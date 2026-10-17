/**
 * The screen of a real iPhone at this PC, with no Mac: the picture from CapMac's screen-mirroring
 * receiver (receiver.ts: the iPhone mirrors to it over Wi-Fi from Control Center), and touch
 * through WebDriverAgent (wda.ts) when the iPhone is plugged in, Developer Mode is on and touch is
 * set up. The same surface as ScreenStream, so Studio's pane shows it like a simulator: H.264
 * messages in CapMac's stream format.
 *
 * The picture needs no Developer Mode and nothing on the iPhone. Without touch, the screen is view
 * only and says why.
 */
import type { InputEvent, ScreenInfo } from '../../shared/protocol.js';
import { STREAM_CONFIG } from '../../shared/stream.js';
import { toErrorInfo, UserError, type ErrorInfo } from '../errors.js';
import type { ScreenCodec, ScreenHandlers } from '../screen.js';
import type { WslDevice } from '../wsl/device.js';
import { mirrorReceiver, type MirrorClient, type ReceiverState } from './receiver.js';
import { WdaControl } from './wda.js';

export interface PhoneScreenOptions {
  /** WebDriverAgent's bundle id on this iPhone, once touch is set up (signed and installed); undefined: view only. */
  touch?: { bundleId: string } | { unavailable: string };
  /** CapMac's Python (wsl.python), when another than its own. */
  python?: string;
}

/**
 * What the pane waits for before the picture comes: the iPhone to start mirroring to this PC,
 * (it mirrors already, since too long to catch up) to start mirroring again, or Windows Firewall
 * to let iPhones reach the receiver.
 */
export type PhoneWait = 'mirror' | 'restart-mirroring' | 'firewall';

export interface PhoneScreenHandlers extends Omit<ScreenHandlers, 'onWaiting'> {
  onWaiting?(wait: PhoneWait | null): void;
  /** Touch came (true) or went (false), with the reason when it went. */
  onTouch?(ready: boolean, reason?: string): void;
  /** The iPhone mirroring now, or null. */
  onClient?(client: MirrorClient | null): void;
}

const touchReasonFor = (touch: PhoneScreenOptions['touch']) => (touch && 'unavailable' in touch ? touch.unavailable : 'Touch is starting');

export class PhoneScreen {
  info: ScreenInfo | null = null;
  readonly fallback = null;
  private wda: WdaControl | null = null;
  private wdaStarting: Promise<void> | null = null;
  /** Counts touch targets: a helper that finishes starting for an earlier one stops again. */
  private touchTarget = 0;
  private active = false;
  private touch: PhoneScreenOptions['touch'];
  private touchReason: string;
  private pixels: { width: number; height: number } | null = null;
  private unsubscribe: ((options?: { now?: boolean }) => void) | null = null;
  private receiverState: ReceiverState = 'stopped';
  private firewallBlocked = false;

  constructor(private device: WslDevice, private readonly options: PhoneScreenOptions, private readonly handlers: PhoneScreenHandlers) {
    this.touch = options.touch;
    this.touchReason = touchReasonFor(options.touch);
  }

  get udid(): string {
    return this.device.udid;
  }

  get isDevice(): boolean {
    return true;
  }

  get running(): boolean {
    return this.active;
  }

  get currentCodec(): ScreenCodec | null {
    return this.active ? 'h264' : null;
  }

  /** The picture's timestamps are this PC's own clock. */
  get clockOffsetUs(): number {
    return 0;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.receiverState = 'stopped';
    this.publishInfo();
    this.handlers.onCodec?.('h264', null);
    const receiver = mirrorReceiver();
    this.unsubscribe = receiver.subscribe({
      onVideo: (packet) => {
        if (packet.header.type === STREAM_CONFIG) {
          const view = new DataView(packet.data.buffer, packet.data.byteOffset + 16, 4);
          this.pixels = { width: view.getUint16(0), height: view.getUint16(2) };
          this.publishInfo();
        }
        this.handlers.onVideo?.(packet);
      },
      onState: (state, client) => this.onReceiverState(state, client),
      onLog: (level, message) => this.handlers.onLog?.(level, message),
      onFirewall: (blocked) => {
        this.firewallBlocked = blocked;
        if (this.receiverState === 'waiting') this.handlers.onWaiting?.(blocked ? 'firewall' : 'mirror');
      },
    });
    void this.startTouch();
    // A receiver that cannot start (not set up on this PC, …) ends the pane with the reason.
    await receiver.start();
  }

  private onReceiverState(state: ReceiverState, client: MirrorClient | null): void {
    if (!this.active) return;
    const was = this.receiverState;
    this.receiverState = state;
    this.handlers.onClient?.(client);
    switch (state) {
      case 'starting':
      case 'waiting':
        this.handlers.onWaiting?.(this.firewallBlocked ? 'firewall' : 'mirror');
        break;
      case 'catch-up':
        this.handlers.onWaiting?.('restart-mirroring');
        break;
      case 'mirroring':
        this.handlers.onWaiting?.(null);
        this.handlers.onState?.('streaming');
        break;
      case 'stopped':
        // Not when this screen subscribes to a receiver that start() is about to start.
        if (was !== 'stopped') this.handlers.onEnd?.(toErrorInfo(new UserError('The screen receiver stopped.', 'Try again.', mirrorReceiver().lastLines)));
        break;
    }
  }

  /**
   * Touch for another iPhone or app (Studio's pane moved to another target or project), while the
   * picture goes on as it is. Touch that is on, or starting, with the same helper on the same iPhone
   * stays on.
   */
  retarget(device: WslDevice, touch: PhoneScreenOptions['touch']): void {
    const helper = (t: PhoneScreenOptions['touch']) => (t && 'bundleId' in t ? t.bundleId : null);
    const same = device.udid === this.device.udid && helper(touch) !== null && helper(touch) === helper(this.touch);
    this.device = device;
    this.touch = touch;
    if (same && (this.wda || this.wdaStarting)) return;
    this.touchTarget += 1;
    const wda = this.wda;
    this.wda = null;
    this.wdaStarting = null;
    void wda?.stop();
    this.touchReason = touchReasonFor(touch);
    this.publishInfo();
    if (this.active) void this.startTouch();
  }

  private startTouch(): Promise<void> {
    const touch = this.touch;
    if (!touch || 'unavailable' in touch || this.wda || this.wdaStarting) return this.wdaStarting ?? Promise.resolve();
    const target = this.touchTarget;
    const wda = new WdaControl(this.device, touch.bundleId, {
      python: this.options.python,
      onEnded: (reason) => {
        if (this.wda !== wda) return;
        this.wda = null;
        this.setTouch(false, `Touch stopped: ${reason}`);
      },
    });
    const starting: Promise<void> = wda.start().then(
      () => {
        if (!this.active || target !== this.touchTarget) return void wda.stop();
        this.wda = wda;
        this.setTouch(true);
      },
      (error: unknown) => {
        void wda.stop();
        if (target !== this.touchTarget) return;
        const info = toErrorInfo(error);
        this.setTouch(false, info.hint ? `${info.message} ${info.hint}` : info.message);
      },
    ).finally(() => {
      if (this.wdaStarting === starting) this.wdaStarting = null;
    });
    this.wdaStarting = starting;
    return starting;
  }

  private setTouch(ready: boolean, reason?: string): void {
    this.touchReason = reason ?? '';
    this.publishInfo();
    this.handlers.onTouch?.(ready, reason);
  }

  private publishInfo(): void {
    const touch = this.wda?.ready === true;
    const scale = 3;
    this.info = {
      t: 'screen', source: 'device', codec: 'h264',
      points: this.pixels ? { width: Math.round(this.pixels.width / scale), height: Math.round(this.pixels.height / scale) } : null,
      scale,
      input: touch,
      inputMode: 'gestures',
      ...(touch ? {} : { inputReason: this.touchReason || 'Touch needs Developer Mode on the iPhone' }),
    };
    this.handlers.onInfo?.(this.info);
  }

  /** The iPhone sends a keyframe only when mirroring starts: there is none to ask for. */
  requestKeyframe(): void {}

  /** The iPhone picks its own size; the pane scales it. */
  setVideoSize(_pixels: number): void {}

  retrySmooth(): void {}

  /** A full-size PNG: WebDriverAgent's when touch is on. */
  async still(): Promise<Buffer> {
    if (!this.wda?.ready) throw new UserError('Full-size screenshots of this iPhone need touch to be on.', 'Turn on touch, or use a screenshot of the pane.');
    return this.wda.screenshot();
  }

  /** Taps, swipes, text, keys and buttons (the pane's gestures mode). */
  input(event: InputEvent): void {
    const wda = this.wda;
    if (!wda?.ready) return;
    void this.perform(wda, event).catch((error: unknown) => {
      const info = toErrorInfo(error);
      this.handlers.onLog?.('warn', `Touch: ${info.message}${info.hint ? ` ${info.hint}` : ''}`);
    });
  }

  private async perform(wda: WdaControl, event: InputEvent): Promise<void> {
    switch (event.kind) {
      case 'tap':
        return wda.tap(event.x, event.y);
      case 'swipe': {
        const still = Math.hypot(event.x2 - event.x1, event.y2 - event.y1) < 0.015;
        if (still) return wda.hold(event.x1, event.y1, event.durationMs / 1000);
        return wda.drag(event.x1, event.y1, event.x2, event.y2, event.durationMs / 1000);
      }
      case 'text':
        return wda.type(event.text);
      case 'key': {
        const typed = ({ return: '\n', delete: '\b', tab: '\t' } as Record<string, string>)[event.key];
        if (typed) return wda.type(typed);
        return;
      }
      case 'button':
        if (event.phase === 'up') return;
        if (event.button === 'home') return wda.button('home');
        if (event.button === 'lock' || event.button === 'side') return wda.button('lock');
        return;
      default:
        return;
    }
  }

  /**
   * Leaves the receiver and stops touch. The receiver keeps running a while, so the iPhone keeps
   * mirroring for a window that reloads; `forGood`: the screen was closed for good, so the receiver
   * stops at once when no other screen uses it.
   */
  stop({ forGood = false }: { forGood?: boolean } = {}): void {
    this.active = false;
    this.unsubscribe?.({ now: forGood });
    this.unsubscribe = null;
    const wda = this.wda;
    this.wda = null;
    void wda?.stop();
  }

  dispose(options?: { forGood?: boolean }): void {
    this.stop(options);
  }
}

export type { ErrorInfo };
