import { SOUND_MODES, type SoundMode } from '@capmac/core/shared/electron';
import { answerAppDialog, appFor, ElectronLiveSession, LiveSession, loadApiKey, loadProject, MacLink, requireElectron, requireIos, soundFor, streamPreference, type ProjectInfo, type StreamPreference } from '@capmac/core/engine';
import { listenForKeys } from '../keys.js';
import { announceApp } from './apps.js';
import { flutterDevCommand, type FlutterCommandOptions } from './flutter.js';
import { reactNativeDevCommand } from './react-native.js';
import { reportError } from '../report.js';
import { terminalContext } from '../terminal.js';
import { log, pc } from '../ui.js';
import { ScreenViewer } from '../viewer/server.js';

export interface DevOptions {
  mac?: string;
  /** Which of the project's apps (`ios` or `electron`); default: the one picked for it. */
  app?: string;
  /** An Electron app's sound (remembered for the project). */
  sound?: SoundMode;
  /** How the screen viewer streams (remembered, CapMac Studio's too). */
  stream?: StreamPreference;
  target?: string;
  device?: boolean;
  simulator?: boolean;
  /** Live-reload the Electron app on the Mac's desktop (Capacitor apps that also have iOS). */
  electron?: boolean;
  url?: string;
  devCommand?: string;
  configuration?: string;
  scheme?: string;
  team?: string;
  full?: boolean;
  clean?: boolean;
  bridge?: boolean;
  allWarnings?: boolean;
  showSimulator?: boolean;
  screen?: boolean;
  watch?: boolean;
  osLogs?: boolean;
  apiKey?: string;
  apiKeyId?: string;
  apiIssuer?: string;
}

function printKeys(): void {
  log.line(pc.dim(`  press ${pc.bold('r')} rebuild · ${pc.bold('R')} clean rebuild · ${pc.bold('l')} relaunch · ${pc.bold('o')} open screen · ${pc.bold('c')} clear · ${pc.bold('q')} quit`));
}

function printElectronKeys(): void {
  log.line(pc.dim(`  press ${pc.bold('r')} rebuild · ${pc.bold('R')} clean rebuild · ${pc.bold('l')} relaunch · ${pc.bold('o')} open window · ${pc.bold('s')} sound · ${pc.bold('c')} clear · ${pc.bold('q')} quit`));
}

/** Runs until q or Ctrl+C (also while starting up), then stops the session. */
export async function untilQuit(start: () => Promise<void>, keys: Record<string, () => void>, onStarted: () => void, stop: () => Promise<void>, help: () => void = printKeys): Promise<void> {
  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => (resolveQuit = resolve));
  const stopKeys = listenForKeys({ ...keys, c: () => console.clear(), h: help, '?': help, q: () => resolveQuit(), 'ctrl+c': () => resolveQuit() });
  const onSigint = () => resolveQuit();
  process.on('SIGINT', onSigint);
  try {
    const started = start().then(() => true);
    if (await Promise.race([started, quit.then(() => false)])) {
      onStarted();
      await quit;
    } else {
      started.catch(() => undefined);
    }
    log.dim('Shutting down…');
  } finally {
    process.off('SIGINT', onSigint);
    stopKeys();
    await stop();
  }
}

export async function devCommand(options: DevOptions & FlutterCommandOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  if (project.kind === 'flutter') return flutterDevCommand(project, options);
  if (project.kind === 'react-native') return reactNativeDevCommand(project, options);
  const app = appFor(project, options);
  await announceApp(project, app);
  if (app === 'electron') return devOnMac(project, options);
  requireIos(project);
  const auth = options.device || options.target ? await loadApiKey(options, project) : undefined;
  const { ctx, reporter } = terminalContext({ mode: 'dev', bridge: options.bridge, allWarnings: options.allWarnings });
  reporter.onAppRunning = printKeys;
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: true });
  const live = new LiveSession(project, link, { ...options, auth }, ctx);
  const prefer = await streamPreference(options.stream);
  let viewer: ScreenViewer | null = null;
  const openScreen = async () => {
    const target = live.target;
    if (!target) return;
    if (target.kind !== 'simulator') {
      log.warn('The remote screen is available for simulators only.');
      return;
    }
    try {
      if (!viewer) {
        viewer = await ScreenViewer.start(link, target, { title: `${project.appName} · ${target.name}`, prefer });
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
    { r: () => live.rebuild(), R: () => live.rebuild({ clean: true }), l: () => live.relaunch(), o: () => void openScreen() },
    () => {
      if (options.screen) void openScreen();
    },
    async () => {
      await live.stop();
      await (viewer as ScreenViewer | null)?.close().catch(() => undefined);
      link.close();
    },
  );
}

/** Live reload of the Electron app on the Mac's desktop. */
async function devOnMac(project: ProjectInfo, options: DevOptions): Promise<void> {
  requireElectron(project);
  const { ctx, reporter } = terminalContext({ mode: 'dev', platform: 'electron', allWarnings: options.allWarnings });
  reporter.onAppRunning = printElectronKeys;
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: true });
  const live = new ElectronLiveSession(project, link, { url: options.url, devCommand: options.devCommand, full: options.full || options.clean, watch: options.watch, sound: options.sound }, ctx);
  let sound = await soundFor(project.projectId, options.sound);
  const prefer = await streamPreference(options.stream);
  const SOUND_WORDS: Record<SoundMode, string> = { off: 'off', mac: 'on the Mac', pc: 'on this PC (in the window viewer: press o)' };
  /** s: the app's sound off, on the Mac, on this PC, and round again. */
  const nextSound = () => {
    sound = SOUND_MODES[(SOUND_MODES.indexOf(sound) + 1) % SOUND_MODES.length]!;
    log.info(`Sound: ${SOUND_WORDS[sound]}`);
    live.setSound(sound).catch((err: Error) => log.warn(`Could not change the sound: ${err.message}`));
  };
  // The app's dialogs stay off the Mac's screen: answered here or in the viewer.
  reporter.onDialogAnswer = async (dialog, answer) => answerAppDialog(await link.session(), project.projectId, dialog.id, answer);
  let viewer: ScreenViewer | null = null;
  const openScreen = async () => {
    const target = live.target;
    if (!target) return;
    try {
      if (!viewer) {
        viewer = await ScreenViewer.start(link, { kind: 'app', projectId: project.projectId, label: target.name }, { title: `${project.appName} · ${target.name}`, prefer });
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
    { r: () => live.rebuild(), R: () => live.rebuild({ clean: true }), l: () => live.relaunch(), o: () => void openScreen(), s: nextSound },
    () => {
      if (options.screen) void openScreen();
    },
    async () => {
      await live.stop();
      await (viewer as ScreenViewer | null)?.close().catch(() => undefined);
      link.close();
    },
  );
}
