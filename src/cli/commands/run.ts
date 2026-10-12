import { UserError } from '../errors.js';
import { announceTarget, buildWeb, Pipeline } from '../pipeline.js';
import { loadProject, type ProjectInfo } from '../project.js';
import { MacSession } from '../session.js';
import { loadApiKey } from '../signing.js';
import { log, pc } from '../ui.js';

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

export function requireIos(project: ProjectInfo): void {
  if (!project.hasIos) {
    throw new UserError(`This app has no iOS platform yet (${project.iosDir}/App is missing).`, 'Add it with `npx cap add ios` (or `npx cap add ios --packagemanager SPM`), then run again.');
  }
}

/** Installs a Ctrl+C handler: first press cancels gracefully, second exits. */
export function cancelOnSigint(controller: AbortController, message = 'Stopping…'): () => void {
  let presses = 0;
  const handler = () => {
    presses += 1;
    if (presses === 1) {
      log.line();
      log.dim(message);
      controller.abort();
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}

export async function runCommand(options: RunOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  requireIos(project);
  const auth = options.device || options.target ? await loadApiKey(options, project) : undefined;
  const sessionPromise = MacSession.open({ host: options.mac ?? project.config.host });
  sessionPromise.catch(() => undefined);
  if (options.webBuild !== false) await buildWeb(project);
  const session = await sessionPromise;
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  const pipeline = new Pipeline(session, project, { bridge: options.bridge, allWarnings: options.allWarnings });
  try {
    await pipeline.sync(true, controller.signal);
    await pipeline.prepare(null, { full: options.full, signal: controller.signal });
    const target = await pipeline.chooseTarget(options);
    announceTarget(target);
    const build = await pipeline.build(target, {
      configuration: options.configuration ?? (options.release ? 'Release' : undefined),
      scheme: options.scheme,
      team: options.team,
      clean: options.clean,
      force: options.clean,
      extraArgs: options.xcodebuildArg,
      auth,
    }, controller.signal);
    if (build.skipped) log.dim('  Native code unchanged: reused the previous build.');
    const attach = options.logs !== false;
    const result = await pipeline.deploy(target, build, {
      attach,
      showSimulator: options.showSimulator,
      osLogs: options.osLogs,
      signal: controller.signal,
      onReady: () => {
        log.success(`${pc.bold(build.displayName)} is running on ${target.name}${attach ? pc.dim('  (app logs below · Ctrl+C to stop)') : ''}`);
      },
    });
    if (result.reason === 'exited') log.info(`The app exited${result.exitCode !== null ? ` (code ${result.exitCode})` : ''}.`);
    if (result.reason === 'cancelled') log.dim('Stopped.');
  } finally {
    restore();
    session.close();
  }
}
