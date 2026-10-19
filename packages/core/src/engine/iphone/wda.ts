/**
 * Touch for an iPhone at this PC, through WebDriverAgent (Appium's, BSD licence): an XCTest runner
 * that CapMac signs with the developer's team and installs once, then starts from here
 * (wda-runner.py, CapMac's Python). Taps, swipes, keys and buttons go to it as HTTP requests through
 * a port the runner forwards: over the cable, or over Wi-Fi through the no-admin tunnel (an iPhone
 * paired for Wi-Fi, iOS 17 and later). XCTest needs Developer Mode on the iPhone.
 *
 * WebDriverAgent plays a whole gesture once it is known, so a drag reaches the iPhone when the
 * pointer is released (the pane's gestures mode), and XCTest's wait for the app to settle is
 * turned off so a tap goes straight through.
 *
 * WebDriverAgent also streams the screen (MJPEG): over the cable that is the iPhone's picture
 * without mirroring (watchScreen).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CancelledError, UserError } from '../errors.js';
import { trackChild } from '../../agent/proc.js';
import { hostRun } from '../wsl/bootstrap.js';
import { deviceHelperCommand, installWslApp, mountWslDeveloperImage, OVER_WIFI, TRUST_DEVELOPER_STEPS, type WslDevice, type WslDeviceOptions } from '../wsl/device.js';
import { MjpegParser } from './mjpeg.js';
import runnerScript from './wda-runner.py';

export const WDA_VERSION = '16.15.3';
const WDA_URL = `https://github.com/appium/WebDriverAgent/releases/download/v${WDA_VERSION}/WebDriverAgentRunner-Runner.zip`;
const WDA_SHA256 = '2176793538d902f6b1e61291e9997f68d306541f222ea715d256a7c6ce9d4fc5';
const RUNNER_APP = 'WebDriverAgentRunner-Runner.app';
/** WebDriverAgent's HTTP port on the iPhone. */
const WDA_PORT = 8100;
/** WebDriverAgent's screen stream (MJPEG) on the iPhone. */
const WDA_SCREEN_PORT = 9100;

/**
 * The screen stream's settings. Measured on an iPhone 8 over the cable: 28 frames a second at the
 * screen's own size (the most it asks for is 30), about 100 KB each, the first after 50–150 ms; taps
 * were no slower with it on. Scaling it down made the frames bigger, not quicker.
 */
const SCREEN_STREAM = { mjpegServerFramerate: 30, mjpegScalingFactor: 100, mjpegServerScreenshotQuality: 50 };

/** CapMac's folder for WebDriverAgent: the download, and each team's signed copy. */
export function wdaHome(): string {
  const base = process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA) ? process.env.LOCALAPPDATA : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'CapMac', 'wda', WDA_VERSION);
}

/** The runner's bundle id in a team. An App ID is unique across all teams, so it names the team. */
export function wdaBundleId(teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new UserError('That is not an Apple team id.', 'A team id has 10 letters and digits, such as 9XCZL2PPRH.');
  return `dev.capmac.wda.${teamId.toLowerCase()}.xctrunner`;
}

/** The team a provisioning profile belongs to (its TeamIdentifier), read from the signed file's plist text. */
export async function profileTeam(profilePath: string): Promise<string> {
  const text = (await fs.readFile(profilePath)).toString('latin1');
  const team = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([A-Z0-9]{10})<\/string>/.exec(text)?.[1];
  if (!team) throw new UserError('Could not read the team from the provisioning profile.', profilePath);
  return team;
}

/** A development profile that is still valid and lists this iPhone. */
export async function profileCovers(profilePath: string, udid: string, now = new Date()): Promise<boolean> {
  const text = await fs.readFile(profilePath).then((bytes) => bytes.toString('latin1'), () => '');
  if (!text) return false;
  const expires = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(text)?.[1];
  if (!expires || new Date(expires).getTime() - now.getTime() < 24 * 3600_000) return false;
  const devices = /<key>ProvisionedDevices<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '';
  return devices.toLowerCase().includes(`<string>${udid.toLowerCase()}</string>`);
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Downloads WebDriverAgent's iPhone build (pinned and checked) once, and unpacks it. Returns the runner app's folder. */
export async function ensureWdaDownload(signal?: AbortSignal): Promise<string> {
  const home = wdaHome();
  const app = path.join(home, 'download', RUNNER_APP);
  if (existsSync(path.join(app, 'Info.plist'))) return app;
  await fs.mkdir(home, { recursive: true });
  const staging = await fs.mkdtemp(path.join(home, '.download-'));
  try {
    let bytes: Buffer;
    try {
      const response = await fetch(WDA_URL, { signal });
      if (!response.ok) throw new UserError(`Could not download WebDriverAgent (HTTP ${response.status}).`, 'Check the internet connection, then try again.');
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (signal?.aborted) throw new CancelledError();
      throw new UserError('Could not download WebDriverAgent.', 'Check the internet connection, then try again.', [String(error)]);
    }
    if (sha256(bytes) !== WDA_SHA256) throw new UserError('The WebDriverAgent download was damaged.', 'Try again to download it again.');
    const archive = path.join(staging, 'runner.zip');
    await fs.writeFile(archive, bytes);
    // Windows' own tar unpacks zip files.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const unpacked = await hostRun(tar, ['-xf', archive, '-C', staging], { signal }, 120_000);
    if (unpacked.code || !existsSync(path.join(staging, RUNNER_APP, 'Info.plist'))) {
      throw new UserError('Could not unpack WebDriverAgent.', 'Try again.', (unpacked.stderr || unpacked.stdout).trim().split(/\r?\n/).slice(-5));
    }
    // Debug symbols are not needed on the iPhone.
    await fs.rm(path.join(staging, RUNNER_APP, 'PlugIns', 'WebDriverAgentRunner.xctest.dSYM'), { recursive: true, force: true });
    await fs.rm(path.join(home, 'download'), { recursive: true, force: true });
    await fs.mkdir(path.join(home, 'download'), { recursive: true });
    await fs.rename(path.join(staging, RUNNER_APP), app);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return app;
}

/** Gives the runner and its test bundle this team's bundle ids (plistlib reads the binary plist too). */
const RENAME_BUNDLES = String.raw`import plistlib,sys
app,runner=sys.argv[1:3]
for path,value in ((app+'/Info.plist',runner),(app+'/PlugIns/WebDriverAgentRunner.xctest/Info.plist',runner.rsplit('.',1)[0])):
 with open(path,'rb') as f: data=plistlib.load(f)
 data['CFBundleIdentifier']=value
 with open(path,'wb') as f: plistlib.dump(data,f,fmt=plistlib.FMT_XML)
`;

/**
 * A copy of the runner with this team's bundle ids, ready to sign. The signing itself is the WSL
 * backend's (signWslApplication), which the caller runs on the copy.
 */
export async function stageWdaApp(teamId: string, options: WslDeviceOptions = {}): Promise<{ appPath: string; ipaPath: string; bundleId: string }> {
  const bundleId = wdaBundleId(teamId);
  const source = await ensureWdaDownload(options.signal);
  const folder = path.join(wdaHome(), teamId);
  const appPath = path.join(folder, RUNNER_APP);
  await fs.rm(appPath, { recursive: true, force: true });
  await fs.mkdir(folder, { recursive: true });
  await fs.cp(source, appPath, { recursive: true });
  const python = await deviceHelperCommand(options);
  const renamed = await hostRun(python.executable, [...python.prefix, '-c', RENAME_BUNDLES, appPath, bundleId], { signal: options.signal }, 60_000);
  if (renamed.code) throw new UserError('Could not prepare WebDriverAgent.', 'Try again.', renamed.stderr.trim().split(/\r?\n/).slice(-5));
  return { appPath, ipaPath: path.join(folder, 'WebDriverAgent.ipa'), bundleId };
}

/** Which signed runner each iPhone has (the IPA's hash), so it is installed again only when it changed. */
const installedFile = () => path.join(wdaHome(), 'installed.json');

async function installedHashes(): Promise<Record<string, string>> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(installedFile(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** The hash of the runner CapMac installed on this iPhone, if it installed one. */
export async function installedHashesFor(udid: string): Promise<string | undefined> {
  return (await installedHashes())[udid.toLowerCase()];
}

/** Installs the signed runner on the iPhone unless that exact one is there already (`force` installs it anyway). */
export async function installWda(ipaPath: string, device: WslDevice, options: WslDeviceOptions & { force?: boolean } = {}): Promise<boolean> {
  const hash = sha256(await fs.readFile(ipaPath));
  const known = await installedHashes();
  if (!options.force && known[device.udid.toLowerCase()] === hash) return false;
  await installWslApp(ipaPath, device, options);
  known[device.udid.toLowerCase()] = hash;
  await fs.writeFile(installedFile(), JSON.stringify(known, null, 2));
  return true;
}

/** Forgets that the runner is on this iPhone (it was deleted there, say). */
export async function forgetWdaInstall(udid: string): Promise<void> {
  const known = await installedHashes();
  if (!(udid.toLowerCase() in known)) return;
  delete known[udid.toLowerCase()];
  await fs.writeFile(installedFile(), JSON.stringify(known, null, 2));
}

interface WdaReply {
  status: number;
  value: unknown;
  sessionId?: string;
}

/** A WebDriverAgent error's message, from its JSON answer. */
function wdaError(reply: WdaReply): string {
  const value = reply.value as { message?: unknown; error?: unknown } | null;
  return typeof value?.message === 'string' ? value.message : typeof value?.error === 'string' ? value.error : `HTTP ${reply.status}`;
}

/**
 * How near an edge (a part of the screen) a swipe that moves away from it starts on the edge. XCTest's
 * fingers open Control Center only from the last few points: on an iPhone 8, 6 points in did and 10
 * didn't, and going back a page needed the very edge.
 */
const EDGE = 0.03;

/**
 * A swipe as one finger's W3C actions: down where it starts, a few points along the line, up where
 * it ends, as fast as the pointer moved. iOS's edge gestures ignore a finger that jumps from start to
 * end: on an iPhone 8, one move opened Control Center 0 times out of 6 and never went back a page,
 * while two moves did every time (each point costs about 0.17 s there, so a quick swipe gets two and
 * a slow drag up to six). A swipe that starts near the edge it moves away from starts on that edge,
 * as a finger off the bezel does. `x`/`y` are 0..1 from the top left; `size` is the screen in points.
 * `pressMs`: the finger rests before it moves (a long press, then a drag); `holdMs`: it rests at the
 * end before it lifts (swipe up and hold for the app switcher).
 */
export function swipeMoves(
  x1: number, y1: number, x2: number, y2: number, seconds: number, size: { width: number; height: number },
  { pressMs = 0, holdMs = 0 }: { pressMs?: number; holdMs?: number } = {},
): unknown[] {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  [x1, y1, x2, y2] = [clamp(x1), clamp(y1), clamp(x2), clamp(y2)];
  const snap = (start: number, end: number) => (start < EDGE && end > start ? 0 : start > 1 - EDGE && end < start ? 1 : start);
  if (Math.abs(y2 - y1) >= Math.abs(x2 - x1)) y1 = snap(y1, y2);
  else x1 = snap(x1, x2);
  const moving = Math.round(Math.min(1.5, Math.max(0.05, seconds)) * 1000);
  const count = Math.min(6, Math.max(2, Math.round(moving / 150)));
  const at = (x: number, y: number) => ({ x: Math.round(x * size.width), y: Math.round(y * size.height) });
  const rest = (ms: number) => Math.round(Math.min(5000, Math.max(0, ms)));
  const moves: unknown[] = [{ type: 'pointerMove', duration: 0, ...at(x1, y1) }, { type: 'pointerDown', button: 0 }];
  if (rest(pressMs)) moves.push({ type: 'pause', duration: rest(pressMs) });
  for (let i = 1; i <= count; i++) {
    const point = i === count ? at(x2, y2) : at(x1 + ((x2 - x1) * i) / count, y1 + ((y2 - y1) * i) / count);
    moves.push({ type: 'pointerMove', duration: Math.round(moving / count), ...point });
  }
  if (rest(holdMs)) moves.push({ type: 'pause', duration: rest(holdMs) });
  moves.push({ type: 'pointerUp', button: 0 });
  return moves;
}

/** What the runner helper says: the forwarded port, or why it stopped. */
export type WdaRunnerEvent = { t: 'port'; port: number } | { t: 'ended'; reason: string } | { t: 'log'; line: string };

/**
 * WebDriverAgent did not start. `retry`: starting it again later can work (the iPhone was away or
 * locked, or a setting on it is being changed); false: it has to be put on the iPhone again first.
 */
export class WdaStartError extends UserError {
  constructor(message: string, hint: string, details: string[], readonly retry: boolean) {
    super(message, hint, details);
  }
}

/**
 * WebDriverAgent running on one iPhone: the runner helper, a session, and the gestures. Points
 * are the iPhone's (window/size); the pane's 0..1 coordinates are scaled to them.
 */
export class WdaControl {
  private child: ChildProcess | null = null;
  private port = 0;
  /** The local end of WebDriverAgent's screen stream (0: the runner forwards none). */
  private screenPort = 0;
  private session: string | null = null;
  private size: { width: number; height: number } | null = null;
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  private stopped = false;
  private readonly stderr: string[] = [];

  constructor(private readonly device: WslDevice, private readonly bundleId: string, private readonly options: WslDeviceOptions & { onEnded?: (reason: string) => void; usbmuxAddress?: string } = {}) {}

  get ready(): boolean {
    return this.session !== null;
  }

  /** Mounts the developer services, starts the runner, and opens a session with XCTest's waits off. */
  async start(): Promise<void> {
    const { device } = this;
    const wifi = device.connection === 'network';
    // On the cable the iOS version decides how the test daemon is reached; over Wi-Fi it's always the tunnel.
    if (!wifi && !device.productVersion) throw new UserError('The iPhone’s iOS version is not known yet.', 'Unplug the iPhone and plug it in again.');
    // Over Wi-Fi the runner mounts them through its own tunnel: finding the iPhone once is enough.
    if (!wifi) await mountWslDeveloperImage(device, this.options);
    const python = await deviceHelperCommand(this.options, device.udid);
    // During screen capture, reach the iPhone through CapMac's own usbmux (Apple's is down then).
    const env = this.options.usbmuxAddress ? { ...python.env, USBMUXD_SOCKET_ADDRESS: this.options.usbmuxAddress } : python.env;
    const args = [device.udid, device.productVersion ?? '', this.bundleId, String(WDA_PORT), wifi ? 'wifi' : 'usb', String(WDA_SCREEN_PORT)];
    const child = spawn(python.executable, [...python.prefix, '-c', `${OVER_WIFI}${runnerScript}`, ...args], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    trackChild(child);
    this.child = child;
    child.stdin!.on('error', () => undefined);
    child.stderr!.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) this.stderr.push(line.trimEnd());
      if (this.stderr.length > 60) this.stderr.splice(0, this.stderr.length - 60);
    });
    this.port = await new Promise<number>((resolve, reject) => {
      let buffer = '';
      const onAbort = () => reject(new CancelledError());
      this.options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const ports = /^CAPMAC_PORT (\d+)(?: (\d+))?$/.exec(line);
          const ended = /^CAPMAC_ENDED (.*)$/.exec(line)?.[1];
          if (ports) {
            this.screenPort = Number(ports[2] ?? 0);
            resolve(Number(ports[1]));
          } else if (ended !== undefined) this.ended(ended);
          // A Wi-Fi iPhone that is asleep or locked: the runner waits for it.
          else if (line === 'CAPMAC_LOCKED') this.options.onLocked?.();
          else if (line.trim()) this.options.onLog?.(line);
        }
      });
      child.once('exit', (code) => {
        this.options.signal?.removeEventListener('abort', onAbort);
        if (!this.port) {
          const { hint, retry } = this.startHint();
          reject(new WdaStartError('WebDriverAgent did not start on the iPhone.', hint, this.stderr.slice(-12), retry));
        } else this.ended(code ? `the runner stopped (exit ${code})` : 'the runner stopped');
      });
      child.once('error', (error) => reject(new UserError('Could not start the iPhone tools.', String(error))));
    });
    const created = await this.request('POST', '/session', {
      capabilities: { alwaysMatch: { shouldWaitForQuiescence: false, waitForIdleTimeout: 0, shouldUseTestManagerForVisibilityDetection: false } },
    });
    const sessionId = created.sessionId ?? (created.value as { sessionId?: string } | null)?.sessionId;
    if (!sessionId) throw new UserError('WebDriverAgent did not open a session.', wdaError(created));
    this.session = sessionId;
    await this.request('POST', `/session/${sessionId}/appium/settings`, { settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0, ...SCREEN_STREAM } }).catch(() => undefined);
    await this.refreshSize();
  }

  private startHint(): { hint: string; retry: boolean } {
    const text = this.stderr.join('\n');
    const wifi = this.device.connection === 'network';
    if (/AppNotInstalled|No app with bundle id/i.test(text)) return { hint: 'WebDriverAgent is not on the iPhone any more. Turn touch on again to put it back.', retry: false };
    if (/DeveloperMode|developer mode/i.test(text)) return { hint: 'Turn on Developer Mode on the iPhone.', retry: true };
    // With a passcode set, the iPhone asks for it before XCTest may take over its screen (now and then).
    if (/automation mode|UI Automation/i.test(text)) return { hint: 'Your iPhone asks for its passcode before touch can start: enter it on the iPhone. If it doesn’t ask, open Settings, tap Developer, then turn on Enable UI Automation.', retry: true };
    if (/Locked|passcode/i.test(text)) return { hint: 'Unlock the iPhone, then try again.', retry: true };
    // Not just "verify": the Wi-Fi tunnel's own log lines talk about its pair verification.
    if (/untrusted|not trusted|0xe8008018|Unable to Verify|no longer valid|invalid code signature/i.test(text)) return { hint: `${TRUST_DEVELOPER_STEPS} Then try again.`, retry: true };
    return { hint: wifi ? 'Unlock the iPhone and keep it on this Wi-Fi, then try again.' : 'Unlock the iPhone and keep it plugged in, then try again.', retry: true };
  }

  private ended(reason: string): void {
    const wasReady = this.session !== null;
    this.session = null;
    // A runner that ended waits for its stdin to close before it exits.
    this.child?.stdin?.end();
    if (!this.stopped && wasReady) this.options.onEnded?.(reason);
  }

  /** The iPhone's screen in points, as WebDriverAgent measures it now (it turns with the iPhone). */
  async refreshSize(): Promise<{ width: number; height: number }> {
    const reply = await this.request('GET', '/window/size');
    const value = reply.value as { width?: number; height?: number } | null;
    if (!value?.width || !value.height) throw new UserError('WebDriverAgent did not tell the screen size.', wdaError(reply));
    this.size = { width: value.width, height: value.height };
    return this.size;
  }

  private points(x: number, y: number): { x: number; y: number } {
    const size = this.size ?? { width: 390, height: 844 };
    return { x: Math.round(Math.min(1, Math.max(0, x)) * size.width), y: Math.round(Math.min(1, Math.max(0, y)) * size.height) };
  }

  private sessionPath(route: string): string {
    if (!this.session) throw new UserError('Touch is not ready on the iPhone yet.');
    return `/session/${this.session}${route}`;
  }

  /**
   * One finger's raw events (W3C actions). XCTest plays them faster than WebDriverAgent's own tap
   * and drag calls: on an iPhone 8 a tap took 0.6 s instead of 0.9 s.
   */
  private finger(moves: unknown[]): Promise<void> {
    return this.expectOk(this.request('POST', this.sessionPath('/actions'), { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: moves }] }));
  }

  /** A tap at a point of the screen (0..1 from the top left). */
  async tap(x: number, y: number): Promise<void> {
    await this.finger([{ type: 'pointerMove', duration: 0, ...this.points(x, y) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 40 }, { type: 'pointerUp', button: 0 }]);
  }

  /** Touch and hold. */
  async hold(x: number, y: number, seconds: number): Promise<void> {
    const held = Math.round(Math.min(10, Math.max(0.2, seconds)) * 1000);
    await this.finger([{ type: 'pointerMove', duration: 0, ...this.points(x, y) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: held }, { type: 'pointerUp', button: 0 }]);
  }

  /** A swipe or drag, as fast as the pointer moved, with the rests it made (see swipeMoves). */
  async drag(x1: number, y1: number, x2: number, y2: number, seconds: number, rests: { pressMs?: number; holdMs?: number } = {}): Promise<void> {
    await this.finger(swipeMoves(x1, y1, x2, y2, seconds, this.size ?? { width: 390, height: 844 }, rests));
  }

  /** Types text into whatever has the keyboard focus on the iPhone (any characters). */
  async type(text: string): Promise<void> {
    if (!text) return;
    await this.expectOk(this.request('POST', this.sessionPath('/wda/keys'), { value: [...text] }));
  }

  /**
   * The Home button, pressed for real: WebDriverAgent's own "home screen" only brings the home
   * screen forward, which leaves Control Center or Notification Center open over it. And the side
   * button (lock).
   */
  async button(name: 'home' | 'lock' | 'volumeup' | 'volumedown' | 'action'): Promise<void> {
    if (name === 'lock') await this.expectOk(this.request('POST', '/wda/lock'));
    else await this.expectOk(this.request('POST', this.sessionPath('/wda/pressButton'), { name }));
  }

  /** A PNG of the screen, at the iPhone's own size. */
  async screenshot(): Promise<Buffer> {
    const reply = await this.request('GET', '/screenshot');
    if (typeof reply.value !== 'string') throw new UserError('WebDriverAgent did not send the picture.', wdaError(reply));
    return Buffer.from(reply.value, 'base64');
  }

  /** The screen in points, as last measured (null before the session). */
  get screenSize(): { width: number; height: number } | null {
    return this.size;
  }

  /** Whether the runner forwards the screen stream. */
  get canWatchScreen(): boolean {
    return this.screenPort > 0 && this.session !== null;
  }

  /**
   * The screen as WebDriverAgent streams it: each new picture as a JPEG (a picture that didn't
   * change is not sent again), until the returned function stops it or the stream ends (`onEnd`,
   * not called after a stop). About 3 MB a second: for the cable.
   */
  watchScreen(onJpeg: (jpeg: Buffer) => void, onEnd: (reason: string) => void): () => void {
    let done = false;
    const end = (reason: string) => {
      if (done) return;
      done = true;
      onEnd(reason);
    };
    if (!this.canWatchScreen) {
      queueMicrotask(() => end('touch is not on'));
      return () => void (done = true);
    }
    const parser = new MjpegParser();
    let last: Buffer | null = null;
    const req = http.get({ host: '127.0.0.1', port: this.screenPort, path: '/', agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        end(`the screen stream answered HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (chunk: Buffer) => {
        if (done) return;
        for (const jpeg of parser.push(chunk)) {
          // WebDriverAgent sends the same picture again and again while the screen stands still.
          if (last?.equals(jpeg)) continue;
          last = jpeg;
          onJpeg(jpeg);
        }
      });
      res.on('end', () => end('the screen stream ended'));
      res.on('error', (error) => end(error.message));
    });
    req.on('error', (error) => end(error.message));
    return () => {
      done = true;
      req.destroy();
    };
  }

  private async expectOk(pending: Promise<WdaReply>): Promise<void> {
    const reply = await pending;
    if (reply.status >= 300) throw new UserError('The iPhone did not take that.', wdaError(reply));
  }

  private request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<WdaReply> {
    if (!this.port) return Promise.reject(new UserError('Touch is not ready on the iPhone yet.'));
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: this.port, method, path: route, agent: this.agent, timeout: 60_000,
        headers: { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          let parsed: { value?: unknown; sessionId?: string } = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            // WebDriverAgent always answers JSON; anything else is its error page.
          }
          resolve({ status: res.statusCode ?? 0, value: parsed.value ?? null, sessionId: parsed.sessionId });
        });
      });
      req.on('timeout', () => req.destroy(new Error('WebDriverAgent did not answer in time')));
      req.on('error', (error) => reject(new UserError('Lost the connection to the iPhone’s touch helper.', error.message)));
      req.end(data);
    });
  }

  /** Ends the session and stops the runner (closing its stdin stops XCTest on the iPhone). */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (this.session) await this.request('DELETE', `/session/${this.session}`).catch(() => undefined);
    this.session = null;
    this.agent.destroy();
    if (!child || child.exitCode !== null) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, 5000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
    });
  }
}
