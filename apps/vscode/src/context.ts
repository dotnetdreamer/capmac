/**
 * Context keys for the manifest's `when` and `enablement` clauses: what
 * CapMac can do now for the app being worked on (menus and buttons follow).
 */
import * as vscode from 'vscode';
import { reloads } from './session.js';
import { keyOf, pcReady, type Model } from './state/model.js';
import { HAS_DEVTOOLS } from './state/pure.js';
import { isActive, isNative } from './state/runs.js';

export class ContextKeys implements vscode.Disposable {
  private readonly values = new Map<string, unknown>();
  private readonly disposable: vscode.Disposable;

  constructor(private readonly model: Model) {
    this.disposable = model.onDidChange(() => this.update());
    this.update();
  }

  private set(key: string, value: unknown): void {
    if (this.values.get(key) === value) return;
    this.values.set(key, value);
    void vscode.commands.executeCommand('setContext', key, value);
  }

  update(): void {
    const m = this.model;
    const ready = m.engine.state === 'ready';
    this.set('capmac.engineReady', ready);
    this.set('capmac.engineFailed', m.engine.state === 'crashed' && !m.engine.restarting);
    const app = m.current();
    const summary = m.summaryOf(app);
    const run = m.runOf(app);
    const active = isActive(run ?? undefined);
    const live = active && run?.mode === 'live';
    const id = app?.app.id ?? null;
    const framework = app?.project.framework ?? null;
    const backend = app ? m.backendOf(app) : 'mac';
    const dest = app ? m.resolveDestination(app) : null;
    this.set('capmac.hasApp', Boolean(app));
    this.set('capmac.hasAnyApp', m.apps.length > 0);
    this.set('capmac.app', id);
    this.set('capmac.framework', framework);
    this.set('capmac.backend', backend);
    this.set('capmac.hasMac', m.macs.length > 0);
    this.set('capmac.running', active);
    this.set('capmac.mode', active ? run?.mode : null);
    this.set('capmac.live', live);
    // Live actions: Flutter hot-reloads, React Native reloads through Metro, an Electron app reloads its windows; a Flutter app hot-restarts.
    this.set('capmac.canReload', live && Boolean(app && reloads(app)) && backend !== 'wsl');
    this.set('capmac.canHotRestart', live && framework === 'flutter' && backend !== 'wsl');
    this.set('capmac.canRebuild', live && backend !== 'wsl');
    this.set('capmac.canRelaunch', live && backend !== 'wsl');
    // React Native (and Expo): DevTools for the app in live reload, and Run in release mode.
    const reactNative = isNative(framework ?? '');
    this.set('capmac.reactNative', reactNative);
    this.set('capmac.canDevTools', HAS_DEVTOOLS && reactNative && live);
    this.set('capmac.canShowScreen', Boolean(app && m.screenFor(app)));
    this.set('capmac.hasBuildLog', Boolean(run?.buildLogPath));
    // Capacitor apps (and Capacitor's Electron platform) can skip their web build.
    const capacitor = framework === 'capacitor';
    this.set('capmac.canSkipWebBuild', Boolean(app) && (capacitor && (id === 'ios' || (id === 'electron' && summary?.electron?.flavor === 'capacitor'))));
    const syncSupported = m.supportsMode('sync');
    this.set('capmac.syncSupported', syncSupported);
    this.set('capmac.canSync', syncSupported && capacitor && id === 'ios' && backend === 'mac');
    this.set('capmac.canIpa', id === 'ios');
    // Flutter's iOS project isn't where Open in Xcode looks (ios/App).
    this.set('capmac.canXcode', capacitor && id === 'ios' && backend === 'mac' && dest?.kind !== 'none');
    this.set('capmac.canPickBackend', process.platform === 'win32' && id === 'ios');
    const pc = app ? m.pc.get(keyOf(app.project.dir)) : undefined;
    this.set('capmac.pcPossible', process.platform === 'win32' && m.runnableApps().some((a) => a.app.id === 'ios'));
    this.set('capmac.pcReady', pcReady(pc?.status));
    this.set('capmac.pcSettingUp', Boolean(pc?.setupId));
  }

  dispose(): void {
    this.disposable.dispose();
  }
}
