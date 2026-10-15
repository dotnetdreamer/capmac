/**
 * Electron apps on the Mac's desktop: a plain Electron app, one built with
 * electron-vite or Electron Forge, or Capacitor's Electron platform.
 *
 * Run: sync → dependencies, Electron for the Mac, Capacitor's web assets, the
 * build (on the Mac) → launch with CapMac's module in the app, which streams
 * back the main process's output and the pages' console.
 *
 * Live: your edits sync as you save. A dev command (electron-vite, Forge)
 * reloads the app by itself on the Mac; CapMac reloads the windows of a plain
 * Electron app, or restarts it when main-process code changed; Capacitor's
 * Electron app loads your dev server on this PC through a tunnel, like iOS.
 */
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import { CHROMIUM_LOG, type ElectronLaunchResult, type ElectronPlan, type ElectronPrepareResult, type HookEvent } from '../shared/electron.js';
import { PathMapper } from '../shared/paths.js';
import type { AgentEvent, Target } from '../shared/protocol.js';
import type { AgentCall } from './agent-client.js';
import { updateHost } from './config.js';
import { log, startStep, type EngineContext, type StepHandle } from './context.js';
import { HMR_LINE, startDevServer, type DevServer } from './devserver.js';
import { isCancelled, toErrorInfo, UserError } from './errors.js';
import type { AppLogEntry } from './events.js';
import type { MacLink } from './link.js';
import { buildWeb } from './pipeline.js';
import { requireElectron, type ProjectInfo } from './project.js';
import type { MacSession } from './session.js';
import type { ForwardObserver } from './ssh.js';
import { syncToMac, type SyncSummary } from './sync-client.js';
import { AgentEventTranslator } from './translate.js';
import { isNoise, watchWrites } from './watch.js';

/** The target id of the Mac's own desktop (where Electron apps run). */
export const MAC_TARGET_ID = 'mac-desktop';

/** The Mac's desktop as a run target, next to its simulators and devices. */
export function macTarget(label: string, macos?: string | null): Target {
  return { kind: 'mac', udid: MAC_TARGET_ID, name: label, os: macos ? `macOS ${macos}` : 'macOS', osVersion: macos ?? '', state: 'available', available: true };
}

/** Scripts that package the app (installers, dmg): never run as "the build" before a launch. */
const PACKAGING = /electron-builder|electron-forge\s+(make|package|publish)|electron-packager|\bdmg\b|--(mac|win|linux)\b/;

/** How CapMac builds, launches and live-reloads the project's Electron app (capmac.json's `electron` wins). */
export function electronPlan(project: ProjectInfo): ElectronPlan {
  const app = requireElectron(project);
  const scripts = app.scripts;
  // npm runs any package.json script, whatever installed the dependencies.
  const script = (name: string) => `npm run ${name}`;
  let build: string | null;
  let launch: ElectronPlan['launch'];
  let dev: ElectronPlan['dev'];
  switch (app.flavor) {
    case 'capacitor':
      build = scripts.build ? script('build') : 'npx tsc';
      launch = { electron: ['.'] };
      dev = null;
      break;
    case 'electron-vite':
      build = scripts.build && !PACKAGING.test(scripts.build) ? script('build') : 'npx electron-vite build';
      launch = { electron: ['.'] };
      // --watch also rebuilds and restarts the main process (the renderer reloads by itself).
      dev = { command: !scripts.dev || /^\s*electron-vite(\s+dev)?\s*$/.test(scripts.dev) ? 'npx electron-vite dev --watch' : script('dev') };
      break;
    case 'forge': {
      const start = scripts.start && /electron-forge\s+start/.test(scripts.start) ? script('start') : 'npx electron-forge start';
      build = null;
      launch = { command: start };
      // Forge restarts the app when it reads "rs".
      dev = { command: start, restartInput: 'rs\n' };
      break;
    }
    default:
      build = scripts.build && !PACKAGING.test(scripts.build) ? script('build') : null;
      launch = { electron: ['.'] };
      dev = scripts.dev && /\belectron\b|electronmon|nodemon|concurrently/.test(scripts.dev) ? { command: script('dev') } : null;
  }
  const config = project.config.electron ?? {};
  if (config.build !== undefined) build = config.build || null;
  if (config.start) launch = { command: config.start };
  if (config.dev !== undefined) dev = config.dev ? { command: config.dev } : null;
  return { flavor: app.flavor, appRel: app.rel, build, launch, dev, webDir: project.kind === 'capacitor' ? project.webDir : undefined };
}

/** What the timeline calls the way the app is built. */
export function describeFlavor(flavor: ElectronPlan['flavor']): string {
  return flavor === 'capacitor' ? 'Capacitor Electron' : flavor === 'electron-vite' ? 'electron-vite' : flavor === 'forge' ? 'Electron Forge' : 'Electron';
}

// ─── Running ──────────────────────────────────────────────────────────────

const CONSOLE_LEVELS = { debug: 'debug', info: 'log', warning: 'warn', error: 'error' } as const;
const CHROMIUM_LEVELS: Record<string, AppLogEntry['level']> = { ERROR: 'error', FATAL: 'error', WARNING: 'warn', INFO: 'debug' };

/** A launched app: its output streams in until it exits; it answers reload and module questions. */
export class ElectronApp {
  readonly done: Promise<ElectronLaunchResult>;
  private nextId = 1;
  private readonly waiting = new Map<number, (event: Extract<AgentEvent, { t: 'control-result' }>) => void>();

  constructor(private readonly call: AgentCall<ElectronLaunchResult>) {
    this.done = call.result;
    this.done.catch(() => undefined);
  }

  /** Answers from the agent (wired by the runner). */
  answer(event: Extract<AgentEvent, { t: 'control-result' }>): void {
    this.waiting.get(event.id)?.(event);
    this.waiting.delete(event.id);
  }

  private control(action: 'reload' | 'modules' | 'input', extra: object = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('The app did not answer.'));
      }, 10_000);
      this.waiting.set(id, (event) => {
        clearTimeout(timer);
        if (event.ok) resolve(event.data);
        else reject(new Error(event.error ?? 'The app could not do that.'));
      });
      this.call.send({ t: 'control', id, action, ...extra });
    });
  }

  /** Reloads every window (a page change). */
  reload(): Promise<void> {
    return this.control('reload').then(() => undefined);
  }

  /** The files the main process loaded (Mac paths). */
  async modules(): Promise<string[]> {
    const data = await this.control('modules');
    return Array.isArray(data) ? data.filter((file): file is string => typeof file === 'string') : [];
  }

  /** Types into the dev command (Forge restarts the app on "rs"). */
  input(text: string): Promise<void> {
    return this.control('input', { text }).then(() => undefined);
  }

  /** Quits the app (and its dev command); resolves once it is gone. */
  async stop(): Promise<void> {
    this.call.cancel();
    await this.done.catch(() => undefined);
  }
}

/** The steps behind `run` and live reload for an Electron app (like Pipeline for iOS). */
export class ElectronRunner {
  mapper: PathMapper | null = null;
  private hellos = 0;
  /** Notes already shown: the app says them again after every restart. */
  private readonly notes = new Set<string>();

  constructor(public session: MacSession, readonly project: ProjectInfo, readonly ctx: EngineContext, readonly plan: ElectronPlan = electronPlan(project)) {}

  get appName(): string {
    return this.project.electron?.name && this.project.kind === 'electron' ? this.project.electron.name : this.project.appName;
  }

  get target(): Target {
    return macTarget(this.session.label, this.session.host.macos);
  }

  private announced = false;
  /** Says where the app runs: once the Mac's macOS version is known (after the first prepare), or `anyway`. */
  announceTarget(anyway = false): void {
    if (this.announced || (!anyway && !this.session.host.macos)) return;
    this.announced = true;
    this.ctx.emit({ type: 'target', target: this.target });
  }

  private ref() {
    return { projectId: this.project.projectId, projectRel: this.project.projectRel };
  }

  /** Uploads the project (Capacitor's web build too, unless live reload serves it). */
  async sync(options: { live: boolean; signal?: AbortSignal; quiet?: boolean }): Promise<SyncSummary> {
    const ctx = options.quiet ? { ...this.ctx, emit: (event: Parameters<EngineContext['emit']>[0]) => event.type === 'log' && this.ctx.emit(event) } : this.ctx;
    const result = await syncToMac(this.session, this.project, { includeWebDir: this.plan.flavor === 'capacitor' && !options.live, signal: options.signal }, ctx);
    this.mapper = new PathMapper(result.remoteRoot, this.project.syncRoot);
    return result;
  }

  /** Dependencies, Electron for the Mac, Capacitor's web assets and the build, as needed. */
  async prepare(options: { live: boolean; full?: boolean; signal?: AbortSignal }): Promise<ElectronPrepareResult> {
    const translator = new AgentEventTranslator(this.ctx, 'electron-prepare', this.mapper);
    let result: ElectronPrepareResult;
    try {
      result = await this.session.call<ElectronPrepareResult>(
        'electron-prepare',
        { ...this.ref(), plan: this.plan, live: options.live, full: options.full },
        { signal: options.signal, onEvent: translator.handle },
      );
    } catch (err) {
      translator.closeOpenSteps(isCancelled(err) || options.signal?.aborted ? 'cancelled' : 'failed');
      throw this.friendly(err);
    }
    // Remembered for the target picker ("macOS 26.6").
    if (result.macos && result.macos !== this.session.host.macos) {
      this.session.host.macos = result.macos;
      await updateHost(this.session.host.name, { macos: result.macos }).catch(() => undefined);
    }
    if (result.installed.length === 0) this.ctx.emit({ type: 'phase-skipped', phase: 'deps', reason: 'dependencies unchanged' });
    if (!result.downloaded) this.ctx.emit({ type: 'phase-skipped', phase: 'electron', reason: `Electron ${result.electron ?? ''} already on the Mac`.replace('  ', ' ') });
    if (this.plan.flavor === 'capacitor' && !result.capCopied) this.ctx.emit({ type: 'phase-skipped', phase: 'cap', reason: options.live ? 'served by your dev server' : 'web assets unchanged' });
    if (!result.built) {
      const reason = options.live && this.plan.dev ? 'built by the dev command' : this.plan.build ? 'app unchanged' : 'no build script';
      this.ctx.emit({ type: 'phase-skipped', phase: 'build', reason });
    }
    return result;
  }

  /** Errors from the agent, with their tool output mapped to this PC's paths. */
  private friendly(err: unknown): unknown {
    const e = err as { message?: string; hint?: string; tail?: string[]; code?: string; expected?: boolean };
    if (!e?.expected || !e.tail) return err;
    const tail = e.tail.map((line) => (this.mapper ? this.mapper.mapText(line) : line));
    return Object.assign(new UserError(e.message ?? String(err), e.hint, tail), e.code ? { code: e.code } : {});
  }

  /** A page's console source as a PC path when it is a file of the project. */
  private mapSource(source: string | undefined, line: number | undefined): string | undefined {
    if (!source) return undefined;
    let where = source;
    if (source.startsWith('file://')) {
      try {
        const file = decodeURIComponent(new URL(source).pathname);
        where = this.mapper ? this.mapper.toLocal(file) : file;
      } catch {
        // keep the URL
      }
    } else {
      where = source.replace(/\?.*$/, '');
    }
    return line ? `${where}:${line}` : where;
  }

  private emitLog(kind: AppLogEntry['kind'], level: AppLogEntry['level'], text: string, stream: 'stdout' | 'stderr', source?: string): void {
    const lines = text.replace(/\r/g, '').split('\n');
    lines.forEach((line, i) => {
      if (!line.trim() && i > 0) return;
      this.ctx.emit({ type: 'app-log', entry: { kind, level, text: this.mapper ? this.mapper.mapText(line) : line, stream, ts: Date.now(), ...(i > 0 ? { continuation: true } : {}), ...(i === 0 && source ? { source } : {}) } });
    });
  }

  private onHook(event: HookEvent): void {
    switch (event.e) {
      case 'hello':
        this.hellos += 1;
        if (this.hellos > 1) log(this.ctx, 'info', `${this.appName} restarted`);
        else log(this.ctx, 'debug', `CapMac is attached to the app (Electron ${event.electron}, Chromium ${event.chrome})`);
        break;
      case 'console':
        this.emitLog('console', CONSOLE_LEVELS[event.level] ?? 'log', event.text, event.level === 'error' || event.level === 'warning' ? 'stderr' : 'stdout', this.mapSource(event.source, event.line));
        break;
      case 'load-failed':
        log(this.ctx, 'error', `The app could not load ${event.url} (${event.description || event.code})`);
        break;
      case 'crashed':
        if (event.reason !== 'clean-exit') log(this.ctx, 'error', `A window’s page stopped (${event.reason})`);
        break;
      case 'unresponsive':
        log(this.ctx, 'warn', 'A window of the app is not responding');
        break;
      case 'error':
        log(this.ctx, 'warn', event.message);
        break;
      case 'note':
        if (!this.notes.has(event.message)) {
          this.notes.add(event.message);
          log(this.ctx, 'info', event.message);
        }
        break;
      default:
        break;
    }
  }

  private onOutput(text: string, stream: 'stdout' | 'stderr', source: 'main' | 'chromium' | 'tool'): void {
    if (source === 'tool') {
      this.ctx.emit({ type: 'devserver-output', text });
      if (HMR_LINE.test(text)) this.ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail: text.trim() });
      return;
    }
    if (source === 'chromium') {
      const match = text.match(CHROMIUM_LOG);
      const level = CHROMIUM_LEVELS[match?.[1] ?? ''] ?? 'debug';
      const file = text.match(/:([\w.]+\(\d+\))\]/)?.[1];
      const message = match ? text.slice(match[0].length) : text;
      this.emitLog('electron', level, file ? `${message} (${file.replace('(', ':').replace(')', '')})` : message, stream);
      return;
    }
    const lower = text.toLowerCase();
    const level: AppLogEntry['level'] = /\b(uncaught|error|exception|fatal)\b/.test(lower) ? 'error' : /\bwarn(ing)?\b|deprecat/.test(lower) ? 'warn' : 'log';
    this.emitLog('main', level, text, stream);
  }

  /**
   * Launches the app (live reload: its dev command). `onReady` runs when its
   * first window opens; the returned app streams until it exits or is stopped.
   */
  async launch(options: { mode: 'run' | 'live'; liveUrl?: string | null; restart?: boolean; signal?: AbortSignal; onReady?: () => void }): Promise<ElectronApp> {
    const step: StepHandle = startStep(this.ctx, `Launching ${this.appName}`, 'launch');
    const appEvent = { name: this.appName, target: this.session.label };
    this.ctx.emit({ type: 'app', state: 'launching', ...appEvent });
    let app: ElectronApp | null = null;
    const pending: Array<Extract<AgentEvent, { t: 'control-result' }>> = [];
    const call = await this.session.agent.start<ElectronLaunchResult>(
      'electron-launch',
      { ...this.ref(), plan: this.plan, mode: options.mode, liveUrl: options.liveUrl ?? null, restart: options.restart ?? false },
      {
        signal: options.signal,
        onEvent: (event) => {
          switch (event.t) {
            case 'ready':
              step.succeed();
              this.ctx.emit({ type: 'app', state: 'running', ...appEvent });
              options.onReady?.();
              break;
            case 'electron':
              this.onHook(event.event);
              break;
            case 'app':
              this.onOutput(event.text, event.stream, event.source ?? 'main');
              break;
            case 'control-result':
              if (app) app.answer(event);
              else pending.push(event);
              break;
            case 'log':
              log(this.ctx, event.level, this.mapper ? this.mapper.mapText(event.msg) : event.msg);
              break;
            default:
              break;
          }
        },
      },
    );
    app = new ElectronApp(call);
    for (const event of pending) app.answer(event);
    void app.done.then(
      (result) => {
        if (result.reason === 'cancelled') {
          step.cancel();
          this.ctx.emit({ type: 'app', state: 'stopped', ...appEvent });
        } else {
          step.succeed();
          this.ctx.emit({ type: 'app', state: 'exited', exitCode: result.exitCode, ...appEvent });
        }
      },
      (err) => {
        if (isCancelled(err) || options.signal?.aborted) step.cancel();
        else step.fail();
      },
    );
    return app;
  }
}

/** Options for `capmac run` on the Mac's desktop. */
export interface ElectronRunOptions {
  /** Reinstall dependencies and build again. */
  full?: boolean;
  /** Capacitor: build the web app first (default true). */
  webBuild?: boolean;
  /** Called once the app's first window is open. */
  onReady?: () => void;
}

/**
 * Sync → prepare → launch on the Mac's desktop. Resolves when the app exits,
 * or when `signal` aborts (which quits it).
 */
export async function runElectronApp(project: ProjectInfo, link: MacLink, options: ElectronRunOptions, ctx: EngineContext, signal: AbortSignal): Promise<ElectronLaunchResult> {
  const plan = electronPlan(project);
  const sessionPromise = link.session();
  sessionPromise.catch(() => undefined);
  if (plan.flavor === 'capacitor' && options.webBuild !== false) await buildWeb(project, ctx, signal);
  const session = await sessionPromise;
  const runner = new ElectronRunner(session, project, ctx, plan);
  runner.announceTarget();
  await runner.sync({ live: false, signal });
  await runner.prepare({ live: false, full: options.full, signal });
  runner.announceTarget(true);
  const app = await runner.launch({ mode: 'run', signal, onReady: options.onReady });
  try {
    return await app.done;
  } catch (err) {
    if (isCancelled(err) || signal.aborted) return { reason: 'cancelled', exitCode: null };
    throw runnerError(err, runner);
  }
}

function runnerError(err: unknown, runner: ElectronRunner): unknown {
  const e = err as { message?: string; hint?: string; tail?: string[]; code?: string; expected?: boolean };
  if (!e?.expected) return err;
  const tail = (e.tail ?? []).map((line) => (runner.mapper ? runner.mapper.mapText(line) : line));
  return Object.assign(new UserError(e.message ?? String(err), e.hint, tail.length ? tail : undefined), e.code ? { code: e.code } : {});
}

// ─── Live reload ──────────────────────────────────────────────────────────

export interface ElectronLiveOptions {
  /** Capacitor: use an already running dev server instead of starting one. */
  url?: string;
  /** Capacitor: the command that starts the dev server. */
  devCommand?: string;
  /** Reinstall dependencies and build again first. */
  full?: boolean;
  /** Sync and reload as you save (default true). */
  watch?: boolean;
}

interface Work {
  /** Files that changed on this PC (POSIX, from the synced root). */
  files?: string[];
  /** Install and build again, then restart. */
  full?: boolean;
  /** Restart the app (after a sync and prepare). */
  restart?: boolean;
  /** Restart only (no sync, no build). */
  relaunch?: boolean;
  /** The files are on the Mac already (a restart after edits). */
  synced?: boolean;
}

const WEBSOCKET_UPGRADE = /^upgrade:\s*websocket\s*$/im;
const DEPENDENCY_FILE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|\.npmrc)$/;
/** Files a dev command reads once: it restarts to pick up a change to them. */
const TOOL_CONFIG = /(^|\/)(electron\.vite\.config|electron-vite\.config|vite\.[\w.-]*config|forge\.config|webpack\.[\w.-]*config|tsconfig[\w.-]*)\.(m?[jt]s|cjs|json)$/;
/** Forge: files that run in the main process or the preload (Forge restarts the app for them). */
const FORGE_MAIN = /(^|\/)(main|preload)(\.[mc]?[jt]sx?$|\/)/;

export class ElectronLiveSession {
  devServer: DevServer | null = null;
  /** Capacitor: the URL the app loads (the dev server through the tunnel). */
  liveUrl: string | null = null;
  private runner: ElectronRunner | null = null;
  private app: ElectronApp | null = null;
  /** Launches so far: the first is a new launch, the rest restarts. */
  private launches = 0;
  private watcher: FSWatcher | null = null;
  private readonly stopAll = new AbortController();
  private busy = false;
  private queued: Work | null = null;
  private tunnel: { port: number; close: () => Promise<void> } | null = null;
  private lastTunnelPort = 0;
  private reconnecting = false;
  private unsubscribeLink: (() => void) | null = null;
  private stopping: Promise<void> | null = null;
  private readonly hmrSockets = new Set<number>();
  readonly plan: ElectronPlan;

  constructor(readonly project: ProjectInfo, readonly link: MacLink, readonly options: ElectronLiveOptions, readonly ctx: EngineContext) {
    this.plan = electronPlan(project);
  }

  get stopped(): boolean {
    return this.stopAll.signal.aborted;
  }

  get session(): MacSession | null {
    return this.runner?.session ?? null;
  }

  /** The Mac's desktop, once connected. */
  get target(): Target | null {
    return this.runner?.target ?? null;
  }

  /** Starts the dev server (Capacitor), syncs, prepares and launches, then follows your edits. */
  async start(): Promise<void> {
    try {
      await this.startInner();
    } catch (err) {
      await this.teardown();
      if (!isCancelled(err)) this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error: toErrorInfo(err) });
      throw err;
    }
  }

  private async startInner(): Promise<void> {
    const { ctx, project, options } = this;
    requireElectron(project);
    ctx.emit({ type: 'session', mode: 'live', state: 'starting' });
    const sessionPromise = this.link.session();
    sessionPromise.catch(() => undefined);
    if (this.plan.flavor === 'capacitor') {
      this.devServer = await startDevServer(project, { url: options.url, command: options.devCommand }, ctx);
      const devServer = this.devServer;
      ctx.emit({ type: 'devserver', url: devServer.url.href, external: devServer.external, command: devServer.command ?? undefined });
      void devServer.exited.then((code) => {
        if (!this.stopped) ctx.emit({ type: 'error', error: { message: `The dev server stopped (exit code ${code ?? 'unknown'}).`, hint: 'Live reload needs it: stop and start live mode again.', expected: true } });
      });
    }
    const session = await sessionPromise;
    this.runner = new ElectronRunner(session, project, ctx, this.plan);
    this.runner.announceTarget();
    if (this.devServer) {
      this.liveUrl = await this.connectTunnel(session, this.devPort);
      ctx.emit({ type: 'tunnel', state: 'up', liveUrl: this.liveUrl, localUrl: this.devServer.url.host });
    }
    this.unsubscribeLink = this.link.onChange((state, next) => this.onLinkChange(state, next));
    await this.cycle({ full: options.full, restart: true });
    if (options.watch !== false && !this.stopped) {
      this.watcher = watchWrites(project.syncRoot, (rel) => !isNoise(rel), (files) => void this.cycle({ files }), 250);
    }
  }

  private get devPort(): number {
    const url = this.devServer!.url;
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  }

  private readonly tunnelObserver: ForwardObserver = {
    onRequest: (id, head) => {
      if (!WEBSOCKET_UPGRADE.test(head)) return;
      this.hmrSockets.add(id);
      if (this.hmrSockets.size === 1) this.ctx.emit({ type: 'hmr', state: 'connected', at: Date.now() });
    },
    onClose: (id) => {
      if (this.hmrSockets.delete(id) && this.hmrSockets.size === 0 && !this.stopped) this.ctx.emit({ type: 'hmr', state: 'disconnected', at: Date.now() });
    },
  };

  /** Capacitor: the Mac's localhost:<port> reaches the dev server on this PC. Returns the URL the app loads. */
  private async connectTunnel(session: MacSession, preferredPort: number): Promise<string> {
    const devUrl = this.devServer!.url;
    const localHost = devUrl.hostname.replace(/^\[|\]$/g, '');
    try {
      this.tunnel = await session.conn.reverseForward(preferredPort, this.devPort, localHost, this.tunnelObserver);
    } catch {
      this.tunnel = await session.conn.reverseForward(0, this.devPort, localHost, this.tunnelObserver);
    }
    this.lastTunnelPort = this.tunnel.port;
    return `${devUrl.protocol}//localhost:${this.tunnel.port}${devUrl.pathname}${devUrl.search}`;
  }

  /** Runs one piece of work at a time; work that arrives meanwhile is merged and runs next. */
  private async cycle(work: Work): Promise<void> {
    if (this.stopped || !this.runner) return;
    if (this.busy || this.reconnecting) {
      const q = this.queued ?? {};
      this.queued = {
        files: [...(q.files ?? []), ...(work.files ?? [])],
        full: q.full || work.full,
        restart: q.restart || work.restart,
        relaunch: (q.relaunch ?? true) && work.relaunch,
      };
      return;
    }
    this.busy = true;
    const signal = this.stopAll.signal;
    try {
      await this.perform(work, signal);
    } catch (err) {
      if (!signal.aborted && !this.reconnecting) {
        const error = toErrorInfo(err);
        this.ctx.emit({ type: 'error', error });
        this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error });
      }
    } finally {
      this.busy = false;
      if (this.queued && !signal.aborted && !this.reconnecting) {
        const next = this.queued;
        this.queued = null;
        void this.cycle(next);
      }
    }
  }

  private async perform(work: Work, signal: AbortSignal): Promise<void> {
    const runner = this.runner!;
    if (work.relaunch && !work.restart && !work.full && !work.files?.length) {
      await this.restartApp(signal);
      return;
    }
    if (work.restart || work.full || !this.app) {
      this.ctx.emit({ type: 'session', mode: 'live', state: 'building' });
      if (work.synced) this.ctx.emit({ type: 'phase-skipped', phase: 'sync', reason: 'edits already on the Mac' });
      else await runner.sync({ live: true, signal });
      await runner.prepare({ live: true, full: work.full, signal });
      runner.announceTarget(true);
      await this.restartApp(signal);
      return;
    }
    // Edits: sync quietly, then do what the change needs.
    const synced = await runner.sync({ live: true, signal, quiet: true });
    const changed = synced.changed;
    if (changed.length === 0) return;
    const appRel = [this.project.projectRel, this.plan.appRel].filter(Boolean).join('/');
    const inApp = (rel: string) => !appRel || rel === appRel || rel.startsWith(`${appRel}/`);
    const restart = (why: string) => {
      log(this.ctx, 'info', `${describeChange(changed)} changed: ${why}`);
      return this.perform({ restart: true, synced: true }, signal);
    };
    if (changed.some((rel) => DEPENDENCY_FILE.test(rel))) return restart('installing and restarting the app');
    const updated = (detail: string) => this.ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail });

    if (this.plan.flavor === 'capacitor') {
      // The pages come from your dev server; the Electron app's own code needs a build and a restart.
      if (changed.some(inApp)) return restart('building and restarting the app');
      return;
    }
    if (this.plan.dev) {
      if (changed.some((rel) => TOOL_CONFIG.test(rel))) return restart('restarting the dev command');
      if (this.plan.dev.restartInput && changed.some((rel) => FORGE_MAIN.test(rel))) {
        await this.app.input(this.plan.dev.restartInput).catch(() => undefined);
        updated(`${describeChange(changed)}: restarting the app`);
        return;
      }
      updated(`${describeChange(changed)} synced`);
      return;
    }
    // CapMac reloads a plain Electron app: a restart when the main process loaded a changed file.
    if (this.plan.build) return restart('building and restarting the app');
    const remoteRoot = synced.remoteRoot.replace(/\/+$/, '');
    const modules = new Set(await this.app.modules().catch(() => [] as string[]));
    if (modules.size === 0 || changed.some((rel) => modules.has(`${remoteRoot}/${rel}`))) return restart('restarting the app');
    await this.app.reload();
    updated(`${describeChange(changed)}: reloaded`);
  }

  private async stopApp(): Promise<void> {
    const app = this.app;
    this.app = null;
    if (app) await app.stop();
  }

  private async restartApp(signal: AbortSignal): Promise<void> {
    await this.stopApp();
    if (this.stopped) return;
    // The first launch opens behind whatever the Mac shows; later ones come back in front if someone was using the app there.
    const restart = this.launches > 0;
    this.launches += 1;
    const app = await this.runner!.launch({
      mode: 'live',
      liveUrl: this.liveUrl,
      restart,
      signal,
      onReady: () => this.ctx.emit({ type: 'session', mode: 'live', state: 'running' }),
    });
    this.app = app;
    void app.done.then(
      (result) => {
        if (this.app === app && result.reason === 'exited' && !this.stopped) {
          this.app = null;
          this.ctx.emit({ type: 'session', mode: 'live', state: 'idle' });
        }
      },
      (err) => {
        if (this.app !== app) return;
        this.app = null;
        if (!isCancelled(err) && !this.reconnecting && !this.stopped) {
          const error = toErrorInfo(runnerError(err, this.runner!));
          this.ctx.emit({ type: 'error', error });
          this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error });
        }
      },
    );
  }

  /** Syncs, prepares (reinstalling and rebuilding with `clean`) and restarts the app. */
  rebuild(options: { clean?: boolean; full?: boolean } = {}): void {
    void this.cycle({ restart: true, full: options.clean || options.full });
  }

  /** Restarts the app without syncing or building. */
  relaunch(): void {
    void this.cycle({ relaunch: true });
  }

  /** Reloads the app's windows (a page change). */
  reload(): Promise<void> {
    return this.app ? this.app.reload() : Promise.resolve();
  }

  private onLinkChange(state: string, session: MacSession | null): void {
    if (this.stopped) return;
    if (state === 'lost') {
      // The app and the tunnel ran over the old connection: they are gone with it.
      this.reconnecting = true;
      this.app = null;
      this.tunnel = null;
      this.hmrSockets.clear();
      if (this.devServer) this.ctx.emit({ type: 'tunnel', state: 'down' });
    } else if (state === 'restored' && session) {
      void this.restore(session);
    }
  }

  private async restore(session: MacSession): Promise<void> {
    try {
      this.runner!.session = session;
      if (this.devServer) {
        const next = await this.connectTunnel(session, this.lastTunnelPort || this.devPort);
        if (next !== this.liveUrl) log(this.ctx, 'info', `Live reload now uses ${next}`);
        this.liveUrl = next;
        this.ctx.emit({ type: 'tunnel', state: 'up', liveUrl: this.liveUrl, localUrl: this.devServer.url.host });
      }
      this.reconnecting = false;
      void this.cycle({ restart: true });
    } catch (err) {
      log(this.ctx, 'note', `  could not restore live reload (${(err as Error)?.message ?? err}); retrying…`);
      session.close();
    }
  }

  private teardown(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        this.stopAll.abort();
        this.unsubscribeLink?.();
        this.watcher?.close();
        await this.stopApp();
        await this.tunnel?.close().catch(() => undefined);
        this.tunnel = null;
        await this.devServer?.stop().catch(() => undefined);
      })();
    }
    return this.stopping;
  }

  /** Quits the app, and stops the tunnel and the dev server. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopping' });
    await this.teardown();
    if (this.devServer) this.ctx.emit({ type: 'tunnel', state: 'down' });
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopped' });
  }
}

function describeChange(paths: string[]): string {
  const names = paths.slice(0, 2).map((rel) => path.posix.basename(rel));
  return paths.length > 2 ? `${names.join(', ')} and ${paths.length - 2} more` : names.join(', ');
}

/** A PNG of the running app's window. */
export async function takeAppScreenshot(session: MacSession, projectId: string, window?: number): Promise<{ png: Buffer; width: number | null; height: number | null }> {
  const chunks: Buffer[] = [];
  const result = await session.call<{ width: number; height: number }>('electron-screenshot', { projectId, window }, { onBinary: (chunk) => chunks.push(chunk) });
  return { png: Buffer.concat(chunks), width: result.width ?? null, height: result.height ?? null };
}



