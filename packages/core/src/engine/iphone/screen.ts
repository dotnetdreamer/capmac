/**
 * The screen of a real iPhone at this PC, with no Mac: the picture from CapMac's screen-mirroring
 * receiver (receiver.ts: the iPhone mirrors to it over Wi-Fi from Control Center), and touch
 * through WebDriverAgent (wda.ts) when Developer Mode is on and touch is set up, on the cable or over
 * Wi-Fi. The same surface as ScreenStream, so Studio's pane shows it like a simulator: H.264
 * messages in CapMac's stream format, or JPEGs.
 *
 * The mirrored picture needs no Developer Mode and nothing on the iPhone. While nothing mirrors, an
 * iPhone with touch on the cable shows its picture over the cable instead (WebDriverAgent's screen
 * stream). Mirroring wins as soon as it starts: its sessions open with a keyframe, so its picture
 * can take over at any time, while it can't come back in the middle of one. When mirroring stops,
 * the pane keeps its last picture until the cable's comes, without asking for mirroring meanwhile.
 *
 * Without touch, the screen is view only and says why. Touch that stops (the iPhone left the Wi-Fi
 * or locked) starts again by itself.
 */
import type { InputEvent, ScreenInfo } from '../../shared/protocol.js';
import { STREAM_CONFIG } from '../../shared/stream.js';
import { toErrorInfo, UserError, type ErrorInfo } from '../errors.js';
import type { ScreenCodec, ScreenHandlers, VideoPacket } from '../screen.js';
import { isIphoneUdid, type WslDevice } from '../wsl/device.js';
import { mirrorReceiver, type MirrorClient, type ReceiverState } from './receiver.js';
import { WdaControl, WdaStartError } from './wda.js';

export interface PhoneScreenOptions {
  /** WebDriverAgent's bundle id on this iPhone, once touch is set up (signed and installed); undefined: view only. */
  touch?: { bundleId: string } | { unavailable: string };
  /** CapMac's Python (wsl.python), when another than its own. */
  python?: string;
}

/**
 * What the pane waits for before the picture comes: the iPhone to start mirroring to this PC, to
 * start mirroring again (it mirrors since too long to catch up, or reconnected with a session that
 * sends no picture), or Windows Firewall to let iPhones reach the receiver.
 */
export type PhoneWait = 'mirror' | 'restart-mirroring' | 'firewall';

export interface PhoneScreenHandlers extends Omit<ScreenHandlers, 'onWaiting'> {
  onWaiting?(wait: PhoneWait | null): void;
  /** Touch came (true) or went (false), with the reason when it went. */
  onTouch?(ready: boolean, reason?: string): void;
  /** The iPhone mirroring now, or null. */
  onClient?(client: MirrorClient | null): void;
}

/** Waits before touch starts again after it stopped or could not start, then every minute. */
const TOUCH_RETRY_MS = [5_000, 15_000, 30_000, 60_000];
/** Waits before the picture over the cable is asked for again after its stream ended while touch stayed on. */
const CABLE_RETRY_MS = 2_000;
/**
 * How long the pane keeps its last picture, without asking for mirroring, while the picture over the
 * cable comes (its first frame took 0.1–0.4 s after mirroring stopped).
 */
const CABLE_GRACE_MS = 3_000;

/** What the pane shows: the mirrored picture, the picture over the cable, or nothing yet. */
type PictureSource = 'mirror' | 'cable' | null;

/** While touch starts: with a passcode set, the iPhone asks for it before XCTest may take over its screen. */
const STARTING = 'Touch is starting. If your iPhone asks for its passcode, enter it there';

const touchReasonFor = (touch: PhoneScreenOptions['touch']) => (touch && 'unavailable' in touch ? touch.unavailable : STARTING);

export class PhoneScreen {
  info: ScreenInfo | null = null;
  readonly fallback = null;
  private wda: WdaControl | null = null;
  private wdaStarting: Promise<void> | null = null;
  /** Ends a start that waits for a Wi-Fi iPhone that is away, when the pane leaves it. */
  private startAbort: AbortController | null = null;
  /** Counts touch targets: a helper that finishes starting for an earlier one stops again. */
  private touchTarget = 0;
  private retries = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private active = false;
  private touch: PhoneScreenOptions['touch'];
  private touchReason: string;
  private pixels: { width: number; height: number } | null = null;
  private unsubscribe: ((options?: { now?: boolean }) => void) | null = null;
  private receiverState: ReceiverState = 'stopped';
  private firewallBlocked = false;
  /** The iPhone mirroring now, as it named itself. */
  private client: MirrorClient | null = null;
  /** What the pane shows now, in which format. */
  private source: PictureSource = null;
  private codec: ScreenCodec = 'h264';
  /** Stops the picture over the cable, while it is asked for. */
  private stopCable: (() => void) | null = null;
  private cableTimer: NodeJS.Timeout | null = null;
  /** When the picture over the cable was asked for, and the check that it came in time. */
  private cableAskedAt = 0;
  private graceTimer: NodeJS.Timeout | null = null;

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
    return this.active ? this.codec : null;
  }

  /** The picture's timestamps are this PC's own clock. */
  get clockOffsetUs(): number {
    return 0;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.receiverState = 'stopped';
    this.source = null;
    this.codec = 'h264';
    this.publishInfo();
    this.handlers.onCodec?.('h264', null);
    const receiver = mirrorReceiver();
    this.unsubscribe = receiver.subscribe({
      onVideo: (packet) => this.onMirrorVideo(packet),
      onState: (state, client) => this.onReceiverState(state, client),
      onLog: (level, message) => this.handlers.onLog?.(level, message),
      onFirewall: (blocked) => {
        this.firewallBlocked = blocked;
        this.updateWaiting();
      },
    });
    void this.startTouch();
    // A receiver that cannot start (not set up on this PC, …) ends the pane with the reason.
    await receiver.start();
  }

  /** The mirrored picture. A session opens with its config and keyframe: from there on, it is shown. */
  private onMirrorVideo(packet: VideoPacket): void {
    if (packet.header.type === STREAM_CONFIG) {
      const view = new DataView(packet.data.buffer, packet.data.byteOffset + 16, 4);
      this.pixels = { width: view.getUint16(0), height: view.getUint16(2) };
      this.show('mirror');
      this.publishInfo();
    } else if (this.source !== 'mirror') {
      // Frames of a session this screen can't show (it opened too late): the cable's picture stays.
      return;
    }
    this.handlers.onVideo?.(packet);
  }

  private onReceiverState(state: ReceiverState, client: MirrorClient | null): void {
    if (!this.active) return;
    const was = this.receiverState;
    this.receiverState = state;
    this.handlers.onClient?.(client);
    if (client?.name !== this.client?.name || client?.model !== this.client?.model) {
      this.client = client;
      this.publishInfo();
    }
    if (state === 'stopped') {
      // Not when this screen subscribes to a receiver that start() is about to start.
      if (was !== 'stopped') this.handlers.onEnd?.(toErrorInfo(new UserError('The screen receiver stopped.', 'Try again.', mirrorReceiver().lastLines)));
      return;
    }
    // Mirroring stopped, or this screen can't show it: the picture over the cable, when there is one.
    if (state !== 'mirroring') {
      if (this.source === 'mirror') this.noPicture();
      if (!this.source) this.startCablePicture();
    }
    this.updateWaiting();
  }

  /** Shows this picture from now on: the pane learns its format, and that the wait is over. */
  private show(source: 'mirror' | 'cable'): void {
    if (this.source === source) return;
    if (source === 'mirror') this.stopCablePicture();
    this.source = source;
    const codec: ScreenCodec = source === 'cable' ? 'jpeg' : 'h264';
    if (codec !== this.codec) {
      this.codec = codec;
      this.handlers.onCodec?.(codec, null);
    }
    // Whose picture it is decides whether touch may drive it.
    this.publishInfo();
    this.handlers.onWaiting?.(null);
    this.handlers.onState?.('streaming');
  }

  /** No picture to show now (the pane keeps the last one, under what it waits for). */
  private noPicture(): void {
    this.source = null;
    this.publishInfo();
  }

  /** What the pane waits for while it has no picture: mirroring, mirroring again, or Windows Firewall. */
  private updateWaiting(): void {
    if (this.source) return this.handlers.onWaiting?.(null);
    // The picture over the cable is on its way: the pane keeps what it shows a moment longer.
    const graceLeft = this.stopCable ? this.cableAskedAt + CABLE_GRACE_MS - Date.now() : 0;
    if (graceLeft > 0) {
      if (!this.graceTimer) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (this.active) this.updateWaiting();
        }, graceLeft);
        this.graceTimer.unref();
      }
      return this.handlers.onWaiting?.(null);
    }
    switch (this.receiverState) {
      case 'starting':
      case 'waiting':
        return this.handlers.onWaiting?.(this.firewallBlocked ? 'firewall' : 'mirror');
      case 'catch-up':
      case 'no-picture':
        return this.handlers.onWaiting?.('restart-mirroring');
      case 'mirroring':
        // Its picture comes with its config.
        this.handlers.onWaiting?.(null);
        return this.handlers.onState?.('streaming');
      default:
        return;
    }
  }

  /**
   * The picture over the cable while nothing mirrors: WebDriverAgent's screen stream, once touch is
   * on for an iPhone on the cable (over Wi-Fi, mirroring is the picture). Asked for again while
   * touch stays on.
   */
  private startCablePicture(): void {
    const wda = this.wda;
    if (!this.active || this.stopCable || this.source === 'mirror' || !wda?.canWatchScreen || this.device.connection === 'network') return;
    this.stopCableRetry();
    this.cableAskedAt = Date.now();
    this.stopCable = wda.watchScreen(
      (jpeg) => {
        this.show('cable');
        this.handlers.onFrame(jpeg);
      },
      (reason) => {
        this.stopCable = null;
        if (this.source === 'cable') {
          this.noPicture();
          this.updateWaiting();
        }
        if (!this.active || this.wda !== wda || !wda.ready) return;
        this.handlers.onLog?.('warn', `The picture over the cable stopped (${reason}). Trying again`);
        this.cableTimer = setTimeout(() => {
          this.cableTimer = null;
          this.startCablePicture();
        }, CABLE_RETRY_MS);
        this.cableTimer.unref();
      },
    );
  }

  private stopCableRetry(): void {
    if (this.cableTimer) clearTimeout(this.cableTimer);
    this.cableTimer = null;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private stopCablePicture(): void {
    this.stopCableRetry();
    const stop = this.stopCable;
    this.stopCable = null;
    stop?.();
  }

  /** Touch went (or moved to another iPhone): so did its picture over the cable. */
  private cableGone(): void {
    this.stopCablePicture();
    if (this.source !== 'cable') return;
    this.noPicture();
    this.updateWaiting();
  }

  /**
   * Touch for another iPhone or app (Studio's pane moved to another target or project, or another
   * iPhone mirrors), while the picture goes on as it is. Touch that is on, or starting, with the same
   * helper on the same iPhone stays on.
   */
  retarget(device: WslDevice, touch: PhoneScreenOptions['touch']): void {
    const helper = (t: PhoneScreenOptions['touch']) => (t && 'bundleId' in t ? t.bundleId : null);
    const same = device.udid === this.device.udid && helper(touch) !== null && helper(touch) === helper(this.touch);
    this.device = device;
    this.touch = touch;
    if (same && (this.wda || this.wdaStarting)) return;
    this.touchTarget += 1;
    this.stopRetrying();
    this.startAbort?.abort();
    const wda = this.wda;
    this.wda = null;
    this.wdaStarting = null;
    this.cableGone();
    void wda?.stop();
    this.touchReason = touchReasonFor(touch);
    this.publishInfo();
    if (this.active) void this.startTouch();
  }

  private startTouch(): Promise<void> {
    const touch = this.touch;
    if (!touch || 'unavailable' in touch || this.wda || this.wdaStarting) return this.wdaStarting ?? Promise.resolve();
    const target = this.touchTarget;
    const device = this.device;
    const wifi = device.connection === 'network';
    const abort = new AbortController();
    this.startAbort = abort;
    // Said once per iPhone, not at every try again.
    if (this.retries === 0) this.setTouch(false, STARTING);
    const wda = new WdaControl(device, touch.bundleId, {
      python: this.options.python,
      signal: abort.signal,
      // A Wi-Fi iPhone that is asleep or locked: touch starts once it is back.
      onLocked: () => {
        if (target === this.touchTarget) this.setTouch(false, `Unlock ${device.name}${wifi ? ' and keep it on this Wi-Fi' : ''} to use touch`);
      },
      onEnded: (reason) => {
        if (this.wda !== wda) return;
        this.wda = null;
        this.cableGone();
        this.handlers.onLog?.('warn', `Touch stopped: ${reason}`);
        this.setTouch(false, wifi ? `Touch stopped. It comes back by itself when ${device.name} is unlocked on this Wi-Fi` : 'Touch stopped. It comes back by itself in a moment');
        this.retryTouch(target);
      },
    });
    const starting: Promise<void> = wda.start().then(
      () => {
        if (!this.active || target !== this.touchTarget) return void wda.stop();
        this.wda = wda;
        this.retries = 0;
        this.setTouch(true);
        // Nothing mirrors: the iPhone's picture comes over the cable now.
        if (this.source !== 'mirror') this.startCablePicture();
      },
      (error: unknown) => {
        void wda.stop();
        if (!this.active || target !== this.touchTarget) return;
        const info = toErrorInfo(error);
        this.setTouch(false, info.hint ? `${info.message} ${info.hint}` : info.message);
        // WebDriverAgent gone from the iPhone: "Turn on touch" puts it back, and starts touch then.
        if (!(error instanceof WdaStartError && !error.retry)) this.retryTouch(target);
      },
    ).finally(() => {
      if (this.wdaStarting === starting) this.wdaStarting = null;
      if (this.startAbort === abort) this.startAbort = null;
    });
    this.wdaStarting = starting;
    return starting;
  }

  /** Starts touch again a while later, for as long as the pane shows this iPhone. */
  private retryTouch(target: number): void {
    if (!this.active || target !== this.touchTarget || this.retryTimer) return;
    const delay = TOUCH_RETRY_MS[Math.min(this.retries, TOUCH_RETRY_MS.length - 1)]!;
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.active && target === this.touchTarget) void this.startTouch();
    }, delay);
    this.retryTimer.unref();
  }

  private stopRetrying(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retries = 0;
  }

  private setTouch(ready: boolean, reason?: string): void {
    this.touchReason = reason ?? '';
    this.publishInfo();
    this.handlers.onTouch?.(ready, reason);
  }

  /**
   * The iPhone mirroring, when it isn't the one touch is for (by the name and model it gave the
   * receiver): touch then stays off, so nobody drives a phone they can't see. The picture over the
   * cable is always the touch iPhone's own.
   */
  private otherPhone(): MirrorClient | null {
    const client = this.client;
    if (!client || this.source === 'cable' || !this.touch || 'unavailable' in this.touch) return null;
    const sameModel = !client.model || !this.device.productType || client.model === this.device.productType;
    return client.name === this.device.name && sameModel ? null : client;
  }

  private publishInfo(): void {
    const other = this.otherPhone();
    const touch = this.wda?.ready === true && !other;
    // The mirrored picture is about three pixels a point; the picture over the cable comes with touch, which measures the points.
    const scale = 3;
    const cable = this.source === 'cable' ? this.wda?.screenSize ?? null : null;
    this.info = {
      t: 'screen', source: 'device', codec: this.codec,
      points: cable ?? (this.pixels ? { width: Math.round(this.pixels.width / scale), height: Math.round(this.pixels.height / scale) } : null),
      ...(cable ? {} : { scale }),
      input: touch,
      inputMode: 'gestures',
      // Touch follows the iPhone that mirrors when this PC knows it: then it isn't the pane's own.
      ...(isIphoneUdid(this.device.udid) ? { phone: { udid: this.device.udid, name: this.device.name } } : {}),
      ...(touch ? {} : {
        inputReason: other
          ? `Touch is for ${this.device.name}, but ${other.name} is mirroring. To use touch on ${other.name}, plug it into this PC once with a cable`
          : this.touchReason || 'Touch needs Developer Mode on the iPhone',
      }),
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
    const other = this.otherPhone();
    if (other) throw new UserError(`${other.name} is mirroring, but full-size screenshots come from ${this.device.name}.`, `Mirror ${this.device.name} instead, or plug ${other.name} into this PC once with a cable.`);
    return this.wda.screenshot();
  }

  /** Taps, swipes, text, keys and buttons (the pane's gestures mode). */
  input(event: InputEvent): void {
    const wda = this.wda;
    if (!wda?.ready || this.otherPhone()) return;
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
        return wda.drag(event.x1, event.y1, event.x2, event.y2, event.durationMs / 1000, { pressMs: event.pressMs, holdMs: event.holdMs });
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
    this.stopRetrying();
    this.startAbort?.abort();
    this.stopCablePicture();
    this.source = null;
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
