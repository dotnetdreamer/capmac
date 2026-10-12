import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectRef } from '../../shared/protocol.js';
import { hintForBuildOutput, XcodeOutputParser } from '../../shared/xcode-output.js';
import { toolEnv, xcodeEnv } from '../env.js';
import { locateIosProject } from '../ios-project.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, run, tryCapture } from '../proc.js';
import { projectPaths, withProjectLock } from '../state.js';

export type ExportKind = 'app-store' | 'ad-hoc' | 'development' | 'enterprise';

export interface ArchiveParams extends ProjectRef {
  iosDir?: string;
  scheme?: string;
  configuration?: string;
  team?: string;
  exportKind: ExportKind;
  upload?: boolean;
  /** App Store Connect API key (.p8 contents) for uploads without an Xcode account. */
  apiKey?: { keyId: string; issuerId: string; p8: string };
  verbose?: boolean;
}

export interface ArchiveResult {
  ipaPath: string | null;
  ipaSize: number;
  uploaded: boolean;
  archivePath: string;
}

function plistValue(value: string | boolean): string {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  return `<string>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`;
}

export function exportOptionsPlist(options: Record<string, string | boolean>): string {
  const body = Object.entries(options).map(([k, v]) => `\t<key>${k}</key>\n\t${plistValue(v)}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

/** Xcode 15.3 renamed the export methods; older Xcodes only know the old names. */
export function exportMethod(kind: ExportKind, xcodeVersion: string): string {
  const [major = 0, minor = 0] = xcodeVersion.split('.').map(Number);
  const modern = major > 15 || (major === 15 && minor >= 3);
  const names: Record<ExportKind, [string, string]> = {
    'app-store': ['app-store-connect', 'app-store'],
    'ad-hoc': ['release-testing', 'ad-hoc'],
    development: ['debugging', 'development'],
    enterprise: ['enterprise', 'enterprise'],
  };
  return names[kind][modern ? 0 : 1];
}

async function xcodebuildStep(io: AgentIO, id: string, title: string, args: string[], cwd: string, logFile: string, ownRoot: string, verbose?: boolean): Promise<void> {
  const parser = new XcodeOutputParser({ ownRoot });
  const out = createWriteStream(logFile, { flags: 'a' });
  out.write(`$ xcodebuild ${args.join(' ')}\n\n`);
  let last = 0;
  try {
    await step(io, id, title, async () => {
      const r = await run('xcodebuild', args, {
        cwd,
        env: await xcodeEnv(),
        signal: io.signal,
        capture: false,
        tailLines: 80,
        onLine: (line) => {
          out.write(`${line}\n`);
          if (verbose) io.send({ t: 'out', stream: 'stdout', text: line });
          for (const ev of parser.push(line)) {
            if (ev.kind === 'diag') io.send({ t: 'diag', ...ev.diag });
            else if (Date.now() - last > 120) {
              last = Date.now();
              io.send({ t: 'progress', text: ev.text, done: ev.done });
            }
          }
        },
      });
      for (const ev of parser.end()) if (ev.kind === 'diag') io.send({ t: 'diag', ...ev.diag });
      if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
      if (r.code !== 0) {
        const hint = hintForBuildOutput(r.tail.join('\n'));
        throw new AgentError(`${title} failed`, hint?.code ?? 'BUILD_FAILED', hint?.hint, r.tail.filter((l) => l.trim()).slice(-25), logFile);
      }
    });
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
}

export async function opArchive(params: ArchiveParams, io: AgentIO): Promise<ArchiveResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  return withProjectLock(paths, io, async () => {
    const env = await toolEnv();
    const ios = await locateIosProject(paths.project, params.iosDir ?? 'ios');
    const scheme = params.scheme || 'App';
    const configuration = params.configuration || 'Release';
    const workDir = path.join(paths.base, 'archive');
    const archivePath = path.join(workDir, `${scheme}.xcarchive`);
    const exportPath = path.join(workDir, 'export');
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(paths.logs, { recursive: true });
    const logFile = path.join(paths.logs, `archive-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

    let keyFile: string | null = null;
    const authArgs: string[] = [];
    if (params.apiKey) {
      keyFile = path.join(os.tmpdir(), `capmac-AuthKey_${params.apiKey.keyId}-${process.pid}.p8`);
      await fs.writeFile(keyFile, params.apiKey.p8, { mode: 0o600 });
      authArgs.push('-authenticationKeyPath', keyFile, '-authenticationKeyID', params.apiKey.keyId, '-authenticationKeyIssuerID', params.apiKey.issuerId);
    }
    try {
      await xcodebuildStep(io, 'archive', `Archiving ${scheme} (${configuration})`, [
        ...(ios.workspace ? ['-workspace', ios.workspace] : ['-project', ios.xcodeproj]),
        '-scheme', scheme,
        '-configuration', configuration,
        '-destination', 'generic/platform=iOS',
        '-archivePath', archivePath,
        '-derivedDataPath', paths.derivedData,
        '-skipPackagePluginValidation',
        '-skipMacroValidation',
        '-allowProvisioningUpdates',
        ...authArgs,
        ...(params.team ? [`DEVELOPMENT_TEAM=${params.team}`] : []),
        'archive',
      ], ios.nativeProjectDir, logFile, paths.src, params.verbose);

      const xcodeVersion = (await tryCapture('xcodebuild', ['-version'], { env }))?.match(/Xcode\s+([\d.]+)/)?.[1] ?? '16.0';
      const options: Record<string, string | boolean> = {
        method: exportMethod(params.exportKind, xcodeVersion),
        signingStyle: 'automatic',
        destination: params.upload ? 'upload' : 'export',
        stripSwiftSymbols: true,
        uploadSymbols: true,
      };
      if (params.team) options.teamID = params.team;
      const plistPath = path.join(workDir, 'ExportOptions.plist');
      await fs.writeFile(plistPath, exportOptionsPlist(options));

      await xcodebuildStep(io, 'export', params.upload ? 'Uploading to App Store Connect' : `Exporting the .ipa (${params.exportKind})`, [
        '-exportArchive',
        '-archivePath', archivePath,
        '-exportPath', exportPath,
        '-exportOptionsPlist', plistPath,
        '-allowProvisioningUpdates',
        ...authArgs,
      ], workDir, logFile, paths.src, params.verbose);
    } finally {
      if (keyFile) await fs.rm(keyFile, { force: true }).catch(() => undefined);
    }

    const files = await fs.readdir(exportPath).catch(() => [] as string[]);
    const ipa = files.find((f) => f.endsWith('.ipa'));
    const ipaPath = ipa ? path.join(exportPath, ipa) : null;
    const ipaSize = ipaPath ? (await fs.stat(ipaPath)).size : 0;
    return { ipaPath, ipaSize, uploaded: Boolean(params.upload), archivePath };
  });
}

/** Streams one file from the project's folder on the Mac back to the client. */
export async function opDownload(params: ProjectRef & { path: string }, io: AgentIO): Promise<{ bytes: number }> {
  const paths = projectPaths(params.projectId, params.projectRel);
  const resolved = path.resolve(params.path);
  if (!resolved.startsWith(`${paths.base}${path.sep}`)) throw new AgentError('Only files inside the project folder can be downloaded.', 'BAD_REQUEST');
  const st = await fs.stat(resolved);
  io.send({ t: 'archive-begin', files: 1 });
  let bytes = 0;
  for await (const chunk of createReadStream(resolved, { highWaterMark: 256 * 1024 })) {
    if (io.signal.aborted) throw new AgentError('Cancelled', 'CANCELLED');
    bytes += (chunk as Buffer).length;
    await io.sendBinary(chunk as Buffer);
  }
  io.send({ t: 'archive-end' });
  if (bytes !== st.size) throw new AgentError('The file changed while it was being sent.');
  return { bytes };
}
