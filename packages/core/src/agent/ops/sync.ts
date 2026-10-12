import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unpackArchive } from '../../shared/archive.js';
import type { ManifestEntry, ProjectRef, SyncResult } from '../../shared/protocol.js';
import type { AgentIO } from '../io.js';
import { AgentError } from '../proc.js';
import { loadState, projectPaths, saveState, withProjectLock, type FileRecord } from '../state.js';

async function removeAndPrune(root: string, rel: string): Promise<void> {
  const target = path.join(root, ...rel.split('/'));
  await fs.rm(target, { force: true });
  // Drop directories that became empty, but never the root itself.
  let dir = path.dirname(target);
  while (dir.length > root.length && dir.startsWith(root)) {
    try {
      await fs.rmdir(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Mirrors the client's project into ~/.capmac/projects/<id>/src.
 *
 * 1. client -> { t: 'manifest', entries }
 * 2. agent  -> { t: 'need', need, remove }
 * 3. client -> binary archive frames, then { t: 'archive-end' }
 * 4. agent  -> result
 */
export async function opSync(params: ProjectRef, io: AgentIO): Promise<SyncResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  return withProjectLock(paths, io, async () => {
    const state = await loadState(paths);
    const message = await io.nextJson<{ t: 'manifest'; entries: ManifestEntry[] }>('manifest');
    const entries = message.entries ?? [];
    const incoming = new Map(entries.map((e) => [e.p, e]));

    const need: string[] = [];
    await Promise.all(
      entries.map(async (entry) => {
        const record = state.manifest[entry.p];
        if (!record || record.h !== entry.h || record.m !== entry.m) {
          need.push(entry.p);
          return;
        }
        // Still there with the size we wrote? (Someone may have cleaned the folder on the Mac.)
        const st = await fs.lstat(path.join(paths.src, ...entry.p.split('/'))).catch(() => null);
        if (!st || !st.isFile() || st.size !== record.s) need.push(entry.p);
      }),
    );
    const remove = Object.keys(state.manifest).filter((p) => !incoming.has(p));
    need.sort();
    io.send({ t: 'need', need, remove });

    const written = new Map<string, number>();
    let bytes = 0;
    if (need.length > 0) {
      const result = await unpackArchive(io.binaryUntil('archive-end'), {
        root: paths.src,
        onFile: (rel, size) => written.set(rel, size),
      });
      bytes = result.bytes;
    } else {
      await io.nextJson('archive-end');
    }

    const wanted = new Set(need);
    for (const rel of written.keys()) {
      if (!wanted.has(rel)) throw new AgentError(`Client sent a file that was not requested: ${rel}`, 'BAD_REQUEST');
    }
    const missing = need.filter((rel) => !written.has(rel));

    for (const rel of remove) {
      await removeAndPrune(paths.src, rel);
      delete state.manifest[rel];
    }
    for (const [rel, size] of written) {
      const entry = incoming.get(rel)!;
      state.manifest[rel] = { h: entry.h, m: entry.m, s: size } satisfies FileRecord;
    }
    // Files the client could not read (deleted mid-sync) stay "needed" next time.
    for (const rel of missing) delete state.manifest[rel];

    const changed = [...written.keys(), ...remove];
    if (!state.pendingFull) state.pendingChanges.push(...changed);
    await saveState(paths, state);

    return {
      remoteRoot: paths.src,
      remoteProject: paths.project,
      uploaded: written.size,
      bytes,
      removed: remove.length,
      changed,
    };
  });
}
