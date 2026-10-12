import { create } from 'zustand';
import type { ErrorInfo, ProjectSummary } from '../../shared/contract';
import { call, errorInfo } from './engine';

/** Windows paths are case-insensitive: one key per project folder. */
export const projectKey = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

export interface ProjectEntry {
  summary: ProjectSummary | null;
  icon: string | null;
  size: { files: number; bytes: number } | null;
  loading: boolean;
  error: ErrorInfo | null;
}

interface ProjectsState {
  byKey: Record<string, ProjectEntry>;
  inspect(path: string, force?: boolean): Promise<ProjectSummary | null>;
  loadSize(path: string): Promise<void>;
}

const empty: ProjectEntry = { summary: null, icon: null, size: null, loading: false, error: null };
const inflight = new Map<string, Promise<ProjectSummary | null>>();

export const useProjects = create<ProjectsState>((set, get) => ({
  byKey: {},
  inspect: (path, force = false) => {
    const key = projectKey(path);
    const existing = get().byKey[key];
    if (existing?.summary && !force) return Promise.resolve(existing.summary);
    const running = inflight.get(key);
    if (running) return running;
    const patch = (p: Partial<ProjectEntry>) => set((s) => ({ byKey: { ...s.byKey, [key]: { ...(s.byKey[key] ?? empty), ...p } } }));
    patch({ loading: true, error: null });
    const promise = (async () => {
      try {
        const summary = await call('projects.inspect', { path });
        const icon = summary.iconPath ? await window.capmac.invoke('app:project-icon', { path: summary.iconPath }).catch(() => null) : null;
        patch({ summary, icon, loading: false, error: null });
        return summary;
      } catch (err) {
        patch({ loading: false, error: errorInfo(err) });
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  },
  loadSize: async (path) => {
    const key = projectKey(path);
    try {
      const size = await call('projects.syncSize', { path });
      set((s) => ({ byKey: { ...s.byKey, [key]: { ...(s.byKey[key] ?? empty), size } } }));
    } catch {
      // sizes are a nicety
    }
  },
}));

export function useProject(path: string | null): ProjectEntry {
  return useProjects((s) => (path ? s.byKey[projectKey(path)] ?? empty : empty));
}
