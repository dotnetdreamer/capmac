/**
 * The apps in a project folder, and which one CapMac works on.
 *
 * One folder can hold several apps: a Capacitor project with an iOS app and
 * an Electron app (Ludo Wala ships its iPad app and its Steam build for the
 * Mac from one folder), or a monorepo with a phone app and a desktop app side
 * by side. Finding them only reads files, nothing runs, so it is quick enough
 * for the moment a folder is added. Each framework has a detector: Capacitor
 * and Electron, which CapMac runs, and the ones it recognises so it can say
 * what it found (Flutter, React Native, Expo, Tauri, .NET MAUI, Cordova,
 * NativeScript, Xcode projects). A new framework is one more detector.
 */
import { existsSync, promises as fs, readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { toPosixRel } from '../shared/paths.js';
import { allDependencies, capacitorElectronDir, dependsOnElectron, describeElectronApp, electronProductName, readPackageJson, type ElectronProject } from './electron-project.js';
import { remember } from './memory.js';
import { appFor, CAP_CONFIG_FILES, isElectronPlatform, isRunnableApp, ProjectError, projectIdFor, projectMemory, readCapacitorConfig, requireElectron, type ProjectInfo, type RunnableApp } from './project.js';

/** What an app is to CapMac: an iOS app (simulators, iPhones and iPads) or a Mac desktop app. */
export type AppPlatform = 'ios' | 'mac';

/** The frameworks CapMac recognises. It runs Capacitor and Electron apps today. */
export type AppFramework = 'capacitor' | 'electron' | 'flutter' | 'react-native' | 'expo' | 'tauri' | 'maui' | 'cordova' | 'nativescript' | 'xcode';

export interface ProjectApp {
  /**
   * The app's id in its project: 'ios' or 'electron' for the apps CapMac
   * runs (what `--app` takes, and what CapMac remembers), 'ios' or 'macos'
   * for the ones it only recognises.
   */
  id: string;
  platform: AppPlatform;
  framework: AppFramework;
  /** How it is built: an iOS app's package manager ('SPM', 'CocoaPods'), an Electron app's tool ('capacitor', 'electron-vite', 'forge', 'plain'). */
  flavor: string | null;
  /** The app's name, as on the Home Screen or in the Dock. */
  name: string;
  /** The app's own folder, POSIX, from the project folder ('' when it is the project folder). */
  rel: string;
  /** The version of the framework the project asks for ("^8.5.0"), for display. */
  version: string | null;
  /** A PNG of the app's icon, if it has one. */
  icon: string | null;
  /** ready: CapMac runs it; setup: it would once `hint` is done; unsupported: CapMac knows it but cannot run it yet. */
  status: 'ready' | 'setup' | 'unsupported';
  hint?: string;
  /** The files that tell what it is, POSIX, from the project folder. */
  evidence: string[];
}

export interface DetectedProject {
  /** The project folder: the one CapMac Studio adds, where `capmac` commands run. */
  dir: string;
  /** POSIX path from where the search started ('' for that folder, '..' when the search started inside the project). */
  rel: string;
  name: string;
  framework: AppFramework;
  apps: ProjectApp[];
  /** The app picked for this project before (in CapMac Studio, or with `capmac apps use`), if any. */
  chosen: RunnableApp | null;
}

export interface AppSearch {
  /** The folder the search started from. */
  start: string;
  /** The project around that folder first (if any), then the ones inside it, nearest first. */
  projects: DetectedProject[];
  /** The app to offer first: the one whose folder the search started in, else the one picked before, else the first CapMac runs. */
  suggested: { dir: string; app: string } | null;
  /** The search stopped early in a very big folder: there may be more apps deeper down. */
  truncated: boolean;
}

/** Whether CapMac can run the app (now, or once it is set up). */
export const canRun = (app: Pick<ProjectApp, 'status'>) => app.status !== 'unsupported';

// ─── Reading files ─────────────────────────────────────────────────────────

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file: string): any {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The largest icon in an asset catalog's app icon set (AppIcon first, as Xcode does), if any. */
async function iconInAssets(assetsDir: string): Promise<string | null> {
  let sets: string[] = [];
  try {
    sets = (await fs.readdir(assetsDir)).filter((name) => name.endsWith('.appiconset'));
  } catch {
    return null;
  }
  sets.sort((a, b) => (a === 'AppIcon.appiconset' ? -1 : b === 'AppIcon.appiconset' ? 1 : a.localeCompare(b)));
  for (const set of sets) {
    const dir = path.join(assetsDir, set);
    let images: Array<{ filename?: string; size?: string; scale?: string }> = [];
    try {
      images = JSON.parse(await fs.readFile(path.join(dir, 'Contents.json'), 'utf8')).images ?? [];
    } catch {
      continue;
    }
    // A single-size icon (Xcode 14+) has no scale: count it as 1x.
    const pixels = (img: { size?: string; scale?: string }) => Number(img.size?.split('x')[0] ?? 0) * Number(img.scale?.replace('x', '') ?? 1);
    const best = images.filter((img) => img.filename && existsSync(path.join(dir, img.filename))).sort((a, b) => pixels(b) - pixels(a))[0];
    if (best?.filename) return path.join(dir, best.filename);
  }
  return null;
}

/** A Capacitor iOS app's icon: the largest PNG in AppIcon.appiconset. */
export function findAppIcon(project: Pick<ProjectInfo, 'capDir' | 'iosDir'>): Promise<string | null> {
  return iconInAssets(path.join(project.capDir, project.iosDir, 'App', 'App', 'Assets.xcassets'));
}

// ─── The apps CapMac runs ──────────────────────────────────────────────────

interface CapacitorParts {
  /** The Capacitor project's folder. */
  dir: string;
  /** Its capacitor.config.* file (name or path). */
  configFile: string;
  iosDir: string;
  appName: string;
  deps: Record<string, string>;
  electron: ElectronProject | null;
}

function electronApp(electron: ElectronProject): ProjectApp {
  return {
    id: 'electron',
    platform: 'mac',
    framework: 'electron',
    flavor: electron.flavor,
    name: electronProductName(electron),
    rel: electron.rel,
    version: electron.electronRange,
    icon: electron.icon,
    status: 'ready',
    evidence: [electron.rel ? `${electron.rel}/package.json` : 'package.json'],
  };
}

/**
 * A Capacitor project's apps: its iOS app, and its Electron platform. The iOS
 * app is listed before it is added when the project depends on @capacitor/ios,
 * or has nothing else to run (it can then be added from CapMac).
 */
async function capacitorApps(parts: CapacitorParts): Promise<ProjectApp[]> {
  const apps: ProjectApp[] = [];
  const nativeDir = path.join(parts.dir, parts.iosDir, 'App');
  const hasIos = existsSync(nativeDir);
  if (hasIos || !parts.electron || parts.deps['@capacitor/ios']) {
    const spm = existsSync(path.join(nativeDir, 'CapApp-SPM'));
    const pods = existsSync(path.join(nativeDir, 'Podfile'));
    const xcodeproj = existsSync(path.join(nativeDir, 'App.xcodeproj'));
    apps.push({
      id: 'ios',
      platform: 'ios',
      framework: 'capacitor',
      flavor: spm ? 'SPM' : pods ? 'CocoaPods' : null,
      name: parts.appName,
      rel: hasIos ? `${parts.iosDir}/App` : parts.iosDir,
      version: parts.deps['@capacitor/ios'] ?? parts.deps['@capacitor/core'] ?? null,
      icon: hasIos ? await findAppIcon({ capDir: parts.dir, iosDir: parts.iosDir }) : null,
      status: hasIos ? 'ready' : 'setup',
      hint: hasIos ? undefined : 'Add it with `npx cap add ios`',
      evidence: [path.basename(parts.configFile), ...(hasIos ? [`${parts.iosDir}/App${xcodeproj ? '/App.xcodeproj' : ''}`] : [])],
    });
  }
  if (parts.electron) apps.push(electronApp(parts.electron));
  return apps;
}

/** The apps of a project CapMac has loaded (names as the project's own tools see them). */
export async function appsOf(project: ProjectInfo): Promise<ProjectApp[]> {
  if (project.kind === 'electron') return project.electron ? [electronApp(project.electron)] : [];
  return capacitorApps({
    dir: project.capDir,
    configFile: project.configFile,
    iosDir: project.iosDir,
    appName: project.appName,
    deps: allDependencies(readPackageJson(project.capDir)),
    electron: project.electron,
  });
}

/** Makes `app` the one CapMac works on in this project, from now on, in the CLI and CapMac Studio alike. */
export async function chooseApp(project: ProjectInfo, app: string): Promise<RunnableApp> {
  const id = appFor(project, { app });
  if (id === 'ios' && project.kind === 'electron') throw new ProjectError('This is an Electron app: it has no iOS app.', 'It runs on the Mac’s desktop: `capmac run` launches it there.');
  if (id === 'electron') requireElectron(project);
  await remember(project.projectId, { app: id });
  return id;
}

// ─── Detectors: one per framework ──────────────────────────────────────────

interface Found {
  framework: AppFramework;
  name: string;
  /** The name CapMac's project id is made from (as loadProject makes it). */
  idName: string;
  apps: ProjectApp[];
  /** The apps' own folders, from the project: they are not searched for other projects. */
  claims: string[];
}

/** One framework's detector: what it finds in `dir`, whose entries are `names`; `nested` when `dir` is below the folder that was picked. */
type Detector = (dir: string, names: Set<string>, nested: boolean) => Promise<Found | null> | Found | null;

function recognised(id: string, platform: AppPlatform, framework: AppFramework, name: string, rel: string, evidence: string[], version: string | null = null, icon: string | null = null): ProjectApp {
  return { id, platform, framework, flavor: null, name, rel, version, icon, status: 'unsupported', evidence };
}

const capacitor: Detector = async (dir, names) => {
  const configFile = CAP_CONFIG_FILES.find((file) => names.has(file));
  // Capacitor's Electron platform keeps a copy of the config: its project is the folder above.
  if (!configFile || isElectronPlatform(dir)) return null;
  const config = readCapacitorConfig(path.join(dir, configFile));
  const pkg = readPackageJson(dir);
  const appName = config.appName || path.basename(dir);
  const iosDir = (config.iosDir || 'ios').replace(/\\/g, '/').replace(/\/+$/, '');
  const electronDir = capacitorElectronDir(dir, readJson(path.join(dir, 'capmac.json')) ?? {});
  const electron = electronDir ? describeElectronApp(electronDir, toPosixRel(dir, electronDir), true) : null;
  const apps = await capacitorApps({ dir, configFile, iosDir, appName, deps: allDependencies(pkg), electron });
  return { framework: 'capacitor', name: appName, idName: appName, apps, claims: [iosDir.split('/')[0]!, ...(electron ? [electron.rel.split('/')[0]!] : []), 'android'] };
};

/** In a folder below the one picked, a package that depends on Electron must also build or start it to be an app (libraries depend on Electron to test with it). */
function looksLikeElectronApp(pkg: ReturnType<typeof readPackageJson>, names: Set<string>): boolean {
  const deps = allDependencies(pkg);
  if (deps['electron-builder'] || deps['@electron-forge/cli'] || deps['electron-vite'] || deps['electron-packager'] || deps['@electron/packager']) return true;
  if (names.has('forge.config.js') || names.has('electron.vite.config.ts') || names.has('electron.vite.config.js') || names.has('electron-builder.yml') || names.has('electron-builder.json')) return true;
  // A script that launches Electron: `electron .`/`electron ./`, `electron <entry.js>` (flags allowed; quoted, spaces too), or Forge/Vite start.
  return Object.values(pkg?.scripts ?? {}).some((script) =>
    /\belectron(?:\s+--?\S+)*\s+(?:(["'])(?:\.\.?(?:\/(?:(?!\1).)*)?|(?:(?!\1).)*\.[cm]?js)\1|\.\.?\/?\S*|\S+\.[cm]?js)(?:\s|$)|\belectron-forge\s+start\b|\belectron-vite\b/.test(script),
  );
}

const electron: Detector = (dir, names, nested) => {
  if (!names.has('package.json')) return null;
  const pkg = readPackageJson(dir);
  if (!dependsOnElectron(pkg) || isElectronPlatform(dir)) return null;
  if (nested && !looksLikeElectronApp(pkg, names)) return null;
  const app = describeElectronApp(dir, '', false);
  return { framework: 'electron', name: electronProductName(app), idName: app.name, apps: [electronApp(app)], claims: [] };
};

const flutter: Detector = async (dir, names) => {
  if (!names.has('pubspec.yaml')) return null;
  const pubspec = readText(path.join(dir, 'pubspec.yaml')) ?? '';
  if (!/^\s*sdk:\s*flutter\b/m.test(pubspec) && !/^flutter\s*:/m.test(pubspec)) return null;
  const name = pubspec.match(/^name:\s*["']?([^"'\s#]+)/m)?.[1] ?? path.basename(dir);
  const apps: ProjectApp[] = [];
  if (names.has('ios')) apps.push(recognised('ios', 'ios', 'flutter', name, 'ios', ['pubspec.yaml', 'ios/Runner.xcodeproj'], null, await iconInAssets(path.join(dir, 'ios', 'Runner', 'Assets.xcassets'))));
  if (names.has('macos')) apps.push(recognised('macos', 'mac', 'flutter', name, 'macos', ['pubspec.yaml', 'macos/Runner.xcodeproj'], null, await iconInAssets(path.join(dir, 'macos', 'Runner', 'Assets.xcassets'))));
  return { framework: 'flutter', name, idName: name, apps, claims: ['ios', 'macos', 'android', 'web', 'windows', 'linux', 'build'] };
};

const reactNative: Detector = (dir, names) => {
  if (!names.has('package.json')) return null;
  const pkg = readPackageJson(dir);
  const deps = allDependencies(pkg);
  if (!deps['react-native'] && !deps.expo) return null;
  const expo = Boolean(deps.expo);
  const appJson = readJson(path.join(dir, 'app.json'));
  const name = appJson?.expo?.name ?? appJson?.displayName ?? appJson?.name ?? pkg?.name ?? path.basename(dir);
  const framework: AppFramework = expo ? 'expo' : 'react-native';
  const version = deps['react-native'] ?? deps.expo ?? null;
  const apps: ProjectApp[] = [];
  // An Expo app without an ios folder makes one when it is built (prebuild).
  if (names.has('ios') || expo) apps.push(recognised('ios', 'ios', framework, name, names.has('ios') ? 'ios' : '', ['package.json', names.has('ios') ? 'ios' : 'app.json'], version));
  if (names.has('macos')) apps.push(recognised('macos', 'mac', framework, name, 'macos', ['package.json', 'macos'], version));
  return { framework, name, idName: name, apps, claims: ['ios', 'macos', 'android', 'windows'] };
};

const tauri: Detector = (dir, names) => {
  const inSrc = names.has('src-tauri');
  const confDir = inSrc ? path.join(dir, 'src-tauri') : dir;
  // The src-tauri folder itself belongs to the project above it.
  if (!inSrc && path.basename(dir) === 'src-tauri') return null;
  const confFile = ['tauri.conf.json', 'tauri.conf.json5', 'Tauri.toml'].find((file) => existsSync(path.join(confDir, file)));
  if (!confFile) return null;
  const conf = confFile === 'tauri.conf.json' ? readJson(path.join(confDir, confFile)) : null;
  const pkg = readPackageJson(dir);
  const name = conf?.productName ?? conf?.package?.productName ?? pkg?.productName ?? pkg?.name ?? path.basename(dir);
  const rel = inSrc ? 'src-tauri' : '';
  const evidence = [rel ? `${rel}/${confFile}` : confFile];
  const version = allDependencies(pkg)['@tauri-apps/cli'] ?? allDependencies(pkg)['@tauri-apps/api'] ?? null;
  const apps = [recognised('macos', 'mac', 'tauri', name, rel, evidence, version)];
  if (existsSync(path.join(confDir, 'gen', 'apple'))) apps.unshift(recognised('ios', 'ios', 'tauri', name, rel ? `${rel}/gen/apple` : 'gen/apple', [...evidence, `${rel ? `${rel}/` : ''}gen/apple`], version));
  return { framework: 'tauri', name, idName: name, apps, claims: ['src-tauri'] };
};

const nativescript: Detector = (dir, names) => {
  const configFile = ['nativescript.config.ts', 'nativescript.config.js'].find((file) => names.has(file));
  if (!configFile) return null;
  const pkg = readPackageJson(dir);
  const name = pkg?.productName ?? pkg?.name ?? path.basename(dir);
  const version = allDependencies(pkg)['@nativescript/ios'] ?? allDependencies(pkg)['@nativescript/core'] ?? null;
  return { framework: 'nativescript', name, idName: name, apps: [recognised('ios', 'ios', 'nativescript', name, '', [configFile], version)], claims: ['platforms', 'App_Resources', 'hooks'] };
};

const cordova: Detector = (dir, names) => {
  if (!names.has('config.xml')) return null;
  const xml = readText(path.join(dir, 'config.xml')) ?? '';
  const deps = allDependencies(readPackageJson(dir));
  if (!/<widget\b/.test(xml) || !(deps.cordova || deps['cordova-ios'] || deps['cordova-osx'] || /cordova/i.test(xml))) return null;
  const name = xml.match(/<name>([^<]+)<\/name>/)?.[1]?.trim() ?? path.basename(dir);
  const apps: ProjectApp[] = [];
  if (deps['cordova-ios'] || existsSync(path.join(dir, 'platforms', 'ios'))) apps.push(recognised('ios', 'ios', 'cordova', name, existsSync(path.join(dir, 'platforms', 'ios')) ? 'platforms/ios' : '', ['config.xml'], deps['cordova-ios'] ?? null));
  if (deps['cordova-osx'] || existsSync(path.join(dir, 'platforms', 'osx'))) apps.push(recognised('macos', 'mac', 'cordova', name, existsSync(path.join(dir, 'platforms', 'osx')) ? 'platforms/osx' : '', ['config.xml'], deps['cordova-osx'] ?? null));
  return { framework: 'cordova', name, idName: name, apps, claims: ['platforms', 'plugins', 'www'] };
};

const maui: Detector = (dir, names) => {
  for (const file of names) {
    if (!file.endsWith('.csproj')) continue;
    const csproj = readText(path.join(dir, file)) ?? '';
    const frameworks = csproj.match(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/g)?.join(';') ?? '';
    if (!/<UseMaui>\s*true\s*<\/UseMaui>/i.test(csproj) && !/net\d+(?:\.\d+)?-(?:ios|maccatalyst)/i.test(frameworks)) continue;
    const name = csproj.match(/<ApplicationTitle>([^<]+)<\/ApplicationTitle>/)?.[1]?.trim() ?? file.replace(/\.csproj$/, '');
    const apps: ProjectApp[] = [];
    if (/-ios/i.test(frameworks)) apps.push(recognised('ios', 'ios', 'maui', name, '', [file]));
    if (/-maccatalyst/i.test(frameworks)) apps.push(recognised('macos', 'mac', 'maui', name, '', [file]));
    return { framework: 'maui', name, idName: name, apps, claims: ['Platforms', 'bin', 'obj'] };
  }
  return null;
};

/** The platforms an Xcode project's app targets build for (none for a library or a plugin). */
function xcodeApps(pbxproj: string): AppPlatform[] {
  if (!pbxproj.includes('com.apple.product-type.application')) return [];
  const platforms = new Set<AppPlatform>();
  for (const [, sdk] of pbxproj.matchAll(/\bSDKROOT = "?(\w+)"?;/g)) {
    if (sdk === 'iphoneos') platforms.add('ios');
    if (sdk === 'macosx') platforms.add('mac');
  }
  for (const [, list] of pbxproj.matchAll(/\bSUPPORTED_PLATFORMS = "([^"]+)";/g)) {
    if (/\biphoneos\b/.test(list!)) platforms.add('ios');
    if (/\bmacosx\b/.test(list!)) platforms.add('mac');
  }
  return [...platforms];
}

/** An app made in Xcode (or a Swift package built with xtool): asked last, when no framework claimed the folder. */
const xcode: Detector = (dir, names) => {
  if (names.has('xtool.yml') && names.has('Package.swift')) {
    const name = readText(path.join(dir, 'Package.swift'))?.match(/\bname:\s*"([^"]+)"/)?.[1] ?? path.basename(dir);
    return { framework: 'xcode', name, idName: name, apps: [recognised('ios', 'ios', 'xcode', name, '', ['xtool.yml', 'Package.swift'])], claims: [] };
  }
  const projects = [...names].filter((file) => file.endsWith('.xcodeproj')).sort();
  for (const project of projects) {
    const platforms = xcodeApps(readText(path.join(dir, project, 'project.pbxproj')) ?? '');
    if (!platforms.length) continue;
    const name = project.replace(/\.xcodeproj$/, '');
    const workspace = names.has(`${name}.xcworkspace`) ? `${name}.xcworkspace` : project;
    const apps = platforms.map((platform) => recognised(platform === 'ios' ? 'ios' : 'macos', platform, 'xcode', name, '', [workspace]));
    return { framework: 'xcode', name, idName: name, apps, claims: [] };
  }
  return null;
};

/** In order: the first that answers owns the folder. Xcode last, so a framework's own Xcode project stays the framework's. */
const DETECTORS: Detector[] = [capacitor, tauri, flutter, reactNative, nativescript, cordova, maui, electron, xcode];

async function detectIn(dir: string, names: Set<string>, nested: boolean): Promise<Found | null> {
  for (const detect of DETECTORS) {
    try {
      const found = await detect(dir, names, nested);
      if (found) return found;
    } catch {
      // A file that cannot be read is not a reason to stop looking.
    }
  }
  return null;
}

// ─── Finding them ──────────────────────────────────────────────────────────

/** Folders never searched: dependencies, build output, version control, platform folders CapMac does not build. */
const SKIP = new Set(['node_modules', 'bower_components', 'Pods', 'DerivedData', 'Carthage', 'dist', 'build', 'out', 'www', 'release', 'coverage', 'tmp', 'temp', 'target', 'bin', 'obj', 'vendor', 'android', 'platforms', '__pycache__', 'venv']);
const skipFolder = (name: string) => name.startsWith('.') || SKIP.has(name);

async function entriesOf(dir: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** Whether `inner` is in one of the folders a project's apps claim. */
function claimed(projectDir: string, claims: string[], inner: string): boolean {
  const rel = toPosixRel(projectDir, inner);
  return rel !== '' && !rel.startsWith('..') && claims.includes(rel.split('/')[0]!);
}

/**
 * The project `start` is in: that folder, or the nearest one above it, up to
 * the repository's root. An Xcode project found first may be a framework's
 * own (ios/App/App.xcodeproj is Capacitor's): look a few folders further up
 * for the framework.
 */
async function projectAround(start: string): Promise<{ dir: string; found: Found } | null> {
  let xcodeMatch: { dir: string; found: Found; level: number } | null = null;
  let dir = start;
  for (let level = 0; ; level += 1) {
    const entries = await entriesOf(dir);
    const names = new Set(entries?.map((entry) => entry.name) ?? []);
    // A folder above the one picked is held to the same bar as one below it (a stray package.json in the home folder is no app).
    const found = entries ? await detectIn(dir, names, level > 0) : null;
    if (found && found.framework !== 'xcode') {
      if (!xcodeMatch || claimed(dir, found.claims, xcodeMatch.dir)) return { dir, found };
      return xcodeMatch;
    }
    if (found && !xcodeMatch) xcodeMatch = { dir, found, level };
    if (xcodeMatch && level - xcodeMatch.level >= 3) return xcodeMatch;
    const parent = path.dirname(dir);
    // A project does not reach past its repository.
    if (parent === dir || names.has('.git')) return xcodeMatch;
    dir = parent;
  }
}

const MAX_FOLDERS = 800;

/** Projects in the folders below `root` (not inside the apps of a project found there), nearest first. */
async function projectsBelow(root: string, rootClaims: string[], depth: number, limit: number, maxFolders = MAX_FOLDERS): Promise<{ found: Array<{ dir: string; found: Found }>; truncated: boolean }> {
  const found: Array<{ dir: string; found: Found }> = [];
  const queue: Array<{ dir: string; level: number }> = [{ dir: root, level: 0 }];
  let folders = 0;
  while (queue.length) {
    const { dir, level } = queue.shift()!;
    if (++folders > maxFolders) return { found, truncated: true };
    const entries = await entriesOf(dir);
    if (!entries) continue;
    if (level > 0) {
      const here = await detectIn(dir, new Set(entries.map((entry) => entry.name)), true);
      if (here) {
        found.push({ dir, found: here });
        if (found.length >= limit) return { found, truncated: queue.length > 0 };
        // A project's own folders are its apps: nothing else to find in it.
        continue;
      }
    }
    if (level >= depth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || skipFolder(entry.name) || (level === 0 && rootClaims.includes(entry.name))) continue;
      queue.push({ dir: path.join(dir, entry.name), level: level + 1 });
    }
  }
  return { found, truncated: false };
}

async function chosenFor(dir: string, found: Found): Promise<RunnableApp | null> {
  if (!found.apps.some(canRun)) return null;
  // What loadProject will read (it saves it under the new id; finding apps only reads).
  const app = (await projectMemory(projectIdFor(found.idName, dir), dir, [found.idName])).app;
  return isRunnableApp(app) && found.apps.some((a) => a.id === app && canRun(a)) ? app : null;
}

/**
 * Whether `dir` is the only project synced from `syncRoot` that had `oldId`,
 * an id made from that folder the way they were before (see projectMemory):
 * apps with one name in one monorepo shared theirs. False when there are too
 * many folders to tell.
 */
export async function onlyProjectWithId(oldId: string, syncRoot: string, dir: string): Promise<boolean> {
  const entries = await entriesOf(syncRoot);
  const atRoot = entries ? await detectIn(syncRoot, new Set(entries.map((entry) => entry.name)), false) : null;
  const below = await projectsBelow(syncRoot, atRoot?.claims ?? [], Infinity, Infinity, 5000);
  if (below.truncated) return false;
  const projects = [...(atRoot ? [{ dir: syncRoot, found: atRoot }] : []), ...below.found];
  // Folders compare as ids do: without case.
  const self = path.resolve(dir).toLowerCase();
  return !projects.some(
    (p) => (p.found.framework === 'capacitor' || p.found.framework === 'electron') && path.resolve(p.dir).toLowerCase() !== self && projectIdFor(p.found.idName, syncRoot) === oldId,
  );
}

/**
 * Every app in `start`: those of the project it is in (that folder, or one
 * above it when `start` is an app's own folder like electron/ or ios/App),
 * and those of the projects below it (a monorepo, or apps kept in their own
 * folder next to the project's). Only reads files.
 */
export async function findApps(start: string, options: { depth?: number; limit?: number } = {}): Promise<AppSearch> {
  const from = path.resolve(start);
  const around = await projectAround(from);
  const root = around?.dir ?? from;
  const below = await projectsBelow(root, around?.found.claims ?? [], options.depth ?? 3, options.limit ?? 24);
  const all = [...(around ? [around] : []), ...below.found];
  const projects: DetectedProject[] = await Promise.all(
    all.map(async ({ dir, found }) => ({ dir, rel: toPosixRel(from, dir), name: found.name, framework: found.framework, apps: found.apps, chosen: await chosenFor(dir, found) })),
  );
  return { start: from, projects, suggested: suggest(from, projects), truncated: below.truncated };
}

/** The app CapMac works on in a project findApps found: appFor's rule, without loading the project. Null when it runs none of its apps. */
export function currentApp(project: DetectedProject): RunnableApp | null {
  const has = (id: string) => project.apps.some((a) => a.id === id && canRun(a));
  if (!has('ios') && !has('electron')) return null;
  if (project.framework === 'electron') return 'electron';
  if (project.chosen === 'ios' || (project.chosen === 'electron' && has('electron'))) return project.chosen;
  const iosReady = project.apps.some((a) => a.id === 'ios' && a.status === 'ready');
  return has('electron') && !iosReady ? 'electron' : 'ios';
}

/** The app whose folder `start` is in, else the one picked before, else the first that is ready, else the first CapMac could run. */
function suggest(start: string, projects: DetectedProject[]): AppSearch['suggested'] {
  const first = projects[0];
  if (first && first.dir !== start && !path.relative(first.dir, start).startsWith('..')) {
    const inside = toPosixRel(first.dir, start);
    const app = first.apps.find((a) => canRun(a) && a.rel && (inside === a.rel || inside.startsWith(`${a.rel}/`) || a.rel.startsWith(`${inside}/`)));
    if (app) return { dir: first.dir, app: app.id };
  }
  for (const project of projects) if (project.chosen) return { dir: project.dir, app: project.chosen };
  for (const status of ['ready', 'setup'] as const) {
    for (const project of projects) {
      const app = project.apps.find((a) => a.status === status);
      if (app) return { dir: project.dir, app: app.id };
    }
  }
  return null;
}

const FRAMEWORK_NAMES: Record<AppFramework, string> = {
  capacitor: 'Capacitor',
  electron: 'Electron',
  flutter: 'Flutter',
  'react-native': 'React Native',
  expo: 'Expo',
  tauri: 'Tauri',
  maui: '.NET MAUI',
  cordova: 'Cordova',
  nativescript: 'NativeScript',
  xcode: 'Xcode',
};

/** The framework's name for people ("React Native"). */
export const frameworkName = (framework: AppFramework) => FRAMEWORK_NAMES[framework];

/**
 * Why a search found nothing CapMac runs, for an error: what it did find
 * ("a Flutter app") or that there was nothing at all.
 */
export function nothingToRun(search: AppSearch): ProjectError {
  const others = [...new Set(search.projects.map((p) => frameworkName(p.framework)))];
  if (others.length === 1) {
    const name = others[0]!;
    return new ProjectError(`CapMac found ${/^[aeiox]/i.test(name) ? 'an' : 'a'} ${name} app here, but it can't run ${name} apps yet.`, 'It runs Capacitor, Ionic and Electron apps today.');
  }
  if (others.length > 1) {
    return new ProjectError(`CapMac found ${others.slice(0, -1).join(', ')} and ${others.at(-1)} apps here, but it can't run those yet.`, 'It runs Capacitor, Ionic and Electron apps today.');
  }
  return new ProjectError(
    'No Capacitor or Electron app found here (no capacitor.config.*, or package.json that depends on electron, in this folder, the ones above it or the ones inside it).',
    'Pick your app’s folder: the one with capacitor.config.ts, or your Electron app’s package.json.',
  );
}
