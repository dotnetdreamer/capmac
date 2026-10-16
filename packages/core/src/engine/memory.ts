import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
 * No write holds the lock this long. An older lock was left by a writer that
 * died, and its process id may belong to another program by now (Windows
 * reuses them soon), so the id alone can't tell.
 */
const STALE_LOCK_MS = 5_000;

/** One writer across CLI and Studio processes; a dead writer's lock may be reclaimed. */
async function lockMemory(memoryFile: string): Promise<() => Promise<void>> {
  const lockFile = `${memoryFile}.lock`;
  const recoveryFile = `${memoryFile}.recovery.lock`;
  const token = `${process.pid} ${randomUUID()}`;
  const ownerFile = `${lockFile}.${randomUUID()}.owner`;
  const deadline = Date.now() + 10_000;
  // Publish a complete owner atomically: a killed writer cannot leave an empty lock.
  await fs.writeFile(ownerFile, token, { flag: 'wx', mode: 0o600 });
  let acquired = false;
  try {
    for (;;) {
      // Dated when it is taken, not when this writer began to wait: its age tells the others whether it was left behind.
      const now = new Date();
      await fs.utimes(ownerFile, now, now);
      try {
        await fs.link(ownerFile, lockFile);
        acquired = true;
        return async () => {
          try {
            if (await fs.readFile(lockFile, 'utf8') === token) await fs.unlink(lockFile);
          } finally {
            await fs.unlink(ownerFile);
          }
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const owner = await fs.readFile(lockFile, 'utf8').catch(() => '');
      let recovering = false;
      let waitingOn = lockFile;
      if (await leftBehind(lockFile, owner)) {
        try {
          await fs.link(ownerFile, recoveryFile);
          recovering = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          waitingOn = recoveryFile;
          // A reclaimer that died while reclaiming would hold off every writer after it.
          const reclaimer = await fs.readFile(recoveryFile, 'utf8').catch(() => '');
          if (await leftBehind(recoveryFile, reclaimer)) await fs.unlink(recoveryFile).catch(() => undefined);
        }
      }
      if (recovering) {
        try {
          // Only one reclaimer can recheck and remove an old lock. A second
          // reclaimer must see the live successor before it may remove anything.
          const current = await fs.readFile(lockFile, 'utf8').catch(() => '');
          if (current === owner && (await leftBehind(lockFile, current))) {
            await fs.unlink(lockFile);
            continue;
          }
        } finally {
          await fs.unlink(recoveryFile);
        }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting to save project settings (${waitingOn}).`);
      await delay(20);
    }
  } finally {
    if (!acquired) await fs.unlink(ownerFile);
  }
}

/** Whether a lock file holding `owner` was left by a writer that died: its process is gone, or the lock is older than any write takes. */
async function leftBehind(file: string, owner: string): Promise<boolean> {
  if (ownerIsDead(owner)) return true;
  const stat = await fs.stat(file).catch(() => null);
  return stat !== null && Date.now() - stat.mtimeMs > STALE_LOCK_MS;
}

function ownerIsDead(owner: string): boolean {
  const pid = Number(owner.split(' ')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
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
