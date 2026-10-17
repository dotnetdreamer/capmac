/** Every action in capmac Studio, for the command palette and keyboard shortcuts. */
import { t } from '../../shared/i18n';
import { useApp } from '../state/app';
import type { RunnableApp } from '../../shared/contract';
import { appGlyph, appKind, canRun } from '../lib/apps';
import { appOf, forgetProject, macFor, openInXcode, openProject, pickProject, projectPrefs, rebuild, relaunch, setApp, setBackend, startSession, stopSession } from '../state/actions';
import { call } from '../state/engine';
import { resolveMac, useMacs } from '../state/macs';
import { usePc } from '../state/pc';
import { projectKey, useProjects } from '../state/projects';
import { setOptions, testConnection, turnOn, useRemote } from '../state/remote';
import { isActive, useRuns } from '../state/runs';
import type { IconName } from '../ui/Icon';

export type CommandGroup = 'Session' | 'Project' | 'View' | 'Navigation' | 'Mac' | 'App';

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  icon?: IconName;
  shortcut?: string;
  keywords?: string;
  hint?: string;
  enabled?: boolean;
  run: () => void;
}

/** Actions that belong to the open workspace (panes, console, simulator). */
export type WorkspaceAction =
  | 'toggle-simulator'
  | 'toggle-timeline'
  | 'toggle-console'
  | 'show-problems'
  | 'find-console'
  | 'clear-console'
  | 'screenshot'
  | 'build-ipa'
  | 'show-build-log';

export const workspaceBus = new EventTarget();
export function emitWorkspace(action: WorkspaceAction): void {
  workspaceBus.dispatchEvent(new CustomEvent<WorkspaceAction>('action', { detail: action }));
}

/** A project with more than one app: switch to each of the others (a running app stops first). */
function switchAppCommands(path: string, active: boolean): Command[] {
  const summary = useProjects.getState().byKey[projectKey(path)]?.summary;
  const current = appOf(summary, projectPrefs(path));
  const apps = summary?.apps.filter(canRun) ?? [];
  if (apps.length < 2) return [];
  return apps
    .filter((a) => a.id !== current)
    .map((a) => ({
      id: `app:${a.id}`,
      title: t.apps.switchTo(appKind(a)),
      group: 'Project' as const,
      icon: appGlyph(a),
      keywords: 'app scheme ios electron mac desktop',
      run: () =>
        void (async () => {
          if (active) await stopSession(path);
          await setApp(path, a.id as RunnableApp);
        })(),
    }));
}

export function buildCommands(): Command[] {
  const app = useApp.getState();
  const route = app.route;
  const path = route.name === 'project' ? route.path : null;
  const run = path ? useRuns.getState().byKey[projectKey(path)] : undefined;
  const active = isActive(run);
  const macs = useMacs.getState().macs;
  const mac = path ? macs.find((m) => m.name === macFor(path)) : resolveMac(macs);
  const commands: Command[] = [];
  const nav = (name: 'home' | 'devices' | 'macs' | 'settings') => () => app.navigate({ name });

  if (path) {
    const live = run?.mode === 'live' && active;
    // Where the iOS app builds: this PC (no Mac), or a Mac. The Electron app always runs on the Mac.
    const summary = useProjects.getState().byKey[projectKey(path)]?.summary;
    const current = appOf(summary, projectPrefs(path)) ?? 'ios';
    const iosApp = Boolean(summary?.kind === 'capacitor' && current !== 'electron');
    const onPc = iosApp && summary?.backend === 'wsl';
    // A Capacitor app also runs without the web build; its iOS app can sync on the Mac (as the Run button's arrow offers).
    const ios = iosApp && current === 'ios' && Boolean(summary?.hasIos);
    const capacitor = ios || (summary?.kind === 'capacitor' && current === 'electron' && summary?.electron?.flavor === 'capacitor');
    commands.push(
      { id: 'live', title: live ? t.commands.restartLive : t.commands.startLive, group: 'Session', icon: 'flash', shortcut: 'F5', keywords: 'dev hmr watch', run: () => void startSession(path, 'live') },
      { id: 'run', title: active && run?.mode === 'run' ? t.commands.runAgain : t.commands.run, group: 'Session', icon: 'play', shortcut: 'Ctrl+F5', keywords: 'build launch start', run: () => void startSession(path, 'run') },
      { id: 'run-no-build', title: t.commands.runWithoutBuilding, group: 'Session', icon: 'history', keywords: 'skip web build cap run prebuilt launch', enabled: capacitor, run: () => void startSession(path, 'run', { webBuild: false }) },
      { id: 'sync', title: t.commands.sync, group: 'Session', icon: 'sync', keywords: 'cap sync copy plugins upload', enabled: ios && !onPc, run: () => void startSession(path, 'sync') },
      { id: 'stop', title: t.commands.stop, group: 'Session', icon: 'stop', shortcut: 'Shift+F5', enabled: active, run: () => void stopSession(path) },
      { id: 'rebuild', title: t.commands.rebuild, group: 'Session', icon: 'sync', shortcut: 'Ctrl+Shift+F5', run: () => void rebuild(path) },
      { id: 'clean-rebuild', title: t.commands.cleanRebuild, group: 'Session', icon: 'eraser', keywords: 'derived data', run: () => void rebuild(path, true) },
      { id: 'relaunch', title: t.commands.restartApp, group: 'Session', icon: 'refresh', enabled: live, run: () => void relaunch(path) },
      { id: 'build-ipa', title: t.commands.buildIpa, group: 'Project', icon: 'box', keywords: 'archive export testflight', run: () => emitWorkspace('build-ipa') },
      { id: 'xcode', title: t.commands.openXcode, group: 'Project', icon: 'code', enabled: !onPc, run: () => void openInXcode(path) },
      // On this PC the toolbar's picker lists the iPhones plugged in here.
      { id: 'pick-target', title: t.commands.chooseTarget, group: 'Project', icon: 'phone', keywords: 'target iphone', enabled: !onPc, run: () => app.openPalette('target') },
      { id: 'backend', title: onPc ? t.commands.buildOnMac : t.commands.buildOnPc, group: 'Project', icon: onPc ? 'mac' : 'desktop', keywords: 'wsl windows no mac backend', enabled: iosApp, run: () => void setBackend(path, onPc ? 'mac' : 'wsl') },
      { id: 'pc-setup', title: t.commands.setUpPc, group: 'Project', icon: 'wrench', keywords: 'wsl apple sign in signing xcode download', enabled: onPc, run: () => usePc.getState().showSetup(path, true) },
      { id: 'pc-check', title: t.commands.checkPc, group: 'Project', icon: 'health', keywords: 'doctor wsl', enabled: onPc, run: () => {
        usePc.getState().showSetup(path, true);
        void usePc.getState().check(path);
      } },
      ...switchAppCommands(path, active),
      { id: 'pick-mac', title: t.commands.chooseMac, group: 'Project', icon: 'mac', enabled: macs.length > 1, run: () => app.openPalette('mac') },
      { id: 'build-log', title: t.commands.buildLog, group: 'Project', icon: 'document', enabled: Boolean(run?.buildLogPath), run: () => emitWorkspace('show-build-log') },
      { id: 'open-folder', title: t.commands.openFolder, group: 'Project', icon: 'folderOpen', keywords: 'explorer', run: () => void window.capmac.invoke('app:open-path', { path }) },
      { id: 'open-editor', title: t.commands.openEditor, group: 'Project', icon: 'open', keywords: 'vs code vscode', run: () => void window.capmac.invoke('app:open-in-editor', { file: path }) },
      { id: 'forget', title: t.commands.forget, group: 'Project', icon: 'delete', run: () => void forgetProject(path) },
      { id: 'toggle-simulator', title: t.commands.toggleSimulator, group: 'View', icon: 'phone', shortcut: 'Ctrl+1', run: () => emitWorkspace('toggle-simulator') },
      { id: 'toggle-timeline', title: t.commands.toggleTimeline, group: 'View', icon: 'timeline', shortcut: 'Ctrl+2', run: () => emitWorkspace('toggle-timeline') },
      { id: 'toggle-console', title: t.commands.toggleConsole, group: 'View', icon: 'console', shortcut: 'Ctrl+`', run: () => emitWorkspace('toggle-console') },
      { id: 'problems', title: t.commands.showProblems, group: 'View', icon: 'errorCircle', shortcut: 'Ctrl+Shift+M', run: () => emitWorkspace('show-problems') },
      { id: 'find', title: t.commands.findInConsole, group: 'View', icon: 'search', shortcut: 'Ctrl+F', run: () => emitWorkspace('find-console') },
      { id: 'clear', title: t.commands.clearConsole, group: 'View', icon: 'eraser', shortcut: 'Ctrl+L', run: () => emitWorkspace('clear-console') },
      { id: 'screenshot', title: t.commands.screenshot, group: 'View', icon: 'camera', shortcut: 'Ctrl+Shift+S', run: () => emitWorkspace('screenshot') },
    );
  }

  const recents = app.settings?.recentProjects ?? [];
  if (!path) {
    // Away from a project: run the recent ones straight from here.
    for (const recent of recents.slice(0, 3)) {
      const start = (mode: 'run' | 'live') => () => void startSession(recent.path, mode).then(() => app.navigate({ name: 'project', path: recent.path }));
      commands.push(
        { id: `run:${recent.path}`, title: t.commands.runProject(recent.name), group: 'Session', icon: 'play', keywords: `build launch start ${recent.appId}`, run: start('run') },
        { id: `live:${recent.path}`, title: t.commands.liveProject(recent.name), group: 'Session', icon: 'flash', keywords: `dev hmr watch ${recent.appId}`, run: start('live') },
      );
    }
  }
  commands.push(
    { id: 'home', title: t.commands.home, group: 'Navigation', icon: 'home', run: nav('home') },
    { id: 'devices', title: t.commands.devices, group: 'Navigation', icon: 'phone', keywords: 'simulators boot', run: nav('devices') },
    { id: 'macs', title: t.commands.macs, group: 'Navigation', icon: 'mac', run: nav('macs') },
    { id: 'settings', title: t.commands.settings, group: 'Navigation', icon: 'settings', shortcut: 'Ctrl+,', keywords: 'preferences options', run: nav('settings') },
    { id: 'add-project', title: t.commands.addProject, group: 'Navigation', icon: 'folderAdd', shortcut: 'Ctrl+O', keywords: 'open project folder', run: () => void pickProject() },
    { id: 'switch-project', title: t.commands.switchProject, group: 'Navigation', icon: 'grid', enabled: recents.length > 0, run: () => app.openPalette('project') },
    { id: 'sidebar', title: t.commands.sidebar, group: 'Navigation', icon: 'sidebar', shortcut: 'Ctrl+B', run: () => void app.updateSettings({ sidebarCollapsed: !app.settings?.sidebarCollapsed }) },
    { id: 'pair', title: t.commands.pair, group: 'Mac', icon: 'add', keywords: 'connect ssh', run: () => app.navigate({ name: 'onboarding' }) },
    { id: 'health', title: t.commands.health, group: 'Mac', icon: 'health', keywords: 'doctor', enabled: Boolean(mac), run: () => app.navigate({ name: 'macs' }) },
    { id: 'keychain', title: t.commands.keychain, group: 'Mac', icon: 'key', keywords: 'signing codesign', enabled: Boolean(mac), run: () => mac && void call('macs.unlockKeychain', { name: mac.name }).catch(() => undefined) },
    { id: 'theme-system', title: t.commands.themeSystem, group: 'App', icon: 'theme', enabled: app.settings?.theme !== 'system', run: () => void app.updateSettings({ theme: 'system' }) },
    { id: 'theme-light', title: t.commands.themeLight, group: 'App', icon: 'sun', enabled: app.settings?.theme !== 'light', run: () => void app.updateSettings({ theme: 'light' }) },
    { id: 'theme-dark', title: t.commands.themeDark, group: 'App', icon: 'moon', enabled: app.settings?.theme !== 'dark', run: () => void app.updateSettings({ theme: 'dark' }) },
    {
      id: 'sample',
      title: t.commands.sample,
      group: 'App',
      icon: 'rocket',
      keywords: 'hello example demo',
      run: () =>
        void call('projects.createSample', {}).then(async ({ path: sample }) => {
          if ((await openProject(sample)) && useMacs.getState().macs.length > 0) void startSession(sample, 'run');
        }),
    },
  );
  if (mac) {
    // Remote access: the same options as `capmac remote`.
    const remote = mac.remote;
    if (!remote.enabled) {
      commands.push({
        id: 'remote-on',
        title: t.commands.remoteOn(mac.label),
        group: 'Mac',
        icon: 'globe',
        keywords: 'internet away remote access peer to peer',
        run: () => {
          if (useRemote.getState().server?.url) void turnOn(mac);
          else {
            app.navigate({ name: 'macs' });
          }
        },
      });
    } else {
      commands.push(
        { id: 'remote-off', title: t.commands.remoteOff(mac.label), group: 'Mac', icon: 'globe', keywords: 'internet away', run: () => app.navigate({ name: 'macs' }) },
        ...(['auto', 'lan', 'internet'] as const).map((route): Command => ({
          id: `remote-route-${route}`,
          title: t.commands.connection(t.route.choice[route]),
          group: 'Mac',
          icon: route === 'lan' ? 'wifi' : 'globe',
          keywords: 'remote access route internet local network lan',
          enabled: remote.route !== route,
          run: () => void setOptions(mac, { route }),
        })),
        { id: 'remote-awake', title: remote.keepAwake ? t.commands.letSleep(mac.label) : t.commands.keepAwake(mac.label), group: 'Mac', icon: 'power', keywords: 'remote access sleep caffeinate', run: () => void setOptions(mac, { keepAwake: !remote.keepAwake }) },
        { id: 'remote-test', title: t.commands.testRemote, group: 'Mac', icon: 'plugConnected', keywords: 'remote access peer relay', run: () => void testConnection(mac) },
      );
    }
  }
  if (app.info?.dev && mac) {
    commands.push({ id: 'drop', title: t.commands.dropConnection, group: 'App', icon: 'plugDisconnected', keywords: 'reconnect test', run: () => void call('debug.dropConnection', { mac: mac.name }) });
  }
  return commands.filter((c) => c.enabled !== false);
}

// ─── Shortcuts ─────────────────────────────────────────────────────────────

export function shortcutOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  // Shift changes the character of punctuation keys; use the physical key for those.
  if (e.code === 'Backquote') key = '`';
  if (e.code === 'Comma') key = ',';
  parts.push(key);
  return parts.join('+');
}
