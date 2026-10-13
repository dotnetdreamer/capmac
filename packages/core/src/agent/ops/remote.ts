/**
 * Remote access on the Mac: installs, updates and removes the door (a
 * LaunchAgent that lets paired PCs reach the Mac's sshd over the internet),
 * and manages which PCs it lets in. Everything lives in ~/.capmac/remote,
 * plus ~/Library/LaunchAgents/dev.capmac.remote.plist.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOOR_LABEL, type DoorConfig, type DoorStatusFile, type RemoteDoorStatus, type RemoteInstallParams, type RemotePc, type RemoteSetParams } from '../../shared/remote-door.js';
import { DOOR_MIN_NODE_MAJOR, isPublicKey, NODE_DATACHANNEL_VERSION, signalUrlProblem } from '../../shared/remote.js';
import { generateIdentity, loadIdentity } from '../../shared/remote-keys.js';
import { DOOR_SOURCE } from '../door-source.js';
import { capmacHome, toolEnv } from '../env.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, run, type RunResult } from '../proc.js';

export interface RemotePaths {
  dir: string;
  door: string;
  config: string;
  key: string;
  allowed: string;
  status: string;
  log: string;
  launchdLog: string;
  runtime: string;
  plist: string;
}

export function remotePaths(): RemotePaths {
  const dir = path.join(capmacHome(), 'remote');
  const agents = process.env.CAPMAC_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
  return {
    dir,
    door: path.join(dir, 'door.mjs'),
    config: path.join(dir, 'config.json'),
    key: path.join(dir, 'door_ed25519'),
    allowed: path.join(dir, 'allowed.json'),
    status: path.join(dir, 'status.json'),
    log: path.join(dir, 'door.log'),
    launchdLog: path.join(dir, 'launchd.log'),
    runtime: path.join(dir, 'runtime'),
    plist: path.join(agents, `${DOOR_LABEL}.plist`),
  };
}

export const doorHash = (code: string) => createHash('sha256').update(code).digest('hex').slice(0, 16);

/** What the ops need from macOS; tests replace it. */
export interface RemoteSystem {
  launchctl(args: string[]): Promise<RunResult>;
  /** Installs node-datachannel into `runtimeDir` with the Mac's npm. */
  npmInstall(runtimeDir: string, nodePath: string, io: AgentIO): Promise<void>;
  /** Checks that node-datachannel loads with `nodePath`; returns libdatachannel's version. */
  checkRuntime(runtimeDir: string, nodePath: string): Promise<string>;
  uid(): number;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchAgentPlist(nodePath: string, paths: RemotePaths): string {
  const env = process.env.CAPMAC_HOME ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>CAPMAC_HOME</key>\n    <string>${xml(process.env.CAPMAC_HOME)}</string>\n  </dict>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- CapMac remote access: lets the PCs you paired reach this Mac over the internet. Turn it off in CapMac. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DOOR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(paths.door)}</string>
    <string>${xml(paths.config)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.launchdLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.launchdLog)}</string>${env}
</dict>
</plist>
`;
}

function npmCommand(nodePath: string): { command: string; args: string[] } {
  // npm sits next to node (official installer, Homebrew, nvm, CapMac's own copy).
  const bin = path.dirname(nodePath);
  const cli = path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { command: nodePath, args: [cli] };
}

export const macSystem: RemoteSystem = {
  launchctl: (args) => run('/bin/launchctl', args, { timeoutMs: 30_000 }),
  async npmInstall(runtimeDir, nodePath, io) {
    const { command, args } = npmCommand(nodePath);
    const env = { ...(await toolEnv()) };
    env.PATH = `${path.dirname(nodePath)}:${env.PATH ?? '/usr/bin:/bin'}`;
    const r = await run(command, [...args, 'install', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], {
      cwd: runtimeDir,
      env,
      timeoutMs: 5 * 60_000,
      signal: io.signal,
      onLine: (line) => {
        if (line.trim()) io.send({ t: 'progress', text: line.trim().slice(0, 120) });
      },
    });
    if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
    if (r.code !== 0) {
      throw new AgentError(
        `Could not install CapMac's WebRTC module (node-datachannel ${NODE_DATACHANNEL_VERSION}) on the Mac.`,
        'REMOTE_RUNTIME',
        'npm on the Mac needs to reach registry.npmjs.org. Check the Mac’s internet connection (or its npm proxy settings), then try again.',
        r.tail,
      );
    }
  },
  async checkRuntime(runtimeDir, nodePath) {
    const module = path.join(runtimeDir, 'node_modules', 'node-datachannel');
    const r = await run(nodePath, ['-e', `process.stdout.write(require(${JSON.stringify(module)}).getLibraryVersion())`], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      throw new AgentError("CapMac's WebRTC module does not load on this Mac.", 'REMOTE_RUNTIME', 'Turn remote access off and on again to reinstall it.', r.tail);
    }
    return r.stdout.trim();
  },
  uid: () => process.getuid?.() ?? 501,
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writePrivate(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function installedRuntime(paths: RemotePaths): Promise<string | null> {
  const pkg = await readJson<{ version?: string }>(path.join(paths.runtime, 'node_modules', 'node-datachannel', 'package.json'));
  return pkg?.version ?? null;
}

async function ensureRuntime(paths: RemotePaths, nodePath: string, io: AgentIO, system: RemoteSystem): Promise<string> {
  if ((await installedRuntime(paths)) === NODE_DATACHANNEL_VERSION) {
    try {
      return await system.checkRuntime(paths.runtime, nodePath);
    } catch {
      // reinstall below
    }
  }
  return step(io, 'remote-runtime', `Installing WebRTC for remote access (node-datachannel ${NODE_DATACHANNEL_VERSION})`, async () => {
    await fs.rm(path.join(paths.runtime, 'node_modules'), { recursive: true, force: true });
    await fs.mkdir(paths.runtime, { recursive: true });
    await fs.writeFile(path.join(paths.runtime, 'package.json'), `${JSON.stringify({ private: true, description: 'CapMac remote access: the door\'s WebRTC module.', dependencies: { 'node-datachannel': NODE_DATACHANNEL_VERSION } }, null, 2)}\n`);
    await system.npmInstall(paths.runtime, nodePath, io);
    return system.checkRuntime(paths.runtime, nodePath);
  });
}

async function ensureKey(paths: RemotePaths): Promise<string> {
  try {
    return loadIdentity(await fs.readFile(paths.key, 'utf8')).publicKey;
  } catch {
    const { pem, identity } = generateIdentity();
    await writePrivate(paths.key, pem);
    return identity.publicKey;
  }
}

async function readAllowed(paths: RemotePaths): Promise<RemotePc[]> {
  const list = await readJson<RemotePc[]>(paths.allowed);
  return Array.isArray(list) ? list.filter((pc) => isPublicKey(pc?.key)) : [];
}

const domain = (system: RemoteSystem) => `gui/${system.uid()}`;

async function launchState(system: RemoteSystem): Promise<{ loaded: boolean; pid: number | null }> {
  if (process.platform !== 'darwin' && system === macSystem) return { loaded: false, pid: null };
  const r = await system.launchctl(['print', `${domain(system)}/${DOOR_LABEL}`]).catch(() => null);
  if (!r || r.code !== 0) return { loaded: false, pid: null };
  const pid = r.stdout.match(/^\s*pid = (\d+)/m);
  return { loaded: true, pid: pid ? Number(pid[1]) : null };
}

/**
 * This request came in through the door (sshd sees the door's connection from
 * the loopback address): restarting or stopping the door would cut it.
 */
export function throughDoor(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(127.0.0.1|::1|::ffff:127.0.0.1) /.test(env.SSH_CONNECTION ?? '');
}

/** Restarts the door a moment from now, from a process of its own (so this answer gets out first). */
function restartDoorSoon(system: RemoteSystem): void {
  const child = spawn('/bin/sh', ['-c', `sleep 1; /bin/launchctl kickstart -k ${domain(system)}/${DOOR_LABEL} 2>/dev/null; true`], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Loads the LaunchAgent, or restarts the door when it already runs. Returns false when the restart was left for later. */
async function startDoor(paths: RemotePaths, system: RemoteSystem): Promise<boolean> {
  if (system === macSystem && throughDoor() && (await launchState(system)).loaded) {
    restartDoorSoon(system);
    return false;
  }
  const target = `${domain(system)}/${DOOR_LABEL}`;
  const state = await launchState(system);
  if (state.loaded) {
    const r = await system.launchctl(['kickstart', '-k', target]);
    if (r.code === 0) return true;
  }
  await system.launchctl(['enable', target]).catch(() => undefined);
  let r = await system.launchctl(['bootstrap', domain(system), paths.plist]);
  if (r.code !== 0 && /already|in progress|5:/i.test(`${r.stderr}${r.stdout}`)) {
    await system.launchctl(['bootout', target]).catch(() => undefined);
    r = await system.launchctl(['bootstrap', domain(system), paths.plist]);
  }
  if (r.code !== 0) {
    throw new AgentError(
      'Could not start CapMac’s remote-access service on the Mac.',
      'REMOTE_LAUNCH',
      'It runs in your login session: log in to the Mac’s desktop (simulators need that too), then try again.',
      `${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-6),
    );
  }
  return true;
}

async function stopDoor(system: RemoteSystem): Promise<void> {
  if ((await launchState(system)).loaded) await system.launchctl(['bootout', `${domain(system)}/${DOOR_LABEL}`]).catch(() => undefined);
}

/** Waits for the (re)started door to report in: online, or why not. */
async function waitForDoor(paths: RemotePaths, since: number, timeoutMs: number, signal: AbortSignal): Promise<DoorStatusFile | null> {
  const end = Date.now() + timeoutMs;
  let last: DoorStatusFile | null = null;
  while (Date.now() < end && !signal.aborted) {
    const status = await readJson<DoorStatusFile>(paths.status);
    if (status && Date.parse(status.since) >= since - 1000) {
      last = status;
      if (status.state === 'online' || status.state === 'error') return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

export async function remoteStatus(system: RemoteSystem = macSystem): Promise<RemoteDoorStatus> {
  const paths = remotePaths();
  const config = await readJson<DoorConfig>(paths.config);
  let macKey: string | null = null;
  try {
    macKey = loadIdentity(await fs.readFile(paths.key, 'utf8')).publicKey;
  } catch {
    // not installed
  }
  let installedHash: string | null = null;
  try {
    installedHash = doorHash(await fs.readFile(paths.door, 'utf8'));
  } catch {
    // not installed
  }
  const launch = await launchState(system);
  const status = launch.loaded ? await readJson<DoorStatusFile>(paths.status) : null;
  return {
    installed: Boolean(config && macKey && installedHash),
    macKey,
    doorHash: installedHash,
    current: Boolean(installedHash && DOOR_SOURCE && installedHash === doorHash(DOOR_SOURCE)),
    loaded: launch.loaded,
    pid: launch.pid,
    status,
    signalUrl: config?.signalUrl ?? null,
    keepAwake: config?.keepAwake ?? false,
    sshPort: config?.sshPort ?? null,
    pcs: await readAllowed(paths),
    runtime: await installedRuntime(paths),
    node: process.version,
  };
}

export async function opRemoteStatus(): Promise<RemoteDoorStatus> {
  return remoteStatus();
}

/** Installs or updates the door, lets `pc` in, and (re)starts it. */
export async function opRemoteInstall(params: RemoteInstallParams & { nodePath?: string }, io: AgentIO, system: RemoteSystem = macSystem): Promise<RemoteDoorStatus> {
  const problem = signalUrlProblem(params.signalUrl ?? '');
  if (problem) throw new AgentError(problem, 'BAD_REQUEST');
  if (!isPublicKey(params.pc?.key)) throw new AgentError('The PC’s remote-access key is invalid.', 'BAD_REQUEST');
  const sshPort = Number(params.sshPort);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65_535) throw new AgentError('The SSH port is invalid.', 'BAD_REQUEST');
  if (!DOOR_SOURCE) throw new AgentError('This CapMac agent was built without remote access.', 'BAD_REQUEST', 'Update CapMac.');
  const nodePath = params.nodePath || process.execPath;
  const major = Number(process.versions.node.split('.')[0]);
  if (major < DOOR_MIN_NODE_MAJOR) {
    throw new AgentError(
      `Remote access needs Node.js ${DOOR_MIN_NODE_MAJOR} or later on the Mac; CapMac uses ${process.version} there.`,
      'REMOTE_NODE',
      'Run `capmac doctor --fix` (or Check health › Install Node.js) to give CapMac a current Node.js, then try again.',
    );
  }
  const paths = remotePaths();
  await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await ensureRuntime(paths, nodePath, io, system);

  return step(io, 'remote-door', 'Starting CapMac’s remote-access service on the Mac', async () => {
    const current = await fs.readFile(paths.door, 'utf8').catch(() => null);
    if (current !== DOOR_SOURCE) await writePrivate(paths.door, DOOR_SOURCE!);
    await ensureKey(paths);
    const pcs = await readAllowed(paths);
    const name = String(params.pc.name ?? 'PC').slice(0, 64);
    const existing = pcs.find((pc) => pc.key === params.pc.key);
    if (existing) existing.name = name;
    else pcs.push({ key: params.pc.key, name, addedAt: new Date().toISOString() });
    await writePrivate(paths.allowed, `${JSON.stringify(pcs, null, 2)}\n`);
    const previous = await readJson<DoorConfig>(paths.config);
    const config: DoorConfig = {
      version: 1,
      signalUrl: params.signalUrl.trim(),
      sshPort,
      keepAwake: params.keepAwake ?? previous?.keepAwake ?? false,
      keyFile: paths.key,
      allowedFile: paths.allowed,
      statusFile: paths.status,
      logFile: paths.log,
      runtimeDir: paths.runtime,
    };
    await writePrivate(paths.config, `${JSON.stringify(config, null, 2)}\n`);
    await fs.mkdir(path.dirname(paths.plist), { recursive: true });
    await fs.writeFile(paths.plist, launchAgentPlist(nodePath, paths), { mode: 0o644 });
    const started = Date.now();
    const now = await startDoor(paths, system);
    const status = now ? await waitForDoor(paths, started, 12_000, io.signal) : null;
    if (status?.state === 'error') throw new AgentError(`CapMac’s remote-access service on the Mac stopped: ${status.error}`, 'REMOTE_DOOR');
    return remoteStatus(system);
  });
}

/** Changes the door's settings and restarts it. */
export async function opRemoteSet(params: RemoteSetParams, io: AgentIO, system: RemoteSystem = macSystem): Promise<RemoteDoorStatus> {
  const paths = remotePaths();
  const config = await readJson<DoorConfig>(paths.config);
  if (!config) throw new AgentError('Remote access is not set up on this Mac.', 'REMOTE_NOT_INSTALLED', 'Turn it on first.');
  if (params.signalUrl !== undefined) {
    const problem = signalUrlProblem(params.signalUrl);
    if (problem) throw new AgentError(problem, 'BAD_REQUEST');
    config.signalUrl = params.signalUrl.trim();
  }
  if (params.keepAwake !== undefined) config.keepAwake = Boolean(params.keepAwake);
  await writePrivate(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  const started = Date.now();
  if (await startDoor(paths, system)) await waitForDoor(paths, started, 8000, io.signal);
  return remoteStatus(system);
}

/** Stops letting a PC in. With `uninstallIfLast`, removes the door once no PC is left. */
export async function opRemoteRevoke(params: { key: string; uninstallIfLast?: boolean }, io: AgentIO, system: RemoteSystem = macSystem): Promise<RemoteDoorStatus> {
  const paths = remotePaths();
  const pcs = (await readAllowed(paths)).filter((pc) => pc.key !== params.key);
  if (pcs.length === 0 && params.uninstallIfLast) return opRemoteUninstall({}, io, system);
  await writePrivate(paths.allowed, `${JSON.stringify(pcs, null, 2)}\n`).catch(() => undefined);
  return remoteStatus(system);
}

/**
 * Removes the door, its LaunchAgent and its files. The PC asking may be
 * connected through the door itself: stopping it would cut that connection
 * before the answer gets back, so the files go first and the door is stopped
 * a moment later by a process of its own.
 */
export async function opRemoteUninstall(_params: object, _io: AgentIO, system: RemoteSystem = macSystem): Promise<RemoteDoorStatus> {
  const paths = remotePaths();
  const loaded = (await launchState(system)).loaded;
  await fs.rm(paths.plist, { force: true });
  await fs.rm(paths.dir, { recursive: true, force: true });
  if (loaded) {
    if (system === macSystem && throughDoor()) {
      const child = spawn('/bin/sh', ['-c', `sleep 1; /bin/launchctl bootout ${domain(system)}/${DOOR_LABEL} 2>/dev/null; true`], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      await stopDoor(system);
    }
  }
  return { ...(await remoteStatus(system)), loaded: false, pid: null, status: null };
}
