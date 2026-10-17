import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { silentContext } from '../../packages/core/src/engine/context.js';
import { chooseLiveHost, liveAddresses, startWslLiveRelay } from '../../packages/core/src/engine/wsl/live.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

async function upstream(handler?: http.RequestListener, host = '127.0.0.1') {
  const server = http.createServer(handler);
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => resolve()); });
  cleanup.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  const port = (server.address() as net.AddressInfo).port;
  return { server, url: new URL(`http://${host.includes(':') ? `[${host}]` : host}:${port}/`) };
}

async function relay(url: URL) {
  const value = await startWslLiveRelay(url, '127.0.0.1');
  cleanup.push(value.stop);
  return value;
}

describe('iPhone live reload relay', () => {
  it('forwards HTTP paths, query strings, and bodies to a loopback-only dev server', async () => {
    const source = await upstream(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString() }));
    });
    const bridge = await relay(source.url);
    const response = await fetch(new URL('/base/api?hello=phone', bridge.url), { method: 'POST', body: 'from iPhone' });
    expect(await response.json()).toEqual({ url: '/base/api?hello=phone', host: source.url.host, body: 'from iPhone' });
  });

  it('relays the WebSocket upgrade and subsequent traffic needed by HMR', async () => {
    const source = await upstream();
    source.server.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.on('data', (data) => socket.write(data));
    });
    const bridge = await relay(source.url);
    const address = new URL(bridge.url);
    const socket = net.connect(Number(address.port), '127.0.0.1');
    cleanup.push(async () => { socket.destroy(); });
    await once(socket, 'connect');
    const result = new Promise<string>((resolve, reject) => {
      let text = '';
      socket.on('error', reject);
      socket.on('data', (data) => {
        text += data.toString();
        if (text.includes('\r\n\r\n') && !text.includes('hmr-update')) socket.write('hmr-update');
        if (text.includes('hmr-update')) resolve(text);
      });
    });
    socket.write(`GET /@vite/ws HTTP/1.1\r\nHost: ${address.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    expect(await result).toContain('101 Switching Protocols');
  });

  it('closes pending upstream requests when the dev session stops', async () => {
    let received!: () => void;
    const arrived = new Promise<void>((resolve) => { received = resolve; });
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => { disconnected = resolve; });
    const source = await upstream((req) => { req.socket.once('close', disconnected); received(); });
    const bridge = await startWslLiveRelay(source.url, '127.0.0.1');
    const request = http.get(bridge.url);
    request.on('error', () => undefined);
    await arrived;
    await bridge.stop();
    await closed;
    request.destroy();
  });

  it('uses a valid IPv6 loopback upstream when available', async (ctx) => {
    let source;
    try { source = await upstream((_req, res) => res.end('ipv6 works'), '::1'); }
    catch { ctx.skip(); return; }
    const bridge = await relay(source.url);
    expect(await (await fetch(bridge.url)).text()).toBe('ipv6 works');
  });

  it('does not advertise loopback, Docker, WSL, or link-local adapters', () => {
    const address = (ip: string, internal = false) => [{ address: ip, family: 'IPv4' as const, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${ip}/24` }];
    expect(liveAddresses({ 'Wi-Fi': address('192.168.1.20'), 'vEthernet (WSL)': address('172.20.0.1'), Loopback: address('127.0.0.1', true), Ethernet: address('169.254.10.1') })).toEqual([{ name: 'Wi-Fi', address: '192.168.1.20' }]);
  });

  it('rejects a loopback override and URLs with credentials', async () => {
    await expect(chooseLiveHost('localhost', silentContext())).rejects.toThrow('LAN address');
    await expect(startWslLiveRelay(new URL('http://user:password@localhost:5173'), '192.168.1.2')).rejects.toThrow('without embedded credentials');
  });
});
