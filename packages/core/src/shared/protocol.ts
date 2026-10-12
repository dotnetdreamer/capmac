/**
 * Messages exchanged between the Windows CLI and the Mac agent.
 * The first JSON frame the client sends is always `{ t: 'params', op, ... }`.
 */

export const PROTOCOL_VERSION = 1;

export type TargetKind = 'simulator' | 'device';

export interface Target {
  kind: TargetKind;
  udid: string;
  name: string;
  /** Human readable OS, e.g. "iOS 18.2". */
  os: string;
  /** Numeric OS version, e.g. "18.2". */
  osVersion: string;
  /** Booted / Shutdown for simulators; connected / available / unavailable for devices. */
  state: string;
  available: boolean;
  model?: string;
  connection?: 'usb' | 'network' | 'unknown';
  /** Devices: whether Developer Mode is on (needed to run development builds). */
  developerMode?: 'enabled' | 'disabled' | 'unknown';
  /** Devices: paired (trusted) with the Mac. */
  paired?: boolean;
}

export interface ProjectRef {
  /** Folder name for this project under ~/.capmac/projects on the Mac. */
  projectId: string;
  /** POSIX path from the synced root to the Capacitor project ('' when they are the same). */
  projectRel: string;
}

export interface ToolInfo {
  path: string;
  version: string;
}

export interface ProbeResult {
  agentVersion: string;
  home: string;
  user: string;
  hostname: string;
  /** "Kabir's MacBook Pro" (System Settings › General › About). */
  computerName: string | null;
  macos: string | null;
  arch: string;
  node: ToolInfo;
  npm: string | null;
  xcode: {
    developerDir: string;
    version: string;
    build: string;
    ready: boolean;
    problem?: string;
  } | null;
  tools: Record<string, ToolInfo | null>;
  simulators: { devices: number; runtimes: string[] };
  freeDiskGb: number | null;
  keychainLocked: boolean | null;
  signingIdentities: string[];
  /** Who is logged in at the Mac's screen ("root" = nobody); simulators need a desktop session. */
  consoleUser: string | null;
}

export interface ManifestEntry {
  /** POSIX relative path. */
  p: string;
  /** Content hash. */
  h: string;
  /** Size in bytes. */
  s: number;
  /** Unix mode bits. */
  m: number;
}

export interface SyncNeed {
  need: string[];
  remove: string[];
}

export interface SyncResult {
  remoteRoot: string;
  remoteProject: string;
  uploaded: number;
  bytes: number;
  removed: number;
  changed: string[];
}

export interface PrepareParams extends ProjectRef {
  /** Web assets directory, relative to the Capacitor project. */
  webDir: string;
  /** iOS platform directory, relative to the Capacitor project (default "ios"). */
  iosDir?: string;
  /** When set, the app loads this URL instead of the bundled web assets. */
  liveUrl: string | null;
  /** Force dependency install and a full `cap sync`. */
  full?: boolean;
  /** Skip dependency install even if the lockfile changed. */
  skipInstall?: boolean;
}

export interface PrepareResult {
  installed: boolean;
  packageManager: string;
  capCommand: 'sync' | 'copy' | null;
  iosPackageManager: 'SPM' | 'CocoaPods' | 'unknown';
  nativeDirty: boolean;
  webChanged: boolean;
}

export interface BuildParams extends ProjectRef {
  target: Target;
  configuration: string;
  iosDir?: string;
  scheme?: string;
  team?: string;
  clean?: boolean;
  /** Build even if nothing native changed since the last successful build. */
  force?: boolean;
  verbose?: boolean;
  extraArgs?: string[];
  /** App Store Connect API key used for automatic signing of device builds. */
  auth?: { keyId: string; issuerId: string; p8: string };
}

export interface BuildResult {
  skipped: boolean;
  appPath: string;
  bundleId: string;
  executable: string;
  displayName: string;
  warnings: number;
  logPath: string | null;
}

export interface DeployParams extends ProjectRef {
  target: Target;
  appPath: string;
  bundleId: string;
  /** Stream app stdout/stderr until the app exits or the client disconnects. */
  attach: boolean;
  /** Open Simulator.app on the Mac's screen. */
  showSimulator?: boolean;
  /** Mirror NSLog/os_log output into the console (OS_ACTIVITY_DT_MODE), like Xcode's console. */
  osLogs?: boolean;
}

export interface DeployResult {
  reason: 'exited' | 'detached' | 'cancelled';
  exitCode: number | null;
}

export interface TargetsResult {
  simulators: Target[];
  devices: Target[];
  deviceSupport: boolean;
}

export interface ScreenParams {
  udid: string;
  fps: number;
  /** JPEG quality 20-100 for streamed frames. */
  quality: number;
  /** Longest side of streamed frames in pixels (frames are downscaled on the Mac). */
  maxSize?: number;
}

export interface ScreenInfo {
  t: 'screen';
  source: 'axe' | 'simctl';
  /** Screen size in points (null until known). */
  points: { width: number; height: number } | null;
  input: boolean;
}

export type InputEvent =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'button'; button: 'home' | 'lock' | 'siri' | 'side' | 'apple-pay' };

export interface ExecParams extends ProjectRef {
  command: string;
  cwd: 'project' | 'root' | 'ios' | 'home';
}

export interface PullParams extends ProjectRef {
  paths: string[];
}

export interface RelayParams {
  listenHost: string;
  listenPort: number;
  targetPort: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AgentErrorInfo {
  message: string;
  code?: string;
  hint?: string;
  /** Last lines of tool output, for context. */
  tail?: string[];
  /** Full tool log on the Mac (e.g. the xcodebuild log of a failed build). */
  logPath?: string;
}

export type Severity = 'error' | 'warning' | 'note';

export interface Diagnostic {
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  context?: string[];
  /** True when the file belongs to the user's project (not Pods / packages). */
  own?: boolean;
}

export type AgentEvent =
  | { t: 'log'; level: LogLevel; msg: string }
  | { t: 'step'; id: string; title: string }
  | { t: 'step-end'; id: string; ok: boolean; ms: number; detail?: string }
  | { t: 'out'; stream: 'stdout' | 'stderr'; text: string }
  | ({ t: 'diag' } & Diagnostic)
  | { t: 'progress'; text: string; done?: number }
  | { t: 'app'; stream: 'stdout' | 'stderr'; text: string }
  | ScreenInfo
  /** `watch-targets`: the simulators and devices changed. */
  | { t: 'targets'; data: TargetsResult }
  | ({ t: 'need' } & SyncNeed)
  | { t: 'archive-begin'; files: number }
  | { t: 'archive-end' }
  /** A long-running operation (relay, screen, deploy) is up and running. */
  | { t: 'ready'; data: unknown }
  | { t: 'result'; ok: true; data: unknown }
  | { t: 'result'; ok: false; error: AgentErrorInfo };

export const ERROR_CODES = {
  cancelled: 'CANCELLED',
  busy: 'BUSY',
  noXcode: 'NO_XCODE',
  xcodeNotReady: 'XCODE_NOT_READY',
  noIosPlatform: 'NO_IOS_PLATFORM',
  installFailed: 'INSTALL_FAILED',
  capFailed: 'CAP_FAILED',
  buildFailed: 'BUILD_FAILED',
  keychainLocked: 'KEYCHAIN_LOCKED',
  signing: 'SIGNING',
  targetNotFound: 'TARGET_NOT_FOUND',
  toolMissing: 'TOOL_MISSING',
  deployFailed: 'DEPLOY_FAILED',
  badRequest: 'BAD_REQUEST',
} as const;
