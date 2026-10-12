import os from 'node:os';
import { promises as fs } from 'node:fs';
import type { ProbeResult } from '../../shared/protocol.js';
import { AgentClient } from '../agent-client.js';
import { ensureClientKey, loadGlobalConfig, saveGlobalConfig, type HostConfig } from '../config.js';
import { discoverMacs } from '../discovery.js';
import { UserError } from '../errors.js';
import { discoverRuntime, installPortableNode, latestNodeLts, RECOMMENDED_NODE_MAJOR, parseNodeVersion, type RemoteRuntime } from '../remote-env.js';
import { resolveMacAddress } from '../resolve.js';
import { MacConnection, SshError, shQuote } from '../ssh.js';
import { ask, canPrompt, confirm, log, password as askPassword, pc, select, withStep } from '../ui.js';
import { printProbe } from './doctor.js';

export interface PairOptions {
  name?: string;
  identity?: string;
  agent?: boolean;
  passwordEnv?: string;
  yes?: boolean;
  default?: boolean;
}

interface Destination {
  host: string;
  port: number;
  username?: string;
  label?: string;
}

export function parseDestination(value: string): Destination {
  const m = value.match(/^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) throw new UserError(`"${value}" is not a valid Mac address. Use user@host or host.`);
  return { username: m[1], host: m[2]!.replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : 22 };
}

function aliasFrom(value: string): string {
  return value.toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mac';
}

async function chooseDestination(arg?: string): Promise<Destination> {
  if (arg) return parseDestination(arg);
  if (!canPrompt()) throw new UserError('Tell capmac which Mac to pair with: `capmac pair user@my-mac.local`.');
  const found = await withStep('Looking for Macs with Remote Login on your network', () => discoverMacs(), (list) => (list.length ? `${list.length} found` : 'none found'));
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

async function installKey(conn: MacConnection, publicKey: string): Promise<void> {
  const key = publicKey.trim();
  const script = `umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
grep -qxF ${shQuote(key)} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${shQuote(key)} >> "$HOME/.ssh/authorized_keys"
echo ok
`;
  const result = await conn.runScript(script, { timeoutMs: 30_000 });
  if (!result.stdout.includes('ok')) throw new UserError(`Could not add capmac's key on the Mac: ${result.stderr.trim()}`);
}

export async function ensureNode(conn: MacConnection, runtime: RemoteRuntime, options: { yes?: boolean }): Promise<string | null> {
  const major = runtime.node ? parseNodeVersion(runtime.node.version)?.[0] ?? 0 : 0;
  if (runtime.node && major >= RECOMMENDED_NODE_MAJOR) return runtime.node.path;
  const reason = runtime.node
    ? `Node.js ${runtime.node.version} on the Mac is old (Capacitor needs ${RECOMMENDED_NODE_MAJOR}+).`
    : 'Node.js is not installed on the Mac (Capacitor needs it to sync plugins).';
  log.warn(reason);
  const ok = options.yes || (canPrompt() && (await confirm('Install a private copy of the latest Node.js LTS into ~/.capmac/runtime on the Mac? (no sudo, does not touch your system)')));
  if (!ok) return runtime.node?.path ?? null;
  const release = await withStep('Looking up the latest Node.js LTS', () => latestNodeLts(runtime.arch), (r) => r.version);
  return withStep(`Installing Node.js ${release.version} on the Mac`, () => installPortableNode(conn, runtime.home, release));
}

async function connectForPairing(dest: Destination, username: string, options: PairOptions, known: HostConfig | undefined): Promise<{ conn: MacConnection; fingerprint: string; usedPassword: boolean; address: string }> {
  const key = options.identity ? await fs.readFile(options.identity, 'utf8') : (await ensureClientKey()).privateKey;
  const agentPath = options.agent ? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK) : undefined;
  let seenFingerprint = '';
  let declined = false;
  let trustedFingerprint: string | null = known?.hostKey ?? null;
  const verifyHostKey = async (fp: string) => {
    seenFingerprint = fp;
    if (trustedFingerprint === fp) return true;
    if (known && known.hostKey !== fp) {
      log.warn(`The Mac's host key is different from when you paired it (was ${known.hostKey}, now ${fp}).`);
    } else {
      log.info(`${dest.host}'s SSH host key fingerprint is ${pc.bold(fp)}`);
      log.dim('  (verify on the Mac with: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)');
    }
    const ok = options.yes || (canPrompt() && (await confirm('Trust this Mac?')));
    if (ok) trustedFingerprint = fp;
    else declined = true;
    return ok;
  };
  const resolved = await resolveMacAddress(dest.host, known?.lastAddress);
  const address = resolved.address;
  const base = { host: address, label: dest.host, port: dest.port, username, verifyHostKey };
  try {
    const conn = await MacConnection.connect({ ...base, privateKey: options.agent ? undefined : key, agent: agentPath });
    return { conn, fingerprint: seenFingerprint, usedPassword: false, address };
  } catch (err) {
    if (declined) throw new UserError('Pairing cancelled: the Mac was not trusted.');
    if (!(err instanceof SshError) || err.code !== 'AUTH') throw err;
  }
  let pw = options.passwordEnv ? process.env[options.passwordEnv] : undefined;
  if (!pw) {
    if (!canPrompt()) throw new UserError(`The Mac needs ${username}'s password once to install capmac's key.`, 'Run `capmac pair` in an interactive terminal, or pass --password-env <VAR>.');
    pw = await askPassword(`Password for ${username} on ${dest.host} (used once, never stored):`);
  }
  const conn = await MacConnection.connect({ ...base, password: pw });
  return { conn, fingerprint: seenFingerprint, usedPassword: true, address };
}

export async function pairCommand(destinationArg: string | undefined, options: PairOptions): Promise<void> {
  const config = await loadGlobalConfig();
  const dest = await chooseDestination(destinationArg);
  const username = dest.username ?? (canPrompt() ? await ask('Mac user name (the short name shown in Terminal as `whoami`):', os.userInfo().username) : os.userInfo().username);
  const known = Object.values(config.hosts).find((h) => h.host === dest.host && h.port === dest.port && h.username === username);

  const { conn, fingerprint, usedPassword, address } = await withStep(`Connecting to ${username}@${dest.host}`, () => connectForPairing(dest, username, options, known));
  try {
    if (usedPassword && !options.identity && !options.agent) {
      const { publicKey } = await ensureClientKey();
      await withStep('Installing capmac\'s SSH key on the Mac (password-free from now on)', () => installKey(conn, publicKey));
      // Prove the key works before we rely on it.
      const check = await MacConnection.connect({ host: address, label: dest.host, port: dest.port, username, privateKey: (await ensureClientKey()).privateKey, verifyHostKey: (fp) => fp === fingerprint });
      check.close();
    }

    const runtime = await withStep('Inspecting the Mac', () => discoverRuntime(conn), (r) => (r.node ? `Node.js ${r.node.version}` : 'no Node.js yet'));
    if (runtime.os && runtime.os !== 'Darwin') log.warn(`This machine reports "${runtime.os}", not macOS. Builds will not work there.`);
    const nodePath = await ensureNode(conn, runtime, { yes: options.yes });
    if (!nodePath) throw new UserError('capmac needs Node.js on the Mac.', 'Install it (https://nodejs.org or `brew install node`) and run `capmac pair` again.');

    const agent = new AgentClient(conn, nodePath, runtime.home);
    const probe = await withStep('Checking Xcode, simulators and tools', () => agent.call<ProbeResult>('probe'));

    const name = options.name ?? known?.name ?? aliasFrom(dest.label ?? probe.computerName ?? dest.host);
    const host: HostConfig = {
      name,
      host: dest.host,
      port: dest.port,
      username,
      hostKey: fingerprint,
      identityFile: options.identity,
      agent: options.agent ? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK) : undefined,
      nodePath,
      home: runtime.home,
      macName: probe.computerName ?? dest.label,
      lastAddress: address !== dest.host ? address : undefined,
      xcode: probe.xcode?.version,
      pairedAt: new Date().toISOString(),
    };
    for (const [key, existing] of Object.entries(config.hosts)) {
      if (existing.host === host.host && existing.port === host.port && existing.username === host.username && key !== name) delete config.hosts[key];
    }
    config.hosts[name] = host;
    if (options.default || !config.defaultHost || !config.hosts[config.defaultHost]) config.defaultHost = name;
    await saveGlobalConfig(config);

    log.line();
    log.success(`Paired with ${pc.bold(host.macName ?? host.host)} as "${name}"${config.defaultHost === name ? ' (default)' : ''}`);
    printProbe(probe);
    log.line();
    log.line(`Next: ${pc.cyan('cd')} into your Capacitor app and run ${pc.cyan('capmac run')} (or ${pc.cyan('capmac dev')} for live reload).`);
  } finally {
    conn.close();
  }
}

export async function macsCommand(): Promise<void> {
  const config = await loadGlobalConfig();
  const hosts = Object.values(config.hosts);
  if (hosts.length === 0) {
    log.info('No Macs paired yet. Run `capmac pair`.');
    return;
  }
  for (const h of hosts) {
    const isDefault = config.defaultHost === h.name;
    log.line(`${isDefault ? pc.green('●') : pc.dim('○')} ${pc.bold(h.name)}  ${h.username}@${h.host}${h.port !== 22 ? `:${h.port}` : ''}  ${pc.dim(`${h.macName ?? ''}${h.xcode ? ` · Xcode ${h.xcode}` : ''}`)}`);
  }
}

export async function unpairCommand(name: string): Promise<void> {
  const config = await loadGlobalConfig();
  if (!config.hosts[name]) throw new UserError(`No paired Mac called "${name}".`, 'See paired Macs with `capmac macs`.');
  delete config.hosts[name];
  if (config.defaultHost === name) config.defaultHost = Object.keys(config.hosts)[0];
  await saveGlobalConfig(config);
  log.success(`Forgot "${name}". (capmac's key is still in ~/.ssh/authorized_keys on that Mac; remove the line ending in "capmac@${os.hostname()}" if you like.)`);
}

export async function setDefaultCommand(name: string): Promise<void> {
  const config = await loadGlobalConfig();
  if (!config.hosts[name]) throw new UserError(`No paired Mac called "${name}".`);
  config.defaultHost = name;
  await saveGlobalConfig(config);
  log.success(`"${name}" is now the default Mac.`);
}
