/**
 * The simulator's screen, live: the smooth stream (H.264 from capmac's helper
 * on the Mac, agent op `stream`) with the compatible stream (JPEG screenshots,
 * agent op `screen`) as its automatic fallback, plus input (through the
 * helper, else AXe). Used by capmac Studio's simulator pane and the CLI's
 * browser viewer. Survives reconnects: when the MacLink is restored, an active
 * stream restarts, starting from a keyframe.
 */
import type { InputEvent, ScreenInfo, StreamFallback } from '../shared/protocol.js';
import type { Route } from '../shared/remote.js';
import { parseStreamHeader, STREAM_FRAME, type StreamHeader } from '../shared/stream.js';
import type { AgentCall } from './agent-client.js';
import { toErrorInfo, type ErrorInfo } from './errors.js';
import type { MacLink } from './link.js';
import type { MacSession } from './session.js';

export type { StreamFallback } from '../shared/protocol.js';

export type ScreenCodec = 'h264' | 'jpeg';

/** 'smooth' prefers H.264 and falls back by itself; 'compatible' is JPEG only. */
export type StreamPreference = 'smooth' | 'compatible';

export interface ScreenStreamOptions {
  /** Default 'compatible'. */
  prefer?: StreamPreference;
  /** JPEG frames a second (compatible stream). */
  fps?: number;
  /** JPEG quality 20-100. */
  quality?: number;
  /** Longest side of the JPEG frames, and of the video, in pixels. */
  maxSize?: number;
  /** Take input through capmac's helper when it works (default true; AXe otherwise). */
  helperInput?: boolean;
}

/** One message of the smooth stream, as the helper wrote it (header and payload). */
export interface VideoPacket {
  data: Buffer;
  header: StreamHeader;
}

export interface ScreenHandlers {
  /** A JPEG frame (compatible stream). */
  onFrame(jpeg: Buffer): void;
  /** A config or frame message (smooth stream). */
  onVideo?(packet: VideoPacket): void;
  onInfo?(info: ScreenInfo): void;
  onLog?(level: 'info' | 'warn' | 'error', message: string): void;
  /** The stream stopped (error is undefined when it was stopped on purpose). */
  onEnd?(error?: ErrorInfo): void;
  /** Frames are flowing (again), or the connection dropped and the stream resumes when it is back. */
  onState?(state: 'streaming' | 'reconnecting'): void;
  /** Which stream is on, and why it is the compatible one when the smooth one was wanted. */
  onCodec?(codec: ScreenCodec, fallback: StreamFallback | null): void;
  /** Smooth stream: preparing the helper on the Mac (compiling it the first time). */
  onPreparing?(stage: 'building' | 'starting', xcode?: string): void;
  /** The Mac's clock minus this PC's, in µs, and the round trip it was measured with. */
  onClock?(offsetUs: number, rttUs: number): void;
  /** Smooth stream: the helper's memory and traffic on the Mac, and the bitrate adaptive bitrate chose, every few seconds. */
  onStatus?(status: { footprint: number; fps: number; dropped: number; bitrate?: number }): void;
}

/**
 * Where adaptive bitrate starts and how high it may go, by route: the local
 * network takes the full rate; over the internet the Mac's upload is often
 * the limit, and the relay goes through your server.
 */
export function bitratesFor(route: Route): { bitrate: number; minBitrate: number; maxBitrate: number } {
  if (route === 'relay') return { bitrate: 2_500_000, minBitrate: 400_000, maxBitrate: 4_000_000 };
  if (route === 'direct') return { bitrate: 4_000_000, minBitrate: 500_000, maxBitrate: 6_000_000 };
  return { bitrate: 6_000_000, minBitrate: 1_000_000, maxBitrate: 6_000_000 };
}

/** No keyframe this long after asking for one: the smooth stream is not working. */
export const PICTURE_TIMEOUT_MS = 1500;

/** Microseconds since the Unix epoch on this PC, with sub-millisecond resolution. */
export function nowUs(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

/**
 * The Mac's clock relative to this PC's, NTP style: of the recent pings, the
 * one with the shortest round trip gives the most precise offset.
 */
export class ClockSync {
  private samples: Array<{ offset: number; rtt: number }> = [];

  /** A ping sent at `sentUs` (PC), answered at `macUs` (Mac), back at `receivedUs` (PC). */
  add(sentUs: number, macUs: number, receivedUs: number): void {
    const rtt = receivedUs - sentUs;
    if (!(rtt >= 0) || !Number.isFinite(macUs)) return;
    this.samples.push({ offset: macUs - (sentUs + rtt / 2), rtt });
    if (this.samples.length > 16) this.samples.shift();
  }

  /** Mac µs minus PC µs, or null before the first ping came back. */
  get offsetUs(): number | null {
    return this.best?.offset ?? null;
  }

  get rttUs(): number | null {
    return this.best?.rtt ?? null;
  }

  private get best(): { offset: number; rtt: number } | undefined {
    let best: { offset: number; rtt: number } | undefined;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best;
  }
}

/**
 * What a failed smooth stream means: a reason to fall back to the compatible
 * stream, or null when the screen cannot be shown at all (no simulator) or the
 * stream was cancelled.
 */
export function fallbackFor(error: unknown): StreamFallback | null {
  const info = toErrorInfo(error);
  if (info.cancelled) return null;
  switch (info.code) {
    case 'CANCELLED':
    case 'TARGET_NOT_FOUND':
      return null;
    case 'HELPER_BUILD_FAILED':
      return { code: 'helper-build', message: info.message, hint: info.hint, details: info.details };
    case 'STREAM_UNSUPPORTED':
      return { code: 'unsupported', message: info.message, hint: info.hint };
    case 'BAD_REQUEST':
      return { code: 'unsupported', message: 'The CapMac agent on the Mac has no smooth stream.', details: [info.message] };
    case 'HELPER_START_FAILED':
      return { code: 'helper-start', message: info.message, hint: info.hint, details: info.details, restartSimulator: true };
    case 'HELPER_EXITED':
      return { code: 'helper-exit', message: info.message, hint: info.hint, details: info.details, restartSimulator: true };
    case 'STREAM_STALLED':
      return { code: 'stalled', message: info.message, hint: info.hint, restartSimulator: true };
    default:
      return { code: 'error', message: info.message, hint: info.hint, details: info.details };
  }
}

export class ScreenStream {
  info: ScreenInfo | null = null;
  /** Set once the smooth stream gave up for this stream; stays until retrySmooth(). */
  fallback: StreamFallback | null = null;
  private call: AgentCall<unknown> | null = null;
  private codec: ScreenCodec | null = null;
  private starting: Promise<void> | null = null;
  private active = false;
  private videoSize: number;
  private readonly clock = new ClockSync();
  private readonly pings = new Map<number, number>();
  private nextPing = 1;
  private pingTimer: NodeJS.Timeout | null = null;
  private ackTimer: NodeJS.Timeout | null = null;
  private pictureTimer: NodeJS.Timeout | null = null;
  private lastSeq = 0;
  private ackedSeq = 0;
  private keyRequestedAt = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly link: MacLink, readonly udid: string, private readonly options: ScreenStreamOptions, private readonly handlers: ScreenHandlers) {
    this.videoSize = options.maxSize ?? 1400;
    this.unsubscribe = link.onChange((state) => {
      if (state === 'lost' || state === 'reconnecting') {
        this.dropCall();
        if (this.active) this.handlers.onState?.('reconnecting');
      }
      if ((state === 'restored' || state === 'connected') && this.active) void this.ensure().catch(() => undefined);
    });
  }

  get running(): boolean {
    return this.call !== null;
  }

  /** The stream showing now (null before it started). */
  get currentCodec(): ScreenCodec | null {
    return this.codec;
  }

  /** The Mac's clock minus this PC's, in µs (null until measured). */
  get clockOffsetUs(): number | null {
    return this.clock.offsetUs;
  }

  /** Starts streaming (no-op when already running). */
  async start(): Promise<void> {
    this.active = true;
    await this.ensure();
  }

  private wantsSmooth(): boolean {
    return this.options.prefer === 'smooth' && !this.fallback;
  }

  private ensure(): Promise<void> {
    if (this.call) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const session = await this.link.session();
      if (!this.active || this.call) return;
      if (this.wantsSmooth()) await this.startSmooth(session);
      else await this.startCompatible(session);
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startSmooth(session: MacSession): Promise<void> {
    this.lastSeq = 0;
    this.ackedSeq = 0;
    const rates = bitratesFor(session.route);
    const call: AgentCall<unknown> = await session.agent.start('stream', { udid: this.udid, maxSize: this.videoSize, fps: 60, ...rates }, {
      onEvent: (event) => {
        if (this.call !== call) return;
        switch (event.t) {
          case 'stream-prepare':
            this.handlers.onPreparing?.(event.stage, event.xcode);
            break;
          case 'screen':
            this.info = event;
            this.handlers.onInfo?.(event);
            break;
          case 'ready':
            // The helper is up and sends a keyframe first: it must arrive promptly.
            this.armPictureTimer();
            break;
          case 'pong':
            this.onPong(event.id, event.mac);
            break;
          case 'stream-status':
            this.handlers.onStatus?.({ footprint: event.footprint, fps: event.fps, dropped: event.dropped, bitrate: event.bitrate });
            break;
          case 'log':
            if (event.level !== 'debug') this.handlers.onLog?.(event.level, event.msg);
            break;
        }
      },
      onBinary: (data) => {
        if (this.call !== call) return;
        const header = parseStreamHeader(data);
        if (!header) return;
        if (header.type === STREAM_FRAME) {
          this.lastSeq = header.seq;
          if (header.key) {
            this.keyRequestedAt = 0;
            this.disarmPictureTimer();
          }
        }
        this.handlers.onVideo?.({ data, header });
      },
    });
    if (!this.active) {
      call.cancel();
      return;
    }
    this.call = call;
    this.codec = 'h264';
    this.handlers.onCodec?.('h264', null);
    this.handlers.onState?.('streaming');
    this.startTimers(call, true);
    call.result.then(
      () => this.ended(call),
      (err) => this.ended(call, err),
    );
  }

  private async startCompatible(session: MacSession): Promise<void> {
    const call: AgentCall<unknown> = await session.agent.start('screen', {
      udid: this.udid,
      fps: this.options.fps ?? 12,
      quality: this.options.quality ?? 70,
      maxSize: this.options.maxSize,
      helperInput: this.options.helperInput !== false,
    }, {
      onEvent: (event) => {
        if (this.call !== call) return;
        if (event.t === 'screen') {
          this.info = event;
          this.handlers.onInfo?.(event);
        } else if (event.t === 'pong') {
          this.onPong(event.id, event.mac);
        } else if (event.t === 'log' && event.level !== 'debug') {
          this.handlers.onLog?.(event.level, event.msg);
        }
      },
      onBinary: (jpeg) => {
        if (this.call === call) this.handlers.onFrame(jpeg);
      },
    });
    if (!this.active) {
      call.cancel();
      return;
    }
    this.call = call;
    this.codec = 'jpeg';
    this.handlers.onCodec?.('jpeg', this.options.prefer === 'smooth' ? this.fallback : null);
    this.handlers.onState?.('streaming');
    this.startTimers(call, false);
    call.result.then(
      () => this.ended(call),
      (err) => this.ended(call, err),
    );
  }

  private startTimers(call: AgentCall<unknown>, video: boolean): void {
    this.stopTimers();
    // Pings measure the clock (for latency) and tell the agent the client is still there.
    const ping = () => {
      const id = this.nextPing++;
      const sent = nowUs();
      this.pings.set(id, sent);
      if (this.pings.size > 8) this.pings.delete(this.pings.keys().next().value!);
      call.send({ t: 'ping', id, pc: sent });
    };
    ping();
    this.pingTimer = setInterval(ping, 2000);
    if (video) {
      // Frames that made it here: the agent keeps no more than a few hundred ms in flight.
      this.ackTimer = setInterval(() => {
        if (this.lastSeq > this.ackedSeq) {
          this.ackedSeq = this.lastSeq;
          call.send({ t: 'ack', seq: this.lastSeq });
        }
      }, 40);
    }
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ackTimer) clearInterval(this.ackTimer);
    this.pingTimer = null;
    this.ackTimer = null;
    this.disarmPictureTimer();
  }

  private onPong(id: number, macUs: number): void {
    const sent = this.pings.get(id);
    if (sent === undefined) return;
    this.pings.delete(id);
    this.clock.add(sent, macUs, nowUs());
    const offset = this.clock.offsetUs;
    const rtt = this.clock.rttUs;
    if (offset !== null && rtt !== null) this.handlers.onClock?.(offset, rtt);
  }

  private armPictureTimer(): void {
    if (this.pictureTimer || this.codec !== 'h264') return;
    this.pictureTimer = setTimeout(() => {
      this.pictureTimer = null;
      if (this.codec === 'h264' && this.call) {
        this.fallBack({ code: 'no-picture', message: 'The simulator sent no picture to the smooth stream.', restartSimulator: true });
      }
    }, PICTURE_TIMEOUT_MS);
  }

  private disarmPictureTimer(): void {
    if (this.pictureTimer) clearTimeout(this.pictureTimer);
    this.pictureTimer = null;
  }

  /** Forgets the current call (it is replaced, or the connection dropped). */
  private dropCall(): AgentCall<unknown> | null {
    const call = this.call;
    this.call = null;
    this.stopTimers();
    return call;
  }

  private ended(call: AgentCall<unknown>, err?: unknown): void {
    // A call replaced on purpose (fallback, retry, stop) ends quietly.
    if (this.call !== call) return;
    const codec = this.codec;
    this.dropCall();
    if (!this.active) return;
    // A dropped connection is not the stream's fault: it restarts when the link is back.
    if (this.link.state === 'lost' || this.link.state === 'reconnecting') {
      this.handlers.onState?.('reconnecting');
      return;
    }
    if (codec === 'h264' && err !== undefined) {
      const reason = fallbackFor(err);
      if (reason) {
        this.fallBack(reason);
        return;
      }
    }
    const info = err === undefined ? undefined : toErrorInfo(err);
    this.handlers.onEnd?.(info?.cancelled ? undefined : info);
  }

  /** The smooth stream gave up: show the compatible one, and say why. */
  private fallBack(reason: StreamFallback): void {
    if (!this.active) return;
    this.fallback = reason;
    this.dropCall()?.cancel();
    this.codec = 'jpeg';
    this.handlers.onCodec?.('jpeg', reason);
    this.ensure().catch((err) => this.handlers.onEnd?.(toErrorInfo(err)));
  }

  /** Smooth stream: asks for a keyframe (decoder reset, dropped frames). It must arrive promptly. */
  requestKeyframe(): void {
    if (this.codec !== 'h264' || !this.call) return;
    // One request at a time: several parts of the pipeline may ask for the same keyframe.
    const now = Date.now();
    if (now - this.keyRequestedAt < 500) return;
    this.keyRequestedAt = now;
    this.call.send({ t: 'keyframe' });
    this.armPictureTimer();
  }

  /** Smooth stream: the video's longest side in pixels (follow the pane's size). */
  setVideoSize(pixels: number): void {
    const size = Math.round(Math.min(3000, Math.max(480, pixels)));
    if (size === this.videoSize) return;
    this.videoSize = size;
    if (this.codec === 'h264') this.call?.send({ t: 'size', maxSize: size });
  }

  /** After a fallback: tries the smooth stream again. */
  retrySmooth(): void {
    if (this.options.prefer !== 'smooth' || !this.fallback) return;
    this.fallback = null;
    this.dropCall()?.cancel();
    if (this.active) this.ensure().catch((err) => this.handlers.onEnd?.(toErrorInfo(err)));
  }

  /** Sends input (starts the stream if needed). */
  input(event: InputEvent): void {
    void this.ensure().then(() => this.call?.send({ t: 'input', event }), () => undefined);
  }

  stop(): void {
    this.active = false;
    this.dropCall()?.cancel();
  }

  dispose(): void {
    this.stop();
    this.unsubscribe();
  }
}
