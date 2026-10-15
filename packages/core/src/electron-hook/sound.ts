/**
 * Where the app's sound plays while CapMac runs it (see SoundMode): nowhere,
 * on the Mac, or on the PC.
 *
 * Off and PC mute the app's pages on the Mac (webContents.setAudioMuted; the
 * app's own muting still counts). For the PC, a hidden page of CapMac's own
 * captures each window's sound the way Chromium captures a tab (no macOS
 * permission involved: getMediaSourceId, then getUserMedia with the "tab"
 * source; muting the page leaves the capture alone), mixes the windows,
 * encodes Opus with WebCodecs and hands the packets over by IPC. The page is
 * a WebContentsView in a session of its own, so it is not one of the app's
 * windows and none of the app's handlers see it.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { APP_AUDIO, type SoundMode } from '../shared/electron.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Electron is loaded at run time from the app's own copy. */

/** The capture page: tab sound in, Opus packets out (`capmac-audio`, a batch of packets). */
function capturePage(): string {
  return `<!doctype html><meta charset="utf-8"><title>CapMac sound</title><script>
const { ipcRenderer } = require('electron');
const config = ${JSON.stringify(APP_AUDIO)};
let ctx = null, dest = null, encoder = null, reader = null, batch = [], flushTimer = null;
const sources = new Map();
function flush() {
  flushTimer = null;
  if (batch.length) ipcRenderer.send('capmac-audio', batch.splice(0));
}
async function start() {
  if (ctx) return;
  ctx = new AudioContext({ sampleRate: config.sampleRate });
  dest = ctx.createMediaStreamDestination();
  dest.channelCount = config.numberOfChannels;
  encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      batch.push(data);
      // A few packets at a time (about 60 ms): fewer messages, little delay.
      if (batch.length >= 3) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, 60);
    },
    error: (e) => ipcRenderer.send('capmac-audio-error', String(e && e.message || e)),
  });
  encoder.configure({ codec: config.codec, sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels, bitrate: 96000 });
  reader = new MediaStreamTrackProcessor({ track: dest.stream.getAudioTracks()[0] }).readable.getReader();
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (encoder && encoder.state === 'configured') encoder.encode(value);
      value.close();
    }
  })().catch(() => undefined);
}
ipcRenderer.on('capmac-sound', async (_e, command) => {
  try {
    if (command.t === 'add') {
      await start();
      // The source id may be taken before the page is ready for it: a fresh one if this hangs.
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: command.source } }, video: false }),
        new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 2500)),
      ]);
      if (sources.has(command.key)) for (const track of sources.get(command.key).stream.getTracks()) track.stop();
      const node = ctx.createMediaStreamSource(stream);
      node.connect(dest);
      sources.set(command.key, { stream, node });
      ipcRenderer.send('capmac-audio-added', command.key);
    } else if (command.t === 'remove') {
      const source = sources.get(command.key);
      if (source) {
        source.node.disconnect();
        for (const track of source.stream.getTracks()) track.stop();
        sources.delete(command.key);
      }
    }
  } catch (e) {
    ipcRenderer.send('capmac-audio-retry', command.key, String(e && e.message || e));
  }
});
</script>`;
}

export interface SoundHost {
  /** The app's pages whose sound counts (its windows' webContents). */
  pages(): any[];
  /** Opus packets for the clients listening. */
  onPackets(packets: Buffer[]): void;
  /** Says something to CapMac's front ends (once). */
  note(message: string): void;
}

/** What the app itself asked for (setAudioMuted), per page. */
const appMuted = new WeakMap<object, boolean>();
/** Electron's own setAudioMuted, per prototype wrapped (once). */
const rawSetMuted = new WeakMap<object, (muted: boolean) => void>();
/** The control the wrapped methods ask (one per app). */
let current: SoundControl | null = null;

export class SoundControl {
  mode: SoundMode;
  private listeners = 0;
  private view: any = null;
  private server: http.Server | null = null;
  private readonly capturing = new Map<number, any>();
  private readonly retries = new Map<number, number>();

  constructor(private readonly electron: any, initial: SoundMode, private readonly host: SoundHost) {
    this.mode = initial;
    current = this;
  }

  /** The PC can get the sound: this Electron has what the capture needs (Electron 30 and later). */
  get canSendToPc(): boolean {
    return typeof this.electron.WebContentsView === 'function' && typeof this.electron.session?.fromPartition === 'function';
  }

  /** Keeps the app's own muting apart from CapMac's (installed once, with the first page). */
  private guard(wc: any): void {
    const proto = Object.getPrototypeOf(wc);
    if (!proto || rawSetMuted.has(proto)) return;
    const set = proto.setAudioMuted;
    if (typeof set !== 'function' || typeof proto.isAudioMuted !== 'function') return;
    rawSetMuted.set(proto, set);
    try {
      proto.setAudioMuted = function (this: any, muted: boolean) {
        appMuted.set(this, Boolean(muted));
        return set.call(this, current ? current.wantsMuted(this) : Boolean(muted));
      };
      proto.isAudioMuted = function (this: any) {
        return appMuted.get(this) ?? false;
      };
    } catch {
      // read-only in this Electron: CapMac's muting still works
    }
  }

  wantsMuted(wc: any): boolean {
    return (appMuted.get(wc) ?? false) || this.mode !== 'mac';
  }

  /** A page of the app: muted on the Mac unless the sound plays there. */
  track(wc: any): void {
    if (!wc) return;
    this.guard(wc);
    this.apply(wc);
    if (this.mode === 'pc' && this.listeners > 0) this.capture(wc);
  }

  private apply(wc: any): void {
    try {
      if (!wc.isDestroyed()) (rawSetMuted.get(Object.getPrototypeOf(wc)) ?? wc.setAudioMuted).call(wc, this.wantsMuted(wc));
    } catch {
      // closing
    }
  }

  /** Where the sound plays from now on. */
  setMode(mode: SoundMode): void {
    if (mode === 'pc' && !this.canSendToPc) {
      this.host.note('This Electron can’t send its sound to the PC (it needs Electron 30 or later): the sound is off');
    }
    this.mode = mode;
    for (const wc of this.host.pages()) this.apply(wc);
    this.update();
  }

  /** How many clients want the sound on the PC. */
  setListeners(count: number): void {
    this.listeners = count;
    this.update();
  }

  /** A page went away. */
  forget(wc: any): void {
    const key = wc?.id;
    if (typeof key !== 'number' || !this.capturing.has(key)) return;
    this.capturing.delete(key);
    this.send({ t: 'remove', key });
  }

  private update(): void {
    if (this.mode === 'pc' && this.listeners > 0 && this.canSendToPc) {
      for (const wc of this.host.pages()) this.capture(wc);
    } else {
      this.stopCapture();
    }
  }

  private send(command: Record<string, unknown>): void {
    try {
      if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send('capmac-sound', command);
    } catch {
      // closing
    }
  }

  /** Starts capturing a page's sound (the capture page first, once). */
  private capture(wc: any): void {
    if (!wc || wc.isDestroyed?.() || this.capturing.has(wc.id)) return;
    this.capturing.set(wc.id, wc);
    void this.ensureView().then((view) => {
      if (!view || this.capturing.get(wc.id) !== wc || wc.isDestroyed()) return;
      try {
        this.send({ t: 'add', key: wc.id, source: wc.getMediaSourceId(view.webContents) });
      } catch {
        this.capturing.delete(wc.id);
      }
    });
  }

  private viewReady: Promise<any> | null = null;
  /** Bumped when capturing stops: a capture page still loading then closes. */
  private generation = 0;

  private ensureView(): Promise<any> {
    if (!this.viewReady) {
      const generation = this.generation;
      this.viewReady = this.makeView().then((view) => {
        if (generation === this.generation) return view;
        try {
          view.webContents.close?.();
        } catch {
          // closing
        }
        return null;
      }, () => {
        this.viewReady = null;
        this.host.note('CapMac could not send the app’s sound to the PC: the sound is off');
        return null;
      });
    }
    return this.viewReady;
  }

  private async makeView(): Promise<any> {
    const { WebContentsView, session } = this.electron;
    // Served on this Mac's loopback: a page there may capture sound (a secure context, a real origin).
    const token = randomBytes(12).toString('hex');
    const page = capturePage();
    const server = http.createServer((req, res) => {
      if (req.url !== `/${token}`) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.server = server;
    const ses = session.fromPartition('capmac-sound');
    ses.setPermissionRequestHandler((_wc: unknown, permission: string, callback: (ok: boolean) => void) => callback(permission === 'media'));
    ses.setPermissionCheckHandler((_wc: unknown, permission: string) => permission === 'media');
    const view = new WebContentsView({ webPreferences: { session: ses, nodeIntegration: true, contextIsolation: false, sandbox: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, devTools: false } });
    const wc = view.webContents;
    // CapMac's page only.
    wc.on('will-navigate', (e: { preventDefault(): void }) => e.preventDefault());
    wc.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    wc.ipc.on('capmac-audio', (_e: unknown, packets: Uint8Array[]) => {
      if (this.mode === 'pc' && Array.isArray(packets)) this.host.onPackets(packets.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    });
    wc.ipc.on('capmac-audio-retry', (_e: unknown, key: number) => {
      // A hung or refused capture: a fresh source, a few times.
      const tries = (this.retries.get(key) ?? 0) + 1;
      this.retries.set(key, tries);
      const page2 = this.capturing.get(key);
      if (!page2 || tries > 4) return;
      setTimeout(() => {
        try {
          if (this.capturing.get(key) === page2 && !page2.isDestroyed()) this.send({ t: 'add', key, source: page2.getMediaSourceId(wc) });
        } catch {
          // gone
        }
      }, 300);
    });
    wc.ipc.on('capmac-audio-added', (_e: unknown, key: number) => this.retries.delete(key));
    await wc.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}/${token}`);
    this.view = view;
    return view;
  }

  private stopCapture(): void {
    this.generation += 1;
    this.capturing.clear();
    this.retries.clear();
    const view = this.view;
    this.view = null;
    this.viewReady = null;
    try {
      if (view && !view.webContents.isDestroyed()) view.webContents.close?.();
    } catch {
      // closing
    }
    this.server?.close();
    this.server = null;
  }

  stop(): void {
    this.listeners = 0;
    this.stopCapture();
  }
}
