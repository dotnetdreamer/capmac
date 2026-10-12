import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArchiveResult, ExportKind } from '../../agent/ops/archive.js';
import { AgentCallError } from '../agent-client.js';
import { UserError } from '../errors.js';
import { announceTarget, buildWeb, Pipeline } from '../pipeline.js';
import { loadProject } from '../project.js';
import { MacSession } from '../session.js';
import { loadApiKey } from '../signing.js';
import { formatBytes, isVerbose, log, pc, withStep } from '../ui.js';
import { cancelOnSigint, requireIos } from './run.js';

export interface BuildCommandOptions {
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
  allWarnings?: boolean;
  xcodebuildArg?: string[];
  ipa?: boolean;
  export?: string;
  upload?: boolean;
  out?: string;
  apiKey?: string;
  apiKeyId?: string;
  apiIssuer?: string;
}

const EXPORT_KINDS: ExportKind[] = ['app-store', 'ad-hoc', 'development', 'enterprise'];

export async function buildCommand(options: BuildCommandOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  requireIos(project);
  const archive = Boolean(options.ipa || options.upload);
  const exportKind = (options.export ?? (options.upload ? 'app-store' : 'development')) as ExportKind;
  if (archive && !EXPORT_KINDS.includes(exportKind)) throw new UserError(`Unknown export type "${options.export}".`, `Use one of: ${EXPORT_KINDS.join(', ')}.`);
  const apiKey = await loadApiKey(options, project);

  const sessionPromise = MacSession.open({ host: options.mac ?? project.config.host });
  sessionPromise.catch(() => undefined);
  if (options.webBuild !== false) await buildWeb(project);
  const session = await sessionPromise;
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  const pipeline = new Pipeline(session, project, { allWarnings: options.allWarnings });
  try {
    await pipeline.sync(true, controller.signal);
    await pipeline.prepare(null, { full: options.full, signal: controller.signal });

    if (!archive) {
      const target = await pipeline.chooseTarget(options);
      announceTarget(target);
      const result = await pipeline.build(target, {
        configuration: options.configuration ?? (options.release ? 'Release' : undefined),
        scheme: options.scheme,
        team: options.team,
        clean: options.clean,
        force: true,
        extraArgs: options.xcodebuildArg,
        auth: apiKey,
      }, controller.signal);
      log.success(`Built ${pc.bold(result.displayName)} ${pc.dim(`(${result.bundleId})`)}`);
      log.dim(`  on the Mac: ${result.appPath}`);
      return;
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
      apiKey,
      verbose: isVerbose(),
    };
    const run = () => session.call<ArchiveResult>('archive', params, { onEvent: pipeline.renderer.handle, signal: controller.signal });
    let result: ArchiveResult;
    try {
      result = await run();
    } catch (err) {
      if (!(err instanceof AgentCallError && err.code === 'KEYCHAIN_LOCKED')) return pipeline.fail(err);
      pipeline.renderer.failOpenSteps();
      await pipeline.unlockKeychain(true);
      result = await run().catch((e) => pipeline.fail(e));
    }

    if (options.upload) {
      log.success('Uploaded to App Store Connect. It shows up in TestFlight once Apple finishes processing.');
      return;
    }
    if (!result.ipaPath) throw new UserError('The export finished but produced no .ipa.');
    const outDir = path.resolve(options.out ?? path.join(project.capDir, 'build', 'ios'));
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, path.basename(result.ipaPath));
    await withStep(`Downloading ${path.basename(result.ipaPath)} (${formatBytes(result.ipaSize)})`, async (s) => {
      const file = createWriteStream(outFile);
      let received = 0;
      try {
        await session.call('download', { projectId: project.projectId, projectRel: project.projectRel, path: result.ipaPath }, {
          signal: controller.signal,
          onBinary: (chunk) => {
            received += chunk.length;
            file.write(chunk);
            s.update(`${formatBytes(received)} of ${formatBytes(result.ipaSize)}`);
          },
        });
      } finally {
        await new Promise<void>((resolve) => file.end(resolve));
      }
    });
    log.success(`IPA ready: ${pc.bold(outFile)}`);
  } finally {
    restore();
    session.close();
  }
}
