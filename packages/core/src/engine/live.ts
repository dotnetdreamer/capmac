/**
 * Live reload: the dev server runs on this PC, an SSH reverse tunnel makes it
 * localhost on the Mac, and the app is built to load it. Native changes
 * trigger rebuilds; a dropped connection is restored and the app relaunched.
 */
import type { BuildResult, Target } from '../shared/protocol.js';
import type { AgentCall } from './agent-client.js';
import { log, type EngineContext } from './context.js';
import { startDevServer, type DevServer } from './devserver.js';
import { isCancelled, toErrorInfo, UserError } from './errors.js';
import type { MacLink } from './link.js';
import { Pipeline, type TargetOptions } from './pipeline.js';
import { requireIos, type ProjectInfo } from './project.js';
import type { MacSession } from './session.js';
import type { ApiKey } from './signing.js';
import type { ForwardObserver } from './ssh.js';
import { watchNativeChanges } from './watch.js';

export interface LiveOptions extends TargetOptions {
  /** Use an already running dev server instead of starting one. */
  url?: string;
  devCommand?: string;
  configuration?: string;
  scheme?: string;
  team?: string;
  full?: boolean;
  clean?: boolean;
  showSimulator?: boolean;
  /** Rebuild automatically when native files change (default true). */
  watch?: boolean;
  osLogs?: boolean;
  auth?: ApiKey;
}

interface CycleRequest {
  full?: boolean;
  clean?: boolean;
  relaunchOnly?: boolean;
}

interface Tunnel {
  port: number;
  close: () => Promise<void>;
}

const WEBSOCKET_UPGRADE = /^upgrade:\s*websocket\s*$/im;

export class LiveSession {
  target: Target | null = null;
  /** The URL the app loads (through the tunnel). */
  liveUrl: string | null = null;
  devServer: DevServer | null = null;
  lastBuild: BuildResult | null = null;
  private pipeline: Pipeline | null = null;
  private tunnel: Tunnel | null = null;
  private lastTunnelPort = 0;
  private relay: AgentCall<unknown> | null = null;
  private relayPort = 0;
  private watcher: { close(): void } | null = null;
  private readonly stopAll = new AbortController();
  private reconnecting = false;
  private app: { controller: AbortController; done: Promise<void> } | null = null;
  private busy = false;
  private queued: CycleRequest | null = null;
  private unsubscribeLink: (() => void) | null = null;
  private readonly hmrSockets = new Set<number>();
  private stopping: Promise<void> | null = null;

  constructor(readonly project: ProjectInfo, readonly link: MacLink, readonly options: LiveOptions, readonly ctx: EngineContext) {}

  get stopped(): boolean {
    return this.stopAll.signal.aborted;
  }

  get session(): MacSession | null {
    return this.pipeline?.session ?? null;
  }

  /** Starts the dev server and tunnel, runs the first build and launch, then watches for changes. */
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
    requireIos(this.project);
    const { ctx, project, options } = this;
    ctx.emit({ type: 'session', mode: 'live', state: 'starting' });
    const sessionPromise = this.link.session();
    sessionPromise.catch(() => undefined);
    this.devServer = await startDevServer(project, { url: options.url, command: options.devCommand }, ctx);
    const devServer = this.devServer;
    ctx.emit({ type: 'devserver', url: devServer.url.href, external: devServer.external, command: devServer.command ?? undefined });
    void devServer.exited.then((code) => {
      if (this.stopped) return;
      ctx.emit({ type: 'error', error: { message: `The dev server stopped (exit code ${code ?? 'unknown'}).`, hint: 'Live reload needs it: stop and start live mode again.', expected: true } });
    });
    const session = await sessionPromise;
    this.pipeline = new Pipeline(session, project, ctx);
    this.target = await this.pipeline.chooseTarget(options);
    this.liveUrl = await this.connectLive(session, this.devPort);
    ctx.emit({ type: 'tunnel', state: 'up', liveUrl: this.liveUrl, localUrl: devServer.url.host });
    this.unsubscribeLink = this.link.onChange((state, next) => this.onLinkChange(state, next));
    await this.cycle({ full: options.full, clean: options.clean });
    if (options.watch !== false && !this.stopped) {
      this.watcher = watchNativeChanges(project, (kinds, paths) => {
        ctx.emit({ type: 'native-change', paths, kinds: [...kinds] });
        void this.cycle({ full: kinds.has('deps') });
      });
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

  /**
   * Reverse tunnel: the Mac's localhost:<port> reaches the dev server on this
   * PC. Devices cannot reach the Mac's loopback, so for them the tunnel is
   * also exposed on the Mac's LAN address. Returns the URL the app loads.
   */
  private async connectLive(session: MacSession, preferredPort: number): Promise<string> {
    const devUrl = this.devServer!.url;
    const localHost = devUrl.hostname.replace(/^\[|\]$/g, '');
    const urlPath = `${devUrl.pathname}${devUrl.search}`;
    try {
      this.tunnel = await session.conn.reverseForward(preferredPort, this.devPort, localHost, this.tunnelObserver);
    } catch {
      this.tunnel = await session.conn.reverseForward(0, this.devPort, localHost, this.tunnelObserver);
    }
    this.lastTunnelPort = this.tunnel.port;
    if (this.target!.kind !== 'device') return `${devUrl.protocol}//localhost:${this.tunnel.port}${urlPath}`;
    this.relay = await session.agent.start('relay', {
      listenHost: '0.0.0.0',
      listenPort: this.relayPort || (this.devPort === this.tunnel.port ? 0 : this.devPort),
      targetPort: this.tunnel.port,
    });
    const ready = await this.relay.waitFor<{ data: { port: number; addresses: string[] } }>('ready');
    const ip = ready.data.addresses[0];
    if (!ip) throw new UserError('The Mac has no network address the iPhone could use to reach the dev server.');
    this.relayPort = ready.data.port;
    return `${devUrl.protocol}//${ip}:${ready.data.port}${urlPath}`;
  }

  private async stopApp(): Promise<void> {
    if (!this.app) return;
    const current = this.app;
    this.app = null;
    current.controller.abort();
    await current.done;
  }

  private launch(): void {
    const controller = new AbortController();
    const build = this.lastBuild!;
    const done = this.pipeline!
      .deploy(this.target!, build, {
        attach: true,
        showSimulator: this.options.showSimulator,
        osLogs: this.options.osLogs,
        signal: controller.signal,
        onReady: () => this.ctx.emit({ type: 'session', mode: 'live', state: 'running' }),
      })
      .then((result) => {
        if (result.reason === 'exited' && !this.stopped) this.ctx.emit({ type: 'session', mode: 'live', state: 'idle' });
      })
      .catch((err) => {
        if (!isCancelled(err) && !this.reconnecting && !this.stopped) {
          const error = toErrorInfo(err);
          this.ctx.emit({ type: 'error', error });
          this.ctx.emit({ type: 'session', mode: 'live', state: 'failed', error });
        }
      });
    this.app = { controller, done };
  }

  private async cycle(request: CycleRequest): Promise<void> {
    if (this.stopped || !this.pipeline || !this.target) return;
    if (this.busy || this.reconnecting) {
      const queued = this.queued;
      this.queued = { full: queued?.full || request.full, clean: queued?.clean || request.clean, relaunchOnly: (queued?.relaunchOnly ?? true) && request.relaunchOnly };
      return;
    }
    this.busy = true;
    const signal = this.stopAll.signal;
    try {
      if (!request.relaunchOnly || !this.lastBuild) {
        this.ctx.emit({ type: 'session', mode: 'live', state: 'building' });
        await this.pipeline!.sync(true, signal);
        await this.pipeline!.prepare(this.liveUrl, { full: request.full, signal });
        this.lastBuild = await this.pipeline!.build(this.target!, {
          configuration: this.options.configuration,
          scheme: this.options.scheme,
          team: this.options.team,
          clean: request.clean,
          force: request.clean,
          auth: this.options.auth,
        }, signal);
      }
      await this.stopApp();
      if (!this.stopped) this.launch();
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

  /** Rebuilds (sync, prepare, build) and relaunches. */
  rebuild(options: { clean?: boolean; full?: boolean } = {}): void {
    void this.cycle(options);
  }

  /** Relaunches the app without building. */
  relaunch(): void {
    void this.cycle({ relaunchOnly: true });
  }

  private onLinkChange(state: string, session: MacSession | null): void {
    if (this.stopped) return;
    if (state === 'lost') {
      // Everything that ran over the old connection died with it.
      this.reconnecting = true;
      this.app = null;
      this.tunnel = null;
      this.relay = null;
      this.hmrSockets.clear();
      this.ctx.emit({ type: 'tunnel', state: 'down' });
      this.ctx.emit({ type: 'hmr', state: 'disconnected', at: Date.now() });
    } else if (state === 'restored' && session) {
      void this.restore(session);
    }
  }

  private async restore(session: MacSession): Promise<void> {
    try {
      this.pipeline!.session = session;
      const nextUrl = await this.connectLive(session, this.lastTunnelPort || this.devPort);
      if (nextUrl !== this.liveUrl) {
        this.liveUrl = nextUrl;
        log(this.ctx, 'info', `Live reload now uses ${nextUrl}`);
      }
      this.ctx.emit({ type: 'tunnel', state: 'up', liveUrl: this.liveUrl, localUrl: this.devServer!.url.host });
      this.reconnecting = false;
      void this.cycle({});
    } catch (err) {
      // Could not restore the tunnel on this connection: drop it and let the link try again.
      log(this.ctx, 'note', `  could not restore the live-reload tunnel (${(err as Error)?.message ?? err}); retrying…`);
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
        this.relay?.cancel();
        await this.tunnel?.close().catch(() => undefined);
        this.tunnel = null;
        await this.devServer?.stop().catch(() => undefined);
      })();
    }
    return this.stopping;
  }

  /** Stops the app, the tunnel and (if capmac started it) the dev server. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopping' });
    await this.teardown();
    this.ctx.emit({ type: 'tunnel', state: 'down' });
    this.ctx.emit({ type: 'session', mode: 'live', state: 'stopped' });
  }
}
