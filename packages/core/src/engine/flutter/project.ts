/**
 * A Flutter project, as CapMac sees it: read from its files only (no Flutter
 * needed on this PC). One Flutter project holds several apps, one per
 * platform folder: ios/ (iPhone and iPad), macos/ (the Mac's desktop) and
 * windows/ (this PC's desktop). CapMac runs each of them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isFlutterApp, readPubspec, type Pubspec } from './pubspec.js';

/** The Flutter platforms CapMac runs. */
export type FlutterPlatform = 'ios' | 'macos' | 'windows';
export const FLUTTER_PLATFORMS: readonly FlutterPlatform[] = ['ios', 'macos', 'windows'];

/** How an Apple app's plugins are built: Swift packages (Flutter's default since 3.27), CocoaPods, or both. */
export type FlutterPluginManager = 'SPM' | 'CocoaPods' | 'SPM+CocoaPods';

export interface FlutterAppleApp {
  /** PRODUCT_BUNDLE_IDENTIFIER of the Runner target (the first one, without flavors). */
  bundleId: string | null;
  /** CFBundleDisplayName (iOS) or PRODUCT_NAME (macOS), as on the Home Screen or in the Dock. */
  displayName: string | null;
  plugins: FlutterPluginManager;
  /** Schemes other than Runner: Flutter flavors. */
  flavors: string[];
}

export interface FlutterProject {
  /** The Dart package's name (pubspec.yaml `name`). */
  name: string;
  /** Which platform folders the project has (and so which apps). */
  platforms: Record<FlutterPlatform, boolean>;
  ios: FlutterAppleApp | null;
  macos: FlutterAppleApp | null;
  /** windows/CMakeLists.txt BINARY_NAME (the .exe's name). */
  windowsBinary: string | null;
  /** The Flutter version the project pins (FVM's .fvmrc), else its pubspec constraint, else null. */
  wantsFlutter: { exact: string | null; constraint: string | null };
  /** The Dart file the app starts from (capmac.json flutter.target, else lib/main.dart). */
  target: string;
  /** capmac.json `flutter` section. */
  options: FlutterOptions;
  /** "1.0.0+1" from pubspec.yaml. */
  version: string | null;
  /** Other folders the project builds from (pubspec `path:` dependencies), absolute. */
  pathDependencies: string[];
  pubspec: Pubspec;
}

/** capmac.json `flutter` section: what `flutter run` and `flutter build` get. */
export interface FlutterOptions {
  /** The Dart entry point (default lib/main.dart). */
  target?: string;
  /** A Flutter flavor (an Xcode scheme on Apple platforms). */
  flavor?: string;
  /** --dart-define values. */
  dartDefines?: Record<string, string>;
  /** A --dart-define-from-file file, relative to the project. */
  dartDefineFile?: string;
  /** The Flutter version to use on the Mac and on this PC ("3.47.7", or "stable"). */
  version?: string;
  /** Extra arguments for `flutter run` / `flutter build`. */
  args?: string[];
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The pubspec in `dir` when it is a Flutter app's, else null. */
export function flutterPubspecIn(dir: string): Pubspec | null {
  const text = readText(path.join(dir, 'pubspec.yaml'));
  if (text === null) return null;
  try {
    const pubspec = readPubspec(text);
    return isFlutterApp(pubspec) ? pubspec : null;
  } catch {
    return null;
  }
}

/** Whether `dir` holds a Flutter app (pubspec.yaml that depends on the Flutter SDK). */
export const isFlutterProjectDir = (dir: string): boolean => flutterPubspecIn(dir) !== null;

/** The settings of an Xcode project's app target, from project.pbxproj (without running Xcode). */
function pbxprojValues(pbxproj: string, key: string): string[] {
  const values: string[] = [];
  for (const match of pbxproj.matchAll(new RegExp(`\\b${key} = ("?)([^";\\n]+)\\1;`, 'g'))) values.push(match[2]!.trim());
  return values;
}

/** The Runner target's bundle id: the first one that is not a test target's. */
function runnerBundleId(pbxproj: string): string | null {
  return pbxprojValues(pbxproj, 'PRODUCT_BUNDLE_IDENTIFIER').find((id) => !/Tests?$/i.test(id) && !id.includes('$(')) ?? null;
}

function plistString(plist: string, key: string): string | null {
  const value = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1]?.trim();
  return value && !value.includes('$(') ? value : null;
}

function schemes(projectDir: string): string[] {
  try {
    return readdirSync(path.join(projectDir, 'Runner.xcodeproj', 'xcshareddata', 'xcschemes'))
      .filter((name) => name.endsWith('.xcscheme'))
      .map((name) => name.replace(/\.xcscheme$/, ''))
      .filter((name) => name !== 'Runner');
  } catch {
    return [];
  }
}

/** Plugins build with Swift packages when the project links Flutter's generated package; CocoaPods when it has a Podfile. */
function pluginManager(platformDir: string, pbxproj: string): FlutterPluginManager {
  const spm = pbxproj.includes('FlutterGeneratedPluginSwiftPackage');
  const pods = existsSync(path.join(platformDir, 'Podfile'));
  if (spm && pods) return 'SPM+CocoaPods';
  if (pods) return 'CocoaPods';
  return 'SPM';
}

function appleApp(dir: string, platform: 'ios' | 'macos'): FlutterAppleApp | null {
  const platformDir = path.join(dir, platform);
  const pbxproj = readText(path.join(platformDir, 'Runner.xcodeproj', 'project.pbxproj'));
  if (pbxproj === null) return null;
  if (platform === 'ios') {
    const plist = readText(path.join(platformDir, 'Runner', 'Info.plist')) ?? '';
    return {
      bundleId: runnerBundleId(pbxproj),
      displayName: plistString(plist, 'CFBundleDisplayName') ?? plistString(plist, 'CFBundleName'),
      plugins: pluginManager(platformDir, pbxproj),
      flavors: schemes(platformDir),
    };
  }
  // A Mac app's name and id live in Runner/Configs/AppInfo.xcconfig.
  const appInfo = readText(path.join(platformDir, 'Runner', 'Configs', 'AppInfo.xcconfig')) ?? '';
  const setting = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(appInfo)?.[1] ?? null;
  return {
    bundleId: setting('PRODUCT_BUNDLE_IDENTIFIER') ?? runnerBundleId(pbxproj),
    displayName: setting('PRODUCT_NAME'),
    plugins: pluginManager(platformDir, pbxproj),
    flavors: schemes(platformDir),
  };
}

function windowsBinary(dir: string): string | null {
  const cmake = readText(path.join(dir, 'windows', 'CMakeLists.txt'));
  return cmake?.match(/set\s*\(\s*BINARY_NAME\s+"([^"]+)"/)?.[1] ?? null;
}

/** FVM's pinned version: .fvmrc ({"flutter": "3.47.7"}), or the older .fvm/fvm_config.json. */
function fvmVersion(dir: string): string | null {
  for (const file of [path.join(dir, '.fvmrc'), path.join(dir, '.fvm', 'fvm_config.json')]) {
    const text = readText(file);
    if (text === null) continue;
    try {
      const parsed = JSON.parse(text);
      const version = parsed.flutter ?? parsed.flutterSdkVersion;
      if (typeof version === 'string' && version.trim()) return version.trim();
    } catch {
      // not JSON
    }
  }
  return null;
}

function readOptions(dir: string): FlutterOptions {
  const text = readText(path.join(dir, 'capmac.json'));
  if (text === null) return {};
  try {
    const flutter = JSON.parse(text)?.flutter;
    if (!flutter || typeof flutter !== 'object') return {};
    const options: FlutterOptions = {};
    if (typeof flutter.target === 'string') options.target = flutter.target;
    if (typeof flutter.flavor === 'string') options.flavor = flutter.flavor;
    if (typeof flutter.version === 'string') options.version = flutter.version;
    if (typeof flutter.dartDefineFile === 'string') options.dartDefineFile = flutter.dartDefineFile;
    if (flutter.dartDefines && typeof flutter.dartDefines === 'object') {
      options.dartDefines = Object.fromEntries(Object.entries(flutter.dartDefines).map(([key, value]) => [key, String(value)]));
    }
    if (Array.isArray(flutter.args)) options.args = flutter.args.map(String);
    return options;
  } catch {
    return {};
  }
}

/** The folders of pubspec `path:` dependencies (and pubspec_overrides.yaml ones), absolute. */
function pathDependencies(dir: string, pubspec: Pubspec): string[] {
  const deps = [...Object.values(pubspec.dependencies), ...Object.values(pubspec.devDependencies), ...Object.values(pubspec.dependencyOverrides)];
  const overrides = readText(path.join(dir, 'pubspec_overrides.yaml'));
  if (overrides !== null) {
    try {
      deps.push(...Object.values(readPubspec(overrides).dependencyOverrides));
    } catch {
      // unreadable overrides: pub reports them
    }
  }
  const dirs = new Set<string>();
  for (const dep of deps) {
    if (!dep.path) continue;
    const abs = path.resolve(dir, dep.path);
    try {
      if (statSync(abs).isDirectory()) dirs.add(abs);
    } catch {
      // missing path: pub get reports it
    }
  }
  return [...dirs];
}

/** Everything CapMac needs to know about the Flutter app in `dir`; null when it is not one. */
export function describeFlutterProject(dir: string): FlutterProject | null {
  const pubspec = flutterPubspecIn(dir);
  if (!pubspec) return null;
  const options = readOptions(dir);
  const platforms = {
    ios: existsSync(path.join(dir, 'ios', 'Runner.xcodeproj')),
    macos: existsSync(path.join(dir, 'macos', 'Runner.xcodeproj')),
    windows: existsSync(path.join(dir, 'windows', 'CMakeLists.txt')),
  };
  return {
    name: pubspec.name ?? path.basename(dir),
    platforms,
    ios: platforms.ios ? appleApp(dir, 'ios') : null,
    macos: platforms.macos ? appleApp(dir, 'macos') : null,
    windowsBinary: platforms.windows ? windowsBinary(dir) : null,
    wantsFlutter: { exact: options.version ?? fvmVersion(dir), constraint: pubspec.environment.flutter ?? null },
    target: (options.target ?? 'lib/main.dart').replace(/\\/g, '/'),
    options,
    version: pubspec.version,
    pathDependencies: pathDependencies(dir, pubspec),
    pubspec,
  };
}

/** The name people see for a Flutter project's app: the iPhone app's display name, else the Mac app's, else the package name in words. */
export function flutterDisplayName(project: FlutterProject): string {
  const named = project.ios?.displayName ?? project.macos?.displayName;
  if (named) return named;
  return project.name.split('_').filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ') || project.name;
}

/** The folder pub reads the project from, and every `path:` dependency: the closest folder holding them all (never above the repository). */
export function flutterSyncRoot(dir: string, project: FlutterProject): string {
  let root = path.resolve(dir);
  const inside = (outer: string, inner: string) => {
    const rel = path.relative(outer, inner);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  // The repository's root bounds how far up the sync goes.
  let repo: string | null = null;
  for (let probe = root; ; probe = path.dirname(probe)) {
    if (existsSync(path.join(probe, '.git'))) {
      repo = probe;
      break;
    }
    if (path.dirname(probe) === probe) break;
  }
  for (const dep of project.pathDependencies) {
    while (!inside(root, dep)) {
      const parent = path.dirname(root);
      if (parent === root || (repo && !inside(repo, parent))) return root;
      root = parent;
    }
  }
  // A pub workspace member resolves from the workspace's root.
  if (project.pubspec.resolution === 'workspace') {
    for (let probe = path.dirname(root); repo ? inside(repo, probe) : path.dirname(probe) !== probe; probe = path.dirname(probe)) {
      const text = readText(path.join(probe, 'pubspec.yaml'));
      if (text !== null && readPubspec(text).workspace.length) return probe;
      if (path.dirname(probe) === probe) break;
    }
  }
  return root;
}
