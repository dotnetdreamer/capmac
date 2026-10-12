import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScreenStream, type AppLogEntry, type MacLink } from '@capmac/core/engine';
import type { InputEvent, Target } from '@capmac/core/shared/protocol';
import { log, pc } from '../ui.js';

const BOUNDARY = 'capmacframe';

function loadPage(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, 'viewer.html'), path.join(here, 'page.html'), path.join(here, '..', 'src', 'viewer', 'page.html')]) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // next
    }
  }
  return '<!doctype html><title>CapMac</title><p>Viewer page missing; rebuild CapMac.</p>';
}

export function openInBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // the URL is printed anyway
  }
}

interface StreamClient {
  res: http.ServerResponse;
  busy: boolean;
}

/**
 * Remote simulator screen, like Xamarin's "Remoted iOS Simulator": a local
 * web page that shows the Mac's simulator and forwards taps, swipes and text.
 */
export class ScreenViewer {
  private readonly clients = new Set<StreamClient>();
  private readonly logClients = new Set<http.ServerResponse>();
  private readonly logBacklog: AppLogEntry[] = [];
  private readonly stream: ScreenStream;
  private latest: Buffer | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly page = loadPage();
  url = '';

  private constructor(link: MacLink, private readonly target: Target, private readonly title: string, private readonly server: http.Server) {
    this.stream = new ScreenStream(link, target.udid, { fps: 12, quality: 70 }, {
      onFrame: (jpeg) => this.broadcast(jpeg),
      onLog: (_level, message) => log.dim(`  screen: ${message}`),
      onEnd: (error) => {
        if (error) log.warn(`Screen stream stopped: ${error.message}`);
        for (const client of this.clients) client.res.end();
        this.clients.clear();
      },
    });
  }

  static async start(link: MacLink, target: Target, options: { title: string; port?: number }): Promise<ScreenViewer> {
    const server = http.createServer();
    const viewer = new ScreenViewer(link, target, options.title, server);
    server.on('request', (req, res) => void viewer.handle(req, res));
    const port = await new Promise<number>((resolve, reject) => {
      const tryPort = (p: number, attemptsLeft: number) => {
        server.once('error', (err: any) => {
          if (err?.code === 'EADDRINUSE' && attemptsLeft > 0) tryPort(p + 1, attemptsLeft - 1);
          else reject(err);
        });
        server.listen(p, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
      };
      tryPort(options.port ?? 7373, options.port ? 0 : 20);
    });
    viewer.url = `http://127.0.0.1:${port}/`;
    log.success(`Remote screen: ${pc.cyan(viewer.url)}`);
    return viewer;
  }

  open(): void {
    openInBrowser(this.url);
  }

  /** Feed app log lines (from `capmac dev`/`run`) into the page's console panel. */
  pushLog(entry: AppLogEntry): void {
    const line = { kind: entry.kind, level: entry.level, text: entry.text };
    this.logBacklog.push(entry);
    if (this.logBacklog.length > 500) this.logBacklog.shift();
    const payload = `data: ${JSON.stringify(line)}\n\n`;
    for (const res of this.logClients) res.write(payload);
  }

  private async ensureStream(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.stream.start();
  }

  private broadcast(jpeg: Buffer): void {
    this.latest = jpeg;
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    for (const client of this.clients) {
      if (client.busy) continue; // slow browser: drop this frame, send the next
      const ok = client.res.write(Buffer.concat([head, jpeg, Buffer.from('\r\n')]));
      if (!ok) {
        client.busy = true;
        client.res.once('drain', () => (client.busy = false));
      }
    }
  }

  private scheduleIdleStop(): void {
    if (this.clients.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size === 0) this.stream.stop();
    }, 15_000);
  }

  private async readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 64 * 1024) throw new Error('Request too large');
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Only pages served by this viewer may drive the simulator.
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(this.page);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/stream') {
        await this.ensureStream();
        res.writeHead(200, {
          'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
          'cache-control': 'no-store, no-cache, must-revalidate',
          connection: 'close',
          pragma: 'no-cache',
        });
        const client: StreamClient = { res, busy: false };
        this.clients.add(client);
        if (this.latest) this.broadcast(this.latest);
        req.on('close', () => {
          this.clients.delete(client);
          this.scheduleIdleStop();
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/info') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ title: this.title, target: `${this.target.name} (${this.target.os})`, screen: this.stream.info }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/frame.jpg') {
        if (!this.latest) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': this.latest.length }).end(this.latest);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        for (const entry of this.logBacklog) res.write(`data: ${JSON.stringify({ kind: entry.kind, level: entry.level, text: entry.text })}\n\n`);
        this.logClients.add(res);
        req.on('close', () => this.logClients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/input') {
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
          res.writeHead(403).end();
          return;
        }
        const event = (await this.readJson(req)) as InputEvent;
        await this.ensureStream();
        this.stream.input(event);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      res.writeHead(404).end('Not found');
    } catch (err: any) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err?.message ?? err));
    }
  }

  async close(): Promise<void> {
    this.stream.dispose();
    for (const client of this.clients) client.res.end();
    for (const res of this.logClients) res.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
