/**
 * `capmac run`, `capmac dev` and `capmac build` for React Native apps: the
 * iOS app on a simulator or a device through the paired Mac (or built on this
 * PC with `--backend wsl`), the Mac app (react-native-macos) on the Mac's
 * desktop, the Windows app (react-native-windows) on this PC. Metro runs on
 * this PC: a save shows in the app at once (Fast Refresh).
 */
import {
  appFor,
  buildReactNativeOnMac,
  MacLink,
  reactNativeMacApp,
  ReactNativeLiveSession,
  ReactNativePcLiveSession,
  runReactNativeOnMac,
  runReactNativeOnPc,
  streamPreference,
  UserError,
  type ProjectInfo,
  type StreamPreference,
} from '@capmac/core/engine';
import { cancelOnSigint } from '../cli-context.js';
import { reportError } from '../report.js';
import { terminalContext } from '../terminal.js';
import { log, pc } from '../ui.js';
import { ScreenViewer } from '../viewer/server.js';
import { announceApp } from './apps.js';
import { untilQuit } from './dev.js';

export interface ReactNativeCommandOptions {
  mac?: string;
  app?: string;
  target?: string;
  device?: boolean;
  simulator?: boolean;
  configuration?: string;
  release?: boolean;
  scheme?: string;
  team?: string;
  clean?: boolean;
  logs?: boolean;
  for?: string;
  watch?: boolean;
  screen?: boolean;
  stream?: StreamPreference;
  showSimulator?: boolean;
  osLogs?: boolean;
  allWarnings?: boolean;
}

function seconds(value: string | undefined): number | undefined {
  const n = value === undefined ? undefined : Number(value);
  if (n !== undefined && !(n > 0)) throw new UserError('--for takes a number of seconds.', 'For example: capmac run --for 20');
  return n;
}

/** `capmac run` for a React Native app: until it quits or Ctrl+C (which closes it too). */
export async function reactNativeRunCommand(project: ProjectInfo, options: ReactNativeCommandOptions): Promise<void> {
  const app = appFor(project, options);
  await announceApp(project, app);
  const { ctx } = terminalContext({ mode: 'run', platform: 'react-native', allWarnings: options.allWarnings, attach: options.logs !== false });
  const controller = new AbortController();
  const restore = cancelOnSigint(controller, 'Stopping the app…');
  const wait = seconds(options.for);
  let timer: NodeJS.Timeout | undefined;
  let timeUp = false;
  const onReady = wait === undefined ? undefined : () => {
    timer = setTimeout(() => {
      timeUp = true;
      log.dim(`${wait} s of console captured; stopping the app.`);
      controller.abort();
    }, wait * 1000);
  };
  const link = app === 'windows' ? null : new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: false });
  try {
    const logs = wait !== undefined || options.logs !== false;
    if (app === 'windows') await runReactNativeOnPc(project, { release: options.release, logs, onReady }, ctx, controller.signal);
    else await runReactNativeOnMac(project, link!, { ...options, logs, onReady, app: reactNativeMacApp(project, options) }, ctx, controller.signal);
  } catch (err) {
    if (!timeUp && !controller.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    restore();
    link?.close();
  }
}

function printKeys(): void {
  log.line(pc.dim(`  press ${pc.bold('r')} reload · ${pc.bold('j')} DevTools · ${pc.bold('b')} rebuild · ${pc.bold('B')} clean rebuild · ${pc.bold('l')} relaunch · ${pc.bold('o')} open screen · ${pc.bold('c')} clear · ${pc.bold('q')} quit`));
}

/** `capmac dev` for a React Native app: Metro brings every save into the app (Fast Refresh); native changes rebuild it. */
export async function reactNativeDevCommand(project: ProjectInfo, options: ReactNativeCommandOptions): Promise<void> {
  const app = appFor(project, options);
  await announceApp(project, app);
  if (options.release) throw new UserError('Live mode needs a debug build (its JavaScript comes from Metro).', 'Leave out --release, or use `capmac run --release` for a release build.');
  const { ctx, reporter } = terminalContext({ mode: 'dev', platform: 'react-native', allWarnings: options.allWarnings });
  reporter.onAppRunning = printKeys;
  const devTools = async (open: () => Promise<boolean>) => {
    if (!(await open())) log.warn('React Native DevTools did not open. Is the app connected to Metro?');
  };
  if (app === 'windows') {
    const live = new ReactNativePcLiveSession(project, { watch: options.watch }, ctx);
    await untilQuit(
      () => live.start(),
      { r: () => void live.reload(), j: () => void devTools(() => live.openDevTools()), b: () => live.rebuild(), B: () => live.rebuild(), l: () => live.relaunch(), o: () => log.dim('The Windows app opens in its own window on this PC.') },
      () => undefined,
      () => live.stop(),
      printKeys,
    );
    return;
  }
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: true });
  const live = new ReactNativeLiveSession(project, link, { ...options, app: reactNativeMacApp(project, options) }, ctx);
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
    { r: () => void live.reload(), j: () => void devTools(() => live.openDevTools()), b: () => live.rebuild(), B: () => live.rebuild({ clean: true }), l: () => live.relaunch(), o: () => void openScreen() },
    () => {
      if (options.screen) void openScreen();
    },
    async () => {
      await live.stop();
      await (viewer as ScreenViewer | null)?.close().catch(() => undefined);
      link.close();
    },
    printKeys,
  );
}

/** `capmac build` for a React Native app: a simulator, device or Mac build, left on the Mac. */
export async function reactNativeBuildCommand(project: ProjectInfo, options: ReactNativeCommandOptions & { ipa?: boolean }): Promise<void> {
  const app = appFor(project, options);
  if (app === 'windows') throw new UserError('Build the Windows app with React Native on this PC: `npx react-native run-windows --release`.', 'CapMac runs it with `capmac run --app windows`.');
  if (options.ipa) throw new UserError('An .ipa of a React Native app is made on this PC: `capmac build --backend wsl`.', 'Or archive it in Xcode on the Mac.');
  const { ctx } = terminalContext({ mode: 'other', platform: 'react-native', allWarnings: options.allWarnings });
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  const macApp = reactNativeMacApp(project, options);
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: false });
  try {
    const result = await buildReactNativeOnMac(project, link, {
      app: macApp,
      what: macApp === 'macos' ? 'macos' : options.simulator ? 'simulator' : 'device',
      configuration: options.configuration,
      release: options.release,
      scheme: options.scheme,
      team: options.team,
      clean: options.clean,
      target: options.target,
    }, ctx, controller.signal);
    log.success(`Built ${pc.bold(result.displayName || project.appName)}${result.bundleId ? pc.dim(` (${result.bundleId})`) : ''}${result.skipped ? pc.dim(' · nothing native changed: the last build') : ''}\n  on the Mac: ${result.appPath}`);
  } finally {
    restore();
    link.close();
  }
}
