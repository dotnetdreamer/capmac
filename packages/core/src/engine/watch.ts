import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { classifyChange, type ChangeKind } from '../shared/classify.js';
import type { ProjectInfo } from './project.js';

const NOISE = /(^|\/)(node_modules|\.git|Pods|DerivedData|xcuserdata|build|\.build|\.gradle|\.angular|\.nx|\.turbo|\.vite|android|\.capmac)(\/|$)|\.(log|tmp|swp)$|~$/;

/** Size and modification time: what changes when a file is written (and not when it is read). */
type Stamp = string;
const MISSING = 'missing';

async function stampOf(file: string): Promise<Stamp | null> {
  try {
    const stat = await fs.stat(file);
    return stat.isDirectory() ? null : `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return MISSING;
  }
}

/** Stamps of every file that could need a native rebuild, to compare events against. */
async function takeBaseline(root: string, relevant: (rel: string) => boolean, signal: AbortSignal): Promise<Map<string, Stamp>> {
  const stamps = new Map<string, Stamp>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (signal.aborted) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (NOISE.test(childRel)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, childRel);
      else if (entry.isFile() && relevant(childRel)) {
        const stamp = await stampOf(full);
        if (stamp) stamps.set(childRel, stamp);
      }
    }
  };
  await walk(root, '');
  return stamps;
}

/**
 * Watches the project for changes that need a native rebuild (Swift/ObjC,
 * Xcode project, plugins, capacitor.config, dependencies). Web changes are
 * ignored: in live-reload mode the dev server's HMR handles them.
 *
 * Only writes count. Windows also reports last-access-time updates, so an
 * editor, a search indexer or a virus scanner merely reading the project
 * would otherwise look like a change; each event is checked against the
 * file's size and modification time.
 */
export function watchNativeChanges(project: ProjectInfo, onChange: (kinds: Set<ChangeKind>, paths: string[]) => void, debounceMs = 700): FSWatcher {
  let pending = new Map<string, ChangeKind>();
  let timer: NodeJS.Timeout | null = null;
  const ctx = { projectRel: project.projectRel, webDir: project.webDir, iosDir: project.iosDir };
  const relevantKind = (rel: string): ChangeKind | null => {
    if (NOISE.test(rel)) return null;
    const kind = classifyChange(rel, ctx);
    return kind === 'web' || kind === 'other' ? null : kind;
  };
  const started = Date.now();
  const stop = new AbortController();
  let stamps: Map<string, Stamp> | null = null;
  // Files written while the baseline was being taken (already reported).
  const early = new Map<string, Stamp>();
  void takeBaseline(project.syncRoot, (rel) => relevantKind(rel) !== null, stop.signal).then((baseline) => {
    stamps = new Map([...baseline, ...early]);
  });

  const report = (rel: string, kind: ChangeKind) => {
    pending.set(rel, kind);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = pending;
      pending = new Map();
      timer = null;
      onChange(new Set(batch.values()), [...batch.keys()]);
    }, debounceMs);
  };

  const watcher = watch(project.syncRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString().split('\\').join('/');
    const kind = relevantKind(rel);
    if (!kind) return;
    void stampOf(path.join(project.syncRoot, rel)).then((stamp) => {
      if (stamp === null || stop.signal.aborted) return;
      if (stamps) {
        const known = stamps.get(rel);
        if (known === stamp || (known === undefined && stamp === MISSING)) return;
        stamps.set(rel, stamp);
      } else {
        // Still taking the baseline: count files written (or deleted) since watching started.
        if (early.get(rel) === stamp) return;
        if (stamp !== MISSING && Number(stamp.slice(stamp.indexOf(':') + 1)) < started) return;
        early.set(rel, stamp);
      }
      report(rel, kind);
    });
  });
  watcher.on('error', () => undefined);
  watcher.on('close', () => {
    stop.abort();
    if (timer) clearTimeout(timer);
  });
  return watcher;
}
