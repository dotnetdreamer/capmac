import path from 'node:path';
import { packArchive } from '../shared/archive.js';
import type { SyncNeed, SyncResult } from '../shared/protocol.js';
import { capmacDir } from './config.js';
import type { ProjectInfo } from './project.js';
import { scanProject } from './scan.js';
import type { MacSession } from './session.js';
import { formatBytes, log, plural, step } from './ui.js';

export interface SyncOptions {
  /** Upload the built web assets (false in live-reload mode). */
  includeWebDir: boolean;
  signal?: AbortSignal;
}

export interface SyncSummary extends SyncResult {
  files: number;
}

export async function syncToMac(session: MacSession, project: ProjectInfo, options: SyncOptions): Promise<SyncSummary> {
  const s = step(`Syncing ${project.appName} to ${session.label}`);
  try {
    const scan = await scanProject({
      root: project.syncRoot,
      projectRel: project.projectRel,
      webDir: project.webDir,
      iosDir: project.iosDir,
      includeWebDir: options.includeWebDir,
      include: project.config.sync?.include,
      exclude: project.config.sync?.exclude,
      cacheFile: path.join(capmacDir(), 'cache', `${project.projectId}.json`),
    });
    s.update(`${plural(scan.files.length, 'file')} scanned`);
    const call = await session.agent.start<SyncResult>('sync', { projectId: project.projectId, projectRel: project.projectRel }, { signal: options.signal });
    call.send({ t: 'manifest', entries: scan.files.map((f) => ({ p: f.rel, h: f.hash, s: f.size, m: f.mode })) });
    const need = await call.waitFor<SyncNeed>('need');
    const byRel = new Map(scan.files.map((f) => [f.rel, f]));
    const toSend = need.need.map((rel) => byRel.get(rel)).filter((f): f is NonNullable<typeof f> => Boolean(f));
    const totalBytes = toSend.reduce((sum, f) => sum + f.size, 0);
    let sentFiles = 0;
    let sentBytes = 0;
    if (toSend.length > 0) {
      const archive = packArchive(
        toSend.map((f) => ({ rel: f.rel, abs: f.abs, mode: f.mode, toLf: f.toLf })),
        {
          onFile: (_rel, bytes) => {
            sentFiles += 1;
            sentBytes += bytes;
            s.update(`uploading ${sentFiles}/${toSend.length} · ${formatBytes(sentBytes)} of ${formatBytes(totalBytes)}`);
          },
          onSkip: (rel) => log.debug(`skipped ${rel} (changed while syncing)`),
        },
      );
      for await (const chunk of archive) await call.sendBinary(chunk);
    }
    call.send({ t: 'archive-end' });
    const result = await call.result;
    const parts: string[] = [];
    if (result.uploaded) parts.push(`${plural(result.uploaded, 'file')} uploaded (${formatBytes(totalBytes)})`);
    if (result.removed) parts.push(`${plural(result.removed, 'file')} removed`);
    s.succeed(parts.length ? parts.join(', ') : `up to date (${plural(scan.files.length, 'file')})`);
    return { ...result, files: scan.files.length };
  } catch (err) {
    s.fail();
    throw err;
  }
}
