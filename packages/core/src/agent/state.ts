import { promises as fs } from 'node:fs';
import path from 'node:path';
import { capmacHome } from './env.js';
import type { AgentIO } from './io.js';
import { AgentError, sleep } from './proc.js';

export interface FileRecord {
  /** Content hash reported by the client. */
  h: string;
  /** Mode bits. */
  m: number;
  /** Size on the Mac (can differ from Windows when line endings were converted). */
  s: number;
}

export interface BuildRecord {
  appPath: string;
  bundleId: string;
  executable: string;
  displayName: string;
  nativeGen: number;
  webGen: number;
  at: number;
}

export interface ProjectState {
  version: 1;
  manifest: Record<string, FileRecord>;
  /** Changed paths not yet handled by `prepare`. */
  pendingChanges: string[];
  /** Too many changes to track individually: treat as a full refresh. */
  pendingFull: boolean;
  depsHash?: string;
  needsCapSync: boolean;
  liveUrl: string | null;
  /** Bumped whenever native inputs change; builds record the value they saw. */
  nativeGen: number;
  /** Bumped whenever the copied web assets / capacitor.config.json change. */
  webGen: number;
  builds: Record<string, BuildRecord>;
  lastTarget?: string;
  /** What capmac added to the Mac's copy of Info.plist for live reload (ATS exception). */
  atsPatch?: 'dict' | 'key' | null;
  /** Electron: changed paths not yet handled by `electron-prepare` (iOS's `prepare` keeps its own list). */
  electronPending: string[];
  /** Electron: too many changes to track: treat as a full refresh. */
  electronPendingFull: boolean;
  /** Electron: the dependencies' hash per folder (POSIX from the synced root, '' for the root) at the last install. */
  electronDeps: Record<string, string>;
  /** Electron: the app was built after the last change to its sources. */
  electronBuilt: boolean;
  /** Electron (Capacitor): the web assets were copied into the app after the last change to them. */
  electronCopied: boolean;
}

export interface ProjectPaths {
  base: string;
  src: string;
  project: string;
  derivedData: string;
  logs: string;
  stateFile: string;
  lockDir: string;
}

const PROJECT_ID = /^[A-Za-z0-9._-]{1,120}$/;
const MAX_PENDING = 20_000;

export function projectPaths(projectId: string, projectRel: string): ProjectPaths {
  if (!PROJECT_ID.test(projectId)) throw new AgentError(`Invalid project id ${JSON.stringify(projectId)}`, 'BAD_REQUEST');
  const rel = projectRel.replace(/^\/+|\/+$/g, '');
  if (rel.split('/').some((part) => part === '..')) throw new AgentError('Invalid project path', 'BAD_REQUEST');
  const base = path.join(capmacHome(), 'projects', projectId);
  const src = path.join(base, 'src');
  return {
    base,
    src,
    project: rel ? path.join(src, ...rel.split('/')) : src,
    derivedData: path.join(base, 'DerivedData'),
    logs: path.join(base, 'logs'),
    stateFile: path.join(base, 'state.json'),
    lockDir: path.join(base, 'lock'),
  };
}

export function emptyState(): ProjectState {
  return {
    version: 1,
    manifest: {},
    pendingChanges: [],
    pendingFull: true,
    needsCapSync: true,
    liveUrl: null,
    nativeGen: 1,
    webGen: 1,
    builds: {},
    electronPending: [],
    electronPendingFull: true,
    electronDeps: {},
    electronBuilt: false,
    electronCopied: false,
  };
}

export async function loadState(paths: ProjectPaths): Promise<ProjectState> {
  try {
    const parsed = JSON.parse(await fs.readFile(paths.stateFile, 'utf8')) as ProjectState;
    if (parsed.version !== 1) return emptyState();
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

export async function saveState(paths: ProjectPaths, state: ProjectState): Promise<void> {
  if (state.pendingChanges.length > MAX_PENDING) {
    state.pendingChanges = [];
    state.pendingFull = true;
  }
  if (state.electronPending.length > MAX_PENDING) {
    state.electronPending = [];
    state.electronPendingFull = true;
  }
  await fs.mkdir(paths.base, { recursive: true });
  const tmp = `${paths.stateFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, paths.stateFile);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * Per-project lock so two capmac commands (say, a `dev` session rebuilding
 * while you run `capmac build`) never run xcodebuild on the same tree.
 */
export async function withProjectLock<T>(paths: ProjectPaths, io: AgentIO, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(paths.base, { recursive: true });
  const ownerFile = path.join(paths.lockDir, 'owner');
  let announced = false;
  for (;;) {
    try {
      await fs.mkdir(paths.lockDir);
      await fs.writeFile(ownerFile, String(process.pid));
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      const owner = Number((await fs.readFile(ownerFile, 'utf8').catch(() => '')).trim());
      if (!owner || !pidAlive(owner)) {
        const st = await fs.stat(paths.lockDir).catch(() => null);
        // An owner-less lock younger than a few seconds is probably being created right now.
        if (owner || !st || Date.now() - st.mtimeMs > 5000) {
          await fs.rm(paths.lockDir, { recursive: true, force: true });
          continue;
        }
      }
      if (!announced) {
        io.log('info', 'Waiting for another capmac command on this project to finish…');
        announced = true;
      }
      await sleep(500, io.signal);
      if (io.signal.aborted) throw new AgentError('Cancelled', 'CANCELLED');
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(paths.lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
