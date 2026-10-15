import { loadApiKey, loadProject, MacLink, requireElectron, requireIos, runApp, runElectronApp, runsOnMac, UserError, type ProjectInfo } from '@capmac/core/engine';
import { cancelOnSigint } from '../cli-context.js';
import { terminalContext } from '../terminal.js';
import { log } from '../ui.js';

export interface RunOptions {
  mac?: string;
  target?: string;
  device?: boolean;
  simulator?: boolean;
  /** Run the Electron app on the Mac's desktop (Capacitor apps that also have iOS). */
  electron?: boolean;
  configuration?: string;
  release?: boolean;
  scheme?: string;
  team?: string;
  clean?: boolean;
  full?: boolean;
  webBuild?: boolean;
  logs?: boolean;
  /** Seconds of the app's console to show before stopping (scripts, AI agents). */
  for?: string;
  showSimulator?: boolean;
  bridge?: boolean;
  allWarnings?: boolean;
  xcodebuildArg?: string[];
  osLogs?: boolean;
  apiKey?: string;
  apiKeyId?: string;
  apiIssuer?: string;
}

/** `--for <seconds>`: how long to show the console once the app is running. */
function parseSeconds(value: string | undefined): number | undefined {
  const seconds = value === undefined ? undefined : Number(value);
  if (seconds !== undefined && !(seconds > 0)) throw new UserError('--for takes a number of seconds.', 'For example: capmac run --for 20');
  return seconds;
}

export async function runCommand(options: RunOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  if (runsOnMac(project, options)) return runOnMac(project, options);
  requireIos(project);
  const auth = options.device || options.target ? await loadApiKey(options, project) : undefined;
  const { ctx } = terminalContext({ mode: 'run', bridge: options.bridge, allWarnings: options.allWarnings, attach: options.logs !== false });
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: false });
  const seconds = parseSeconds(options.for);
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  let timer: NodeJS.Timeout | undefined;
  let timeUp = false;
  // With --for, capture the console for that long once the app is running, then stop like Ctrl+C.
  const onReady = seconds === undefined ? undefined : () => {
    timer = setTimeout(() => {
      timeUp = true;
      log.dim(`${seconds} s of console captured; stopping the app.`);
      controller.abort();
    }, seconds * 1000);
  };
  try {
    await runApp(project, link, { ...options, auth, logs: seconds !== undefined || options.logs !== false, onReady }, ctx, controller.signal);
  } catch (err) {
    if (!timeUp) throw err;
  } finally {
    clearTimeout(timer);
    restore();
    link.close();
  }
}

/** The Electron app, on the Mac's desktop: it runs until it quits or Ctrl+C (which quits it). */
async function runOnMac(project: ProjectInfo, options: RunOptions): Promise<void> {
  requireElectron(project);
  if (options.logs === false) {
    throw new UserError('An Electron app runs while CapMac is attached to it.', 'Use `capmac run --for 20` to launch it, show its console for 20 seconds, then quit it.');
  }
  const { ctx } = terminalContext({ mode: 'run', platform: 'electron', allWarnings: options.allWarnings, attach: true });
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: false });
  const seconds = parseSeconds(options.for);
  const controller = new AbortController();
  const restore = cancelOnSigint(controller, 'Quitting the app…');
  let timer: NodeJS.Timeout | undefined;
  const onReady = seconds === undefined ? undefined : () => {
    timer = setTimeout(() => {
      log.dim(`${seconds} s of console captured; quitting the app.`);
      controller.abort();
    }, seconds * 1000);
  };
  try {
    await runElectronApp(project, link, { full: options.full || options.clean, webBuild: options.webBuild, onReady }, ctx, controller.signal);
  } finally {
    clearTimeout(timer);
    restore();
    link.close();
  }
}
