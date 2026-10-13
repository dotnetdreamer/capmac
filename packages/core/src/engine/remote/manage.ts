/**
 * Remote access ("Reach this Mac from anywhere"), as the CLI and CapMac
 * Studio offer it: turning it on and off for a Mac, its options, the PCs a
 * Mac lets in, and the signaling server. Both front ends call these, so they
 * offer the same options with the same defaults and share one config.
 */
import { RELAY_CHOICES, ROUTE_CHOICES, signalUrlProblem, type PublicKey, type RelayChoice, type RemoteSettings, type RemoteTestResult, type RouteChoice, type SignalServerSetting } from '../../shared/remote.js';
import type { RemoteDoorStatus, RemotePc } from '../../shared/remote-door.js';
import { loadGlobalConfig, resolveHost, saveGlobalConfig, type HostConfig, type HostRemote } from '../config.js';
import { log, wait, withStep, type EngineContext } from '../context.js';
import { UserError } from '../errors.js';
import { privateKeyFor, type MacSession } from '../session.js';
import { MacConnection } from '../ssh.js';
import { AgentEventTranslator } from '../translate.js';
import { openRemote } from './connect.js';
import { pcIdentity, pcName } from './identity.js';

declare const __CAPMAC_SIGNAL_URL__: string | undefined;
/** The signaling server a release of CapMac was built with (CAPMAC_DEFAULT_SIGNAL_URL at build time). */
const BUILT_IN_SIGNAL_URL = typeof __CAPMAC_SIGNAL_URL__ === 'string' && __CAPMAC_SIGNAL_URL__ ? __CAPMAC_SIGNAL_URL__ : null;

export type { RemoteSettings, RemoteTestResult, SignalServerSetting } from '../../shared/remote.js';

export const DEFAULT_ROUTE: RouteChoice = 'auto';
export const DEFAULT_RELAY: RelayChoice = 'allow';

export function remoteSettings(host: HostConfig): RemoteSettings {
  const r = host.remote;
  return {
    enabled: Boolean(r),
    route: r?.route ?? DEFAULT_ROUTE,
    relay: r?.relay ?? DEFAULT_RELAY,
    keepAwake: r?.keepAwake ?? false,
    signalUrl: r?.signalUrl ?? null,
    macKey: r?.macKey ?? null,
    enabledAt: r?.enabledAt ?? null,
  };
}

/** The signaling server for turning remote access on: CAPMAC_SIGNAL_URL, then the setting, then the build's. */
export async function signalServer(): Promise<SignalServerSetting> {
  const env = process.env.CAPMAC_SIGNAL_URL?.trim();
  if (env) return { url: env, source: 'environment' };
  const config = await loadGlobalConfig();
  if (config.signalUrl) return { url: config.signalUrl, source: 'settings' };
  if (BUILT_IN_SIGNAL_URL) return { url: BUILT_IN_SIGNAL_URL, source: 'built-in' };
  return { url: null, source: 'none' };
}

/** Sets (or, with null, clears) the signaling server in CapMac's settings. */
export async function setSignalServer(url: string | null): Promise<SignalServerSetting> {
  const value = url?.trim() || null;
  if (value) {
    const problem = signalUrlProblem(value);
    if (problem) throw new UserError(problem);
  }
  const config = await loadGlobalConfig();
  if (value) config.signalUrl = value;
  else delete config.signalUrl;
  await saveGlobalConfig(config);
  return signalServer();
}

const NO_SERVER = new UserError(
  'Remote access needs your signaling server’s address.',
  'Set it with `capmac remote set --signal-url wss://signal.example.com`, or in CapMac Studio’s Settings › Remote access. (Deploy the server from services/signal.)',
);

async function saveRemote(name: string, remote: HostRemote | undefined): Promise<HostConfig> {
  const config = await loadGlobalConfig();
  const host = config.hosts[name];
  if (!host) throw new UserError(`No paired Mac called "${name}".`);
  if (remote) host.remote = remote;
  else delete host.remote;
  await saveGlobalConfig(config);
  return host;
}

async function hostNamed(name: string): Promise<HostConfig> {
  const host = resolveHost(await loadGlobalConfig(), name);
  if (!host) throw new UserError(`No paired Mac called "${name}".`, 'See paired Macs with `capmac macs`.');
  return host;
}

async function callDoor<T>(session: MacSession, op: string, params: object, ctx: EngineContext): Promise<T> {
  const translator = new AgentEventTranslator(ctx, op);
  try {
    return await session.call<T>(op, params, { onEvent: translator.handle });
  } catch (err) {
    translator.closeOpenSteps('failed');
    if ((err as { code?: string })?.code === 'BAD_REQUEST' && /Unknown operation/.test((err as Error).message)) {
      throw new UserError('The CapMac agent on the Mac is too old for remote access.', 'Update CapMac and try again.');
    }
    throw err;
  }
}

/** Connects to the Mac the way a PC elsewhere would (signaling, WebRTC or relay, then SSH), and hangs up. */
export async function testRemote(host: HostConfig, options: { signal?: AbortSignal } = {}): Promise<RemoteTestResult> {
  const remote = host.remote;
  if (!remote) return { ok: false, error: 'Remote access is off.' };
  const started = Date.now();
  try {
    const label = host.macName ?? host.host;
    const stream = await openRemote({ label, macKey: remote.macKey, signalUrl: remote.signalUrl, relay: remote.relay ?? DEFAULT_RELAY }, { signal: options.signal });
    try {
      const privateKey = await privateKeyFor(host);
      const conn = await MacConnection.connect({ host: label, label, port: host.port, username: host.username, privateKey, agent: host.agent, verifyHostKey: (fp) => fp === host.hostKey, sock: stream.sock, signal: options.signal });
      conn.close();
      return { ok: true, route: stream.route, detail: stream.detail, ms: Date.now() - started };
    } finally {
      stream.close();
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message, ms: Date.now() - started };
  }
}

export interface EnableRemoteOptions {
  keepAwake?: boolean;
  /** Otherwise the Mac's current server, then CapMac's setting (signalServer()). */
  signalUrl?: string;
  /** Check the connection over the internet afterwards (default true). */
  test?: boolean;
}

export interface EnableRemoteResult {
  host: HostConfig;
  door: RemoteDoorStatus;
  test: RemoteTestResult | null;
}

/**
 * Turns remote access on for the Mac `session` is connected to (usually over
 * the local network): installs or updates the door, lets this PC in, and
 * remembers the Mac's remote-access key.
 */
export async function enableRemote(session: MacSession, options: EnableRemoteOptions, ctx: EngineContext): Promise<EnableRemoteResult> {
  const host = session.host;
  const signalUrl = options.signalUrl?.trim() || host.remote?.signalUrl || (await signalServer()).url;
  if (!signalUrl) throw NO_SERVER;
  const problem = signalUrlProblem(signalUrl);
  if (problem) throw new UserError(problem);
  const identity = await pcIdentity();
  const door = await withStep(ctx, `Turning on remote access for ${session.label}`, 'other', () =>
    callDoor<RemoteDoorStatus>(session, 'remote-install', {
      signalUrl,
      sshPort: host.port,
      pc: { key: identity.publicKey, name: pcName() },
      keepAwake: options.keepAwake ?? host.remote?.keepAwake,
      nodePath: host.nodePath,
    }, ctx));
  if (!door.macKey) throw new UserError('The Mac did not report its remote-access key.', 'Try again; if it keeps happening, turn remote access off and on.');
  const previous = host.remote;
  const saved = await saveRemote(host.name, {
    macKey: door.macKey,
    signalUrl,
    enabledAt: previous?.enabledAt ?? new Date().toISOString(),
    route: previous?.route ?? DEFAULT_ROUTE,
    relay: previous?.relay ?? DEFAULT_RELAY,
    keepAwake: door.keepAwake,
  });
  if (door.status?.state !== 'online') {
    log(ctx, 'warn', `${session.label}'s remote-access service is ${door.status?.state ?? 'not running'}${door.status?.error ? `: ${door.status.error}` : ''}.`, 'Check that the Mac can reach the signaling server.');
  }
  let test: RemoteTestResult | null = null;
  if (options.test !== false) {
    test = await withStep(ctx, 'Testing the connection over the internet', 'other', async () => {
      const first = await testRemote(saved);
      if (first.ok || session.route === 'lan') return first;
      // Reached through the door, which restarts a moment after an update: give it that moment.
      await wait(2500);
      return testRemote(saved);
    }, (r) => (r.ok ? `${r.route === 'relay' ? 'through the relay' : 'peer to peer'} · ${r.ms} ms` : 'failed'));
    if (!test.ok) log(ctx, 'warn', `This PC could not reach ${session.label} over the internet: ${test.error}`, 'Check the signaling server’s address, and that this PC can reach it.');
  }
  return { host: saved, door, test };
}

/**
 * Turns remote access off for this PC: the Mac stops letting it in (the door
 * is removed when no other PC uses it). With `localOnly`, only forgets it here
 * (when the Mac cannot be reached).
 */
export async function disableRemote(target: MacSession | string, ctx: EngineContext, options: { localOnly?: boolean } = {}): Promise<HostConfig> {
  if (typeof target === 'string' || options.localOnly) {
    const name = typeof target === 'string' ? target : target.host.name;
    log(ctx, 'note', 'The Mac still lists this PC until you turn remote access off from its network.');
    return saveRemote((await hostNamed(name)).name, undefined);
  }
  const identity = await pcIdentity();
  await withStep(ctx, `Turning off remote access for ${target.label}`, 'other', () => callDoor<RemoteDoorStatus>(target, 'remote-revoke', { key: identity.publicKey, uninstallIfLast: true }, ctx));
  return saveRemote(target.host.name, undefined);
}

export interface RemoteOptionsPatch {
  route?: RouteChoice;
  relay?: RelayChoice;
  keepAwake?: boolean;
  signalUrl?: string;
}

/**
 * Changes a Mac's remote-access options. The route and the relay are this
 * PC's choices; keeping the Mac awake and its signaling server are the Mac's,
 * so they need `session`.
 */
export async function setRemoteOptions(name: string, patch: RemoteOptionsPatch, session: MacSession | null, ctx: EngineContext): Promise<HostConfig> {
  const host = await hostNamed(name);
  if (!host.remote) throw new UserError(`Remote access is off for ${host.macName ?? host.host}.`, 'Turn it on first: `capmac remote on`.');
  if (patch.route !== undefined && !(ROUTE_CHOICES as readonly string[]).includes(patch.route)) throw new UserError(`"${patch.route}" is not a route: use ${ROUTE_CHOICES.join(', ')}.`);
  if (patch.relay !== undefined && !(RELAY_CHOICES as readonly string[]).includes(patch.relay)) throw new UserError(`"${patch.relay}" is not a relay setting: use ${RELAY_CHOICES.join(', ')}.`);
  const remote: HostRemote = { ...host.remote };
  if (patch.route !== undefined) remote.route = patch.route;
  if (patch.relay !== undefined) remote.relay = patch.relay;
  if (patch.keepAwake !== undefined || patch.signalUrl !== undefined) {
    if (patch.signalUrl !== undefined) {
      const problem = signalUrlProblem(patch.signalUrl);
      if (problem) throw new UserError(problem);
    }
    if (!session) throw new UserError(`Changing that needs a connection to ${host.macName ?? host.host}.`);
    const door = await withStep(ctx, `Updating remote access on ${session.label}`, 'other', () =>
      callDoor<RemoteDoorStatus>(session, 'remote-set', { keepAwake: patch.keepAwake, signalUrl: patch.signalUrl?.trim() }, ctx));
    remote.keepAwake = door.keepAwake;
    if (door.signalUrl) remote.signalUrl = door.signalUrl;
  }
  return saveRemote(host.name, remote);
}

/** The door on the Mac: installed, running, online, which PCs it lets in. */
export async function remoteDoorStatus(session: MacSession): Promise<RemoteDoorStatus | null> {
  try {
    return await session.call<RemoteDoorStatus>('remote-status');
  } catch (err) {
    if ((err as { code?: string })?.code === 'BAD_REQUEST') return null;
    throw err;
  }
}

/** The PCs that can reach the Mac over the internet; `current` marks this one. */
export async function listRemotePcs(session: MacSession): Promise<Array<RemotePc & { current: boolean }>> {
  const status = await remoteDoorStatus(session);
  const me = (await pcIdentity()).publicKey;
  return (status?.pcs ?? []).map((pc) => ({ ...pc, current: pc.key === me }));
}

/** Stops letting another PC in over the internet. */
export async function revokeRemotePc(session: MacSession, key: PublicKey, ctx: EngineContext): Promise<Array<RemotePc & { current: boolean }>> {
  const me = (await pcIdentity()).publicKey;
  if (key === me) throw new UserError('That is this PC.', 'Turn remote access off instead: `capmac remote off`.');
  await withStep(ctx, `Removing a PC from ${session.label}`, 'other', () => callDoor<RemoteDoorStatus>(session, 'remote-revoke', { key }, ctx));
  return listRemotePcs(session);
}

/** This PC's remote-access identity (its public key), for showing in lists. */
export async function thisPc(): Promise<{ key: PublicKey; name: string }> {
  return { key: (await pcIdentity()).publicKey, name: pcName() };
}
