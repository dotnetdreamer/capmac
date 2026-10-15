/**
 * An Electron app's windows, live, from the Mac (agent op `electron-screen`):
 * JPEG frames straight from the app's compositor, through CapMac's module in
 * the app, and mouse, wheel and keyboard input back. It waits while the app
 * is not running and follows it across restarts and reconnects. Used by
 * CapMac Studio's window pane and the CLI's browser viewer.
 */
import type { AppDialog, AppDialogAnswer, AppDialogClosed, AppWindowInfo, MacFolder, SoundMode } from '../shared/electron.js';
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
  /** Send the app's sound when it plays on this PC (see onAudio). */
  audio?: boolean;
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
  /** The app's dialogs waiting for an answer here (shown over its window); `closed` says what happened to one that went. */
  onDialogs?(dialogs: AppDialog[], closed?: { id: number; how: AppDialogClosed }): void;
  /** Where the app's sound plays, and whether it can play on this PC. */
  onSound?(mode: SoundMode, toPc: boolean): void;
  /** The app's sound when it plays on this PC: Opus packets in order (see APP_AUDIO). */
  onAudio?(packets: Buffer[]): void;
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
  dialogs: AppDialog[] = [];
  sound: { mode: SoundMode; toPc: boolean } | null = null;
  private call: AgentCall<unknown> | null = null;
  private audio: boolean;
  private nextReq = 1;
  private readonly replies = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
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
    this.audio = options.audio ?? false;
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
        audio: this.audio,
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
            case 'app-sound':
              this.sound = { mode: event.mode, toPc: event.toPc };
              this.handlers.onSound?.(event.mode, event.toPc);
              break;
            case 'app-audio':
              this.handlers.onAudio?.(event.packets.map((p) => Buffer.from(p, 'base64')));
              break;
            case 'app-dialogs':
              this.dialogs = event.dialogs;
              this.handlers.onDialogs?.(event.dialogs, event.closed);
              break;
            case 'app-dialog-reply': {
              const waiting = this.replies.get(event.req);
              if (!waiting) break;
              this.replies.delete(event.req);
              clearTimeout(waiting.timer);
              if (event.ok) waiting.resolve(event.data);
              else waiting.reject(new Error(event.error ?? 'The app could not do that.'));
              break;
            }
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
    for (const [req, waiting] of this.replies) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('The connection to the Mac dropped.'));
      this.replies.delete(req);
    }
    if (call && this.dialogs.length) {
      this.dialogs = [];
      this.handlers.onDialogs?.([]);
    }
    return call;
  }

  /** A dialog request through the screen's call, answered by `app-dialog-reply`. */
  private dialogRequest(message: Record<string, unknown>): Promise<unknown> {
    const call = this.call;
    if (!call) return Promise.reject(new Error('The app is not showing here.'));
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(req);
        reject(new Error('The app did not answer.'));
      }, 20_000);
      this.replies.set(req, { resolve, reject, timer });
      call.send({ ...message, req });
    });
  }

  /** Where the app's sound plays from now on (the app says so back with onSound). */
  setSound(mode: SoundMode): void {
    void this.ensure().then(() => this.call?.send({ t: 'sound', mode }), () => undefined);
  }

  /** Whether this screen wants the app's sound when it plays on this PC. */
  setAudio(on: boolean): void {
    if (on === this.audio) return;
    this.audio = on;
    this.call?.send({ t: 'audio', on });
  }

  /** Answers one of the app's dialogs. */
  answerDialog(dialog: number, answer: AppDialogAnswer): Promise<void> {
    return this.dialogRequest({ t: 'dialog-answer', dialog, answer }).then(() => undefined);
  }

  /** A folder on the Mac, for a file dialog ("~" is the home folder). */
  async listFolder(path: string, hidden = false): Promise<MacFolder> {
    return (await this.dialogRequest({ t: 'dialog-list', path, hidden })) as MacFolder;
  }

  /** Makes a folder on the Mac (a file dialog's New Folder). */
  async makeFolder(path: string): Promise<string> {
    return String(await this.dialogRequest({ t: 'dialog-mkdir', path }));
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
