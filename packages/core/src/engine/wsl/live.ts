import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { pipeline } from 'node:stream';
import type { EngineContext } from '../context.js';
import { UserError } from '../errors.js';

export function liveAddresses(interfaces = os.networkInterfaces()): Array<{ name: string; address: string }> {
  return Object.entries(interfaces).flatMap(([name, addresses]) => /loopback|docker|wsl|vethernet|vmware|virtualbox/i.test(name) ? [] :
    (addresses ?? []).filter((address) => !address.internal && address.family === 'IPv4' && !address.address.startsWith('169.254.')).map((address) => ({ name, address: address.address })));
}

export async function chooseLiveHost(override: string | undefined, ctx: EngineContext): Promise<string> {
  if (override) {
    if (!/^[A-Za-z0-9.-]+$/.test(override) || ['localhost', '0.0.0.0', '127.0.0.1'].includes(override)) throw new UserError('--live-host must be a LAN address the iPhone can reach.', 'For example: --live-host 192.168.1.20');
    return override;
  }
  const candidates = liveAddresses();
  if (!candidates.length) throw new UserError('No LAN address was found for iPhone live reload.', 'Connect the PC and iPhone to the same Wi-Fi network, or pass --live-host <PC-LAN-IP>.');
  if (candidates.length === 1) return candidates[0]!.address;
  if (!ctx.prompter.interactive) throw new UserError('Several network connections are available.', 'Choose the PC address your iPhone can reach with --live-host <PC-LAN-IP>.', candidates.map((candidate) => `${candidate.name}: ${candidate.address}`));
  return ctx.prompter.choose({ message: 'Which PC connection can your iPhone reach?', items: candidates.map((candidate) => ({ label: candidate.name, value: candidate.address, hint: candidate.address })) });
}

/** A local dev server can stay on loopback; this relay carries HTTP and HMR WebSockets to the phone. */
export async function startWslLiveRelay(upstream: URL, advertisedHost: string): Promise<{ url: string; stop(): Promise<void> }> {
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) throw new UserError('The development server URL must be HTTP(S), without embedded credentials.');
  const sockets = new Set<net.Socket>();
  const requests = new Set<http.ClientRequest>();
  const hostname = upstream.hostname.replace(/^\[|\]$/g, '');
  const track = (request: http.ClientRequest) => {
    requests.add(request);
    request.once('close', () => requests.delete(request));
    return request;
  };
  const transport = upstream.protocol === 'https:' ? https : http;
  const server = http.createServer((req, res) => {
    const request = track(transport.request({
      protocol: upstream.protocol, hostname, port: upstream.port || undefined,
      method: req.method, path: req.url, headers: { ...req.headers, host: upstream.host },
    }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); pipeline(response, res, () => undefined); }));
    request.on('error', () => { if (!res.destroyed) { if (!res.headersSent) res.writeHead(502); res.end('The development server is unavailable.'); } });
    req.on('aborted', () => request.destroy());
    res.on('close', () => request.destroy());
    pipeline(req, request, () => undefined);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    const request = track(transport.request({
      protocol: upstream.protocol, hostname, port: upstream.port || undefined,
      method: 'GET', path: req.url, headers: { ...req.headers, host: upstream.host },
    }));
    request.on('upgrade', (response, target, targetHead) => {
      sockets.add(target);
      target.on('close', () => sockets.delete(target));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}`)).join('\r\n')}\r\n\r\n`);
      if (targetHead.length) socket.write(targetHead);
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
      socket.on('error', () => target.destroy());
      target.on('error', () => socket.destroy());
      socket.on('close', () => target.destroy());
    });
    request.on('response', () => socket.destroy());
    request.on('error', () => socket.destroy());
    socket.on('close', () => request.destroy());
    request.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', () => { server.off('error', reject); resolve(); }); });
  const address = server.address() as net.AddressInfo;
  return { url: `http://${advertisedHost}:${address.port}${upstream.pathname}${upstream.search}`, stop: () => new Promise<void>((resolve) => { for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}
