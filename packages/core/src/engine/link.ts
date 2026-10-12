/**
 * One connection to a paired Mac, kept alive: connects on demand and, when the
 * Mac sleeps or Wi-Fi drops, dials back in by itself. Everything that talks
 * to the Mac (sessions, the screen, target lists) shares one MacLink, so it
 * all rides on one SSH connection.
 */
import { loadGlobalConfig, resolveHost } from './config.js';
import { wait, type EngineContext } from './context.js';
import { UserError } from './errors.js';
import type { ConnectionState } from './events.js';
import { MacSession } from './session.js';

export interface MacLinkOptions {
  /** Dial back in when the connection drops (default true). */
  autoReconnect?: boolean;
  /** Pause between reconnect attempts (default 3 s). */
  retryMs?: number;
}

export type LinkListener = (state: ConnectionState, session: MacSession | null) => void;

export class MacLink {
  private current: MacSession | null = null;
  private pending: Promise<MacSession> | null = null;
  private readonly listeners = new Set<LinkListener>();
  private readonly stopController = new AbortController();
  private reconnecting = false;
  private everConnected = false;
  state: ConnectionState | 'idle' = 'idle';
  attempt = 0;
  lastError: string | null = null;
  latencyMs: number | null = null;
  /** Friendly name ("IK's M1"), known once resolved or connected. */
  label: string;

  /** `macName` is a paired Mac's alias; undefined means the default Mac. */
  constructor(readonly macName: string | undefined, private readonly ctx: EngineContext | null = null, private readonly options: MacLinkOptions = {}) {
    this.label = macName ?? 'the Mac';
  }

  /** The alias of the Mac this link talks to (resolved from the config when it was the default). */
  get name(): string {
    return this.current?.host.name ?? this.macName ?? '';
  }

  get closed(): boolean {
    return this.stopController.signal.aborted;
  }

  get connected(): boolean {
    return Boolean(this.current && !this.current.conn.isClosed);
  }

  /** The current session if connected (does not connect). */
  get currentSession(): MacSession | null {
    return this.connected ? this.current : null;
  }

  /** Looks up the friendly name from the config without connecting. */
  async resolveLabel(): Promise<string> {
    const host = resolveHost(await loadGlobalConfig(), this.macName);
    if (host) this.label = host.macName ?? host.host;
    return this.label;
  }

  onChange(listener: LinkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: ConnectionState, extra: { attempt?: number; error?: string } = {}): void {
    this.state = state;
    if (extra.error !== undefined) this.lastError = extra.error;
    this.ctx?.emit({ type: 'connection', mac: this.name, label: this.label, state, attempt: extra.attempt, error: extra.error, latencyMs: this.latencyMs ?? undefined });
    for (const listener of [...this.listeners]) {
      try {
        listener(state, this.currentSession);
      } catch {
        // a listener's problem is not the link's
      }
    }
  }

  /** The live session, connecting first if needed. */
  session(): Promise<MacSession> {
    if (this.closed) return Promise.reject(new UserError(`The connection to ${this.label} was closed.`));
    if (this.current && !this.current.conn.isClosed) return Promise.resolve(this.current);
    return this.connectOnce();
  }

  private connectOnce(): Promise<MacSession> {
    if (this.pending) return this.pending;
    const restoring = this.everConnected;
    if (!restoring) this.setState('connecting');
    const started = Date.now();
    this.pending = MacSession.open({ host: this.macName }).then(
      (session) => {
        this.pending = null;
        if (this.closed) {
          session.close();
          throw new UserError(`The connection to ${this.label} was closed.`);
        }
        this.current = session;
        this.label = session.label;
        this.latencyMs = Date.now() - started;
        this.lastError = null;
        this.attempt = 0;
        this.everConnected = true;
        this.watch(session);
        this.setState(restoring ? 'restored' : 'connected');
        return session;
      },
      (err: unknown) => {
        this.pending = null;
        const message = (err as Error)?.message ?? String(err);
        if (!this.reconnecting) this.setState('offline', { error: message });
        throw err;
      },
    );
    return this.pending;
  }

  private watch(session: MacSession): void {
    void session.conn.closedPromise.then(() => {
      if (this.closed || this.current !== session) return;
      this.current = null;
      this.setState('lost');
      if (this.options.autoReconnect !== false) void this.reconnectLoop();
    });
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      for (let attempt = 1; !this.closed && !this.connected; attempt++) {
        this.attempt = attempt;
        try {
          await this.connectOnce();
          return;
        } catch (err) {
          this.setState('reconnecting', { attempt, error: (err as Error)?.message ?? String(err) });
          await wait(this.options.retryMs ?? 3000, this.stopController.signal);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /** Drops the connection on purpose (tests, "simulate disconnect"); auto-reconnect kicks in. */
  dropConnection(): void {
    this.current?.conn.client.destroy();
  }

  close(): void {
    if (this.closed) return;
    this.stopController.abort();
    const session = this.current;
    this.current = null;
    session?.close();
    this.setState('closed');
    this.listeners.clear();
  }
}
