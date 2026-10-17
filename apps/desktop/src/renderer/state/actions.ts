/** What the UI (buttons, palette, tray, shortcuts) can do. */
import type { AppSearch, BuildBackend, ErrorInfo, ProjectSummary, RunnableApp } from '../../shared/contract';
import { t, tidy } from '../../shared/i18n';
import { canRun } from '../lib/apps';
import { toast, useApp, useToasts } from './app';
import { useChooser } from './chooser';
import { call, errorInfo } from './engine';
import { resolveMac, useMacs } from './macs';
import { pcReady, usePc } from './pc';
import { projectKey, useProjects } from './projects';
import { emptyRun, isActive, MAC_TARGET_ID, PC_TARGET_ID, useRuns } from './runs';

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

/** An error's message and hint, as one line for a toast. */
export function both(e: { message: string; hint?: string }): string {
  return e.hint ? `${tidy(e.message)}. ${tidy(e.hint)}` : tidy(e.message);
}

function failStart(path: string, error: ErrorInfo): void {
  const key = projectKey(path);
  const run = useRuns.getState().byKey[key] ?? emptyRun(path);
  useRuns.setState((s) => ({ byKey: { ...s.byKey, [key]: { ...run, status: 'failed', error, sessionId: null, endedAt: Date.now() } } }));
}

/** Chosen in onboarding ("No Mac? Build on this PC"): the next Capacitor app opened builds on this PC. */
let thisPcNext = false;
export function preferThisPc(): void {
  thisPcNext = true;
}

/** Adds a folder as a project (validates it is a Capacitor app) and opens it; `known`: its summary, just made. */
export async function openProject(path: string, known?: ProjectSummary): Promise<boolean> {
  const summary = known ?? (await useProjects.getState().inspect(path, true));
  if (!summary) {
    const error = useProjects.getState().byKey[projectKey(path)]?.error;
    toast({ tone: 'critical', title: t.actions.notCapacitor, body: error ? both(error) : t.actions.notCapacitorBody });
    return false;
  }
  await window.capmac.invoke('app:project-opened', { path: summary.path, name: summary.appName, appId: summary.appId });
  useApp.getState().navigate({ name: 'project', path: summary.path });
  if (thisPcNext && summary.kind === 'capacitor') {
    thisPcNext = false;
    // Switches it (when it isn't yet), and shows setup when this PC isn't ready.
    await setBackend(summary.path, 'wsl');
  }
  return true;
}

/**
 * Adds a folder: finds the apps in it (and in the folders inside it), asks
 * which one to work on when there are several, then opens that project.
 * A project already in the list just opens (its app is switched in the toolbar).
 */
export async function addProject(path: string): Promise<boolean> {
  let search: AppSearch;
  try {
    search = await call('projects.detect', { path });
  } catch (err) {
    toast({ tone: 'critical', title: t.actions.notCapacitor, body: both(errorInfo(err)) });
    return false;
  }
  const runnable = search.projects.filter((p) => p.apps.some(canRun));
  if (runnable.length === 0) {
    const found = [...new Set(search.projects.map((p) => t.apps.framework[p.framework] ?? p.framework))];
    toast({ tone: 'critical', title: t.actions.notCapacitor, body: found.length ? t.actions.cantRunYet(found) : t.actions.notCapacitorBody });
    return false;
  }
  const only = runnable.length === 1 ? runnable[0]! : null;
  const known = (dir: string) => useApp.getState().settings?.recentProjects.some((r) => projectKey(r.path) === projectKey(dir)) ?? false;
  if (only && (only.apps.filter(canRun).length === 1 || only.chosen || known(only.dir))) return openProject(only.dir);
  const choice = await useChooser.getState().ask(search);
  if (!choice) return false;
  const summary = await setApp(choice.dir, choice.app);
  return summary ? openProject(choice.dir, summary) : false;
}

export async function pickProject(): Promise<void> {
  const folder = await window.capmac.invoke('app:pick-folder');
  if (folder) await addProject(folder);
}

/**
 * The app a project works on: the one picked, else the Mac's desktop when it
 * was picked as the target (before projects had apps to pick), else the
 * project's own default.
 */
export function appOf(summary: ProjectSummary | null | undefined, prefs: { target?: string } = {}): RunnableApp | undefined {
  if (!summary) return undefined;
  if (!summary.appChosen && prefs.target === MAC_TARGET_ID && summary.apps.some((a) => a.id === 'electron')) return 'electron';
  return summary.app;
}

/** Makes `app` the one CapMac works on in this project (the CLI too); resolves with the project as it is now. */
export async function setApp(path: string, app: RunnableApp): Promise<ProjectSummary | null> {
  let summary: ProjectSummary;
  try {
    summary = await call('projects.setApp', { path, app });
  } catch (err) {
    toast({ tone: 'critical', title: t.apps.switchFailed, body: both(errorInfo(err)) });
    return null;
  }
  // The Mac's desktop was how the Electron app used to be picked: targets are the iOS app's now.
  if (projectPrefs(path).target === MAC_TARGET_ID || projectPrefs(path).target === PC_TARGET_ID) setProjectPrefs(path, { target: undefined });
  await useProjects.getState().put(path, summary);
  return summary;
}

/**
 * Where the project's iOS app builds from now on: a paired Mac (`mac`: which one), or this PC.
 * The capmac command uses the same choice. A running app is stopped first.
 */
export async function setBackend(path: string, backend: BuildBackend, mac?: string): Promise<void> {
  const summary = useProjects.getState().byKey[projectKey(path)]?.summary;
  if (summary && summary.backend !== backend) {
    if (isActive(useRuns.getState().byKey[projectKey(path)])) await stopSession(path);
    let next: ProjectSummary;
    try {
      next = await call('projects.setBackend', { path, backend });
    } catch (err) {
      toast({ tone: 'critical', title: t.pc.switchFailed, body: both(errorInfo(err)) });
      return;
    }
    await useProjects.getState().put(path, next);
    const label = resolveMac(useMacs.getState().macs, mac ?? projectPrefs(path).mac ?? summary.host)?.label;
    toast({ tone: 'success', title: backend === 'wsl' ? t.pc.switched : t.pc.switchedMac(label ?? t.common.theMac), body: t.pc.switchedBody });
  }
  if (mac) setProjectPrefs(path, { mac });
  if (backend === 'wsl') {
    // Not set up yet: show what setup does.
    const status = await usePc.getState().refresh(path);
    if (status && !pcReady(status)) usePc.getState().showSetup(path, true);
  }
}

/** On this PC: set up first, then build for the iPhone picked (when it is plugged in), else the one that is. */
async function startOnPc(path: string, mode: 'run' | 'live' | 'build', picked: string | undefined, options: { clean?: boolean; flutterMode?: 'debug' | 'profile' | 'release'; configuration?: string }): Promise<void> {
  const pc = usePc.getState();
  const status = pc.byKey[projectKey(path)]?.status ?? (await pc.refresh(path));
  if (!pcReady(status)) {
    pc.showSetup(path, true);
    toast({ tone: 'info', title: t.pc.setupFirst, body: t.pc.setupFirstBody });
    return;
  }
  const plugged = usePc.getState().byKey[projectKey(path)]?.devices?.devices ?? [];
  const target = picked && plugged.some((device) => device.udid === picked) ? picked : undefined;
  try {
    await call('sessions.start', { projectPath: path, mode, app: 'ios', backend: 'wsl', target, options: { clean: options.clean, flutterMode: options.flutterMode, configuration: options.configuration } });
  } catch (err) {
    failStart(path, errorInfo(err));
  }
}

/** `build`: on this PC, build the app and its .ipa without installing it. `flutterMode`: a Flutter app's Run in profile or release mode; `configuration`: a React Native app's (Release). */
export async function startSession(path: string, mode: 'run' | 'live' | 'build', options: { clean?: boolean; full?: boolean; flutterMode?: 'debug' | 'profile' | 'release'; configuration?: string } = {}): Promise<void> {
  const prefs = projectPrefs(path);
  const summary = useProjects.getState().byKey[projectKey(path)]?.summary;
  const app = appOf(summary, prefs);
  // A Flutter app's Windows app builds and runs on this PC: no Mac.
  if (app === 'windows') {
    if (mode === 'build') return;
    try {
      await call('sessions.start', { projectPath: path, mode, app, options: { flutterMode: options.flutterMode, configuration: options.configuration } });
    } catch (err) {
      failStart(path, errorInfo(err));
    }
    return;
  }
  // Desktop apps run on the Mac's desktop; the iOS app builds where the project builds.
  if (summary?.backend === 'wsl' && app === 'ios') return startOnPc(path, mode, prefs.target, options);
  if (mode === 'build') return;
  const mac = macFor(path);
  if (!mac) {
    if (useMacs.getState().macs.length === 0) {
      // Nothing failed: there is just no Mac yet. The workspace already says so.
      toast({ tone: 'info', title: t.actions.pairFirst, body: t.actions.pairFirstBody, action: { label: t.common.pairMac, run: () => useApp.getState().navigate({ name: 'onboarding' }) } });
      return;
    }
    failStart(path, { message: t.actions.noMacSelected, hint: t.actions.noMacSelectedHint, expected: true });
    return;
  }
  const settings = useApp.getState().settings;
  try {
    await call('sessions.start', { projectPath: path, mode, mac, app, target: app !== 'ios' || prefs.target === MAC_TARGET_ID || prefs.target === PC_TARGET_ID ? undefined : prefs.target, options: { ...options, osLogs: settings?.osLogs } });
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
  // Live reload on this PC rebuilds by starting again.
  if (run?.sessionId && run.mode === 'live' && run.backend !== 'wsl') {
    await call('sessions.rebuild', { sessionId: run.sessionId, clean }).catch((err) => toast({ tone: 'critical', title: t.actions.rebuildFailed, body: tidy(errorInfo(err).message) }));
  } else {
    await startSession(path, run?.mode === 'live' ? 'live' : 'run', { clean });
  }
}

export async function relaunch(path: string): Promise<void> {
  const run = useRuns.getState().byKey[projectKey(path)];
  if (run?.sessionId && run.mode === 'live' && run.backend !== 'wsl') await call('sessions.relaunch', { sessionId: run.sessionId }).catch(() => undefined);
  else await startSession(path, run?.mode === 'live' ? 'live' : 'run');
}

/** Live reload: an Electron app reloads its windows; a Flutter app hot-reloads. */
export async function reloadApp(path: string): Promise<void> {
  const run = useRuns.getState().byKey[projectKey(path)];
  if (!run?.sessionId || run.mode !== 'live') return;
  await call('sessions.reload', { sessionId: run.sessionId }).catch((err) => toast({ tone: 'critical', title: t.actions.reloadFailed, body: tidy(errorInfo(err).message) }));
}

/** A React Native app in live reload: opens React Native DevTools for it (in the browser Metro picks). */
export async function openDevTools(path: string): Promise<void> {
  const run = useRuns.getState().byKey[projectKey(path)];
  if (!run?.sessionId || run.mode !== 'live') return;
  try {
    const { opened } = await call('sessions.devtools', { sessionId: run.sessionId });
    if (!opened) toast({ tone: 'caution', title: t.actions.devToolsFailed, body: t.actions.devToolsFailedBody });
  } catch (err) {
    toast({ tone: 'critical', title: t.actions.devToolsFailed, body: tidy(errorInfo(err).message) });
  }
}

export async function openInXcode(path: string): Promise<void> {
  const id = toast({ tone: 'info', title: t.actions.openingXcode, timeout: 0 });
  try {
    await call('xcode.open', { projectPath: path, mac: macFor(path) ?? undefined });
    toast({ tone: 'success', title: t.actions.xcodeOpened, body: t.actions.xcodeOpenedBody });
  } catch (err) {
    toast({ tone: 'critical', title: t.actions.xcodeFailed, body: both(errorInfo(err)) });
  } finally {
    useToasts.getState().dismiss(id);
  }
}

export async function openInEditor(file: string, line?: number, column?: number): Promise<void> {
  try {
    await window.capmac.invoke('app:open-in-editor', { file, line, column });
  } catch (err) {
    toast({ tone: 'critical', title: t.actions.fileFailed, body: tidy(errorInfo(err).message) });
  }
}

export async function forgetProject(path: string): Promise<void> {
  await window.capmac.invoke('app:forget-project', { path });
  const route = useApp.getState().route;
  if (route.name === 'project' && projectKey(route.path) === projectKey(path)) useApp.getState().navigate({ name: 'home' });
}
