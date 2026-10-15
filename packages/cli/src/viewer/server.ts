import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppScreenStream, ScreenStream, soundFor, takeAppScreenshot, type AppLogEntry, type MacLink, type VideoPacket } from '@capmac/core/engine';
import { isSoundMode, type AppWindowInfo, type SoundMode } from '@capmac/core/shared/electron';
import type { InputEvent, ScreenInfo, Target } from '@capmac/core/shared/protocol';
import { parseVideoConfig, STREAM_CONFIG, STREAM_FRAME, STREAM_HEADER_BYTES } from '@capmac/core/shared/stream';
import { log, pc } from '../ui.js';

const BOUNDARY = 'capmacframe';

/**
 * A config message as the page takes it: the helper's header, then JSON with
 * the WebCodecs settings (the SPS already says frames come in order, see
 * core's h264.ts), so the page parses no H.264 itself.
 */
export function pageConfigMessage(message: Buffer): Buffer | null {
  const config = parseVideoConfig(message);
  if (!config) return null;
  const json = JSON.stringify({ codec: config.codec, width: config.width, height: config.height, description: Buffer.from(config.description).toString('base64') });
  return Buffer.concat([message.subarray(0, STREAM_HEADER_BYTES), Buffer.from(json)]);
}

/** One message on /video: its u32 big-endian length, then the message. */
export function lengthPrefixed(message: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(message.length);
  return Buffer.concat([head, message]);
}

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

/** A page playing the smooth stream (/video). */
interface VideoClient {
  res: http.ServerResponse;
  /** Its socket is full: frames are skipped until it drains, then it resumes at a keyframe. */
  blocked: boolean;
  /** Deltas are useless until the next keyframe. */
  needsKey: boolean;
}

/**
 * What the viewer shows: a simulator, an iPhone plugged into the Mac (the
 * smooth stream, view only), or an Electron app's windows on the Mac's desktop.
 */
export type ViewerSource = { kind: 'simulator'; target: Target } | { kind: 'device'; target: Target } | { kind: 'app'; projectId: string; label: string };

/** What both streams offer the viewer. */
interface Stream {
  info: ScreenInfo | null;
  start(): Promise<void>;
  stop(): void;
  dispose(): void;
  input(event: InputEvent): void;
}

/**
 * Remote screen, like Xamarin's "Remoted iOS Simulator": a local web page
 * that shows the Mac's simulator (taps, swipes and text) or an Electron app's
 * window (pointer, wheel and keyboard).
 */
export class ScreenViewer {
  private readonly clients = new Set<StreamClient>();
  private readonly videoClients = new Set<VideoClient>();
  private readonly logClients = new Set<http.ServerResponse>();
  private readonly eventClients = new Set<http.ServerResponse>();
  private readonly logBacklog: AppLogEntry[] = [];
  private readonly stream: Stream;
  private readonly app: AppScreenStream | null = null;
  /** The smooth stream's source (a plugged-in iPhone): keyframes, its video size, stills. */
  private readonly video: ScreenStream | null = null;
  /** The newest config, for pages that join later. */
  private videoConfig: Buffer | null = null;
  private latest: Buffer | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly page = loadPage();
  private cursor = 'pointer';
  url = '';

  private constructor(private readonly link: MacLink, private readonly source: ViewerSource, private readonly title: string, private readonly server: http.Server) {
    const onEnd = (error?: { message: string; hint?: string }) => {
      if (error) log.warn(`Screen stream stopped: ${error.message}${error.hint ? ` ${error.hint}` : ''}`);
      if (error) this.event({ type: 'ended', message: error.message, hint: error.hint ?? null });
      for (const client of this.clients) client.res.end();
      this.clients.clear();
      for (const client of this.videoClients) client.res.end();
      this.videoClients.clear();
    };
    if (source.kind === 'app') {
      this.app = new AppScreenStream(link, source.projectId, { fps: 20, quality: 72, audio: true }, {
        onFrame: (jpeg) => this.broadcast(jpeg),
        onWindows: (windows, watched) => this.event({ type: 'windows', windows, watched }),
        onCursor: (cursor) => {
          this.cursor = cursor;
          this.event({ type: 'cursor', cursor });
        },
        onClipboard: (text) => this.event({ type: 'clipboard', text }),
        onDialogs: (dialogs, closed) => this.event({ type: 'dialogs', dialogs, closed }),
        onSound: (mode, toPc) => this.event({ type: 'sound', mode, toPc }),
        // The app's sound, when it plays on this PC: the page plays it.
        onAudio: (packets) => this.event({ type: 'audio', packets: packets.map((p) => p.toString('base64')) }),
        onWaiting: (waiting) => this.event({ type: 'waiting', waiting }),
        onInfo: (info) => this.event({ type: 'info', screen: info }),
        onEnd,
      });
      this.stream = this.app;
    } else if (source.kind === 'device') {
      // The iPhone's screen comes as H.264 only: the page decodes it (WebCodecs).
      this.video = new ScreenStream(link, source.target.udid, { maxSize: 1400, device: { name: source.target.name } }, {
        onFrame: () => undefined,
        onVideo: (packet) => this.sendVideo(packet),
        onInfo: (info) => this.event({ type: 'info', screen: info }),
        onWaiting: (wait) => {
          this.event({ type: 'device-wait', wait });
          if (wait === 'device') log.info(`Plug ${source.target.name} into the Mac with a cable to see its screen.`);
          else if (wait === 'permission') log.info(`Click ${pc.bold('Allow')} on the Mac: macOS asks once if CapMac may see the iPhone's screen.`);
        },
        onLog: (_level, message) => log.dim(`  screen: ${message}`),
        onEnd,
      });
      this.stream = this.video;
    } else {
      this.stream = new ScreenStream(link, source.target.udid, { fps: 12, quality: 70 }, {
        onFrame: (jpeg) => this.broadcast(jpeg),
        onLog: (_level, message) => log.dim(`  screen: ${message}`),
        onEnd,
      });
    }
  }

  static async start(link: MacLink, source: ViewerSource | Target, options: { title: string; port?: number }): Promise<ScreenViewer> {
    const server = http.createServer();
    // A Target (a simulator, or a plugged-in iPhone) is the usual case; the app's windows come as a ViewerSource.
    const what: ViewerSource = 'target' in source || source.kind === 'app' ? (source as ViewerSource) : { kind: source.kind === 'device' ? 'device' : 'simulator', target: source };
    const viewer = new ScreenViewer(link, what, options.title, server);
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

  /** Window, cursor and clipboard news for the page (app windows). */
  private event(value: { type: string } & Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(value)}\n\n`;
    for (const res of this.eventClients) res.write(payload);
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
    // Each frame ends with the next boundary: a browser shows a part only once that arrives,
    // and a still window sends no next frame.
    const head = Buffer.from(`Content-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${BOUNDARY}\r\n`);
    for (const client of this.clients) {
      if (client.busy) continue; // slow browser: drop this frame, send the next
      const ok = client.res.write(Buffer.concat([head, jpeg, tail]));
      if (!ok) {
        client.busy = true;
        client.res.once('drain', () => (client.busy = false));
      }
    }
  }

  /**
   * The smooth stream, to every page playing it: each message whole, in
   * order. A page that falls behind skips to the next keyframe instead of
   * piling up delay; one that joins starts from the newest config and a
   * fresh keyframe.
   */
  private sendVideo({ data, header }: VideoPacket): void {
    if (header.type === STREAM_CONFIG) {
      const config = pageConfigMessage(data);
      if (!config) return;
      this.videoConfig = config;
      for (const client of this.videoClients) {
        client.needsKey = true;
        this.writeVideo(client, config);
      }
      return;
    }
    if (header.type !== STREAM_FRAME) return;
    for (const client of this.videoClients) {
      if (client.blocked) {
        client.needsKey = true;
        continue;
      }
      if (client.needsKey) {
        if (!header.key) continue;
        client.needsKey = false;
      }
      this.writeVideo(client, data);
    }
  }

  private writeVideo(client: VideoClient, message: Buffer): void {
    if (client.res.write(lengthPrefixed(message)) || client.blocked) return;
    client.blocked = true;
    client.res.once('drain', () => {
      client.blocked = false;
      this.video?.requestKeyframe();
    });
  }

  private scheduleIdleStop(): void {
    if (this.clients.size > 0 || this.videoClients.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size === 0 && this.videoClients.size === 0) this.stream.stop();
    }, 15_000);
  }

  private async readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 512 * 1024) throw new Error('Request too large');
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  private infoBody(): object {
    const target = this.source.kind === 'app' ? this.source.label : `${this.source.target.name} (${this.source.target.os})`;
    const app = this.app;
    return {
      title: this.title,
      target,
      targetName: this.source.kind === 'app' ? this.source.label : this.source.target.name,
      mode: this.source.kind,
      // The page plays /video (H.264) instead of /stream (JPEG).
      video: this.video !== null,
      screen: this.stream.info,
      ...(app ? { windows: app.windows as AppWindowInfo[], watched: app.watched, waiting: app.waiting, cursor: this.cursor, dialogs: app.dialogs, sound: app.sound } : {}),
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Only pages served by this viewer may drive the simulator or the app.
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        res.writeHead(403).end();
        return;
      }
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
        res.write(`--${BOUNDARY}\r\n`);
        this.clients.add(client);
        if (this.latest) this.broadcast(this.latest);
        req.on('close', () => {
          this.clients.delete(client);
          this.scheduleIdleStop();
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/video' && this.video) {
        await this.ensureStream();
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        const client: VideoClient = { res, blocked: false, needsKey: true };
        this.videoClients.add(client);
        if (this.videoConfig) this.writeVideo(client, this.videoConfig);
        this.video.requestKeyframe();
        req.on('close', () => {
          this.videoClients.delete(client);
          this.scheduleIdleStop();
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/keyframe' && this.video) {
        this.video.requestKeyframe();
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/size' && this.video) {
        const body = await this.readJson(req);
        if (typeof body.maxSize === 'number' && Number.isFinite(body.maxSize)) this.video.setVideoSize(body.maxSize);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/screenshot.png' && this.video) {
        const png = await this.video.still();
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }).end(png);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/info') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.infoBody()));
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
      if (req.method === 'GET' && url.pathname === '/api/screenshot.png' && this.source.kind === 'app') {
        const shot = await takeAppScreenshot(await this.link.session(), this.source.projectId, this.app?.watched ?? undefined);
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': shot.png.length }).end(shot.png);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        for (const entry of this.logBacklog) res.write(`data: ${JSON.stringify({ kind: entry.kind, level: entry.level, text: entry.text })}\n\n`);
        this.logClients.add(res);
        req.on('close', () => this.logClients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', ...this.infoBody() })}\n\n`);
        this.eventClients.add(res);
        req.on('close', () => this.eventClients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/input') {
        const event = (await this.readJson(req)) as InputEvent;
        await this.ensureStream();
        this.stream.input(event);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/window' && this.app) {
        const body = await this.readJson(req);
        this.app.selectWindow(typeof body.window === 'number' ? body.window : null);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sound' && this.app) {
        const body = await this.readJson(req);
        if (!isSoundMode(body.mode)) {
          res.writeHead(400).end('Not a sound setting');
          return;
        }
        await this.setSound(body.mode);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/dialog/') && this.app) {
        const body = await this.readJson(req);
        await this.ensureStream();
        let data: unknown = null;
        if (url.pathname === '/api/dialog/answer') await this.app.answerDialog(Number(body.dialog), body.answer);
        else if (url.pathname === '/api/dialog/list') data = await this.app.listFolder(String(body.path ?? '~'), Boolean(body.hidden));
        else if (url.pathname === '/api/dialog/mkdir') data = await this.app.makeFolder(String(body.path ?? ''));
        else {
          res.writeHead(404).end('Not found');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, data }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/window-action' && this.app) {
        const body = await this.readJson(req);
        if (typeof body.window === 'number' && ['close', 'minimize', 'zoom'].includes(body.action)) this.app.windowAction(body.window, body.action);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      res.writeHead(404).end('Not found');
    } catch (err: any) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err?.message ?? err));
    }
  }

  /** Where the Electron app's sound plays (remembered for the project, as Studio does). */
  async setSound(mode: SoundMode): Promise<void> {
    if (!this.app || this.source.kind !== 'app') return;
    await soundFor(this.source.projectId, mode);
    this.app.setSound(mode);
  }

  async close(): Promise<void> {
    this.stream.dispose();
    for (const client of this.clients) client.res.end();
    for (const client of this.videoClients) client.res.end();
    for (const res of this.logClients) res.end();
    for (const res of this.eventClients) res.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
