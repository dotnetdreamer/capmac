/**
 * A Flutter app's Windows app, on this PC: `flutter run -d windows` with this
 * PC's Flutter (the developer's own, else one CapMac installs). The app opens
 * in its own window here; CapMac shows its steps and console, and in live mode
 * hot-reloads it on every save. No Mac and no sync are involved.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { buildArgs, daemonRequestLine, parseDaemonLine, type FlutterBuildOptions, type FlutterRunResult, type FlutterSdkInfo } from '../../shared/flutter.js';
import type { Target } from '../../shared/protocol.js';
import { log, withStep, type EngineContext } from '../context.js';
import { CancelledError, isCancelled, toErrorInfo, UserError } from '../errors.js';
import { requireFlutter, type ProjectInfo } from '../project.js';
import { watchWrites } from '../watch.js';
import { classifyFlutterChange, matters, needsRebuild } from './changes.js';
import { forgetLocalFlutter, localFlutter, managedFlutterDir, spawnTool } from './local.js';
import { flutterBuildOptions, untilStarted } from './mac.js';
import { FlutterRunner, type DaemonTransport } from './runner.js';
import { ensureWindowsToolchain } from './vs.js';

/** The target id of this PC's desktop, where a Flutter app's Windows app runs. */
export const PC_TARGET_ID = 'pc-desktop';

/** This PC as a run target. */
export function pcTarget(): Target {
  return { kind: 'pc', udid: PC_TARGET_ID, name: 'This PC', os: 'Windows', osVersion: '', state: 'available', available: true };
}

const FLUTTER_GIT = 'https://github.com/flutter/flutter.git';
const RELEASES_URL = 'https://storage.googleapis.com/flutter_infra_release/releases/releases_windows.json';

function flutterEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FLUTTER_SUPPRESS_ANALYTICS: 'true', PUB_ENVIRONMENT: 'capmac' };
  // VS Code's terminals make Electron behave as Node; nothing Flutter starts should inherit that.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Runs a command and streams its lines (flutter.bat and git go through cmd on Windows). */
function runLocal(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; onLine?: (line: string) => void }): Promise<{ code: number | null; tail: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawnTool(command, args, { cwd: options.cwd, env: flutterEnv() });
    const tail: string[] = [];
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 60) tail.shift();
        options.onLine?.(line);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const onAbort = () => killTree(child);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) reject(new CancelledError());
      else resolve({ code, tail });
    });
  });
}

/** Ends a process and everything it started (flutter.bat → dart → the app). */
function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
  else child.kill('SIGTERM');
}

/** The newest stable Flutter release. */
export async function latestStable(): Promise<string> {
  const response = await fetch(RELEASES_URL);
  if (!response.ok) throw new UserError(`Could not read Flutter's release list (HTTP ${response.status}).`);
  const releases = (await response.json()) as { current_release?: { stable?: string }; releases?: Array<{ hash: string; version: string }> };
  const release = releases.releases?.find((r) => r.hash === releases.current_release?.stable);
  if (!release) throw new UserError('Flutter’s release list names no stable version.');
  return release.version;
}

/**
 * Installs Flutter on this PC in %LOCALAPPDATA%\CapMac\flutter\<version>: a
 * shallow clone of the release (git comes with Git for Windows), then the
 * tool and the Windows engine.
 */
export async function installFlutterOnPc(version: string | undefined, ctx: EngineContext, signal?: AbortSignal): Promise<FlutterSdkInfo> {
  const wanted = !version || version === 'stable' ? await latestStable() : version.replace(/^v/, '');
  const root = path.join(managedFlutterDir(), wanted);
  const sdkDir = path.join(root, 'flutter');
  const bin = path.join(sdkDir, 'bin', process.platform === 'win32' ? 'flutter.bat' : 'flutter');
  if (!existsSync(bin)) {
    await withStep(ctx, `Downloading Flutter ${wanted}`, 'deps', async (step) => {
      await fs.rm(`${root}.part`, { recursive: true, force: true });
      await fs.mkdir(`${root}.part`, { recursive: true });
      const result = await runLocal('git', ['clone', '--depth', '1', '--branch', wanted, '--progress', FLUTTER_GIT, path.join(`${root}.part`, 'flutter')], { signal, onLine: (line) => step.update(line.trim().slice(0, 120)) }).catch((err) => {
        if (isCancelled(err)) throw err;
        throw new UserError('Installing Flutter needs git on this PC.', 'Install Git for Windows (https://git-scm.com), or install Flutter yourself (https://docs.flutter.dev/get-started).');
      });
      if (result.code !== 0) throw new UserError(`Downloading Flutter ${wanted} failed.`, 'Check this PC’s internet connection, then try again.', result.tail.slice(-8));
      await fs.rm(root, { recursive: true, force: true });
      await fs.rename(`${root}.part`, root);
    });
  }
  await withStep(ctx, 'Preparing the Flutter tool and its Windows engine', 'deps', async (step) => {
    for (const args of [['config', '--no-analytics', '--no-cli-animations'], ['precache', '--windows', '--no-android', '--no-ios', '--no-web', '--no-macos', '--no-linux', '--no-fuchsia']]) {
      const result = await runLocal(bin, args, { signal, onLine: (line) => step.update(line.trim().slice(0, 120)) });
      if (result.code !== 0) throw new UserError('The Flutter tool did not start on this PC.', undefined, result.tail.slice(-10));
    }
  });
  forgetLocalFlutter();
  const sdk = await localFlutter(wanted);
  if (!sdk) throw new UserError(`Flutter ${wanted} was installed but does not report its version.`);
  return sdk;
}

/** This PC's Flutter for the project (the pinned version, if it pins one); offers to install one when there is none. */
export async function flutterOnPc(project: ProjectInfo, ctx: EngineContext, signal?: AbortSignal): Promise<FlutterSdkInfo> {
  const pinned = project.flutter?.wantsFlutter.exact ?? undefined;
  const sdk = await localFlutter(pinned);
  if (sdk) {
    // Nothing to get: Flutter gets the app's packages as it builds.
    ctx.emit({ type: 'phase-skipped', phase: 'deps', reason: `Flutter ${sdk.version} is ready on this PC` });
    return sdk;
  }
  if (!ctx.prompter.interactive) throw new UserError(pinned ? `Flutter ${pinned} (the version this project pins) is not on this PC.` : 'Flutter is not on this PC.', 'Install it from CapMac Studio, or run `capmac flutter install --pc`.');
  const what = pinned ? `Flutter ${pinned}` : 'the latest stable Flutter';
  const yes = await ctx.prompter.confirm({
    message: `Install ${what} on this PC?`,
    detail: `The Windows app is built on this PC with Flutter. CapMac downloads it into ${managedFlutterDir()}. A Flutter you install yourself is used instead.`,
    confirmLabel: 'Install Flutter',
    defaultYes: true,
  });
  if (!yes) throw new UserError('Flutter is needed on this PC to run the Windows app.', 'Install Flutter (https://docs.flutter.dev/get-started), or let CapMac install it.');
  return installFlutterOnPc(pinned, ctx, signal);
}

/** Starts `flutter run -d windows` here; the runner follows it from there. */
export function startFlutterOnPc(project: ProjectInfo, sdk: FlutterSdkInfo, options: FlutterBuildOptions, ctx: EngineContext, live: boolean): FlutterRunner {
  const args = ['run', '--machine', '-d', 'windows', ...buildArgs(options)];
  log(ctx, 'debug', `flutter ${args.join(' ')}`);
  const child = spawnTool(sdk.bin, args, { cwd: project.capDir, env: flutterEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let runner: FlutterRunner | null = null;
  let appId: string | null = null;
  let stopped = false;
  const partial = { stdout: '', stderr: '' };
  // What Flutter said, for when it stops before the app starts.
  const tail: string[] = [];
  let firstError: string | undefined;
  const note = (line: string, error: boolean) => {
    tail.push(line);
    if (tail.length > 40) tail.shift();
    if (error || /^(Error|Exception|FAILURE)\b/.test(line)) firstError ??= line.trim();
  };
  const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const lines = (partial[stream] + chunk.toString('utf8')).split('\n');
    partial[stream] = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      const messages = stream === 'stdout' ? parseDaemonLine(line) : null;
      if (!messages) {
        if (line.trim()) {
          note(line, false);
          runner?.output(line, stream);
        }
        continue;
      }
      for (const msg of messages) {
        if ('event' in msg && msg.event === 'app.start' && typeof msg.params?.appId === 'string') appId = msg.params.appId;
        if ('event' in msg && msg.event === 'daemon.logMessage' && typeof msg.params?.message === 'string') note(msg.params.message, msg.params.level === 'error');
        runner?.handle(msg);
      }
    }
  };
  child.stdout!.on('data', onData('stdout'));
  child.stderr!.on('data', onData('stderr'));
  child.stdin!.on('error', () => undefined);
  const done = new Promise<FlutterRunResult>((resolve, reject) => {
    child.on('error', (err) => reject(new UserError(`Flutter did not start on this PC: ${err.message}`)));
    child.on('close', (code) => resolve({ reason: stopped ? 'cancelled' : 'exited', exitCode: code, ...(code ? { error: firstError, tail } : {}) }));
  });
  const transport: DaemonTransport = {
    send: (id, method, params) => {
      child.stdin!.write(daemonRequestLine(id, method, params));
    },
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      // Flutter closes the app when asked; the tree goes if it has not after a few seconds.
      if (appId) child.stdin!.write(daemonRequestLine(9_999_999, 'app.stop', { appId }));
      const timer = setTimeout(() => killTree(child), appId ? 6000 : 0);
      timer.unref();
      void done.finally(() => clearTimeout(timer));
    },
  };
  runner = new FlutterRunner(transport, ctx, { appName: project.appName, where: 'this PC', live, desktop: true });
  return runner;
}

export interface FlutterPcOptions {
  mode?: FlutterBuildOptions['mode'];
  flavor?: string;
  main?: string;
  dartDefines?: Record<string, string>;
  logs?: boolean;
  onReady?: () => void;
  /** Live mode: hot reload on every save (default true). */
  watch?: boolean;
}

/** `capmac run --app windows`: until the app quits, or `signal` stops it (which closes it too). */
export async function runFlutterOnPc(project: ProjectInfo, options: FlutterPcOptions, ctx: EngineContext, signal: AbortSignal): Promise<FlutterRunResult> {
  requireFlutter(project, 'windows');
  if (process.platform !== 'win32') throw new UserError('A Flutter app’s Windows app runs on Windows.');
  const sdk = await flutterOnPc(project, ctx, signal);
  await ensureWindowsToolchain(ctx, signal);
  ctx.emit({ type: 'target', target: pcTarget() });
  const runner = startFlutterOnPc(project, sdk, flutterBuildOptions(project, options), ctx, false);
  const stop = () => runner.stop();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await untilStarted(runner);
    options.onReady?.();
    if (options.logs === false) return { reason: 'exited', exitCode: null };
    return await runner.transport.done;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** Live mode for the Windows app: every save hot-reloads it; dependencies or windows/ rebuild it. */
export class FlutterPcLiveSession {
  readonly target = pcTarget();
  private runner: FlutterRunner | null = null;
  private sdk: FlutterSdkInfo | null = null;
  private watcher: FSWatcher | null = null;
  private stopped = false;
  private busy = false;
  private queued: { files: string[]; rebuild: boolean; restart: boolean; reload: boolean } | null = null;

  constructor(readonly project: ProjectInfo, readonly options: FlutterPcOptions, readonly ctx: EngineContext) {}

  async start(): Promise<void> {
    const { ctx, project } = this;
    try {
      requireFlutter(project, 'windows');
      ctx.emit({ type: 'session', mode: 'live', state: 'starting' });
      this.sdk = await flutterOnPc(project, ctx);
      await ensureWindowsToolchain(ctx);
      ctx.emit({ type: 'target', target: this.target });
      await this.launch();
      if (this.options.watch !== false && !this.stopped) {
        this.watcher = watchWrites(project.capDir, (rel) => classifyFlutterChange(rel, '') !== 'ignore', (files) => void this.cycle({ files, rebuild: false, restart: false, reload: false }), 200);
      }
    } catch (err) {
      await this.stop();
      if (!isCancelled(err)) ctx.emit({ type: 'session', mode: 'live', state: 'failed', error: toErrorInfo(err) });
      throw err;
    }
  }

  private async launch(): Promise<void> {
    this.runner?.stop();
    const runner = startFlutterOnPc(this.project, this.sdk!, flutterBuildOptions(this.project, { ...this.options, mode: 'debug' }), this.ctx, true);
    this.runner = runner;
    void runner.transport.done.then((result) => {
      if (this.runner !== runner || this.stopped) return;
      this.runner = null;
      if (result.reason === 'exited') this.ctx.emit({ type: 'session', mode: 'live', state: 'idle' });
    }, (err) => {
      if (this.runner !== runner || this.stopped) return;
      this.runner = null;
      const error = toErrorInfo(err);
      this.ctx.emit({ type: 'error', error });
      this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error });
    });
    await untilStarted(runner);
    this.ctx.emit({ type: 'session', mode: 'live', state: 'running' });
    this.options.onReady?.();
  }

  private async cycle(work: { files: string[]; rebuild: boolean; restart: boolean; reload: boolean }): Promise<void> {
    if (this.stopped) return;
    if (this.busy) {
      const q = this.queued;
      this.queued = q ? { files: [...q.files, ...work.files], rebuild: q.rebuild || work.rebuild, restart: q.restart || work.restart, reload: q.reload || work.reload } : work;
      return;
    }
    this.busy = true;
    try {
      const changes = new Set(work.files.map((rel) => classifyFlutterChange(rel, '')).filter((change) => matters(change, 'windows')));
      if (work.rebuild || !this.runner || needsRebuild(changes, 'windows')) {
        if (work.files.length && !work.rebuild) log(this.ctx, 'info', 'Dependencies or windows/ changed: rebuilding the app');
        this.ctx.emit({ type: 'session', mode: 'live', state: 'building' });
        await this.launch();
        return;
      }
      if (!work.restart && !work.reload && changes.size === 0) return;
      let result = await this.runner.reload(work.restart, work.restart ? 'manual' : 'save');
      if (!result.ok && result.needsRestart) result = await this.runner.reload(true, 'save');
      if (result.ok) this.ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail: result.message });
      else this.ctx.emit({ type: 'error', error: { message: `Hot reload failed: ${result.message}`, hint: 'Fix the error and save again, or rebuild.', expected: true } });
    } catch (err) {
      if (!this.stopped) this.ctx.emit({ type: 'error', error: toErrorInfo(err) });
    } finally {
      this.busy = false;
      const next = this.queued;
      this.queued = null;
      if (next && !this.stopped) void this.cycle(next);
    }
  }

  reload(full = false): Promise<void> {
    return this.cycle({ files: [], rebuild: false, restart: full, reload: !full });
  }

  rebuild(): void {
    void this.cycle({ files: [], rebuild: true, restart: false, reload: false });
  }

  relaunch(): void {
    void this.cycle({ files: [], rebuild: false, restart: true, reload: false });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopping' });
    this.watcher?.close();
    const runner = this.runner;
    this.runner = null;
    if (runner) {
      runner.stop();
      await runner.transport.done.catch(() => undefined);
    }
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopped' });
  }
}
