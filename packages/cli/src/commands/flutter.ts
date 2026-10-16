/**
 * `capmac run`, `capmac dev` and `capmac build` for Flutter apps: the iOS app
 * on a simulator or a device through the paired Mac (or built on this PC
 * with `--backend wsl`), the Mac app on the Mac's desktop, the Windows app on
 * this PC. `capmac flutter install` puts Flutter on the Mac or this PC.
 */
import {
  buildFlutterOnMac,
  flutterMacApp,
  FlutterLiveSession,
  FlutterPcLiveSession,
  installFlutterOnPc,
  loadProject,
  localFlutter,
  MacLink,
  MacSession,
  runFlutterOnMac,
  runFlutterOnPc,
  streamPreference,
  UserError,
  appFor,
  AgentEventTranslator,
  type ProjectInfo,
  type StreamPreference,
} from '@capmac/core/engine';
import { isFlutterMode, type FlutterMode, type FlutterSdkResult } from '@capmac/core/shared/flutter';
import { cancelOnSigint } from '../cli-context.js';
import { reportError } from '../report.js';
import { terminalContext } from '../terminal.js';
import { log, pc } from '../ui.js';
import { ScreenViewer } from '../viewer/server.js';
import { announceApp } from './apps.js';
import { untilQuit } from './dev.js';

export interface FlutterCommandOptions {
  mac?: string;
  app?: string;
  target?: string;
  device?: boolean;
  simulator?: boolean;
  /** --mode debug|profile|release, or --release. */
  mode?: string;
  release?: boolean;
  flavor?: string;
  /** The Dart entry point (lib/main.dart). */
  main?: string;
  dartDefine?: string[];
  team?: string;
  clean?: boolean;
  logs?: boolean;
  for?: string;
  watch?: boolean;
  screen?: boolean;
  stream?: StreamPreference;
  allWarnings?: boolean;
  ipa?: boolean;
  export?: string;
  out?: string;
}

/** --mode, or --release: the build mode (`fallback` when none is given). */
export function flutterMode(options: FlutterCommandOptions, fallback: FlutterMode): FlutterMode {
  if (options.mode !== undefined && !isFlutterMode(options.mode)) throw new UserError(`Unknown mode "${options.mode}".`, 'Use debug, profile or release.');
  if (options.release && options.mode && options.mode !== 'release') throw new UserError('Pick one: --release, or --mode ' + options.mode + '.');
  return options.release ? 'release' : (options.mode as FlutterMode | undefined) ?? fallback;
}

/** --dart-define KEY=VALUE (repeatable). */
function dartDefines(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf('=');
    if (at <= 0) throw new UserError(`--dart-define takes KEY=VALUE (got "${value}").`);
    out[value.slice(0, at)] = value.slice(at + 1);
  }
  return out;
}

function seconds(value: string | undefined): number | undefined {
  const n = value === undefined ? undefined : Number(value);
  if (n !== undefined && !(n > 0)) throw new UserError('--for takes a number of seconds.', 'For example: capmac run --for 20');
  return n;
}

function common(options: FlutterCommandOptions, fallback: FlutterMode) {
  return { mode: flutterMode(options, fallback), flavor: options.flavor, main: options.main, dartDefines: dartDefines(options.dartDefine) };
}

/** `capmac run` for a Flutter app: until it quits or Ctrl+C (which closes it too). */
export async function flutterRunCommand(project: ProjectInfo, options: FlutterCommandOptions): Promise<void> {
  const app = appFor(project, options);
  await announceApp(project, app);
  const { ctx } = terminalContext({ mode: 'run', platform: 'flutter', allWarnings: options.allWarnings, attach: options.logs !== false });
  const controller = new AbortController();
  const restore = cancelOnSigint(controller, 'Stopping the app…');
  const wait = seconds(options.for);
  let timer: NodeJS.Timeout | undefined;
  const onReady = wait === undefined ? undefined : () => {
    timer = setTimeout(() => {
      log.dim(`${wait} s of console captured; stopping the app.`);
      controller.abort();
    }, wait * 1000);
  };
  const link = app === 'windows' ? null : new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: false });
  try {
    const run = { ...common(options, 'debug'), logs: wait !== undefined || options.logs !== false, onReady };
    if (app === 'windows') await runFlutterOnPc(project, run, ctx, controller.signal);
    else await runFlutterOnMac(project, link!, { ...options, ...run, app: flutterMacApp(project, options) }, ctx, controller.signal);
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    restore();
    link?.close();
  }
}

function printFlutterKeys(): void {
  log.line(pc.dim(`  press ${pc.bold('r')} hot reload · ${pc.bold('R')} hot restart · ${pc.bold('b')} rebuild · ${pc.bold('o')} open screen · ${pc.bold('c')} clear · ${pc.bold('q')} quit`));
}

/** `capmac dev` for a Flutter app: hot reload on every save. */
export async function flutterDevCommand(project: ProjectInfo, options: FlutterCommandOptions): Promise<void> {
  const app = appFor(project, options);
  await announceApp(project, app);
  if (flutterMode(options, 'debug') !== 'debug') throw new UserError('Hot reload needs a debug build.', 'Leave out --mode, or use `capmac run --mode profile` for a profile build.');
  const { ctx, reporter } = terminalContext({ mode: 'dev', platform: 'flutter', allWarnings: options.allWarnings });
  reporter.onAppRunning = printFlutterKeys;
  const run = { ...common(options, 'debug'), watch: options.watch };
  if (app === 'windows') {
    const live = new FlutterPcLiveSession(project, run, ctx);
    await untilQuit(
      () => live.start(),
      { r: () => void live.reload(false), R: () => void live.reload(true), b: () => live.rebuild(), o: () => log.dim('The Windows app opens in its own window on this PC.') },
      () => undefined,
      () => live.stop(),
      printFlutterKeys,
    );
    return;
  }
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: true });
  const live = new FlutterLiveSession(project, link, { ...options, ...run, app: flutterMacApp(project, options) }, ctx);
  const prefer = await streamPreference(options.stream);
  let viewer: ScreenViewer | null = null;
  const openScreen = async () => {
    const target = live.target;
    if (!target) return;
    try {
      if (!viewer) {
        viewer = target.kind === 'mac'
          ? await ScreenViewer.start(link, { kind: 'app', projectId: project.projectId, label: target.name }, { title: `${project.appName} · ${target.name}`, prefer })
          : target.kind === 'simulator'
            ? await ScreenViewer.start(link, target, { title: `${project.appName} · ${target.name}`, prefer })
            : null;
        if (!viewer) {
          log.warn('The screen viewer shows simulators and the Mac app.');
          return;
        }
        const v = viewer;
        reporter.onAppLog = (entry) => v.pushLog(entry);
      }
      viewer.open();
    } catch (err) {
      reportError(err);
    }
  };
  await untilQuit(
    () => live.start(),
    { r: () => void live.reload(false), R: () => void live.reload(true), b: () => live.rebuild(), l: () => live.relaunch(), o: () => void openScreen() },
    () => {
      if (options.screen) void openScreen();
    },
    async () => {
      await live.stop();
      await (viewer as ScreenViewer | null)?.close().catch(() => undefined);
      link.close();
    },
    printFlutterKeys,
  );
}

/** `capmac build` for a Flutter app: an .ipa (or device build) of the iOS app, the Mac app, or the Windows app. */
export async function flutterBuildCommand(project: ProjectInfo, options: FlutterCommandOptions): Promise<void> {
  const app = appFor(project, options);
  const { ctx } = terminalContext({ mode: 'other', platform: 'flutter', allWarnings: options.allWarnings });
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  if (app === 'windows') {
    restore();
    throw new UserError('Build the Windows app with Flutter on this PC: `flutter build windows`.', 'CapMac runs it with `capmac run --app windows`.');
  }
  const macApp = flutterMacApp(project, options);
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: false });
  try {
    // Like a Capacitor app's `capmac build`: a simulator build, a signed device build (--device), or an .ipa (--ipa).
    const what = macApp === 'macos' ? 'macos' : options.ipa ? 'ipa' : options.device ? 'ios' : 'ios-simulator';
    const result = await buildFlutterOnMac(project, link, {
      app: macApp,
      what,
      ...common(options, what === 'ios-simulator' ? 'debug' : 'release'),
      team: options.team,
      exportMethod: options.export as 'development' | 'ad-hoc' | 'app-store' | 'enterprise' | undefined,
      outDir: options.out,
    }, ctx, controller.signal);
    if (result.kind === 'ipa') log.success(`IPA ready: ${pc.bold(result.file)}`);
    else log.success(`Built ${pc.bold(result.build.displayName ?? project.appName)}${result.build.bundleId ? pc.dim(` (${result.build.bundleId})`) : ''}\n  on the Mac: ${result.build.appPath}`);
  } finally {
    restore();
    link.close();
  }
}

/** `capmac flutter install`: Flutter on the paired Mac (default) or this PC. */
export async function flutterInstallCommand(options: { mac?: string; pc?: boolean; version?: string }): Promise<void> {
  const { ctx } = terminalContext({ mode: 'other' });
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  let project: ProjectInfo | null = null;
  try {
    project = await loadProject(process.cwd()).catch(() => null);
    const pinned = options.version ?? project?.flutter?.wantsFlutter.exact ?? undefined;
    if (options.pc) {
      const have = await localFlutter(pinned);
      if (have) {
        log.success(`Flutter ${have.version} is already on this PC ${pc.dim(`(${have.root})`)}`);
        return;
      }
      const sdk = await installFlutterOnPc(pinned, ctx, controller.signal);
      log.success(`Flutter ${sdk.version} is installed on this PC ${pc.dim(`(${sdk.root})`)}`);
      return;
    }
    const session = await MacSession.open({ host: options.mac ?? project?.config.host, signal: controller.signal });
    try {
      const found = await session.call<FlutterSdkResult>('flutter-sdk', { version: pinned });
      if (found.sdk) {
        log.success(`Flutter ${found.sdk.version} is already on ${session.label} ${pc.dim(`(${found.sdk.root})`)}`);
        return;
      }
      const version = pinned ?? (await localFlutter())?.version ?? 'stable';
      const translator = new AgentEventTranslator(ctx, 'flutter-sdk');
      const installed = await session.call<FlutterSdkResult>('flutter-sdk', { version, install: true, platforms: ['ios', 'macos'] }, { signal: controller.signal, onEvent: translator.handle });
      log.success(`Flutter ${installed.sdk?.version ?? version} is installed on ${session.label}`);
    } finally {
      session.close();
    }
  } finally {
    restore();
  }
}

export { isFlutterMode };
