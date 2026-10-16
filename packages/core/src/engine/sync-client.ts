import path from 'node:path';
import { packArchive } from '../shared/archive.js';
import type { SyncNeed, SyncResult } from '../shared/protocol.js';
import { capmacDir } from './config.js';
import { log, startStep, type EngineContext } from './context.js';
import { isCancelled } from './errors.js';
import { formatBytes, plural } from './format.js';
import { readPackageJson } from './electron-project.js';
import type { ProjectInfo } from './project.js';
import { scanProject, type ScanOptions } from './scan.js';
import type { MacSession } from './session.js';

export interface SyncOptions {
  /** Upload the built web assets (false in live-reload mode). */
  includeWebDir: boolean;
  signal?: AbortSignal;
}

export interface SyncSummary extends SyncResult {
  files: number;
  totalBytes: number;
}

/** Where a project's hash cache lives on this PC. */
export function scanCacheFile(project: ProjectInfo): string {
  return path.join(capmacDir(), 'cache', `${project.projectId}.json`);
}

/**
 * Capacitor projects: the folders a build on the Mac reads (this PC builds
 * the web app): the web assets, the native platforms, local dependencies.
 * Undefined for an Electron app, which runs from its sources.
 */
export function macBuildRoots(project: ProjectInfo): string[] | undefined {
  if (project.kind !== 'capacitor') return undefined;
  const toRoot = (abs: string) => path.relative(project.syncRoot, abs).split(path.sep).join('/');
  const roots = [project.webDir, project.iosDir, project.electron?.rel ?? '']
    .filter((rel) => rel && rel !== '.')
    .map((rel) => toRoot(path.resolve(project.capDir, rel)));
  // file: and link: dependencies install from their own folders.
  for (const dir of new Set([project.syncRoot, project.capDir, project.electron?.dir].filter((d): d is string => Boolean(d)))) {
    const pkg = readPackageJson(dir);
    for (const spec of Object.values({ ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.optionalDependencies })) {
      const local = /^(?:file|link):(.+)$/.exec(String(spec))?.[1];
      if (local) roots.push(toRoot(path.resolve(dir, local)));
    }
  }
  // A root that is the whole project (webDir ".") leaves nothing out.
  if (roots.some((rel) => rel === '')) return undefined;
  return roots.filter((rel) => !rel.startsWith('..'));
}

/** What a sync of `project` uploads (the same for iOS and Electron runs, so switching never re-uploads). */
export function scanOptionsFor(project: ProjectInfo, includeWebDir: boolean): ScanOptions {
  return {
    root: project.syncRoot,
    projectRel: project.projectRel,
    webDir: project.webDir,
    iosDir: project.iosDir,
    includeWebDir: includeWebDir && Boolean(project.webDir),
    // An electron/ folder is Capacitor's Electron platform (synced when present), or part of an Electron app.
    excludeElectron: project.kind === 'capacitor' && !project.electron,
    flutter: project.kind === 'flutter',
    include: project.config.sync?.include,
    exclude: project.config.sync?.exclude,
    macBuildsFrom: macBuildRoots(project),
    cacheFile: scanCacheFile(project),
  };
}

/** The biggest folders among `files`, by their first two path parts ("promo/out"). */
export function largestFolders(files: Array<{ rel: string; size: number }>, count = 3): Array<{ folder: string; files: number; bytes: number }> {
  const folders = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    const parts = file.rel.split('/');
    const folder = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0]! : '.';
    const entry = folders.get(folder) ?? { files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += file.size;
    folders.set(folder, entry);
  }
  return [...folders.entries()].map(([folder, v]) => ({ folder, ...v })).sort((a, b) => b.bytes - a.bytes).slice(0, count);
}

const reportedLeftOnPc = new Set<string>();

/** Says once per project which files stay on this PC (every sync leaves the same ones out). */
function reportLeftOnPc(project: ProjectInfo, files: Array<{ rel: string; size: number }>, ctx: EngineContext): void {
  if (files.length === 0) return;
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  const where = largestFolders(files).map((f) => f.folder).join(', ');
  const key = `${project.projectId}:${files.length}:${bytes}`;
  const first = !reportedLeftOnPc.has(key);
  reportedLeftOnPc.add(key);
  log(
    ctx,
    first ? 'info' : 'debug',
    `Kept ${plural(files.length, 'video, design or large file', 'videos, design and large files')} (${formatBytes(bytes)}) on this PC: nothing on the Mac reads them (${where})`,
    first ? 'To send one anyway, add a `!path` line to .capmacignore' : undefined,
  );
}

export async function syncToMac(session: MacSession, project: ProjectInfo, options: SyncOptions, ctx: EngineContext): Promise<SyncSummary> {
  const s = startStep(ctx, `Syncing ${project.appName} to ${session.label}`, 'sync');
  try {
    const scan = await scanProject(scanOptionsFor(project, options.includeWebDir));
    s.update(`${plural(scan.files.length, 'file')} scanned`);
    reportLeftOnPc(project, scan.leftOnPc, ctx);
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
            s.update(`uploading ${sentFiles}/${toSend.length} · ${formatBytes(sentBytes)} of ${formatBytes(totalBytes)}`, totalBytes ? sentBytes / totalBytes : undefined);
          },
          onSkip: (rel) => log(ctx, 'debug', `skipped ${rel} (changed while syncing)`),
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
    return { ...result, files: scan.files.length, totalBytes };
  } catch (err) {
    if (isCancelled(err)) s.cancel();
    else s.fail();
    throw err;
  }
}
