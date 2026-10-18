import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { assertSafeRelPath, packArchive, type ArchiveFile } from '../../shared/archive.js';
import type { ExecParams, ProjectRef, PullParams, RelayParams } from '../../shared/protocol.js';
import { toolEnv } from '../env.js';
import { locateIosProject, locateXcodeProject } from '../ios-project.js';
import type { AgentIO } from '../io.js';
import { AgentError, exists, run } from '../proc.js';
import { loadState, projectPaths, saveState, withProjectLock } from '../state.js';

export async function opExec(params: ExecParams, io: AgentIO): Promise<{ code: number | null }> {
  let cwd = os.homedir();
  if (params.cwd !== 'home') {
    const paths = projectPaths(params.projectId, params.projectRel);
    cwd = params.cwd === 'root' ? paths.src : params.cwd === 'ios' ? path.join(paths.project, 'ios') : paths.project;
  }
  if (!(await exists(cwd))) {
    throw new AgentError('The project has not been synced to the Mac yet.', 'BAD_REQUEST', 'Run `capmac sync` first.');
  }
  const shell = process.env.SHELL || '/bin/zsh';
  const result = await run(shell, ['-c', params.command], {
    cwd,
    env: await toolEnv(),
    signal: io.signal,
    capture: false,
    onLine: (line, stream) => io.send({ t: 'out', stream, text: line }),
  });
  if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
  return { code: result.code };
}

const PULL_SKIP_DIRS = new Set(['node_modules', 'Pods', 'build', 'DerivedData', 'xcuserdata', '.git', '.build']);

async function collect(root: string, rel: string, out: ArchiveFile[]): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  const st = await fs.lstat(abs).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    out.push({ rel, abs, mode: st.mode & 0o777 });
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
    if (entry.isDirectory() && PULL_SKIP_DIRS.has(entry.name)) continue;
    if (entry.name === '.DS_Store' || entry.name.endsWith('.xcuserstate')) continue;
    await collect(root, `${rel}/${entry.name}`, out);
  }
}

/** Streams files from the Mac's copy of the project back to the client. */
export async function opPull(params: PullParams, io: AgentIO): Promise<{ files: number; bytes: number }> {
  const paths = projectPaths(params.projectId, params.projectRel);
  const files: ArchiveFile[] = [];
  for (const raw of params.paths) {
    const rel = raw.replace(/\\/g, '/').replace(/^\.\/+|\/+$/g, '');
    assertSafeRelPath(rel);
    if (!(await exists(path.join(paths.project, ...rel.split('/'))))) {
      throw new AgentError(`Nothing at ${rel} on the Mac.`, 'BAD_REQUEST');
    }
    await collect(paths.project, rel, files);
  }
  let bytes = 0;
  io.send({ t: 'archive-begin', files: files.length });
  for await (const chunk of packArchive(files, { onFile: (_rel, size) => (bytes += size) })) {
    if (io.signal.aborted) throw new AgentError('Cancelled', 'CANCELLED');
    await io.sendBinary(chunk);
  }
  io.send({ t: 'archive-end' });
  return { files: files.length, bytes };
}

export async function opKeychain(params: { password: string; allowCodesign?: boolean }): Promise<{ unlocked: boolean; partitionList: boolean }> {
  const env = await toolEnv();
  const keychain = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
  const unlock = await run('security', ['unlock-keychain', '-p', params.password, keychain], { env, timeoutMs: 30_000 });
  if (unlock.code !== 0) {
    throw new AgentError('Could not unlock the login keychain (wrong password?).', 'KEYCHAIN_LOCKED');
  }
  let partitionList = false;
  if (params.allowCodesign) {
    // Lets codesign use the signing keys without a GUI prompt (what CI setups do).
    const r = await run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', params.password, keychain], { env, timeoutMs: 60_000 });
    partitionList = r.code === 0;
  }
  return { unlocked: true, partitionList };
}

export async function opClean(params: ProjectRef & { what: 'build' | 'all' }, io: AgentIO): Promise<{ removed: string }> {
  const paths = projectPaths(params.projectId, params.projectRel);
  if (params.what === 'all') {
    await withProjectLock(paths, io, async () => {
      await fs.rm(paths.derivedData, { recursive: true, force: true });
      await fs.rm(paths.src, { recursive: true, force: true });
      await fs.rm(paths.stateFile, { force: true });
      await fs.rm(paths.logs, { recursive: true, force: true });
      await fs.rm(path.join(paths.base, 'archive'), { recursive: true, force: true });
    });
    // The lock lives inside the folder, so remove the folder itself once it is released.
    await fs.rm(paths.base, { recursive: true, force: true });
    return { removed: paths.base };
  }
  return withProjectLock(paths, io, async () => {
    await fs.rm(paths.derivedData, { recursive: true, force: true });
    const state = await loadState(paths);
    state.builds = {};
    await saveState(paths, state);
    return { removed: paths.derivedData };
  });
}

/** `xcodeName`: a Flutter or React Native app's Xcode project, in `iosDir`; without it, Capacitor's ios/App. */
export async function opOpenXcode(params: ProjectRef & { iosDir?: string; xcodeName?: string }): Promise<{ opened: string }> {
  const paths = projectPaths(params.projectId, params.projectRel);
  const target = params.xcodeName
    ? await locateXcodeProject(paths.project, params.iosDir ?? 'ios', params.xcodeName)
    : await locateIosProject(paths.project, params.iosDir ?? 'ios').then((ios) => ios.workspace ?? ios.xcodeproj);
  const r = await run('open', ['-a', 'Xcode', target], { env: await toolEnv(), timeoutMs: 30_000 });
  if (r.code !== 0) throw new AgentError(`Could not open Xcode: ${r.stderr.trim()}`, undefined, 'Opening Xcode needs someone logged in to the Mac desktop.');
  return { opened: target };
}

export function lanAddresses(): string[] {
  const result: Array<{ name: string; address: string }> = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) result.push({ name, address: info.address });
    }
  }
  result.sort((a, b) => (a.name === 'en0' ? -1 : b.name === 'en0' ? 1 : a.name.localeCompare(b.name)));
  return result.map((r) => r.address);
}

/**
 * Exposes a loopback-only port (the SSH reverse tunnel) on the Mac's LAN
 * address, so a physical iPhone can reach the Windows dev server.
 */
export async function opRelay(params: RelayParams, io: AgentIO): Promise<{ connections: number }> {
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    connections += 1;
    const upstream = net.connect({ host: '127.0.0.1', port: params.targetPort });
    sockets.add(client).add(upstream);
    const cleanup = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', cleanup).on('close', cleanup);
    upstream.on('error', cleanup).on('close', cleanup);
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: any) => reject(new AgentError(`Could not listen on port ${params.listenPort}: ${err?.code ?? err}`)));
    server.listen(params.listenPort, params.listenHost, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : params.listenPort;
  io.send({ t: 'ready', data: { port, addresses: lanAddresses() } });
  await new Promise<void>((resolve) => {
    if (io.signal.aborted) resolve();
    else io.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { connections };
}
