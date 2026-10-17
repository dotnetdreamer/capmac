import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toPosixRel } from '../shared/paths.js';
import { loadProjectConfig, type ProjectConfig } from './config.js';
import { capacitorElectronDir, dependsOnElectron, describeElectronApp, readPackageJson, type ElectronProject } from './electron-project.js';
import { describeFlutterProject, flutterDisplayName, flutterSyncRoot, isFlutterProjectDir, type FlutterProject } from './flutter/project.js';
import { adoptMemory, recallAll, type ProjectMemory } from './memory.js';
import { describeReactNativeProject, isReactNativeProjectDir, type ReactNativeProject } from './react-native/project.js';

export type { ElectronProject } from './electron-project.js';
export type { FlutterProject } from './flutter/project.js';
export type { ReactNativeProject } from './react-native/project.js';

export const CAP_CONFIG_FILES = ['capacitor.config.ts', 'capacitor.config.mts', 'capacitor.config.js', 'capacitor.config.mjs', 'capacitor.config.cjs', 'capacitor.config.json'];
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

/** A Capacitor app (capacitor.config.*), an Electron app on its own (a package.json that depends on electron), a Flutter app (pubspec.yaml), or a React Native app (a package.json that depends on react-native or expo). */
export type ProjectKind = 'capacitor' | 'electron' | 'flutter' | 'react-native';

/**
 * The apps CapMac runs, by the id `--app` takes: a Capacitor project's iOS
 * app, and the Electron app (Capacitor's Electron platform, or the project
 * itself); a Flutter or React Native project's iOS app, its Mac app (`macos`,
 * on the Mac's desktop) and its Windows app (`windows`, on this PC). One
 * project can have several.
 */
export type RunnableApp = 'ios' | 'electron' | 'macos' | 'windows';
export const RUNNABLE_APPS: readonly RunnableApp[] = ['ios', 'electron', 'macos', 'windows'];
export const isRunnableApp = (value: unknown): value is RunnableApp => RUNNABLE_APPS.includes(value as RunnableApp);

/** Where a project's iOS app builds: on a paired Mac, or on this PC in WSL with no Mac (see backend.ts). */
export type BuildBackend = 'mac' | 'wsl';
export const isBuildBackend = (value: unknown): value is BuildBackend => value === 'mac' || value === 'wsl';

export interface ProjectInfo {
  kind: ProjectKind;
  /** The project folder: the one with capacitor.config.*, or the Electron app's. */
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
  /** The Electron app: the project itself, or Capacitor's Electron platform; null when there is none. */
  electron: ElectronProject | null;
  /** A Flutter project's details (its apps, ids and options); null for other projects. */
  flutter?: FlutterProject | null;
  /** A React Native project's details (its apps, ids and options); null for other projects. */
  reactNative?: ReactNativeProject | null;
  /** The app picked for this project (CapMac Studio's app picker, `capmac apps use`), if any. */
  chosenApp?: RunnableApp | null;
}

export class ProjectError extends Error {
  readonly expected = true;
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

const hasCapacitorConfig = (dir: string) => CAP_CONFIG_FILES.some((f) => existsSync(path.join(dir, f)));

/** Capacitor's Electron platform folder (it has a copy of capacitor.config, but the project is above it). */
export const isElectronPlatform = (dir: string) => path.basename(dir) === 'electron' && dependsOnElectron(readPackageJson(dir)) && hasCapacitorConfig(path.dirname(dir));

export function findCapacitorDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (hasCapacitorConfig(dir) && !isElectronPlatform(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The project `start` is in: the nearest folder with capacitor.config.*, a
 * Flutter app's pubspec.yaml, a React Native app's package.json, or a
 * package.json that depends on electron.
 * Inside Capacitor's Electron platform (electron/), that is the Capacitor
 * project around it.
 */
export function findProjectDir(start: string): { dir: string; kind: ProjectKind } | null {
  let dir = path.resolve(start);
  for (;;) {
    // Capacitor's Electron platform keeps a copy of capacitor.config: the project is the folder above.
    if (isElectronPlatform(dir)) return { dir: path.dirname(dir), kind: 'capacitor' };
    if (hasCapacitorConfig(dir)) return { dir, kind: 'capacitor' };
    if (isFlutterProjectDir(dir)) return { dir, kind: 'flutter' };
    if (isReactNativeProjectDir(dir)) return { dir, kind: 'react-native' };
    if (dependsOnElectron(readPackageJson(dir))) return { dir, kind: 'electron' };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The folder mirrored to the Mac: the lockfile's folder (a monorepo's root), else the project. */
export function findSyncRoot(capDir: string): string {
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

/** Simple literal values from a Capacitor config's text (no code is run). */
function parseCapacitorConfig(text: string, json: boolean): ResolvedCapConfig {
  if (json) {
    const parsed = JSON.parse(text);
    return { appId: parsed.appId, appName: parsed.appName, webDir: parsed.webDir, iosDir: parsed.ios?.path, scheme: parsed.ios?.scheme };
  }
  const pick = (key: string) => text.match(new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`))?.[1];
  const iosBlock = text.match(/\bios\s*:\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const pickIos = (key: string) => iosBlock.match(new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`))?.[1];
  return { appId: pick('appId'), appName: pick('appName'), webDir: pick('webDir'), iosDir: pickIos('path'), scheme: pickIos('scheme') };
}

/** Fallback when the CLI is unavailable: read simple literal values from the config file. */
async function evaluateStatically(configFile: string): Promise<ResolvedCapConfig> {
  return parseCapacitorConfig(await fs.readFile(configFile, 'utf8'), configFile.endsWith('.json'));
}

/** A Capacitor config's literal values, read without running anything (finding apps must be quick); {} when unreadable. */
export function readCapacitorConfig(configFile: string): { appId?: string; appName?: string; webDir?: string; iosDir?: string } {
  try {
    return parseCapacitorConfig(readFileSync(configFile, 'utf8'), configFile.endsWith('.json'));
  } catch {
    return {};
  }
}

/** The name a Capacitor project's CLI evaluates (CapMac 0.1 made its id from it), without loading or migrating the project. Null when the CLI can't run here. */
export async function evaluatedCapacitorName(dir: string): Promise<string | null> {
  const evaluated = await evaluateWithCli(dir);
  return evaluated ? evaluated.appName || path.basename(dir) : null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

/**
 * The project's id: its folder name on the Mac, and its key in CapMac's memory
 * of it. A readable slug of its name plus a hash of its own folder, so sibling
 * projects that share a name and a lockfile (a monorepo's `one/mobile` and
 * `two/mobile`) still get different ids and never share build state or memory.
 */
export function projectIdFor(appName: string, projectDir: string): string {
  return `${slug(appName)}-${createHash('sha1').update(`${os.hostname()}|${projectDir.toLowerCase()}`).digest('hex').slice(0, 8)}`;
}

/**
 * Why there is no project here, saying what is here instead when CapMac knows
 * it: apps in the folders inside (a monorepo), or an app it can't run yet.
 */
async function noProjectError(cwd: string): Promise<ProjectError> {
  // Loaded here: apps.ts builds on this module.
  const { canRun, findApps, nothingToRun } = await import('./apps.js');
  const search = await findApps(cwd, { depth: 2 }).catch(() => null);
  const inside = search?.projects.find((p) => p.apps.some(canRun) && p.rel && !p.rel.startsWith('..'));
  if (inside) {
    return new ProjectError('There is no app in this folder itself, but there are apps in the folders inside it.', `See them with \`capmac apps\`, and run capmac in one of them (e.g. \`cd ${inside.rel.split('/').join(path.sep)}\`).`);
  }
  if (search?.projects.length) return nothingToRun(search);
  return new ProjectError(
    'No Capacitor, Flutter, React Native or Electron app found here (no capacitor.config.*, Flutter pubspec.yaml, or package.json that depends on react-native, expo or electron, in this folder or its parents).',
    'Run capmac from your app’s folder.',
  );
}

/**
 * What CapMac remembers about the project in `dir`: its last target, its
 * sound, the app picked for it. Ids used to be made from the folder synced to
 * the Mac and the name a Capacitor app's CLI evaluates (`oldNames`), so a
 * monorepo's app, or an app with a computed name, had another id before.
 * What it remembered under that one carries over while the new id has
 * nothing, except the app picked when another project there had the same old
 * id: apps with one name in one monorepo shared it, and whose pick it was
 * can't be told. `adopt` saves it under the new id.
 */
export async function projectMemory(projectId: string, dir: string, oldNames: string[], adopt = false): Promise<ProjectMemory> {
  const all = await recallAll();
  if (all[projectId]) return all[projectId]!;
  const syncRoot = findSyncRoot(dir);
  const oldIds = [...new Set(oldNames.map((name) => projectIdFor(name, syncRoot)))].filter((id) => id !== projectId && all[id]);
  if (!oldIds.length) return {};
  const memory: ProjectMemory = Object.assign({}, ...oldIds.map((id) => all[id]));
  const pickedUnder = [...oldIds].reverse().find((id) => all[id]!.app !== undefined);
  if (pickedUnder) {
    // Loaded here: apps.ts builds on this module.
    const { onlyProjectWithId } = await import('./apps.js');
    if (!(await onlyProjectWithId(pickedUnder, syncRoot, dir, { evaluateNames: adopt }))) delete memory.app;
  }
  if (adopt) return adoptMemory(projectId, memory).catch(() => memory);
  return memory;
}

/** The app picked for the project before (in CapMac Studio or with `capmac apps use`), if it is one CapMac runs. */
async function recallApp(projectId: string, dir: string, oldNames: string[]): Promise<RunnableApp | null> {
  const app = (await projectMemory(projectId, dir, oldNames, true)).app;
  return isRunnableApp(app) ? app : null;
}

/** An Electron app on its own (no Capacitor): the app is the project. */
async function loadElectronProject(dir: string): Promise<ProjectInfo> {
  const syncRoot = findSyncRoot(dir);
  const packageJson = readPackageJson(dir) ?? {};
  const rootPackageJson = syncRoot === dir ? packageJson : readPackageJson(syncRoot) ?? packageJson;
  const config = await loadProjectConfig(dir);
  const electron = describeElectronApp(dir, '', false);
  const projectId = projectIdFor(electron.name, dir);
  return {
    kind: 'electron',
    capDir: dir,
    configFile: path.join(dir, 'package.json'),
    syncRoot,
    projectRel: toPosixRel(syncRoot, dir),
    appId: electron.appId ?? packageJson.name ?? path.basename(dir),
    appName: electron.name,
    // No Capacitor web assets: the build (if any) runs on the Mac.
    webDir: '',
    iosDir: 'ios',
    scheme: 'App',
    iosPackageManager: 'unknown',
    hasIos: false,
    packageManager: detectPackageManager(syncRoot, rootPackageJson),
    projectId,
    config,
    scripts: packageJson.scripts ?? {},
    electron,
    chosenApp: await recallApp(projectId, dir, [electron.name]),
  };
}

/** A Flutter app: one project, an app per platform folder (ios/, macos/, windows/). */
async function loadFlutterProject(dir: string): Promise<ProjectInfo> {
  const flutter = describeFlutterProject(dir);
  if (!flutter) throw new ProjectError('This pubspec.yaml is not a Flutter app’s.', 'CapMac runs Flutter apps: a pubspec.yaml that depends on the Flutter SDK (flutter: sdk: flutter).');
  const syncRoot = flutterSyncRoot(dir, flutter);
  const config = await loadProjectConfig(dir);
  const projectId = projectIdFor(flutter.name, dir);
  return {
    kind: 'flutter',
    capDir: dir,
    configFile: path.join(dir, 'pubspec.yaml'),
    syncRoot,
    projectRel: toPosixRel(syncRoot, dir),
    appId: flutter.ios?.bundleId ?? flutter.macos?.bundleId ?? flutter.name,
    appName: flutterDisplayName(flutter),
    // Flutter builds its own assets; there is no web folder to copy.
    webDir: '',
    iosDir: 'ios',
    scheme: flutter.options.flavor ?? 'Runner',
    iosPackageManager: !flutter.ios ? 'unknown' : flutter.ios.plugins === 'SPM' ? 'SPM' : 'CocoaPods',
    hasIos: flutter.platforms.ios,
    packageManager: 'npm',
    projectId,
    config,
    scripts: {},
    electron: null,
    flutter,
    chosenApp: await recallApp(projectId, dir, [flutter.name]),
  };
}

/** A React Native app: one project, an app per platform folder (ios/, macos/, windows/). */
async function loadReactNativeProject(dir: string): Promise<ProjectInfo> {
  const reactNative = describeReactNativeProject(dir);
  if (!reactNative) throw new ProjectError('This package.json is not a React Native app’s.', 'CapMac runs React Native apps: a package.json that depends on react-native (or expo), with an ios/, macos/ or windows/ folder.');
  const syncRoot = findSyncRoot(dir);
  const packageJson = readPackageJson(dir) ?? {};
  const rootPackageJson = syncRoot === dir ? packageJson : readPackageJson(syncRoot) ?? packageJson;
  const config = await loadProjectConfig(dir);
  const projectId = projectIdFor(reactNative.name, dir);
  return {
    kind: 'react-native',
    capDir: dir,
    configFile: path.join(dir, 'package.json'),
    syncRoot,
    projectRel: toPosixRel(syncRoot, dir),
    appId: reactNative.ios?.bundleId ?? reactNative.macos?.bundleId ?? reactNative.name,
    appName: reactNative.displayName,
    // Metro serves the JavaScript; there is no web folder to copy.
    webDir: '',
    iosDir: 'ios',
    scheme: reactNative.ios?.scheme ?? reactNative.name,
    iosPackageManager: reactNative.ios ? (reactNative.ios.pods ? 'CocoaPods' : 'unknown') : 'unknown',
    hasIos: reactNative.platforms.ios,
    packageManager: detectPackageManager(syncRoot, rootPackageJson),
    projectId,
    config,
    scripts: packageJson.scripts ?? {},
    electron: null,
    reactNative,
    chosenApp: await recallApp(projectId, dir, [reactNative.name]),
  };
}

export async function loadProject(cwd: string): Promise<ProjectInfo> {
  const found = findProjectDir(cwd);
  if (!found) throw await noProjectError(cwd);
  if (found.kind === 'electron') return loadElectronProject(found.dir);
  if (found.kind === 'flutter') return loadFlutterProject(found.dir);
  if (found.kind === 'react-native') return loadReactNativeProject(found.dir);
  const capDir = found.dir;
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
  // The id (the Mac folder, and the memory key app detection looks the project up by) must not
  // depend on whether the Capacitor CLI is installed, so derive it from the statically-read config
  // — the same name apps.ts computes — not the CLI-evaluated appName.
  const idName = readCapacitorConfig(configFile).appName || path.basename(capDir);
  const projectId = projectIdFor(idName, capDir);
  const config = await loadProjectConfig(capDir);
  const electronDir = capacitorElectronDir(capDir, config);
  return {
    kind: 'capacitor',
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
    config,
    scripts: packageJson.scripts ?? {},
    electron: electronDir ? describeElectronApp(electronDir, toPosixRel(capDir, electronDir), true) : null,
    // Old ids used the name the CLI evaluates (CapMac 0.1), or the config's.
    chosenApp: await recallApp(projectId, capDir, [appName, idName]),
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
  if (project.kind === 'electron') {
    throw new ProjectError('This is an Electron app: it has no iOS app to build.', 'It runs on the Mac’s desktop: `capmac run` launches it there.');
  }
  if (project.kind === 'flutter') {
    if (!project.hasIos) throw new ProjectError('This Flutter app has no iOS app yet (ios/Runner.xcodeproj is missing).', 'Add it on Windows with `flutter create --platforms ios .`, then run again.');
    return;
  }
  if (project.kind === 'react-native') {
    requireReactNative(project, 'ios');
    return;
  }
  if (!project.hasIos) {
    throw new ProjectError(`This app has no iOS platform yet (${project.iosDir}/App is missing).`, 'Add it with `npx cap add ios` (or `npx cap add ios --packagemanager SPM`), then run again.');
  }
}

/** A Flutter project's details, for code that only runs Flutter apps. */
export function requireFlutter(project: ProjectInfo, app?: 'ios' | 'macos' | 'windows'): FlutterProject {
  const flutter = project.kind === 'flutter' ? project.flutter : null;
  if (!flutter) throw new ProjectError('This is not a Flutter app.', 'Run capmac in the folder with your Flutter app’s pubspec.yaml.');
  if (app && !flutter.platforms[app]) {
    const what = app === 'ios' ? 'an iOS app' : app === 'macos' ? 'a Mac app' : 'a Windows app';
    throw new ProjectError(`This Flutter app has no ${what.slice(what.indexOf(' ') + 1)} yet (${app}/ is missing).`, `Add ${what} on Windows with \`flutter create --platforms ${app} .\`, then run again.`);
  }
  return flutter;
}

/** A React Native project's details, for code that only runs React Native apps; with `app`, that app must be there. */
export function requireReactNative(project: ProjectInfo, app?: 'ios' | 'macos' | 'windows'): ReactNativeProject {
  const rn = project.kind === 'react-native' ? project.reactNative : null;
  if (!rn) throw new ProjectError('This is not a React Native app.', 'Run capmac in the folder with your React Native app’s package.json.');
  if (app && !rn.platforms[app]) {
    if (app === 'ios') throw new ProjectError('This React Native app has no iOS app yet (ios/ is missing).', 'Make a new app with React Native’s template (`npx @react-native-community/cli init`) and copy its ios/ folder over, then run again.');
    if (app === 'macos') throw new ProjectError('This React Native app has no Mac app yet (macos/ is missing).', 'Add one on Windows with `npx react-native-macos-init`, then run again.');
    throw new ProjectError('This React Native app has no Windows app yet (windows/ is missing).', 'Add one on Windows with `npm install react-native-windows` and `npx react-native init-windows --template cpp-app`, then run again.');
  }
  return rn;
}

/** The platform apps of a Flutter or React Native project (null for the others). */
export function platformsOf(project: Pick<ProjectInfo, 'flutter' | 'reactNative'>): Record<'ios' | 'macos' | 'windows', boolean> | null {
  return project.flutter?.platforms ?? project.reactNative?.platforms ?? null;
}

/** A project with an app per platform folder: a Flutter or a React Native app. */
export const hasPlatformApps = (project: Pick<ProjectInfo, 'kind'>): boolean => project.kind === 'flutter' || project.kind === 'react-native';

/** The framework's name, for messages ("Flutter", "React Native"). */
function multiName(project: ProjectInfo): string {
  return project.kind === 'react-native' ? 'React Native' : 'Flutter';
}

export function requireElectron(project: ProjectInfo): ElectronProject {
  if (hasPlatformApps(project)) throw new ProjectError(`This is a ${multiName(project)} app: it has no Electron app.`, 'Its Mac app runs on the Mac’s desktop: `capmac run --app macos`.');
  if (project.electron) return project.electron;
  throw new ProjectError(
    'This app has no Electron platform.',
    'Add it on Windows with `npm install @capacitor-community/electron` and `npx cap add @capacitor-community/electron`, then run again.',
  );
}

/** What a command says about which app it is for (its flags). */
export interface AppOptions {
  /** `--app`: the app's id ('ios', 'electron', 'macos' or 'windows'). */
  app?: string;
  /** `--electron`: the Electron app. */
  electron?: boolean;
  /** A simulator or device (the iOS app), "mac" (the Mac desktop app) or "pc" (a Flutter app's Windows app, on this PC). */
  target?: string;
  /** A device or a simulator: places only the iOS app runs. */
  device?: boolean;
  simulator?: boolean;
}

const MAC_TARGET = /^(mac|macos|electron|mac-desktop|this mac)$/i;
const PC_TARGET = /^(pc|this pc|this-pc|windows|pc-desktop)$/i;

/** The apps a project has, by id: the ones `--app` takes for it. */
export function projectApps(project: ProjectInfo): RunnableApp[] {
  if (project.kind === 'electron') return ['electron'];
  if (hasPlatformApps(project)) {
    const platforms = platformsOf(project);
    return (['ios', 'macos', 'windows'] as const).filter((app) => platforms?.[app]);
  }
  // A Capacitor project always has room for its iOS app (it can be added from CapMac).
  return project.electron ? ['ios', 'electron'] : ['ios'];
}

/** `--app` as people type it: the Mac app is "mac" too, the Windows app "pc" or "win". */
function appNamed(project: ProjectInfo, name: string): RunnableApp | null {
  const wanted = name.trim().toLowerCase();
  if (isRunnableApp(wanted)) return wanted;
  if (MAC_TARGET.test(wanted)) return hasPlatformApps(project) ? 'macos' : 'electron';
  if (PC_TARGET.test(wanted) || wanted === 'win') return 'windows';
  if (wanted === 'iphone' || wanted === 'ipad') return 'ios';
  return null;
}

/**
 * Which of the project's apps a command is for: the one asked for (`--app`),
 * the project itself when it is an Electron app, a place only one app runs
 * (`--electron`, `--target mac`, `--target pc`, a simulator or a device), else
 * the app picked for the project, else its iOS app, else its first other app.
 */
export function appFor(project: ProjectInfo, options: AppOptions = {}): RunnableApp {
  const apps = projectApps(project);
  if (options.app !== undefined) {
    const wanted = appNamed(project, options.app);
    // An app the project could have but does not yet is fine here: running it says how to add it.
    const kinds: readonly RunnableApp[] = hasPlatformApps(project) ? ['ios', 'macos', 'windows'] : ['ios', 'electron'];
    if (wanted && kinds.includes(wanted)) return wanted;
    throw new ProjectError(`There is no app called "${options.app}" here.`, `This project's apps: ${apps.join(', ') || 'none yet'}. See them with \`capmac apps\`.`);
  }
  if (project.kind === 'electron') return 'electron';
  const multi = hasPlatformApps(project);
  if (options.electron) {
    if (multi) throw new ProjectError(`This is a ${multiName(project)} app: it has no Electron app.`, 'Its Mac app is `--app macos`.');
    return 'electron';
  }
  if (options.target) {
    const target = options.target.trim();
    if (MAC_TARGET.test(target)) return multi ? 'macos' : 'electron';
    if (multi && PC_TARGET.test(target)) return 'windows';
    return 'ios';
  }
  if (options.device || options.simulator) return 'ios';
  // An app picked before that still exists.
  if (project.chosenApp && apps.includes(project.chosenApp)) return project.chosenApp;
  if (multi) return apps[0] ?? 'ios';
  return project.electron && !project.hasIos ? 'electron' : 'ios';
}

/** Whether a command is for an app that runs on the Mac's desktop (Electron, or a Flutter or React Native app's Mac app) rather than a simulator or device (see appFor). */
export function runsOnMac(project: ProjectInfo, options: AppOptions = {}): boolean {
  const app = appFor(project, options);
  return app === 'electron' || app === 'macos';
}

/** Whether a command is for a Flutter or React Native app's Windows app, which runs on this PC (see appFor). */
export function runsOnPc(project: ProjectInfo, options: AppOptions = {}): boolean {
  return appFor(project, options) === 'windows';
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
