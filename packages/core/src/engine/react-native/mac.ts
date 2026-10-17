/**
 * React Native apps through the paired Mac: the iOS app on a simulator or a
 * device the Mac reaches, and the Mac app (react-native-macos) on the Mac's
 * desktop. The Mac builds the native app (CocoaPods, xcodebuild) only when
 * something native changed; the JavaScript comes from Metro on this PC,
 * through the SSH connection, so a save shows in the app at once (Fast
 * Refresh) with no sync and no build. A release build bundles the JavaScript
 * into the app instead, as React Native's own build does.
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { metroLaunchArgs, classifyReactNativeChange, needsNativeRebuild, type ReactNativeApplePlatform, type ReactNativeBuildParams, type ReactNativeChange, type ReactNativePrepareParams, type ReactNativePrepareResult } from '../../shared/react-native.js';
import type { BuildResult, DeployResult, Target } from '../../shared/protocol.js';
import { AgentCallError, type AgentCall } from '../agent-client.js';
import { log, startStep, type EngineContext } from '../context.js';
import { macTarget } from '../electron.js';
import { CancelledError, isCancelled, toErrorInfo, UserError } from '../errors.js';
import type { MacLink } from '../link.js';
import { launchMacApp, type LaunchedMacApp } from '../mac-app.js';
import { Pipeline, unlockKeychain, type TargetOptions } from '../pipeline.js';
import { appFor, loadProject, nodeExecutable, requireReactNative, type ProjectInfo } from '../project.js';
import type { MacSession } from '../session.js';
import type { ForwardObserver } from '../ssh.js';
import { watchWrites } from '../watch.js';
import { ReactNativeLogClassifier } from './logs.js';
import { startMetro, type MetroServer } from './metro.js';

/** The React Native apps that run through the Mac. */
export type ReactNativeMacApp = ReactNativeApplePlatform;

export interface ReactNativeRunOptions extends TargetOptions {
  /** Which app: the iOS app or the Mac app (default: the project's app). */
  app?: ReactNativeMacApp;
  /** The Xcode configuration (default capmac.json ios.configuration, else Debug; --release: Release). */
  configuration?: string;
  release?: boolean;
  scheme?: string;
  /** A device build's Apple team. */
  team?: string;
  clean?: boolean;
  /** Stream the app's output until it quits (default true; false returns once it runs). */
  logs?: boolean;
  showSimulator?: boolean;
  osLogs?: boolean;
  /** Called once the app runs. */
  onReady?: () => void;
}

/** The app a React Native command on the Mac is for: the one asked for, else the project's (its iOS app when that is its Windows app). */
export function reactNativeMacApp(project: ProjectInfo, options: { app?: string; target?: string; device?: boolean; simulator?: boolean } = {}): ReactNativeMacApp {
  const app = appFor(project, options);
  if (app === 'windows') {
    if (options.app !== undefined || (options.target && /^(pc|this pc|windows)$/i.test(options.target))) throw new UserError('A React Native app’s Windows app runs on this PC, not on the Mac.', 'Run it with `capmac run --app windows`.');
    return project.reactNative?.platforms.ios ? 'ios' : 'macos';
  }
  if (app !== 'ios' && app !== 'macos') throw new UserError('This is not a React Native app.');
  requireReactNative(project, app);
  return app;
}

/** The Xcode configuration a run builds: --release, the one asked for, capmac.json's, else Debug. */
export function configurationOf(project: ProjectInfo, options: { configuration?: string; release?: boolean }): string {
  if (options.release) return 'Release';
  return options.configuration ?? project.config.ios?.configuration ?? 'Debug';
}

/** Debug builds load their JavaScript from Metro; the others carry it bundled. */
export const isDebugConfiguration = (configuration: string) => /debug/i.test(configuration);

/** The app's name in titles. */
function appNameOf(project: ProjectInfo, app: ReactNativeMacApp): string {
  const rn = project.reactNative;
  return (app === 'macos' ? rn?.macos?.displayName : rn?.ios?.displayName) ?? project.appName;
}

function schemeOf(project: ProjectInfo, app: ReactNativeMacApp, wanted?: string): string {
  const rn = requireReactNative(project, app);
  if (app === 'ios' && (wanted ?? project.config.ios?.scheme)) return (wanted ?? project.config.ios!.scheme)!;
  return (app === 'macos' ? rn.macos?.scheme : rn.ios?.scheme) ?? rn.name;
}

/**
 * An Expo app without an ios/ folder: `expo prebuild` makes it on this PC,
 * as `expo run:ios` would (without `pod install`: the Mac, or WSL, does that).
 * Returns the project as it is afterwards.
 */
export async function ensureIosFolder(project: ProjectInfo, ctx: EngineContext, signal?: AbortSignal): Promise<ProjectInfo> {
  if (!project.reactNative?.prebuild) return project;
  const cli = ['expo/bin/cli'].map((rel) => path.join(project.capDir, 'node_modules', ...rel.split('/'))).find((file) => existsSync(file));
  if (!cli) throw new UserError('This Expo app has no ios/ folder, and Expo is not installed on this PC to make it.', `Run \`${project.packageManager} install\`, then run again (CapMac runs \`expo prebuild\`).`);
  const step = startStep(ctx, 'Making the iOS app’s folder (expo prebuild --platform ios)', 'deps');
  const tail: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', FORCE_COLOR: '0', EXPO_NO_GIT_STATUS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(nodeExecutable(), [cli, 'prebuild', '--platform', 'ios', '--no-install'], { cwd: project.capDir, env, windowsHide: true });
    const onAbort = () => {
      child.kill();
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        ctx.emit({ type: 'tool-output', stream: 'stdout', text: line });
        step.update(line.trim().slice(0, 140));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (exit) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(exit);
    });
  }).catch((err) => {
    if (isCancelled(err)) step.cancel();
    else step.fail();
    throw err;
  });
  if (code !== 0) {
    step.fail();
    throw new UserError('`expo prebuild` could not make the iOS app’s folder.', 'Fix what Expo says above (often app.json), then run again.', tail.slice(-20));
  }
  step.succeed();
  return loadProject(project.capDir);
}

/** The PC's Podfile.lock for an app, when the project keeps one (see ReactNativePrepareParams.podfileLock). */
async function podfileLockOf(project: ProjectInfo, dir: string): Promise<string | undefined> {
  return fs.readFile(path.join(project.capDir, dir, 'Podfile.lock'), 'utf8').catch(() => undefined);
}

/** The app's packages and CocoaPods on the Mac (`rn-prepare`). */
export async function prepareOnMac(pipeline: Pipeline, app: ReactNativeMacApp, options: { full?: boolean; signal?: AbortSignal } = {}): Promise<ReactNativePrepareResult> {
  const project = pipeline.project;
  const rn = requireReactNative(project, app);
  const dir = app === 'macos' ? rn.macos!.dir : rn.ios!.dir;
  const params: ReactNativePrepareParams = {
    projectId: project.projectId,
    projectRel: project.projectRel,
    platform: app,
    dir,
    full: options.full,
    ...(rn.options.podEnv ? { podEnv: rn.options.podEnv } : {}),
    ...(await podfileLockOf(project, dir).then((lock) => (lock === undefined ? {} : { podfileLock: lock }))),
  };
  const result = await pipeline.call<ReactNativePrepareResult>('rn-prepare', params, { signal: options.signal }).catch((err) => pipeline.fail(err));
  if (!result.installed && !result.pods) pipeline.ctx.emit({ type: 'phase-skipped', phase: 'deps', reason: 'packages and native libraries unchanged' });
  return result;
}

/** Builds the app on the Mac (`rn-build`); a build nothing native changed for is reused. */
export async function buildOnMac(pipeline: Pipeline, app: ReactNativeMacApp, target: Target, options: { configuration: string; scheme?: string; team?: string; clean?: boolean; force?: boolean; signal?: AbortSignal }): Promise<BuildResult> {
  const project = pipeline.project;
  const rn = requireReactNative(project, app);
  const params: ReactNativeBuildParams = {
    projectId: project.projectId,
    projectRel: project.projectRel,
    platform: app,
    dir: app === 'macos' ? rn.macos!.dir : rn.ios!.dir,
    scheme: schemeOf(project, app, options.scheme),
    configuration: options.configuration,
    target,
    team: app === 'ios' ? options.team ?? project.config.ios?.team ?? project.teamId : undefined,
    clean: options.clean,
    force: options.force || options.clean,
    verbose: pipeline.ctx.verbose,
  };
  if (target.kind === 'device') await pipeline.ensureKeychainUnlocked();
  const attempt = () => pipeline.call<BuildResult>('rn-build', params, { signal: options.signal });
  let result: BuildResult;
  try {
    result = await attempt();
  } catch (err) {
    if (!(err instanceof AgentCallError && err.code === 'KEYCHAIN_LOCKED')) return pipeline.fail(err);
    await unlockKeychain(pipeline.session, pipeline.ctx, true);
    result = await attempt().catch((e) => pipeline.fail(e));
  }
  if (result.logPath) pipeline.ctx.emit({ type: 'build-log', path: result.logPath });
  if (result.skipped) {
    pipeline.ctx.emit({ type: 'build-reused', reason: 'native-unchanged' });
    pipeline.ctx.emit({ type: 'phase-skipped', phase: 'build', reason: 'native code unchanged' });
  }
  return result;
}

const WEBSOCKET_UPGRADE = /^upgrade:\s*websocket\s*$/im;

/**
 * Metro, as the app on the Mac's side reaches it: an SSH reverse tunnel makes
 * Metro on this PC localhost on the Mac (simulators and the Mac app use it);
 * an iPhone, which cannot reach the Mac's loopback, gets the tunnel on the
 * Mac's network address too.
 */
export class MetroBridge {
  private tunnel: { port: number; close: () => Promise<void> } | null = null;
  private relay: AgentCall<unknown> | null = null;
  private readonly sockets = new Set<number>();
  /** host:port the app loads its JavaScript from. */
  hostPort: string | null = null;

  constructor(private readonly metro: MetroServer, private readonly ctx: EngineContext) {}

  private readonly observer: ForwardObserver = {
    onRequest: (id, head) => {
      if (!WEBSOCKET_UPGRADE.test(head)) return;
      this.sockets.add(id);
      if (this.sockets.size === 1) this.ctx.emit({ type: 'hmr', state: 'connected', at: Date.now() });
    },
    onClose: (id) => {
      if (this.sockets.delete(id) && this.sockets.size === 0) this.ctx.emit({ type: 'hmr', state: 'disconnected', at: Date.now() });
    },
  };

  async connect(session: MacSession, target: Target): Promise<string> {
    await this.close();
    // The same port on the Mac when it is free there, so the app finds Metro where React Native looks first.
    try {
      this.tunnel = await session.conn.reverseForward(this.metro.port, this.metro.port, '127.0.0.1', this.observer);
    } catch {
      this.tunnel = await session.conn.reverseForward(0, this.metro.port, '127.0.0.1', this.observer);
    }
    if (target.kind !== 'device') {
      this.hostPort = `localhost:${this.tunnel.port}`;
    } else {
      this.relay = await session.agent.start('relay', { listenHost: '0.0.0.0', listenPort: 0, targetPort: this.tunnel.port });
      const ready = await this.relay.waitFor<{ data: { port: number; addresses: string[] } }>('ready');
      const ip = ready.data.addresses[0];
      if (!ip) throw new UserError('The Mac has no network address the iPhone could use to reach Metro.', 'Connect the Mac and the iPhone to the same Wi-Fi, then try again.');
      this.hostPort = `${ip}:${ready.data.port}`;
    }
    this.ctx.emit({ type: 'tunnel', state: 'up', liveUrl: `http://${this.hostPort}`, localUrl: `localhost:${this.metro.port}` });
    return this.hostPort;
  }

  /** The connection to the Mac dropped: what ran over it is gone. */
  lost(): void {
    this.tunnel = null;
    this.relay = null;
    this.sockets.clear();
    this.ctx.emit({ type: 'tunnel', state: 'down' });
  }

  async close(): Promise<void> {
    this.relay?.cancel();
    this.relay = null;
    const tunnel = this.tunnel;
    this.tunnel = null;
    await tunnel?.close().catch(() => undefined);
  }
}

/** Where the app runs: a simulator or device for the iOS app, the Mac's desktop for the Mac app. */
async function chooseTarget(pipeline: Pipeline, app: ReactNativeMacApp, options: TargetOptions, ctx: EngineContext): Promise<Target> {
  if (app === 'macos') {
    const target = macTarget(pipeline.session.label, pipeline.session.host.macos);
    ctx.emit({ type: 'target', target });
    return target;
  }
  return pipeline.chooseTarget(options);
}

/** A running app: the iOS app's deploy call, or the Mac app CapMac launched. */
interface RunningApp {
  readonly done: Promise<DeployResult | { reason: 'exited' | 'cancelled'; exitCode: number | null }>;
  stop(): void;
}

/** Installs and opens the app (the iOS app through `deploy`, the Mac app with CapMac's module in it). */
async function startApp(pipeline: Pipeline, app: ReactNativeMacApp, target: Target, build: BuildResult, launchArgs: string[], options: { attach: boolean; showSimulator?: boolean; osLogs?: boolean; onReady?: () => void; jsFromMetro: boolean }, ctx: EngineContext): Promise<RunningApp> {
  const controller = new AbortController();
  if (app === 'macos') {
    const classifier = new ReactNativeLogClassifier(options.jsFromMetro);
    const mac: LaunchedMacApp = await launchMacApp(pipeline.session, {
      op: 'mac-app-launch',
      params: { projectId: pipeline.project.projectId, appPath: build.appPath, args: launchArgs },
      appName: build.displayName || appNameOf(pipeline.project, 'macos'),
      bundleId: build.bundleId,
      where: target.name,
      mapper: pipeline.mapper,
      logEntry: (text, stream) => classifier.classify(text, stream),
    }, ctx, controller.signal);
    void mac.ready.then(() => options.onReady?.(), () => undefined);
    await mac.ready;
    return { done: mac.done, stop: () => mac.stop() };
  }
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  const done = pipeline.deploy(target, build, {
    attach: options.attach,
    showSimulator: options.showSimulator,
    osLogs: options.osLogs,
    signal: controller.signal,
    launchArgs,
    onReady: () => {
      resolveReady();
      options.onReady?.();
    },
  });
  // Opened (or failed to): the run goes on from there.
  await Promise.race([ready, done.then(() => undefined)]);
  return { done, stop: () => controller.abort() };
}

/**
 * `capmac run` for a React Native app on the Mac: Metro on this PC (a debug
 * build), sync, packages and CocoaPods on the Mac, build, install and open,
 * then the app's output until it quits or `signal` stops it (which stops the
 * app too).
 */
export async function runReactNativeOnMac(project: ProjectInfo, link: MacLink, options: ReactNativeRunOptions, ctx: EngineContext, signal: AbortSignal): Promise<DeployResult | { reason: 'exited' | 'cancelled'; exitCode: number | null }> {
  const app = options.app ?? reactNativeMacApp(project, options);
  if (app === 'ios') project = await ensureIosFolder(project, ctx, signal);
  const configuration = configurationOf(project, options);
  const debug = isDebugConfiguration(configuration);
  const sessionPromise = link.session();
  sessionPromise.catch(() => undefined);
  // Metro starts while the Mac syncs and builds (a release build carries its JavaScript).
  if (!debug) ctx.emit({ type: 'phase-skipped', phase: 'devserver', reason: 'a release build carries its JavaScript' });
  const metroPromise = debug ? startMetro(project, { signal }, ctx) : null;
  metroPromise?.catch(() => undefined);
  let metro: MetroServer | null = null;
  let bridge: MetroBridge | null = null;
  try {
    const session = await sessionPromise;
    const pipeline = new Pipeline(session, project, ctx, new ReactNativeLogClassifier(debug));
    await pipeline.sync(false, signal);
    await prepareOnMac(pipeline, app, { full: options.clean, signal });
    const target = await chooseTarget(pipeline, app, options, ctx);
    const build = await buildOnMac(pipeline, app, target, { configuration, scheme: options.scheme, team: options.team, clean: options.clean, signal });
    let launchArgs: string[] = [];
    if (metroPromise) {
      metro = await metroPromise;
      bridge = new MetroBridge(metro, ctx);
      launchArgs = metroLaunchArgs(await bridge.connect(session, target));
    }
    if (app === 'macos' && options.logs === false) throw new UserError('The Mac app runs while CapMac is attached to it.', 'Use `capmac run --for 20` to launch it, show its console for 20 seconds, then quit it.');
    const running = await startApp(pipeline, app, target, build, launchArgs, { attach: options.logs !== false, showSimulator: options.showSimulator, osLogs: options.osLogs, onReady: options.onReady, jsFromMetro: debug }, ctx);
    const stop = () => running.stop();
    signal.addEventListener('abort', stop, { once: true });
    try {
      return await running.done;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  } finally {
    await bridge?.close();
    if (!metro && metroPromise) metro = await metroPromise.catch(() => null);
    await metro?.stop();
  }
}

/** Live mode for a React Native app on the Mac: what `capmac dev` and Studio's Live take. */
export interface ReactNativeLiveOptions extends ReactNativeRunOptions {
  /** Rebuild when native files change (default true; Metro brings JavaScript over by itself). */
  watch?: boolean;
}

interface Work {
  files?: string[];
  rebuild?: boolean;
  clean?: boolean;
  /** Start the app again without building. */
  relaunch?: boolean;
}

function describe(paths: string[]): string {
  const names = paths.slice(0, 2).map((rel) => path.posix.basename(rel));
  return paths.length > 2 ? `${names.join(', ')} and ${paths.length - 2} more` : names.join(', ');
}

/**
 * A React Native app in debug mode through the Mac, as you work: Metro on
 * this PC brings every JavaScript save into the app at once (Fast Refresh);
 * a change to the packages or the app's native folder rebuilds it on the Mac
 * and opens it again; a dropped connection is restored and the app relaunched.
 */
export class ReactNativeLiveSession {
  target: Target | null = null;
  readonly app: ReactNativeMacApp;
  metro: MetroServer | null = null;
  private pipeline: Pipeline | null = null;
  private bridge: MetroBridge | null = null;
  private running: RunningApp | null = null;
  private lastBuild: BuildResult | null = null;
  private watcher: FSWatcher | null = null;
  private readonly stopAll = new AbortController();
  private busy = false;
  private queued: Work | null = null;
  private reconnecting = false;
  private unsubscribeLink: (() => void) | null = null;
  private stopping: Promise<void> | null = null;

  constructor(public project: ProjectInfo, readonly link: MacLink, readonly options: ReactNativeLiveOptions, readonly ctx: EngineContext) {
    this.app = options.app ?? reactNativeMacApp(project, options);
  }

  get stopped(): boolean {
    return this.stopAll.signal.aborted;
  }

  get session(): MacSession | null {
    return this.pipeline?.session ?? null;
  }

  /** Starts Metro, builds and opens the app, then follows your edits. */
  async start(): Promise<void> {
    try {
      await this.startInner();
    } catch (err) {
      await this.teardown();
      if (!isCancelled(err)) this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error: toErrorInfo(err) });
      throw err;
    }
  }

  private async startInner(): Promise<void> {
    const { ctx } = this;
    const signal = this.stopAll.signal;
    ctx.emit({ type: 'session', mode: 'live', state: 'starting' });
    if (this.app === 'ios') this.project = await ensureIosFolder(this.project, ctx, signal);
    const configuration = configurationOf(this.project, this.options);
    if (!isDebugConfiguration(configuration)) throw new UserError('Live mode needs a debug build (its JavaScript comes from Metro).', 'Leave out --release, or use `capmac run --release` for a release build.');
    const sessionPromise = this.link.session();
    sessionPromise.catch(() => undefined);
    this.metro = await startMetro(this.project, { signal }, ctx);
    const session = await sessionPromise;
    this.pipeline = new Pipeline(session, this.project, ctx, new ReactNativeLogClassifier(true));
    await this.pipeline.sync(false, signal);
    await prepareOnMac(this.pipeline, this.app, { full: this.options.clean, signal });
    this.target = await chooseTarget(this.pipeline, this.app, this.options, ctx);
    this.bridge = new MetroBridge(this.metro, ctx);
    await this.bridge.connect(session, this.target);
    this.unsubscribeLink = this.link.onChange((state, next) => this.onLinkChange(state, next));
    this.lastBuild = await buildOnMac(this.pipeline, this.app, this.target, { configuration, scheme: this.options.scheme, team: this.options.team, clean: this.options.clean, signal });
    await this.launch();
    if (this.options.watch !== false && !this.stopped) {
      const project = this.project;
      this.watcher = watchWrites(project.syncRoot, (rel) => classifyReactNativeChange(rel, project.projectRel) !== 'ignore', (files) => void this.onSaved(files), 200);
    }
  }

  private async launch(): Promise<void> {
    const previous = this.running;
    this.running = null;
    previous?.stop();
    await previous?.done.catch(() => undefined);
    const running = await startApp(this.pipeline!, this.app, this.target!, this.lastBuild!, metroLaunchArgs(this.bridge!.hostPort!), {
      attach: true,
      showSimulator: this.options.showSimulator,
      osLogs: this.options.osLogs,
      jsFromMetro: true,
      onReady: () => {
        this.ctx.emit({ type: 'session', mode: 'live', state: 'running' });
        this.options.onReady?.();
      },
    }, this.ctx);
    this.running = running;
    void running.done.then(
      (result) => {
        if (this.running !== running || this.stopped || this.reconnecting) return;
        this.running = null;
        if (result.reason === 'exited') this.ctx.emit({ type: 'session', mode: 'live', state: 'idle' });
      },
      (err) => {
        if (this.running !== running || this.stopped || this.reconnecting) return;
        this.running = null;
        if (!isCancelled(err)) {
          const error = toErrorInfo(err);
          this.ctx.emit({ type: 'error', error });
          this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error });
        }
      },
    );
  }

  /** Saved files: JavaScript reaches the app through Metro by itself; native changes rebuild it. */
  private async onSaved(files: string[]): Promise<void> {
    const changes = new Set<ReactNativeChange>(files.map((rel) => classifyReactNativeChange(rel, this.project.projectRel)));
    if ([...changes].some((change) => needsNativeRebuild(change, this.app))) {
      this.ctx.emit({ type: 'native-change', kinds: ['native'], paths: files });
      log(this.ctx, 'info', `${describe(files)} changed: rebuilding the app`);
      return this.cycle({ files, rebuild: true });
    }
    if (changes.has('metro')) {
      log(this.ctx, 'info', `${describe(files)} changed: Metro starts again with its new settings`);
      return this.restartMetro();
    }
    // (Editors and tools save through temporary files that are gone by now: name only the files that stay.)
    const saved = files.filter((rel) => existsSync(path.join(this.project.syncRoot, ...rel.split('/'))));
    if (changes.has('js') && saved.length) this.ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail: `${describe(saved)}: sent to the app (Fast Refresh)` });
  }

  /** One piece of work at a time; work that comes meanwhile is merged and runs next. */
  private async cycle(work: Work): Promise<void> {
    if (this.stopped || !this.pipeline) return;
    if (this.busy || this.reconnecting) {
      const q = this.queued ?? {};
      this.queued = { files: [...(q.files ?? []), ...(work.files ?? [])], rebuild: q.rebuild || work.rebuild, clean: q.clean || work.clean, relaunch: (q.relaunch ?? true) && work.relaunch };
      return;
    }
    this.busy = true;
    const signal = this.stopAll.signal;
    try {
      if (!work.relaunch || !this.lastBuild) {
        this.ctx.emit({ type: 'session', mode: 'live', state: 'building' });
        await this.pipeline.sync(false, signal);
        await prepareOnMac(this.pipeline, this.app, { full: work.clean, signal });
        this.lastBuild = await buildOnMac(this.pipeline, this.app, this.target!, { configuration: configurationOf(this.project, this.options), scheme: this.options.scheme, team: this.options.team, clean: work.clean, signal });
      }
      if (!this.stopped) await this.launch();
    } catch (err) {
      if (!signal.aborted && !this.reconnecting) {
        const error = toErrorInfo(err);
        this.ctx.emit({ type: 'error', error });
        if (!this.running) this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error });
      }
    } finally {
      this.busy = false;
      if (this.queued && !signal.aborted && !this.reconnecting) {
        const next = this.queued;
        this.queued = null;
        void this.cycle(next);
      }
    }
  }

  private async restartMetro(): Promise<void> {
    if (!this.metro || this.metro.external) return;
    await this.metro.stop();
    this.metro = await startMetro(this.project, { signal: this.stopAll.signal, resetCache: true }, this.ctx);
    await this.reload();
  }

  /** Reloads the app's JavaScript (Metro's r). */
  async reload(): Promise<void> {
    const ok = await this.metro?.reload();
    if (ok) this.ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail: 'Reloaded the JavaScript' });
    else log(this.ctx, 'warn', 'Metro could not reach the app to reload it. Is it open?');
  }

  /** Opens React Native DevTools for the app (Metro's j). */
  async openDevTools(): Promise<boolean> {
    return (await this.metro?.openDevTools()) ?? false;
  }

  /** Syncs and rebuilds the app on the Mac, then opens it again. */
  rebuild(options: { clean?: boolean } = {}): void {
    void this.cycle({ rebuild: true, clean: options.clean });
  }

  /** Opens the app again without building. */
  relaunch(): void {
    void this.cycle({ relaunch: true });
  }

  private onLinkChange(state: string, session: MacSession | null): void {
    if (this.stopped) return;
    if (state === 'lost') {
      // The app (its console), the tunnel and the relay ran over the old connection.
      this.reconnecting = true;
      this.running = null;
      this.bridge?.lost();
    } else if (state === 'restored' && session && this.pipeline) {
      void (async () => {
        try {
          this.pipeline!.session = session;
          await this.bridge!.connect(session, this.target!);
          this.reconnecting = false;
          void this.cycle({ relaunch: true });
        } catch (err) {
          log(this.ctx, 'note', `  could not restore the connection to Metro (${(err as Error)?.message ?? err}); retrying…`);
          session.close();
        }
      })();
    }
  }

  private teardown(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        this.stopAll.abort();
        this.unsubscribeLink?.();
        this.watcher?.close();
        const running = this.running;
        this.running = null;
        running?.stop();
        await running?.done.catch(() => undefined);
        await this.bridge?.close();
        await this.metro?.stop().catch(() => undefined);
      })();
    }
    return this.stopping;
  }

  /** Stops the app, the tunnel and Metro. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopping' });
    await this.teardown();
    this.ctx.emit({ type: 'tunnel', state: 'down' });
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopped' });
  }
}

export interface ReactNativeBuildOnMacOptions {
  app?: ReactNativeMacApp;
  /** simulator: a simulator build; device: a signed device build; macos: the Mac app. Default: device for the iOS app (Release). */
  what?: 'simulator' | 'device' | 'macos';
  configuration?: string;
  release?: boolean;
  scheme?: string;
  team?: string;
  clean?: boolean;
  target?: string;
}

/** `capmac build` for a React Native app on the Mac: a simulator, device or Mac build, left on the Mac. */
export async function buildReactNativeOnMac(project: ProjectInfo, link: MacLink, options: ReactNativeBuildOnMacOptions, ctx: EngineContext, signal?: AbortSignal): Promise<BuildResult> {
  const app = options.app ?? reactNativeMacApp(project);
  if (app === 'ios') project = await ensureIosFolder(project, ctx, signal);
  const session = await link.session();
  const configuration = options.configuration ?? (options.release ? 'Release' : project.config.ios?.configuration ?? 'Release');
  const pipeline = new Pipeline(session, project, ctx, new ReactNativeLogClassifier(false));
  await pipeline.sync(false, signal);
  await prepareOnMac(pipeline, app, { full: options.clean, signal });
  const target = app === 'macos'
    ? await chooseTarget(pipeline, app, {}, ctx)
    : await pipeline.chooseTarget({ target: options.target, device: options.what !== 'simulator', simulator: options.what === 'simulator' });
  return buildOnMac(pipeline, app, target, { configuration, scheme: options.scheme, team: options.team, clean: options.clean, signal });
}
