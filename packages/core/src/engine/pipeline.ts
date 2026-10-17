import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PathMapper } from '../shared/paths.js';
import type { AgentEvent, BuildResult, DeployResult, PrepareResult, Target, TargetsResult } from '../shared/protocol.js';
import { AgentCallError, type CallHandlers } from './agent-client.js';
import { log, startStep, type EngineContext, type StepHandle } from './context.js';
import { CancelledError, isCancelled, UserError } from './errors.js';
import { stripAnsi } from './format.js';
import { recall, remember } from './memory.js';
import { hasInstalledDependencies, scriptCommand, usesSceneLifecycle, type ProjectInfo } from './project.js';
import type { MacSession } from './session.js';
import type { ApiKey } from './signing.js';
import { syncToMac, type SyncSummary } from './sync-client.js';
import { chooseTarget } from './targets.js';
import { AgentEventTranslator, AppLogClassifier } from './translate.js';

/** Builds the web app on Windows with the project's own build script. */
export async function buildWeb(project: ProjectInfo, ctx: EngineContext, signal?: AbortSignal): Promise<void> {
  const configured = project.config.web?.build;
  if (configured === false) {
    ctx.emit({ type: 'phase-skipped', phase: 'web', reason: 'web build turned off in capmac.json' });
    return;
  }
  const command = typeof configured === 'string' ? configured : project.scripts.build ? scriptCommand(project.packageManager, 'build') : null;
  if (!command) {
    log(ctx, 'warn', `No "build" script in package.json; using the existing ${project.webDir}/ as is.`);
    ctx.emit({ type: 'phase-skipped', phase: 'web', reason: 'no build script' });
    return;
  }
  // A project copied without node_modules (e.g. the sample) can still run with its built assets.
  const hasModules = hasInstalledDependencies(project);
  if (!hasModules && !configured && existsSync(path.join(project.capDir, project.webDir, 'index.html'))) {
    log(ctx, 'info', `Using the built web assets in ${project.webDir}/ (dependencies are not installed on this PC; \`${project.packageManager} install\` builds from source).`);
    ctx.emit({ type: 'phase-skipped', phase: 'web', reason: 'dependencies not installed on this PC' });
    return;
  }
  const s = startStep(ctx, `Building web assets (${command})`, 'web');
  const output: string[] = [];
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command, { cwd: project.capDir, shell: true, env: { ...process.env, FORCE_COLOR: ctx.verbose ? process.env.FORCE_COLOR : '0' }, windowsHide: true });
      const onAbort = () => {
        child.kill();
        reject(new CancelledError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const onData = (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          output.push(line);
          if (output.length > 400) output.shift();
          ctx.emit({ type: 'tool-output', stream: 'stdout', text: line });
          s.update(stripAnsi(line).trim());
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (exit) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(exit);
      });
    });
  } catch (err) {
    if (isCancelled(err)) s.cancel();
    else s.fail();
    throw err;
  }
  if (code !== 0) {
    s.fail();
    throw new UserError(`The web build failed (${command}).`, 'Fix the errors above, or skip it with --no-web-build to use the existing web assets.', output.slice(-40).map(stripAnsi));
  }
  s.succeed();
}

export interface BuildOptions {
  configuration?: string;
  scheme?: string;
  team?: string;
  clean?: boolean;
  force?: boolean;
  extraArgs?: string[];
  /** App Store Connect API key for signing device builds over SSH. */
  auth?: ApiKey;
}

export interface TargetOptions {
  target?: string;
  device?: boolean;
  simulator?: boolean;
}

export interface DeployOptions {
  attach: boolean;
  showSimulator?: boolean;
  osLogs?: boolean;
  signal?: AbortSignal;
  onReady?: () => void;
  /** Arguments the app is launched with (a React Native debug build: where Metro is). */
  launchArgs?: string[];
}

/** The shared steps behind `run`, `dev` and `build`. */
export class Pipeline {
  mapper: PathMapper | null = null;
  /** Keeps multi-line console messages together across relaunches. */
  private readonly classifier: AppLogClassifier;

  /** `classifier`: how the app's lines read (a React Native app's differ from a Capacitor app's). */
  constructor(public session: MacSession, readonly project: ProjectInfo, readonly ctx: EngineContext, classifier?: AppLogClassifier) {
    this.classifier = classifier ?? new AppLogClassifier();
  }

  private ref() {
    return { projectId: this.project.projectId, projectRel: this.project.projectRel };
  }

  /** Runs an agent operation and reports its events (steps, diagnostics, app output). */
  async call<T>(op: string, params: object = {}, handlers: CallHandlers = {}): Promise<T> {
    const translator = new AgentEventTranslator(this.ctx, op, this.mapper, this.classifier);
    try {
      return await this.session.call<T>(op, params, {
        ...handlers,
        onEvent: (event: AgentEvent) => {
          translator.handle(event);
          handlers.onEvent?.(event);
        },
      });
    } catch (err) {
      translator.closeOpenSteps(isCancelled(err) || handlers.signal?.aborted ? 'cancelled' : 'failed');
      throw err;
    }
  }

  async sync(includeWebDir: boolean, signal?: AbortSignal): Promise<SyncSummary> {
    const result = await syncToMac(this.session, this.project, { includeWebDir, signal }, this.ctx);
    this.mapper = new PathMapper(result.remoteRoot, this.project.syncRoot);
    return result;
  }

  async prepare(liveUrl: string | null, options: { full?: boolean; signal?: AbortSignal } = {}): Promise<PrepareResult> {
    const result = await this.call<PrepareResult>(
      'prepare',
      { ...this.ref(), webDir: this.project.webDir, iosDir: this.project.iosDir, liveUrl, full: options.full },
      { signal: options.signal },
    ).catch((err) => this.fail(err));
    if (!result.installed) this.ctx.emit({ type: 'phase-skipped', phase: 'deps', reason: 'dependencies unchanged' });
    if (!result.capCommand) this.ctx.emit({ type: 'phase-skipped', phase: 'cap', reason: liveUrl ? 'nothing to copy' : 'web assets unchanged' });
    return result;
  }

  async targets(): Promise<TargetsResult> {
    return this.session.call<TargetsResult>('targets');
  }

  /** Picks the target (explicit > capmac.json > last used > a sensible default) and remembers it. */
  async chooseTarget(options: TargetOptions): Promise<Target> {
    const memory = await recall(this.project.projectId);
    const wanted = options.target ?? this.project.config.ios?.target;
    const all = await this.targets();
    const target = chooseTarget(all, {
      wanted,
      device: options.device,
      simulator: options.simulator,
      last: options.device ? memory.lastDevice : memory.lastTarget,
    });
    // Only a convenience for next time: a run never fails for it.
    await remember(this.project.projectId, target.kind === 'device' ? { lastDevice: target.udid } : { lastTarget: target.udid }).catch(() => undefined);
    this.ctx.emit({ type: 'target', target });
    return target;
  }

  /** Unlocks the Mac's login keychain if needed (code signing over SSH requires it). */
  async ensureKeychainUnlocked(): Promise<void> {
    const status = await this.session.call<{ locked: boolean | null }>('keychain-status').catch(() => ({ locked: null }));
    if (status.locked) await unlockKeychain(this.session, this.ctx, false);
  }

  async build(target: Target, options: BuildOptions = {}, signal?: AbortSignal): Promise<BuildResult> {
    const params = {
      ...this.ref(),
      target,
      iosDir: this.project.iosDir,
      configuration: options.configuration ?? this.project.config.ios?.configuration ?? 'Debug',
      scheme: options.scheme ?? this.project.config.ios?.scheme ?? this.project.scheme,
      team: options.team ?? this.project.config.ios?.team ?? this.project.teamId,
      clean: options.clean,
      force: options.force,
      verbose: this.ctx.verbose,
      extraArgs: options.extraArgs,
      auth: options.auth,
    };
    this.warnAboutScenes();
    if (target.kind === 'device') await this.ensureKeychainUnlocked();
    const attempt = () => this.call<BuildResult>('build', params, { signal });
    let result: BuildResult;
    try {
      result = await attempt();
    } catch (err) {
      if (!(err instanceof AgentCallError && err.code === 'KEYCHAIN_LOCKED')) return this.fail(err);
      await unlockKeychain(this.session, this.ctx, true);
      result = await attempt().catch((e) => this.fail(e));
    }
    if (result.logPath) this.ctx.emit({ type: 'build-log', path: result.logPath });
    if (result.skipped) {
      this.ctx.emit({ type: 'build-reused', reason: 'native-unchanged' });
      this.ctx.emit({ type: 'phase-skipped', phase: 'build', reason: 'native code unchanged' });
    }
    return result;
  }

  private scenesChecked = false;

  /** Apps without the UIScene lifecycle build fine with the iOS 27 SDK but never launch. */
  private warnAboutScenes(): void {
    if (this.scenesChecked) return;
    this.scenesChecked = true;
    const xcodeMajor = Number(this.session.host.xcode?.split('.')[0] ?? 0);
    if (xcodeMajor >= 27 && usesSceneLifecycle(this.project) === false) {
      log(this.ctx, 'warn', 'This app does not use the UIScene lifecycle, which the iOS 27 SDK requires (it will not launch). Run `npx cap migrate` to add it.');
    }
  }

  /**
   * Installs and launches the app. With `attach`, streams its output until it
   * exits or `signal` aborts (which also stops the app, like Xcode's Stop).
   */
  async deploy(target: Target, build: BuildResult, options: DeployOptions): Promise<DeployResult> {
    let booted = false;
    let launch: StepHandle | null = null;
    const appEvent = { name: build.displayName, bundleId: build.bundleId, target: target.name };
    const result = await this.call<DeployResult>(
      'deploy',
      { ...this.ref(), target, appPath: build.appPath, bundleId: build.bundleId, attach: options.attach, showSimulator: options.showSimulator, osLogs: options.osLogs, ...(options.launchArgs?.length ? { launchArgs: options.launchArgs } : {}) },
      {
        signal: options.signal,
        onEvent: (event) => {
          if (event.t === 'step' && event.id === 'boot') booted = true;
          if (event.t === 'step-end' && event.id === 'install' && event.ok) {
            if (!booted && target.kind === 'simulator') this.ctx.emit({ type: 'phase-skipped', phase: 'boot', reason: 'already booted' });
            launch = startStep(this.ctx, `Launching ${build.displayName}`, 'launch');
            this.ctx.emit({ type: 'app', state: 'launching', ...appEvent });
          }
          if (event.t === 'ready') {
            launch?.succeed();
            launch = null;
            this.ctx.emit({ type: 'app', state: 'running', ...appEvent });
            options.onReady?.();
          }
        },
      },
    ).catch((err) => {
      const cancelled = isCancelled(err) || options.signal?.aborted;
      if (cancelled) (launch as StepHandle | null)?.cancel();
      else (launch as StepHandle | null)?.fail();
      return this.fail(err);
    });
    if (result.reason === 'exited') this.ctx.emit({ type: 'app', state: 'exited', exitCode: result.exitCode, ...appEvent });
    if (result.reason === 'cancelled') this.ctx.emit({ type: 'app', state: 'stopped', ...appEvent });
    return result;
  }

  /** Converts agent errors into friendly UserErrors (with the tool output tail, paths mapped). */
  fail(err: unknown): never {
    if (err instanceof AgentCallError) {
      if (err.logPath) this.ctx.emit({ type: 'build-log', path: err.logPath });
      const tail = (err.tail ?? []).map((line) => (this.mapper ? this.mapper.mapText(line) : line));
      throw Object.assign(new UserError(err.message, err.hint, tail.length ? tail : undefined), err.code ? { code: err.code } : {});
    }
    throw err;
  }
}

/** Asks for the Mac password and unlocks the login keychain (code signing over SSH needs it). */
export async function unlockKeychain(session: MacSession, ctx: EngineContext, allowCodesign: boolean): Promise<{ partitionList: boolean }> {
  if (!ctx.prompter.interactive) {
    throw new UserError('The Mac keychain is locked, so code signing cannot work over SSH.', 'Run `capmac keychain` in an interactive terminal first.');
  }
  log(ctx, 'info', `Code signing needs the login keychain on ${session.label} unlocked.`);
  const pw = await ctx.prompter.password({ purpose: 'keychain', message: `Mac login password for ${session.host.username}:`, mac: session.label, user: session.host.username });
  const result = await session.call<{ unlocked: boolean; partitionList: boolean }>('keychain', { password: pw, allowCodesign });
  log(ctx, 'success', 'Keychain unlocked');
  return result;
}
