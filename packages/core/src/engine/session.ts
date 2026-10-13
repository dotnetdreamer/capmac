import { promises as fs } from 'node:fs';
import net from 'node:net';
import { ROUTE_CHOICES, type Route, type RouteChoice } from '../shared/remote.js';
import { AgentClient, type CallHandlers } from './agent-client.js';
import { ensureClientKey, loadGlobalConfig, resolveHost, updateHost, type HostConfig, type HostRemote } from './config.js';
import { canConnect } from './devserver.js';
import { isCancelled, UserError } from './errors.js';
import { openRemote, type RemoteStream } from './remote/connect.js';
import { discoverRuntime } from './remote-env.js';
import { resolveMacAddress } from './resolve.js';
import { HostKeyMismatchError, MacConnection, SshError } from './ssh.js';

export interface SessionOptions {
  /** Host alias from --mac (falls back to capmac.json, then the default host). */
  host?: string;
  /** Which way to connect; overrides the Mac's setting (see setRouteOverride). */
  route?: RouteChoice;
  signal?: AbortSignal;
}

let routeOverride: RouteChoice | null = null;

/** Makes every connection in this process go one way (the CLI's --route). */
export function setRouteOverride(route: RouteChoice | null): void {
  routeOverride = route;
}

function envRoute(): RouteChoice | null {
  const value = process.env.CAPMAC_ROUTE?.trim().toLowerCase();
  return value && (ROUTE_CHOICES as readonly string[]).includes(value) ? (value as RouteChoice) : null;
}

/** The local network gets this head start before the internet is tried too. */
const LAN_HEAD_START_MS = 500;

interface Opened {
  conn: MacConnection;
  route: Route;
  stream: RemoteStream | null;
  /** The IP address that worked (local network). */
  address?: string;
  resolvedVia?: string;
}

/** The key CapMac logs in to `host` with (undefined when it uses the OpenSSH agent). */
export async function privateKeyFor(host: HostConfig): Promise<string | Buffer | undefined> {
  if (host.agent) return undefined;
  return host.identityFile ? fs.readFile(host.identityFile) : (await ensureClientKey()).privateKey;
}

function sshTo(address: string, host: HostConfig, privateKey: string | Buffer | undefined, signal?: AbortSignal): Promise<MacConnection> {
  return MacConnection.connect({
    host: address,
    label: host.host,
    port: host.port,
    username: host.username,
    privateKey,
    agent: host.agent,
    verifyHostKey: (fp) => fp === host.hostKey,
    signal,
  });
}

async function connectLan(host: HostConfig, privateKey: string | Buffer | undefined, signal?: AbortSignal): Promise<Opened> {
  // The address that worked last time usually still does, and Windows can take
  // seconds to resolve a ".local" name: try it first when it answers at once.
  if (host.lastAddress && !net.isIP(host.host) && (await canConnect(host.lastAddress, host.port, 600))) {
    try {
      const conn = await sshTo(host.lastAddress, host, privateKey, signal);
      return { conn, route: 'lan', stream: null, address: host.lastAddress, resolvedVia: 'cache' };
    } catch (err) {
      // Another device has that address now (or it stopped answering): look the Mac up by name.
      if (!(err instanceof HostKeyMismatchError) && (err as SshError)?.code !== 'ECONNRESET' && (err as SshError)?.code !== 'TIMEOUT') throw err;
    }
  }
  const resolved = await resolveMacAddress(host.host, host.lastAddress);
  if (signal?.aborted) throw new UserError('Cancelled');
  const conn = await sshTo(resolved.address, host, privateKey, signal);
  return { conn, route: 'lan', stream: null, address: resolved.address, resolvedVia: resolved.via };
}

async function connectInternet(host: HostConfig, remote: HostRemote, privateKey: string | Buffer | undefined, signal?: AbortSignal): Promise<Opened> {
  const label = host.macName ?? host.host;
  const stream = await openRemote({ label, macKey: remote.macKey, signalUrl: remote.signalUrl, relay: remote.relay ?? 'allow' }, { signal });
  try {
    const conn = await MacConnection.connect({
      host: label,
      label,
      port: host.port,
      username: host.username,
      privateKey,
      agent: host.agent,
      verifyHostKey: (fp) => fp === host.hostKey,
      sock: stream.sock,
      // The connection is already up; SSH only has to shake hands.
      readyTimeoutMs: 30_000,
      signal,
    });
    void conn.closedPromise.then(() => stream.close());
    return { conn, route: stream.route, stream };
  } catch (err) {
    stream.close();
    throw err;
  }
}

/** Both ways failed: say what happened on each. */
function bothFailed(label: string, lan: unknown, internet: unknown): UserError {
  const l = lan as { message?: string; hint?: string; code?: string };
  const r = internet as { message?: string; hint?: string; code?: string };
  // The Mac answered on the local network but refused CapMac: that is the real problem.
  if (l?.code === 'AUTH') return lan as UserError;
  return new UserError(
    r?.code === 'MAC_OFFLINE' || r?.code === 'NOT_PAIRED' ? (r.message ?? `Cannot reach ${label}.`) : `Cannot reach ${label}.`,
    r?.hint ?? l?.hint,
    [`On the local network: ${l?.message ?? String(lan)}`, `Over the internet: ${r?.message ?? String(internet)}`],
  );
}

/** Tries the local network first and the internet shortly after; the first to answer wins. */
function race(host: HostConfig, remote: HostRemote, privateKey: string | Buffer | undefined, outer?: AbortSignal): Promise<Opened> {
  const label = host.macName ?? host.host;
  const lanAbort = new AbortController();
  const netAbort = new AbortController();
  const abortBoth = () => {
    lanAbort.abort();
    netAbort.abort();
  };
  outer?.addEventListener('abort', abortBoth, { once: true });
  return new Promise<Opened>((resolve, reject) => {
    let done = false;
    let pending = 1;
    let internetStarted = false;
    const errors: { lan?: unknown; internet?: unknown } = {};
    const finish = () => {
      done = true;
      clearTimeout(timer);
      outer?.removeEventListener('abort', abortBoth);
    };
    const win = (opened: Opened, loser: AbortController) => {
      if (done) {
        // Too late: the other way already won.
        opened.conn.close();
        opened.stream?.close();
        return;
      }
      finish();
      loser.abort();
      resolve(opened);
    };
    const lose = (which: 'lan' | 'internet', err: unknown) => {
      errors[which] = err;
      pending -= 1;
      if (which === 'lan' && !done && !isCancelled(err)) startInternet();
      if (done || pending > 0 || !internetStarted) return;
      finish();
      if (outer?.aborted) reject(new UserError('Cancelled'));
      else reject(bothFailed(label, errors.lan, errors.internet));
    };
    const startInternet = () => {
      if (internetStarted || done) return;
      internetStarted = true;
      pending += 1;
      connectInternet(host, remote, privateKey, netAbort.signal).then((o) => win(o, lanAbort), (err) => lose('internet', err));
    };
    // A host key that does not match on the local network is another device at that address
    // (this PC is on some other network), not an attack: the internet route still verifies the Mac.
    connectLan(host, privateKey, lanAbort.signal).then((o) => win(o, netAbort), (err) => lose('lan', err instanceof HostKeyMismatchError ? new SshError(`Another device answered at ${host.lastAddress ?? host.host}.`) : err));
    const timer = setTimeout(startInternet, LAN_HEAD_START_MS);
  });
}

/** A live connection to a paired Mac with the agent ready to go. */
export class MacSession {
  private constructor(
    readonly host: HostConfig,
    readonly conn: MacConnection,
    public agent: AgentClient,
    /** How this connection goes: the local network, peer to peer, or the relay. */
    readonly route: Route,
    /** The internet connection under SSH (null on the local network). */
    readonly remoteStream: RemoteStream | null,
  ) {}

  static async open(options: SessionOptions = {}): Promise<MacSession> {
    const config = await loadGlobalConfig();
    const host = resolveHost(config, options.host);
    if (!host) {
      if (options.host) throw new UserError(`No paired Mac called "${options.host}".`, 'See paired Macs with `capmac macs`, or pair a new one with `capmac pair`.');
      if (Object.keys(config.hosts).length > 1) throw new UserError('Several Macs are paired and none is the default.', 'Pick one with --mac <name>, or set a default with `capmac pair --default <name>`.');
      throw new UserError('No Mac is paired yet.', 'Run `capmac pair` to connect this PC to your Mac.');
    }
    const privateKey = await privateKeyFor(host);
    const choice = options.route ?? routeOverride ?? envRoute() ?? host.remote?.route ?? 'auto';
    const remote = host.remote;
    if (choice === 'internet' && !remote) {
      throw new UserError(`Remote access is off for ${host.macName ?? host.host}.`, 'Turn it on while you are on the Mac’s network: `capmac remote on`, or Macs › Remote access in CapMac Studio.');
    }
    const opened = !remote || choice === 'lan'
      ? await connectLan(host, privateKey, options.signal)
      : choice === 'internet'
        ? await connectInternet(host, remote, privateKey, options.signal)
        : await race(host, remote, privateKey, options.signal);
    const conn = opened.conn;
    if (opened.route === 'lan' && opened.address && opened.resolvedVia !== 'unresolved' && opened.resolvedVia !== 'cache' && opened.address !== host.lastAddress) {
      await updateHost(host.name, { lastAddress: opened.address });
    }
    let { nodePath, home } = host;
    if (!nodePath || !home) {
      const runtime = await discoverRuntime(conn);
      if (!runtime.node) {
        conn.close();
        throw new UserError(`Node.js was not found on ${host.macName ?? host.host}.`, 'Run `capmac doctor --fix` to install a private copy, or install Node.js 20+ on the Mac (https://nodejs.org).');
      }
      nodePath = runtime.node.path;
      home = runtime.home;
      await updateHost(host.name, { nodePath, home });
    }
    return new MacSession({ ...host, nodePath, home }, conn, new AgentClient(conn, nodePath, home), opened.route, opened.stream);
  }

  get label(): string {
    return this.host.macName ?? this.host.host;
  }

  /** The round trip measured by WebRTC, for a peer-to-peer connection. */
  get rttMs(): number | null {
    return this.remoteStream?.rttMs() ?? null;
  }

  /** "peer to peer (srflx → host, UDP)", "through signal.example.com", or "local network". */
  get routeDetail(): string {
    return this.remoteStream?.detail ?? 'local network';
  }

  /** Runs an agent operation; re-discovers Node once if the configured one vanished. */
  async call<T>(op: string, params: object = {}, handlers: CallHandlers = {}): Promise<T> {
    try {
      return await this.agent.call<T>(op, params, handlers);
    } catch (err: any) {
      if (err?.code !== 'AGENT_CRASHED' || !/No such file|not found|command not found/i.test((err.tail ?? []).join('\n'))) throw err;
      const runtime = await discoverRuntime(this.conn);
      if (!runtime.node) throw new UserError('Node.js is no longer available on the Mac.', 'Run `capmac doctor --fix`.');
      await updateHost(this.host.name, { nodePath: runtime.node.path, home: runtime.home });
      this.agent = new AgentClient(this.conn, runtime.node.path, runtime.home);
      return this.agent.call<T>(op, params, handlers);
    }
  }

  close(): void {
    this.conn.close();
    this.remoteStream?.close();
  }
}
