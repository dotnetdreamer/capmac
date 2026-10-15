/**
 * An Electron app's windows, live, from the Mac (agent op `electron-screen`):
 * JPEG frames straight from the app's compositor, through CapMac's module in
 * the app, and mouse, wheel and keyboard input back. It waits while the app
 * is not running and follows it across restarts and reconnects. Used by
 * CapMac Studio's window pane and the CLI's browser viewer.
 */
import type { AppWindowInfo } from '../shared/electron.js';
import type { InputEvent, ScreenInfo } from '../shared/protocol.js';
import type { AgentCall } from './agent-client.js';
import { toErrorInfo, type ErrorInfo } from './errors.js';
import type { MacLink } from './link.js';
import { ClockSync, nowUs } from './screen.js';

export interface AppScreenOptions {
  fps?: number;
  /** JPEG quality 30-95. */
  quality?: number;
  /** Longest side of the frames in pixels. */
  maxSize?: number;
  /** The window to show (null or missing: follow the focused one). */
  window?: number | null;
}

export interface AppScreenHandlers {
  onFrame(jpeg: Buffer): void;
  /** The window showing: its size in points and the display's scale. */
  onInfo?(info: ScreenInfo): void;
  onWindows?(windows: AppWindowInfo[], watched: number | null): void;
  /** The pointer's shape over the window (Electron's cursor type). */
  onCursor?(cursor: string): void;
  /** Text copied in the app, for this PC's clipboard. */
  onClipboard?(text: string): void;
  /** The app is not running (or restarting), or shows again. */
  onWaiting?(waiting: boolean): void;
  onState?(state: 'streaming' | 'reconnecting'): void;
  onEnd?(error?: ErrorInfo): void;
  onClock?(offsetUs: number, rttUs: number): void;
}

export class AppScreenStream {
  info: ScreenInfo | null = null;
  windows: AppWindowInfo[] = [];
  watched: number | null = null;
  waiting = true;
  private call: AgentCall<unknown> | null = null;
  private starting: Promise<void> | null = null;
  private active = false;
  private maxSize: number;
  private window: number | null;
  private readonly clock = new ClockSync();
  private readonly pings = new Map<number, number>();
  private nextPing = 1;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly link: MacLink, readonly projectId: string, private readonly options: AppScreenOptions, private readonly handlers: AppScreenHandlers) {
    this.maxSize = options.maxSize ?? 1400;
    this.window = options.window ?? null;
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

  async start(): Promise<void> {
    this.active = true;
    await this.ensure();
  }

  private ensure(): Promise<void> {
    if (this.call) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const session = await this.link.session();
      if (!this.active || this.call) return;
      const call: AgentCall<unknown> = await session.agent.start('electron-screen', {
        projectId: this.projectId,
        maxSize: this.maxSize,
        fps: this.options.fps ?? 30,
        quality: this.options.quality ?? 72,
        window: this.window,
      }, {
        onEvent: (event) => {
          if (this.call !== call) return;
          switch (event.t) {
            case 'screen':
              this.info = event;
              this.handlers.onInfo?.(event);
              break;
            case 'app-windows':
              this.windows = event.windows;
              this.watched = event.watched;
              this.handlers.onWindows?.(event.windows, event.watched);
              break;
            case 'app-cursor':
              this.handlers.onCursor?.(event.cursor);
              break;
            case 'app-clipboard':
              this.handlers.onClipboard?.(event.text);
              break;
            case 'app-waiting':
              this.waiting = event.waiting;
              this.handlers.onWaiting?.(event.waiting);
              break;
            case 'pong':
              this.onPong(event.id, event.mac);
              break;
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
      this.handlers.onState?.('streaming');
      this.startPings(call);
      call.result.then(
        () => this.ended(call),
        (err) => this.ended(call, err),
      );
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private startPings(call: AgentCall<unknown>): void {
    this.stopPings();
    // Pings tell the agent the client is still there (and measure the clock).
    const ping = () => {
      const id = this.nextPing++;
      const sent = nowUs();
      this.pings.set(id, sent);
      if (this.pings.size > 8) this.pings.delete(this.pings.keys().next().value!);
      call.send({ t: 'ping', id, pc: sent });
    };
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private onPong(id: number, macUs: number): void {
    const sent = this.pings.get(id);
    if (sent === undefined) return;
    this.pings.delete(id);
    this.clock.add(sent, macUs, nowUs());
    if (this.clock.offsetUs !== null && this.clock.rttUs !== null) this.handlers.onClock?.(this.clock.offsetUs, this.clock.rttUs);
  }

  private dropCall(): AgentCall<unknown> | null {
    const call = this.call;
    this.call = null;
    this.stopPings();
    return call;
  }

  private ended(call: AgentCall<unknown>, err?: unknown): void {
    if (this.call !== call) return;
    this.dropCall();
    if (!this.active) return;
    if (this.link.state === 'lost' || this.link.state === 'reconnecting') {
      this.handlers.onState?.('reconnecting');
      return;
    }
    const info = err === undefined ? undefined : toErrorInfo(err);
    this.handlers.onEnd?.(info?.cancelled ? undefined : info);
  }

  /** Sends input to the window showing. */
  input(event: InputEvent): void {
    void this.ensure().then(() => this.call?.send({ t: 'input', event }), () => undefined);
  }

  /** The frames' longest side in pixels (follow the pane's size). */
  setVideoSize(pixels: number): void {
    const size = Math.round(Math.min(4096, Math.max(320, pixels)));
    if (size === this.maxSize) return;
    this.maxSize = size;
    this.call?.send({ t: 'size', maxSize: size });
  }

  /** Shows this window (null: follow the focused one). */
  selectWindow(window: number | null): void {
    this.window = window;
    this.call?.send({ t: 'window', window });
  }

  /** The window's traffic lights. */
  windowAction(window: number, action: 'close' | 'minimize' | 'zoom'): void {
    this.call?.send({ t: 'window-action', window, action });
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
