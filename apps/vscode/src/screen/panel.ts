/**
 * The live screen tab: an iOS simulator, an iPhone plugged into the Mac, an
 * app's window on the Mac's desktop, or an iPhone at this PC with no Mac (the
 * one mirroring to it over Wi-Fi, or its picture over the cable). One tab,
 * which follows the app being worked on; it can live beside the code or in a
 * window of its own.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { streamPreference as sharedStreamPreference } from '@capmac/core/engine/config';
import type { ScreenPortMessage } from '../../../desktop/src/shared/contract.js';
import { EngineError, type ScreenChannel } from '../engine/client.js';
import { s, studio } from '../i18n.js';
import { sameStream } from '../state/screens.js';
import { isActive } from '../state/runs.js';
import { errorText, keyOf, type Model, type WorkspaceApp } from '../state/model.js';

export interface ScreenActions {
  screenshot(app: WorkspaceApp, window?: number | null): Promise<void>;
  /** The screenshot as a PNG, for Copy screenshot (null: it failed, and it said why). */
  screenshotPng(app: WorkspaceApp, window?: number | null): Promise<Uint8Array | null>;
  run(app: WorkspaceApp, mode: 'run' | 'live'): Promise<void>;
  reloadApp(app: WorkspaceApp): Promise<void>;
}

type Screen = NonNullable<ReturnType<Model['screenFor']>>;
type PhoneScreen = Extract<Screen, { backend: 'wsl' }>;

/** The stream setting CapMac's front ends share (~/.capmac/config.json `stream`). */
export async function streamPreference(): Promise<'smooth' | 'compatible'> {
  return sharedStreamPreference().catch(() => 'smooth' as const);
}

/** Core's own save: a config file it can't read just now stays as it is (it holds the paired Macs). */
export async function setStreamPreference(mode: 'smooth' | 'compatible'): Promise<void> {
  await sharedStreamPreference(mode);
}

export class ScreenPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private channel: ScreenChannel | null = null;
  private app: WorkspaceApp | null = null;
  private screen: Screen | null = null;
  private ready = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly model: Model, private readonly actions: ScreenActions) {
    this.disposables.push(
      model.onDidChange((change) => {
        if (change === 'runs') this.syncRun();
        if (change === 'macs') this.syncRoute();
        if (change === 'runs' || change === 'targets' || change === 'selection' || change === 'apps' || change === 'engine' || change === 'pc') this.followTarget();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('capmac.screen.deviceFrame')) void this.panel?.webview.postMessage({ type: 'frame', frame: this.frame() });
      }),
    );
  }

  get visible(): boolean {
    return Boolean(this.panel?.visible);
  }

  get isOpen(): boolean {
    return this.panel !== null;
  }

  /** The open stream of an iPhone at this PC (its screenshots come from it), or null. */
  get phoneStreamId(): string | null {
    return this.screen?.backend === 'wsl' && this.channel ? this.channel.streamId : null;
  }

  private frame(): boolean {
    return vscode.workspace.getConfiguration('capmac').get<boolean>('screen.deviceFrame', true);
  }

  /** Shows `app`'s screen (opens the tab, or points it at this app). */
  async show(app: WorkspaceApp, options: { preserveFocus?: boolean } = {}): Promise<boolean> {
    const screen = this.model.screenFor(app);
    if (!screen) return false;
    const sameScreen = this.panel && this.screen && sameStream(this.screen, screen);
    this.app = app;
    if (this.panel) {
      if (!sameScreen) {
        this.screen = screen;
        this.panel.title = s.screen.title(screen.name);
        if (this.ready) await this.open();
      } else if (screen.backend === 'wsl') this.retargetPhone(screen);
      this.panel.reveal(undefined, options.preserveFocus ?? true);
      return true;
    }
    this.screen = screen;
    const location = vscode.workspace.getConfiguration('capmac').get<string>('screen.location', 'beside');
    const column = location === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel('capmac.screen', s.screen.title(screen.name), { viewColumn: column, preserveFocus: options.preserveFocus ?? true }, this.options());
    this.adopt(panel);
    if (location === 'window') await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => undefined);
    return true;
  }

  /**
   * Another iPhone or app at this PC: the picture goes on (it is the same for all), touch moves to
   * it. A new stream could not show the picture again: the iPhone sends its keyframe only when
   * mirroring starts.
   */
  private retargetPhone(screen: PhoneScreen): void {
    const was = this.screen;
    this.screen = screen;
    if (was?.backend === 'wsl' && was.udid === screen.udid && keyOf(was.projectPath) === keyOf(screen.projectPath) && was.name === screen.name) return;
    if (this.panel) this.panel.title = s.screen.title(screen.name);
    this.channel?.post({ type: 'phone-target', udid: screen.udid, projectPath: screen.projectPath });
    void this.panel?.webview.postMessage({ type: 'name', name: screen.name });
  }

  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')] };
  }

  /** Takes over a tab: a new one, or one VS Code brings back after a reload. */
  private adopt(panel: vscode.WebviewPanel): void {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    panel.webview.options = this.options();
    panel.iconPath = { light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'screen-light.svg'), dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'screen-dark.svg') };
    this.panel = panel;
    this.ready = false;
    panel.webview.html = this.html(panel.webview, dist);
    panel.onDidDispose(() => {
      this.opens++;
      this.channel?.close();
      this.channel = null;
      this.panel = null;
      this.screen = null;
      this.noneFor = null;
      this.ready = false;
    }, null, this.disposables);
    panel.webview.onDidReceiveMessage((message) => void this.onMessage(message), null, this.disposables);
  }

  /** A tab from before the reload: it follows the current app as soon as CapMac knows where that runs. */
  restore(panel: vscode.WebviewPanel): void {
    this.adopt(panel);
    this.followTarget();
  }

  /** The app the "no screen here" note was shown for. */
  private noneFor: string | null = null;

  /** Keeps the open tab on the current app: its new simulator, another app's screen, or a note when it has none. */
  private followTarget(): void {
    if (!this.panel) return;
    const app = this.model.current();
    if (!app) return;
    const screen = this.model.screenFor(app);
    if (screen) {
      this.noneFor = null;
      if (!this.screen || !sameStream(screen, this.screen)) void this.show(app);
      else if (screen.backend === 'wsl') {
        this.app = app;
        this.retargetPhone(screen);
      }
      return;
    }
    // Nothing to stream here (a Windows app, an iPhone that doesn't trust this PC yet): say where it is.
    if (!this.ready || this.noneFor === app.key || this.model.engine.state !== 'ready' || this.model.detecting) return;
    const dest = this.model.resolveDestination(app);
    // Still finding out (the Mac's simulators aren't listed yet).
    if (dest.kind === 'auto' && !dest.target) return;
    this.opens++;
    this.channel?.close();
    this.channel = null;
    this.screen = null;
    this.app = app;
    this.noneFor = app.key;
    this.panel.title = app.app.name;
    const text = dest.kind === 'pc-desktop' ? s.session.noScreenWindows : dest.kind === 'pc-iphone' ? studio.pc.trust.body : s.screen.noTarget;
    void this.panel.webview.postMessage({ type: 'none', text });
  }

  /** Counts opens: one that a newer open, the "no screen" note or closing the tab overtook goes no further. */
  private opens = 0;

  private async open(): Promise<void> {
    const panel = this.panel;
    const screen = this.screen;
    const app = this.app;
    if (!panel || !screen || !app) return;
    const open = ++this.opens;
    this.channel?.close();
    this.channel = null;
    const prefer = await streamPreference();
    if (open !== this.opens || this.panel !== panel) return;
    const mac = screen.backend === 'mac' ? this.model.macs.find((m) => m.name === screen.mac) : undefined;
    const run = this.model.runOf(app);
    const kind = screen.backend === 'wsl' ? 'phone' : screen.udid === 'mac-desktop' ? 'app' : screen.device ? 'device' : 'simulator';
    const webview = panel.webview;
    // The page learns the stream's id first; every message after carries it.
    const channel = this.model.client.openScreen(
      screen.backend === 'wsl'
        ? { udid: screen.udid, prefer, projectPath: screen.projectPath, backend: 'wsl' }
        : { mac: screen.mac, udid: screen.udid, prefer, projectPath: screen.projectPath, device: screen.device },
      {
        onMessage: (message: ScreenPortMessage) => void webview.postMessage({ type: 'port', streamId: channel.streamId, message }),
        onClose: () => {
          if (this.channel === channel) void webview.postMessage({ type: 'closed' });
        },
      },
    );
    this.channel = channel;
    await webview.postMessage({
      type: 'init',
      streamId: channel.streamId,
      init: {
        kind,
        name: screen.name,
        macLabel: screen.backend === 'mac' ? mac?.label ?? screen.mac : '',
        frame: this.frame(),
        live: run?.mode === 'live' && isActive(run),
        running: isActive(run ?? undefined) && run?.app?.state === 'running',
        route: mac?.route ?? null,
        rttMs: mac?.rttMs ?? null,
        prefer,
      },
    });
  }

  private async onMessage(message: { type: string; name?: string; command?: unknown; text?: string; window?: number | null; streamId?: string; udid?: string; req?: number; ok?: boolean; error?: string }): Promise<void> {
    const app = this.app;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        if (this.screen) await this.open();
        else this.followTarget();
        return;
      case 'port':
        // Acks and input of a stream that was replaced go nowhere.
        if (this.channel && message.streamId === this.channel.streamId) this.channel.post(message.command as Parameters<ScreenChannel['post']>[0]);
        return;
      case 'action':
        if (!app) return;
        switch (message.name) {
          case 'reconnect':
            await this.open();
            return;
          case 'screenshot':
            await this.actions.screenshot(app, message.window ?? null);
            return;
          case 'copy-screenshot': {
            // The page puts it on the clipboard: VS Code's clipboard takes text only.
            const webview = this.panel?.webview;
            const png = await this.actions.screenshotPng(app, message.window ?? null);
            void webview?.postMessage(png ? { type: 'shot', req: message.req, png } : { type: 'shot', req: message.req, error: studio.simulator.shotFailed });
            return;
          }
          case 'screenshot-copied':
            if (message.ok) vscode.window.setStatusBarMessage(`$(copy) ${s.screen.copied}`, 4000);
            else void vscode.window.showErrorMessage(s.screen.copyFailed, { detail: message.error } as vscode.MessageOptions);
            return;
          case 'restart-simulator':
            if (this.screen?.backend === 'mac' && !this.screen.device && this.screen.udid !== 'mac-desktop') {
              const { mac, udid, name } = this.screen;
              await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: s.screen.title(name) }, async (progress) => {
                progress.report({ message: `Restarting ${name}…` });
                await this.model.client.invoke('simulators.shutdown', { mac, udid });
                await this.model.client.invoke('simulators.boot', { mac, udid });
              });
              await this.open();
            }
            return;
          case 'fix-axe':
            if (this.screen?.backend === 'mac') {
              await this.model.client.invoke('macs.fix', { name: this.screen.mac, fix: 'install-axe' });
              await this.open();
            }
            return;
          case 'turn-on-touch':
            if (this.screen?.backend === 'wsl' && message.udid) await this.turnOnTouch(this.screen, message.udid);
            return;
          case 'reload-app':
            await this.actions.reloadApp(app);
            return;
          case 'run':
          case 'live':
            await this.actions.run(app, message.name);
            return;
          case 'clipboard':
            if (message.text) {
              await vscode.env.clipboard.writeText(message.text);
              vscode.window.setStatusBarMessage(`$(clippy) Copied from ${app.app.name}`, 3000);
            }
            return;
        }
    }
  }

  /**
   * An iPhone at this PC: signs WebDriverAgent with the developer's team and puts it on the iPhone
   * touch is for (`udid`: the one that mirrors when this PC knows it, else the tab's), so the screen
   * takes taps. Touch then starts on the open stream.
   */
  private async turnOnTouch(screen: PhoneScreen, udid: string): Promise<void> {
    const webview = this.panel?.webview;
    void webview?.postMessage({ type: 'touch-busy', busy: true });
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: s.screen.turningOnTouch }, () =>
        this.model.client.invoke('iphone.setUpTouch', { projectPath: screen.projectPath, udid }),
      );
      vscode.window.setStatusBarMessage(`$(check) ${studio.pc.screen.touchOn}`, 5000);
      // Touch starts on the stream that is open: a new one could not show the picture again.
      if (this.screen?.backend === 'wsl') this.channel?.post({ type: 'phone-target', udid: this.screen.udid, projectPath: this.screen.projectPath });
    } catch (err) {
      if (!(err instanceof EngineError && err.cancelled)) {
        const error = errorText(err);
        void vscode.window.showErrorMessage(studio.pc.screen.touchFailed, { detail: [error.message, error.hint].filter(Boolean).join('\n') } as vscode.MessageOptions);
      }
    } finally {
      void webview?.postMessage({ type: 'touch-busy', busy: false });
    }
  }

  /** An app's window: tell the page whether the app runs (it shows Run and Live otherwise). */
  private syncRun(): void {
    if (!this.panel || !this.app || this.screen?.udid !== 'mac-desktop') return;
    const run = this.model.runs.get(keyOf(this.app.project.dir));
    void this.panel.webview.postMessage({ type: 'run-state', running: isActive(run) && run?.app?.state === 'running', live: run?.mode === 'live' && isActive(run) });
  }

  private syncRoute(): void {
    const screen = this.screen;
    if (!this.panel || screen?.backend !== 'mac') return;
    const mac = this.model.macs.find((m) => m.name === screen.mac);
    void this.panel.webview.postMessage({ type: 'route', route: mac?.route ?? null, rttMs: mac?.rttMs ?? null });
  }

  /** Reopens the stream (another stream setting, or after a restart). */
  async reopen(): Promise<void> {
    if (this.ready) await this.open();
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...parts)).toString();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      'worker-src blob:',
      `connect-src ${webview.cspSource}`,
      'media-src blob:',
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('screen.css')}">
<title>CapMac screen</title>
</head>
<body data-worker="${uri('screen-worker.js')}">
<div id="root"></div>
<script nonce="${nonce}" src="${uri('screen.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.channel?.close();
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
