import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toPosixRel } from '../shared/paths.js';
import { loadProjectConfig, type ProjectConfig } from './config.js';

export const CAP_CONFIG_FILES = ['capacitor.config.ts', 'capacitor.config.mts', 'capacitor.config.js', 'capacitor.config.mjs', 'capacitor.config.cjs', 'capacitor.config.json'];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export interface ProjectInfo {
  /** Folder with capacitor.config.* */
  capDir: string;
  configFile: string;
  /** Folder mirrored to the Mac (lockfile root for monorepos). */
  syncRoot: string;
  /** POSIX path from syncRoot to capDir ('' when equal). */
  projectRel: string;
  appId: string;
  appName: string;
  /** Web assets dir, relative to capDir. */
  webDir: string;
  /** iOS platform dir, relative to capDir. */
  iosDir: string;
  scheme: string;
  teamId?: string;
  iosPackageManager: 'SPM' | 'CocoaPods' | 'unknown';
  hasIos: boolean;
  packageManager: PackageManager;
  projectId: string;
  config: ProjectConfig;
  scripts: Record<string, string>;
}

export class ProjectError extends Error {
  readonly expected = true;
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

export function findCapacitorDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (CAP_CONFIG_FILES.some((f) => existsSync(path.join(dir, f)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findSyncRoot(capDir: string): string {
  let dir = capDir;
  for (;;) {
    if (LOCKFILES.some((f) => existsSync(path.join(dir, f)))) return dir;
    if (existsSync(path.join(dir, '.git'))) return capDir;
    const parent = path.dirname(dir);
    if (parent === dir) return capDir;
    dir = parent;
  }
}

function detectPackageManager(root: string, packageJson: any): PackageManager {
  const declared = String(packageJson?.packageManager ?? '').match(/^(npm|yarn|pnpm|bun)@/)?.[1];
  if (declared) return declared as PackageManager;
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

function findLocalCapCli(capDir: string): string | null {
  let dir = capDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface ResolvedCapConfig {
  appId?: string;
  appName?: string;
  webDir?: string;
  iosDir?: string;
  scheme?: string;
  teamId?: string;
  iosPackageManager?: string;
}

/**
 * The Node.js to run project tools with. Inside Electron (capmac Studio)
 * process.execPath is the app itself, so use the developer's Node from PATH.
 */
export function nodeExecutable(): string {
  return process.versions.electron ? (process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath;
}

/** Asks the project's own Capacitor CLI for the evaluated config (handles TS configs). */
function evaluateWithCli(capDir: string): Promise<ResolvedCapConfig | null> {
  const cli = findLocalCapCli(capDir);
  if (!cli) return Promise.resolve(null);
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', FORCE_COLOR: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(nodeExecutable(), [cli, 'config', '--json'], { cwd: capDir, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const line = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
      try {
        const parsed = JSON.parse(line ?? '');
        resolve({
          appId: parsed.app?.appId,
          appName: parsed.app?.appName,
          webDir: parsed.app?.webDir,
          iosDir: parsed.ios?.platformDir,
          scheme: parsed.ios?.scheme,
          teamId: parsed.ios?.buildOptions?.teamId ?? parsed.app?.extConfig?.ios?.buildOptions?.teamId,
          iosPackageManager: parsed.ios?.packageManager,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/** Fallback when the CLI is unavailable: read simple literal values from the config file. */
async function evaluateStatically(configFile: string): Promise<ResolvedCapConfig> {
  const text = await fs.readFile(configFile, 'utf8');
  if (configFile.endsWith('.json')) {
    const json = JSON.parse(text);
    return { appId: json.appId, appName: json.appName, webDir: json.webDir, iosDir: json.ios?.path, scheme: json.ios?.scheme };
  }
  const pick = (key: string) => text.match(new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`))?.[1];
  const iosBlock = text.match(/\bios\s*:\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const pickIos = (key: string) => iosBlock.match(new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`))?.[1];
  return { appId: pick('appId'), appName: pick('appName'), webDir: pick('webDir'), iosDir: pickIos('path'), scheme: pickIos('scheme') };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

export async function loadProject(cwd: string): Promise<ProjectInfo> {
  const capDir = findCapacitorDir(cwd);
  if (!capDir) {
    throw new ProjectError('No Capacitor project found here (no capacitor.config.* in this folder or its parents).', 'Run capmac from your Capacitor app folder.');
  }
  const configFile = CAP_CONFIG_FILES.map((f) => path.join(capDir, f)).find((f) => existsSync(f))!;
  const resolved = (await evaluateWithCli(capDir)) ?? (await evaluateStatically(configFile));
  const syncRoot = findSyncRoot(capDir);
  let packageJson: any = {};
  try {
    packageJson = JSON.parse(await fs.readFile(path.join(capDir, 'package.json'), 'utf8'));
  } catch {
    // ok
  }
  let rootPackageJson = packageJson;
  if (syncRoot !== capDir) {
    try {
      rootPackageJson = JSON.parse(await fs.readFile(path.join(syncRoot, 'package.json'), 'utf8'));
    } catch {
      // ok
    }
  }
  const iosDir = (resolved.iosDir || 'ios').replace(/\\/g, '/').replace(/\/+$/, '');
  const nativeDir = path.join(capDir, iosDir, 'App');
  const iosPackageManager: ProjectInfo['iosPackageManager'] = existsSync(path.join(nativeDir, 'CapApp-SPM'))
    ? 'SPM'
    : existsSync(path.join(nativeDir, 'Podfile'))
      ? 'CocoaPods'
      : 'unknown';
  const appName = resolved.appName || path.basename(capDir);
  const projectId = `${slug(appName)}-${createHash('sha1').update(`${os.hostname()}|${syncRoot.toLowerCase()}`).digest('hex').slice(0, 8)}`;
  return {
    capDir,
    configFile,
    syncRoot,
    projectRel: toPosixRel(syncRoot, capDir),
    appId: resolved.appId || 'unknown',
    appName,
    webDir: (resolved.webDir || 'www').replace(/\\/g, '/').replace(/^\.\/+|\/+$/g, ''),
    iosDir,
    scheme: resolved.scheme || 'App',
    teamId: resolved.teamId,
    iosPackageManager,
    hasIos: existsSync(nativeDir),
    packageManager: detectPackageManager(syncRoot, rootPackageJson),
    projectId,
    config: await loadProjectConfig(capDir),
    scripts: packageJson.scripts ?? {},
  };
}

/**
 * Whether the project's JavaScript dependencies are installed on this PC.
 * A node_modules folder alone is not enough: dev servers leave caches there
 * (node_modules/.vite) even when nothing was installed.
 */
export function hasInstalledDependencies(project: Pick<ProjectInfo, 'capDir' | 'syncRoot'>): boolean {
  for (const dir of new Set([project.capDir, project.syncRoot])) {
    try {
      if (readdirSync(path.join(dir, 'node_modules')).some((name) => !name.startsWith('.'))) return true;
    } catch {
      // no node_modules here
    }
  }
  return false;
}

export function requireIos(project: ProjectInfo): void {
  if (!project.hasIos) {
    throw new ProjectError(`This app has no iOS platform yet (${project.iosDir}/App is missing).`, 'Add it with `npx cap add ios` (or `npx cap add ios --packagemanager SPM`), then run again.');
  }
}

/** Whether the iOS app adopts the UIScene lifecycle (required when building with the iOS 27 SDK). */
export function usesSceneLifecycle(project: ProjectInfo): boolean | null {
  try {
    const plist = readFileSync(path.join(project.capDir, project.iosDir, 'App', 'App', 'Info.plist'), 'utf8');
    return plist.includes('UIApplicationSceneManifest');
  } catch {
    return null;
  }
}

/** The command a developer would type to run a package.json script. */
export function scriptCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case 'npm':
      return `npm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'bun':
      return `bun run ${script}`;
  }
}
