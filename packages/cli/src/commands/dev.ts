import { ElectronLiveSession, LiveSession, loadApiKey, loadProject, MacLink, requireElectron, requireIos, runsOnMac, type ProjectInfo } from '@capmac/core/engine';
import { listenForKeys } from '../keys.js';
import { reportError } from '../report.js';
import { terminalContext } from '../terminal.js';
import { log, pc } from '../ui.js';
import { ScreenViewer } from '../viewer/server.js';

export interface DevOptions {
  mac?: string;
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

/** Runs until q or Ctrl+C (also while starting up), then stops the session. */
async function untilQuit(start: () => Promise<void>, keys: Record<string, () => void>, onStarted: () => void, stop: () => Promise<void>): Promise<void> {
  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => (resolveQuit = resolve));
  const stopKeys = listenForKeys({ ...keys, c: () => console.clear(), h: printKeys, '?': printKeys, q: () => resolveQuit(), 'ctrl+c': () => resolveQuit() });
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

export async function devCommand(options: DevOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  if (runsOnMac(project, options)) return devOnMac(project, options);
  requireIos(project);
  const auth = options.device || options.target ? await loadApiKey(options, project) : undefined;
  const { ctx, reporter } = terminalContext({ mode: 'dev', bridge: options.bridge, allWarnings: options.allWarnings });
  reporter.onAppRunning = printKeys;
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: true });
  const live = new LiveSession(project, link, { ...options, auth }, ctx);
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
        viewer = await ScreenViewer.start(link, target, { title: `${project.appName} · ${target.name}` });
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
  reporter.onAppRunning = printKeys;
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: true });
  const live = new ElectronLiveSession(project, link, { url: options.url, devCommand: options.devCommand, full: options.full || options.clean, watch: options.watch }, ctx);
  let viewer: ScreenViewer | null = null;
  const openScreen = async () => {
    const target = live.target;
    if (!target) return;
    try {
      if (!viewer) {
        viewer = await ScreenViewer.start(link, { kind: 'app', projectId: project.projectId, label: target.name }, { title: `${project.appName} · ${target.name}` });
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
