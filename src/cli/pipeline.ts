import { spawn } from 'node:child_process';
import { PathMapper } from '../shared/paths.js';
import type { BuildResult, DeployResult, PrepareResult, Target, TargetsResult } from '../shared/protocol.js';
import { AgentCallError } from './agent-client.js';
import { UserError } from './errors.js';
import { recall, remember } from './memory.js';
import { scriptCommand, usesSceneLifecycle, type ProjectInfo } from './project.js';
import { EventRenderer } from './render.js';
import type { ApiKey } from './signing.js';
import type { MacSession } from './session.js';
import { syncToMac, type SyncSummary } from './sync-client.js';
import { chooseTarget, describeTarget } from './targets.js';
import { canPrompt, isVerbose, log, password, pc, plural, step } from './ui.js';

/** Builds the web app on Windows with the project's own build script. */
export async function buildWeb(project: ProjectInfo): Promise<void> {
  const configured = project.config.web?.build;
  if (configured === false) return;
  const command = typeof configured === 'string' ? configured : project.scripts.build ? scriptCommand(project.packageManager, 'build') : null;
  if (!command) {
    log.warn(`No "build" script in package.json; using the existing ${project.webDir}/ as is.`);
    return;
  }
  const s = step(`Building web assets (${command})`);
  const output: string[] = [];
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, { cwd: project.capDir, shell: true, env: { ...process.env, FORCE_COLOR: isVerbose() ? process.env.FORCE_COLOR : '0' }, windowsHide: true });
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        output.push(line);
        if (output.length > 400) output.shift();
        if (isVerbose()) log.dim(`  ${line}`);
        else s.update(line.replace(/\x1b\[[0-9;]*m/g, '').trim());
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) {
    s.fail();
    if (!isVerbose()) for (const line of output.slice(-40)) log.raw(line);
    throw new UserError(`The web build failed (${command}).`, 'Fix the errors above, or skip it with --no-web-build to use the existing web assets.');
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

/** The shared steps behind `run`, `dev` and `build`. */
export class Pipeline {
  mapper: PathMapper | null = null;
  readonly renderer: EventRenderer;

  constructor(public session: MacSession, readonly project: ProjectInfo, options: { bridge?: boolean; allWarnings?: boolean } = {}) {
    this.renderer = new EventRenderer({ bridge: options.bridge, allWarnings: options.allWarnings });
  }

  private ref() {
    return { projectId: this.project.projectId, projectRel: this.project.projectRel };
  }

  async sync(includeWebDir: boolean, signal?: AbortSignal): Promise<SyncSummary> {
    const result = await syncToMac(this.session, this.project, { includeWebDir, signal });
    this.mapper = new PathMapper(result.remoteRoot, this.project.syncRoot);
    this.renderer.setMapper(this.mapper);
    return result;
  }

  async prepare(liveUrl: string | null, options: { full?: boolean; signal?: AbortSignal } = {}): Promise<PrepareResult> {
    return this.session.call<PrepareResult>(
      'prepare',
      {
        ...this.ref(),
        webDir: this.project.webDir,
        iosDir: this.project.iosDir,
        liveUrl,
        full: options.full,
      },
      { onEvent: this.renderer.handle, signal: options.signal },
    ).catch((err) => this.fail(err));
  }

  async targets(): Promise<TargetsResult> {
    return this.session.call<TargetsResult>('targets');
  }

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
    await remember(this.project.projectId, target.kind === 'device' ? { lastDevice: target.udid } : { lastTarget: target.udid });
    return target;
  }

  /** Unlocks the Mac's login keychain if needed (code signing over SSH requires it). */
  async ensureKeychainUnlocked(): Promise<void> {
    const status = await this.session.call<{ locked: boolean | null }>('keychain-status').catch(() => ({ locked: null }));
    if (status.locked) await this.unlockKeychain(false);
  }

  async unlockKeychain(allowCodesign: boolean): Promise<void> {
    if (!canPrompt()) {
      throw new UserError('The Mac keychain is locked, so code signing cannot work over SSH.', 'Run `capmac keychain unlock` in an interactive terminal first.');
    }
    log.info(`Code signing needs the login keychain on ${this.session.label} unlocked.`);
    const pw = await password(`Mac login password for ${this.session.host.username}:`);
    await this.session.call('keychain', { password: pw, allowCodesign });
    log.success('Keychain unlocked');
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
      verbose: isVerbose(),
      extraArgs: options.extraArgs,
      auth: options.auth,
    };
    this.warnAboutScenes();
    if (target.kind === 'device') await this.ensureKeychainUnlocked();
    const attempt = () => this.session.call<BuildResult>('build', params, { onEvent: this.renderer.handle, signal });
    try {
      const result = await attempt();
      this.reportBuild(result);
      return result;
    } catch (err) {
      if (err instanceof AgentCallError && err.code === 'KEYCHAIN_LOCKED') {
        this.renderer.failOpenSteps();
        await this.unlockKeychain(true);
        const result = await attempt().catch((e) => this.fail(e));
        this.reportBuild(result);
        return result;
      }
      return this.fail(err);
    }
  }

  private reportBuild(result: BuildResult): void {
    const hidden = this.renderer.hiddenWarningCount;
    if (hidden > 0) log.dim(`  ${plural(hidden, 'warning')} from dependencies hidden (show with --all-warnings)`);
    void result;
  }

  private scenesChecked = false;

  /** Apps without the UIScene lifecycle build fine with the iOS 27 SDK but never launch. */
  private warnAboutScenes(): void {
    if (this.scenesChecked) return;
    this.scenesChecked = true;
    const xcodeMajor = Number(this.session.host.xcode?.split('.')[0] ?? 0);
    if (xcodeMajor >= 27 && usesSceneLifecycle(this.project) === false) {
      log.warn('This app does not use the UIScene lifecycle, which the iOS 27 SDK requires (it will not launch). Run `npx cap migrate` to add it.');
    }
  }

  async deploy(target: Target, build: BuildResult, options: { attach: boolean; showSimulator?: boolean; osLogs?: boolean; signal?: AbortSignal; onReady?: () => void }): Promise<DeployResult> {
    const call = await this.session.agent.start<DeployResult>(
      'deploy',
      { ...this.ref(), target, appPath: build.appPath, bundleId: build.bundleId, attach: options.attach, showSimulator: options.showSimulator, osLogs: options.osLogs },
      {
        // Handle "ready" inline so the success line prints before the first app log line.
        onEvent: (event) => {
          if (event.t === 'ready') options.onReady?.();
          this.renderer.handle(event);
        },
        signal: options.signal,
      },
    );
    return call.result.catch((err) => this.fail(err));
  }

  /** Converts agent errors into friendly UserErrors (with the tool output tail). */
  fail(err: unknown): never {
    this.renderer.failOpenSteps();
    if (err instanceof AgentCallError) {
      const tail = (err.tail ?? []).map((line) => (this.mapper ? this.mapper.mapText(line) : line));
      throw new UserError(err.message, err.hint, tail.length ? tail : undefined);
    }
    throw err;
  }
}

export function announceTarget(target: Target): void {
  log.info(`Target: ${pc.bold(describeTarget(target))}`);
}
