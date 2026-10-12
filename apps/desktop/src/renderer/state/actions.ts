/** What the UI (buttons, palette, tray, shortcuts) can do. */
import type { ErrorInfo } from '../../shared/contract';
import { toast, useApp, useToasts } from './app';
import { call, errorInfo } from './engine';
import { resolveMac, useMacs } from './macs';
import { projectKey, useProjects } from './projects';
import { emptyRun, isActive, useRuns } from './runs';

export function projectPrefs(path: string): { mac?: string; target?: string } {
  return useApp.getState().settings?.projectPrefs[projectKey(path)] ?? {};
}

export function setProjectPrefs(path: string, patch: { mac?: string; target?: string }): void {
  const s = useApp.getState().settings;
  if (!s) return;
  const key = projectKey(path);
  void useApp.getState().updateSettings({ projectPrefs: { ...s.projectPrefs, [key]: { ...s.projectPrefs[key], ...patch } } });
}

/** The Mac a project builds on (toolbar pick, then capmac.json, then the default Mac). */
export function macFor(path: string): string | null {
  const summary = useProjects.getState().byKey[projectKey(path)]?.summary;
  return resolveMac(useMacs.getState().macs, projectPrefs(path).mac ?? summary?.host)?.name ?? null;
}

function failStart(path: string, error: ErrorInfo): void {
  const key = projectKey(path);
  const run = useRuns.getState().byKey[key] ?? emptyRun(path);
  useRuns.setState((s) => ({ byKey: { ...s.byKey, [key]: { ...run, status: 'failed', error, sessionId: null, endedAt: Date.now() } } }));
}

/** Adds a folder as a project (validates it is a Capacitor app) and opens it. */
export async function openProject(path: string): Promise<boolean> {
  const summary = await useProjects.getState().inspect(path, true);
  if (!summary) {
    const error = useProjects.getState().byKey[projectKey(path)]?.error;
    toast({ tone: 'critical', title: 'That folder is not a Capacitor app', body: error?.hint ? `${error.message} ${error.hint}` : error?.message ?? 'No capacitor.config.* found in it or its parents.' });
    return false;
  }
  await window.capmac.invoke('app:project-opened', { path: summary.path, name: summary.appName, appId: summary.appId });
  useApp.getState().navigate({ name: 'project', path: summary.path });
  return true;
}

export async function pickProject(): Promise<void> {
  const folder = await window.capmac.invoke('app:pick-folder');
  if (folder) await openProject(folder);
}

export async function startSession(path: string, mode: 'run' | 'live', options: { clean?: boolean; full?: boolean } = {}): Promise<void> {
  const prefs = projectPrefs(path);
  const mac = macFor(path);
  if (!mac) {
    failStart(path, { message: 'No Mac is selected for this project.', hint: useMacs.getState().macs.length ? 'Pick a Mac in the toolbar.' : 'Pair your Mac first (Macs › Pair a Mac).', expected: true });
    return;
  }
  const settings = useApp.getState().settings;
  try {
    await call('sessions.start', { projectPath: path, mode, mac, target: prefs.target, options: { ...options, osLogs: settings?.osLogs } });
  } catch (err) {
    failStart(path, errorInfo(err));
  }
}

export async function stopSession(path: string): Promise<void> {
  const run = useRuns.getState().byKey[projectKey(path)];
  if (run?.sessionId) await call('sessions.stop', { sessionId: run.sessionId }).catch(() => undefined);
}

export async function stopAll(): Promise<void> {
  const runs = Object.values(useRuns.getState().byKey).filter((r) => isActive(r));
  await Promise.all(runs.map((r) => (r.sessionId ? call('sessions.stop', { sessionId: r.sessionId }).catch(() => undefined) : undefined)));
}

export async function rebuild(path: string, clean = false): Promise<void> {
  const run = useRuns.getState().byKey[projectKey(path)];
  if (run?.sessionId && run.mode === 'live') {
    await call('sessions.rebuild', { sessionId: run.sessionId, clean }).catch((err) => toast({ tone: 'critical', title: 'Could not rebuild', body: errorInfo(err).message }));
  } else {
    await startSession(path, run?.mode === 'live' ? 'live' : 'run', { clean });
  }
}

export async function relaunch(path: string): Promise<void> {
  const run = useRuns.getState().byKey[projectKey(path)];
  if (run?.sessionId && run.mode === 'live') await call('sessions.relaunch', { sessionId: run.sessionId }).catch(() => undefined);
  else await startSession(path, 'run');
}

export async function openInXcode(path: string): Promise<void> {
  const id = toast({ tone: 'info', title: 'Opening in Xcode on the Mac…', timeout: 0 });
  try {
    await call('xcode.open', { projectPath: path, mac: macFor(path) ?? undefined });
    toast({ tone: 'success', title: 'Opened in Xcode', body: 'It’s on the Mac’s screen.' });
  } catch (err) {
    const e = errorInfo(err);
    toast({ tone: 'critical', title: 'Could not open Xcode', body: e.hint ? `${e.message} ${e.hint}` : e.message });
  } finally {
    useToasts.getState().dismiss(id);
  }
}

export async function openInEditor(file: string, line?: number, column?: number): Promise<void> {
  try {
    await window.capmac.invoke('app:open-in-editor', { file, line, column });
  } catch (err) {
    toast({ tone: 'critical', title: 'Could not open the file', body: errorInfo(err).message });
  }
}

export async function forgetProject(path: string): Promise<void> {
  await window.capmac.invoke('app:forget-project', { path });
  const route = useApp.getState().route;
  if (route.name === 'project' && projectKey(route.path) === projectKey(path)) useApp.getState().navigate({ name: 'home' });
}
