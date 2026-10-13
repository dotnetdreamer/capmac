/** Every action in capmac Studio, for the command palette and keyboard shortcuts. */
import { useApp } from '../state/app';
import { forgetProject, macFor, openInXcode, openProject, pickProject, rebuild, relaunch, startSession, stopSession } from '../state/actions';
import { call } from '../state/engine';
import { resolveMac, useMacs } from '../state/macs';
import { projectKey } from '../state/projects';
import { ROUTE_LABEL, setOptions, testConnection, turnOn, useRemote } from '../state/remote';
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
    commands.push(
      { id: 'live', title: live ? 'Restart live reload' : 'Start live reload', group: 'Session', icon: 'flash', shortcut: 'F5', keywords: 'dev hmr watch', run: () => void startSession(path, 'live') },
      { id: 'run', title: active && run?.mode === 'run' ? 'Run again' : 'Run', group: 'Session', icon: 'play', shortcut: 'Ctrl+F5', keywords: 'build launch start', run: () => void startSession(path, 'run') },
      { id: 'stop', title: 'Stop', group: 'Session', icon: 'stop', shortcut: 'Shift+F5', enabled: active, run: () => void stopSession(path) },
      { id: 'rebuild', title: 'Rebuild and relaunch', group: 'Session', icon: 'sync', shortcut: 'Ctrl+Shift+F5', run: () => void rebuild(path) },
      { id: 'clean-rebuild', title: 'Clean rebuild', group: 'Session', icon: 'eraser', keywords: 'derived data', run: () => void rebuild(path, true) },
      { id: 'relaunch', title: 'Relaunch the app', group: 'Session', icon: 'refresh', enabled: live, run: () => void relaunch(path) },
      { id: 'build-ipa', title: 'Build IPA…', group: 'Project', icon: 'box', keywords: 'archive export testflight', run: () => emitWorkspace('build-ipa') },
      { id: 'xcode', title: 'Open in Xcode on the Mac', group: 'Project', icon: 'code', run: () => void openInXcode(path) },
      { id: 'pick-target', title: 'Choose simulator or device…', group: 'Project', icon: 'phone', keywords: 'target iphone', run: () => app.openPalette('target') },
      { id: 'pick-mac', title: 'Choose Mac…', group: 'Project', icon: 'mac', enabled: macs.length > 1, run: () => app.openPalette('mac') },
      { id: 'build-log', title: 'Show full build log', group: 'Project', icon: 'document', enabled: Boolean(run?.buildLogPath), run: () => emitWorkspace('show-build-log') },
      { id: 'open-folder', title: 'Open project folder', group: 'Project', icon: 'folderOpen', keywords: 'explorer', run: () => void window.capmac.invoke('app:open-path', { path }) },
      { id: 'open-editor', title: 'Open project in your editor', group: 'Project', icon: 'open', keywords: 'vs code vscode', run: () => void window.capmac.invoke('app:open-in-editor', { file: path }) },
      { id: 'forget', title: 'Remove from recent projects', group: 'Project', icon: 'delete', run: () => void forgetProject(path) },
      { id: 'toggle-simulator', title: 'Show or hide the simulator', group: 'View', icon: 'phone', shortcut: 'Ctrl+1', run: () => emitWorkspace('toggle-simulator') },
      { id: 'toggle-timeline', title: 'Show or hide the timeline', group: 'View', icon: 'timeline', shortcut: 'Ctrl+2', run: () => emitWorkspace('toggle-timeline') },
      { id: 'toggle-console', title: 'Show or hide the console', group: 'View', icon: 'console', shortcut: 'Ctrl+`', run: () => emitWorkspace('toggle-console') },
      { id: 'problems', title: 'Show problems', group: 'View', icon: 'errorCircle', shortcut: 'Ctrl+Shift+M', run: () => emitWorkspace('show-problems') },
      { id: 'find', title: 'Find in console', group: 'View', icon: 'search', shortcut: 'Ctrl+F', run: () => emitWorkspace('find-console') },
      { id: 'clear', title: 'Clear console', group: 'View', icon: 'eraser', shortcut: 'Ctrl+L', run: () => emitWorkspace('clear-console') },
      { id: 'screenshot', title: 'Take a simulator screenshot', group: 'View', icon: 'camera', shortcut: 'Ctrl+Shift+S', run: () => emitWorkspace('screenshot') },
    );
  }

  const recents = app.settings?.recentProjects ?? [];
  if (!path) {
    // Away from a project: run the recent ones straight from here.
    for (const recent of recents.slice(0, 3)) {
      const start = (mode: 'run' | 'live') => () => void startSession(recent.path, mode).then(() => app.navigate({ name: 'project', path: recent.path }));
      commands.push(
        { id: `run:${recent.path}`, title: `Run ${recent.name}`, group: 'Session', icon: 'play', keywords: `build launch start ${recent.appId}`, run: start('run') },
        { id: `live:${recent.path}`, title: `Live reload ${recent.name}`, group: 'Session', icon: 'flash', keywords: `dev hmr watch ${recent.appId}`, run: start('live') },
      );
    }
  }
  commands.push(
    { id: 'home', title: 'Go to Home', group: 'Navigation', icon: 'home', run: nav('home') },
    { id: 'devices', title: 'Go to Devices', group: 'Navigation', icon: 'phone', keywords: 'simulators boot', run: nav('devices') },
    { id: 'macs', title: 'Go to Macs', group: 'Navigation', icon: 'mac', run: nav('macs') },
    { id: 'settings', title: 'Open Settings', group: 'Navigation', icon: 'settings', shortcut: 'Ctrl+,', keywords: 'preferences options', run: nav('settings') },
    { id: 'add-project', title: 'Add a Capacitor app…', group: 'Navigation', icon: 'folderAdd', shortcut: 'Ctrl+O', keywords: 'open project folder', run: () => void pickProject() },
    { id: 'switch-project', title: 'Switch project…', group: 'Navigation', icon: 'grid', enabled: recents.length > 0, run: () => app.openPalette('project') },
    { id: 'sidebar', title: 'Toggle the sidebar', group: 'Navigation', icon: 'sidebar', shortcut: 'Ctrl+B', run: () => void app.updateSettings({ sidebarCollapsed: !app.settings?.sidebarCollapsed }) },
    { id: 'pair', title: 'Pair a Mac…', group: 'Mac', icon: 'add', keywords: 'connect ssh', run: () => app.navigate({ name: 'onboarding' }) },
    { id: 'health', title: 'Check Mac health', group: 'Mac', icon: 'health', keywords: 'doctor', enabled: Boolean(mac), run: () => app.navigate({ name: 'macs' }) },
    { id: 'keychain', title: 'Unlock the keychain on the Mac…', group: 'Mac', icon: 'key', keywords: 'signing codesign', enabled: Boolean(mac), run: () => mac && void call('macs.unlockKeychain', { name: mac.name }).catch(() => undefined) },
    { id: 'theme-system', title: 'Theme: follow Windows', group: 'App', icon: 'theme', enabled: app.settings?.theme !== 'system', run: () => void app.updateSettings({ theme: 'system' }) },
    { id: 'theme-light', title: 'Theme: light', group: 'App', icon: 'sun', enabled: app.settings?.theme !== 'light', run: () => void app.updateSettings({ theme: 'light' }) },
    { id: 'theme-dark', title: 'Theme: dark', group: 'App', icon: 'moon', enabled: app.settings?.theme !== 'dark', run: () => void app.updateSettings({ theme: 'dark' }) },
    {
      id: 'sample',
      title: 'Run the sample app',
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
        title: `Remote access: reach ${mac.label} from anywhere`,
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
        { id: 'remote-off', title: `Remote access: turn it off for ${mac.label}…`, group: 'Mac', icon: 'globe', keywords: 'internet away', run: () => app.navigate({ name: 'macs' }) },
        ...(['auto', 'lan', 'internet'] as const).map((route): Command => ({
          id: `remote-route-${route}`,
          title: `Connection: ${ROUTE_LABEL[route]}`,
          group: 'Mac',
          icon: route === 'lan' ? 'wifi' : 'globe',
          keywords: 'remote access route internet local network lan',
          enabled: remote.route !== route,
          run: () => void setOptions(mac, { route }),
        })),
        { id: 'remote-awake', title: remote.keepAwake ? `Let ${mac.label} sleep again` : `Keep ${mac.label} awake`, group: 'Mac', icon: 'power', keywords: 'remote access sleep caffeinate', run: () => void setOptions(mac, { keepAwake: !remote.keepAwake }) },
        { id: 'remote-test', title: 'Test the connection over the internet', group: 'Mac', icon: 'plugConnected', keywords: 'remote access peer relay', run: () => void testConnection(mac) },
      );
    }
  }
  if (app.info?.dev && mac) {
    commands.push({ id: 'drop', title: 'Developer: drop the connection to the Mac', group: 'App', icon: 'plugDisconnected', keywords: 'reconnect test', run: () => void call('debug.dropConnection', { mac: mac.name }) });
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
