import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isSoundMode, type SoundMode } from '../shared/electron.js';
import { capmacDir } from './config.js';
import type { RunnableApp } from './project.js';

/** Small per-project memory on the Windows side (last target used, etc), shared by the CLI and CapMac Studio. */
export interface ProjectMemory {
  lastTarget?: string;
  lastDevice?: string;
  /** Where an Electron app's sound plays (see SoundMode). */
  sound?: SoundMode;
  /** The app CapMac works on, when the project has more than one (see apps.ts). */
  app?: RunnableApp;
}

const file = () => path.join(capmacDir(), 'projects.json');

async function readAll(): Promise<Record<string, ProjectMemory>> {
  try {
    return JSON.parse(await fs.readFile(file(), 'utf8'));
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

export async function remember(projectId: string, patch: ProjectMemory): Promise<void> {
  const all = await readAll();
  all[projectId] = { ...all[projectId], ...patch };
  await fs.mkdir(capmacDir(), { recursive: true });
  await fs.writeFile(file(), `${JSON.stringify(all, null, 2)}\n`);
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
