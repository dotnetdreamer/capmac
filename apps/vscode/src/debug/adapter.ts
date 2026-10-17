/**
 * A CapMac run as a VS Code debug session: F5 (live reload) and Ctrl+F5
 * (run), Stop and Restart on the debug toolbar, the app's console in the Debug
 * Console. The adapter runs inside the extension (no process of its own) and
 * drives the engine's session; it does not debug code (no breakpoints).
 *
 * In the Debug Console, typed commands work like the CLI's keys: r reload,
 * R restart, b rebuild, j React Native DevTools, s screenshot, o screen, q stop.
 */
import * as vscode from 'vscode';
import type { AppLogEntry, Envelope, ErrorInfo, HostEvent } from '../../../desktop/src/shared/contract.js';
import { EngineError } from '../engine/client.js';
import { s, studio, tidy } from '../i18n.js';
import { keyOf, type Model, type RunnableApp, type WorkspaceApp } from '../state/model.js';
import { HAS_DEVTOOLS, sourceOf } from '../state/pure.js';
import { isNative, phaseLabel, type TimelinePhase } from '../state/runs.js';

export interface CapmacLaunch extends vscode.DebugConfiguration {
  mode?: 'run' | 'live';
  projectPath?: string;
  app?: RunnableApp;
  target?: string;
  mac?: string;
  backend?: 'mac' | 'wsl';
  webBuild?: boolean;
  clean?: boolean;
  full?: boolean;
  configuration?: string;
  flutterMode?: 'debug' | 'profile' | 'release';
  screen?: boolean;
}

/** The commands the session's owner offers the adapter (screenshot, screen, live actions). */
export interface SessionActions {
  reload(app: WorkspaceApp): Promise<void>;
  restart(app: WorkspaceApp): Promise<void>;
  rebuild(app: WorkspaceApp, clean?: boolean): Promise<void>;
  screenshot(app: WorkspaceApp): Promise<unknown>;
  showScreen(app: WorkspaceApp): Promise<void>;
  /** React Native DevTools for the app in live reload. */
  devtools(app: WorkspaceApp): Promise<void>;
  /** The run started: open the screen when that's wanted. */
  started(app: WorkspaceApp, config: CapmacLaunch): void;
}

interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  arguments?: any;
  event?: string;
}

const ESC = '\u001b[';
const paint = {
  dim: (t: string) => `${ESC}2m${t}${ESC}0m`,
  red: (t: string) => `${ESC}31m${t}${ESC}0m`,
  yellow: (t: string) => `${ESC}33m${t}${ESC}0m`,
  green: (t: string) => `${ESC}32m${t}${ESC}0m`,
  cyan: (t: string) => `${ESC}36m${t}${ESC}0m`,
  magenta: (t: string) => `${ESC}35m${t}${ESC}0m`,
  bold: (t: string) => `${ESC}1m${t}${ESC}0m`,
};

export class CapmacDebugAdapter implements vscode.DebugAdapter {
  private readonly sent = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.sent.event;
  private seq = 1;
  private sessionId: string | null = null;
  private config: CapmacLaunch;
  private app: WorkspaceApp | null = null;
  private readonly early: Envelope[] = [];
  private listening: vscode.Disposable | null = null;
  private ended: Promise<void>;
  private markEnded!: () => void;
  private terminated = false;
  /** Stop was pressed: nothing starts after that, not even a start already on its way. */
  private stopRequested = false;
  private progressId: string | null = null;
  private readonly steps = new Map<string, string>();
  private readonly flutter: boolean;
  /** A React Native (or Expo) app: Metro, Fast Refresh, DevTools. */
  private readonly reactNative: boolean;

  /** `j` opens React Native DevTools (with an engine that has them). */
  private get devtools(): boolean {
    return this.reactNative && HAS_DEVTOOLS;
  }
  private readonly showBridge = vscode.workspace.getConfiguration('capmac').get<boolean>('console.bridge', false);
  private readonly showSteps = vscode.workspace.getConfiguration('capmac').get<boolean>('console.buildSteps', true);
  private readonly verbose = vscode.workspace.getConfiguration('capmac').get<boolean>('verbose', false);

  constructor(private readonly model: Model, session: vscode.DebugSession, private readonly actions: SessionActions) {
    this.config = session.configuration as CapmacLaunch;
    this.app = findApp(model, this.config);
    this.flutter = this.app?.project.framework === 'flutter';
    this.reactNative = isNative(this.app?.project.framework ?? '');
    this.ended = new Promise((resolve) => (this.markEnded = resolve));
  }

  // ─── Protocol ────────────────────────────────────────────────────────────

  private send(message: Omit<DapMessage, 'seq'> & Record<string, unknown>): void {
    this.sent.fire({ seq: this.seq++, ...message } as vscode.DebugProtocolMessage);
  }

  private respond(request: DapMessage, body?: unknown, error?: string): void {
    this.send({ type: 'response', request_seq: request.seq, command: request.command, success: !error, message: error, body });
  }

  private event(event: string, body?: unknown): void {
    this.send({ type: 'event', event, body });
  }

  private print(text: string, category: 'console' | 'stdout' | 'stderr' = 'console', source?: { path: string; line: number } | null): void {
    this.event('output', {
      category,
      output: text.endsWith('\n') ? text : `${text}\n`,
      ...(source ? { source: { path: source.path, name: source.path.split(/[\\/]/).pop() }, line: source.line } : {}),
    });
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const request = message as DapMessage;
    if (request.type !== 'request') return;
    void this.handle(request).catch((err) => this.respond(request, undefined, String((err as Error)?.message ?? err)));
  }

  private async handle(request: DapMessage): Promise<void> {
    switch (request.command) {
      case 'initialize':
        this.respond(request, {
          supportsConfigurationDoneRequest: true,
          supportsRestartRequest: true,
          supportsTerminateRequest: true,
          supportsCompletionsRequest: true,
          completionTriggerCharacters: [],
          supportsEvaluateForHovers: false,
        });
        this.event('initialized');
        return;
      case 'launch':
        await this.launch(request);
        return;
      case 'configurationDone':
        this.respond(request);
        return;
      case 'threads':
        this.respond(request, { threads: [] });
        return;
      case 'pause':
        this.respond(request, undefined, 'CapMac runs your app without a debugger, so it can’t pause it');
        return;
      case 'restart':
        await this.restart(request);
        return;
      case 'disconnect':
      case 'terminate':
        await this.stop();
        this.respond(request);
        return;
      case 'evaluate':
        await this.evaluate(request);
        return;
      case 'completions':
        this.respond(request, { targets: ['r', 'R', 'b', ...(this.devtools ? ['j'] : []), 's', 'o', 'q', 'help'].map((label) => ({ label, type: 'function' })) });
        return;
      default:
        this.respond(request);
    }
  }

  // ─── Running ─────────────────────────────────────────────────────────────

  private async launch(request: DapMessage): Promise<void> {
    const app = this.app;
    if (!app) {
      this.respond(request, undefined, s.session.noApp);
      return;
    }
    // Listen before starting: the engine's first events come before the session's id does.
    this.listening ??= this.model.onEnvelopes((batch) => this.onBatch(batch));
    const mode = this.config.mode ?? (this.config.noDebug ? 'run' : 'live');
    const params = this.model.sessionParams(app, mode, {
      clean: this.config.clean,
      full: this.config.full,
      configuration: this.config.configuration,
      webBuild: this.config.webBuild,
      flutterMode: mode === 'run' ? this.config.flutterMode : undefined,
    }, { target: this.config.target, mac: this.config.mac, backend: this.config.backend });
    const dest = this.model.resolveDestination(app);
    this.print(paint.bold(`${mode === 'live' ? '⚡' : '▶'} ${s.console.started(mode === 'live' ? studio.common.live : studio.common.run, app.app.name, dest.detail ? `${dest.label} · ${dest.detail}` : dest.label)}`));
    this.print(paint.dim(this.devtools && mode === 'live' ? s.console.helpReactNative : s.console.help));
    try {
      this.sessionId = await this.model.startSession(params);
    } catch (err) {
      const info = err instanceof EngineError ? err.info : null;
      this.printError(info ?? { message: String((err as Error).message), expected: true });
      this.respond(request);
      this.finish(false);
      return;
    }
    this.respond(request);
    if (this.stopRequested) {
      // Stopped while it started: the engine's session goes too.
      void this.model.stopSession(this.sessionId).catch(() => undefined);
      return;
    }
    // Replay what came before the id.
    const early = this.early.splice(0);
    for (const envelope of early) this.onEnvelope(envelope);
    this.actions.started(app, { ...this.config, mode });
  }

  private onBatch(batch: Envelope[]): void {
    for (const envelope of batch) {
      if (!this.sessionId) {
        if (this.app && envelope.scope.projectPath && keyOf(envelope.scope.projectPath) === keyOf(this.app.project.dir)) this.early.push(envelope);
        continue;
      }
      this.onEnvelope(envelope);
    }
  }

  private onEnvelope({ scope, event }: Envelope): void {
    // A Mac's connection is the Mac's (its scope has no session): shown while this run uses that Mac.
    if (event.type === 'connection') {
      if (!this.terminated && event.mac === this.model.runOf(this.app)?.mac) this.render(event);
      return;
    }
    if (scope.sessionId !== this.sessionId) return;
    this.render(event);
  }

  private render(event: HostEvent): void {
    switch (event.type) {
      case 'step':
        this.steps.set(event.id, event.title);
        if (this.showSteps && event.phase !== 'launch') this.print(paint.dim(`› ${event.title}…`));
        this.progress(event.title);
        break;
      case 'step-progress':
        this.progress(undefined, event.text);
        break;
      case 'step-end': {
        const title = this.steps.get(event.id) ?? '';
        this.steps.delete(event.id);
        if (this.showSteps || event.status === 'failed') {
          const mark = event.status === 'ok' ? paint.green('✓') : event.status === 'failed' ? paint.red('✗') : paint.dim('○');
          const detail = [event.detail, event.ms ? s.time.seconds(event.ms) : null].filter(Boolean).join(' · ');
          this.print(`${mark} ${title}${detail ? `  ${paint.dim(detail)}` : ''}`);
        }
        this.endProgress();
        break;
      }
      case 'phase-skipped':
        if (this.showSteps) this.print(paint.dim(`○ ${s.console.skipped(phaseLabel(event.phase as TimelinePhase, { onMac: false, pc: false, flutter: this.flutter, reactNative: this.reactNative }), event.reason)}`));
        break;
      case 'diagnostic': {
        const d = event.diagnostic;
        if (d.severity === 'note' || (!d.own && d.severity !== 'error' && !this.verbose)) break;
        const where = d.file ? `${d.file}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''}: ` : '';
        const text = `${where}${d.severity}: ${d.message}`;
        this.print(d.severity === 'error' ? paint.red(text) : paint.yellow(text), 'stderr', d.file && d.line && /^[A-Za-z]:\\|^\\\\/.test(d.file) ? { path: d.file, line: d.line } : null);
        break;
      }
      case 'app-log':
        this.appLog(event.entry);
        break;
      case 'log': {
        if (event.level === 'debug' && !this.verbose) break;
        const text = event.level === 'error' ? paint.red(tidy(event.message)) : event.level === 'warn' ? paint.yellow(tidy(event.message)) : event.level === 'success' ? paint.green(tidy(event.message)) : event.level === 'note' || event.level === 'debug' ? paint.dim(tidy(event.message)) : tidy(event.message);
        this.print(text, event.level === 'error' ? 'stderr' : 'console');
        if (event.hint) this.print(paint.dim(s.console.hint(tidy(event.hint))));
        break;
      }
      case 'error':
        if (!event.error.cancelled) this.printError(event.error);
        break;
      case 'tool-output':
        if (this.verbose) this.print(paint.dim(event.text.replace(/\n$/, '')));
        break;
      case 'devserver-output':
        this.print(`${paint.cyan('web │')} ${event.text.replace(/\n$/, '')}`, 'stdout');
        break;
      case 'devserver':
        this.print(paint.green(`✓ ${s.console.devServer(event.url)}`));
        break;
      case 'tunnel':
        if (event.state === 'up' && event.liveUrl) this.print(paint.dim(s.console.linkUp(event.liveUrl)));
        break;
      case 'hmr':
        if (event.state === 'update' && event.detail) this.print(paint.magenta(`↻ ${tidy(event.detail)}`));
        // React Native's Fast Refresh says no more than that it happened.
        else if (event.state === 'update' && this.reactNative) this.print(paint.magenta(`↻ ${s.console.refreshed(new Date().toLocaleTimeString())}`));
        break;
      case 'app':
        if (event.state === 'running') this.print(paint.green(`● ${studio.console.appRunning(event.name ?? this.app?.app.name ?? studio.system.yourApp, event.target ?? '')}`));
        else if (event.state === 'exited') this.print(paint.yellow(studio.console.appExited(event.exitCode)));
        break;
      case 'native-change': {
        const names = event.paths.slice(0, 3).map((p) => p.split(/[\\/]/).pop()).join(', ');
        this.print(paint.cyan(s.console.nativeChange(`${names}${event.paths.length > 3 ? ` +${event.paths.length - 3}` : ''}`)));
        break;
      }
      case 'build-reused':
        this.print(paint.dim(s.console.reused));
        break;
      case 'connection':
        if (event.state === 'lost' || (event.state === 'reconnecting' && event.attempt === 1)) this.print(paint.yellow(s.console.reconnecting(event.label)));
        else if (event.state === 'restored') this.print(paint.green(s.console.restored(event.label)));
        break;
      case 'app-dialogs':
        for (const dialog of event.dialogs) this.print(paint.yellow(s.console.dialog(this.app?.app.name ?? studio.system.yourApp, tidy(dialogText(dialog)))));
        break;
      case 'ipa-ready':
        this.print(paint.green(`✓ ${s.session.ipaReady(event.file)}`));
        break;
      case 'session-ended': {
        const time = s.time.seconds(event.ms);
        if (event.cancelled) this.print(paint.dim(s.console.ended(time)));
        else if (!event.ok) {
          if (event.error) this.printError(event.error);
          this.print(paint.red(s.console.failedAfter(time)));
        } else this.print(paint.dim(event.mode === 'ipa' ? s.console.done(time) : s.console.ended(time)));
        this.finish(event.ok || event.cancelled);
        break;
      }
      default:
        break;
    }
  }

  private appLog(entry: AppLogEntry): void {
    if (entry.kind === 'bridge' && !this.showBridge) return;
    if (entry.kind === 'electron' && entry.level === 'debug' && !this.verbose) return;
    // A Flutter or React Native app's native side may be its Mac or Windows app: "app", not "ios".
    const tag = entry.kind === 'console' ? (this.flutter ? 'dart' : 'js') : entry.kind === 'capacitor' ? 'cap' : entry.kind === 'native' ? (this.flutter || this.reactNative ? 'app' : 'ios') : entry.kind === 'bridge' ? '⇄' : entry.kind === 'main' ? 'main' : 'elec';
    const text = entry.text;
    const label = entry.continuation ? '    ' : paint.dim(tag.padEnd(4));
    const body = entry.level === 'error' ? paint.red(text) : entry.level === 'warn' ? paint.yellow(text) : entry.level === 'debug' ? paint.dim(text) : text;
    this.print(`${label} ${body}`, entry.level === 'error' || entry.stream === 'stderr' ? 'stderr' : 'stdout', sourceOf(entry));
  }

  private printError(error: ErrorInfo): void {
    this.print(paint.red(`✗ ${tidy(error.message)}`), 'stderr');
    if (error.details?.length) this.print(paint.dim(error.details.map((l) => `  │ ${l}`).join('\n')));
    if (error.hint) this.print(s.console.hint(tidy(error.hint)));
  }

  private progress(title?: string, message?: string): void {
    if (title) {
      this.endProgress();
      this.progressId = `p${this.seq}`;
      this.event('progressStart', { progressId: this.progressId, title, cancellable: false });
    } else if (this.progressId && message) {
      this.event('progressUpdate', { progressId: this.progressId, message: tidy(message) });
    }
  }

  private endProgress(): void {
    if (!this.progressId) return;
    this.event('progressEnd', { progressId: this.progressId });
    this.progressId = null;
  }

  private finish(ok: boolean): void {
    if (this.terminated) return;
    this.terminated = true;
    this.endProgress();
    this.markEnded();
    this.event('exited', { exitCode: ok ? 0 : 1 });
    this.event('terminated');
  }

  private async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.sessionId && !this.terminated) {
      await this.model.stopSession(this.sessionId);
      await Promise.race([this.ended, new Promise((resolve) => setTimeout(resolve, 8000))]);
    }
    this.finish(true);
  }

  private async restart(request: DapMessage): Promise<void> {
    const app = this.app;
    const run = app ? this.model.activeSession(app) : null;
    // Live reload that can start the app over in place (a Flutter app: hot restart); otherwise
    // (a run, or live reload on this PC, which has no relaunch) the session starts again.
    if (app && run?.mode === 'live' && run.status !== 'failed' && run.backend !== 'wsl') {
      await this.actions.restart(app);
      this.respond(request);
      return;
    }
    if (request.arguments?.arguments) this.config = { ...this.config, ...request.arguments.arguments };
    if (this.sessionId) {
      const old = this.sessionId;
      this.sessionId = null;
      await this.model.stopSession(old);
    }
    // Stopped while the old session stopped: no new one.
    if (this.stopRequested) {
      this.respond(request);
      return;
    }
    this.terminated = false;
    this.ended = new Promise((resolve) => (this.markEnded = resolve));
    await this.launch(request);
  }

  private async evaluate(request: DapMessage): Promise<void> {
    const text = String(request.arguments?.expression ?? '').trim();
    const app = this.app;
    const say = (result: string) => this.respond(request, { result, variablesReference: 0 });
    if (!app) return say(s.session.noApp);
    try {
      switch (text) {
        case 'r':
          await this.actions.reload(app);
          return say('');
        case 'R':
          await this.actions.restart(app);
          return say('');
        case 'b':
          await this.actions.rebuild(app);
          return say('');
        case 'B':
          await this.actions.rebuild(app, true);
          return say('');
        case 's':
          await this.actions.screenshot(app);
          return say('');
        case 'o':
          await this.actions.showScreen(app);
          return say('');
        case 'j':
          if (!this.devtools) return say(s.console.unknown(text));
          await this.actions.devtools(app);
          return say('');
        case 'q':
          await this.stop();
          return say('');
        case 'h':
        case '?':
        case 'help':
          return say(s.console.helpFull);
        default:
          return say(s.console.unknown(text));
      }
    } catch (err) {
      return say(tidy(err instanceof EngineError ? err.info.message : String((err as Error).message)));
    }
  }

  dispose(): void {
    this.listening?.dispose();
    this.sent.dispose();
  }
}

/** The workspace app a launch configuration is about (the current one when it names none). */
export function findApp(model: Model, config: CapmacLaunch): WorkspaceApp | null {
  if (config.projectPath) {
    const key = keyOf(config.projectPath);
    const inProject = model.runnableApps().filter((a) => keyOf(a.project.dir) === key);
    if (inProject.length) {
      if (config.app) return inProject.find((a) => a.app.id === config.app) ?? null;
      const current = model.current();
      return current && inProject.includes(current) ? current : model.runnableApps().find((a) => keyOf(a.project.dir) === key && a.app.status === 'ready') ?? inProject[0]!;
    }
    // A folder above the project (${workspaceFolder} of a monorepo): the current app if it is inside it.
    const current = model.current();
    if (current && keyOf(current.project.dir).startsWith(key) && (!config.app || current.app.id === config.app)) return current;
    const inside = model.runnableApps().filter((a) => keyOf(a.project.dir).startsWith(key));
    return (config.app ? inside.find((a) => a.app.id === config.app) : inside[0]) ?? null;
  }
  const current = model.current();
  if (config.app && current?.app.id !== config.app) return model.runnableApps().find((a) => a.project === current?.project && a.app.id === config.app) ?? current;
  return current;
}

function dialogText(dialog: { kind?: string; message?: string; title?: string }): string {
  return dialog.message || dialog.title || dialog.kind || '';
}
