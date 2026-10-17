/**
 * Flutter on this PC: the developer's own (on PATH, or in the usual places),
 * else the one CapMac installs in %LOCALAPPDATA%\CapMac\flutter. A Flutter
 * app's Windows app runs with it, and the Mac gets the same version when the
 * project pins none.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, promises as fs, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FlutterSdkInfo } from '../../shared/flutter.js';

const isWindows = process.platform === 'win32';
const FLUTTER = isWindows ? 'flutter.bat' : 'flutter';

/** One argument for cmd.exe: quoted (the way programs read their command line) when it has spaces or cmd's special characters. */
function cmdArg(arg: string): string {
  if (arg && !/[\s"^&|<>()%!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Starts a tool; flutter.bat (a batch file) goes through cmd.exe with every
 * argument quoted, so paths with spaces and --dart-define values arrive whole.
 */
export function spawnTool(bin: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (isWindows && /\.(bat|cmd)$/i.test(bin)) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[bin, ...args].map(cmdArg).join(' ')}"`], { windowsHide: true, ...options, shell: false, windowsVerbatimArguments: true });
  }
  return spawn(bin, args, { windowsHide: true, ...options, shell: false });
}

/** Where CapMac keeps the Flutter it installs on this PC. */
export function managedFlutterDir(): string {
  const base = isWindows ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.local', 'share');
  return path.join(base, isWindows ? 'CapMac' : 'capmac', 'flutter');
}

function onPath(name: string): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.map((dir) => path.join(dir, name)).filter((file) => existsSync(file));
}

/** Flutter's record of its version (bin/cache/flutter.version.json, Flutter 3.22+). */
async function versionFile(root: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, 'bin', 'cache', 'flutter.version.json'), 'utf8'));
  } catch {
    return null;
  }
}

function askVersion(bin: string): Promise<any | null> {
  return new Promise((resolve) => {
    const env = { ...process.env, FLUTTER_SUPPRESS_ANALYTICS: 'true' };
    let stdout = '';
    let child: ChildProcess;
    try {
      child = spawnTool(bin, ['--version', '--machine'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), 180_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(stdout.slice(stdout.indexOf('{'))));
      } catch {
        resolve(null);
      }
    });
  });
}

async function describe(bin: string, managed: boolean): Promise<FlutterSdkInfo | null> {
  const root = path.dirname(path.dirname(bin));
  const info = (await versionFile(root)) ?? (await askVersion(bin));
  const version = info?.frameworkVersion ?? info?.flutterVersion;
  if (typeof version !== 'string') return null;
  return {
    bin,
    root,
    version,
    channel: typeof info.channel === 'string' ? info.channel : null,
    dartVersion: typeof info.dartSdkVersion === 'string' ? info.dartSdkVersion : null,
    engineRevision: typeof info.engineRevision === 'string' ? info.engineRevision : null,
    managed,
  };
}

/** The Flutter installs on this PC, the developer's own first. */
function candidates(): Array<{ bin: string; managed: boolean }> {
  const home = os.homedir();
  const found: Array<{ bin: string; managed: boolean }> = [];
  const add = (bin: string, managed = false) => {
    if (existsSync(bin) && !found.some((f) => f.bin.toLowerCase() === bin.toLowerCase())) found.push({ bin, managed });
  };
  for (const bin of onPath(FLUTTER)) add(bin);
  for (const dir of [path.join(home, 'flutter'), path.join(home, 'development', 'flutter'), path.join(home, 'src', 'flutter'), 'C:\\src\\flutter', 'C:\\flutter', 'C:\\tools\\flutter', path.join(home, 'fvm', 'default')]) {
    add(path.join(dir, 'bin', FLUTTER));
  }
  try {
    const versions = readdirSync(managedFlutterDir()).filter((name) => !name.endsWith('.part')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of versions) add(path.join(managedFlutterDir(), name, 'flutter', 'bin', FLUTTER), true);
  } catch {
    // none installed
  }
  return found;
}

let cached: { at: number; sdk: FlutterSdkInfo | null; wanted?: string } | null = null;

/** The Flutter to use on this PC: the exact version when one is wanted, else the first that works. */
export async function localFlutter(wanted?: string): Promise<FlutterSdkInfo | null> {
  if (cached && cached.wanted === wanted && Date.now() - cached.at < 60_000) return cached.sdk;
  let fallback: FlutterSdkInfo | null = null;
  let match: FlutterSdkInfo | null = null;
  for (const candidate of candidates()) {
    const sdk = await describe(candidate.bin, candidate.managed);
    if (!sdk) continue;
    if (!wanted || wanted === 'stable' || sdk.version === wanted) {
      match = sdk;
      break;
    }
    fallback ??= sdk;
  }
  const sdk = match ?? (wanted && wanted !== 'stable' ? null : fallback);
  cached = { at: Date.now(), sdk, wanted };
  return sdk;
}

/** Forgets what localFlutter found (after an install). */
export function forgetLocalFlutter(): void {
  cached = null;
}
