import { promises as fs } from 'node:fs';
import path from 'node:path';
import { capmacDir } from './config.js';

/** Small per-project memory on the Windows side (last target used, etc). */
interface ProjectMemory {
  lastTarget?: string;
  lastDevice?: string;
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

export async function remember(projectId: string, patch: ProjectMemory): Promise<void> {
  const all = await readAll();
  all[projectId] = { ...all[projectId], ...patch };
  await fs.mkdir(capmacDir(), { recursive: true });
  await fs.writeFile(file(), `${JSON.stringify(all, null, 2)}\n`);
}
