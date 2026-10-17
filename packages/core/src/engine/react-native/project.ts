/**
 * A React Native project, as CapMac sees it: read from its files only (no
 * Node, CocoaPods or Xcode needed). One project holds several apps, one per
 * platform folder: ios/ (iPhone and iPad), macos/ (react-native-macos, on the
 * Mac's desktop) and windows/ (react-native-windows, on this PC). An Expo app
 * without an ios/ folder gets one from `expo prebuild` when it is first built.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { allDependencies, readPackageJson } from '../electron-project.js';

/** The React Native platforms CapMac runs. */
export type ReactNativePlatform = 'ios' | 'macos' | 'windows';
export const REACT_NATIVE_PLATFORMS: readonly ReactNativePlatform[] = ['ios', 'macos', 'windows'];

export interface ReactNativeAppleApp {
  /** The app's folder in the project ('ios' or 'macos'). */
  dir: string;
  /** The Xcode project's name ("HelloReactNative.xcodeproj"), null when an Expo app has not made it yet. */
  xcodeproj: string | null;
  /** The workspace `pod install` makes next to it ("HelloReactNative.xcworkspace"). */
  workspace: string | null;
  /** The scheme that builds and runs the app. */
  scheme: string;
  bundleId: string | null;
  /** As on the Home Screen or in the Dock. */
  displayName: string | null;
  /** The app's native libraries come through CocoaPods (React Native's default). */
  pods: boolean;
}

export interface ReactNativeWindowsApp {
  /** The Visual Studio solution, from windows/ ("HelloReactNative.sln"). */
  solution: string;
  /** The app's name (its project and its .exe). */
  name: string;
}

export interface ReactNativeProject {
  /** The name the app registers its root component under (app.json `name`), and its project's name. */
  name: string;
  /** The name people see. */
  displayName: string;
  /** An Expo app (expo is a dependency). */
  expo: boolean;
  /** Which apps the project has (or, for an Expo app, can make). */
  platforms: Record<ReactNativePlatform, boolean>;
  /** An Expo app whose ios/ folder `expo prebuild` makes on the first build. */
  prebuild: boolean;
  ios: ReactNativeAppleApp | null;
  macos: ReactNativeAppleApp | null;
  windows: ReactNativeWindowsApp | null;
  /** The versions the project asks for, for display. */
  versions: { reactNative: string | null; macos: string | null; windows: string | null; expo: string | null };
  /** capmac.json `reactNative` section. */
  options: ReactNativeOptions;
}

/** capmac.json `reactNative` section. */
export interface ReactNativeOptions {
  /** Metro's port on this PC (default 8081, or the next free one). */
  port?: number;
  /** Extra arguments for Metro (`react-native start`, or `expo start`). */
  metroArgs?: string[];
  /** Environment for `pod install` on the Mac and in WSL (RCT_NEW_ARCH_ENABLED, USE_FRAMEWORKS…). */
  podEnv?: Record<string, string>;
  /** The Mac app's scheme, when it is not the one CapMac finds. */
  macosScheme?: string;
  /** The Windows app's build: x64 (default) or ARM64. */
  windowsArch?: 'x64' | 'ARM64';
}

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

/** Whether a package.json belongs to a React Native app: it depends on react-native (or expo, or react-native-macos/windows on their own). */
export function dependsOnReactNative(pkg: any): boolean {
  const deps = allDependencies(pkg);
  return Boolean(deps['react-native'] || deps.expo || deps['react-native-macos'] || deps['react-native-windows']);
}

/**
 * Whether `dir` holds a React Native app: a package.json that depends on it,
 * and an app to run (a platform folder, or an Expo app's config). A library
 * that only tests against React Native has neither.
 */
export function isReactNativeProjectDir(dir: string): boolean {
  const pkg = readPackageJson(dir);
  if (!dependsOnReactNative(pkg)) return false;
  if (allDependencies(pkg).expo) return true;
  return ['ios', 'macos', 'windows'].some((folder) => existsSync(path.join(dir, folder))) || existsSync(path.join(dir, 'app.json'));
}

/** The values an Xcode project's settings give `key`, from project.pbxproj (without running Xcode). */
function pbxprojValues(pbxproj: string, key: string): string[] {
  const values: string[] = [];
  for (const match of pbxproj.matchAll(new RegExp(`\\b${key} = ("?)([^";\\n]+)\\1;`, 'g'))) values.push(match[2]!.trim());
  return values;
}

function plistString(plist: string, key: string): string | null {
  const value = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1]?.trim();
  return value && !value.includes('$(') ? value : null;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The app's Xcode project in its folder: the one with an app target, preferring the one named like the app. */
function appProject(platformDir: string, name: string): { file: string; pbxproj: string } | null {
  const projects = listDir(platformDir).filter((entry) => entry.endsWith('.xcodeproj')).sort((a, b) => (a === `${name}.xcodeproj` ? -1 : b === `${name}.xcodeproj` ? 1 : a.localeCompare(b)));
  for (const file of projects) {
    const pbxproj = readText(path.join(platformDir, file, 'project.pbxproj'));
    if (pbxproj?.includes('com.apple.product-type.application')) return { file, pbxproj };
  }
  return null;
}

/**
 * The names of a project's app targets. Xcode writes each target's keys in
 * order, productType last, so a target is everything up to its productType.
 */
export function appTargets(pbxproj: string): string[] {
  const names: string[] = [];
  for (const match of pbxproj.matchAll(/isa = PBXNativeTarget;([\s\S]*?)productType = "?([^";\n]+)"?;/g)) {
    if (match[2] !== 'com.apple.product-type.application') continue;
    const name = /\bname = ("?)([^";\n]+)\1;/.exec(match[1]!)?.[2]?.trim();
    if (name) names.push(name);
  }
  return names;
}

/** The scheme that runs the app: a shared scheme named like a target, else the first shared app scheme, else the project's name (Xcode's own scheme). */
function appScheme(platformDir: string, xcodeproj: string, pbxproj: string, platform: 'ios' | 'macos'): string {
  const base = xcodeproj.replace(/\.xcodeproj$/, '');
  const shared = listDir(path.join(platformDir, xcodeproj, 'xcshareddata', 'xcschemes'))
    .filter((file) => file.endsWith('.xcscheme'))
    .map((file) => file.replace(/\.xcscheme$/, ''))
    .filter((scheme) => !/Tests?$/i.test(scheme));
  const targets = appTargets(pbxproj);
  const preferred = platform === 'macos' ? [`${base}-macOS`, base] : [base, `${base}-iOS`];
  for (const scheme of preferred) if (shared.includes(scheme)) return scheme;
  const named = shared.find((scheme) => targets.includes(scheme));
  if (named) return named;
  if (shared.length) return shared[0]!;
  return targets.find((t) => preferred.includes(t)) ?? targets[0] ?? base;
}

/** The app target's bundle id: the first that is not a test target's, without Xcode variables. */
function appBundleId(pbxproj: string): string | null {
  return pbxprojValues(pbxproj, 'PRODUCT_BUNDLE_IDENTIFIER').find((id) => !/Tests?$/i.test(id) && !id.includes('$(')) ?? null;
}

function appleApp(dir: string, platform: 'ios' | 'macos', name: string): ReactNativeAppleApp | null {
  const platformDir = path.join(dir, platform);
  if (!existsSync(platformDir)) return null;
  const project = appProject(platformDir, name);
  if (!project) return null;
  const scheme = appScheme(platformDir, project.file, project.pbxproj, platform);
  // The Info.plist the app target names (ios/<Name>/Info.plist, macos/<Name>-macOS/Info.plist).
  const infoRel = pbxprojValues(project.pbxproj, 'INFOPLIST_FILE').find((file) => !/Tests?/i.test(file) && !file.includes('$('));
  const plist = infoRel ? readText(path.join(platformDir, infoRel)) ?? '' : '';
  return {
    dir: platform,
    xcodeproj: project.file,
    workspace: project.file.replace(/\.xcodeproj$/, '.xcworkspace'),
    scheme,
    bundleId: appBundleId(project.pbxproj),
    displayName: plistString(plist, 'CFBundleDisplayName') ?? plistString(plist, 'CFBundleName'),
    pods: existsSync(path.join(platformDir, 'Podfile')),
  };
}

function windowsApp(dir: string, pkg: any): ReactNativeWindowsApp | null {
  const windowsDir = path.join(dir, 'windows');
  const solution = listDir(windowsDir).filter((file) => file.endsWith('.sln')).sort()[0];
  if (!solution) return null;
  const configured = pkg?.['react-native-windows']?.['init-windows']?.name;
  return { solution, name: typeof configured === 'string' && configured ? configured : solution.replace(/\.sln$/, '') };
}

function readOptions(dir: string): ReactNativeOptions {
  const section = readJson(path.join(dir, 'capmac.json'))?.reactNative;
  if (!section || typeof section !== 'object') return {};
  const options: ReactNativeOptions = {};
  if (Number.isInteger(section.port) && section.port > 0 && section.port < 65536) options.port = section.port;
  if (Array.isArray(section.metroArgs)) options.metroArgs = section.metroArgs.map(String);
  if (section.podEnv && typeof section.podEnv === 'object') options.podEnv = Object.fromEntries(Object.entries(section.podEnv).map(([key, value]) => [key, String(value)]));
  if (typeof section.macosScheme === 'string') options.macosScheme = section.macosScheme;
  if (section.windowsArch === 'x64' || section.windowsArch === 'ARM64') options.windowsArch = section.windowsArch;
  return options;
}

/** Everything CapMac needs to know about the React Native app in `dir`; null when it is not one. */
export function describeReactNativeProject(dir: string): ReactNativeProject | null {
  if (!isReactNativeProjectDir(dir)) return null;
  const pkg = readPackageJson(dir) ?? {};
  const deps = allDependencies(pkg);
  const appJson = readJson(path.join(dir, 'app.json')) ?? {};
  const expo = Boolean(deps.expo);
  const expoConfig = appJson.expo ?? (expo ? appJson : null);
  // The registered component's name: app.json `name` (React Native CLI apps), else the package's.
  const name = (typeof appJson.name === 'string' && appJson.name) || (typeof expoConfig?.name === 'string' && expoConfig.name) || pkg.name || path.basename(dir);
  const ios = appleApp(dir, 'ios', name);
  const options = readOptions(dir);
  const macos = appleApp(dir, 'macos', name);
  if (macos && options.macosScheme) macos.scheme = options.macosScheme;
  const windows = windowsApp(dir, pkg);
  const prebuild = expo && !ios;
  const displayName = ios?.displayName ?? (typeof appJson.displayName === 'string' && appJson.displayName) ?? (typeof expoConfig?.name === 'string' && expoConfig.name) ?? macos?.displayName ?? name;
  return {
    name,
    displayName: displayName || name,
    expo,
    platforms: { ios: Boolean(ios) || prebuild, macos: Boolean(macos), windows: Boolean(windows) },
    prebuild,
    ios: ios ?? (prebuild ? { dir: 'ios', xcodeproj: null, workspace: null, scheme: name.replace(/[^A-Za-z0-9]/g, '') || 'App', bundleId: expoConfig?.ios?.bundleIdentifier ?? null, displayName: expoConfig?.name ?? null, pods: true } : null),
    macos,
    windows,
    versions: { reactNative: deps['react-native'] ?? null, macos: deps['react-native-macos'] ?? null, windows: deps['react-native-windows'] ?? null, expo: deps.expo ?? null },
    options,
  };
}

/** The app's icon: the largest PNG in its asset catalog's app icon set. */
export function reactNativeIconDirs(dir: string, project: ReactNativeProject): Array<{ platform: 'ios' | 'macos'; assets: string }> {
  const found: Array<{ platform: 'ios' | 'macos'; assets: string }> = [];
  for (const app of [project.ios, project.macos]) {
    if (!app?.xcodeproj) continue;
    const platformDir = path.join(dir, app.dir);
    for (const folder of listDir(platformDir)) {
      const assets = ['Images.xcassets', 'Assets.xcassets'].map((name) => path.join(platformDir, folder, name)).find((candidate) => existsSync(candidate));
      if (assets) {
        found.push({ platform: app.dir as 'ios' | 'macos', assets });
        break;
      }
    }
  }
  return found;
}
