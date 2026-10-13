import os from 'node:os';
import {
  disableRemote,
  discoverMacs,
  keyComment,
  listMacs,
  loadGlobalConfig,
  MacSession,
  pairMac,
  remoteSettings,
  parseDestination,
  setDefaultMac,
  unpairMac,
  UserError,
  withStep,
  type Destination,
  type EngineContext,
} from '@capmac/core/engine';
import { terminalContext } from '../terminal.js';
import { reportError } from '../report.js';
import { ask, canPrompt, confirm, log, pc, select } from '../ui.js';
import { printProbe } from './doctor.js';
import { turnRemoteOn } from './remote.js';

export interface PairOptions {
  name?: string;
  identity?: string;
  agent?: boolean;
  passwordEnv?: string;
  yes?: boolean;
  default?: boolean;
  /** Remote access: true turns it on, false skips the question. */
  remote?: boolean;
  signalUrl?: string;
}

async function chooseDestination(arg: string | undefined, ctx: EngineContext): Promise<Destination> {
  if (arg) return parseDestination(arg);
  if (!canPrompt()) throw new UserError('Tell CapMac which Mac to pair with: `capmac pair user@my-mac.local`.');
  const found = await withStep(ctx, 'Looking for Macs with Remote Login on your network', 'other', () => discoverMacs(), (list) => (list.length ? `${list.length} found` : 'none found'));
  if (found.length > 0) {
    const choice = await select<Destination | null>('Which Mac?', [
      ...found.map((m) => ({ label: m.name, hint: `${m.host}${m.addresses[0] ? ` · ${m.addresses[0]}` : ''}`, value: { host: m.host, port: m.port, label: m.name } as Destination | null })),
      { label: 'Another Mac (type its address)', value: null },
    ]);
    if (choice) return choice;
  } else {
    log.dim('  Tip: enable System Settings › General › Sharing › Remote Login on the Mac.');
  }
  const typed = await ask('Mac host name or IP address (e.g. my-mac.local or 192.168.1.20):');
  if (!typed) throw new UserError('No Mac given.');
  return parseDestination(typed);
}

export async function pairCommand(destinationArg: string | undefined, options: PairOptions): Promise<void> {
  const { ctx } = terminalContext();
  const dest = await chooseDestination(destinationArg, ctx);
  const username = dest.username ?? (canPrompt() ? await ask('Mac user name (the short name shown in Terminal as `whoami`):', os.userInfo().username) : os.userInfo().username);
  const password = options.passwordEnv ? process.env[options.passwordEnv] : undefined;
  const { host, probe, isDefault } = await pairMac(dest, username, { ...options, password }, ctx);
  log.line();
  log.success(`Paired with ${pc.bold(host.macName ?? host.host)} as "${host.name}"${isDefault ? ' (default)' : ''}`);
  printProbe(probe);
  let remote = options.remote;
  if (remote === undefined && canPrompt()) {
    log.line();
    remote = await confirm('Also reach this Mac from anywhere, over the internet (remote access)?', false);
  }
  if (remote) {
    log.line();
    const session = await MacSession.open({ host: host.name, route: 'lan' });
    try {
      await turnRemoteOn(session, { signalUrl: options.signalUrl }, ctx);
    } catch (err) {
      // Pairing worked; remote access can be turned on later.
      reportError(err);
      log.line(pc.dim(`  Pairing is done. Try remote access again with ${pc.cyan('capmac remote on')}.`));
    } finally {
      session.close();
    }
  } else if (remote === undefined) {
    log.line(pc.dim(`  To reach this Mac from anywhere later: ${pc.cyan('capmac remote on')}.`));
  }
  log.line();
  log.line(`Next: ${pc.cyan('cd')} into your Capacitor app and run ${pc.cyan('capmac run')} (or ${pc.cyan('capmac dev')} for live reload).`);
}

export async function macsCommand(): Promise<void> {
  const { hosts, defaultHost } = await listMacs();
  if (hosts.length === 0) {
    log.info('No Macs paired yet. Run `capmac pair`.');
    return;
  }
  for (const h of hosts) {
    const isDefault = defaultHost === h.name;
    const remote = remoteSettings(h);
    const reach = remote.enabled ? ` · remote access on${remote.route !== 'auto' ? ` (${remote.route === 'lan' ? 'local network only' : 'internet only'})` : ''}` : '';
    log.line(`${isDefault ? pc.green('●') : pc.dim('○')} ${pc.bold(h.name)}  ${h.username}@${h.host}${h.port !== 22 ? `:${h.port}` : ''}  ${pc.dim(`${h.macName ?? ''}${h.xcode ? ` · Xcode ${h.xcode}` : ''}${reach}`)}`);
  }
}

export async function unpairCommand(name: string): Promise<void> {
  // With remote access on, ask the Mac to stop letting this PC in first (when it can be reached).
  const host = (await loadGlobalConfig()).hosts[name];
  if (host?.remote) {
    const { ctx } = terminalContext();
    try {
      const session = await MacSession.open({ host: name, signal: AbortSignal.timeout(15_000) });
      try {
        await disableRemote(session, ctx);
      } finally {
        session.close();
      }
    } catch {
      log.warn(`Could not reach ${host.macName ?? host.host}: it still lets this PC in over the internet until you turn remote access off there.`);
    }
  }
  await unpairMac(name);
  log.success(`Forgot "${name}". (CapMac's key is still in ~/.ssh/authorized_keys on that Mac; remove the line ending in "${keyComment()}" if you like.)`);
}

export async function setDefaultCommand(name: string): Promise<void> {
  await setDefaultMac(name);
  log.success(`"${name}" is now the default Mac.`);
}
