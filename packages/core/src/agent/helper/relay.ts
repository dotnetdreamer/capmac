/**
 * The agent's half of a smooth stream, for either helper (a simulator's or a
 * plugged-in iPhone's). Frames go to the client as binary frames, unchanged;
 * acks, clock pings, keyframe and size requests and input come back. It keeps
 * latency bounded on a slow network and adapts the bitrate (VideoPacer, which
 * an Electron app's window shares, see ops/electron.ts), reports every few
 * seconds, and ends when the client stops talking, the helper stops or a check
 * fails. No orphans: the op stops the helper when this returns.
 */
import type { InputEvent, StreamParams } from '../../shared/protocol.js';
import { STREAM_CONFIG, type StreamHeader } from '../../shared/stream.js';
import type { AgentIO } from '../io.js';
import { AgentError, sleep } from '../proc.js';
import { BitrateController } from './bitrate.js';
import type { HelperExit, HelperHandlers, StreamHelper } from './process.js';
import type { StallWatch } from './stall.js';
import { VideoWindow } from './window.js';

/** The client pings every couple of seconds; this long without a word means it is gone. */
export const CLIENT_TIMEOUT_MS = 15_000;

const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The pacing every smooth stream shares. Each video message goes out or is
 * dropped to keep latency bounded on a slow network (VideoWindow); every
 * 100 ms or so `tick` says whether the source should send a keyframe (the way
 * is clear again after drops) or change its bitrate (adaptive bitrate, once a
 * second), and every few seconds what to report.
 */
export class VideoPacer {
  window: VideoWindow;
  readonly bitrate: BitrateController;
  /** Frames sent since the stream started. */
  frames = 0;
  private droppedBefore = 0;
  private lastKeyAsk = 0;
  private lastTick: number;
  private tickFrames = 0;
  private tickDropped = 0;
  private lastStatus: number;
  private statusFrames = 0;

  constructor(params: Pick<StreamParams, 'bitrate' | 'minBitrate' | 'maxBitrate'>, private readonly now: () => number = Date.now) {
    this.window = new VideoWindow(now);
    const maxBitrate = clampInt(params.maxBitrate ?? params.bitrate, 1_000_000, 20_000_000, 6_000_000);
    this.bitrate = new BitrateController({
      start: clampInt(params.bitrate, 300_000, maxBitrate, maxBitrate),
      min: clampInt(params.minBitrate, 300_000, maxBitrate, 600_000),
      max: maxBitrate,
    }, now);
    this.lastTick = this.lastStatus = now();
  }

  /** Frames dropped to catch up since the stream started. */
  get dropped(): number {
    return this.droppedBefore + this.window.dropped;
  }

  /** Whether a video message goes out now (configs always do). */
  offer(header: StreamHeader, backlog: number): boolean {
    if (header.type === STREAM_CONFIG) return true;
    if (!this.window.offer(header.seq, header.key, backlog)) return false;
    this.frames += 1;
    return true;
  }

  /** The client got every frame up to `seq`. */
  ack(seq: number): void {
    this.window.ack(seq);
  }

  /** A new source (the app restarted): the frames in flight are forgotten, the bitrate stays. */
  restart(): void {
    this.droppedBefore += this.window.dropped;
    this.window = new VideoWindow(this.now);
    this.lastKeyAsk = 0;
  }

  /** What the source should do now, and (every 5 s) the numbers to report. */
  tick(backlog: number): { keyframe: boolean; bitrate: number | null; status: { fps: number; dropped: number } | null } {
    const now = this.now();
    let keyframe = false;
    // Dropped frames to catch up: once the way is clear, restart from a keyframe.
    if (this.window.wantsKeyframe(backlog) && now - this.lastKeyAsk > 400) {
      keyframe = true;
      this.lastKeyAsk = now;
    }
    let bitrate: number | null = null;
    // Adaptive bitrate: once a second, from how the frames got through.
    if (now - this.lastTick >= 1000) {
      this.lastTick = now;
      bitrate = this.bitrate.tick({ peakLagMs: this.window.takePeakLag(), dropped: this.dropped - this.tickDropped, frames: this.frames - this.tickFrames, backlogBytes: backlog });
      this.tickFrames = this.frames;
      this.tickDropped = this.dropped;
    }
    let status: { fps: number; dropped: number } | null = null;
    if (now - this.lastStatus >= 5000) {
      status = { fps: Math.round(((this.frames - this.statusFrames) * 1000) / (now - this.lastStatus)), dropped: this.dropped };
      this.lastStatus = now;
      this.statusFrames = this.frames;
    }
    return { keyframe, bitrate, status };
  }
}

export interface RelayHooks {
  /** Why the helper stopping ends the stream: an error for the client. */
  failure(exit: HelperExit): AgentError;
  /** An input event from the client. */
  onInput?(event: InputEvent): void;
  /** A client message the relay itself does not handle. */
  onMessage?(message: any): void;
  /** The stall check found a change the helper did not see (simulators). */
  stalled?(): AgentError;
}

export class StreamRelay {
  readonly pacer: VideoPacer;
  private footprint = 0;
  private helperDropped = 0;
  private lastHeard = Date.now();
  private hooks: RelayHooks | null = null;
  private helper: StreamHelper | null = null;
  /** Set from callbacks (the helper exiting, the stall check): ends the stream. */
  private failure: AgentError | null = null;
  private stopping = false;

  constructor(private readonly io: AgentIO, params: StreamParams, private readonly watch?: StallWatch) {
    this.pacer = new VideoPacer(params);
  }

  /** Where the helper's bitrate starts, and how adaptive bitrate moves it. */
  get bitrate(): BitrateController {
    return this.pacer.bitrate;
  }

  /** The helper's video and status go here (spread them into its handlers). */
  readonly handlers: Pick<HelperHandlers, 'onVideo' | 'onStatus'> = {
    onVideo: (message, header) => this.video(message, header),
    onStatus: (status) => {
      if (status.callbacks > 0) this.watch?.activity();
      this.footprint = status.footprint;
      this.helperDropped += status.dropped;
    },
  };

  private video(message: Buffer, header: StreamHeader): void {
    this.watch?.activity();
    if (this.pacer.offer(header, this.io.backlog)) this.io.sendLive(message);
  }

  /** Takes the client's messages for `helper` from now on (before waiting for its hello, too). */
  attach(helper: StreamHelper, hooks: RelayHooks): void {
    this.helper = helper;
    this.hooks = hooks;
    this.lastHeard = Date.now();
    this.io.onMessage((message) => {
      this.lastHeard = Date.now();
      switch (message?.t) {
        case 'ack':
          if (Number.isInteger(message.seq)) this.pacer.ack(message.seq);
          break;
        case 'keyframe':
          helper.send('k');
          break;
        case 'ping':
          this.io.send({ t: 'pong', id: Number(message.id) || 0, pc: Number(message.pc) || 0, mac: nowUs() });
          break;
        case 'size':
          helper.send(`s ${clampInt(message.maxSize, 480, 3000, 1400)}`);
          break;
        case 'input': {
          const event = message.event as InputEvent | undefined;
          if (event) hooks.onInput?.(event);
          break;
        }
        default:
          hooks.onMessage?.(message);
      }
    });
    void helper.exited.then((exit) => {
      if (!this.stopping && !this.io.signal.aborted) this.failure ??= hooks.failure(exit);
    });
  }

  /** Ends the stream with `error`. */
  fail(error: AgentError): void {
    this.failure ??= error;
  }

  /** True while the client is there and nothing failed. */
  private get going(): boolean {
    return !this.io.signal.aborted && !this.failure && Date.now() - this.lastHeard <= CLIENT_TIMEOUT_MS;
  }

  /**
   * Waits for `promise` (the helper's hello) for as long as the client is
   * there: a device may wait for its cable as long as someone looks at it.
   * Null when the client went away first; throws what failed meanwhile.
   */
  async waitFor<T>(promise: Promise<T>): Promise<T | null> {
    let done = false;
    let value: T | null = null;
    const settled = promise.then(
      (v) => {
        done = true;
        value = v;
      },
      () => {
        done = true;
      },
    );
    while (!done && this.going) await Promise.race([settled, sleep(250, this.io.signal)]);
    if (this.failure) throw this.failure;
    return done ? value : null;
  }

  /** Relays until the client goes away, the helper stops or a check fails. */
  async run(): Promise<{ frames: number; dropped: number }> {
    const helper = this.helper;
    if (!helper) throw new Error('StreamRelay.run before attach');
    let lastCheck = Date.now();
    while (this.going) {
      await sleep(100, this.io.signal);
      const now = Date.now();
      const pace = this.pacer.tick(this.io.backlog);
      if (pace.keyframe) helper.send('k');
      if (pace.bitrate) helper.send(`r ${pace.bitrate}`);
      if (this.watch && this.hooks?.stalled && now - lastCheck >= 1000) {
        lastCheck = now;
        const stalled = this.hooks.stalled;
        void this.watch.check().then((yes) => {
          if (yes) this.failure ??= stalled();
        });
      }
      if (pace.status) this.io.send({ t: 'stream-status', footprint: this.footprint, fps: pace.status.fps, dropped: pace.status.dropped + this.helperDropped, bitrate: this.pacer.bitrate.current });
    }
    if (this.failure) throw this.failure;
    return { frames: this.pacer.frames, dropped: this.pacer.dropped + this.helperDropped };
  }

  /** Stops the helper (the op is done with it): its exit is no failure then. */
  async close(): Promise<void> {
    this.stopping = true;
    await this.helper?.stop();
  }
}
