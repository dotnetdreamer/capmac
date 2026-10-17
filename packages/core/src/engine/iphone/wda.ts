/**
 * Touch for an iPhone plugged into this PC, through WebDriverAgent (Appium's, BSD licence): an
 * XCTest runner that CapMac signs with the developer's team and installs once, then starts from
 * here (wda-runner.py, CapMac's Python). Taps, swipes, keys and buttons go to it as HTTP requests
 * through a port the runner forwards over the cable. XCTest needs Developer Mode on the iPhone.
 *
 * WebDriverAgent plays a whole gesture once it is known, so a drag reaches the iPhone when the
 * pointer is released (the pane's gestures mode), and XCTest's wait for the app to settle is
 * turned off so a tap goes straight through.
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
import { deviceHelperCommand, installWslApp, mountWslDeveloperImage, type WslDevice, type WslDeviceOptions } from '../wsl/device.js';
import runnerScript from './wda-runner.py';

export const WDA_VERSION = '16.15.3';
const WDA_URL = `https://github.com/appium/WebDriverAgent/releases/download/v${WDA_VERSION}/WebDriverAgentRunner-Runner.zip`;
const WDA_SHA256 = '2176793538d902f6b1e61291e9997f68d306541f222ea715d256a7c6ce9d4fc5';
const RUNNER_APP = 'WebDriverAgentRunner-Runner.app';
/** WebDriverAgent's HTTP port on the iPhone. */
const WDA_PORT = 8100;

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

/** What the runner helper says: the forwarded port, or why it stopped. */
export type WdaRunnerEvent = { t: 'port'; port: number } | { t: 'ended'; reason: string } | { t: 'log'; line: string };

/**
 * WebDriverAgent running on one iPhone: the runner helper, a session, and the gestures. Points
 * are the iPhone's (window/size); the pane's 0..1 coordinates are scaled to them.
 */
export class WdaControl {
  private child: ChildProcess | null = null;
  private port = 0;
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
    if (!device.productVersion) throw new UserError('The iPhone’s iOS version is not known yet.', 'Unplug the iPhone and plug it in again.');
    await mountWslDeveloperImage(device, this.options);
    const python = await deviceHelperCommand(this.options, device.udid);
    // During screen capture, reach the iPhone through CapMac's own usbmux (Apple's is down then).
    const env = this.options.usbmuxAddress ? { ...python.env, USBMUXD_SOCKET_ADDRESS: this.options.usbmuxAddress } : python.env;
    const child = spawn(python.executable, [...python.prefix, '-c', runnerScript, device.udid, device.productVersion, this.bundleId, String(WDA_PORT)], {
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
          const port = /^CAPMAC_PORT (\d+)$/.exec(line)?.[1];
          const ended = /^CAPMAC_ENDED (.*)$/.exec(line)?.[1];
          if (port) resolve(Number(port));
          else if (ended !== undefined) this.ended(ended);
          else if (line.trim()) this.options.onLog?.(line);
        }
      });
      child.once('exit', (code) => {
        this.options.signal?.removeEventListener('abort', onAbort);
        if (!this.port) reject(new UserError('WebDriverAgent did not start on the iPhone.', this.startHint(), this.stderr.slice(-12)));
        else this.ended(code ? `the runner stopped (exit ${code})` : 'the runner stopped');
      });
      child.once('error', (error) => reject(new UserError('Could not start the iPhone tools.', String(error))));
    });
    const created = await this.request('POST', '/session', {
      capabilities: { alwaysMatch: { shouldWaitForQuiescence: false, waitForIdleTimeout: 0, shouldUseTestManagerForVisibilityDetection: false } },
    });
    const sessionId = created.sessionId ?? (created.value as { sessionId?: string } | null)?.sessionId;
    if (!sessionId) throw new UserError('WebDriverAgent did not open a session.', wdaError(created));
    this.session = sessionId;
    await this.request('POST', `/session/${sessionId}/appium/settings`, { settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 } }).catch(() => undefined);
    await this.refreshSize();
  }

  private startHint(): string {
    const text = this.stderr.join('\n');
    if (/AppNotInstalled|No app with bundle id/i.test(text)) return 'WebDriverAgent is not on the iPhone any more. Turn touch on again to put it back.';
    if (/DeveloperMode|developer mode/i.test(text)) return 'Turn on Developer Mode on the iPhone.';
    if (/Locked|passcode/i.test(text)) return 'Unlock the iPhone, then try again.';
    if (/untrusted|not trusted|0xe8008018|Verify|valid/i.test(text)) return 'On the iPhone, open Settings › General › VPN & Device Management and trust your developer app, then try again.';
    return 'Unlock the iPhone and keep it plugged in, then try again.';
  }

  private ended(reason: string): void {
    const wasReady = this.session !== null;
    this.session = null;
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

  /** A tap at a point of the screen (0..1 from the top left). */
  async tap(x: number, y: number): Promise<void> {
    await this.expectOk(this.request('POST', this.sessionPath('/wda/tap'), this.points(x, y)));
  }

  /** Touch and hold. */
  async hold(x: number, y: number, seconds: number): Promise<void> {
    await this.expectOk(this.request('POST', this.sessionPath('/wda/touchAndHold'), { ...this.points(x, y), duration: Math.min(10, Math.max(0.2, seconds)) }));
  }

  /** A swipe or drag, as fast as the pointer moved. */
  async drag(x1: number, y1: number, x2: number, y2: number, seconds: number): Promise<void> {
    const from = this.points(x1, y1);
    const to = this.points(x2, y2);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const velocity = Math.min(8000, Math.max(200, distance / Math.max(0.05, seconds)));
    await this.expectOk(this.request('POST', this.sessionPath('/wda/pressAndDragWithVelocity'), {
      fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, pressDuration: 0.05, holdDuration: 0, velocity,
    }));
  }

  /** Types text into whatever has the keyboard focus on the iPhone (any characters). */
  async type(text: string): Promise<void> {
    if (!text) return;
    await this.expectOk(this.request('POST', this.sessionPath('/wda/keys'), { value: [...text] }));
  }

  /** The Home button, and the side button (lock). */
  async button(name: 'home' | 'lock' | 'volumeup' | 'volumedown' | 'action'): Promise<void> {
    if (name === 'home') await this.expectOk(this.request('POST', '/wda/homescreen'));
    else if (name === 'lock') await this.expectOk(this.request('POST', '/wda/lock'));
    else await this.expectOk(this.request('POST', this.sessionPath('/wda/pressButton'), { name }));
  }

  /** A PNG of the screen, at the iPhone's own size. */
  async screenshot(): Promise<Buffer> {
    const reply = await this.request('GET', '/screenshot');
    if (typeof reply.value !== 'string') throw new UserError('WebDriverAgent did not send the picture.', wdaError(reply));
    return Buffer.from(reply.value, 'base64');
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
