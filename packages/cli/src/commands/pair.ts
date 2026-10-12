import os from 'node:os';
import {
  discoverMacs,
  keyComment,
  listMacs,
  pairMac,
  parseDestination,
  setDefaultMac,
  unpairMac,
  UserError,
  withStep,
  type Destination,
  type EngineContext,
} from '@capmac/core/engine';
import { terminalContext } from '../terminal.js';
import { ask, canPrompt, log, pc, select } from '../ui.js';
import { printProbe } from './doctor.js';

export interface PairOptions {
  name?: string;
  identity?: string;
  agent?: boolean;
  passwordEnv?: string;
  yes?: boolean;
  default?: boolean;
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
    log.line(`${isDefault ? pc.green('●') : pc.dim('○')} ${pc.bold(h.name)}  ${h.username}@${h.host}${h.port !== 22 ? `:${h.port}` : ''}  ${pc.dim(`${h.macName ?? ''}${h.xcode ? ` · Xcode ${h.xcode}` : ''}`)}`);
  }
}

export async function unpairCommand(name: string): Promise<void> {
  await unpairMac(name);
  log.success(`Forgot "${name}". (CapMac's key is still in ~/.ssh/authorized_keys on that Mac; remove the line ending in "${keyComment()}" if you like.)`);
}

export async function setDefaultCommand(name: string): Promise<void> {
  await setDefaultMac(name);
  log.success(`"${name}" is now the default Mac.`);
}
