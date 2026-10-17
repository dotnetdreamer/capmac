/**
 * The screen of an iPhone on this PC's Wi-Fi, with no Mac, no app on the iPhone and no Developer
 * Mode: CapMac runs a screen-mirroring receiver the iPhone mirrors to from Control Center. It is
 * UxPlay (GPL-3.0), built for Windows with a small patch and shipped by CapMac as its own folder
 * (see receiverHome: Studio's installer carries it). UxPlay decrypts the iPhone's H.264 and forwards it as RTP to a loopback UDP
 * port; rtp-h264.ts turns that into CapMac's stream messages, the same ones the Mac's helpers write.
 *
 * One receiver serves the whole PC and screens subscribe to it. The iPhone sends a keyframe only
 * when mirroring starts, so the receiver keeps everything since that keyframe (up to a limit) for a
 * screen that opens later. It stops itself a while after the last screen closes (at once when that
 * screen was closed for good), which also ends the iPhone's mirroring.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackChild } from '../../agent/proc.js';
import { MIRROR_RECEIVER_NAME } from '../../shared/mirror.js';
import { parseStreamHeader, STREAM_CONFIG, type StreamHeader } from '../../shared/stream.js';
import { UserError } from '../errors.js';
import { H264Depacketizer, H264Messages } from './rtp-h264.js';

/** UxPlay 1.74 at commit 4e95a9e with CapMac's patch, bundle revision 1. */
export const RECEIVER_VERSION = '1.74-4e95a9e-1';

/** How much of the stream since the last keyframe is kept for a screen that opens later (about 8 minutes). */
const CATCH_UP_BYTES = 64 * 1024 * 1024;
/** Stop this long after the last screen closed (the iPhone stops mirroring then). */
const IDLE_STOP_MS = 10 * 60 * 1000;
/** How often Windows Firewall is asked again while it blocks the receiver, or may be asking about it. */
const FIREWALL_RECHECK_MS = 3000;
/** Windows asks about a new receiver when it first listens: how long a missing rule may still be on its way. */
const FIREWALL_ASKING_MS = 2 * 60 * 1000;

/** The receiver Studio's installer ships (resources/mirror-receiver), once the engine said where. */
let bundledHome: string | null = null;

/** Studio tells the engine where its installer put the receiver (null: not a packaged Studio). */
export function setBundledReceiver(home: string | null): void {
  bundledHome = home;
}

/** CapMac's own folder on this PC (%LOCALAPPDATA%\CapMac). */
function localDir(): string {
  const base = process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA) ? process.env.LOCALAPPDATA : path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'CapMac');
}

/**
 * The receiver's folder: CAPMAC_MIRROR_RECEIVER when it is set (a folder build.sh made), else the
 * one Studio's installer ships, else the one set up on this PC by hand (development).
 */
export function receiverHome(): string {
  const override = process.env.CAPMAC_MIRROR_RECEIVER;
  if (override && path.isAbsolute(override)) return override;
  if (bundledHome && receiverInstalled(bundledHome)) return bundledHome;
  return path.join(localDir(), 'mirror-receiver', RECEIVER_VERSION);
}

export function receiverInstalled(home = receiverHome()): boolean {
  return existsSync(path.join(home, 'bin', 'uxplay.exe')) && existsSync(path.join(home, 'lib', 'gstreamer-1.0', 'libgstrtp.dll'));
}

/** What to do about a missing receiver, for where this CapMac looks for it. */
function missingReceiverHint(): string {
  const override = process.env.CAPMAC_MIRROR_RECEIVER;
  if (override && path.isAbsolute(override)) return `CAPMAC_MIRROR_RECEIVER is set to ${override}, which has no receiver in it.`;
  if (bundledHome) return 'Install CapMac Studio again to get it back.';
  return 'Build it with packages/core/receiver/build.sh and put it where that script says.';
}

/** GStreamer's plugin cache for a receiver folder, kept with CapMac's own files (Studio's folder can be read-only). */
function registryFile(home: string): string {
  const tag = createHash('sha256').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 8);
  return path.join(localDir(), 'mirror-receiver', `registry-${RECEIVER_VERSION}-${tag}.bin`);
}

/** The iPhone mirroring to this PC, as it introduced itself. */
export interface MirrorClient {
  name: string;
  /** "iPhone15,3" */
  model: string;
  deviceId: string;
}

/**
 * `waiting`: the receiver is on the network and no iPhone mirrors to it; `mirroring`: pictures come;
 * `catch-up`: an iPhone mirrors, but this screen opened too long after its keyframe to show it
 * (mirroring has to start again on the iPhone).
 */
export type ReceiverState = 'stopped' | 'starting' | 'waiting' | 'mirroring' | 'catch-up';

export interface ReceiverListener {
  /** A config or frame message, as the Mac's helpers write them. */
  onVideo(packet: { data: Buffer; header: StreamHeader }): void;
  onState(state: ReceiverState, client: MirrorClient | null): void;
  onLog?(level: 'info' | 'warn' | 'error', message: string): void;
  /** Windows Firewall blocks iPhones from reaching the receiver on this network (checked once it is up). */
  onFirewall?(blocked: boolean): void;
}

/**
 * PowerShell (no admin) that says whether Windows Firewall lets iPhones reach `exe` on the networks
 * this PC is on now: `allowed`, `blocked` (a block rule, or rules for other network types only), or
 * `none` (no rules yet: Windows asks the first time the receiver listens).
 */
export function firewallCheckScript(exe: string): string {
  const quoted = `'${exe.replace(/'/g, "''")}'`;
  return [
    `$rules = @(Get-NetFirewallApplicationFilter -Program ${quoted} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' })`,
    "if (-not $rules.Count) { 'none'; exit 0 }",
    "$kinds = @(Get-NetConnectionProfile | ForEach-Object { if ([string]$_.NetworkCategory -eq 'DomainAuthenticated') { 'Domain' } else { [string]$_.NetworkCategory } })",
    'foreach ($kind in $kinds) {',
    "  $covering = @($rules | Where-Object { [string]$_.Profile -eq 'Any' -or ([string]$_.Profile) -match $kind })",
    "  if (@($covering | Where-Object { [string]$_.Action -eq 'Block' }).Count -or -not @($covering | Where-Object { [string]$_.Action -eq 'Allow' }).Count) { 'blocked'; exit 0 }",
    '}',
    "'allowed'",
  ].join('\n');
}

/** Runs firewallCheckScript: 'allowed', 'blocked', 'none', or 'unknown' when PowerShell could not say. */
function firewallVerdict(exe: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', firewallCheckScript(exe)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', () => resolve('unknown'));
    child.on('close', () => resolve(out.trim().split(/\r?\n/).pop() ?? 'unknown'));
  });
}

/** What one line of UxPlay's output means to CapMac. */
export type ReceiverEvent =
  | { t: 'ready' }
  | { t: 'client'; client: MirrorClient }
  | { t: 'connections'; count: number }
  | { t: 'streaming' }
  | { t: 'error'; message: string };

export function parseReceiverLine(line: string): ReceiverEvent | null {
  let m: RegExpMatchArray | null;
  if (/register_dnssd: advertised/.test(line)) return { t: 'ready' };
  if ((m = /connection request from (.+) \((.+)\) with deviceID = (\S+)/.exec(line))) return { t: 'client', client: { name: m[1]!.trim(), model: m[2]!.trim(), deviceId: m[3]!.trim() } };
  if ((m = /Open connections: (\d+)/.exec(line))) return { t: 'connections', count: Number(m[1]) };
  if (/Begin streaming to GStreamer video pipeline/.test(line)) return { t: 'streaming' };
  if ((m = /\*\*\* ERROR: (.+)/.exec(line))) return { t: 'error', message: m[1]!.trim() };
  if ((m = /Required gstreamer plugin '(.+)' not found/.exec(line))) return { t: 'error', message: `The screen receiver is missing its ${m[1]} part.` };
  return null;
}

/** The arguments CapMac starts UxPlay with: video forwarded to `port`, nothing played or shown here. */
export function receiverArgs(name: string, port: number): string[] {
  return [
    '-n', name, '-nh',
    // No audio, and the video goes out as RTP without being decoded (`identity` keeps the patched
    // startup from asking for the "bad" h264parse plugin).
    '-as', '0', '-vp', 'identity',
    '-vrtp', `config-interval=1 ! udpsink host=127.0.0.1 port=${port} sync=false`,
    '-fps', '60',
    // A new iPhone takes over from the one mirroring now, instead of being turned away.
    '-nohold',
    // Connection changes are only in its debug output (1: without packet dumps).
    '-d', '1',
  ];
}

export class MirrorReceiver {
  state: ReceiverState = 'stopped';
  client: MirrorClient | null = null;
  private child: ChildProcess | null = null;
  private socket: dgram.Socket | null = null;
  private depacketizer = new H264Depacketizer();
  private messages = new H264Messages();
  private readonly listeners = new Set<ReceiverListener>();
  /** Frames since the last keyframe (the config is messages.lastConfig). */
  private catchUp: Buffer[] = [];
  private catchUpBytes = 0;
  private catchUpLost = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private firewallTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private restarts = 0;
  private readonly recent: string[] = [];
  /** Whether Windows Firewall blocks the receiver here (null: not checked yet). */
  firewallBlocked: boolean | null = null;

  /**
   * catchUpLimit: how much is kept for a screen that opens later, in bytes (CATCH_UP_BYTES).
   * firewallVerdict: how Windows Firewall is asked (firewallCheckScript, in PowerShell).
   */
  constructor(private readonly options: { name: string; home?: string; catchUpLimit?: number; firewallVerdict?: (exe: string) => Promise<string> }) {}

  private get home(): string {
    return this.options.home ?? receiverHome();
  }

  /**
   * Starts the receiver if needed and feeds this listener, catching it up on what is mirroring now.
   * Unsubscribing leaves it running a while (a reloaded window catches up); `{ now: true }`: the
   * screen was closed for good, so it stops at once when no other screen uses it.
   */
  subscribe(listener: ReceiverListener): (options?: { now?: boolean }) => void {
    this.listeners.add(listener);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.catchUpListener(listener);
    void this.start().catch((error: unknown) => listener.onLog?.('error', error instanceof Error ? error.message : String(error)));
    return ({ now = false } = {}) => {
      if (!this.listeners.delete(listener) || this.listeners.size) return;
      if (now) {
        this.stop();
        return;
      }
      if (!this.idleTimer) {
        this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
        this.idleTimer.unref();
      }
    };
  }

  private catchUpListener(listener: ReceiverListener): void {
    if (this.firewallBlocked !== null) listener.onFirewall?.(this.firewallBlocked);
    const config = this.messages.lastConfig;
    if (this.state === 'mirroring' && (!config || this.catchUpLost || !this.catchUp.length)) {
      listener.onState('catch-up', this.client);
      return;
    }
    listener.onState(this.state, this.client);
    if (this.state !== 'mirroring' || !config) return;
    listener.onVideo(packet(config));
    for (const frame of this.catchUp) listener.onVideo(packet(frame));
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (process.platform !== 'win32') throw new UserError('The screen-mirroring receiver is for Windows.', 'On a Mac, CapMac shows a plugged-in iPhone through the Mac.');
    if (!receiverInstalled(this.home)) throw new UserError('The screen-mirroring receiver is not set up on this PC yet.', missingReceiverHint());
    this.setState('starting');
    const socket = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 * 1024 * 1024 });
    socket.on('message', (packet) => this.onPacket(packet));
    socket.on('error', (error) => this.log('warn', `Screen receiver socket: ${error.message}`));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', () => {
        socket.off('error', reject);
        resolve();
      });
    });
    this.socket = socket;
    const registry = registryFile(this.home);
    await fs.mkdir(path.dirname(registry), { recursive: true }).catch(() => undefined);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Only the bundle's own DLLs and GStreamer plugins: nothing the PC happens to have installed.
      PATH: [path.join(this.home, 'bin'), path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows'].join(';'),
      GST_PLUGIN_SYSTEM_PATH_1_0: path.join(this.home, 'lib', 'gstreamer-1.0'),
      GST_REGISTRY_1_0: registry,
      // Scan the four plugins in this process: no gst-plugin-scanner helper to ship.
      GST_REGISTRY_FORK: 'no',
      // UxPlay reads options from ~/.uxplayrc: keep its home in the bundle, where there is none.
      HOME: this.home,
    };
    for (const key of ['GST_PLUGIN_PATH', 'GST_PLUGIN_PATH_1_0', 'GST_PLUGIN_SYSTEM_PATH', 'UXPLAYRC', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    const child = spawn(path.join(this.home, 'bin', 'uxplay.exe'), receiverArgs(this.options.name, socket.address().port), { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    trackChild(child);
    this.child = child;
    for (const stream of [child.stdout!, child.stderr!]) {
      let rest = '';
      stream.on('data', (chunk: Buffer) => {
        rest += chunk.toString('utf8');
        const lines = rest.split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) this.onLine(line);
      });
    }
    child.on('error', (error) => this.log('error', `Screen receiver: ${error.message}`));
    child.on('exit', (code) => this.onExit(child, code));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    this.recent.push(line);
    if (this.recent.length > 200) this.recent.shift();
    const event = parseReceiverLine(line);
    if (!event) return;
    switch (event.t) {
      case 'ready':
        this.restarts = 0;
        if (this.state === 'starting') this.setState('waiting');
        this.stopFirewallChecks();
        void this.checkFirewall(Date.now());
        break;
      case 'client':
        this.client = event.client;
        // An iPhone got through, whatever the firewall's rules said a moment ago.
        if (this.firewallBlocked) this.setFirewall(false);
        this.log('info', `${event.client.name} (${event.client.model}) is mirroring to this PC.`);
        break;
      case 'connections':
        if (event.count === 0) {
          // The iPhone stopped mirroring: what was kept belongs to that session.
          this.client = null;
          this.resetStream();
          if (this.state !== 'stopped' && this.state !== 'starting') this.setState('waiting');
        }
        break;
      case 'streaming':
        break;
      case 'error':
        this.log('error', event.message);
        break;
    }
  }

  private onPacket(packet: Buffer): void {
    for (const unit of this.depacketizer.push(packet)) {
      for (const message of this.messages.push(unit, Date.now() * 1000)) {
        const header = parseStreamHeader(message)!;
        if (header.type !== STREAM_CONFIG) this.keep(message, header.key);
        if (this.state !== 'mirroring') this.setState('mirroring');
        for (const listener of this.listeners) listener.onVideo({ data: message, header });
      }
    }
  }

  /** Keeps every frame since the last keyframe, for screens that open later, up to the catch-up limit. */
  private keep(frame: Buffer, key: boolean): void {
    if (key) {
      this.catchUp = [];
      this.catchUpBytes = 0;
      this.catchUpLost = false;
    }
    if (this.catchUpLost) return;
    this.catchUp.push(frame);
    this.catchUpBytes += frame.length;
    if (this.catchUpBytes > (this.options.catchUpLimit ?? CATCH_UP_BYTES)) {
      this.catchUp = [];
      this.catchUpBytes = 0;
      this.catchUpLost = true;
    }
  }

  private resetStream(): void {
    this.depacketizer.reset();
    this.messages = new H264Messages();
    this.catchUp = [];
    this.catchUpBytes = 0;
    this.catchUpLost = false;
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.stopFirewallChecks();
    this.socket?.close();
    this.socket = null;
    this.client = null;
    this.resetStream();
    if (this.state === 'stopped') return;
    const why = this.recent.filter((line) => /error|not found|failed|stopping/i.test(line)).slice(-3).join(' ');
    this.log('warn', `The screen receiver stopped (exit ${code ?? 'signal'})${why ? `: ${why}` : ''}`);
    // Back on the network after a crash while screens are open, a few times.
    if (this.listeners.size && this.restarts < 3) {
      this.restarts += 1;
      this.setState('starting');
      setTimeout(() => void this.start().catch((error: unknown) => this.log('error', String(error))), 2000).unref();
      return;
    }
    this.setState('stopped');
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.stopFirewallChecks();
    this.setState('stopped');
    const child = this.child;
    this.child = null;
    try {
      child?.kill();
    } catch {
      // already gone
    }
    this.socket?.close();
    this.socket = null;
    this.client = null;
    this.resetStream();
  }

  /**
   * Asks Windows whether its firewall lets iPhones reach the receiver, and tells the screens when that
   * changes. Asks again while it blocks them, and for a while when there is no rule yet: Windows asks
   * about a new receiver when it first listens, with blocking rules until the question is answered.
   */
  private async checkFirewall(since: number): Promise<void> {
    const child = this.child;
    const verdict = await (this.options.firewallVerdict ?? firewallVerdict)(path.join(this.home, 'bin', 'uxplay.exe'));
    if (!child || this.child !== child) return;
    // 'none': no rule yet, nothing to say (Windows lets it through, or asks now).
    this.setFirewall(verdict === 'blocked');
    if (verdict === 'blocked' || (verdict !== 'allowed' && Date.now() - since < FIREWALL_ASKING_MS)) {
      this.firewallTimer = setTimeout(() => void this.checkFirewall(since), FIREWALL_RECHECK_MS);
      this.firewallTimer.unref();
    }
  }

  private setFirewall(blocked: boolean): void {
    if (blocked === this.firewallBlocked) return;
    this.firewallBlocked = blocked;
    if (blocked) this.log('warn', 'Windows Firewall blocks the screen receiver on this network, so iPhones cannot reach it.');
    for (const listener of this.listeners) listener.onFirewall?.(blocked);
  }

  private stopFirewallChecks(): void {
    if (this.firewallTimer) clearTimeout(this.firewallTimer);
    this.firewallTimer = null;
  }

  /** UxPlay's last lines, for an error's details. */
  get lastLines(): string[] {
    return this.recent.slice(-20);
  }

  private setState(state: ReceiverState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener.onState(state, this.client);
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    for (const listener of this.listeners) listener.onLog?.(level, message);
  }
}

function packet(message: Buffer): { data: Buffer; header: StreamHeader } {
  return { data: message, header: parseStreamHeader(message)! };
}

let shared: MirrorReceiver | null = null;

/** The one receiver of this PC (screens share it). */
export function mirrorReceiver(): MirrorReceiver {
  // For tests only: a small catch-up limit shows a screen that opened too late within seconds.
  const testLimit = Number(process.env.CAPMAC_TEST_MIRROR_CATCH_UP_BYTES);
  shared ??= new MirrorReceiver({ name: MIRROR_RECEIVER_NAME, catchUpLimit: testLimit > 0 ? testLimit : undefined });
  return shared;
}
