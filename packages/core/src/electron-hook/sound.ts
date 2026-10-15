/**
 * Where the app's sound plays while CapMac runs it (see SoundMode): nowhere,
 * on the Mac, or on the PC.
 *
 * Off and PC mute the app's pages on the Mac (webContents.setAudioMuted; the
 * app's own muting still counts). For the PC, CapMac's capture page
 * (capture.ts) captures each window's sound the way Chromium captures a tab
 * (muting the page leaves the capture alone), mixes the windows, encodes Opus
 * with WebCodecs and hands the packets over by IPC.
 */
import { APP_AUDIO, type SoundMode } from '../shared/electron.js';
import { CapturePage } from './capture.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Electron is loaded at run time from the app's own copy. */

/** The capture page's sound part: tab sound in, Opus packets out (`capmac-audio`, a batch of packets). */
export function soundPageScript(): string {
  return `{
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
  const own = reader = new MediaStreamTrackProcessor({ track: dest.stream.getAudioTracks()[0] }).readable.getReader();
  (async () => {
    for (;;) {
      const { value, done } = await own.read();
      if (done) break;
      if (encoder && encoder.state === 'configured') encoder.encode(value);
      value.close();
    }
  })().catch(() => undefined);
}
function remove(key) {
  const source = sources.get(key);
  if (!source) return;
  source.node.disconnect();
  for (const track of source.stream.getTracks()) track.stop();
  sources.delete(key);
}
/** Nothing to capture any more (the page may stay open for the video). */
function stopAll() {
  for (const key of [...sources.keys()]) remove(key);
  if (reader) reader.cancel().catch(() => undefined);
  if (encoder && encoder.state !== 'closed') encoder.close();
  if (ctx) ctx.close().catch(() => undefined);
  if (flushTimer) clearTimeout(flushTimer);
  ctx = dest = encoder = reader = flushTimer = null;
  batch = [];
}
ipcRenderer.on('capmac-sound', async (_e, command) => {
  try {
    if (command.t === 'add') {
      await start();
      // The source id may be taken before the page is ready for it: a fresh one if this hangs.
      const asked = navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: command.source } }, video: false });
      const stream = await Promise.race([asked, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 2500))]).catch((e) => {
        asked.then((late) => { for (const track of late.getTracks()) track.stop(); }, () => undefined);
        throw e;
      });
      if (!ctx) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      remove(command.key);
      const node = ctx.createMediaStreamSource(stream);
      node.connect(dest);
      sources.set(command.key, { stream, node });
      ipcRenderer.send('capmac-audio-added', command.key);
    } else if (command.t === 'remove') {
      remove(command.key);
    } else if (command.t === 'stop') {
      stopAll();
    }
  } catch (e) {
    ipcRenderer.send('capmac-audio-retry', command.key, String(e && e.message || e));
  }
});
}`;
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
  private readonly capturing = new Map<number, any>();
  private readonly retries = new Map<number, number>();
  /** Holding the capture page (see capture.ts). */
  private holding = false;
  private readonly page: CapturePage;

  /** `page`: the capture page, shared with the video (one of its own when there is none). */
  constructor(electron: any, initial: SoundMode, private readonly host: SoundHost, page?: CapturePage) {
    this.mode = initial;
    current = this;
    this.page = page ?? new CapturePage(electron, [soundPageScript()]);
    this.page.on('capmac-audio', (_e: unknown, packets: Uint8Array[]) => {
      if (this.mode === 'pc' && Array.isArray(packets)) this.host.onPackets(packets.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    });
    this.page.on('capmac-audio-retry', (_e: unknown, key: number) => {
      // A hung or refused capture: a fresh source, a few times.
      const tries = (this.retries.get(key) ?? 0) + 1;
      this.retries.set(key, tries);
      const wc = this.capturing.get(key);
      if (!wc || tries > 4) return;
      setTimeout(() => {
        try {
          const contents = this.page.contents;
          if (contents && this.capturing.get(key) === wc && !wc.isDestroyed()) this.page.send('capmac-sound', { t: 'add', key, source: wc.getMediaSourceId(contents) });
        } catch {
          // gone
        }
      }, 300);
    });
    this.page.on('capmac-audio-added', (_e: unknown, key: number) => this.retries.delete(key));
  }

  /** The PC can get the sound: this Electron has what the capture needs (Electron 30 and later). */
  get canSendToPc(): boolean {
    return this.page.available;
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
    this.page.send('capmac-sound', { t: 'remove', key });
  }

  private update(): void {
    if (this.mode === 'pc' && this.listeners > 0 && this.canSendToPc) {
      for (const wc of this.host.pages()) this.capture(wc);
    } else {
      this.stopCapture();
    }
  }

  /** Starts capturing a page's sound (the capture page first, once). */
  private capture(wc: any): void {
    if (!wc || wc.isDestroyed?.() || this.capturing.has(wc.id)) return;
    this.capturing.set(wc.id, wc);
    this.holding = true;
    this.page.hold(this).then(
      (contents) => {
        if (!contents || this.capturing.get(wc.id) !== wc || wc.isDestroyed()) return;
        try {
          this.page.send('capmac-sound', { t: 'add', key: wc.id, source: wc.getMediaSourceId(contents) });
        } catch {
          this.capturing.delete(wc.id);
        }
      },
      () => {
        if (this.capturing.get(wc.id) === wc) this.host.note('CapMac could not send the app’s sound to the PC: the sound is off');
      },
    );
  }

  private stopCapture(): void {
    this.capturing.clear();
    this.retries.clear();
    if (!this.holding) return;
    this.holding = false;
    // The page may stay open for the video: its sound part lets go of everything.
    this.page.send('capmac-sound', { t: 'stop' });
    this.page.drop(this);
  }

  stop(): void {
    this.listeners = 0;
    this.stopCapture();
  }
}
