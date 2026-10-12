import { loadApiKey, loadProject, MacLink, requireIos, runApp, UserError } from '@capmac/core/engine';
import { cancelOnSigint } from '../cli-context.js';
import { terminalContext } from '../terminal.js';
import { log } from '../ui.js';

export interface RunOptions {
  mac?: string;
  target?: string;
  device?: boolean;
  simulator?: boolean;
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

export async function runCommand(options: RunOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  requireIos(project);
  const auth = options.device || options.target ? await loadApiKey(options, project) : undefined;
  const { ctx } = terminalContext({ mode: 'run', bridge: options.bridge, allWarnings: options.allWarnings, attach: options.logs !== false });
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: false });
  const seconds = options.for === undefined ? undefined : Number(options.for);
  if (seconds !== undefined && !(seconds > 0)) throw new UserError('--for takes a number of seconds.', 'For example: capmac run --for 20');
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
