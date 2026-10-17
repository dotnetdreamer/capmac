import { constants as fsConstants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isSoundMode, type SoundMode } from '../shared/electron.js';
import { capmacDir } from './config.js';
import type { BuildBackend, RunnableApp } from './project.js';

/** Small per-project memory on the Windows side (last target used, etc), shared by the CLI and CapMac Studio. */
export interface ProjectMemory {
  lastTarget?: string;
  lastDevice?: string;
  /** Where an Electron app's sound plays (see SoundMode). */
  sound?: SoundMode;
  /** The app CapMac works on, when the project has more than one (see apps.ts). */
  app?: RunnableApp;
  /** Where the iOS app builds: a paired Mac (the default), or this PC (see backend.ts). */
  backend?: BuildBackend;
}

const file = () => path.join(capmacDir(), 'projects.json');
const pending = new Map<string, Promise<ProjectMemory>>();

/** Everything saved; {} when nothing is. `forWriting`: a file that is there but can't be read throws, so a write never replaces it with less. */
async function readAll(memoryFile = file(), forWriting = false): Promise<Record<string, ProjectMemory>> {
  let text: string;
  try {
    text = await fs.readFile(memoryFile, 'utf8');
  } catch (err) {
    if (!forWriting || (err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const all: unknown = JSON.parse(text);
    return all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, ProjectMemory>) : {};
  } catch {
    return {};
  }
}

export async function recall(projectId: string): Promise<ProjectMemory> {
  return (await readAll())[projectId] ?? {};
}

/** Everything remembered, by project id. */
export function recallAll(): Promise<Record<string, ProjectMemory>> {
  return readAll();
}

/**
 * The lock on the settings file, shared by every CapMac process (the CLI's,
 * Studio's): one the system holds for a process and lets go of when that
 * process exits, however it exits. So a writer that died never holds the
 * others up, and one that is only slow or paused is never written over. A
 * process id could not tell those apart (Windows soon gives a dead process's
 * id to another program), nor could a lock file's age (a paused writer's
 * looks as old), nor whether a socket file still answers (its queue fills).
 */
async function lockMemory(memoryFile: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const release = await tryLock(memoryFile);
    if (release) return release;
    if (Date.now() >= deadline) throw new Error('Timed out waiting to save project settings: another CapMac process is saving them.');
    await delay(20);
  }
}

/** macOS's open(2) flag that locks the file as it opens (not in Node's fs.constants). */
const O_EXLOCK = 0x20;

/** Takes the lock on `memoryFile`, or null while another process has it. */
async function tryLock(memoryFile: string): Promise<(() => Promise<void>) | null> {
  if (process.platform === 'win32' || process.platform === 'linux') {
    // A named pipe (Windows) or a socket with no file behind it (Linux): one process at a time listens on it.
    const name = `capmac-settings-${createHash('sha1').update(path.resolve(memoryFile).toLowerCase()).digest('hex').slice(0, 16)}`;
    const server = await listenOn(process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`);
    return server && (() => new Promise<void>((resolve) => server.close(() => resolve())));
  }
  // macOS: a file next to the settings that the system locks while a process has it open; EAGAIN meanwhile.
  try {
    const file = await fs.open(`${memoryFile}.lock`, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NONBLOCK | O_EXLOCK, 0o600);
    return () => file.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EAGAIN') return null;
    throw err;
  }
}

/** Listens on `name`; null when another process does. */
function listenOn(name: string): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    // Kept on while it listens: an error then must not end the process.
    server.on('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    server.listen(name, () => {
      // Holding the lock is no reason for a process to stay up.
      server.unref();
      resolve(server);
    });
  });
}

/** Removes the half-done writes of writers that died: while the lock is held, no other is at work. */
async function clearLeftovers(memoryFile: string): Promise<void> {
  const dir = path.dirname(memoryFile);
  const prefix = `${path.basename(memoryFile)}.`;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) await fs.unlink(path.join(dir, name)).catch(() => undefined);
  }
}

async function updateMemory(projectId: string, patch: ProjectMemory, onlyMissing: boolean): Promise<ProjectMemory> {
  const memoryFile = file();
  const previous = pending.get(memoryFile) ?? Promise.resolve({});
  const writing = previous.catch(() => ({})).then(async () => {
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    const release = await lockMemory(memoryFile);
    const temp = `${memoryFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await clearLeftovers(memoryFile);
      const all = await readAll(memoryFile, true);
      if (onlyMissing && all[projectId]) return all[projectId]!;
      const memory = { ...all[projectId], ...patch };
      all[projectId] = memory;
      await fs.writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      // Windows may refuse replacement while a reader has the old file open.
      // Retry the atomic operation; never remove the file readers rely on.
      const replaceDeadline = Date.now() + 1000;
      for (;;) {
        try {
          await fs.rename(temp, memoryFile);
          break;
        } catch (err) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '') || Date.now() >= replaceDeadline) throw err;
          await delay(10);
        }
      }
      return memory;
    } finally {
      try {
        await fs.unlink(temp).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; });
      } finally {
        await release();
      }
    }
  });
  pending.set(memoryFile, writing);
  try {
    return await writing;
  } finally {
    if (pending.get(memoryFile) === writing) pending.delete(memoryFile);
  }
}

export async function remember(projectId: string, patch: ProjectMemory): Promise<void> {
  await updateMemory(projectId, patch, false);
}

/** Carries old settings over only while the new id has none; a concurrent user choice wins. */
export function adoptMemory(projectId: string, memory: ProjectMemory): Promise<ProjectMemory> {
  return updateMemory(projectId, memory, true);
}

/** Where the project's Electron app plays its sound: `wanted` (remembered for next time), else what was picked last, else off. */
export async function soundFor(projectId: string, wanted?: SoundMode): Promise<SoundMode> {
  if (wanted && isSoundMode(wanted)) {
    await remember(projectId, { sound: wanted }).catch(() => undefined);
    return wanted;
  }
  const remembered = (await recall(projectId)).sound;
  return isSoundMode(remembered) ? remembered : 'off';
}
