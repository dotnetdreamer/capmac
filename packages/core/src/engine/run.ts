import type { DeployResult } from '../shared/protocol.js';
import type { EngineContext } from './context.js';
import type { MacLink } from './link.js';
import { buildWeb, Pipeline, skipWebBuild, type TargetOptions } from './pipeline.js';
import { requireIos, type ProjectInfo } from './project.js';
import type { MacSession } from './session.js';
import type { ApiKey } from './signing.js';
import type { SyncSummary } from './sync-client.js';

export interface RunAppOptions extends TargetOptions {
  configuration?: string;
  release?: boolean;
  scheme?: string;
  team?: string;
  clean?: boolean;
  full?: boolean;
  /** Build the web app first (default true). */
  webBuild?: boolean;
  /** Stream the app's output until it exits (default true). */
  logs?: boolean;
  showSimulator?: boolean;
  osLogs?: boolean;
  xcodebuildArg?: string[];
  auth?: ApiKey;
  /** Called once the app is running (before its first log line). */
  onReady?: () => void;
}

/**
 * Web build → sync → prepare → choose target → build → install and launch.
 * Resolves when the app exits, or when `signal` aborts (which stops it).
 */
export async function runApp(project: ProjectInfo, link: MacLink, options: RunAppOptions, ctx: EngineContext, signal: AbortSignal): Promise<DeployResult> {
  requireIos(project);
  // Connect while the web build runs.
  const sessionPromise = link.session();
  sessionPromise.catch(() => undefined);
  if (options.webBuild !== false) await buildWeb(project, ctx, signal);
  else skipWebBuild(ctx);
  const session = await sessionPromise;
  const pipeline = new Pipeline(session, project, ctx);
  await pipeline.sync(true, signal);
  await pipeline.prepare(null, { full: options.full, signal });
  const target = await pipeline.chooseTarget(options);
  const build = await pipeline.build(target, {
    configuration: options.configuration ?? (options.release ? 'Release' : undefined),
    scheme: options.scheme,
    team: options.team,
    clean: options.clean,
    force: options.clean,
    extraArgs: options.xcodebuildArg,
    auth: options.auth,
  }, signal);
  return pipeline.deploy(target, build, {
    attach: options.logs !== false,
    showSimulator: options.showSimulator,
    osLogs: options.osLogs,
    signal,
    onReady: options.onReady,
  });
}

export interface SyncAppOptions {
  /** Leave out the web build output (live reload serves it). */
  live?: boolean;
  /** Reinstall dependencies on the Mac and run a full `cap sync`. */
  full?: boolean;
  /** Bring the Mac's iOS project up to date after copying (default true); false only copies files. */
  prepare?: boolean;
}

/**
 * `capmac sync` and Studio's Sync: copies the project to the Mac, then installs
 * dependencies and runs `cap sync` (or `cap copy`) there as needed, like
 * `npx cap sync ios`. Builds and launches nothing; the web build is not run.
 */
export async function syncApp(project: ProjectInfo, session: MacSession, options: SyncAppOptions, ctx: EngineContext, signal?: AbortSignal): Promise<SyncSummary> {
  const pipeline = new Pipeline(session, project, ctx);
  const summary = await pipeline.sync(!options.live, signal);
  if (options.prepare !== false && project.hasIos) await pipeline.prepare(null, { full: options.full, signal });
  return summary;
}
