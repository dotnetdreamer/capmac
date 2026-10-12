/**
 * Pairing: connect with the Mac password once, install capmac's own SSH key,
 * pin the host key, make sure Node.js is there, and remember the Mac.
 */
import os from 'node:os';
import { promises as fs } from 'node:fs';
import type { ProbeResult } from '../shared/protocol.js';
import { AgentClient } from './agent-client.js';
import { ensureClientKey, loadGlobalConfig, saveGlobalConfig, type HostConfig } from './config.js';
import { log, withStep, type EngineContext } from './context.js';
import { UserError } from './errors.js';
import { discoverRuntime, installPortableNode, latestNodeLts, parseNodeVersion, RECOMMENDED_NODE_MAJOR, type RemoteRuntime } from './remote-env.js';
import { resolveMacAddress } from './resolve.js';
import { MacConnection, SshError, shQuote } from './ssh.js';

export interface Destination {
  host: string;
  port: number;
  username?: string;
  /** Friendly name from discovery ("IK's M1"). */
  label?: string;
}

export function parseDestination(value: string): Destination {
  const m = value.trim().match(/^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) throw new UserError(`"${value}" is not a valid Mac address. Use user@host or host.`);
  return { username: m[1], host: m[2]!.replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : 22 };
}

export function aliasFrom(value: string): string {
  return value.toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mac';
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
  if (!result.stdout.includes('ok')) throw new UserError(`Could not add CapMac's key on the Mac: ${result.stderr.trim()}`);
}

/**
 * Makes sure the Mac has a usable Node.js; offers to install a private copy
 * (no sudo) when it is missing or too old. Returns the node path, or null.
 */
export async function ensureNode(conn: MacConnection, runtime: RemoteRuntime, options: { yes?: boolean; force?: boolean }, ctx: EngineContext): Promise<string | null> {
  const major = runtime.node ? parseNodeVersion(runtime.node.version)?.[0] ?? 0 : 0;
  if (!options.force && runtime.node && major >= RECOMMENDED_NODE_MAJOR) return runtime.node.path;
  if (!options.force) {
    log(ctx, 'warn', runtime.node
      ? `Node.js ${runtime.node.version} on the Mac is old (Capacitor needs ${RECOMMENDED_NODE_MAJOR}+).`
      : 'Node.js is not installed on the Mac (Capacitor needs it to sync plugins).');
  }
  const ok = options.yes || (ctx.prompter.interactive && (await ctx.prompter.confirm({ message: 'Install a private copy of the latest Node.js LTS into ~/.capmac/runtime on the Mac? (no sudo, does not touch your system)' })));
  if (!ok) return runtime.node?.path ?? null;
  const release = await withStep(ctx, 'Looking up the latest Node.js LTS', 'other', () => latestNodeLts(runtime.arch), (r) => r.version);
  return withStep(ctx, `Installing Node.js ${release.version} on the Mac`, 'other', () => installPortableNode(conn, runtime.home, release));
}

export interface PairOptions {
  /** Short alias for this Mac. */
  name?: string;
  /** Use this private key instead of capmac's own. */
  identity?: string;
  /** Authenticate with the Windows OpenSSH agent. */
  agent?: boolean;
  /** The Mac password, when the front end already asked for it. */
  password?: string;
  /** Trust the host key and install Node.js without asking. */
  yes?: boolean;
  /** Make this the default Mac. */
  default?: boolean;
}

export interface PairResult {
  host: HostConfig;
  probe: ProbeResult;
  isDefault: boolean;
}

const OPENSSH_AGENT = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK;

async function connectForPairing(dest: Destination, username: string, options: PairOptions, known: HostConfig | undefined, ctx: EngineContext): Promise<{ conn: MacConnection; fingerprint: string; usedPassword: boolean; address: string }> {
  const key = options.identity ? await fs.readFile(options.identity, 'utf8') : (await ensureClientKey()).privateKey;
  let seenFingerprint = '';
  let declined = false;
  let trustedFingerprint: string | null = known?.hostKey ?? null;
  const verifyHostKey = async (fp: string) => {
    seenFingerprint = fp;
    if (trustedFingerprint === fp) return true;
    const changed = Boolean(known && known.hostKey !== fp);
    if (changed) log(ctx, 'warn', `The Mac's host key is different from when you paired it (was ${known!.hostKey}, now ${fp}).`);
    else {
      log(ctx, 'info', `${dest.host}'s SSH host key fingerprint is ${fp}`);
      log(ctx, 'note', '  (verify on the Mac with: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)');
    }
    const ok = options.yes || (ctx.prompter.interactive && (await ctx.prompter.confirm({
      message: changed ? `${dest.label ?? dest.host}'s identity changed. Trust it anyway?` : `Trust ${dest.label ?? dest.host}?`,
      detail: `SSH host key fingerprint: ${fp}\nVerify on the Mac with: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`,
      confirmLabel: 'Trust',
      danger: changed,
    }).catch(() => false)));
    if (ok) trustedFingerprint = fp;
    else declined = true;
    return ok;
  };
  const resolved = await resolveMacAddress(dest.host, known?.lastAddress);
  const address = resolved.address;
  const base = { host: address, label: dest.label ?? dest.host, port: dest.port, username, verifyHostKey };
  try {
    const conn = await MacConnection.connect({ ...base, privateKey: options.agent ? undefined : key, agent: options.agent ? OPENSSH_AGENT : undefined });
    return { conn, fingerprint: seenFingerprint, usedPassword: false, address };
  } catch (err) {
    if (declined) throw new UserError('Pairing cancelled: the Mac was not trusted.');
    if (!(err instanceof SshError) || err.code !== 'AUTH') throw err;
  }
  let pw = options.password;
  if (!pw) {
    if (!ctx.prompter.interactive) throw new UserError(`The Mac needs ${username}'s password once to install CapMac's key.`, 'Run `capmac pair` in an interactive terminal, or pass --password-env <VAR>.');
    pw = await ctx.prompter.password({ purpose: 'pair', message: `Password for ${username} on ${dest.host} (used once, never stored):`, mac: dest.label ?? dest.host, user: username });
  }
  try {
    const conn = await MacConnection.connect({ ...base, password: pw });
    return { conn, fingerprint: seenFingerprint, usedPassword: true, address };
  } catch (err) {
    if (err instanceof SshError && err.code === 'AUTH') {
      throw new UserError(`The Mac did not accept the password for "${username}".`, 'Check the user name (the short name shown by `whoami` on the Mac) and the password, then try again.');
    }
    throw err;
  }
}

/** Pairs with a Mac and saves it to capmac's config. */
export async function pairMac(dest: Destination, username: string, options: PairOptions, ctx: EngineContext): Promise<PairResult> {
  const config = await loadGlobalConfig();
  const known = Object.values(config.hosts).find((h) => h.host === dest.host && h.port === dest.port && h.username === username);
  const { conn, fingerprint, usedPassword, address } = await withStep(ctx, `Connecting to ${username}@${dest.host}`, 'other', () => connectForPairing(dest, username, options, known, ctx));
  try {
    if (usedPassword && !options.identity && !options.agent) {
      const { publicKey, privateKey } = await ensureClientKey();
      await withStep(ctx, 'Installing CapMac\'s SSH key on the Mac (password-free from now on)', 'other', () => installKey(conn, publicKey));
      // Prove the key works before we rely on it.
      const check = await MacConnection.connect({ host: address, label: dest.host, port: dest.port, username, privateKey, verifyHostKey: (fp) => fp === fingerprint });
      check.close();
    }

    const runtime = await withStep(ctx, 'Inspecting the Mac', 'other', () => discoverRuntime(conn), (r) => (r.node ? `Node.js ${r.node.version}` : 'no Node.js yet'));
    if (runtime.os && runtime.os !== 'Darwin') log(ctx, 'warn', `This machine reports "${runtime.os}", not macOS. Builds will not work there.`);
    const nodePath = await ensureNode(conn, runtime, { yes: options.yes }, ctx);
    if (!nodePath) throw new UserError('CapMac needs Node.js on the Mac.', 'Install it (https://nodejs.org or `brew install node`) and pair again.');

    const agent = new AgentClient(conn, nodePath, runtime.home);
    const probe = await withStep(ctx, 'Checking Xcode, simulators and tools', 'other', () => agent.call<ProbeResult>('probe'));

    const latest = await loadGlobalConfig();
    const name = options.name ?? known?.name ?? aliasFrom(dest.label ?? probe.computerName ?? dest.host);
    const host: HostConfig = {
      name,
      host: dest.host,
      port: dest.port,
      username,
      hostKey: fingerprint,
      identityFile: options.identity,
      agent: options.agent ? OPENSSH_AGENT : undefined,
      nodePath,
      home: runtime.home,
      macName: probe.computerName ?? dest.label,
      lastAddress: address !== dest.host ? address : undefined,
      xcode: probe.xcode?.version,
      pairedAt: new Date().toISOString(),
    };
    for (const [key, existing] of Object.entries(latest.hosts)) {
      if (existing.host === host.host && existing.port === host.port && existing.username === host.username && key !== name) delete latest.hosts[key];
    }
    latest.hosts[name] = host;
    if (options.default || !latest.defaultHost || !latest.hosts[latest.defaultHost]) latest.defaultHost = name;
    await saveGlobalConfig(latest);
    return { host, probe, isDefault: latest.defaultHost === name };
  } finally {
    conn.close();
  }
}

export async function listMacs(): Promise<{ hosts: HostConfig[]; defaultHost?: string }> {
  const config = await loadGlobalConfig();
  return { hosts: Object.values(config.hosts), defaultHost: config.defaultHost };
}

/** Forgets a paired Mac (capmac's key stays in the Mac's authorized_keys). */
export async function unpairMac(name: string): Promise<void> {
  const config = await loadGlobalConfig();
  if (!config.hosts[name]) throw new UserError(`No paired Mac called "${name}".`, 'See paired Macs with `capmac macs`.');
  delete config.hosts[name];
  if (config.defaultHost === name) config.defaultHost = Object.keys(config.hosts)[0];
  await saveGlobalConfig(config);
}

export async function setDefaultMac(name: string): Promise<void> {
  const config = await loadGlobalConfig();
  if (!config.hosts[name]) throw new UserError(`No paired Mac called "${name}".`);
  config.defaultHost = name;
  await saveGlobalConfig(config);
}

/** The comment capmac's key carries in the Mac's authorized_keys. */
export function keyComment(): string {
  return `capmac@${os.hostname()}`;
}
