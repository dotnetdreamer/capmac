/**
 * One `flutter run --machine` (or `flutter attach --machine`): on the Mac
 * through the agent, or on this PC. Flutter builds, installs and launches the
 * app itself; this turns its daemon messages into CapMac's timeline steps,
 * console lines and app states, and asks it for hot reloads, hot restarts and
 * the stop.
 */
import type { FlutterDaemonMessage, FlutterRunResult } from '../../shared/flutter.js';
import { log, startStep, type EngineContext, type StepHandle } from '../context.js';
import { CancelledError, UserError } from '../errors.js';
import type { AppLogEntry, Phase } from '../events.js';

/** How the runner talks to Flutter: requests go out, daemon messages and other output come in. */
export interface DaemonTransport {
  send(id: number, method: string, params: Record<string, unknown>): void;
  /** Resolves when Flutter exits (or the run is stopped). */
  readonly done: Promise<FlutterRunResult>;
  /** Ends the run (asking Flutter to stop the app first). */
  stop(): void;
}

/** The result of a hot reload or hot restart. */
export interface ReloadResult {
  ok: boolean;
  /** Flutter's words ("Reloaded 1 of 812 libraries", "Hot reload was rejected: …"). */
  message: string;
  /** A hot reload that could not apply the change (a new field in a class, a changed main): a hot restart applies it. */
  needsRestart: boolean;
  ms: number;
}

/** Which timeline phase one of Flutter's progress messages is. */
export function flutterPhase(message: string, progressId?: string | null): Phase {
  if (progressId === 'hot.reload' || progressId === 'hot.restart' || progressId === 'devFS.update') return 'other';
  if (/pod install|Resolving dependencies|Got dependencies|Downloading|pub get|Swift Package/i.test(message)) return 'deps';
  if (/Xcode build|Building|Compiling|Running Gradle|Running Xcode|Generating|CMake|Visual Studio/i.test(message)) return 'build';
  // Flutter installs and opens the app as one step.
  if (/Installing and launching/i.test(message)) return 'launch';
  if (/Installing|Uploading/i.test(message)) return 'install';
  if (/Launching|Waiting for|Syncing files|Connecting to|attach/i.test(message)) return 'launch';
  return 'other';
}

/** A Dart print() reaches Flutter's log as "flutter: …". */
const DART_PRINT = /^flutter: ?/;
/** The Flutter engine's own notes ("[IMPORTANT:flutter/shell/…] Using the Impeller rendering backend"). */
const ENGINE_LOG = /^\[(IMPORTANT|ERROR|WARNING|INFO|FATAL):flutter\//;

/** Flutter's own lines outside its protocol on a desktop run, where the app's lines come the same way. */
const FLUTTER_OWN = /^(Launching .+ mode\.\.\.|\S+ Built .+|Application finished\.|Lost connection to device\.)$/;

/** Where a debug build's Dart VM service and DevTools listen: CapMac uses them itself (hot reload). */
const VM_NOTICE = /^(flutter: )?(The Dart VM service is listening on|The Dart DevTools debugger and profiler is available at)\b/;

/**
 * One line from a Flutter app: Dart's print() and debugPrint() (the console), else the engine's and the plugins' native logs.
 * `desktop`: an app on this PC's desktop writes Dart's print() to its stdout as it is, without "flutter: ".
 */
export function flutterLogEntry(text: string, error = false, desktop = false): AppLogEntry | null {
  if (!text.trim() || VM_NOTICE.test(text)) return null;
  const dart = DART_PRINT.test(text) || (desktop && !ENGINE_LOG.test(text));
  return {
    kind: dart ? 'console' : 'native',
    level: error ? 'error' : /\b(error|exception)\b/i.test(text) ? 'error' : /\bwarn(ing)?\b/i.test(text) ? 'warn' : dart ? 'log' : 'info',
    text: dart ? text.replace(DART_PRINT, '') : text,
    stream: error ? 'stderr' : 'stdout',
    ts: Date.now(),
  };
}

export interface FlutterRunnerOptions {
  /** The app's name, for titles ("Launching Hello Flutter"). */
  appName: string;
  /** Where it runs, for titles and events ("iPhone 17", "the Mac", "this PC"). */
  where: string;
  bundleId?: string;
  /** Called once the app runs (Flutter's app.started). */
  onStarted?: () => void;
  /** Hot reloads and restarts in progress show as 'hmr' updates (live sessions), not as timeline steps. */
  live?: boolean;
  /** Turns the Mac's paths in Flutter's messages into this PC's. */
  mapText?: (text: string) => string;
  /** A Mac path as this PC's (for a compile error's file). */
  toLocal?: (file: string) => string;
  /** The app's own lines (false: another process relays them, as for a Mac app CapMac launched and Flutter attached to). */
  appLogs?: boolean;
  /** Flutter attaches to an app CapMac launched: that launch has the steps and the app's states, so this adds none. */
  attached?: boolean;
  /** The app runs on this PC's desktop (the Windows app): its Dart print() lines come without "flutter: ". */
  desktop?: boolean;
}

/** A Dart compile error or warning as Flutter prints it: `lib/main.dart:12:5: Error: Expected ';' after this.` */
const DART_DIAGNOSTIC = /^(.+?\.dart):(\d+):(\d+): (Error|Warning|Info|Context): (.+)$/;

export class FlutterRunner {
  appId: string | null = null;
  /** The Dart VM service (for DevTools), once Flutter reports it. */
  vmServiceUri: string | null = null;
  supportsRestart = false;
  readonly started: Promise<void>;
  private resolveStarted!: () => void;
  private rejectStarted!: (err: unknown) => void;
  private isStarted = false;
  /** A desktop app wrote its first line (its engine's): its later lines outside the protocol are the app's. */
  private appWrote = false;
  private readonly steps = new Map<string, StepHandle>();
  private launchStep: StepHandle | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (err: unknown) => void }>();
  /** One reload at a time; a save that comes while one runs reloads again after it. */
  private reloading: Promise<ReloadResult> | null = null;

  constructor(
    readonly transport: DaemonTransport,
    readonly ctx: EngineContext,
    readonly options: FlutterRunnerOptions,
  ) {
    this.started = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    this.started.catch(() => undefined);
    void transport.done.then(
      (result) => this.finish(result),
      (err) => this.fail(err),
    );
  }

  get running(): boolean {
    return this.isStarted;
  }

  /** Feeds one daemon message in (the transport calls this). */
  handle(msg: FlutterDaemonMessage): void {
    if ('id' in msg && !('event' in msg)) {
      const id = Number(msg.id);
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (msg.error !== undefined) waiter.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }
    if (!('event' in msg) || typeof msg.event !== 'string') return;
    const params: Record<string, any> = ('params' in msg && msg.params) || {};
    switch (msg.event) {
      case 'daemon.logMessage': {
        const text = this.map(String(params.message ?? ''));
        if (!text) return;
        // Until Flutter says the app started, the app's own lines come as the tool's status messages.
        if (params.level === 'status' && (DART_PRINT.test(text) || ENGINE_LOG.test(text))) {
          this.appLine(text, false);
          return;
        }
        const level = params.level === 'error' ? 'error' : params.level === 'warning' ? 'warn' : 'note';
        this.ctx.emit({ type: 'tool-output', stream: level === 'error' ? 'stderr' : 'stdout', text });
        this.diagnostics(text);
        if (level !== 'note') log(this.ctx, level, text);
        else this.currentStep()?.update(text.split('\n')[0]!.slice(0, 160));
        return;
      }
      case 'daemon.showMessage':
        log(this.ctx, params.level === 'error' ? 'error' : params.level === 'warning' ? 'warn' : 'info', [params.title, params.message].filter(Boolean).join(': '));
        return;
      case 'app.start':
        this.appId = typeof params.appId === 'string' ? params.appId : this.appId;
        this.supportsRestart = Boolean(params.supportsRestart);
        return;
      case 'app.debugPort':
        if (typeof params.wsUri === 'string') this.vmServiceUri = params.wsUri;
        return;
      case 'app.progress':
        this.progress(String(params.id ?? ''), typeof params.progressId === 'string' ? params.progressId : null, typeof params.message === 'string' ? params.message : null, Boolean(params.finished));
        return;
      case 'app.started':
        this.onStarted();
        return;
      case 'app.log':
        this.appLine(this.map(String(params.log ?? '').replace(/\r$/, '')), Boolean(params.error));
        return;
      case 'app.stop':
        if (params.error) log(this.ctx, 'error', String(params.error));
        return;
      default:
        return;
    }
  }

  private appLine(text: string, error: boolean): void {
    if (this.options.appLogs === false) return;
    const entry = flutterLogEntry(text, error, this.options.desktop);
    if (entry) this.ctx.emit({ type: 'app-log', entry });
  }

  /** A line Flutter printed outside its protocol (before machine mode starts, or a tool's own output). */
  output(text: string, stream: 'stdout' | 'stderr'): void {
    const mapped = this.map(text);
    // A desktop app writes to Flutter's own output, its print() without "flutter: ": after the
    // engine's first line, every line but Flutter's own few is the app's.
    const desktop = this.options.desktop === true && !FLUTTER_OWN.test(mapped.trim());
    if (desktop && ENGINE_LOG.test(mapped)) this.appWrote = true;
    // The app's own early lines can come this way too (before Flutter says it started).
    if (DART_PRINT.test(mapped) || ENGINE_LOG.test(mapped) || (desktop && this.appWrote)) {
      this.appLine(mapped, desktop && stream === 'stderr');
      return;
    }
    this.ctx.emit({ type: 'tool-output', stream, text: mapped });
    this.diagnostics(mapped);
  }

  private map(text: string): string {
    return this.options.mapText ? this.options.mapText(text) : text;
  }

  /** Dart compile errors become Problems, with this PC's file paths. */
  private diagnostics(text: string): void {
    for (const line of text.split('\n')) {
      const match = DART_DIAGNOSTIC.exec(line.trim());
      if (!match || match[4] === 'Context') continue;
      const file = this.options.toLocal ? this.options.toLocal(match[1]!) : match[1]!;
      this.ctx.emit({
        type: 'diagnostic',
        diagnostic: {
          severity: match[4] === 'Error' ? 'error' : match[4] === 'Warning' ? 'warning' : 'note',
          message: match[5]!,
          file,
          line: Number(match[2]),
          column: Number(match[3]),
          own: !/[\\/]\.pub-cache[\\/]|[\\/]flutter[\\/]packages[\\/]/.test(file),
        },
      });
    }
  }

  private currentStep(): StepHandle | null {
    const open = [...this.steps.values()];
    return open.at(-1) ?? this.launchStep;
  }

  private progress(id: string, progressId: string | null, message: string | null, finished: boolean): void {
    // A hot reload's own steps: its result says what happened (see reload()).
    const hot = progressId === 'hot.reload' || progressId === 'hot.restart';
    if (hot || this.options.attached || (this.isStarted && progressId === 'devFS.update')) return;
    // The first sync of the app's code is part of launching it.
    if (progressId === 'devFS.update') {
      if (message) (this.launchStep ??= startStep(this.ctx, `Launching ${this.options.appName}`, 'launch')).update(message.replace(/\.\.\.$|…$/, ''));
      return;
    }
    if (finished) {
      this.steps.get(id)?.succeed();
      this.steps.delete(id);
      // Built and installed: the launch is next, until Flutter says the app runs.
      if (!this.isStarted && !this.launchStep && this.steps.size === 0) this.launchStep = startStep(this.ctx, `Launching ${this.options.appName}`, 'launch');
      return;
    }
    if (!message) return;
    const phase = flutterPhase(message, progressId);
    if (phase === 'launch' && this.launchStep) return;
    // A new step ends the waiting launch step (Flutter had more to do before launching).
    if (this.launchStep && phase !== 'launch') {
      this.launchStep.succeed();
      this.launchStep = null;
    }
    const step = startStep(this.ctx, message.replace(/\.\.\.$|…$/, ''), phase);
    if (phase === 'launch') this.launchStep = step;
    else this.steps.set(id, step);
  }

  private onStarted(): void {
    if (this.isStarted) return;
    this.isStarted = true;
    for (const step of this.steps.values()) step.succeed();
    this.steps.clear();
    this.launchStep?.succeed();
    this.launchStep = null;
    if (!this.options.attached) this.ctx.emit({ type: 'app', state: 'running', name: this.options.appName, bundleId: this.options.bundleId, target: this.options.where });
    this.resolveStarted();
    this.options.onStarted?.();
  }

  private finish(result: FlutterRunResult): void {
    const cancelled = result.reason === 'cancelled';
    for (const step of this.steps.values()) (cancelled ? step.cancel() : step.fail());
    this.steps.clear();
    if (this.launchStep) (cancelled ? this.launchStep.cancel() : this.launchStep.fail());
    this.launchStep = null;
    for (const waiter of this.pending.values()) waiter.reject(new Error('Flutter stopped.'));
    this.pending.clear();
    if (this.isStarted) {
      if (!this.options.attached) this.ctx.emit({ type: 'app', state: cancelled ? 'stopped' : 'exited', name: this.options.appName, bundleId: this.options.bundleId, target: this.options.where, exitCode: result.exitCode });
    } else if (cancelled) {
      this.rejectStarted(new CancelledError());
    } else {
      const error = result.error?.replace(/^Error:\s*/, '').replace(/\s*Please run `flutter doctor` for more details\.?$/, '');
      this.rejectStarted(new UserError(error ? `Flutter stopped before the app started: ${error}` : `Flutter exited (code ${result.exitCode ?? 'unknown'}) before the app started.`, error && /flutter doctor/.test(result.error ?? '') ? 'Run `flutter doctor` to see what Flutter needs.' : undefined, result.tail));
    }
  }

  private fail(err: unknown): void {
    for (const step of this.steps.values()) step.fail();
    this.steps.clear();
    this.launchStep?.fail();
    this.launchStep = null;
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
    if (!this.isStarted) this.rejectStarted(err);
    else if (!this.options.attached) this.ctx.emit({ type: 'app', state: 'exited', name: this.options.appName, bundleId: this.options.bundleId, target: this.options.where, exitCode: null });
  }

  /** Sends a daemon request and waits for its answer. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.send(id, method, { ...(this.appId ? { appId: this.appId } : {}), ...params });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * A hot reload (`full`: a hot restart). Flutter answers `{code, message}`;
   * a reload it rejects (the change needs a restart) says so.
   */
  async reload(full = false, reason = 'save'): Promise<ReloadResult> {
    if (!this.isStarted || !this.appId) return { ok: false, message: 'The app is not running yet.', needsRestart: false, ms: 0 };
    const previous = this.reloading;
    const attempt = async (): Promise<ReloadResult> => {
      await previous?.catch(() => undefined);
      const started = Date.now();
      try {
        const result = await this.request<{ code?: number; message?: string }>('app.restart', { fullRestart: full, pause: false, reason, debounce: false });
        const code = Number(result?.code ?? 0);
        const message = String(result?.message ?? '').trim();
        return { ok: code === 0, message: message || (full ? 'Restarted' : 'Reloaded'), needsRestart: code !== 0 && !full && /restart|rejected|not reloadable|cannot be hot reloaded/i.test(message), ms: Date.now() - started };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err), needsRestart: false, ms: Date.now() - started };
      }
    };
    const current = attempt();
    this.reloading = current;
    try {
      return await current;
    } finally {
      if (this.reloading === current) this.reloading = null;
    }
  }

  /** Stops the app and Flutter. */
  stop(): void {
    this.transport.stop();
  }
}
