/**
 * Messages exchanged between the Windows CLI and the Mac agent.
 * The first JSON frame the client sends is always `{ t: 'params', op, ... }`.
 */

import type { AppCodec, AppDialog, AppDialogClosed, AppInputEvent, AppWindowInfo, HookEvent, SoundMode } from './electron.js';

export const PROTOCOL_VERSION = 1;

/** 'mac': the Mac's own desktop, where Electron apps run. */
export type TargetKind = 'simulator' | 'device' | 'mac';

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
  /** The smooth (H.264) simulator stream's helper; missing from older agents. */
  streamHelper?: StreamHelperState;
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
  /** Take input through capmac's helper when it works (else AXe, when installed). */
  helperInput?: boolean;
}

/** The H.264 stream (agent op `stream`): capmac's helper on the Mac, frames relayed as they are. */
export interface StreamParams {
  udid: string;
  /** Longest side of the video in pixels. */
  maxSize?: number;
  fps?: number;
  /** The bitrate to start at; adaptive bitrate moves it between minBitrate and maxBitrate. */
  bitrate?: number;
  minBitrate?: number;
  maxBitrate?: number;
}

/** The H.264 stream of an iPhone or iPad plugged into the Mac (agent op `device-stream`). */
export interface DeviceStreamParams extends StreamParams {
  /** The device's name, to find it when the Mac knows it by another id. */
  name?: string;
}

export interface ScreenInfo {
  t: 'screen';
  /**
   * 'app': a window of an Electron app on the Mac (through CapMac's module in the app).
   * 'device': an iPhone or iPad plugged into the Mac (CapMac.app on the Mac captures it).
   */
  source: 'axe' | 'simctl' | 'helper' | 'app' | 'device';
  /** Screen size in points (null until known). */
  points: { width: number; height: number } | null;
  /** Whether the screen takes input at all. */
  input: boolean;
  /**
   * How input works: 'touch' streams fingers down, move and up as they happen
   * (capmac's helper); 'gestures' sends whole taps and swipes (AXe); 'mouse'
   * is a desktop app's pointer and keyboard (Electron apps).
   */
  inputMode?: 'touch' | 'gestures' | 'mouse';
  /** Why input is not available (or limited to gestures). */
  inputReason?: string;
  /** Points to pixels. */
  scale?: number;
  codec?: 'h264' | 'jpeg';
}

/** Why the compatible stream is showing although the smooth one was wanted. */
export interface StreamFallback {
  code: 'helper-build' | 'helper-start' | 'helper-exit' | 'no-picture' | 'stalled' | 'unsupported' | 'error';
  message: string;
  hint?: string;
  details?: string[];
  /** Restarting the simulator usually brings the smooth stream back. */
  restartSimulator?: boolean;
}

/** Normalized screen coordinates: 0 to 1 from the top left corner. */
export type InputEvent =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  /** `via: 'paste'` puts the text on the simulator's pasteboard and pastes it; 'type' (the default) types it. */
  | { kind: 'text'; text: string; via?: 'type' | 'paste' }
  | { kind: 'key'; key: string }
  /** No phase: press and release. */
  | { kind: 'button'; button: 'home' | 'lock' | 'siri' | 'side' | 'apple-pay'; phase?: 'down' | 'up' }
  // Streaming input ('touch' mode): as it happens, so drags and scrolling feel natural.
  | { kind: 'touch'; phase: 'down' | 'move' | 'up' | 'cancel'; x: number; y: number }
  | { kind: 'touch2'; phase: 'down' | 'move' | 'up'; x1: number; y1: number; x2: number; y2: number }
  /** Scroll by (dx, dy) points at (x, y). */
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  /** A key press: a USB HID keyboard usage plus modifier bits (see shared/hid.ts). */
  | { kind: 'keypress'; usage: number; modifiers?: number }
  // A desktop app's window (Electron): pointer, wheel and keys, as the PC reported them.
  | Exclude<AppInputEvent, { kind: 'text' }>;

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
  /**
   * A line from the running app. Electron apps say where it came from: the
   * main process, Chromium inside Electron, or the dev command around it.
   */
  | { t: 'app'; stream: 'stdout' | 'stderr'; text: string; source?: 'main' | 'chromium' | 'tool' }
  /** Electron: what CapMac's module in the app reported (windows, the pages' console, crashes). */
  | { t: 'electron'; event: HookEvent }
  /** Electron: the answer to a control request sent to `electron-launch`. */
  | { t: 'control-result'; id: number; ok: boolean; data?: unknown; error?: string }
  /** `electron-screen`: the app's windows, and which one is showing. */
  | { t: 'app-windows'; windows: AppWindowInfo[]; watched: number | null }
  /** `electron-screen`: the pointer's shape over the window (Electron's cursor type). */
  | { t: 'app-cursor'; cursor: string }
  /** `electron-screen`: text copied in the app, for the PC's clipboard. */
  | { t: 'app-clipboard'; text: string }
  /** `electron-screen`: waiting for the app (not running, or restarting), or showing it again. */
  | { t: 'app-waiting'; waiting: boolean }
  /** `electron-screen`: the app's dialogs waiting for an answer in CapMac (see AppDialog). */
  | { t: 'app-dialogs'; dialogs: AppDialog[]; closed?: { id: number; how: AppDialogClosed } }
  /** `electron-screen`: where the app's sound plays, and whether it can play on the PC. */
  | { t: 'app-sound'; mode: SoundMode; toPc: boolean }
  /** `electron-screen`: the app's sound, Opus packets (base64) in order, when it plays on the PC. */
  | { t: 'app-audio'; packets: string[] }
  /** `electron-screen`: the answer to a dialog request (`dialog-answer`, `dialog-list`, `dialog-mkdir`). */
  | { t: 'app-dialog-reply'; req: number; ok: boolean; data?: unknown; error?: string }
  /** `electron-screen`: how the window's pictures come now, and why it is JPEG when video was asked for. */
  | { t: 'app-codec'; codec: AppCodec; fallback: StreamFallback | null }
  | ScreenInfo
  /** `watch-targets`: the simulators and devices changed. */
  | { t: 'targets'; data: TargetsResult }
  | ({ t: 'need' } & SyncNeed)
  | { t: 'archive-begin'; files: number }
  | { t: 'archive-end' }
  /** A long-running operation (relay, screen, deploy) is up and running. */
  | { t: 'ready'; data: unknown }
  /** `stream`: preparing the helper (compiling it on first use, then starting it). */
  | { t: 'stream-prepare'; stage: 'building' | 'starting'; xcode?: string }
  /** `stream`: a clock ping answered (Unix epoch µs; `pc` is echoed). */
  | { t: 'pong'; id: number; pc: number; mac: number }
  /** `stream`: the helper's memory and traffic, every few seconds. */
  | { t: 'stream-status'; footprint: number; fps: number; dropped: number; bitrate?: number }
  /** `device-stream`: waiting for the device's cable or for camera access on the Mac; null once the picture comes. */
  | { t: 'stream-wait'; for: 'device' | 'permission' | null }
  /** `device-stream`: no still this time (the answer to `still`). */
  | { t: 'still-error'; message: string }
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
  /** The H.264 helper did not compile on this Mac (details in the tail). */
  helperBuild: 'HELPER_BUILD_FAILED',
  /** The helper started but could not stream (no screen, CoreSimulator changed, …). */
  helperStart: 'HELPER_START_FAILED',
  /** The helper stopped unexpectedly. */
  helperExit: 'HELPER_EXITED',
  /** The screen kept changing while the helper saw nothing. */
  streamStalled: 'STREAM_STALLED',
  /** Nothing to build the helper with (no Xcode selected). */
  streamUnsupported: 'STREAM_UNSUPPORTED',
  /** The Mac said no to CapMac seeing a plugged-in iPhone's screen (camera access). */
  deviceScreenDenied: 'DEVICE_SCREEN_DENIED',
  /** Electron: the app's build failed. */
  electronBuild: 'ELECTRON_BUILD_FAILED',
  /** Electron: the app did not start, or no Electron is installed in the project. */
  electronLaunch: 'ELECTRON_LAUNCH_FAILED',
  /** Electron: the app is not running (no window to show). */
  appNotRunning: 'APP_NOT_RUNNING',
} as const;

/** The H.264 helper on a Mac, as the health check reports it. */
export interface StreamHelperState {
  state: 'ready' | 'not-built' | 'failed' | 'unsupported';
  /** "26.6" */
  xcode?: string;
  /** The simulators take touch and keys from the helper (CoreSimulator before Xcode 27). */
  input?: boolean;
  /** Why it failed or is unsupported (the compiler's last lines). */
  detail?: string;
}
