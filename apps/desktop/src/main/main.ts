/**
 * capmac Studio, main process: windows, tray, notifications, OS integration
 * and request validation. The engine runs in a utility process (engine.ts).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, MessageChannelMain, nativeImage, nativeTheme, Notification, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  appChannels,
  engineMethods,
  type AppChannel,
  type AppCommand,
  type AppInfo,
  type AppResults,
  type EngineMethod,
  type EngineStatus,
  type Envelope,
  type PromptRequest,
  type Settings,
  type TakeoverInfo,
} from '../shared/contract.js';
import { EngineProcess } from './engine.js';
import { openInEditor } from './editor.js';
import { installSkill, removeSkill, skillProjectRoot, skillStatus } from '@capmac/core/engine/agent-skills';
import { capmacCommandStatus, installCapmacCommand, removeCapmacCommand } from '@capmac/core/engine/capmac-command';
import { loadGlobalConfig, streamPreference } from '@capmac/core/engine/config';
import { disableTakeover, enableTakeover, ensureTakeoverDefault, samePath, takeoverStatus, type TakeoverInstall } from '@capmac/core/engine/takeover';
import { agentPath, cliDir, electronSampleDir, flutterSampleDir, iconsDir, outDir, reactNativeSampleDir, remoteModulesDir, sampleDir } from './paths.js';
import { SettingsStore } from './settings.js';
import { AppTray } from './tray.js';
import { Updates } from './updates.js';
import { t, tidy } from '../shared/i18n/index.js';
import { sameOrigin } from '../shared/urls.js';
import { APP_ORIGIN, createMainWindow, hardenSession, micaSupported, registerAppScheme, serveRenderer } from './window.js';


const devUrl = process.env.ELECTRON_RENDERER_URL ?? null;
const isDev = !app.isPackaged;

// A separate profile (settings, window state, instance lock), e.g. for end-to-end tests.
if (process.env.CAPMAC_STUDIO_USER_DATA) app.setPath('userData', path.resolve(process.env.CAPMAC_STUDIO_USER_DATA));

/**
 * One capmac Studio at a time. In development the previous instance may
 * still be exiting when the dev runner restarts Electron, so retry briefly.
 */
async function acquireInstanceLock(): Promise<boolean> {
  for (let attempt = 0; attempt < 24; attempt++) {
    if (app.requestSingleInstanceLock()) return true;
    if (!process.env.CAPMAC_STUDIO_DEV) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
const instanceLock = acquireInstanceLock();
registerAppScheme();
app.setAppUserModelId('dev.capmac.studio');

let win: BrowserWindow | null = null;
let settings: SettingsStore;
let engine: EngineProcess;
let tray: AppTray | null = null;
let updates: Updates;
let quitting = false;
let engineStatus: EngineStatus = { state: 'starting' };
const mica = micaSupported();
const pendingPrompts: PromptRequest[] = [];
const running = new Map<string, { projectPath: string; mode: 'run' | 'live' | 'ipa' }>();

// ─── Helpers ───────────────────────────────────────────────────────────────

function accentColor(): string | null {
  try {
    const rgba = systemPreferences.getAccentColor();
    return rgba ? `#${rgba.slice(0, 6)}` : null;
  } catch {
    return null;
  }
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    win = openWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function command(cmd: AppCommand): void {
  showWindow();
  send('app:command', cmd);
}

function projectName(projectPath: string | undefined): string {
  if (!projectPath) return t.system.yourApp;
  const recent = settings.get().recentProjects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase());
  return recent?.name ?? path.basename(projectPath);
}

function updateTray(): void {
  const s = settings.get();
  const last = s.lastProject ? { path: s.lastProject, name: projectName(s.lastProject) } : null;
  tray?.update({ lastProject: last, running: [...running.values()].map((r) => ({ ...r, name: projectName(r.projectPath) })), updateReady: updates?.ready ?? null });
}

/** A Windows notification, only when capmac Studio is not in front. */
function notify(title: string, body: string, onClick?: () => void): void {
  if (!settings.get().notifications || !Notification.isSupported()) return;
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return;
  const n = new Notification({ title, body, icon: path.join(iconsDir(), 'icon.png'), silent: false });
  n.on('click', () => {
    showWindow();
    onClick?.();
  });
  n.show();
}

function updateVisibility(): void {
  const visible = Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
  engine?.setVisible(visible);
}

// ─── Engine events: relay to the window, drive tray and notifications ─────

const launchedAt = new Map<string, number>();
/** An Electron app's dialogs already announced, per project. */
const dialogsSeen = new Map<string, Set<number>>();

function onEngineEvents(batch: Envelope[]): void {
  send('engine:events', batch);
  for (const { scope, event } of batch) {
    switch (event.type) {
      case 'session-started':
        if (scope.sessionId) running.set(scope.sessionId, { projectPath: event.projectPath, mode: event.mode === 'live' || event.mode === 'ipa' ? event.mode : 'run' });
        if (scope.sessionId) launchedAt.set(scope.sessionId, Date.now());
        updateTray();
        break;
      case 'session-ended':
        if (scope.sessionId) running.delete(scope.sessionId);
        updateTray();
        if (!event.ok && event.error && scope.projectPath) {
          const name = projectName(scope.projectPath);
          settings.recordRun(scope.projectPath, { at: Date.now(), mode: event.mode === 'live' ? 'live' : 'run', ok: false, ms: event.ms });
          notify(t.console.buildFailed(name, event.mode === 'ipa'), tidy(event.error.message), () => command({ type: 'open-project', path: scope.projectPath! }));
        }
        break;
      case 'app':
        if (event.state === 'running' && scope.projectPath) {
          const started = scope.sessionId ? launchedAt.get(scope.sessionId) : undefined;
          const ms = started ? Date.now() - started : undefined;
          if (scope.sessionId) launchedAt.delete(scope.sessionId);
          const mode = scope.sessionId ? running.get(scope.sessionId)?.mode : undefined;
          settings.recordRun(scope.projectPath, { at: Date.now(), mode: mode === 'live' ? 'live' : 'run', ok: true, target: event.target, ms });
          notify(t.system.isRunning(event.name ?? projectName(scope.projectPath)), t.system.runningOn(event.target ?? t.common.theSimulator, ms ? (ms / 1000).toFixed(1) : undefined), () => command({ type: 'open-project', path: scope.projectPath! }));
        }
        break;
      case 'session':
        if (event.state === 'failed' && event.mode === 'live' && event.error && scope.projectPath) {
          notify(t.system.rebuildFailed(projectName(scope.projectPath)), tidy(event.error.message), () => command({ type: 'open-project', path: scope.projectPath! }));
        }
        break;
      case 'ipa-ready':
        notify(t.ipa.ready, path.basename(event.file), () => shell.showItemInFolder(event.file));
        break;
      case 'app-dialogs': {
        // An Electron app asks something (over its window, in the pane): flash the taskbar and say so, without taking the keyboard.
        const seen = dialogsSeen.get(event.projectId) ?? new Set<number>();
        dialogsSeen.set(event.projectId, seen);
        const open = new Set(event.dialogs.map((d) => d.id));
        for (const id of [...seen]) if (!open.has(id)) seen.delete(id);
        const fresh = event.dialogs.find((d) => !seen.has(d.id));
        for (const d of event.dialogs) seen.add(d.id);
        if (fresh && win && !win.isDestroyed() && !win.isFocused()) {
          const app = fresh.app || (scope.projectPath ? projectName(scope.projectPath) : t.common.theApp);
          const body = fresh.kind === 'message' ? t.appDialog.asks(app, fresh.message || fresh.title || t.appDialog.message) : fresh.kind === 'save' ? t.appDialog.wantsSave(app) : t.appDialog.wantsFile(app);
          if (!win.isVisible()) win.showInactive();
          win.flashFrame(true);
          notify(t.appDialog.waiting(app), body, scope.projectPath ? () => command({ type: 'open-project', path: scope.projectPath! }) : undefined);
        }
        break;
      }
      default:
        break;
    }
  }
}

function onEnginePrompt(prompt: PromptRequest): void {
  if (!win || win.isDestroyed()) {
    engine.respondPrompt({ id: prompt.id, ok: false });
    return;
  }
  pendingPrompts.push(prompt);
  send('engine:prompt', prompt);
  // A question that waits on something else (a sign-in in the browser) needs no answer to go on.
  if (!(prompt.kind === 'confirm' && prompt.waiting)) askForAttention(prompt.message);
}

function onEnginePromptWithdraw(id: string): void {
  const index = pendingPrompts.findIndex((p) => p.id === id);
  if (index < 0) return;
  pendingPrompts.splice(index, 1);
  send('engine:prompt-withdraw', id);
  if (!pendingPrompts.length && win && !win.isDestroyed()) win.flashFrame(false);
}

/**
 * A question waits in the window without taking the keyboard: someone busy in
 * another app could otherwise type into it (a password, even). The taskbar
 * button flashes and a notification says CapMac Studio needs an answer.
 */
function askForAttention(message: string): void {
  if (!win || win.isDestroyed() || win.isFocused()) return;
  if (!win.isVisible()) win.showInactive();
  win.flashFrame(true);
  notify(t.system.needsAnswer, message);
}

// ─── IPC (every payload validated; only our own pages may call) ───────────

function trusted(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return sameOrigin(url, APP_ORIGIN) || (devUrl !== null && sameOrigin(url, devUrl));
}

function handle<C extends AppChannel>(channel: C, fn: (payload: z.output<(typeof appChannels)[C]>, event: IpcMainInvokeEvent) => Promise<AppResults[C]> | AppResults[C]): void {
  ipcMain.handle(channel, async (event, payload) => {
    if (!trusted(event)) throw new Error('Request from an untrusted page.');
    const parsed = appChannels[channel].safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid request (${channel}): ${z.prettifyError(parsed.error)}`);
    return fn(parsed.data as z.output<(typeof appChannels)[C]>, event);
  });
}

// ─── Takeover ──────────────────────────────────────────────────────────────

/** The capmac CLI inside capmac Studio, which `npx cap run ios` runs when takeover is on. */
function studioCli(): TakeoverInstall {
  return { cli: path.join(cliDir(), 'cli.mjs'), preload: path.join(cliDir(), 'takeover.cjs'), version: app.getVersion() };
}

async function takeoverInfo(): Promise<TakeoverInfo> {
  const status = await takeoverStatus();
  return { ...status, bundled: status.cli !== undefined && samePath(status.cli, studioCli().cli) };
}

// ─── The screen stream, shared with the capmac command ────────────────────

/** Smooth or compatible, as the CLI and Studio share it (~/.capmac/config.json); Studio's setting follows it. */
async function sharedStream(): Promise<Settings['simulatorStream']> {
  const shared = (await loadGlobalConfig().catch(() => null))?.stream;
  if (shared !== 'smooth' && shared !== 'compatible') return settings.get().simulatorStream;
  if (shared !== settings.get().simulatorStream) settings.update({ simulatorStream: shared });
  return shared;
}

function registerIpc(): void {
  handle('app:info', (): AppInfo => ({
    version: __APP_VERSION__,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    agent: __AGENT_VERSION__,
    platform: process.platform,
    arch: process.arch,
    osRelease: process.getSystemVersion(),
    packaged: app.isPackaged,
    dev: isDev,
    configDir: process.env.CAPMAC_CONFIG_DIR || path.join(app.getPath('home'), '.capmac'),
    accent: accentColor(),
    mica,
    userName: os.userInfo().username,
  }));
  handle('app:get-settings', () => settings.get());
  handle('app:set-settings', (patch) => settings.update(patch));
  handle('app:pick-folder', async () => {
    const result = await dialog.showOpenDialog(win!, { title: t.system.pickFolder, properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('app:open-in-editor', ({ file, line, column }) => openInEditor(settings.get().editor, file, line, column));
  handle('app:show-in-folder', ({ path: p }) => shell.showItemInFolder(p));
  handle('app:open-path', async ({ path: p }) => {
    const error = await shell.openPath(p);
    if (error) throw new Error(error);
  });
  handle('app:open-external', ({ url }) => shell.openExternal(url));
  handle('app:project-icon', async ({ path: p }) => {
    if (!/\.png$/i.test(p)) return null;
    const image = nativeImage.createFromPath(p);
    if (image.isEmpty()) return null;
    return image.resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
  });
  handle('app:save-image', async ({ data, name }) => {
    const result = await dialog.showSaveDialog(win!, { title: t.system.saveScreenshot, defaultPath: path.join(app.getPath('pictures'), name), filters: [{ name: t.system.pngImage, extensions: ['png'] }] });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
    return result.filePath;
  });
  handle('app:copy-image', async ({ data }) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  });
  handle('app:save-text', async ({ text, name }) => {
    const result = await dialog.showSaveDialog(win!, { title: t.system.saveLog, defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: t.system.logFile, extensions: ['log', 'txt'] }] });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, text);
    return result.filePath;
  });
  handle('app:screen-open', async ({ mac, udid, maxSize, projectPath, device }, event) => {
    const streamId = `scr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const prefer = await sharedStream();
    const { port1, port2 } = new MessageChannelMain();
    engine.openScreen(streamId, mac, udid, port1, { prefer, maxSize, projectPath, device });
    event.sender.postMessage('screen-port', { streamId }, [port2]);
    return { streamId };
  });
  handle('app:project-opened', (entry) => {
    settings.touchProject(entry);
    updateTray();
  });
  handle('app:forget-project', ({ path: p }) => {
    settings.forgetProject(p);
    updateTray();
  });
  handle('app:engine-call', async ({ method, params }) => {
    if (!Object.hasOwn(engineMethods, method) || (method === 'debug.dropConnection' && app.isPackaged)) {
      return { ok: false, error: { message: t.system.unknownRequest(method), expected: false } };
    }
    const parsed = engineMethods[method as EngineMethod].safeParse(params ?? {});
    if (!parsed.success) {
      return { ok: false, error: { message: t.system.badRequest, details: z.prettifyError(parsed.error).split('\n'), expected: false } };
    }
    return engine.call(method as EngineMethod, parsed.data);
  });
  handle('app:prompt-response', (response) => {
    const index = pendingPrompts.findIndex((p) => p.id === response.id);
    if (index < 0) return;
    pendingPrompts.splice(index, 1);
    engine.respondPrompt(response);
  });
  handle('app:visibility', () => updateVisibility());
  handle('app:takeover-status', () => takeoverInfo());
  handle('app:takeover-set', async ({ on }) => {
    if (on) await enableTakeover(studioCli());
    else await disableTakeover();
    return takeoverInfo();
  });
  handle('app:skills-status', async ({ projectDir }) => ({
    version: app.getVersion(),
    projectRoot: projectDir ? skillProjectRoot(projectDir) : null,
    agents: await skillStatus(app.getVersion(), projectDir),
    command: await capmacCommandStatus(),
  }));
  handle('app:skills-install', (options) => installSkill({ ...options, version: app.getVersion() }));
  handle('app:skills-remove', (options) => removeSkill(options));
  // Agents run `capmac` as a command; without the npm package, it runs the CLI shipped inside Studio.
  handle('app:capmac-command', ({ install }) => (install ? installCapmacCommand(studioCli().cli) : removeCapmacCommand()));
  handle('app:update-status', () => updates.info);
  handle('app:update-check', () => updates.check());
  handle('app:update-install', () => restartToUpdate());
  // Late-loading pages ask for state they may have missed.
  ipcMain.on('app:hello', (event) => {
    event.sender.send('engine:status', engineStatus);
    for (const prompt of pendingPrompts) event.sender.send('engine:prompt', prompt);
  });
}

// ─── Updates ───────────────────────────────────────────────────────────────

/** Restarts into the downloaded update; a running session is the user's call. */
async function restartToUpdate(): Promise<void> {
  const version = updates.ready;
  if (!version) return;
  if (running.size > 0) {
    const names = [...running.values()].map((r) => projectName(r.projectPath)).join(', ');
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: [t.updates.dialogRestart, t.common.cancel],
      defaultId: 1,
      cancelId: 1,
      title: t.updates.dialogTitle,
      message: t.updates.dialogMessage(version),
      detail: t.updates.dialogDetail(names),
    };
    const { response } = await (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
    if (response !== 0) return;
  }
  quitting = true;
  updates.install();
}

// ─── Window ────────────────────────────────────────────────────────────────

function openWindow(): BrowserWindow {
  const w = createMainWindow({
    preload: outDir('preload', 'preload.cjs'),
    url: devUrl ?? `${APP_ORIGIN}/index.html`,
    icon: path.join(iconsDir(), 'icon.ico'),
    mica,
  });
  w.on('show', updateVisibility);
  w.on('hide', updateVisibility);
  w.on('focus', () => w.flashFrame(false));
  w.on('minimize', updateVisibility);
  w.on('restore', updateVisibility);
  w.on('close', (event) => {
    if (quitting || running.size === 0 || !settings.get().keepInTray) return;
    // A session is running: keep it going in the tray.
    event.preventDefault();
    w.hide();
    if (!settings.get().trayHintShown) {
      settings.update({ trayHintShown: true });
      new Notification({ title: t.system.stillRunning, body: t.system.stillRunningBody, icon: path.join(iconsDir(), 'icon.png') }).show();
    }
  });
  w.on('closed', () => {
    if (win === w) win = null;
    // Nothing running: closing the window quits the app.
    if (!quitting && running.size === 0) app.quit();
  });
  if (isDev) w.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') console.log(`[renderer ${details.level}] ${details.message}`);
  });
  return w;
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

app.on('second-instance', (_event, argv) => {
  showWindow();
  const folder = argv.slice(1).find((a) => !a.startsWith('-') && path.isAbsolute(a));
  if (folder) send('app:command', { type: 'open-project', path: folder } satisfies AppCommand);
});

app.whenReady().then(async () => {
  if (!(await instanceLock)) {
    // Another capmac Studio is running: it was told to come to the front (second-instance).
    app.exit(0);
    return;
  }
  if (app.isPackaged) Menu.setApplicationMenu(null); // no reload/devtools accelerators in the product
  settings = new SettingsStore();
  nativeTheme.themeSource = settings.get().theme;
  serveRenderer();
  hardenSession(devUrl);
  engine = new EngineProcess(outDir('engine', 'engine.cjs'), () => ({
    agentPath: agentPath(),
    sampleDir: sampleDir(),
    electronSampleDir: electronSampleDir(),
    flutterSampleDir: flutterSampleDir(),
    reactNativeSampleDir: reactNativeSampleDir(),
    samplesHome: path.join(app.getPath('documents'), 'CapMac Studio'),
    remoteModulesDir: remoteModulesDir(),
    settings: { verbose: settings.get().verbose, osLogs: settings.get().osLogs },
  }), {
    onEvents: onEngineEvents,
    onPrompt: onEnginePrompt,
    onPromptWithdraw: onEnginePromptWithdraw,
    onStatus: (status) => {
      engineStatus = status;
      if (status.state === 'crashed') {
        // Prompts of the crashed engine can never be answered.
        pendingPrompts.length = 0;
        running.clear();
        updateTray();
      }
      send('engine:status', status);
    },
  });
  engine.start();
  registerIpc();
  // Takeover is on by default (Settings › Terminal commands). Development builds and
  // the e2e tests leave the user's environment alone.
  if (app.isPackaged) void ensureTakeoverDefault(studioCli()).catch(() => undefined);
  // The screen stream is the capmac command's too: a choice made here before it was shared counts once.
  let stream = settings.get().simulatorStream;
  void loadGlobalConfig().then((config) => {
    if (config.stream) void sharedStream();
    else if (stream === 'compatible') void streamPreference(stream).catch(() => undefined);
  }, () => undefined);
  settings.onChange((s: Settings) => {
    nativeTheme.themeSource = s.theme;
    engine.setSettings({ verbose: s.verbose, osLogs: s.osLogs });
    send('app:settings', s);
    if (s.simulatorStream !== stream) {
      stream = s.simulatorStream;
      void streamPreference(stream).catch(() => undefined);
    }
  });
  systemPreferences.on('accent-color-changed', () => send('app:accent', accentColor()));
  win = openWindow();
  tray = new AppTray(iconsDir(), { show: showWindow, quit: () => app.quit(), command, update: () => void restartToUpdate() });
  updates = new Updates({
    onChange: (info) => {
      send('app:update', info);
      updateTray();
    },
  });
  updates.start();
  updateTray();
});

app.on('window-all-closed', () => {
  // Kept alive by the tray while a session runs; otherwise `closed` already quit.
});

let shutdownDone = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (shutdownDone) return;
  event.preventDefault();
  // Stop running apps, tunnels and dev servers cleanly before exiting.
  void engine.shutdown().finally(() => {
    shutdownDone = true;
    tray?.destroy();
    app.quit();
  });
});
