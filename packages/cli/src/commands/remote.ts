import {
  disableRemote,
  enableRemote,
  listRemotePcs,
  loadGlobalConfig,
  loadProject,
  MacSession,
  remoteChecks,
  remoteDoorStatus,
  remoteSettings,
  resolveHost,
  revokeRemotePc,
  setRemoteOptions,
  setSignalServer,
  signalServer,
  testRemote,
  thisPc,
  UserError,
  type EngineContext,
  type HostConfig,
} from '@capmac/core/engine';
import { RELAY_CHOICES, ROUTE_CHOICES, shortKey, signalUrlProblem, type RelayChoice, type Route, type RouteChoice } from '@capmac/core/shared/remote';
import { terminalContext } from '../terminal.js';
import { ask, canPrompt, log, pc } from '../ui.js';
import { printChecks } from './doctor.js';

export interface RemoteOptions {
  mac?: string;
  json?: boolean;
}

export const ROUTE_TEXT: Record<RouteChoice, string> = {
  auto: 'Automatic: the local network when the Mac answers there, else the internet',
  lan: 'Local network only',
  internet: 'Over the internet only',
};

export const RELAY_TEXT: Record<RelayChoice, string> = {
  allow: 'Used when peer to peer is not possible',
  never: 'Never (peer to peer only)',
  always: 'Always (for testing)',
};

export function routeText(route: Route): string {
  return route === 'lan' ? 'on the local network' : route === 'direct' ? 'peer to peer over the internet' : 'through the relay';
}

async function hostFor(options: RemoteOptions): Promise<HostConfig> {
  let projectHost: string | undefined;
  try {
    projectHost = (await loadProject(process.cwd())).config.host;
  } catch {
    // not inside a Capacitor app
  }
  const config = await loadGlobalConfig();
  const host = resolveHost(config, options.mac ?? projectHost);
  if (!host) {
    if (Object.keys(config.hosts).length === 0) throw new UserError('No Mac is paired yet.', 'Run `capmac pair` first.');
    throw new UserError(options.mac ? `No paired Mac called "${options.mac}".` : 'Several Macs are paired and none is the default.', 'Pick one with --mac <name>.');
  }
  return host;
}

const label = (host: HostConfig) => host.macName ?? host.host;

/** Asks for the signaling server when none is set (interactive terminals only). */
async function askForServer(): Promise<string | null> {
  if (!canPrompt()) return null;
  log.line(`Remote access goes through your own signaling server (deploy it from ${pc.cyan('services/signal')}).`);
  for (;;) {
    const typed = (await ask('Signaling server address (wss://…):')).trim();
    if (!typed) return null;
    const problem = signalUrlProblem(typed);
    if (!problem) {
      await setSignalServer(typed);
      return typed;
    }
    log.warn(problem);
  }
}

/** Turns remote access on for a Mac; shared by `capmac remote on` and `capmac pair --remote`. */
export async function turnRemoteOn(session: MacSession, options: { signalUrl?: string; keepAwake?: boolean }, ctx: EngineContext): Promise<void> {
  let signalUrl = options.signalUrl;
  if (signalUrl) {
    const problem = signalUrlProblem(signalUrl);
    if (problem) throw new UserError(problem);
    if (!(await signalServer()).url) await setSignalServer(signalUrl);
  } else if (!session.host.remote && !(await signalServer()).url) {
    signalUrl = (await askForServer()) ?? undefined;
  }
  const result = await enableRemote(session, { signalUrl, keepAwake: options.keepAwake }, ctx);
  log.line();
  log.success(`Remote access is on for ${pc.bold(session.label)}.`);
  if (result.test?.ok && result.test.route) log.line(pc.dim(`  Tested: ${routeText(result.test.route)}, ${result.test.ms} ms.`));
  log.line(pc.dim('  Away from this network, CapMac reaches the Mac by itself. It runs while you are logged in on the Mac.'));
  if (!result.door.keepAwake) log.line(pc.dim(`  Tip: ${pc.cyan('capmac remote set --keep-awake on')} stops the Mac from sleeping while you are away.`));
}

export async function remoteOnCommand(options: RemoteOptions & { signalUrl?: string; keepAwake?: boolean }): Promise<void> {
  const { ctx } = terminalContext();
  const host = await hostFor(options);
  const session = await MacSession.open({ host: host.name, route: host.remote ? undefined : 'lan' }).catch((err) => {
    if (host.remote) throw err;
    throw new UserError(`Cannot reach ${label(host)} on the local network.`, 'Turn remote access on while this PC is on the Mac’s network.', [(err as Error).message]);
  });
  try {
    await turnRemoteOn(session, options, ctx);
  } finally {
    session.close();
  }
}

export async function remoteOffCommand(options: RemoteOptions & { local?: boolean }): Promise<void> {
  const { ctx } = terminalContext();
  const host = await hostFor(options);
  if (!host.remote) {
    log.info(`Remote access is already off for ${label(host)}.`);
    return;
  }
  if (options.local) {
    await disableRemote(host.name, ctx, { localOnly: true });
    log.success(`This PC no longer uses remote access for ${label(host)}.`);
    return;
  }
  const session = await MacSession.open({ host: host.name }).catch((err) => {
    throw new UserError(`Cannot reach ${label(host)} to turn remote access off there.`, 'Try again when it is reachable, or run `capmac remote off --local` to stop using it from this PC only.', [(err as Error).message]);
  });
  try {
    await disableRemote(session, ctx);
  } finally {
    session.close();
  }
  log.success(`Remote access is off for ${label(host)}: the Mac no longer lets this PC in over the internet.`);
}

function parseOnOff(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(on|yes|true|1)$/i.test(value)) return true;
  if (/^(off|no|false|0)$/i.test(value)) return false;
  throw new UserError(`${flag} takes "on" or "off".`);
}

export async function remoteSetCommand(options: RemoteOptions & { route?: string; relay?: string; keepAwake?: string; signalUrl?: string }): Promise<void> {
  const { ctx } = terminalContext();
  const host = await hostFor(options);
  const keepAwake = parseOnOff(options.keepAwake, '--keep-awake');
  if (options.route !== undefined && !(ROUTE_CHOICES as readonly string[]).includes(options.route)) throw new UserError(`--route takes ${ROUTE_CHOICES.join(', ')}.`);
  if (options.relay !== undefined && !(RELAY_CHOICES as readonly string[]).includes(options.relay)) throw new UserError(`--relay takes ${RELAY_CHOICES.join(', ')}.`);
  if (options.route === undefined && options.relay === undefined && keepAwake === undefined && options.signalUrl === undefined) {
    throw new UserError('Nothing to change.', 'Use --route, --relay, --keep-awake or --signal-url (see `capmac remote set --help`).');
  }
  const needsMac = keepAwake !== undefined || options.signalUrl !== undefined;
  const session = needsMac ? await MacSession.open({ host: host.name }) : null;
  try {
    const updated = await setRemoteOptions(host.name, { route: options.route as RouteChoice | undefined, relay: options.relay as RelayChoice | undefined, keepAwake, signalUrl: options.signalUrl }, session, ctx);
    log.success(`Updated remote access for ${label(updated)}.`);
    printSettings(updated);
  } finally {
    session?.close();
  }
}

function printSettings(host: HostConfig): void {
  const s = remoteSettings(host);
  const row = (name: string, value: string) => log.line(`  ${pc.dim(name.padEnd(18))}${value}`);
  row('Signaling server', s.signalUrl ?? pc.dim('none'));
  row('Connection', ROUTE_TEXT[s.route]);
  row('Relay', RELAY_TEXT[s.relay]);
  row('Keep awake', s.keepAwake ? 'On: the Mac does not sleep while remote access is on' : 'Off');
}

export async function remoteStatusCommand(options: RemoteOptions & { test?: boolean }): Promise<void> {
  const host = await hostFor(options);
  const settings = remoteSettings(host);
  const me = await thisPc();
  const server = await signalServer();
  let session: MacSession | null = null;
  let connectError: string | null = null;
  const started = Date.now();
  try {
    session = await MacSession.open({ host: host.name });
  } catch (err) {
    connectError = (err as Error).message;
  }
  const connectedMs = Date.now() - started;
  try {
    const door = session ? await remoteDoorStatus(session).catch(() => null) : null;
    const test = options.test && host.remote ? await testRemote(host) : null;
    if (options.json) {
      console.log(JSON.stringify({
        mac: host.name,
        label: label(host),
        ...settings,
        thisPc: me,
        defaultSignalServer: server,
        connection: session ? { route: session.route, detail: session.routeDetail, rttMs: session.rttMs, ms: connectedMs } : { error: connectError },
        door,
        test,
      }, null, 2));
      return;
    }
    log.line(`${pc.bold(label(host))} ${pc.dim('·')} remote access ${settings.enabled ? pc.green('on') : 'off'}`);
    if (settings.enabled) printSettings(host);
    else log.line(pc.dim(`  Turn it on with ${pc.cyan('capmac remote on')} while you are on the Mac’s network.${server.url ? '' : ' It needs your signaling server: `capmac remote server <url>`.'}`));
    log.line(`  ${pc.dim('This PC'.padEnd(18))}${me.name} ${pc.dim(`(${shortKey(me.key)})`)}`);
    log.line(`  ${pc.dim('Connected'.padEnd(18))}${session ? `${routeText(session.route)} in ${connectedMs} ms${session.rttMs !== null ? pc.dim(` · round trip ${session.rttMs} ms`) : ''}` : pc.red(connectError ?? 'no')}`);
    if (session) {
      log.line();
      printChecks('On the Mac', remoteChecks(host, door, session.route, me.key));
    }
    if (test) {
      log.line();
      log.line(test.ok ? `${pc.green('✔')} Over the internet: ${routeText(test.route!)}, ${test.ms} ms ${pc.dim(`(${test.detail})`)}` : `${pc.red('✖')} Over the internet: ${test.error}`);
    }
  } finally {
    session?.close();
  }
}

export async function remoteTestCommand(options: RemoteOptions): Promise<void> {
  const host = await hostFor(options);
  if (!host.remote) throw new UserError(`Remote access is off for ${label(host)}.`, 'Turn it on with `capmac remote on`.');
  const result = await testRemote(host);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.ok) throw new UserError(`Could not reach ${label(host)} over the internet: ${result.error}`);
  log.success(`Reached ${label(host)} ${routeText(result.route!)} in ${result.ms} ms ${pc.dim(`(${result.detail})`)}`);
}

export async function remoteServerCommand(url: string | undefined, options: { clear?: boolean; json?: boolean }): Promise<void> {
  const setting = options.clear ? await setSignalServer(null) : url ? await setSignalServer(url) : await signalServer();
  if (options.json) {
    console.log(JSON.stringify(setting, null, 2));
    return;
  }
  if (url || options.clear) log.success(setting.url ? `Signaling server: ${setting.url}` : 'Signaling server cleared.');
  else if (setting.url) log.line(`Signaling server: ${setting.url} ${pc.dim(`(${setting.source === 'environment' ? 'from CAPMAC_SIGNAL_URL' : setting.source === 'built-in' ? 'built in' : 'set with `capmac remote server`'})`)}`);
  else log.line(`No signaling server is set. Deploy one (services/signal), then run ${pc.cyan('capmac remote server wss://your-server')}.`);
  const config = await loadGlobalConfig();
  const elsewhere = Object.values(config.hosts).filter((h) => h.remote && h.remote.signalUrl !== setting.url);
  for (const h of elsewhere) log.line(pc.dim(`  ${label(h)} uses ${h.remote!.signalUrl}; move it with \`capmac remote set --mac ${h.name} --signal-url <url>\`.`));
}

export async function remotePcsCommand(options: RemoteOptions): Promise<void> {
  const host = await hostFor(options);
  const session = await MacSession.open({ host: host.name });
  try {
    const pcs = await listRemotePcs(session);
    if (options.json) {
      console.log(JSON.stringify(pcs, null, 2));
      return;
    }
    if (pcs.length === 0) {
      log.info(`No PC can reach ${label(host)} over the internet.`);
      return;
    }
    log.line(pc.bold(`PCs that can reach ${label(host)} over the internet`));
    for (const p of pcs) log.line(`  ${p.current ? pc.green('●') : pc.dim('○')} ${p.name} ${pc.dim(`${shortKey(p.key)} · added ${p.addedAt.slice(0, 10)}`)}${p.current ? pc.dim('  (this PC)') : ''}`);
  } finally {
    session.close();
  }
}

export async function remoteRevokeCommand(which: string, options: RemoteOptions): Promise<void> {
  const { ctx } = terminalContext();
  const host = await hostFor(options);
  const session = await MacSession.open({ host: host.name });
  try {
    const pcs = await listRemotePcs(session);
    const wanted = which.trim().toLowerCase();
    const matches = pcs.filter((p) => p.key.toLowerCase().startsWith(wanted) || p.name.toLowerCase() === wanted || shortKey(p.key).toLowerCase() === wanted);
    if (matches.length === 0) throw new UserError(`No PC "${which}" can reach ${label(host)}.`, 'See them with `capmac remote pcs`.');
    if (matches.length > 1) throw new UserError(`"${which}" matches ${matches.length} PCs.`, `Use more of the key: ${matches.map((p) => shortKey(p.key)).join(', ')}.`);
    const left = await revokeRemotePc(session, matches[0]!.key, ctx);
    log.success(`${matches[0]!.name} can no longer reach ${label(host)} over the internet (${left.length} PC${left.length === 1 ? '' : 's'} still can).`);
  } finally {
    session.close();
  }
}
