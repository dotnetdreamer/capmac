import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RelayChoice, RouteChoice } from '../shared/remote.js';
import type { StreamPreference } from './screen.js';

export interface HostConfig {
  /** Short alias used on the command line. */
  name: string;
  host: string;
  /** IP address that worked last time (fallback when `.local` lookups fail). */
  lastAddress?: string;
  port: number;
  username: string;
  /** Pinned SSH host key fingerprint ("SHA256:..."). */
  hostKey: string;
  /** Private key file; defaults to capmac's own key. */
  identityFile?: string;
  /** Use the Windows OpenSSH agent / Pageant instead of a key file. */
  agent?: string;
  /** Node.js the agent runs with on the Mac. */
  nodePath?: string;
  home?: string;
  /** Friendly name of the Mac (e.g. "Kabir's MacBook Pro"). */
  macName?: string;
  xcode?: string;
  /** macOS version ("26.6.1"), as last seen. */
  macos?: string;
  pairedAt: string;
  /** Remote access ("Reach this Mac from anywhere"), when it is on for this Mac. */
  remote?: HostRemote;
}

/** Remote access to a Mac, from this PC. */
export interface HostRemote {
  /** The door's public key: the Mac's identity for remote access, pinned like the SSH host key. */
  macKey: string;
  /** The signaling server this PC and the Mac's door use. */
  signalUrl: string;
  enabledAt: string;
  /** Which way to connect (default 'auto': the local network when it answers, else the internet). */
  route?: RouteChoice;
  /** Whether the relay may be used when peer to peer is not possible (default 'allow'). */
  relay?: RelayChoice;
  /** The Mac's door keeps it awake (a copy of the Mac's setting, for display). */
  keepAwake?: boolean;
}

export interface GlobalConfig {
  version: 1;
  defaultHost?: string;
  hosts: Record<string, HostConfig>;
  /** Takeover of `npx cap run ios` and friends, as last chosen; unset means on (see takeover.ts). */
  takeover?: 'on' | 'off';
  /** The signaling server for remote access (your own; see services/signal). */
  signalUrl?: string;
  /** How screens stream (simulators and Electron app windows) in the CLI and CapMac Studio alike; unset means smooth. */
  stream?: StreamPreference;
}

export interface ProjectConfig {
  /** Which paired Mac to use for this project. */
  host?: string;
  ios?: {
    scheme?: string;
    configuration?: string;
    /** Default simulator/device name or UDID. */
    target?: string;
    /** Apple Developer Team ID for device builds. */
    team?: string;
    /** App Store Connect API key for signing over SSH (path relative to the project). */
    apiKey?: { path: string; keyId?: string; issuerId: string };
  };
  web?: {
    /** Command that builds the web assets; false to skip. */
    build?: string | false;
    /** Command that starts the dev server for `capmac dev`. */
    dev?: string;
    /** Use an already running dev server instead of starting one. */
    devUrl?: string;
  };
  sync?: {
    /** Extra gitignore-style patterns to upload even if ignored. */
    include?: string[];
    /** Extra gitignore-style patterns to never upload. */
    exclude?: string[];
  };
  /** The Electron app, which runs on the Mac's desktop. */
  electron?: {
    /** Capacitor: the Electron platform's folder, relative to this one (default "electron"). */
    dir?: string;
    /** Command that builds the app on the Mac before it launches; false to skip the build. */
    build?: string | false;
    /** Command that launches the app on the Mac (default: Electron itself, on the app's folder). */
    start?: string;
    /** Command that runs the app for live reload on the Mac (default: the "dev" script when it runs Electron); false: CapMac reloads the app itself. */
    dev?: string | false;
  };
}

export function capmacDir(): string {
  return process.env.CAPMAC_CONFIG_DIR || path.join(os.homedir(), '.capmac');
}

const configFile = () => path.join(capmacDir(), 'config.json');

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(configFile(), 'utf8')) as Partial<GlobalConfig>;
    return { ...parsed, version: 1, hosts: parsed.hosts ?? {} };
  } catch {
    return { version: 1, hosts: {} };
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await fs.mkdir(capmacDir(), { recursive: true });
  const tmp = `${configFile()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, configFile());
}

/**
 * How screens stream, shared by the CLI and CapMac Studio: `wanted` (kept for
 * next time, in both), else the last choice, else smooth.
 */
export async function streamPreference(wanted?: StreamPreference): Promise<StreamPreference> {
  if (wanted !== 'smooth' && wanted !== 'compatible') return (await loadGlobalConfig()).stream === 'compatible' ? 'compatible' : 'smooth';
  let saved: Partial<GlobalConfig> = {};
  try {
    saved = JSON.parse(await fs.readFile(configFile(), 'utf8')) as Partial<GlobalConfig>;
  } catch (err) {
    // A file that is there but cannot be read now is not overwritten (it holds the paired Macs).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return wanted;
  }
  if (saved.stream !== wanted) await saveGlobalConfig({ ...saved, version: 1, hosts: saved.hosts ?? {}, stream: wanted }).catch(() => undefined);
  return wanted;
}

export async function updateHost(name: string, patch: Partial<HostConfig>): Promise<void> {
  const config = await loadGlobalConfig();
  const existing = config.hosts[name];
  if (!existing) return;
  config.hosts[name] = { ...existing, ...patch };
  await saveGlobalConfig(config);
}

export interface ClientKey {
  privateKey: string;
  publicKey: string;
  path: string;
}

/** capmac's own ed25519 key pair, created on first use. */
export async function ensureClientKey(): Promise<ClientKey> {
  const keyPath = path.join(capmacDir(), 'id_ed25519');
  try {
    const [privateKey, publicKey] = await Promise.all([fs.readFile(keyPath, 'utf8'), fs.readFile(`${keyPath}.pub`, 'utf8')]);
    return { privateKey, publicKey: publicKey.trim(), path: keyPath };
  } catch {
    await fs.mkdir(capmacDir(), { recursive: true });
    const comment = `capmac@${os.hostname()}`;
    // Loaded here, not at the top: capmac Studio's main process reads this config without needing ssh2.
    // ssh2 is CommonJS; `utils` is not visible as a named ESM export.
    const { default: ssh2 } = await import('ssh2');
    const keys = ssh2.utils.generateKeyPairSync('ed25519', { comment });
    await fs.writeFile(keyPath, keys.private, { mode: 0o600 });
    await fs.writeFile(`${keyPath}.pub`, `${keys.public.trim()}\n`, { mode: 0o644 });
    return { privateKey: keys.private, publicKey: keys.public.trim(), path: keyPath };
  }
}

export async function loadProjectConfig(projectDir: string): Promise<ProjectConfig> {
  const file = path.join(projectDir, 'capmac.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as ProjectConfig;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    throw new Error(`Could not read ${file}: ${err?.message ?? err}`);
  }
}

/** Picks the host: explicit flag > project config > default > the only one paired. */
export function resolveHost(config: GlobalConfig, wanted?: string): HostConfig | null {
  const name = wanted ?? config.defaultHost;
  if (name) {
    const exact = config.hosts[name];
    if (exact) return exact;
    const byHost = Object.values(config.hosts).find((h) => h.host === name || h.macName === name);
    if (byHost) return byHost;
    return null;
  }
  const all = Object.values(config.hosts);
  return all.length === 1 ? all[0]! : null;
}
