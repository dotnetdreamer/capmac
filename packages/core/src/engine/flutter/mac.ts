/**
 * Flutter apps on the paired Mac: the iOS app on a simulator or on a device
 * the Mac reaches, and the Mac app on the Mac's desktop. Flutter on the Mac
 * builds, installs and launches (`flutter run`, as an IDE drives it); CapMac
 * syncs the project, makes sure Flutter is there, shows the steps and the
 * console, and in live mode hot-reloads the app on every save.
 */
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import type { FlutterBuildOptions, FlutterBuildParams, FlutterBuildResult, FlutterDaemonMessage, FlutterDevice, FlutterMode, FlutterRunParams, FlutterRunResult, FlutterSdkInfo, FlutterSdkResult } from '../../shared/flutter.js';
import { PathMapper } from '../../shared/paths.js';
import type { Target } from '../../shared/protocol.js';
import { AgentCallError } from '../agent-client.js';
import { log, startStep, type EngineContext } from '../context.js';
import { macTarget } from '../electron.js';
import { CancelledError, isCancelled, toErrorInfo, UserError } from '../errors.js';
import { downloadFromMac } from '../ipa.js';
import type { MacLink } from '../link.js';
import { Pipeline, type TargetOptions } from '../pipeline.js';
import { appFor, requireFlutter, type ProjectInfo } from '../project.js';
import type { MacSession } from '../session.js';
import { syncToMac, type SyncSummary } from '../sync-client.js';
import { AgentEventTranslator } from '../translate.js';
import { watchWrites } from '../watch.js';
import { classifyFlutterChange, matters, needsRebuild, type FlutterChange } from './changes.js';
import { localFlutter } from './local.js';
import { flutterLogEntry, FlutterRunner, type DaemonTransport, type ReloadResult } from './runner.js';

/** The Flutter apps that run through the Mac. */
export type FlutterMacApp = 'ios' | 'macos';

export interface FlutterRunOptions extends TargetOptions {
  /** Which app: the iOS app or the Mac app (default: the project's app). */
  app?: FlutterMacApp;
  mode?: FlutterMode;
  flavor?: string;
  /** The Dart entry point (default: capmac.json flutter.target, else lib/main.dart). */
  main?: string;
  dartDefines?: Record<string, string>;
  /** A device build's Apple team. */
  team?: string;
  /** Stream the app's output until it quits (default true; false returns once it runs). */
  logs?: boolean;
  /** Called once the app runs. */
  onReady?: () => void;
}

/** What `flutter run`/`flutter build` get: the command's flags over capmac.json's flutter section. */
export function flutterBuildOptions(project: ProjectInfo, options: { mode?: FlutterMode; flavor?: string; main?: string; dartDefines?: Record<string, string> } = {}): FlutterBuildOptions {
  const flutter = requireFlutter(project);
  const target = options.main ?? flutter.options.target;
  return {
    mode: options.mode ?? 'debug',
    ...(target && target !== 'lib/main.dart' ? { target: target.replace(/\\/g, '/') } : {}),
    ...(options.flavor ?? flutter.options.flavor ? { flavor: options.flavor ?? flutter.options.flavor } : {}),
    ...(flutter.options.dartDefines || options.dartDefines ? { dartDefines: { ...flutter.options.dartDefines, ...options.dartDefines } } : {}),
    ...(flutter.options.dartDefineFile ? { dartDefineFile: flutter.options.dartDefineFile } : {}),
    ...(flutter.options.args?.length ? { args: flutter.options.args } : {}),
  };
}

/** The app a Flutter command on the Mac is for: the one asked for, else the project's (its iOS app when that is its Windows app). */
export function flutterMacApp(project: ProjectInfo, options: { app?: string; target?: string; device?: boolean; simulator?: boolean } = {}): FlutterMacApp {
  const app = appFor(project, options);
  if (app === 'windows') {
    if (options.app !== undefined || (options.target && /^(pc|this pc|windows)$/i.test(options.target))) throw new UserError('A Flutter app’s Windows app runs on this PC, not on the Mac.', 'Run it with `capmac run --app windows`.');
    return project.flutter?.platforms.ios ? 'ios' : 'macos';
  }
  if (app !== 'ios' && app !== 'macos') throw new UserError('This is not a Flutter app.');
  requireFlutter(project, app);
  return app;
}

/** The Flutter version the project pins (FVM, capmac.json), if any: then the Mac must have that one. */
function pinnedVersion(project: ProjectInfo): string | undefined {
  return project.flutter?.wantsFlutter.exact ?? undefined;
}

const sdkChecked = new WeakMap<MacSession, Map<string, FlutterSdkInfo>>();

/**
 * The Flutter the Mac uses for this project. When the Mac has none that fits,
 * CapMac offers to install one in ~/.capmac/flutter: the version the project
 * pins, else this PC's, else the latest stable.
 */
export async function flutterOnMac(session: MacSession, project: ProjectInfo, ctx: EngineContext, signal?: AbortSignal, platforms: FlutterMacApp[] = ['ios', 'macos']): Promise<FlutterSdkInfo> {
  const wanted = pinnedVersion(project);
  const key = wanted ?? '';
  // Flutter there already: nothing to get (it gets the app's packages as it builds).
  const ready = (sdk: FlutterSdkInfo) => ctx.emit({ type: 'phase-skipped', phase: 'deps', reason: `Flutter ${sdk.version} is ready on ${session.label}` });
  const known = sdkChecked.get(session)?.get(key);
  if (known) {
    ready(known);
    return known;
  }
  const found = await session.call<FlutterSdkResult>('flutter-sdk', { version: wanted }, { signal });
  let sdk = found.sdk;
  if (sdk) ready(sdk);
  if (!sdk) {
    const version = wanted ?? (await localFlutter())?.version ?? 'stable';
    const what = version === 'stable' ? 'the latest stable Flutter' : `Flutter ${version}`;
    if (!ctx.prompter.interactive) {
      throw new UserError(wanted ? `Flutter ${wanted} (the version this project pins) is not on ${session.label}.` : `Flutter is not on ${session.label}.`, 'Install it from CapMac Studio, or run `capmac flutter install` in a terminal.');
    }
    const yes = await ctx.prompter.confirm({
      message: `Install ${what} on ${session.label}?`,
      detail: `Flutter builds your app on the Mac. CapMac downloads it (about 1 GB) into ~/.capmac/flutter there, apart from any Flutter you install yourself.`,
      confirmLabel: 'Install Flutter',
      defaultYes: true,
    });
    if (!yes) throw new UserError(`Flutter is needed on ${session.label} to build this app.`, 'Run again and let CapMac install it, or install Flutter on the Mac yourself.');
    const translator = new AgentEventTranslator(ctx, 'flutter-sdk');
    const installed = await session.call<FlutterSdkResult>('flutter-sdk', { version, install: true, platforms }, { signal, onEvent: translator.handle }).catch((err) => {
      translator.closeOpenSteps(isCancelled(err) ? 'cancelled' : 'failed');
      throw err instanceof AgentCallError ? new UserError(err.message, err.hint, err.tail) : err;
    });
    sdk = installed.sdk;
    if (!sdk) throw new UserError(`Flutter could not be installed on ${session.label}.`);
    log(ctx, 'success', `Flutter ${sdk.version} is installed on ${session.label}`);
  }
  if (!sdkChecked.has(session)) sdkChecked.set(session, new Map());
  sdkChecked.get(session)!.set(key, sdk);
  return sdk;
}

/** An agent error as a UserError with Flutter's own messages (paths as this PC's). */
function asUserError(err: unknown, mapper: PathMapper | null): unknown {
  if (err instanceof AgentCallError) {
    const tail = (err.tail ?? []).map((line) => (mapper ? mapper.mapText(line) : line));
    return Object.assign(new UserError(err.message, err.hint, tail.length ? tail : undefined), err.code ? { code: err.code } : {});
  }
  return err;
}

function failure(err: unknown, mapper: PathMapper | null): never {
  throw asUserError(err, mapper);
}

/** Builds the Mac app on the Mac (`flutter build macos`); its path there. */
async function buildMacApp(session: MacSession, project: ProjectInfo, sdk: FlutterSdkInfo, options: FlutterBuildOptions, mapper: PathMapper | null, ctx: EngineContext, signal?: AbortSignal): Promise<string> {
  const translator = new AgentEventTranslator(ctx, 'flutter-build', mapper);
  const params: FlutterBuildParams = { projectId: project.projectId, projectRel: project.projectRel, what: 'macos', options, version: sdk.version };
  const result = await session.call<FlutterBuildResult>('flutter-build', params, { signal, onEvent: translator.handle }).catch((err) => {
    translator.closeOpenSteps(isCancelled(err) ? 'cancelled' : 'failed');
    return failure(err, mapper);
  });
  if (!result.appPath) throw new UserError('The build made no Mac app.');
  return result.appPath;
}

/** A Mac app CapMac launched on the Mac (with its module in it). */
export interface MacAppProcess {
  /** Its window is open. */
  readonly ready: Promise<void>;
  /** A debug build's Dart VM service (for hot reload), else null. */
  readonly vm: Promise<string | null>;
  readonly done: Promise<FlutterRunResult>;
  stop(): void;
}

/** Launches the built Mac app, behind whatever the Mac shows; its window shows in CapMac, its output in the console. */
async function launchMacApp(session: MacSession, project: ProjectInfo, appPath: string, debug: boolean, mapper: PathMapper | null, ctx: EngineContext, where: string, signal?: AbortSignal): Promise<MacAppProcess> {
  const appName = appNameOf(project, 'macos');
  const bundleId = project.flutter?.macos?.bundleId ?? undefined;
  const launch = startStep(ctx, `Launching ${appName}`, 'launch');
  let running = false;
  let markReady!: () => void;
  let failReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  ready.catch(() => undefined);
  let gotVm!: (uri: string | null) => void;
  const vm = new Promise<string | null>((resolve) => (gotVm = resolve));
  const translator = new AgentEventTranslator(ctx, 'flutter-mac-launch', mapper);
  const call = await session.agent.start<FlutterRunResult>('flutter-mac-launch', { projectId: project.projectId, appPath, debug }, {
    signal,
    onEvent: (event) => {
      if (event.t === 'ready') {
        if (running) return;
        running = true;
        launch.succeed();
        ctx.emit({ type: 'app', state: 'running', name: appName, bundleId, target: where });
        markReady();
      } else if (event.t === 'flutter-vm') {
        gotVm(event.uri);
      } else if (event.t === 'app') {
        const entry = flutterLogEntry(mapper ? mapper.mapText(event.text) : event.text);
        if (entry) ctx.emit({ type: 'app-log', entry });
      } else if (event.t === 'electron') {
        if (event.event.e === 'note') log(ctx, 'note', event.event.message);
      } else {
        translator.handle(event);
      }
    },
  });
  const done = call.result.then(
    (result) => {
      gotVm(null);
      if (!running) {
        if (result.reason === 'cancelled') launch.cancel();
        else launch.fail();
        failReady(result.reason === 'cancelled' ? new CancelledError() : new UserError('The Mac app quit before its window opened.'));
      } else {
        ctx.emit({ type: 'app', state: result.reason === 'cancelled' ? 'stopped' : 'exited', name: appName, bundleId, target: where, exitCode: result.exitCode });
      }
      return result;
    },
    (err) => {
      gotVm(null);
      const error = asUserError(err, mapper);
      if (!running) {
        if (isCancelled(err)) launch.cancel();
        else launch.fail();
      }
      translator.closeOpenSteps(isCancelled(err) ? 'cancelled' : 'failed');
      failReady(error);
      throw error;
    },
  );
  done.catch(() => undefined);
  return { ready, vm, done, stop: () => call.cancel() };
}

/** The Dart VM service, or null when the app does not say within `ms` (a release build has none). */
function vmWithin(app: MacAppProcess, ms: number): Promise<string | null> {
  return Promise.race([app.vm, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref())]);
}

interface MacRunStart {
  session: MacSession;
  project: ProjectInfo;
  device: FlutterDevice;
  options: FlutterBuildOptions;
  sdk: FlutterSdkInfo;
  team?: string;
  mapper: PathMapper | null;
  appName: string;
  where: string;
  live?: boolean;
  signal?: AbortSignal;
  /** Attach to the app at this Dart VM service instead of launching one. */
  attachUrl?: string;
  /** The app's own lines (false when CapMac launched it and relays them already). */
  appLogs?: boolean;
}

/** Starts `flutter run` (or `flutter attach`) on the Mac; the runner follows it from there. */
export async function startFlutterOnMac(start: MacRunStart, ctx: EngineContext): Promise<FlutterRunner> {
  const { session, project, mapper } = start;
  let runner: FlutterRunner | null = null;
  const early: FlutterDaemonMessage[] = [];
  const translator = new AgentEventTranslator(ctx, 'flutter-run', mapper);
  const params: FlutterRunParams = {
    projectId: project.projectId,
    projectRel: project.projectRel,
    device: start.device,
    options: start.options,
    version: start.sdk.version,
    team: start.team,
    attachUrl: start.attachUrl,
  };
  // A simulator that was already on: its step is done before Flutter starts.
  const simulator = start.device.kind === 'ios' && start.device.target.kind === 'simulator' && !start.attachUrl;
  let booted = false;
  let bootNoted = !simulator;
  const call = await session.agent.start<FlutterRunResult>('flutter-run', params, {
    signal: start.signal,
    onEvent: (event) => {
      if (event.t === 'step' && event.id === 'boot') booted = true;
      if (event.t === 'flutter' && !bootNoted) {
        bootNoted = true;
        if (!booted) ctx.emit({ type: 'phase-skipped', phase: 'boot', reason: 'already booted' });
      }
      if (event.t === 'flutter') {
        if (runner) runner.handle(event.msg);
        else early.push(event.msg);
        return;
      }
      if (event.t === 'out') {
        runner?.output(event.text, event.stream);
        return;
      }
      translator.handle(event);
    },
  });
  const transport: DaemonTransport = {
    send: (id, method, args) => call.send({ t: 'flutter-request', id, method, params: args }),
    done: call.result.catch((err) => {
      translator.closeOpenSteps(isCancelled(err) ? 'cancelled' : 'failed');
      return failure(err, mapper);
    }),
    stop: () => call.cancel(),
  };
  const localRoot = project.capDir;
  runner = new FlutterRunner(transport, ctx, {
    appName: start.appName,
    where: start.where,
    bundleId: start.device.kind === 'macos' ? project.flutter?.macos?.bundleId ?? undefined : project.flutter?.ios?.bundleId ?? undefined,
    live: start.live,
    appLogs: start.appLogs,
    attached: Boolean(start.attachUrl),
    mapText: mapper ? (text) => mapper.mapText(text) : undefined,
    toLocal: (file) => (file.startsWith('/') ? (mapper ? mapper.toLocal(file) : file) : path.join(localRoot, ...file.split('/'))),
  });
  for (const msg of early) runner.handle(msg);
  return runner;
}

/** Where the Flutter app runs on the Mac: a simulator or device, or the Mac's desktop. */
async function chooseDevice(pipeline: Pipeline, app: FlutterMacApp, options: FlutterRunOptions, ctx: EngineContext): Promise<{ device: FlutterDevice; target: Target }> {
  if (app === 'macos') {
    const target = macTarget(pipeline.session.label, pipeline.session.host.macos);
    ctx.emit({ type: 'target', target });
    return { device: { kind: 'macos' }, target };
  }
  const target = await pipeline.chooseTarget(options);
  if (target.kind === 'simulator' && options.mode && options.mode !== 'debug') {
    throw new UserError(`Flutter runs apps on simulators in debug mode only (not ${options.mode}).`, 'Pick an iPhone for a profile or release run, or run without --release/--profile.');
  }
  if (target.kind === 'device') await pipeline.ensureKeychainUnlocked();
  return { device: { kind: 'ios', target }, target };
}

/**
 * Waits for the app to run. When Flutter stops first, its own error (with
 * its messages) says more than "it stopped", so that is what is thrown.
 */
export async function untilStarted(runner: FlutterRunner): Promise<void> {
  try {
    await runner.started;
  } catch (err) {
    const result = await runner.transport.done;
    if (result.reason === 'cancelled') throw new CancelledError();
    throw err;
  }
}

/** The app's name in titles. */
function appNameOf(project: ProjectInfo, app: FlutterMacApp): string {
  const flutter = project.flutter;
  return (app === 'macos' ? flutter?.macos?.displayName : flutter?.ios?.displayName) ?? project.appName;
}

/**
 * `capmac run` for a Flutter app on the Mac: sync, Flutter, then `flutter run`
 * until the app quits or `signal` stops it (which stops the app too).
 */
export async function runFlutterOnMac(project: ProjectInfo, link: MacLink, options: FlutterRunOptions, ctx: EngineContext, signal: AbortSignal): Promise<FlutterRunResult> {
  const app = options.app ?? flutterMacApp(project, options);
  const session = await link.session();
  const pipeline = new Pipeline(session, project, ctx);
  await pipeline.sync(false, signal);
  const sdk = await flutterOnMac(session, project, ctx, signal, [app]);
  const { device, target } = await chooseDevice(pipeline, app, options, ctx);
  if (app === 'macos') {
    // CapMac launches the Mac app itself (with its module: behind the Mac's other windows, its window in CapMac).
    if (options.logs === false) throw new UserError('The Mac app runs while CapMac is attached to it.', 'Use `capmac run --for 20` to launch it, show its console for 20 seconds, then quit it.');
    const options_ = flutterBuildOptions(project, options);
    const appPath = await buildMacApp(session, project, sdk, options_, pipeline.mapper, ctx, signal);
    const mac = await launchMacApp(session, project, appPath, options_.mode === 'debug', pipeline.mapper, ctx, target.name, signal);
    await mac.ready;
    options.onReady?.();
    return mac.done;
  }
  const runner = await startFlutterOnMac({
    session,
    project,
    device,
    options: flutterBuildOptions(project, options),
    sdk,
    team: options.team ?? project.config.ios?.team,
    mapper: pipeline.mapper,
    appName: appNameOf(project, app),
    where: target.name,
    signal,
  }, ctx);
  await untilStarted(runner);
  options.onReady?.();
  if (options.logs === false) {
    runner.transport.stop();
    return { reason: 'exited', exitCode: null };
  }
  return runner.transport.done;
}

/** Live mode for a Flutter app on the Mac: what `capmac dev` and Studio's Live take. */
export interface FlutterLiveOptions extends FlutterRunOptions {
  /** Hot reload when files are saved (default true). */
  watch?: boolean;
}

interface Work {
  files?: string[];
  rebuild?: boolean;
  /** A hot restart. */
  restart?: boolean;
  /** A hot reload, whatever changed (the Reload button). */
  reload?: boolean;
}

/**
 * A Flutter app in debug mode on the Mac, reloaded as you work: every save is
 * synced and hot-reloaded (a hot restart when the reload cannot apply it); a
 * change to the dependencies or the app's native folder rebuilds and relaunches.
 */
export class FlutterLiveSession {
  target: Target | null = null;
  readonly app: FlutterMacApp;
  private runner: FlutterRunner | null = null;
  private pipeline: Pipeline | null = null;
  private sdk: FlutterSdkInfo | null = null;
  private watcher: FSWatcher | null = null;
  private readonly stopAll = new AbortController();
  private busy = false;
  private queued: Work | null = null;
  private reconnecting = false;
  private unsubscribeLink: (() => void) | null = null;
  private stopping: Promise<void> | null = null;

  constructor(readonly project: ProjectInfo, readonly link: MacLink, readonly options: FlutterLiveOptions, readonly ctx: EngineContext) {
    this.app = options.app ?? flutterMacApp(project, options);
  }

  get stopped(): boolean {
    return this.stopAll.signal.aborted;
  }

  get session(): MacSession | null {
    return this.pipeline?.session ?? null;
  }

  /** Syncs, makes sure Flutter is on the Mac, runs the app, then follows your edits. */
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
    const { ctx, project } = this;
    ctx.emit({ type: 'session', mode: 'live', state: 'starting' });
    const session = await this.link.session();
    this.pipeline = new Pipeline(session, project, ctx);
    await this.pipeline.sync(false, this.stopAll.signal);
    this.sdk = await flutterOnMac(session, project, ctx, this.stopAll.signal, [this.app]);
    const chosen = await chooseDevice(this.pipeline, this.app, { ...this.options, mode: 'debug' }, ctx);
    this.target = chosen.target;
    this.unsubscribeLink = this.link.onChange((state, next) => this.onLinkChange(state, next));
    // (Still the first build: 'building' is for the rebuilds after it, which start a new timeline run.)
    await this.launch(chosen.device);
    if (this.options.watch !== false && !this.stopped) {
      this.watcher = watchWrites(project.syncRoot, (rel) => classifyFlutterChange(rel, project.projectRel) !== 'ignore', (files) => void this.cycle({ files }), 200);
    }
  }

  private device(): FlutterDevice {
    return this.app === 'macos' || !this.target ? { kind: 'macos' } : { kind: 'ios', target: this.target };
  }

  /** The Mac app CapMac launched (the Mac app's live mode; Flutter attaches to it for hot reload). */
  private macApp: MacAppProcess | null = null;

  /**
   * The Mac app: built, then launched by CapMac (behind the Mac's other
   * windows, its window in CapMac), then `flutter attach` to its Dart VM
   * service for hot reload.
   */
  private async launchMac(): Promise<void> {
    const pipeline = this.pipeline!;
    const previous = { runner: this.runner, app: this.macApp };
    this.runner = null;
    this.macApp = null;
    previous.runner?.stop();
    previous.app?.stop();
    await Promise.allSettled([previous.runner?.transport.done, previous.app?.done]);
    const options = flutterBuildOptions(this.project, { ...this.options, mode: 'debug' });
    const appPath = await buildMacApp(pipeline.session, this.project, this.sdk!, options, pipeline.mapper, this.ctx, this.stopAll.signal);
    const mac = await launchMacApp(pipeline.session, this.project, appPath, true, pipeline.mapper, this.ctx, this.target?.name ?? 'the Mac', this.stopAll.signal);
    this.macApp = mac;
    void mac.done.then(
      (result) => {
        if (this.macApp !== mac || this.stopped || this.reconnecting) return;
        this.macApp = null;
        this.runner?.stop();
        this.runner = null;
        if (result.reason === 'exited') this.ctx.emit({ type: 'session', mode: 'live', state: 'idle' });
      },
      (err) => {
        if (this.macApp !== mac || this.stopped || this.reconnecting) return;
        this.macApp = null;
        if (!isCancelled(err)) {
          const error = toErrorInfo(err);
          this.ctx.emit({ type: 'error', error });
          this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error });
        }
      },
    );
    await mac.ready;
    const uri = await vmWithin(mac, 30_000);
    if (!uri) {
      log(this.ctx, 'warn', 'The Mac app did not say where its Dart VM service is, so saves rebuild it instead of hot-reloading.');
    } else {
      const runner = await startFlutterOnMac({
        session: pipeline.session,
        project: this.project,
        device: { kind: 'macos' },
        options,
        sdk: this.sdk!,
        mapper: pipeline.mapper,
        appName: appNameOf(this.project, 'macos'),
        where: this.target?.name ?? 'the Mac',
        live: true,
        signal: this.stopAll.signal,
        attachUrl: uri,
        // The app's own lines come from CapMac's launch already.
        appLogs: false,
      }, this.ctx);
      this.runner = runner;
      await untilStarted(runner).catch((err) => {
        if (isCancelled(err)) throw err;
        this.runner = null;
        log(this.ctx, 'warn', `Hot reload is not available: ${(err as Error)?.message ?? err}`);
      });
    }
    this.ctx.emit({ type: 'session', mode: 'live', state: 'running' });
    this.options.onReady?.();
  }

  private async launch(device: FlutterDevice): Promise<void> {
    if (device.kind === 'macos') return this.launchMac();
    const pipeline = this.pipeline!;
    this.runner?.stop();
    const runner = await startFlutterOnMac({
      session: pipeline.session,
      project: this.project,
      device,
      options: flutterBuildOptions(this.project, { ...this.options, mode: 'debug' }),
      sdk: this.sdk!,
      team: this.options.team ?? this.project.config.ios?.team,
      mapper: pipeline.mapper,
      appName: appNameOf(this.project, this.app),
      where: this.target?.name ?? 'the Mac',
      live: true,
      signal: this.stopAll.signal,
    }, this.ctx);
    this.runner = runner;
    void runner.transport.done.then(
      (result) => {
        if (this.runner !== runner || this.stopped || this.reconnecting) return;
        this.runner = null;
        if (result.reason === 'exited') this.ctx.emit({ type: 'session', mode: 'live', state: 'idle' });
      },
      (err) => {
        if (this.runner !== runner || this.stopped || this.reconnecting) return;
        this.runner = null;
        if (!isCancelled(err)) {
          const error = toErrorInfo(err);
          this.ctx.emit({ type: 'error', error });
          this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error });
        }
      },
    );
    await untilStarted(runner);
    this.ctx.emit({ type: 'session', mode: 'live', state: 'running' });
    this.options.onReady?.();
  }

  /** One piece of work at a time; work that comes meanwhile is merged and runs next. */
  private async cycle(work: Work): Promise<void> {
    if (this.stopped || !this.pipeline) return;
    if (this.busy || this.reconnecting) {
      const q = this.queued ?? {};
      this.queued = { files: [...(q.files ?? []), ...(work.files ?? [])], rebuild: q.rebuild || work.rebuild, restart: q.restart || work.restart, reload: q.reload || work.reload };
      return;
    }
    this.busy = true;
    const signal = this.stopAll.signal;
    try {
      await this.perform(work, signal);
    } catch (err) {
      if (!signal.aborted && !this.reconnecting) {
        const error = toErrorInfo(err);
        this.ctx.emit({ type: 'error', error });
        if (!this.runner) this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error });
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

  private async sync(signal: AbortSignal, quiet: boolean): Promise<SyncSummary> {
    const pipeline = this.pipeline!;
    const ctx = quiet ? { ...this.ctx, emit: (event: Parameters<EngineContext['emit']>[0]) => event.type === 'log' && this.ctx.emit(event) } : this.ctx;
    const result = await syncToMac(pipeline.session, this.project, { includeWebDir: false, signal }, ctx);
    pipeline.mapper = new PathMapper(result.remoteRoot, this.project.syncRoot);
    return result;
  }

  private async perform(work: Work, signal: AbortSignal): Promise<void> {
    if (work.rebuild || !this.runner) {
      this.ctx.emit({ type: 'session', mode: 'live', state: 'building' });
      await this.sync(signal, false);
      await this.launch(this.device());
      return;
    }
    const synced = await this.sync(signal, true);
    const changes = new Set<FlutterChange>(synced.changed.map((rel) => classifyFlutterChange(rel, this.project.projectRel)).filter((change) => matters(change, this.app)));
    if (needsRebuild(changes, this.app)) {
      log(this.ctx, 'info', `${describe(synced.changed)} changed: rebuilding the app`);
      return this.perform({ rebuild: true }, signal);
    }
    if (!work.restart && !work.reload && changes.size === 0) return;
    await this.hotReload(Boolean(work.restart), synced.changed);
  }

  private async hotReload(full: boolean, changed: string[]): Promise<ReloadResult | null> {
    const runner = this.runner;
    if (!runner?.running) return null;
    const what = changed.length ? describe(changed) : null;
    let result = await runner.reload(full, full ? 'manual' : 'save');
    if (!result.ok && result.needsRestart) {
      log(this.ctx, 'info', `${result.message}: restarting the app`);
      result = await runner.reload(true, 'save');
    }
    if (result.ok) {
      this.ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail: `${what ? `${what}: ` : ''}${result.message}` });
    } else {
      this.ctx.emit({ type: 'error', error: { message: `${full ? 'Hot restart' : 'Hot reload'} failed: ${result.message}`, hint: 'Fix the error and save again, or rebuild.', expected: true } });
    }
    return result;
  }

  /** A hot reload now (`full`: a hot restart), after syncing what changed. */
  async reload(full = false): Promise<void> {
    await this.cycle(full ? { restart: true } : { reload: true });
  }

  /** Syncs and rebuilds the app, then launches it again. */
  rebuild(): void {
    void this.cycle({ rebuild: true });
  }

  /** A hot restart: the app starts over with its current code, without a rebuild. */
  relaunch(): void {
    void this.cycle({ restart: true });
  }

  private onLinkChange(state: string, session: MacSession | null): void {
    if (this.stopped) return;
    if (state === 'lost') {
      // Flutter (and a Mac app CapMac launched) ran over the old connection: they are gone with it.
      this.reconnecting = true;
      this.runner = null;
      this.macApp = null;
    } else if (state === 'restored' && session && this.pipeline) {
      this.pipeline.session = session;
      this.reconnecting = false;
      void this.cycle({ rebuild: true });
    }
  }

  private teardown(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        this.stopAll.abort();
        this.unsubscribeLink?.();
        this.watcher?.close();
        const runner = this.runner;
        const mac = this.macApp;
        this.runner = null;
        this.macApp = null;
        runner?.stop();
        mac?.stop();
        await Promise.allSettled([runner?.transport.done, mac?.done]);
      })();
    }
    return this.stopping;
  }

  /** Stops the app and Flutter on the Mac. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopping' });
    await this.teardown();
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopped' });
  }
}

function describe(paths: string[]): string {
  const names = paths.slice(0, 2).map((rel) => path.posix.basename(rel));
  return paths.length > 2 ? `${names.join(', ')} and ${paths.length - 2} more` : names.join(', ');
}

export interface FlutterBuildOnMacOptions {
  app?: FlutterMacApp;
  /** ios: a signed device build; ios-simulator; ipa; macos (default: ipa for the iOS app, macos for the Mac app). */
  what?: FlutterBuildParams['what'];
  mode?: FlutterMode;
  flavor?: string;
  main?: string;
  team?: string;
  exportMethod?: FlutterBuildParams['exportMethod'];
  /** Where to save the .ipa (default: <project>/build/ios/ipa). */
  outDir?: string;
}

export type FlutterBuildOnMacResult = { kind: 'ipa'; file: string; size: number } | { kind: 'app'; build: FlutterBuildResult };

/** `capmac build` for a Flutter app on the Mac: a simulator or Mac app (left on the Mac), a device build, or an .ipa (downloaded to this PC). */
export async function buildFlutterOnMac(project: ProjectInfo, link: MacLink, options: FlutterBuildOnMacOptions, ctx: EngineContext, signal?: AbortSignal): Promise<FlutterBuildOnMacResult> {
  const app = options.app ?? flutterMacApp(project);
  const what = options.what ?? (app === 'macos' ? 'macos' : 'ipa');
  if (app === 'macos' && what !== 'macos') throw new UserError('The Mac app builds as a Mac app.', 'Leave out --ipa, or build the iOS app with `--app ios`.');
  const session = await link.session();
  const pipeline = new Pipeline(session, project, ctx);
  await pipeline.sync(false, signal);
  const sdk = await flutterOnMac(session, project, ctx, signal, [app]);
  if (what === 'ios' || what === 'ipa') await pipeline.ensureKeychainUnlocked();
  const mode = options.mode ?? (what === 'ios-simulator' ? 'debug' : 'release');
  if (what === 'ios-simulator' && mode !== 'debug') throw new UserError('Flutter builds simulator apps in debug mode only.');
  const translator = new AgentEventTranslator(ctx, 'flutter-build', pipeline.mapper);
  const params: FlutterBuildParams = {
    projectId: project.projectId,
    projectRel: project.projectRel,
    what,
    options: flutterBuildOptions(project, { ...options, mode }),
    version: sdk.version,
    team: options.team ?? project.config.ios?.team,
    exportMethod: options.exportMethod ?? (what === 'ipa' ? 'development' : undefined),
  };
  const result = await session.call<FlutterBuildResult>('flutter-build', params, { signal, onEvent: translator.handle }).catch((err) => {
    translator.closeOpenSteps(isCancelled(err) ? 'cancelled' : 'failed');
    return failure(err, pipeline.mapper);
  });
  if (what === 'ipa') {
    if (!result.ipaPath) throw new UserError('The build finished but made no .ipa.');
    const outDir = path.resolve(options.outDir ?? path.join(project.capDir, 'build', 'ios', 'ipa'));
    const file = await downloadFromMac(session, project, result.ipaPath, path.join(outDir, path.posix.basename(result.ipaPath)), null, ctx, signal);
    const { size } = await import('node:fs').then((fs) => fs.promises.stat(file));
    return { kind: 'ipa', file, size };
  }
  return { kind: 'app', build: result };
}

/** Throws CancelledError when `signal` is aborted (for loops that wait on Flutter). */
export function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}
