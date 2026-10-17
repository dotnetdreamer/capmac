/**
 * React Native on the wire: the agent operations that build a React Native
 * app's iOS and Mac apps on the Mac, and what a changed file means for a
 * running app. Shared by the agent and the engine.
 */
import type { Target } from './protocol.js';

/** The React Native apps built on a Mac: the iOS app (simulators, iPhones) and the Mac app (react-native-macos). */
export type ReactNativeApplePlatform = 'ios' | 'macos';

/** `rn-prepare`: the app's JavaScript packages on the Mac, then CocoaPods for one of its Apple apps. */
export interface ReactNativePrepareParams {
  projectId: string;
  projectRel: string;
  platform: ReactNativeApplePlatform;
  /** The app's folder in the project: 'ios' or 'macos'. */
  dir: string;
  /** Install the packages and run `pod install` again, whatever changed. */
  full?: boolean;
  /** Extra environment for `pod install` (RCT_NEW_ARCH_ENABLED, USE_FRAMEWORKS…), from capmac.json. */
  podEnv?: Record<string, string>;
  /**
   * The project's Podfile.lock on the PC, when it has one. It is not synced
   * with the other files: CocoaPods rewrites it on the Mac (its own version
   * line), and a sync would bring the old one back each time.
   */
  podfileLock?: string;
}

export interface ReactNativePrepareResult {
  /** The packages were installed (npm ci / yarn / pnpm / bun). */
  installed: boolean;
  /** `pod install` ran. */
  pods: boolean;
  packageManager: string;
  /** Something the native build reads changed (a rebuild is needed). */
  nativeDirty: boolean;
}

/** `rn-build`: xcodebuild for a simulator, a device or the Mac. */
export interface ReactNativeBuildParams {
  projectId: string;
  projectRel: string;
  platform: ReactNativeApplePlatform;
  dir: string;
  /** The scheme to build (the app's, from its .xcscheme or its target). */
  scheme: string;
  configuration: string;
  /** A simulator or device for the iOS app; the Mac's desktop (kind 'mac') for the Mac app. */
  target: Target;
  team?: string;
  clean?: boolean;
  /** Build even when nothing native changed. */
  force?: boolean;
  extraArgs?: string[];
  verbose?: boolean;
}

export interface ReactNativeBuildResult {
  /** Nothing the build reads changed: the last build was reused. */
  skipped: boolean;
  appPath: string;
  bundleId: string;
  executable: string;
  displayName: string;
  warnings: number;
  logPath: string | null;
}

export const REACT_NATIVE_ERROR_CODES = {
  podsFailed: 'PODS_FAILED',
  noWorkspace: 'NO_WORKSPACE',
  buildFailed: 'BUILD_FAILED',
} as const;

/**
 * Launch arguments that point a debug build at CapMac's Metro, at `hostPort`
 * ("localhost:8081"). React Native reads RCT_jsLocation from the app's
 * settings, and the command line fills those (NSArgumentDomain): no change to
 * the app or its build is needed.
 */
export function metroLaunchArgs(hostPort: string): string[] {
  return ['-RCT_jsLocation', hostPort];
}

/**
 * The lines of React Native's notice (0.82+) that running `pod install`
 * yourself is deprecated: CapMac runs it as React Native's own commands do,
 * so the notice only confuses (trimmed lines).
 */
export const POD_INSTALL_NOTICE = /DEPRECATION NOTICE|Calling `pod install` directly is deprecated|because we are moving away from Cocoapods|solutions to build the project\.|If you are using (Expo|the Community CLI), please run:|^`(npx expo run:ios|yarn ios)`$|^=+$/;

/** What a saved file means for a React Native app. */
export type ReactNativeChange =
  /** JavaScript, TypeScript, JSON and assets: Metro brings them over (Fast Refresh). */
  | 'js'
  /** Metro's or Babel's settings: Metro starts again. */
  | 'metro'
  /** package.json and lockfiles: packages are installed again, then the native apps rebuild. */
  | 'deps'
  /** A Podfile (or its lock): CocoaPods runs again for that app. */
  | 'pods-ios'
  | 'pods-macos'
  /** An app's own native folder. */
  | 'ios'
  | 'macos'
  | 'windows'
  /** A local native module's code: every native app rebuilds. */
  | 'native'
  | 'ignore';

/** What package managers, CocoaPods, Xcode, Metro and the tools write themselves: never a reason to reload. */
const GENERATED = /(^|\/)(node_modules|Pods|build|DerivedData|\.git|\.capmac|xcuserdata|\.expo|\.expo-shared|vendor\/bundle|\.gradle|\.cxx|\.vs|\.yarn|\.metro-health-check[^/]*|coverage)(\/|$)|(^|\/)(\.xcode\.env\.local|ip\.txt|main\.jsbundle)$|\.(log|tmp|swp|binlog|user|xcuserstate)$|~$/;
/** What MSBuild and NuGet write in a Windows app's folder. */
const WINDOWS_GENERATED = /(^|\/)windows\/(.+\/)?(x64|x86|ARM64|ARM|Debug|Release|AppPackages|BundleArtifacts|Bundle|Generated Files|packages|obj|bin)(\/|$)/i;
const DEPENDENCY_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lockb', 'bun.lock', '.npmrc', '.yarnrc', '.yarnrc.yml', 'react-native.config.js', 'capmac.json']);
const METRO_FILES = /^(metro\.config\.[cm]?[jt]s|babel\.config\.[cm]?[jt]s|\.babelrc(\.js|\.json)?|\.watchmanconfig)$/;
/** Folders no app build or Metro reads. */
const UNUSED_TOP = new Set(['android', '__tests__', 'e2e', 'docs', 'doc', '.github', '.vscode', '.idea', 'fastlane']);
const NATIVE_SOURCE = /\.(swift|m|mm|h|hpp|c|cc|cpp|podspec|xcconfig|cs|vcxproj|xcframework)$/i;
const NATIVE_DIRS = new Set(['ios', 'macos', 'windows', 'apple']);

/** `rel`: POSIX path from the synced root; `projectRel`: the app from there ('' when it is the root). */
export function classifyReactNativeChange(rel: string, projectRel: string): ReactNativeChange {
  if (GENERATED.test(rel) || WINDOWS_GENERATED.test(rel)) return 'ignore';
  const inProject = projectRel === '' ? rel : rel.startsWith(`${projectRel}/`) ? rel.slice(projectRel.length + 1) : null;
  const parts = (inProject ?? rel).split('/');
  const base = parts.at(-1)!;
  if (DEPENDENCY_FILES.has(base)) return 'deps';
  if (inProject !== null) {
    if (UNUSED_TOP.has(parts[0]!)) return 'ignore';
    if (parts.length === 1 && METRO_FILES.test(base)) return 'metro';
    if (parts.length > 1 && (parts[0] === 'ios' || parts[0] === 'macos')) {
      // CocoaPods writes its settings into the Xcode project too: a project file from the PC needs them again.
      if (base === 'Podfile' || base === 'Podfile.lock' || base === 'Gemfile' || base === 'Gemfile.lock' || base === 'project.pbxproj') return parts[0] === 'ios' ? 'pods-ios' : 'pods-macos';
      return parts[0];
    }
    if (parts.length > 1 && parts[0] === 'windows') return 'windows';
  }
  if (base === 'Gemfile' || base === 'Gemfile.lock') return 'pods-ios';
  // A local package's (or native module's) own native code.
  if (parts.slice(0, -1).some((part) => NATIVE_DIRS.has(part)) && NATIVE_SOURCE.test(base)) return 'native';
  if (/\.(md|txt)$/i.test(base) || base.startsWith('.') || base === 'LICENSE') return 'ignore';
  return 'js';
}

export type ReactNativeAppKind = 'ios' | 'macos' | 'windows';

/** Whether a change needs the app running `app` rebuilt (Metro brings JavaScript over by itself). */
export function needsNativeRebuild(change: ReactNativeChange, app: ReactNativeAppKind): boolean {
  switch (change) {
    case 'deps':
    case 'native':
      return true;
    case 'pods-ios':
    case 'ios':
      return app === 'ios';
    case 'pods-macos':
    case 'macos':
      return app === 'macos';
    case 'windows':
      return app === 'windows';
    default:
      return false;
  }
}

/** Whether `pod install` has to run again for `platform` after these changes. */
export function needsPodInstall(changes: Iterable<ReactNativeChange>, platform: ReactNativeApplePlatform): boolean {
  for (const change of changes) {
    if (change === 'deps' || change === `pods-${platform}`) return true;
  }
  return false;
}
