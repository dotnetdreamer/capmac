/** Builds without launching, or archives and exports a signed .ipa (and downloads it to this PC). */
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArchiveResult, ExportKind } from '../agent/ops/archive.js';
import type { BuildResult } from '../shared/protocol.js';
import { AgentCallError } from './agent-client.js';
import { withStep, type EngineContext } from './context.js';
import { UserError } from './errors.js';
import { formatBytes } from './format.js';
import type { MacLink } from './link.js';
import { buildWeb, Pipeline, skipWebBuild, unlockKeychain, type TargetOptions } from './pipeline.js';
import { requireIos, type ProjectInfo } from './project.js';
import type { MacSession } from './session.js';
import type { ApiKey } from './signing.js';

export type { ExportKind } from '../agent/ops/archive.js';
export const EXPORT_KINDS: ExportKind[] = ['app-store', 'ad-hoc', 'development', 'enterprise'];

export interface BuildAppOptions extends TargetOptions {
  configuration?: string;
  release?: boolean;
  scheme?: string;
  team?: string;
  clean?: boolean;
  full?: boolean;
  webBuild?: boolean;
  xcodebuildArg?: string[];
  auth?: ApiKey;
  /** Archive and export an .ipa (or upload with `upload`). */
  ipa?: boolean;
  exportKind?: ExportKind;
  upload?: boolean;
  /** Where to save the .ipa (default: <project>/build/ios). */
  outDir?: string;
}

export type BuildAppResult =
  | { kind: 'app'; build: BuildResult }
  | { kind: 'ipa'; file: string; size: number }
  | { kind: 'uploaded' };

export async function buildApp(project: ProjectInfo, link: MacLink, options: BuildAppOptions, ctx: EngineContext, signal?: AbortSignal): Promise<BuildAppResult> {
  requireIos(project);
  const archive = Boolean(options.ipa || options.upload);
  const exportKind = options.exportKind ?? (options.upload ? 'app-store' : 'development');
  if (archive && !EXPORT_KINDS.includes(exportKind)) throw new UserError(`Unknown export type "${exportKind}".`, `Use one of: ${EXPORT_KINDS.join(', ')}.`);
  const sessionPromise = link.session();
  sessionPromise.catch(() => undefined);
  if (options.webBuild !== false) await buildWeb(project, ctx, signal);
  else skipWebBuild(ctx);
  const session = await sessionPromise;
  const pipeline = new Pipeline(session, project, ctx);
  await pipeline.sync(true, signal);
  await pipeline.prepare(null, { full: options.full, signal });

  if (!archive) {
    const target = await pipeline.chooseTarget(options);
    const build = await pipeline.build(target, {
      configuration: options.configuration ?? (options.release ? 'Release' : undefined),
      scheme: options.scheme,
      team: options.team,
      clean: options.clean,
      force: true,
      extraArgs: options.xcodebuildArg,
      auth: options.auth,
    }, signal);
    return { kind: 'app', build };
  }

  await pipeline.ensureKeychainUnlocked();
  const params = {
    projectId: project.projectId,
    projectRel: project.projectRel,
    iosDir: project.iosDir,
    scheme: options.scheme ?? project.config.ios?.scheme ?? project.scheme,
    configuration: options.configuration ?? 'Release',
    team: options.team ?? project.config.ios?.team ?? project.teamId,
    exportKind,
    upload: options.upload,
    apiKey: options.auth,
    verbose: ctx.verbose,
  };
  const run = () => pipeline.call<ArchiveResult>('archive', params, { signal });
  let result: ArchiveResult;
  try {
    result = await run();
  } catch (err) {
    if (!(err instanceof AgentCallError && err.code === 'KEYCHAIN_LOCKED')) return pipeline.fail(err);
    await unlockKeychain(session, ctx, true);
    result = await run().catch((e) => pipeline.fail(e));
  }
  if (options.upload) return { kind: 'uploaded' };
  if (!result.ipaPath) throw new UserError('The export finished but produced no .ipa.');
  const outDir = path.resolve(options.outDir ?? path.join(project.capDir, 'build', 'ios'));
  const file = await downloadFromMac(session, project, result.ipaPath, path.join(outDir, path.basename(result.ipaPath)), result.ipaSize, ctx, signal);
  return { kind: 'ipa', file, size: result.ipaSize };
}

/** Copies one file from the project's folder on the Mac to `localFile`. */
export async function downloadFromMac(session: MacSession, project: ProjectInfo, remotePath: string, localFile: string, size: number | null, ctx: EngineContext, signal?: AbortSignal): Promise<string> {
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await withStep(ctx, `Downloading ${path.basename(remotePath)}${size ? ` (${formatBytes(size)})` : ''}`, 'download', async (s) => {
    const file = createWriteStream(localFile);
    let received = 0;
    try {
      await session.call('download', { projectId: project.projectId, projectRel: project.projectRel, path: remotePath }, {
        signal,
        onBinary: (chunk) => {
          received += chunk.length;
          file.write(chunk);
          s.update(size ? `${formatBytes(received)} of ${formatBytes(size)}` : formatBytes(received), size ? received / size : undefined);
        },
      });
    } finally {
      await new Promise<void>((resolve) => file.end(resolve));
    }
  });
  return localFile;
}

/** Reads a text file (e.g. a build log) from the project's folder on the Mac. */
export async function readFromMac(session: MacSession, project: ProjectInfo, remotePath: string, maxBytes = 32 * 1024 * 1024, signal?: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  await session.call('download', { projectId: project.projectId, projectRel: project.projectRel, path: remotePath }, {
    signal,
    onBinary: (chunk) => {
      if (size >= maxBytes) return;
      chunks.push(chunk);
      size += chunk.length;
    },
  });
  return Buffer.concat(chunks).toString('utf8');
}
