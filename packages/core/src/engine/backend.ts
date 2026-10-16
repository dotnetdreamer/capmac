/**
 * Where a project's iOS app builds: on a paired Mac, or on this PC in WSL
 * with no Mac. Picked per project with `capmac backend` or in CapMac Studio,
 * and remembered for both.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';
import { recall, remember } from './memory.js';
import { CAP_CONFIG_FILES, findProjectDir, isBuildBackend, projectIdFor, readCapacitorConfig, type BuildBackend, type ProjectInfo } from './project.js';

/** The backend picked for the project, else the Mac. */
export async function backendOf(project: Pick<ProjectInfo, 'projectId'>): Promise<BuildBackend> {
  const saved = (await recall(project.projectId).catch(() => ({ backend: undefined }))).backend;
  return isBuildBackend(saved) ? saved : 'mac';
}

/**
 * The backend picked for the project in `dir` or a folder above, without
 * loading the project (that runs its Capacitor CLI): the id comes from the
 * config file the way loadProject makes it. Not in a Capacitor app, or its
 * Electron app is the one picked: the Mac, where Electron apps run.
 */
export async function backendIn(dir: string): Promise<BuildBackend> {
  const found = findProjectDir(dir);
  if (found?.kind !== 'capacitor') return 'mac';
  const configFile = CAP_CONFIG_FILES.map((name) => path.join(found.dir, name)).find((file) => existsSync(file));
  if (!configFile) return 'mac';
  const name = readCapacitorConfig(configFile).appName || path.basename(found.dir);
  const memory = await recall(projectIdFor(name, found.dir)).catch(() => ({ app: undefined, backend: undefined }));
  return memory.app !== 'electron' && isBuildBackend(memory.backend) ? memory.backend : 'mac';
}

/** Makes `backend` the one the project builds with from now on, in the CLI and CapMac Studio alike. */
export async function chooseBackend(project: ProjectInfo, backend: string): Promise<BuildBackend> {
  if (!isBuildBackend(backend)) throw new UserError(`Unknown backend "${backend}".`, 'Use `mac` (a paired Mac) or `wsl` (this PC, no Mac).');
  if (backend === 'wsl') {
    if (process.platform !== 'win32') throw new UserError('Building without a Mac needs a Windows PC.', 'Use a paired Mac on this computer.');
    if (project.kind !== 'capacitor') throw new UserError('Only Capacitor iOS apps build without a Mac so far.', 'Use a paired Mac for this app.');
  }
  await remember(project.projectId, { backend });
  return backend;
}
