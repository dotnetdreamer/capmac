/**
 * A React Native app's Windows app (react-native-windows), on this PC: the
 * project's own `react-native run-windows` builds it with Visual Studio,
 * installs it and opens it in its own window; Metro on this PC serves its
 * JavaScript (Fast Refresh in a debug build). CapMac shows the steps and the
 * console, and stops the app with the run. No Mac and no sync are involved.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { classifyReactNativeChange, needsNativeRebuild, type ReactNativeChange } from '../../shared/react-native.js';
import type { Target } from '../../shared/protocol.js';
import { log, startStep, type EngineContext } from '../context.js';
import { killTree } from '../devserver.js';
import { CancelledError, isCancelled, toErrorInfo, UserError } from '../errors.js';
import { stripAnsi } from '../format.js';
import { nodeExecutable, requireReactNative, type ProjectInfo } from '../project.js';
import { ensureVisualStudio, type VsRequirement } from '../visual-studio.js';
import { watchWrites } from '../watch.js';
import { METRO_DEFAULT_PORT, metroStatus, startMetro, type MetroServer } from './metro.js';

/** The target id of this PC's desktop (the same as a Flutter app's Windows app's). */
const PC_TARGET_ID = 'pc-desktop';

function pcTarget(): Target {
  return { kind: 'pc', udid: PC_TARGET_ID, name: 'This PC', os: 'Windows', osVersion: '', state: 'available', available: true };
}

function resolveFrom(dir: string, request: string): string | null {
  for (let probe = dir; ; probe = path.dirname(probe)) {
    const candidate = path.join(probe, 'node_modules', ...request.split('/'));
    if (existsSync(candidate)) return candidate;
    if (path.dirname(probe) === probe) return null;
  }
}

/**
 * The Visual Studio versions the project's react-native-windows builds with:
 * its CLI asks vswhere for that range (0.83: Visual Studio 2022, 17.11 or
 * later); newer releases move on, so the range is read from the CLI itself.
 */
async function vsVersions(project: ProjectInfo): Promise<string> {
  const file = resolveFrom(project.capDir, '@react-native-windows/cli/lib-commonjs/utils/msbuildtools.js');
  const text = file ? await fs.readFile(file, 'utf8').catch(() => '') : '';
  const min = /process\.env\.VisualStudioVersion \|\|\s*'(\d+)\.(\d+)(?:\.\d+)?'/.exec(text);
  return min ? `[${min[1]}.${min[2]},${Number(min[1]) + 1}.0)` : '[17.11,18.0)';
}

/**
 * What react-native-windows needs from Visual Studio (its rnw-dependencies.ps1
 * lists the same for a developer's PC). The C++ UWP tools build the native
 * modules whose Windows projects are UWP libraries (async-storage's, for one).
 */
async function reactNativeWindowsVs(project: ProjectInfo): Promise<VsRequirement> {
  return {
    components: {
      'Microsoft.Component.MSBuild': 'MSBuild',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64': 'MSVC C++ x64/x86 build tools',
      'Microsoft.VisualStudio.ComponentGroup.UWP.Support': 'Universal Windows Platform tools',
      'Microsoft.VisualStudio.ComponentGroup.UWP.VC': 'C++ (v143) Universal Windows Platform tools',
      'Microsoft.VisualStudio.ComponentGroup.NativeDesktop.Core': 'C++ core desktop features',
      'Microsoft.VisualStudio.Component.Windows11SDK.22621': 'Windows 11 SDK (10.0.22621)',
    },
    workloads: {
      'Microsoft.VisualStudio.Workload.NativeDesktop': 'Desktop development with C++',
      'Microsoft.VisualStudio.Workload.Universal': 'Universal Windows Platform development',
    },
    versions: await vsVersions(project),
    framework: 'React Native for Windows',
    installerHint: '“Desktop development with C++” and “Universal Windows Platform development” (with “C++ (v143) Universal Windows Platform tools”)',
  };
}

function regValue(key: string, name: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', name], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const match = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(stdout);
      resolve(match ? parseInt(match[1]!, 16) : null);
    });
  });
}

/** Windows' Developer Mode: a React Native Windows app installs from its build folder only with it on. */
export async function developerModeOn(): Promise<boolean> {
  return (await regValue('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock', 'AllowDevelopmentWithoutDevLicense')) === 1;
}

/** Visual Studio's parts, and Windows' Developer Mode, for the Windows app. */
export async function ensureReactNativeWindowsToolchain(project: ProjectInfo, ctx: EngineContext, signal?: AbortSignal): Promise<void> {
  if (!(await developerModeOn())) {
    throw new UserError('Installing the Windows app needs Windows’ Developer Mode.', 'Turn it on in Settings › System › For developers (Developer Mode), then try again.');
  }
  await ensureVisualStudio(await reactNativeWindowsVs(project), ctx, signal);
}

/** The app's process name, as Windows lists it: its project's name. */
function processName(project: ProjectInfo): string {
  return `${project.reactNative?.windows?.name ?? project.reactNative?.name ?? 'App'}.exe`;
}

/** Whether a process with that image name runs on this PC. */
function processRunning(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(`"${image.toLowerCase()}"`));
    });
  });
}

function stopProcess(image: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', image, '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve());
  });
}

/** run-windows' steps, in the order they come. */
const WINDOWS_PHASES = ['deps', 'build', 'install', 'launch'] as const;

/** Which timeline step a line of run-windows' output starts. */
export function runWindowsPhase(line: string): { phase: 'deps' | 'build' | 'install' | 'launch'; title: string } | null {
  if (/Autolinking/i.test(line)) return { phase: 'deps', title: 'Linking the native modules (autolink-windows)' };
  if (/Restoring NuGet|NuGet restore|Restore/i.test(line) && !/Build/i.test(line)) return { phase: 'deps', title: 'Getting the Windows app’s packages (NuGet)' };
  if (/Building Solution|Build started|msbuild/i.test(line) && !/succeeded/i.test(line)) return { phase: 'build', title: 'Building the Windows app (Visual Studio)' };
  if (/Deploying|Installing app|Removing old version|Installing dependencies/i.test(line)) return { phase: 'install', title: 'Installing the Windows app on this PC' };
  if (/Starting the app|Launching|Launched/i.test(line)) return { phase: 'launch', title: 'Opening the Windows app' };
  return null;
}

export interface ReactNativePcOptions {
  /** Release builds carry their JavaScript (no Metro). */
  release?: boolean;
  logs?: boolean;
  onReady?: () => void;
  /** Live mode: rebuild when the Windows app's native folder or the packages change (default true). */
  watch?: boolean;
}

/** One `react-native run-windows`: build, install and open; resolves once the app is open. */
async function runWindows(project: ProjectInfo, release: boolean, ctx: EngineContext, signal?: AbortSignal, build = true): Promise<void> {
  const cli = resolveFrom(project.capDir, 'react-native/cli.js');
  if (!cli) throw new UserError('React Native is not installed in this project on this PC.', `Run \`${project.packageManager} install\`, then try again.`);
  const arch = project.reactNative?.options.windowsArch ?? (process.arch === 'arm64' ? 'ARM64' : 'x64');
  const args = [cli, 'run-windows', '--no-packager', '--logging', '--no-telemetry', '--arch', arch, ...(release ? ['--release'] : []), ...(build ? [] : ['--no-build'])];
  log(ctx, 'debug', `react-native ${args.slice(1).join(' ')}`);
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child: ChildProcess = spawn(nodeExecutable(), args, { cwd: project.capDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail: string[] = [];
  const errors: string[] = [];
  let step = startStep(ctx, 'Getting the Windows app ready', 'deps');
  let current: (typeof WINDOWS_PHASES)[number] = 'deps';
  const onLine = (raw: string) => {
    const line = stripAnsi(raw).trimEnd();
    if (!line.trim()) return;
    tail.push(line);
    if (tail.length > 80) tail.shift();
    ctx.emit({ type: 'tool-output', stream: 'stdout', text: line });
    // MSBuild's errors: "file(12,5): error C2065: ..." or "error MSB...".
    const diag = /^\s*(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning)\s+([A-Z]+\d+)\s*:\s*(.+?)(?:\s+\[[^\]]+\])?$/.exec(line);
    if (diag) {
      ctx.emit({ type: 'diagnostic', diagnostic: { severity: diag[4] === 'error' ? 'error' : 'warning', message: `${diag[5]}: ${diag[6]}`, file: diag[1], line: Number(diag[2]), column: diag[3] ? Number(diag[3]) : undefined, own: !/[\\/](node_modules|packages)[\\/]/i.test(diag[1]!) } });
      if (diag[4] === 'error') errors.push(line.trim());
    } else if (/\berror\b|\bfailed\b|✖/i.test(line)) {
      errors.push(line.trim());
      if (errors.length > 40) errors.shift();
    }
    // Steps only move forward: MSBuild's lines name restore and build again and again while it builds.
    const next = runWindowsPhase(line);
    if (next && WINDOWS_PHASES.indexOf(next.phase) > WINDOWS_PHASES.indexOf(current)) {
      step.succeed();
      step = startStep(ctx, next.title, next.phase);
      current = next.phase;
    } else {
      step.update(line.trim().slice(0, 160));
    }
  };
  const partial = { stdout: '', stderr: '' };
  const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const lines = (partial[stream] + chunk.toString('utf8')).split(/\r?\n/);
    partial[stream] = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  };
  child.stdout!.on('data', onData('stdout'));
  child.stderr!.on('data', onData('stderr'));
  const onAbort = () => void killTree(child);
  signal?.addEventListener('abort', onAbort, { once: true });
  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null));
    child.on('close', (exit) => resolve(exit));
  }).finally(() => signal?.removeEventListener('abort', onAbort));
  if (signal?.aborted) {
    step.cancel();
    throw new CancelledError();
  }
  if (code !== 0) {
    step.fail();
    const text = tail.join('\n');
    const hint = /Developer Mode|developer license/i.test(text)
      ? 'Turn on Developer Mode in Settings › System › For developers, then try again.'
      : /NoMSBuild|Could not find MSBuild|MSBuild tools not found|DesktopBridge|missing required software dependencies/i.test(text)
        ? 'Visual Studio is missing parts the Windows app needs: run again and let CapMac add them, or run `npx react-native run-windows --info`.'
        : /WindowsAppSDKVerifyTransitiveDependencies/.test(text)
          ? 'A native module’s Windows project predates Windows App SDK 1.8: update the module, or add <WindowsAppSDKVerifyTransitiveDependencies>false</WindowsAppSDKVerifyTransitiveDependencies> to windows/ExperimentalFeatures.props.'
          : 'Fix the errors above, then run again.';
    throw new UserError(`The Windows app did not build or open (run-windows exited with ${code ?? 'an error'}).`, hint, (errors.length ? errors : tail).slice(-25));
  }
  step.succeed();
}

/**
 * Metro for the Windows app: it looks on port 8081 (react-native-windows
 * sets no other in its template), so Metro has to be there.
 */
async function metroForWindows(project: ProjectInfo, ctx: EngineContext, signal?: AbortSignal): Promise<MetroServer> {
  const status = await metroStatus(METRO_DEFAULT_PORT, project.capDir);
  if (status === 'taken') throw new UserError(`Another server uses port ${METRO_DEFAULT_PORT} on this PC, where the Windows app looks for Metro.`, 'Stop it (another app’s Metro?), then run again.');
  return startMetro(project, { port: METRO_DEFAULT_PORT, signal }, ctx);
}

/** Waits while the app's process runs; resolves when it quits, or when `signal` stops the wait. */
async function whileRunning(image: string, signal: AbortSignal): Promise<void> {
  // Windows may take a moment to list a packaged app's process.
  for (let i = 0; i < 20 && !(await processRunning(image)); i++) {
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  while (!signal.aborted && (await processRunning(image))) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

/** `capmac run --app windows`: until the app quits, or `signal` stops it (which closes it too). */
export async function runReactNativeOnPc(project: ProjectInfo, options: ReactNativePcOptions, ctx: EngineContext, signal: AbortSignal): Promise<{ reason: 'exited' | 'cancelled'; exitCode: number | null }> {
  requireReactNative(project, 'windows');
  if (process.platform !== 'win32') throw new UserError('A React Native app’s Windows app runs on Windows.');
  await ensureReactNativeWindowsToolchain(project, ctx, signal);
  ctx.emit({ type: 'target', target: pcTarget() });
  if (options.release) ctx.emit({ type: 'phase-skipped', phase: 'devserver', reason: 'a release build carries its JavaScript' });
  const metro = options.release ? null : await metroForWindows(project, ctx, signal);
  const image = processName(project);
  try {
    await runWindows(project, Boolean(options.release), ctx, signal);
    ctx.emit({ type: 'app', state: 'running', name: project.appName, target: 'This PC' });
    options.onReady?.();
    if (options.logs === false) return { reason: 'exited', exitCode: null };
    await whileRunning(image, signal);
    if (signal.aborted) {
      await stopProcess(image);
      ctx.emit({ type: 'app', state: 'stopped', name: project.appName, target: 'This PC' });
      return { reason: 'cancelled', exitCode: null };
    }
    ctx.emit({ type: 'app', state: 'exited', name: project.appName, target: 'This PC', exitCode: null });
    return { reason: 'exited', exitCode: null };
  } finally {
    await metro?.stop();
  }
}

/** Live mode for the Windows app: Metro brings every save over (Fast Refresh); the packages or windows/ rebuild it. */
export class ReactNativePcLiveSession {
  readonly target = pcTarget();
  metro: MetroServer | null = null;
  private watcher: FSWatcher | null = null;
  private readonly stopAll = new AbortController();
  private busy = false;
  private queued = false;
  private watching: Promise<void> | null = null;

  constructor(readonly project: ProjectInfo, readonly options: ReactNativePcOptions, readonly ctx: EngineContext) {}

  get stopped(): boolean {
    return this.stopAll.signal.aborted;
  }

  async start(): Promise<void> {
    const { ctx, project } = this;
    try {
      requireReactNative(project, 'windows');
      if (process.platform !== 'win32') throw new UserError('A React Native app’s Windows app runs on Windows.');
      ctx.emit({ type: 'session', mode: 'live', state: 'starting' });
      await ensureReactNativeWindowsToolchain(project, ctx, this.stopAll.signal);
      ctx.emit({ type: 'target', target: this.target });
      this.metro = await metroForWindows(project, ctx, this.stopAll.signal);
      await this.launch();
      if (this.options.watch !== false && !this.stopped) {
        this.watcher = watchWrites(project.capDir, (rel) => classifyReactNativeChange(rel, '') !== 'ignore', (files) => void this.onSaved(files), 200);
      }
    } catch (err) {
      await this.stop();
      if (!isCancelled(err)) ctx.emit({ type: 'session', mode: 'live', state: 'failed', error: toErrorInfo(err) });
      throw err;
    }
  }

  private async launch(build = true): Promise<void> {
    const image = processName(this.project);
    await stopProcess(image);
    await runWindows(this.project, false, this.ctx, this.stopAll.signal, build);
    this.ctx.emit({ type: 'app', state: 'running', name: this.project.appName, target: 'This PC' });
    this.ctx.emit({ type: 'session', mode: 'live', state: 'running' });
    this.options.onReady?.();
    const watching = whileRunning(image, this.stopAll.signal).then(() => {
      if (this.stopped || this.watching !== watching || this.busy) return;
      this.ctx.emit({ type: 'app', state: 'exited', name: this.project.appName, target: 'This PC', exitCode: null });
      this.ctx.emit({ type: 'session', mode: 'live', state: 'idle' });
    });
    this.watching = watching;
  }

  private async onSaved(files: string[]): Promise<void> {
    const changes = new Set<ReactNativeChange>(files.map((rel) => classifyReactNativeChange(rel, '')));
    if ([...changes].some((change) => needsNativeRebuild(change, 'windows'))) {
      log(this.ctx, 'info', 'The packages or windows/ changed: rebuilding the Windows app');
      this.rebuild();
      return;
    }
    if (changes.has('js')) this.ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail: 'Sent to the app (Fast Refresh)' });
  }

  async reload(): Promise<void> {
    const ok = await this.metro?.reload();
    if (ok) this.ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail: 'Reloaded the JavaScript' });
  }

  async openDevTools(): Promise<boolean> {
    return (await this.metro?.openDevTools()) ?? false;
  }

  /** Builds the Windows app again and opens it. */
  rebuild(build = true): void {
    void (async () => {
      if (this.stopped) return;
      if (this.busy) {
        this.queued = true;
        return;
      }
      this.busy = true;
      try {
        do {
          this.queued = false;
          this.ctx.emit({ type: 'session', mode: 'live', state: 'building' });
          await this.launch(build);
        } while (this.queued && !this.stopped);
      } catch (err) {
        if (!this.stopped) this.ctx.emit({ type: 'error', error: toErrorInfo(err) });
      } finally {
        this.busy = false;
      }
    })();
  }

  /** Opens the app again without building (run-windows skips the build). */
  relaunch(): void {
    this.rebuild(false);
  }

  async stop(): Promise<void> {
    if (this.stopAll.signal.aborted) return;
    this.stopAll.abort();
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopping' });
    this.watcher?.close();
    await stopProcess(processName(this.project));
    await this.metro?.stop();
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopped' });
  }
}
