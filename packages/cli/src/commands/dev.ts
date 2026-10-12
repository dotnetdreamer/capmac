import { LiveSession, loadApiKey, loadProject, MacLink, requireIos } from '@capmac/core/engine';
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

export async function devCommand(options: DevOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  requireIos(project);
  const auth = options.device || options.target ? await loadApiKey(options, project) : undefined;
  const { ctx, reporter } = terminalContext({ mode: 'dev', bridge: options.bridge, allWarnings: options.allWarnings });
  reporter.onAppRunning = printKeys;
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: true });
  const live = new LiveSession(project, link, { ...options, auth }, ctx);
  let viewer: ScreenViewer | null = null;

  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => (resolveQuit = resolve));
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
  const stopKeys = listenForKeys({
    r: () => live.rebuild(),
    R: () => live.rebuild({ clean: true }),
    l: () => live.relaunch(),
    o: () => void openScreen(),
    c: () => console.clear(),
    h: printKeys,
    '?': printKeys,
    q: () => resolveQuit(),
    'ctrl+c': () => resolveQuit(),
  });
  const onSigint = () => resolveQuit();
  process.on('SIGINT', onSigint);

  try {
    // Ctrl+C or q while starting up stops everything too.
    const started = live.start().then(() => true);
    if (await Promise.race([started, quit.then(() => false)])) {
      if (options.screen) void openScreen();
      await quit;
    } else {
      started.catch(() => undefined);
    }
    log.dim('Shutting down…');
  } finally {
    process.off('SIGINT', onSigint);
    stopKeys();
    await live.stop();
    await (viewer as ScreenViewer | null)?.close().catch(() => undefined);
    link.close();
  }
}
