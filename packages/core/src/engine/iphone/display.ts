/**
 * The screen of an iPhone with iOS 26 or later as Xcode 26's Device Hub shows it: CoreDevice's display
 * service streams it through the no-admin tunnel, on the cable or over Wi-Fi, and takes touch,
 * buttons and keys while it streams (display-runner.py, CapMac's Python). It needs Developer Mode and
 * nothing installed on the iPhone. The helper passes the stream's RTP to a loopback port here, where
 * rtp-h264.ts turns it into CapMac's stream messages (the mirrored picture's too).
 *
 * Unlike mirroring, the iPhone sends a keyframe when asked: one is asked for after a lost packet, and
 * whenever the picture has to start again.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import { trackChild } from '../../agent/proc.js';
import { parseStreamHeader, type StreamHeader } from '../../shared/stream.js';
import { CancelledError, UserError } from '../errors.js';
import { deviceHelperCommand, OVER_WIFI, type WslDevice, type WslDeviceOptions } from '../wsl/device.js';
import runnerScript from './display-runner.py';
import { H264Depacketizer, H264Messages, parseRtp } from './rtp-h264.js';

/** The RTP payload type the iPhone sends H.264 with (HEVC is 123). */
const H264_PAYLOAD = 100;
/** Keyframes asked for no closer together than this (the encoder chokes on a storm of them). */
const KEYFRAME_GAP_MS = 700;

/** The iOS version from which an iPhone streams its screen this way (Xcode 26's Device Hub). */
export const DISPLAY_STREAM_IOS = 26;

/** Whether this iPhone's screen can come from its own stream (iOS 26 or later). */
export function hasDisplayStream(device: Pick<WslDevice, 'productVersion'>): boolean {
  const major = Number(device.productVersion?.split('.')[0]);
  return Number.isFinite(major) && major >= DISPLAY_STREAM_IOS;
}

export interface DisplayStreamOptions extends WslDeviceOptions {
  /** A config or frame message, in CapMac's stream format. */
  onVideo?(packet: { data: Buffer; header: StreamHeader }): void;
  /** The stream stopped after it ran (the iPhone locked or left, the cable came out, …). */
  onEnded?(reason: string): void;
}

export class DisplayStream {
  private child: ChildProcess | null = null;
  private socket: dgram.Socket | null = null;
  private depacketizer = new H264Depacketizer();
  private messages = new H264Messages();
  private running = false;
  private stopped = false;
  private keyAskedAt = 0;
  private readonly stderr: string[] = [];
  private shots: Array<(png: Buffer | null) => void> = [];

  constructor(private readonly device: WslDevice, private readonly options: DisplayStreamOptions = {}) {}

  /** The stream runs: pictures come, and touch works. */
  get ready(): boolean {
    return this.running;
  }

  /** The current config message (the picture starts again from it and a keyframe). */
  get lastConfig(): Buffer | null {
    return this.messages.lastConfig;
  }

  /** Starts the helper and waits for the stream to run. */
  async start(): Promise<void> {
    const wifi = this.device.connection === 'network';
    const socket = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 * 1024 * 1024 });
    socket.on('message', (packet) => this.onPacket(packet));
    socket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', () => {
        socket.off('error', reject);
        resolve();
      });
    });
    this.socket = socket;
    const python = await deviceHelperCommand(this.options, this.device.udid);
    const args = [this.device.udid, wifi ? 'wifi' : 'usb', String(socket.address().port), 'h264'];
    const child = spawn(python.executable, [...python.prefix, '-c', `${OVER_WIFI}${runnerScript}`, ...args], { env: python.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    trackChild(child);
    this.child = child;
    child.stdin!.on('error', () => undefined);
    child.stderr!.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) this.stderr.push(line.trimEnd());
      if (this.stderr.length > 60) this.stderr.splice(0, this.stderr.length - 60);
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const onAbort = () => reject(new CancelledError());
      this.options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line === 'CAPMAC_STREAM') {
            this.running = true;
            resolve();
          } else if (line === 'CAPMAC_LOCKED') this.options.onLocked?.();
          else if (line.startsWith('CAPMAC_SHOT')) this.shots.shift()?.(line.length > 12 ? Buffer.from(line.slice(12), 'base64') : null);
          else if (line.startsWith('CAPMAC_ENDED')) this.ended(line.slice(13) || 'the stream stopped');
          else if (line.trim()) this.options.onLog?.(line);
        }
      });
      child.once('exit', (code) => {
        this.options.signal?.removeEventListener('abort', onAbort);
        if (!this.running) reject(new UserError('The iPhone did not stream its screen.', this.startHint(), this.stderr.slice(-12)));
        else this.ended(code ? `the screen helper stopped (exit ${code})` : 'the screen helper stopped');
        for (const shot of this.shots.splice(0)) shot(null);
      });
      child.once('error', (error) => reject(new UserError('Could not start the iPhone tools.', String(error))));
    });
  }

  private startHint(): string {
    const text = this.stderr.join('\n');
    if (/DeveloperMode|developer mode/i.test(text)) return 'Turn on Developer Mode on the iPhone.';
    if (/9022|camera or microphone/i.test(text)) return 'An app on the iPhone uses its camera or microphone. Close it, then try again.';
    if (this.device.connection === 'network') return 'Unlock the iPhone and keep it on this Wi-Fi, then try again.';
    return 'Unlock the iPhone and keep it plugged in, then try again.';
  }

  private ended(reason: string): void {
    const was = this.running;
    this.running = false;
    if (!this.stopped && was) this.options.onEnded?.(reason);
  }

  private onPacket(packet: Buffer): void {
    if (parseRtp(packet)?.payload && (packet[1]! & 0x7f) !== H264_PAYLOAD) return;
    const lostBefore = this.depacketizer.lost;
    for (const unit of this.depacketizer.push(packet)) {
      for (const message of this.messages.push(unit, Date.now() * 1000)) this.options.onVideo?.({ data: message, header: parseStreamHeader(message)! });
    }
    // A lost packet: pictures stop until a keyframe, so ask for one now.
    if (this.depacketizer.lost !== lostBefore) this.requestKeyframe();
  }

  private send(command: object): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** A keyframe from the iPhone, soon (not more often than the encoder copes with). */
  requestKeyframe(): void {
    const now = Date.now();
    if (now - this.keyAskedAt < KEYFRAME_GAP_MS) return;
    this.keyAskedAt = now;
    this.send({ t: 'key' });
  }

  /** The finger down at, or moved to, (x, y) (0..1 from the top left), or lifted. */
  touch(down: boolean, x: number, y: number): void {
    this.send({ t: 'touch', down, x, y });
  }

  /** A button: pressed (no `down`), or held down and let go. */
  button(name: 'home' | 'lock' | 'volume-up' | 'volume-down', down?: boolean): void {
    this.send(down === undefined ? { t: 'button', name } : { t: 'button', name, down });
  }

  /** The keyboard keys held now, as HID usages (none: all let go). */
  keys(usages: number[]): void {
    this.send({ t: 'keys', usages });
  }

  /** A PNG of the screen at its own size. */
  screenshot(): Promise<Buffer> {
    if (!this.running) return Promise.reject(new UserError('The iPhone’s screen is not streaming.'));
    return new Promise((resolve, reject) => {
      this.shots.push((png) => (png ? resolve(png) : reject(new UserError('The iPhone did not send the picture.'))));
      this.send({ t: 'shot' });
    });
  }

  /** Ends the stream (closing the helper's stdin ends it on the iPhone too). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    const child = this.child;
    this.child = null;
    this.socket?.close();
    this.socket = null;
    if (!child || child.exitCode !== null) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      // The helper ends the iPhone's session first (a few seconds at most).
      const kill = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
    });
  }
}
