import { loadApiKey, loadProject, MacLink, requireIos, runApp } from '@capmac/core/engine';
import { cancelOnSigint } from '../cli-context.js';
import { terminalContext } from '../terminal.js';

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
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  try {
    await runApp(project, link, { ...options, auth }, ctx, controller.signal);
  } finally {
    restore();
    link.close();
  }
}
