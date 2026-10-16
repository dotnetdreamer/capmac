/**
 * Flutter on the wire: the messages of `flutter run --machine` (Flutter's
 * daemon protocol, the one IDEs use), and the agent operations that run
 * Flutter on the Mac. Shared by the agent and the engine.
 */
import type { Target } from './protocol.js';

/** One message of Flutter's daemon protocol: an event, or the answer to a request. */
export type FlutterDaemonMessage =
  | { event: string; params?: Record<string, any> }
  | { id: number | string; result?: unknown; error?: unknown; trace?: unknown };

/**
 * The messages on one line of `flutter run --machine` output: the protocol
 * wraps each in a JSON array (`[{"event":…}]`). Null for anything else (the
 * tool prints plain text before machine mode starts).
 */
export function parseDaemonLine(line: string): FlutterDaemonMessage[] | null {
  const text = line.trim();
  if (!text.startsWith('[{') || !text.endsWith('}]')) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((m): m is FlutterDaemonMessage => Boolean(m) && typeof m === 'object') : null;
  } catch {
    return null;
  }
}

/** A daemon request, as one line of `flutter run --machine` input. */
export function daemonRequestLine(id: number, method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify([{ id, method, params }])}\n`;
}

/** Debug (hot reload), profile, or release (what ships). */
export type FlutterMode = 'debug' | 'profile' | 'release';
export const isFlutterMode = (value: unknown): value is FlutterMode => value === 'debug' || value === 'profile' || value === 'release';

/** What `flutter run`/`flutter build` get from capmac.json's flutter section and the command line. */
export interface FlutterBuildOptions {
  mode: FlutterMode;
  /** The Dart entry point, relative to the project (lib/main.dart). */
  target?: string;
  flavor?: string;
  dartDefines?: Record<string, string>;
  dartDefineFile?: string;
  /** Extra arguments, passed as they are. */
  args?: string[];
}

/** `flutter run`/`flutter build` arguments for the build options. */
export function buildArgs(options: FlutterBuildOptions): string[] {
  const args = [`--${options.mode}`];
  if (options.target) args.push('--target', options.target);
  if (options.flavor) args.push('--flavor', options.flavor);
  for (const [key, value] of Object.entries(options.dartDefines ?? {})) args.push('--dart-define', `${key}=${value}`);
  if (options.dartDefineFile) args.push('--dart-define-from-file', options.dartDefineFile);
  args.push(...(options.args ?? []));
  return args;
}

/** The Flutter SDK the Mac (or this PC) uses. */
export interface FlutterSdkInfo {
  /** The flutter command. */
  bin: string;
  /** FLUTTER_ROOT. */
  root: string;
  version: string;
  channel: string | null;
  dartVersion: string | null;
  engineRevision: string | null;
  /** CapMac installed it (in ~/.capmac/flutter) rather than finding the Mac's own. */
  managed: boolean;
}

/** `flutter-sdk`: which Flutter the Mac has; with `install`, gets that version first when it is missing. */
export interface FlutterSdkParams {
  /** "3.47.7", "stable", or nothing for any Flutter already there. */
  version?: string;
  install?: boolean;
  /** Engine artifacts to download now (`flutter precache`), so the first run does not. */
  platforms?: Array<'ios' | 'macos'>;
}

export interface FlutterSdkResult {
  sdk: FlutterSdkInfo | null;
  /** Installed just now. */
  installed?: boolean;
}

/** Where `flutter-run` runs the app: a simulator or device (the iOS app), or the Mac's desktop (the Mac app). */
export type FlutterDevice = { kind: 'ios'; target: Target } | { kind: 'macos' };

export interface FlutterRunParams {
  projectId: string;
  projectRel: string;
  device: FlutterDevice;
  options: FlutterBuildOptions;
  /** The Flutter version wanted (see FlutterSdkParams.version). */
  version?: string;
  /** A device build's Apple team (FLUTTER_XCODE_DEVELOPMENT_TEAM). */
  team?: string;
  /** Attach to an app already running (the Mac app CapMac launched) instead of building and launching one. */
  attachUrl?: string;
}

/** How `flutter-run` ended: the app quit, or the run was stopped. */
export interface FlutterRunResult {
  reason: 'exited' | 'cancelled';
  exitCode: number | null;
  /** Flutter's own error, when it stopped before the app started ("Unable to find suitable Visual Studio toolchain"). */
  error?: string;
  /** Its last lines, for context. */
  tail?: string[];
}

/** `flutter-build`: builds without running (an .app for a simulator or the Mac, a signed device build, an .ipa). */
export interface FlutterBuildParams {
  projectId: string;
  projectRel: string;
  /** ios: a device build; ios-simulator; ipa: an archive and its .ipa; macos: the Mac app. */
  what: 'ios' | 'ios-simulator' | 'ipa' | 'macos';
  options: FlutterBuildOptions;
  version?: string;
  team?: string;
  /** `flutter build ipa --export-method`. */
  exportMethod?: 'development' | 'ad-hoc' | 'app-store' | 'enterprise';
}

export interface FlutterBuildResult {
  /** The built .app (or .xcarchive for an .ipa build), on the Mac. */
  appPath: string | null;
  /** The .ipa, on the Mac. */
  ipaPath: string | null;
  bundleId: string | null;
  displayName: string | null;
  executable: string | null;
}

/** `flutter-mac-launch`: opens a built Mac app with CapMac's module in it (its window shows in CapMac, its keys and clicks come from there). */
export interface FlutterMacLaunchParams {
  projectId: string;
  appPath: string;
  /** Debug builds: report the Dart VM service address (`flutter attach` uses it for hot reload). */
  debug: boolean;
}

export const FLUTTER_ERROR_CODES = {
  /** No Flutter on the Mac (or this PC), and none was installed. */
  missing: 'FLUTTER_MISSING',
  /** `flutter run` stopped before the app started. */
  runFailed: 'FLUTTER_RUN_FAILED',
  buildFailed: 'FLUTTER_BUILD_FAILED',
  installFailed: 'FLUTTER_INSTALL_FAILED',
} as const;
