/**
 * The app's windows as H.264 video, for the smooth stream. CapMac's capture
 * page (capture.ts) captures a window the way Chromium captures a tab,
 * encodes it with WebCodecs (VideoToolbox on the Mac) and hands each message
 * over by IPC, in the simulator stream's format (shared/stream.ts): a config
 * (the size and the avcC record), then frames as AVCC. A keyframe comes
 * first, on request, and whenever the size changes. A still window sends
 * nothing; asked for a keyframe, it sends its last picture again.
 *
 * Each watching client has a session of its own (its size, its bitrate).
 * When the capture or the encoder cannot work, the session gives up and its
 * client gets JPEG frames instead (see hook.ts).
 */
import type { CapturePage } from './capture.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Electron is loaded at run time from the app's own copy. */

/** The capture page's video part (`capmac-video` commands in, one IPC message per stream message out). */
export function videoPageScript(): string {
  return `{
const sessions = new Map();
const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);
const errorText = (e) => String((e && e.message) || e);
// H.264 High profile, at the lowest level that fits the size and the frame rate: [level, macroblocks, macroblocks a second].
const LEVELS = [[0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
function codecFor(width, height, fps) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = (LEVELS.find((l) => mbs <= l[1] && mbs * fps <= l[2]) || LEVELS[LEVELS.length - 1])[0];
  return 'avc1.6400' + level.toString(16).padStart(2, '0');
}
function header(message, type, key, us, seq) {
  const v = new DataView(message.buffer, message.byteOffset, 16);
  v.setUint8(0, type);
  v.setUint8(1, key ? 1 : 0);
  v.setUint16(2, 0);
  v.setBigUint64(4, BigInt(Math.max(0, Math.round(us))));
  v.setUint32(12, seq >>> 0);
}
function output(s, chunk, metadata) {
  if (s.closed) return;
  s.frames += 1;
  const config = metadata && metadata.decoderConfig;
  if (config && config.description) {
    // A config message: the size, then the avcC record.
    const d = config.description;
    const avcc = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
    const message = new Uint8Array(20 + avcc.byteLength);
    header(message, 1, false, chunk.timestamp, s.seq);
    const v = new DataView(message.buffer);
    v.setUint16(16, s.width);
    v.setUint16(18, s.height);
    message.set(avcc, 20);
    ipcRenderer.send('capmac-video', s.key, message);
  }
  const message = new Uint8Array(16 + chunk.byteLength);
  header(message, 2, chunk.type === 'key', chunk.timestamp, ++s.seq);
  chunk.copyTo(message.subarray(16));
  ipcRenderer.send('capmac-video', s.key, message);
}
function close(s) {
  s.closed = true;
  clearTimeout(s.keyTimer);
  if (s.reader) s.reader.cancel().catch(() => undefined);
  if (s.stream) for (const track of s.stream.getTracks()) track.stop();
  if (s.last) s.last.close();
  s.last = null;
  try {
    if (s.encoder && s.encoder.state !== 'closed') s.encoder.close();
  } catch {}
}
function stop(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  close(s);
}
function fail(s, message, fatal) {
  if (s.closed) return;
  stop(s.key);
  ipcRenderer.send('capmac-video-failed', s.key, message, Boolean(fatal));
}
function encoderError(s, e) {
  if (s.closed) return;
  const now = performance.now();
  s.errors = s.errors.filter((t) => t > now - 10000);
  s.errors.push(now);
  s.encoder = null;
  s.width = 0;
  // Hardware refused from the start: software once; nothing at all means this app cannot encode.
  if (s.frames === 0) {
    if (s.software) {
      fail(s, 'the H.264 encoder did not start: ' + errorText(e), true);
      return;
    }
    s.software = true;
    // A still window sends no new picture: its last one, as soon as this call is over.
    setTimeout(() => {
      if (!s.closed && s.last) encode(s, s.last, true);
    }, 0);
    return;
  }
  // A hiccup (the Mac slept, the GPU reset): a fresh encoder from the next picture, unless it keeps failing.
  if (s.errors.length > 3) fail(s, 'the H.264 encoder keeps failing: ' + errorText(e), false);
}
function configure(s, width, height) {
  s.config = { codec: codecFor(width, height, s.fps), width, height, bitrate: s.bitrate, framerate: s.fps, hardwareAcceleration: s.software ? 'no-preference' : 'prefer-hardware', latencyMode: 'realtime', bitrateMode: 'variable', avc: { format: 'avc' } };
  s.width = width;
  s.height = height;
  s.wantKey = true;
  try {
    if (!s.encoder || s.encoder.state === 'closed') s.encoder = new VideoEncoder({ output: (chunk, md) => output(s, chunk, md), error: (e) => encoderError(s, e) });
    s.encoder.configure(s.config);
    return true;
  } catch (e) {
    encoderError(s, e);
    return false;
  }
}
/** The part of a picture the encoder takes: whole chroma pixels (H.264 wants an even size). */
function area(frame) {
  const r = frame.visibleRect;
  return { x: r.x & ~1, y: r.y & ~1, width: Math.max(2, r.width & ~1), height: Math.max(2, r.height & ~1) };
}
function encode(s, frame, key) {
  const a = area(frame);
  if ((!s.encoder || s.encoder.state === 'closed' || a.width !== s.width || a.height !== s.height) && !configure(s, a.width, a.height)) return;
  // It may fail while configuring (the error comes at once): the next picture tries again.
  if (!s.encoder || s.encoder.state !== 'configured') return;
  // Behind (a slow encoder): skip this picture; the next one goes (a keyframe, if one is due).
  if (s.encoder.encodeQueueSize > 2 && !key) return;
  const wantKey = s.wantKey || key;
  s.wantKey = false;
  clearTimeout(s.keyTimer);
  s.keyTimer = 0;
  // Stamped with the time it reached CapMac, on the Mac's clock (the stream's capture time).
  let copy;
  try {
    copy = new VideoFrame(frame, { timestamp: nowUs(), visibleRect: a });
  } catch {
    s.wantKey = true;
    return;
  }
  try {
    s.encoder.encode(copy, { keyFrame: wantKey });
  } catch (e) {
    s.wantKey = true;
    encoderError(s, e);
  }
  copy.close();
}
function keyframe(s) {
  s.wantKey = true;
  if (s.keyTimer || !s.last) return;
  // A still window sends no new picture: its last one again, as a keyframe.
  s.keyTimer = setTimeout(() => {
    s.keyTimer = 0;
    if (s.wantKey && s.last && !s.closed) encode(s, s.last, true);
  }, 120);
}
function setBitrate(s, bitrate) {
  s.bitrate = bitrate;
  if (!s.encoder || s.encoder.state !== 'configured' || !s.config) return;
  s.config = Object.assign({}, s.config, { bitrate });
  try {
    s.encoder.configure(s.config);
  } catch (e) {
    encoderError(s, e);
  }
}
async function start(c) {
  stop(c.key);
  const s = { key: c.key, fps: c.fps, bitrate: c.bitrate, stream: null, track: null, reader: null, encoder: null, config: null, width: 0, height: 0, wantKey: true, last: null, seq: 0, keyTimer: 0, frames: 0, errors: [], software: false, closed: false };
  sessions.set(c.key, s);
  // The window's own size and shape (CapMac works it out): limits alone would give a picture of their size, the page letterboxed in it.
  // A little above the frame rate: capped at exactly 30, a 60 Hz screen's every other frame is often a hair early, and one in three is taken (20 fps).
  // The source id may be taken before the page is ready for it: a fresh one if this hangs.
  const asked = navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: c.source, minWidth: c.width, maxWidth: c.width, minHeight: c.height, maxHeight: c.height, maxFrameRate: c.fps + 2 } } });
  let stream;
  try {
    stream = await Promise.race([asked, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 2500))]);
  } catch (e) {
    asked.then((late) => { for (const track of late.getTracks()) track.stop(); }, () => undefined);
    if (sessions.get(c.key) === s) {
      sessions.delete(c.key);
      close(s);
      ipcRenderer.send('capmac-video-retry', c.key, errorText(e));
    }
    return;
  }
  if (sessions.get(c.key) !== s) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  s.stream = stream;
  s.track = stream.getVideoTracks()[0];
  if (!s.track || typeof MediaStreamTrackProcessor === 'undefined' || typeof VideoEncoder === 'undefined') {
    fail(s, 'this Electron has no video encoder for CapMac', true);
    return;
  }
  const reader = s.reader = new MediaStreamTrackProcessor({ track: s.track }).readable.getReader();
  ipcRenderer.send('capmac-video-started', c.key);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (s.closed) {
        value.close();
        break;
      }
      // The newest picture stays, for a keyframe on request.
      if (s.last) s.last.close();
      s.last = value;
      encode(s, value, false);
    }
  } catch {
    // the capture stopped
  }
  // The capture ended by itself (the window went away): CapMac starts it again, or gives up.
  if (sessions.get(c.key) === s) {
    sessions.delete(c.key);
    close(s);
    ipcRenderer.send('capmac-video-ended', c.key);
  }
}
ipcRenderer.on('capmac-video', (_e, c) => {
  if (c.t === 'start') {
    start(c).catch((e) => ipcRenderer.send('capmac-video-retry', c.key, errorText(e)));
    return;
  }
  if (c.t === 'stop') {
    stop(c.key);
    return;
  }
  const s = sessions.get(c.key);
  if (!s) return;
  if (c.t === 'keyframe') keyframe(s);
  else if (c.t === 'bitrate') setBitrate(s, c.bitrate);
});
}`;
}

export interface VideoOptions {
  /** The video's size in pixels: the window's page, scaled down to fit (see videoSize). */
  width: number;
  height: number;
  fps: number;
  /** Bits a second. */
  bitrate: number;
}

/** The largest picture the Mac's H.264 encoder (VideoToolbox) takes. */
const MAX_WIDTH = 4096;
const MAX_HEIGHT = 2304;

/**
 * The video size for a page `width` x `height` points on a display of
 * `scale`: its own pixels (never more), with the longest side at most
 * `maxSize` and within what the encoder takes, in even numbers (H.264 counts
 * colour in 2 x 2 blocks).
 */
export function videoSize(width: number, height: number, scale: number, maxSize: number): { width: number; height: number } {
  const w = Math.max(2, width * (scale || 1));
  const h = Math.max(2, height * (scale || 1));
  const k = Math.min(1, maxSize / Math.max(w, h), MAX_WIDTH / w, MAX_HEIGHT / h);
  const even = (n: number) => Math.max(2, Math.floor((n * k) / 2) * 2);
  return { width: even(w), height: even(h) };
}

export interface VideoHost {
  /** One message of session `key`'s video: a config or a frame, header and payload. */
  onMessage(key: number, message: Buffer): void;
  /** Session `key` gave up: its client shows JPEG frames instead. */
  onFailed(key: number, reason: string): void;
}

interface Session {
  wc: any;
  options: VideoOptions;
  tries: number;
  /** Video came: the capture works. */
  heard: boolean;
  timer: NodeJS.Timeout | null;
  /** A new size waits for the window to stop changing. */
  resizeTimer: NodeJS.Timeout | null;
}

/** Tries for a capture that hangs or is refused, each with a fresh source. */
const TRIES = 4;
/** No answer from the page this long after a start (it answers within its capture's own 2.5 s): it is not working. */
const START_TIMEOUT_MS = 6000;
/** A capture that started and sent nothing this long is stuck (a window that just opened sends its picture at once). */
const SILENT_MS = 5000;
/** A new size this long unchanged starts the capture again at it (a window being dragged changes size many times). */
const RESIZE_SETTLE_MS = 250;

export class VideoCapture {
  private readonly sessions = new Map<number, Session>();
  /** Why video cannot work in this app at all (no encoder): every client gets JPEG. */
  broken: string | null = null;

  constructor(private readonly page: CapturePage, private readonly host: VideoHost) {
    page.on('capmac-video', (_e: unknown, key: number, data: Uint8Array) => {
      const s = this.sessions.get(key);
      if (!s || !(data instanceof Uint8Array)) return;
      if (!s.heard) {
        s.heard = true;
        s.tries = 0;
        this.disarm(s);
      }
      this.host.onMessage(key, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    });
    page.on('capmac-video-started', (_e: unknown, key: number) => {
      const s = this.sessions.get(key);
      if (s && !s.heard) this.arm(s, SILENT_MS, () => this.retry(key, 'no picture came'));
    });
    page.on('capmac-video-retry', (_e: unknown, key: number, why: string) => this.retry(key, String(why ?? '')));
    page.on('capmac-video-ended', (_e: unknown, key: number) => this.retry(key, 'the capture stopped'));
    page.on('capmac-video-failed', (_e: unknown, key: number, why: string, fatal: boolean) => {
      if (fatal) this.broken = String(why);
      this.fail(key, String(why));
    });
  }

  /** Video can work here: this Electron captures (Electron 30 and later) and nothing proved it cannot encode. */
  get available(): boolean {
    return this.page.available && !this.broken;
  }

  /** Starts session `key` on a window's page (a session already running for `key` stops first). */
  start(key: number, wc: any, options: VideoOptions): void {
    this.stop(key);
    const s: Session = { wc, options: { ...options }, tries: 0, heard: false, timer: null, resizeTimer: null };
    this.sessions.set(key, s);
    this.begin(key, s);
  }

  private begin(key: number, s: Session): void {
    s.tries += 1;
    this.disarm(s);
    this.page.hold(this).then(
      (contents) => {
        if (!contents || this.sessions.get(key) !== s || s.wc.isDestroyed()) return;
        let source: string;
        try {
          source = s.wc.getMediaSourceId(contents);
        } catch (err) {
          this.fail(key, `the window could not be captured (${String((err as Error)?.message ?? err)})`);
          return;
        }
        this.page.send('capmac-video', { t: 'start', key, source, ...s.options });
        // Not a word from the page (it answers within seconds, whatever happens): it will not, for anyone.
        this.arm(s, START_TIMEOUT_MS, () => {
          this.broken = 'CapMac’s capture page does not answer';
          this.fail(key, this.broken);
        });
      },
      (err) => this.fail(key, `CapMac’s capture page did not load (${String((err as Error)?.message ?? err)})`),
    );
  }

  private retry(key: number, why: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    this.disarm(s);
    s.heard = false;
    if (s.tries >= TRIES) {
      this.fail(key, `the window could not be captured (${why})`);
      return;
    }
    s.timer = setTimeout(() => {
      s.timer = null;
      if (this.sessions.get(key) === s && !s.wc.isDestroyed()) this.begin(key, s);
    }, 300);
  }

  private arm(s: Session, ms: number, then: () => void): void {
    this.disarm(s);
    s.timer = setTimeout(() => {
      s.timer = null;
      then();
    }, ms);
  }

  private disarm(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
  }

  private fail(key: number, reason: string): void {
    if (!this.sessions.has(key)) return;
    this.stop(key);
    this.host.onFailed(key, reason);
  }

  stop(key: number): void {
    const s = this.sessions.get(key);
    if (!s) return;
    this.disarm(s);
    if (s.resizeTimer) clearTimeout(s.resizeTimer);
    this.sessions.delete(key);
    this.page.send('capmac-video', { t: 'stop', key });
    if (this.sessions.size === 0) this.page.drop(this);
  }

  /** The next frame is a keyframe (the last picture again, when the window is still). */
  keyframe(key: number): void {
    if (this.sessions.has(key)) this.page.send('capmac-video', { t: 'keyframe', key });
  }

  setBitrate(key: number, bitrate: number): void {
    const s = this.sessions.get(key);
    if (!s || s.options.bitrate === bitrate) return;
    s.options.bitrate = bitrate;
    this.page.send('capmac-video', { t: 'bitrate', key, bitrate });
  }

  /**
   * The video's size from now on (the window or the viewer changed size): the
   * capture starts again at it, once the size settles. Changing a running
   * tab capture's size (applyConstraints) leaves it sending no new pictures.
   */
  setSize(key: number, size: { width: number; height: number }): void {
    const s = this.sessions.get(key);
    if (!s || (s.options.width === size.width && s.options.height === size.height)) return;
    s.options.width = size.width;
    s.options.height = size.height;
    if (s.resizeTimer) clearTimeout(s.resizeTimer);
    s.resizeTimer = setTimeout(() => {
      s.resizeTimer = null;
      if (this.sessions.get(key) !== s || s.wc.isDestroyed()) return;
      // Not a failed try: a fresh start.
      s.heard = false;
      s.tries = 0;
      this.begin(key, s);
    }, RESIZE_SETTLE_MS);
  }

  stopAll(): void {
    for (const key of [...this.sessions.keys()]) this.stop(key);
  }
}
