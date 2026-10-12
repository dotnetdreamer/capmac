/**
 * The simulator's screen as a stream of JPEG frames (agent `screen` op), plus
 * touch/keyboard input (via AXe on the Mac, when installed). Used by the
 * CLI's browser viewer and capmac Studio's simulator pane. Survives
 * reconnects: when the MacLink is restored, an active stream restarts.
 */
import type { InputEvent, ScreenInfo } from '../shared/protocol.js';
import type { AgentCall } from './agent-client.js';
import { toErrorInfo, type ErrorInfo } from './errors.js';
import type { MacLink } from './link.js';

export interface ScreenStreamOptions {
  fps?: number;
  /** JPEG quality 20-100. */
  quality?: number;
  /** Longest side of the frames in pixels. */
  maxSize?: number;
}

export interface ScreenHandlers {
  onFrame(jpeg: Buffer): void;
  onInfo?(info: ScreenInfo): void;
  onLog?(level: 'info' | 'warn' | 'error', message: string): void;
  /** The stream stopped (error is undefined when it was stopped on purpose). */
  onEnd?(error?: ErrorInfo): void;
  /** Frames are flowing (again), or the connection dropped and the stream resumes when it is back. */
  onState?(state: 'streaming' | 'reconnecting'): void;
}

export class ScreenStream {
  info: ScreenInfo | null = null;
  private call: AgentCall<unknown> | null = null;
  private starting: Promise<void> | null = null;
  private active = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly link: MacLink, readonly udid: string, private readonly options: ScreenStreamOptions, private readonly handlers: ScreenHandlers) {
    this.unsubscribe = link.onChange((state) => {
      if (state === 'lost' || state === 'reconnecting') {
        this.call = null;
        if (this.active) this.handlers.onState?.('reconnecting');
      }
      if ((state === 'restored' || state === 'connected') && this.active) void this.ensure().catch(() => undefined);
    });
  }

  get running(): boolean {
    return this.call !== null;
  }

  /** Starts streaming (no-op when already running). */
  async start(): Promise<void> {
    this.active = true;
    await this.ensure();
  }

  private ensure(): Promise<void> {
    if (this.call) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const session = await this.link.session();
      const call = await session.agent.start('screen', {
        udid: this.udid,
        fps: this.options.fps ?? 12,
        quality: this.options.quality ?? 70,
        maxSize: this.options.maxSize,
      }, {
        onEvent: (event) => {
          if (event.t === 'screen') {
            this.info = event;
            this.handlers.onInfo?.(event);
          } else if (event.t === 'log' && event.level !== 'debug') {
            this.handlers.onLog?.(event.level, event.msg);
          }
        },
        onBinary: (jpeg) => this.handlers.onFrame(jpeg),
      });
      if (!this.active) {
        call.cancel();
        return;
      }
      this.call = call;
      this.handlers.onState?.('streaming');
      call.result.then(
        () => {
          if (this.call === call) this.call = null;
          this.handlers.onEnd?.();
        },
        (err) => {
          if (this.call === call) this.call = null;
          const info = toErrorInfo(err);
          // A dropped connection is not the stream's fault: it restarts when the link is back.
          if (this.active && (this.link.state === 'lost' || this.link.state === 'reconnecting')) this.handlers.onState?.('reconnecting');
          else this.handlers.onEnd?.(info.cancelled ? undefined : info);
        },
      );
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Sends a tap, swipe, key or button press (starts the stream if needed). */
  input(event: InputEvent): void {
    void this.ensure().then(() => this.call?.send({ t: 'input', event }), () => undefined);
  }

  stop(): void {
    this.active = false;
    this.call?.cancel();
    this.call = null;
  }

  dispose(): void {
    this.stop();
    this.unsubscribe();
  }
}
