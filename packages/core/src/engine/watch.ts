import { watch, type FSWatcher } from 'node:fs';
import { classifyChange, type ChangeKind } from '../shared/classify.js';
import type { ProjectInfo } from './project.js';

const NOISE = /(^|\/)(node_modules|\.git|Pods|DerivedData|xcuserdata|build|\.build|\.gradle|\.angular|\.nx|\.turbo|\.vite|android|\.capmac)(\/|$)|\.(log|tmp|swp)$|~$/;

/**
 * Watches the project for changes that need a native rebuild (Swift/ObjC,
 * Xcode project, plugins, capacitor.config, dependencies). Web changes are
 * ignored: in live-reload mode the dev server's HMR handles them.
 */
export function watchNativeChanges(project: ProjectInfo, onChange: (kinds: Set<ChangeKind>, paths: string[]) => void, debounceMs = 700): FSWatcher {
  let pending = new Map<string, ChangeKind>();
  let timer: NodeJS.Timeout | null = null;
  const ctx = { projectRel: project.projectRel, webDir: project.webDir, iosDir: project.iosDir };
  const watcher = watch(project.syncRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString().split('\\').join('/');
    if (NOISE.test(rel)) return;
    const kind = classifyChange(rel, ctx);
    if (kind === 'web' || kind === 'other') return;
    pending.set(rel, kind);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = pending;
      pending = new Map();
      timer = null;
      onChange(new Set(batch.values()), [...batch.keys()]);
    }, debounceMs);
  });
  watcher.on('error', () => undefined);
  return watcher;
}
