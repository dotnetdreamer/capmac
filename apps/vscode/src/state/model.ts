/**
 * The extension's model: the engine, and everything it knows about this
 * workspace (its apps, the Macs, their simulators and iPhones, this PC, the
 * runs). Views read it and listen to `onDidChange`; commands call its methods.
 *
 * The workspace is the project: CapMac looks for apps in its folders, and the
 * app being worked on is the one picked before, else the one around the file
 * that is open, else the one CapMac suggests.
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import type {
  AppSearch,
  Check,
  DetectedProject,
  Diagnostic,
  EngineStatus,
  Envelope,
  ErrorInfo,
  MacSummary,
  MethodParams,
  ProjectApp,
  ProjectSummary,
  PromptRequest,
  SessionMode,
  Target,
  TargetsResult,
  WslDevices,
  WslStatus,
} from '../../../desktop/src/shared/contract.js';
import type { HostInit } from '../../../desktop/src/shared/host-protocol.js';
import { EngineClient, EngineError } from '../engine/client.js';
import { s, studio, tidy } from '../i18n.js';
import { automaticTarget, keyOf, pcReady, WebBuildDiagnostics } from './pure.js';
import { emptyRun, isActive, MAC_TARGET_ID, PC_TARGET_ID, reduceRun, runningPhase, type RunState } from './runs.js';

export { automaticTarget, keyOf, pcReady };

/** The modes the contract's `sessions.start` takes (scripts/build.mjs reads them from contract.ts). */
declare const __CAPMAC_SESSION_MODES__: string[] | undefined;

export type RunnableApp = 'ios' | 'electron' | 'macos' | 'windows';
export type Backend = 'mac' | 'wsl';

export const RUNNABLE: readonly string[] = ['ios', 'electron', 'macos', 'windows'];

export interface WorkspaceApp {
  /** `<project key>#<app id>` */
  key: string;
  project: DetectedProject;
  app: ProjectApp;
  /** CapMac runs it (now, or once it is set up). */
  runnable: boolean;
}

/** Where the current app runs, as picked (unset fields: CapMac picks). */
export interface Destination {
  mac?: string;
  /** A simulator's or iPhone's udid. */
  target?: string;
}

/** Where the current app runs, resolved for display and for starting a session. */
export interface ResolvedDestination {
  kind: 'simulator' | 'device' | 'mac-desktop' | 'pc-desktop' | 'pc-iphone' | 'auto' | 'none';
  backend: Backend;
  /** The Mac it goes through (null: no Mac, or none paired). */
  mac: MacSummary | null;
  /** The simulator or iPhone, when one is picked or known. */
  target: Target | null;
  /** What the status bar and the Run view call it. */
  label: string;
  /** Mac name or "This PC", for the description. */
  detail: string;
}

export interface PcState {
  /** The project's folder, as the engine knows it. */
  path: string;
  status: WslStatus | null;
  devices: WslDevices | null;
  setupId: string | null;
  /** Setup steps as they run: engine phase → state. */
  phases: Record<string, { state: 'running' | 'done' | 'failed' | 'skipped'; detail?: string; bytes?: { received: number; total?: number; resumedFrom?: number }; fraction?: number }>;
  lines: string[];
}

export interface LogLine {
  ts: number;
  source: string;
  level: 'error' | 'warn' | 'info' | 'log' | 'debug';
  text: string;
}

export interface HealthState {
  checks: Check[];
  running: boolean;
  at: number | null;
  error: string | null;
}

export type Change = 'engine' | 'macs' | 'targets' | 'apps' | 'selection' | 'runs' | 'pc' | 'health';

const LOG_LIMIT = 3000;
const STATE_CURRENT = 'capmac.current';
const STATE_DEST = 'capmac.destinations';

export class Model implements vscode.Disposable {
  readonly client: EngineClient;
  engine: EngineStatus = { state: 'starting' };
  macs: MacSummary[] = [];
  readonly targets = new Map<string, TargetsResult | null>();
  readonly targetErrors = new Map<string, string>();
  readonly health = new Map<string, HealthState>();
  readonly searches = new Map<string, AppSearch>();
  readonly summaries = new Map<string, ProjectSummary>();
  readonly runs = new Map<string, RunState>();
  readonly pc = new Map<string, PcState>();
  readonly logs = new Map<string, LogLine[]>();
  /** Apps found, in order: by workspace folder, then as the engine lists them. */
  apps: WorkspaceApp[] = [];
  detecting = false;

  private readonly changed = new vscode.EventEmitter<Change>();
  readonly onDidChange = this.changed.event;
  private readonly envelopes = new vscode.EventEmitter<Envelope[]>();
  /** Every engine event, as it comes (debug sessions print their own). */
  readonly onEnvelopes = this.envelopes.event;
  private readonly disposables: vscode.Disposable[] = [];
  private watch: { mac: string; watchId: string } | null = null;
  /** The Mac whose simulators are watched, or about to be (its `targets.watch` call may be on its way). */
  private watchWanted: string | null = null;
  private pcTimer: NodeJS.Timeout | null = null;
  private detectTimer: NodeJS.Timeout | null = null;
  private focused = vscode.window.state.focused;
  private pendingChanges = new Set<Change>();
  private changeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
    private readonly prompts: { ask(prompt: PromptRequest): void; withdraw(id: string): void; reset(): void },
  ) {
    const dist = (...parts: string[]) => context.asAbsolutePath(path.join('dist', ...parts));
    const sample = (name: string) => (existsSync(dist('samples', name)) ? dist('samples', name) : null);
    // What the engine starts with; the React Native sample is for a host that knows it (feature/react-native).
    const init = (): HostInit & { reactNativeSampleDir: string | null } => ({
      agentPath: dist('agent', 'agent.mjs'),
      sampleDir: sample('hello-capacitor'),
      electronSampleDir: sample('hello-electron'),
      flutterSampleDir: sample('hello-flutter'),
      reactNativeSampleDir: sample('hello-react-native'),
      samplesHome: path.join(os.homedir(), 'Documents', 'CapMac'),
      remoteModulesDir: existsSync(dist('remote', 'node_modules')) ? dist('remote') : null,
      settings: this.hostSettings(),
    });
    this.client = new EngineClient(
      dist('engine.cjs'),
      init,
      {
        onEvents: (batch) => this.onEvents(batch),
        onPrompt: (prompt) => prompts.ask(prompt),
        onPromptWithdraw: (id) => prompts.withdraw(id),
        onStatus: (status) => {
          this.engine = status;
          this.emit('engine');
          if (status.state === 'ready') void this.refreshAll();
          if (status.state === 'crashed') this.engineStopped();
        },
        onLog: (level, message) => {
          // The engine may still print while VS Code shuts down, after the log is gone.
          try {
            if (level === 'error') output.error(message);
            else output.info(message);
          } catch {
            // closed
          }
        },
      },
    );
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleDetect(0)),
      vscode.window.onDidChangeActiveTextEditor(() => this.emit('selection')),
      vscode.window.onDidChangeWindowState((state) => this.setFocused(state.focused)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('capmac.verbose') || e.affectsConfiguration('capmac.osLogs')) this.client.setSettings(this.hostSettings());
      }),
    );
    // A new app, a renamed app or another platform folder: look again.
    const watcher = vscode.workspace.createFileSystemWatcher('**/{capacitor.config.json,capacitor.config.ts,capacitor.config.js,pubspec.yaml,capmac.json,package.json,app.json,metro.config.js,metro.config.ts,Runner.xcodeproj/project.pbxproj,CMakeLists.txt}');
    this.disposables.push(watcher, watcher.onDidCreate(() => this.scheduleDetect()), watcher.onDidDelete(() => this.scheduleDetect()), watcher.onDidChange(() => this.scheduleDetect()));
  }

  start(): void {
    this.client.start();
  }

  private hostSettings() {
    const config = vscode.workspace.getConfiguration('capmac');
    return { verbose: config.get<boolean>('verbose', false), osLogs: config.get<boolean>('osLogs', false) };
  }

  /** Change notifications, coalesced: one per kind every 50 ms at most. */
  emit(change: Change): void {
    this.pendingChanges.add(change);
    this.changeTimer ??= setTimeout(() => {
      this.changeTimer = null;
      const changes = [...this.pendingChanges];
      this.pendingChanges.clear();
      for (const c of changes) this.changed.fire(c);
    }, 50);
  }

  private setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    // Nobody is looking: stop asking the Mac for its simulators (and this PC for iPhones).
    this.client.setVisible(focused);
    this.syncWatches();
  }

  // ─── Engine events ───────────────────────────────────────────────────────

  /**
   * The engine stopped, and what it was doing with it: its runs end (their
   * debug sessions and progress with them), this PC's setup too, its questions
   * can't be answered any more, and the simulator watch is gone. A new engine
   * starts with none of them.
   */
  private engineStopped(): void {
    this.prompts.reset();
    this.watch = null;
    this.watchWanted = null;
    const error: ErrorInfo = { message: studio.engine.stopped, hint: studio.engine.restartingBody, code: 'ENGINE_CRASHED', expected: true };
    const now = Date.now();
    const batch: Envelope[] = [];
    for (const run of this.runs.values()) {
      if (!run.sessionId) continue;
      const mode = (run.mode === 'sync' ? 'run' : run.mode ?? 'run') as SessionMode;
      batch.push({ scope: { sessionId: run.sessionId, projectPath: run.path }, event: { type: 'session-ended', mode, ok: false, cancelled: false, error, ms: run.startedAt ? now - run.startedAt : 0 } });
    }
    for (const state of this.pc.values()) {
      if (state.setupId) batch.push({ scope: { setup: state.path }, event: { type: 'setup-ended', ok: false, cancelled: false, error } });
    }
    if (batch.length) this.onEvents(batch);
  }

  /** Per session: the compiler errors in the output of the web build this PC runs. */
  private readonly webBuilds = new Map<string, WebBuildDiagnostics>();

  /** The web build's TypeScript, esbuild and Vite errors arrive only as output: read them, so they go to Problems like Xcode's. */
  private webDiagnostics(scope: Envelope['scope'], event: Envelope['event'], run: RunState): Diagnostic[] {
    if (event.type !== 'tool-output' || !scope.sessionId || !scope.projectPath || runningPhase(run) !== 'web') return [];
    let build = this.webBuilds.get(scope.sessionId);
    if (!build) this.webBuilds.set(scope.sessionId, (build = new WebBuildDiagnostics(scope.projectPath)));
    return build.push(event.text);
  }

  private onEvents(incoming: Envelope[]): void {
    const changes = new Set<Change>();
    const batch = [...incoming];
    for (let i = 0; i < batch.length; i++) {
      const { scope, event } = batch[i]!;
      if (scope.projectPath) {
        const key = keyOf(scope.projectPath);
        const run = this.runs.get(key) ?? emptyRun(scope.projectPath);
        const next = reduceRun(run, event, scope.sessionId);
        if (next !== run) {
          this.runs.set(key, next);
          changes.add('runs');
        }
        this.recordLog(key, event);
        // Errors in the web build's output follow the line that completed them.
        const found = this.webDiagnostics(scope, event, next);
        if (found.length) batch.splice(i + 1, 0, ...found.map((diagnostic): Envelope => ({ scope, event: { type: 'diagnostic', diagnostic } })));
        if (event.type === 'session-ended' && scope.sessionId) this.webBuilds.delete(scope.sessionId);
      }
      if (scope.setup) {
        this.applySetup(scope.setup, event);
        changes.add('pc');
      }
      switch (event.type) {
        case 'macs-changed':
          void this.refreshMacs();
          break;
        case 'connection': {
          const mac = this.macs.find((m) => m.name === event.mac);
          if (mac) {
            const state = event.state === 'restored' ? 'connected' : event.state;
            Object.assign(mac, { state, latencyMs: event.latencyMs ?? mac.latencyMs, error: event.error ?? (state === 'connected' ? null : mac.error), route: event.route ?? mac.route, rttMs: event.rttMs ?? mac.rttMs });
            changes.add('macs');
          }
          break;
        }
        case 'targets':
          if (scope.mac) {
            this.targets.set(scope.mac, event.targets);
            this.targetErrors.delete(scope.mac);
            changes.add('targets');
          }
          break;
        case 'error':
          // A target watch that can't reach the Mac.
          if (scope.mac && !scope.projectPath && !scope.sessionId) {
            this.targetErrors.set(scope.mac, tidy(event.error.message));
            changes.add('targets');
          }
          break;
        case 'check':
          if (scope.mac) {
            const health = this.health.get(scope.mac) ?? { checks: [], running: true, at: null, error: null };
            health.checks = [...health.checks.filter((c) => c.id !== event.check.id), event.check];
            this.health.set(scope.mac, health);
            changes.add('health');
          }
          break;
        case 'session-ended':
          if (scope.projectPath) {
            // A run may have changed the remembered target, app or backend.
            void this.refreshSummary(scope.projectPath);
          }
          break;
      }
    }
    for (const change of changes) this.emit(change);
    this.envelopes.fire(batch);
  }

  private recordLog(key: string, event: Envelope['event']): void {
    let line: LogLine | null = null;
    const now = Date.now();
    if (event.type === 'app-log') line = { ts: event.entry.ts, source: event.entry.kind, level: event.entry.level, text: event.entry.text };
    else if (event.type === 'log' && event.level !== 'debug') line = { ts: now, source: 'capmac', level: event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info', text: event.hint ? `${event.message} → ${event.hint}` : event.message };
    else if (event.type === 'error') line = { ts: now, source: 'capmac', level: 'error', text: event.error.hint ? `${event.error.message} → ${event.error.hint}` : event.error.message };
    else if (event.type === 'devserver-output') line = { ts: now, source: 'web', level: /\berror\b/i.test(event.text) ? 'error' : /\bwarn/i.test(event.text) ? 'warn' : 'log', text: event.text };
    else if (event.type === 'session-ended' && !event.ok && event.error) line = { ts: now, source: 'capmac', level: 'error', text: event.error.hint ? `${event.error.message} → ${event.error.hint}` : event.error.message };
    if (!line) return;
    let lines = this.logs.get(key);
    if (!lines) this.logs.set(key, (lines = []));
    lines.push(line);
    if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
  }

  private applySetup(projectPath: string, event: Envelope['event']): void {
    const state = this.pcFor(projectPath);
    if (event.type === 'wsl-setup') {
      if (event.phase !== 'complete') state.phases[event.phase] = { state: event.state, detail: event.detail, bytes: event.bytes, fraction: event.fraction };
    } else if (event.type === 'tool-output' || event.type === 'log') {
      const text = event.type === 'log' ? event.message : event.text;
      state.lines.push(...text.split(/\r?\n/).filter(Boolean));
      if (state.lines.length > 200) state.lines.splice(0, state.lines.length - 200);
    } else if (event.type === 'setup-ended') {
      state.setupId = null;
      void this.refreshPc(projectPath);
    }
  }

  pcFor(projectPath: string): PcState {
    const key = keyOf(projectPath);
    let state = this.pc.get(key);
    if (!state) this.pc.set(key, (state = { path: projectPath, status: null, devices: null, setupId: null, phases: {}, lines: [] }));
    return state;
  }

  // ─── Refreshing ──────────────────────────────────────────────────────────

  private async refreshAll(): Promise<void> {
    await Promise.all([this.refreshMacs(), this.detect()]);
    this.syncWatches();
  }

  async refreshMacs(): Promise<void> {
    const result = await this.client.call('macs.list', {});
    if (!result.ok) return;
    this.macs = result.value;
    this.emit('macs');
    this.syncWatches();
  }

  scheduleDetect(delay = 800): void {
    if (this.detectTimer) clearTimeout(this.detectTimer);
    this.detectTimer = setTimeout(() => {
      this.detectTimer = null;
      void this.detect();
    }, delay);
  }

  /** Looks for apps in every workspace folder (reads files only: quick). */
  async detect(): Promise<void> {
    if (this.engine.state !== 'ready') return;
    const folders = vscode.workspace.workspaceFolders?.filter((f) => f.uri.scheme === 'file') ?? [];
    this.detecting = true;
    this.emit('apps');
    const searches = await Promise.all(folders.map(async (folder) => [folder.uri.fsPath, await this.client.call('projects.detect', { path: folder.uri.fsPath })] as const));
    this.searches.clear();
    const seen = new Set<string>();
    const apps: WorkspaceApp[] = [];
    for (const [folder, result] of searches) {
      if (!result.ok) {
        this.output.warn(`Looking for apps in ${folder}: ${result.error.message}`);
        continue;
      }
      this.searches.set(keyOf(folder), result.value);
      for (const project of result.value.projects) {
        const projectKey = keyOf(project.dir);
        for (const app of project.apps) {
          const key = `${projectKey}#${app.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          apps.push({ key, project, app, runnable: app.status !== 'unsupported' && RUNNABLE.includes(app.id) });
        }
      }
    }
    this.apps = apps;
    this.detecting = false;
    this.emit('apps');
    this.emit('selection');
    const current = this.current();
    if (current) await this.refreshSummary(current.project.dir);
    this.syncWatches();
  }

  async refreshSummary(projectPath: string): Promise<ProjectSummary | null> {
    const result = await this.client.call('projects.inspect', { path: projectPath });
    if (!result.ok) return null;
    this.summaries.set(keyOf(projectPath), result.value);
    this.emit('selection');
    this.syncWatches();
    return result.value;
  }

  async refreshPc(projectPath: string, devices = true): Promise<void> {
    if (process.platform !== 'win32') return;
    const state = this.pcFor(projectPath);
    const status = await this.client.call('wsl.status', { projectPath });
    if (status.ok) {
      state.status = status.value;
      state.setupId = status.value.setupId;
    }
    if (devices && pcReady(state.status)) {
      const list = await this.client.call('wsl.devices', { projectPath });
      if (list.ok) state.devices = list.value;
    }
    this.emit('pc');
  }

  async refreshTargets(mac: string): Promise<TargetsResult | null> {
    const result = await this.client.call('targets.list', { mac });
    if (result.ok) {
      this.targets.set(mac, result.value);
      this.targetErrors.delete(mac);
    } else {
      this.targetErrors.set(mac, tidy(result.error.message));
    }
    this.emit('targets');
    return result.ok ? result.value : null;
  }

  async checkMac(mac: string): Promise<HealthState> {
    const current = this.current();
    const health: HealthState = { checks: [], running: true, at: null, error: null };
    this.health.set(mac, health);
    this.emit('health');
    const result = await this.client.call('macs.health', { name: mac, projectPath: current?.project.dir });
    health.running = false;
    health.at = Date.now();
    if (result.ok) health.checks = result.value.checks;
    else health.error = tidy(result.error.message);
    this.emit('health');
    return health;
  }

  /** Watches the simulators of the Mac the current app uses, and this PC's iPhones, while VS Code has focus. */
  syncWatches(): void {
    if (this.engine.state !== 'ready') return;
    const current = this.current();
    const dest = current ? this.resolveDestination(current) : null;
    const wantMac = this.focused && current && dest?.backend === 'mac' && current.app.id === 'ios' ? dest.mac?.name ?? null : null;
    if (this.watchWanted !== wantMac) {
      this.watchWanted = wantMac;
      const old = this.watch;
      this.watch = null;
      if (old) void this.client.call('targets.unwatch', { watchId: old.watchId });
      if (wantMac) {
        void this.client.call('targets.watch', { mac: wantMac }).then((result) => {
          if (!result.ok) {
            // The next look (focus, another app) tries again.
            if (this.watchWanted === wantMac && !this.watch) this.watchWanted = null;
            return;
          }
          // Another Mac is wanted by now (or none): this watch is nobody's.
          if (this.watchWanted !== wantMac || this.watch) {
            void this.client.call('targets.unwatch', { watchId: result.value.watchId });
            return;
          }
          this.watch = { mac: wantMac, watchId: result.value.watchId };
          if (result.value.targets) {
            this.targets.set(wantMac, result.value.targets);
            this.emit('targets');
          }
        });
      }
    }
    // This PC: the setup's state, and the iPhones plugged in (every 5 s).
    const wantPc = this.focused && current && dest?.backend === 'wsl' ? current.project.dir : null;
    if (this.pcTimer) {
      clearInterval(this.pcTimer);
      this.pcTimer = null;
    }
    if (wantPc) {
      void this.refreshPc(wantPc);
      this.pcTimer = setInterval(() => void this.refreshPc(wantPc), 5000);
    }
  }

  // ─── The app being worked on ─────────────────────────────────────────────

  runnableApps(): WorkspaceApp[] {
    return this.apps.filter((a) => a.runnable);
  }

  /** The app Run and Live use. */
  current(): WorkspaceApp | null {
    const runnable = this.runnableApps();
    if (!runnable.length) return null;
    const saved = this.context.workspaceState.get<{ dir: string; app: string }>(STATE_CURRENT);
    const projectApps = (dir: string) => runnable.filter((a) => keyOf(a.project.dir) === keyOf(dir));
    const best = (candidates: WorkspaceApp[]) => {
      if (!candidates.length) return null;
      const project = candidates[0]!.project;
      const summary = this.summaries.get(keyOf(project.dir));
      // The engine's own pick (shared with the CLI and CapMac Studio), else the project's first app.
      const chosen = summary?.app ?? project.chosen;
      return candidates.find((a) => a.app.id === chosen) ?? candidates.find((a) => a.app.status === 'ready') ?? candidates[0]!;
    };
    if (saved) {
      const inProject = projectApps(saved.dir);
      const exact = inProject.find((a) => a.app.id === saved.app);
      if (exact) {
        const summary = this.summaries.get(keyOf(saved.dir));
        // The CLI or Studio may have picked another app of this project since.
        if (summary && summary.appChosen && summary.app !== saved.app) return best(inProject);
        return exact;
      }
      if (inProject.length) return best(inProject);
    }
    // The project around the file that is open.
    const file = vscode.window.activeTextEditor?.document.uri;
    if (file?.scheme === 'file') {
      const fileKey = keyOf(file.fsPath);
      const around = [...new Set(runnable.map((a) => a.project))]
        .filter((p) => fileKey === keyOf(p.dir) || fileKey.startsWith(`${keyOf(p.dir)}${path.sep}`))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      if (around) return best(projectApps(around.dir));
    }
    for (const search of this.searches.values()) {
      const suggested = search.suggested;
      if (suggested) {
        const app = runnable.find((a) => keyOf(a.project.dir) === keyOf(suggested.dir) && a.app.id === suggested.app);
        if (app) return app;
      }
    }
    return best(projectApps(runnable[0]!.project.dir));
  }

  summaryOf(app: WorkspaceApp | null): ProjectSummary | null {
    return app ? this.summaries.get(keyOf(app.project.dir)) ?? null : null;
  }

  runOf(app: WorkspaceApp | null): RunState | null {
    return app ? this.runs.get(keyOf(app.project.dir)) ?? null : null;
  }

  /** Makes `app` the one Run and Live use (the CLI and CapMac Studio use it too). */
  async useApp(app: WorkspaceApp): Promise<void> {
    await this.context.workspaceState.update(STATE_CURRENT, { dir: app.project.dir, app: app.app.id });
    if (RUNNABLE.includes(app.app.id)) {
      const result = await this.client.call('projects.setApp', { path: app.project.dir, app: app.app.id as RunnableApp });
      if (result.ok) this.summaries.set(keyOf(app.project.dir), result.value);
      else this.output.warn(`Choosing the ${app.app.id} app: ${result.error.message}`);
    }
    this.emit('selection');
    this.syncWatches();
  }

  // ─── Where it runs ───────────────────────────────────────────────────────

  destinationOf(app: WorkspaceApp): Destination {
    const all = this.context.workspaceState.get<Record<string, Destination>>(STATE_DEST, {});
    return all[app.key] ?? {};
  }

  async setDestination(app: WorkspaceApp, dest: Destination): Promise<void> {
    const all = { ...this.context.workspaceState.get<Record<string, Destination>>(STATE_DEST, {}) };
    all[app.key] = dest;
    await this.context.workspaceState.update(STATE_DEST, all);
    this.emit('selection');
    this.syncWatches();
  }

  /** Where the project's iOS app builds: the engine's choice, shared with the CLI and Studio. */
  backendOf(app: WorkspaceApp): Backend {
    if (app.app.id !== 'ios') return 'mac';
    return this.summaryOf(app)?.backend ?? 'mac';
  }

  async setBackend(app: WorkspaceApp, backend: Backend): Promise<void> {
    const result = await this.client.call('projects.setBackend', { path: app.project.dir, backend });
    if (!result.ok) throw new EngineError(result.error);
    this.summaries.set(keyOf(app.project.dir), result.value);
    this.emit('selection');
    this.syncWatches();
    if (backend === 'wsl') void this.refreshPc(app.project.dir);
  }

  /** The Mac a session for `app` goes through: the one picked, else the project's capmac.json host, else the default. */
  macFor(app: WorkspaceApp): MacSummary | null {
    const picked = this.destinationOf(app).mac;
    const summary = this.summaryOf(app);
    const byName = (name: string | null | undefined) => (name ? this.macs.find((m) => m.name === name || m.host === name || m.label === name) ?? null : null);
    return byName(picked) ?? byName(summary?.host) ?? this.macs.find((m) => m.isDefault) ?? (this.macs.length === 1 ? this.macs[0]! : null);
  }

  resolveDestination(app: WorkspaceApp): ResolvedDestination {
    const id = app.app.id as RunnableApp;
    const backend = this.backendOf(app);
    if (id === 'windows') return { kind: 'pc-desktop', backend: 'mac', mac: null, target: null, label: s.devices.windowsDesktop, detail: s.devices.thisPc };
    if (id === 'ios' && backend === 'wsl') {
      const pc = this.pc.get(keyOf(app.project.dir));
      const picked = this.destinationOf(app).target;
      const devices = pc?.devices?.devices ?? [];
      const phone = devices.find((d) => d.udid === picked) ?? (devices.length === 1 ? devices[0]! : null);
      return { kind: 'pc-iphone', backend, mac: null, target: phone, label: phone?.name ?? s.devices.pcIphones, detail: s.devices.thisPc };
    }
    const mac = this.macFor(app);
    if (!mac) return { kind: 'none', backend, mac: null, target: null, label: s.status.pairMac, detail: '' };
    if (id === 'electron' || id === 'macos') return { kind: 'mac-desktop', backend, mac, target: null, label: s.devices.macDesktop, detail: mac.label };
    const targets = this.targets.get(mac.name);
    const picked = this.destinationOf(app).target;
    const all = targets ? [...targets.simulators, ...targets.devices] : [];
    const target = picked ? all.find((t) => t.udid === picked) ?? null : null;
    if (target) return { kind: target.kind === 'device' ? 'device' : 'simulator', backend, mac, target, label: target.name, detail: mac.label };
    // Not picked (or not listed yet): what CapMac will pick, as Studio shows it.
    const run = this.runOf(app);
    const last = run?.target && run.target.kind !== 'mac' && run.target.kind !== 'pc' ? run.target : null;
    const auto = last ?? automaticTarget(targets);
    if (picked && !targets) return { kind: 'simulator', backend, mac, target: null, label: run?.target?.udid === picked ? run.target.name : s.run.chooseTarget, detail: mac.label };
    return { kind: 'auto', backend, mac, target: auto, label: auto?.name ?? s.run.autoTarget, detail: mac.label };
  }

  /** Whether the current destination shows a picture CapMac can stream. */
  screenFor(app: WorkspaceApp): { mac: string; udid: string; projectPath?: string; device?: { name: string }; name: string } | null {
    const dest = this.resolveDestination(app);
    if (!dest.mac) return null;
    if (dest.kind === 'mac-desktop') return { mac: dest.mac.name, udid: MAC_TARGET_ID, projectPath: app.project.dir, name: app.app.name };
    const run = this.runOf(app);
    // The one it runs on now, else the one it will run on.
    const target = (isActive(run ?? undefined) && run?.target && (run.target.kind === 'simulator' || run.target.kind === 'device') ? run.target : null) ?? dest.target;
    if (!target) return null;
    return { mac: dest.mac.name, udid: target.udid, device: target.kind === 'device' ? { name: target.name } : undefined, name: target.name };
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  /** Whether this build of the engine knows a mode (Sync arrives with feature/run-options-console); read from the contract at build time. */
  supportsMode(mode: string): boolean {
    const modes = typeof __CAPMAC_SESSION_MODES__ !== 'undefined' ? __CAPMAC_SESSION_MODES__ : ['run', 'live'];
    return modes.includes(mode);
  }

  /** The parameters `sessions.start` takes for `app` where it runs now (see the host's startSession). */
  sessionParams(app: WorkspaceApp, mode: 'run' | 'live' | 'build' | 'sync', options: NonNullable<MethodParams<'sessions.start'>['options']> = {}, overrides: { target?: string; mac?: string; backend?: Backend } = {}): MethodParams<'sessions.start'> {
    const id = app.app.id as RunnableApp;
    const dest = this.resolveDestination(app);
    const backend = overrides.backend ?? dest.backend;
    const base = { projectPath: app.project.dir, mode: mode as MethodParams<'sessions.start'>['mode'], app: id };
    if (id === 'windows') return { ...base, target: PC_TARGET_ID, options };
    if (id === 'electron' || id === 'macos') return { ...base, mac: overrides.mac ?? dest.mac?.name, target: MAC_TARGET_ID, options };
    if (backend === 'wsl') {
      const picked = overrides.target ?? this.destinationOf(app).target;
      // Only an iPhone that is plugged in now; otherwise the engine asks which.
      const plugged = this.pc.get(keyOf(app.project.dir))?.devices?.devices.some((d) => d.udid === picked);
      return { ...base, backend: 'wsl', target: plugged ? picked : undefined, options: { clean: options.clean, flutterMode: options.flutterMode } };
    }
    const target = overrides.target ?? this.destinationOf(app).target;
    return { ...base, backend: 'mac', mac: overrides.mac ?? dest.mac?.name, target: mode === 'sync' ? undefined : target, options: { ...options, osLogs: options.osLogs ?? this.hostSettings().osLogs } };
  }

  /** Per project, the start on its way. */
  private readonly starts = new Map<string, Promise<unknown>>();

  /**
   * Starts for one project, one after the other: the engine stops a project's
   * session when another starts, but only one it already knows of (two starts
   * at once would both run).
   */
  private inOrder<T>(projectPath: string, start: () => Promise<T>): Promise<T> {
    const key = keyOf(projectPath);
    const next = (this.starts.get(key) ?? Promise.resolve()).catch(() => undefined).then(start);
    this.starts.set(key, next);
    void next.finally(() => this.starts.get(key) === next && this.starts.delete(key)).catch(() => undefined);
    return next;
  }

  startSession(params: MethodParams<'sessions.start'>): Promise<string> {
    return this.inOrder(params.projectPath, async () => (await this.client.invoke('sessions.start', params)).sessionId);
  }

  /** An IPA build on the Mac (on this PC it is a `build` session). */
  startIpaBuild(params: MethodParams<'builds.ipa'>): Promise<string> {
    return this.inOrder(params.projectPath, async () => (await this.client.invoke('builds.ipa', params)).sessionId);
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.client.call('sessions.stop', { sessionId });
  }

  /** The live session of `app`, if one runs. */
  activeSession(app: WorkspaceApp | null): RunState | null {
    const run = this.runOf(app);
    return run && isActive(run) ? run : null;
  }

  dispose(): void {
    if (this.pcTimer) clearInterval(this.pcTimer);
    if (this.detectTimer) clearTimeout(this.detectTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
    this.envelopes.dispose();
  }
}

/** An engine error's words for a notification. */
export function errorText(error: ErrorInfo | EngineError | unknown): { message: string; hint?: string } {
  const info = error instanceof EngineError ? error.info : (error as ErrorInfo | undefined);
  if (info && typeof info === 'object' && 'message' in info) return { message: tidy(info.message), hint: tidy(info.hint) };
  return { message: String((error as Error)?.message ?? error) };
}
