/**
 * Starting and steering runs: Run and Live are VS Code debug sessions (see
 * debug/adapter.ts); an IPA build, a sync and this PC's setup run with a
 * progress notification. The live actions (reload, restart, rebuild) go to
 * the engine's live session of the app.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { EngineMethod, Envelope, MethodParams } from '../../desktop/src/shared/contract.js';
import { EngineError } from './engine/client.js';
import { s, studio, tidy } from './i18n.js';
import type { CapmacLaunch, SessionActions } from './debug/adapter.js';
import type { ScreenPanel } from './screen/panel.js';
import type { IpaChoice } from './ui/pickers.js';
import { errorText, keyOf, pcReady, type Model, type WorkspaceApp } from './state/model.js';
import { isActive, isNative, phaseLabel, type TimelinePhase } from './state/runs.js';

/** Apps whose live session reloads in place: Flutter (hot reload), React Native and Expo (Metro), Electron (its windows). */
export const HOT_RELOAD_FRAMEWORKS: readonly string[] = ['flutter', 'react-native', 'expo'];
export const reloads = (app: WorkspaceApp): boolean => HOT_RELOAD_FRAMEWORKS.includes(app.project.framework) || app.app.id === 'electron';

export class Sessions implements SessionActions {
  screen: ScreenPanel | null = null;

  constructor(private readonly model: Model, private readonly output: vscode.LogOutputChannel) {}

  // ─── Run and Live ────────────────────────────────────────────────────────

  /** Checks what a run needs first; says what to do when something is missing. */
  async ready(app: WorkspaceApp): Promise<boolean> {
    if (!app.runnable) {
      void vscode.window.showWarningMessage(s.session.notRunnable(app.app.name), { detail: s.session.notRunnableHint } as vscode.MessageOptions);
      return false;
    }
    if (app.app.status === 'setup' && app.app.hint) {
      void vscode.window.showWarningMessage(`${app.app.name}: ${tidy(app.app.hint)}`);
      return false;
    }
    // What's missing is said, with the way to fix it, and the run doesn't wait for an answer.
    const offer = (message: string, actions: Array<[label: string, command: string]>, detail?: string) => {
      const labels = actions.map(([label]) => label);
      const shown = detail ? vscode.window.showWarningMessage(message, { detail } as vscode.MessageOptions, ...labels) : vscode.window.showWarningMessage(message, ...labels);
      void shown.then((answer) => {
        const action = actions.find(([label]) => label === answer);
        if (action) void vscode.commands.executeCommand(action[1]);
      });
      return false;
    };
    const dest = this.model.resolveDestination(app);
    if (dest.kind === 'none') {
      const actions: Array<[string, string]> = [[s.cmd.pairMac, 'capmac.pairMac']];
      if (process.platform === 'win32' && app.app.id === 'ios') actions.push([s.cmd.setupPc, 'capmac.setupPc']);
      return offer(app.app.id === 'ios' ? s.session.pairFirst : s.session.pairFirstMac, actions);
    }
    if (dest.kind === 'pc-iphone') {
      await this.model.refreshPc(app.project.dir, false);
      if (!pcReady(this.model.pc.get(keyOf(app.project.dir))?.status)) return offer(s.session.pcFirst, [[s.cmd.setupPc, 'capmac.setupPc']], s.session.pcFirstBody);
    }
    return true;
  }

  /**
   * Live reload runs the project's dev server on this PC, so its packages must
   * be installed (a fresh clone, or a sample copied without node_modules).
   * Run can do without: it uses the web files built last time.
   */
  private async dependenciesFor(app: WorkspaceApp, mode: 'run' | 'live'): Promise<boolean> {
    if (mode !== 'live' || app.project.framework === 'flutter') return true;
    const summary = this.model.summaryOf(app) ?? (await this.model.refreshSummary(app.project.dir));
    if (!summary || summary.hasNodeModules || summary.kind === 'flutter') return true;
    const install = s.deps.installAndRun;
    const answer = await vscode.window.showWarningMessage(s.deps.needed(app.app.name), { modal: true, detail: s.deps.neededDetail(summary.packageManager) }, install);
    if (answer !== install) return false;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: s.deps.installing }, () => this.model.client.invoke('projects.installDeps', { path: app.project.dir }));
    } catch (err) {
      const { message, hint } = errorText(err);
      void vscode.window.showErrorMessage(`${s.deps.failed}: ${message}`, { detail: hint } as vscode.MessageOptions);
      return false;
    }
    await this.model.refreshSummary(app.project.dir);
    return true;
  }

  /** Starts on their way, by project and mode. */
  private readonly starting = new Map<string, Promise<boolean>>();

  /** Starts Run or Live as a debug session (Studio's F5 and Ctrl+F5). A second click while it starts is the same start. */
  start(app: WorkspaceApp, mode: 'run' | 'live', extra: Partial<CapmacLaunch> = {}): Promise<boolean> {
    const key = `${keyOf(app.project.dir)}#${mode}`;
    const pending = this.starting.get(key);
    if (pending) return pending;
    const start = this.startNow(app, mode, extra).finally(() => this.starting.delete(key));
    this.starting.set(key, start);
    return start;
  }

  private async startNow(app: WorkspaceApp, mode: 'run' | 'live', extra: Partial<CapmacLaunch>): Promise<boolean> {
    if (!(await this.ready(app))) return false;
    if (!(await this.dependenciesFor(app, mode))) return false;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(app.project.dir));
    const config: CapmacLaunch = {
      type: 'capmac',
      request: 'launch',
      name: `${mode === 'live' ? studio.common.live : studio.common.run}: ${app.app.name}`,
      mode,
      projectPath: app.project.dir,
      app: app.app.id as CapmacLaunch['app'],
      internalConsoleOptions: 'openOnSessionStart',
      ...extra,
    };
    return vscode.debug.startDebugging(folder, config, { noDebug: mode === 'run' });
  }

  /** The debug session running `app`, if any. */
  debugSessionOf(app: WorkspaceApp): vscode.DebugSession | undefined {
    const key = keyOf(app.project.dir);
    const active = vscode.debug.activeDebugSession;
    const matches = (session: vscode.DebugSession | undefined) => session?.type === 'capmac' && keyOf(String(session.configuration.projectPath ?? '')) === key;
    if (matches(active)) return active;
    return this.sessions.find(matches);
  }

  /** Debug sessions CapMac started, so Stop finds them (VS Code lists only the active one). */
  readonly sessions: vscode.DebugSession[] = [];

  async stop(app: WorkspaceApp): Promise<void> {
    const session = this.debugSessionOf(app);
    if (session) {
      await vscode.debug.stopDebugging(session);
      return;
    }
    const run = this.model.activeSession(app);
    if (run?.sessionId) await this.model.stopSession(run.sessionId);
  }

  // ─── Live actions ────────────────────────────────────────────────────────

  private liveSession(app: WorkspaceApp): string {
    const run = this.model.activeSession(app);
    if (!run?.sessionId || run.mode !== 'live') throw new EngineError({ message: s.session.notLive, expected: true });
    return run.sessionId;
  }

  /**
   * r: Flutter's hot reload, React Native's (Metro) reload, an Electron app's
   * windows reload; a Capacitor app's web view reloads on save by itself, so
   * r rebuilds it (as the CLI's r).
   */
  async reload(app: WorkspaceApp): Promise<void> {
    const sessionId = this.liveSession(app);
    if (reloads(app)) await this.model.client.invoke('sessions.reload', { sessionId });
    else await this.model.client.invoke('sessions.rebuild', { sessionId });
  }

  /** R: start the app over (Flutter: hot restart). */
  async restart(app: WorkspaceApp): Promise<void> {
    const run = this.model.activeSession(app);
    if (run?.sessionId && run.mode === 'live' && run.backend !== 'wsl') {
      await this.model.client.invoke('sessions.relaunch', { sessionId: run.sessionId });
      return;
    }
    const session = this.debugSessionOf(app);
    if (session) await vscode.commands.executeCommand('workbench.action.debug.restart');
    else await this.start(app, run?.mode === 'live' ? 'live' : 'run');
  }

  async rebuild(app: WorkspaceApp, clean = false): Promise<void> {
    const run = this.model.activeSession(app);
    if (run?.sessionId && run.mode === 'live' && run.backend !== 'wsl') {
      await this.model.client.invoke('sessions.rebuild', { sessionId: run.sessionId, clean });
      return;
    }
    await this.start(app, run?.mode === 'live' ? 'live' : 'run', { clean });
  }

  /** j: React Native DevTools for the app in live reload (Metro's j), in the browser Metro picks. */
  async devtools(app: WorkspaceApp): Promise<void> {
    const run = this.model.activeSession(app);
    if (!run?.sessionId || run.mode !== 'live') {
      void vscode.window.showInformationMessage(s.devtools.needsLive);
      return;
    }
    // An engine method of feature/react-native's contract (HAS_DEVTOOLS: this build's engine has it). A cold
    // browser start can take a while (the engine gives Metro 30 s): the status bar says it's on its way.
    const result = (await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: s.devtools.opening }, () =>
      this.model.client.invoke('sessions.devtools' as EngineMethod, { sessionId: run.sessionId } as never),
    )) as unknown as { opened: boolean };
    if (!result.opened) void vscode.window.showWarningMessage(s.devtools.failed, { detail: s.devtools.failedBody } as vscode.MessageOptions);
  }

  /** A React Native app as people get it: release build, its JavaScript inside (Studio's "Run in release mode"). */
  runRelease(app: WorkspaceApp): Promise<boolean> {
    return this.start(app, 'run', { configuration: 'Release' });
  }

  // ─── The screen ──────────────────────────────────────────────────────────

  async showScreen(app: WorkspaceApp): Promise<void> {
    if (!this.screen) return;
    if (await this.screen.show(app, { preserveFocus: false })) return;
    const dest = this.model.resolveDestination(app);
    void vscode.window.showInformationMessage(dest.kind === 'pc-desktop' ? s.session.noScreenWindows : dest.kind === 'pc-iphone' ? s.session.noScreenPc : s.screen.noTarget);
  }

  started(app: WorkspaceApp, config: CapmacLaunch): void {
    const setting = vscode.workspace.getConfiguration('capmac').get<string>('screen.openOnRun', 'auto');
    const wanted = config.screen ?? (setting === 'always' || (setting === 'auto' && this.autoScreen(app)));
    if (!wanted || !this.screen) return;
    // Show the screen once the app has a target (the simulator is picked during the run).
    const tryShow = () => {
      const run = this.model.runOf(app);
      if (!run || !isActive(run)) return true;
      const screen = this.model.screenFor(app);
      if (!screen) return false;
      void this.screen?.show(app);
      return true;
    };
    if (tryShow()) return;
    const listener = this.model.onDidChange((change) => {
      if (change === 'runs' && tryShow()) listener.dispose();
    });
    setTimeout(() => listener.dispose(), 10 * 60_000);
  }

  /** "auto": simulators and Mac apps show their screen; a real iPhone needs its cable, this PC's apps have their own window. */
  private autoScreen(app: WorkspaceApp): boolean {
    const dest = this.model.resolveDestination(app);
    return dest.kind === 'simulator' || dest.kind === 'auto' || dest.kind === 'mac-desktop';
  }

  /** A full-size screenshot, saved in the project's .capmac folder and opened beside the code. */
  async screenshot(app: WorkspaceApp, window: number | null = null): Promise<string | null> {
    const screen = this.model.screenFor(app);
    if (!screen) {
      void vscode.window.showInformationMessage(s.screen.noTarget);
      return null;
    }
    try {
      const shot = await this.model.client.invoke('screen.screenshot', { mac: screen.mac, udid: screen.udid, projectPath: screen.projectPath, window: window ?? undefined });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const name = screen.udid === 'mac-desktop' ? studio.appWindow.shotName(stamp) : screen.device ? studio.simulator.deviceShotName(screen.name, stamp) : `${screen.name} ${stamp}.png`;
      const dir = path.join(app.project.dir, '.capmac', 'screenshots');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, name.replace(/[<>:"/\\|?*]+/g, '-'));
      await fs.writeFile(file, Buffer.from(shot.png));
      void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
      vscode.window.setStatusBarMessage(`$(device-camera) ${s.screen.saved(path.basename(file))}`, 5000);
      return file;
    } catch (err) {
      void vscode.window.showErrorMessage(`${s.screen.shotFailed}: ${errorText(err).message}`);
      return null;
    }
  }

  // ─── Builds with a progress notification ─────────────────────────────────

  /** Follows a session to its end in a notification (IPA builds, sync). Resolves with its last events. */
  private follow(app: WorkspaceApp, title: string, start: () => Promise<string>): Promise<{ ok: boolean; cancelled: boolean; ipa?: { file: string; size: number }; error?: string; hint?: string }> {
    return new Promise((resolve) => {
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
        let sessionId: string | null = null;
        const early: Envelope[] = [];
        let ipa: { file: string; size: number } | undefined;
        let finish!: (result: { ok: boolean; cancelled: boolean; error?: string; hint?: string }) => void;
        const done = new Promise<{ ok: boolean; cancelled: boolean; error?: string; hint?: string }>((r) => (finish = r));
        const flutter = app.project.framework === 'flutter';
        const reactNative = isNative(app.project.framework);
        const handle = (envelope: Envelope) => {
          const { event } = envelope;
          if (event.type === 'step') progress.report({ message: event.title });
          else if (event.type === 'step-progress') progress.report({ message: tidy(event.text) });
          else if (event.type === 'phase-skipped') progress.report({ message: `${phaseLabel(event.phase as TimelinePhase, { onMac: false, pc: false, flutter, reactNative })}: ${event.reason}` });
          else if (event.type === 'ipa-ready') ipa = { file: event.file, size: event.size };
          else if (event.type === 'session-ended') finish({ ok: event.ok && !event.cancelled, cancelled: event.cancelled, error: event.error ? tidy(event.error.message) : undefined, hint: event.error ? tidy(event.error.hint) : undefined });
        };
        const listener = this.model.onEnvelopes((batch) => {
          for (const envelope of batch) {
            if (!sessionId) {
              if (envelope.scope.projectPath && keyOf(envelope.scope.projectPath) === keyOf(app.project.dir)) early.push(envelope);
            } else if (envelope.scope.sessionId === sessionId) handle(envelope);
          }
        });
        try {
          sessionId = await start();
          for (const envelope of early.splice(0)) if (envelope.scope.sessionId === sessionId) handle(envelope);
          token.onCancellationRequested(() => void this.model.stopSession(sessionId!));
          const result = await done;
          resolve({ ...result, ipa });
        } catch (err) {
          const { message, hint } = errorText(err);
          resolve({ ok: false, cancelled: err instanceof EngineError && err.cancelled, error: message, hint });
        } finally {
          listener.dispose();
        }
      });
    });
  }

  /** `choice`: what to build through the Mac (pickIpa); on this PC the profile from setup decides. */
  async buildIpa(app: WorkspaceApp, choice: IpaChoice | null): Promise<void> {
    const onPc = this.model.backendOf(app) === 'wsl';
    if (!(await this.ready(app))) return;
    const result = await this.follow(app, s.ipa.building(app.app.name), async () => {
      if (onPc) return this.model.startSession(this.model.sessionParams(app, 'build'));
      return this.model.startIpaBuild({ projectPath: app.project.dir, mac: this.model.macFor(app)?.name, exportKind: choice?.exportKind ?? 'development', upload: choice?.upload || undefined, team: choice?.team, outDir: choice?.outDir });
    });
    if (result.cancelled) return;
    // Sent to App Store Connect: nothing comes back to this PC.
    if (result.ok && choice?.upload) {
      void vscode.window.showInformationMessage(s.ipa.uploaded(app.app.name));
      return;
    }
    if (!result.ok || !result.ipa) {
      const answer = await vscode.window.showErrorMessage(s.session.ipaFailed(app.app.name), { detail: [result.error, result.hint].filter(Boolean).join('\n') } as vscode.MessageOptions, s.session.showOutput);
      if (answer) this.output.show();
      return;
    }
    const file = result.ipa.file;
    const answer = await vscode.window.showInformationMessage(s.ipa.done(path.basename(file)), s.ipa.reveal, s.ipa.copyPath);
    if (answer === s.ipa.reveal) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
    else if (answer === s.ipa.copyPath) await vscode.env.clipboard.writeText(file);
  }

  /** Sync: files and plugins to the Mac, nothing built (with feature/run-options-console's engine). */
  async sync(app: WorkspaceApp): Promise<void> {
    if (!(await this.ready(app))) return;
    const mac = this.model.macFor(app);
    const result = await this.follow(app, s.session.syncing(mac?.label ?? studio.common.theMac), () => this.model.startSession(this.model.sessionParams(app, 'sync')));
    if (result.cancelled) return;
    if (result.ok) void vscode.window.showInformationMessage(s.session.synced(mac?.label ?? studio.common.theMac), { detail: s.session.syncedBody } as vscode.MessageOptions);
    else void vscode.window.showErrorMessage(s.session.syncFailed(app.app.name), { detail: [result.error, result.hint].filter(Boolean).join('\n') } as vscode.MessageOptions);
  }
}
