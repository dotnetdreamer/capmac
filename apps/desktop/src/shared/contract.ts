/**
 * The contract between capmac Studio's processes: renderer ⇄ main ⇄ engine
 * host. Every renderer request is validated in main with these schemas
 * before it reaches the engine; screen input arriving on a MessagePort is
 * validated by the engine host.
 */
import { z } from 'zod';
import type { AppSearch, ProjectApp } from '@capmac/core/engine/apps';
import type { ErrorInfo } from '@capmac/core/engine/errors';
import type { WslSetupState } from '@capmac/core/shared/wsl-setup';
import type { Check, ConnectionState, EngineEvent, FixId, SessionMode } from '@capmac/core/engine/events';
import type { ProbeResult, ScreenInfo, StreamFallback, TargetsResult } from '@capmac/core/shared/protocol';
import type { AppDialog, AppDialogAnswer, AppDialogClosed, AppWindowInfo, ElectronFlavor, MacFolder, SoundMode } from '@capmac/core/shared/electron';
import { PUBLIC_KEY_RE, RELAY_CHOICES, ROUTE_CHOICES } from '@capmac/core/shared/remote';
import type { RemoteSettings, RemoteTestResult, Route, SignalServerSetting } from '@capmac/core/shared/remote';
import type { RemoteDoorStatus, RemotePc } from '@capmac/core/shared/remote-door';
import type { AgentSkillStatus, CapmacCommandStatus, SkillChange } from '@capmac/core/shared/skills';
import type { TakeoverStatus } from '@capmac/core/shared/takeover';

export type { AppFramework, AppPlatform, AppSearch, DetectedProject, ProjectApp } from '@capmac/core/engine/apps';
export type { ErrorInfo } from '@capmac/core/engine/errors';
export type { AppLogEntry, Check, CheckLevel, ConnectionState, EngineEvent, FixId, Phase, SessionMode, SessionState, StepStatus, WslSetupPhase } from '@capmac/core/engine/events';
export type { Diagnostic, InputEvent, ProbeResult, ScreenInfo, StreamFallback, StreamHelperState, Target, TargetsResult } from '@capmac/core/shared/protocol';
export type { AppDialog, AppDialogAnswer, AppDialogClosed, AppWindowInfo, ElectronFlavor, MacFolder, SoundMode } from '@capmac/core/shared/electron';
export type { RelayChoice, RemoteSettings, RemoteTestResult, Route, RouteChoice, SignalServerSetting } from '@capmac/core/shared/remote';
export type { RemoteDoorStatus, RemotePc } from '@capmac/core/shared/remote-door';

// ─── Values ────────────────────────────────────────────────────────────────

const text = (max: number) => z.string().min(1).max(max);
const macName = text(100);
const fsPath = text(4096);
const udid = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'not a device id');
const id = z.string().regex(/^[a-z0-9-]{1,64}$/);
/** The apps CapMac runs, by their id in a project (see core's apps.ts): a Flutter app's Mac and Windows apps too. */
const runnableApp = z.enum(['ios', 'electron', 'macos', 'windows']);
export type RunnableApp = z.infer<typeof runnableApp>;
/** Where a project's iOS app builds: a paired Mac, or this PC with no Mac (see core's backend.ts). */
const buildBackend = z.enum(['mac', 'wsl']);
export type BuildBackend = z.infer<typeof buildBackend>;
/** Which agents get (or lose) the capmac skill, and where. */
const skillTarget = { agents: z.array(id).min(1).max(32), scope: z.enum(['global', 'project']), projectDir: fsPath.optional() };
const hasProject = (v: { scope: string; projectDir?: string }) => v.scope === 'global' || v.projectDir !== undefined;
const fixIds = ['install-node', 'xcode-license', 'xcode-first-launch', 'download-ios', 'install-axe', 'install-cocoapods', 'unlock-keychain', 'build-stream-helper', 'remote-repair'] as const satisfies readonly FixId[];

export const sessionOptionsSchema = z.object({
  clean: z.boolean().optional(),
  full: z.boolean().optional(),
  configuration: z.string().max(64).optional(),
  osLogs: z.boolean().optional(),
  showSimulator: z.boolean().optional(),
  webBuild: z.boolean().optional(),
  /** A Flutter app's Run: debug (the default), profile or release (`capmac run --mode`). */
  flutterMode: z.enum(['debug', 'profile', 'release']).optional(),
}).strict();

/** Params of every engine method the renderer may call. */
export const engineMethods = {
  'macs.list': z.object({}).strict(),
  'macs.discover': z.object({ timeoutMs: z.number().int().min(500).max(15_000).optional() }).strict(),
  'macs.pair': z.object({
    host: text(253),
    port: z.number().int().min(1).max(65_535).optional(),
    username: text(64),
    password: z.string().max(1024).optional(),
    name: z.string().max(40).optional(),
    label: z.string().max(120).optional(),
    /** Also turn remote access on (needs the signaling server set). */
    remote: z.boolean().optional(),
  }).strict(),
  'macs.unpair': z.object({ name: macName }).strict(),
  'macs.setDefault': z.object({ name: macName }).strict(),
  'macs.connect': z.object({ name: macName }).strict(),
  'macs.health': z.object({ name: macName, projectPath: fsPath.optional() }).strict(),
  'macs.fix': z.object({ name: macName, fix: z.enum(fixIds) }).strict(),
  'macs.unlockKeychain': z.object({ name: macName }).strict(),
  'targets.list': z.object({ mac: macName }).strict(),
  'targets.watch': z.object({ mac: macName }).strict(),
  'targets.unwatch': z.object({ watchId: id }).strict(),
  'targets.refresh': z.object({ mac: macName }).strict(),
  'simulators.boot': z.object({ mac: macName, udid }).strict(),
  'simulators.shutdown': z.object({ mac: macName, udid }).strict(),
  'projects.inspect': z.object({ path: fsPath }).strict(),
  /** Every app in a folder: the project's own, and the ones in the folders inside it (reads files only). */
  'projects.detect': z.object({ path: fsPath }).strict(),
  /** The app CapMac works on in this project from now on (the CLI too). */
  'projects.setApp': z.object({ path: fsPath, app: runnableApp }).strict(),
  'projects.syncSize': z.object({ path: fsPath }).strict(),
  /** Copies a bundled sample to Documents\CapMac Studio: the Capacitor iOS app, the Electron app, or the Flutter app. */
  'projects.createSample': z.object({ kind: z.enum(['ios', 'electron', 'flutter']).optional() }).strict(),
  'projects.installDeps': z.object({ path: fsPath }).strict(),
  /** Where the project's iOS app builds from now on: a paired Mac, or this PC (`capmac backend`, the CLI too). */
  'projects.setBackend': z.object({ path: fsPath, backend: buildBackend }).strict(),
  'sessions.start': z.object({
    projectPath: fsPath,
    /** `build`: on this PC, build the app and its .ipa without installing it. */
    mode: z.enum(['run', 'live', 'build']),
    mac: macName.optional(),
    /** Which of the project's apps (default: the one picked for it). */
    app: runnableApp.optional(),
    /** Where it builds (default: the one picked for the project). */
    backend: buildBackend.optional(),
    target: udid.optional(),
    options: sessionOptionsSchema.optional(),
  }).strict(),
  'sessions.stop': z.object({ sessionId: id }).strict(),
  'sessions.rebuild': z.object({ sessionId: id, clean: z.boolean().optional() }).strict(),
  /** Live reload: start the app again (a Flutter app: a hot restart). */
  'sessions.relaunch': z.object({ sessionId: id }).strict(),
  /** Live reload: an Electron app reloads its windows; a Flutter app hot-reloads. */
  'sessions.reload': z.object({ sessionId: id }).strict(),
  'builds.ipa': z.object({
    projectPath: fsPath,
    mac: macName.optional(),
    exportKind: z.enum(['development', 'ad-hoc', 'app-store', 'enterprise']),
    upload: z.boolean().optional(),
    outDir: fsPath.optional(),
    team: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
  }).strict(),
  'xcode.open': z.object({ projectPath: fsPath, mac: macName.optional() }).strict(),
  'logs.buildLog': z.object({ projectPath: fsPath, mac: macName.optional(), path: text(4096) }).strict(),
  'screen.stop': z.object({ streamId: id }).strict(),
  /** A simulator's screen, or (the Mac's desktop, with the project) the Electron app's window. */
  'screen.screenshot': z.object({ mac: macName, udid, projectPath: fsPath.optional(), window: z.number().int().min(0).optional() }).strict(),
  'debug.dropConnection': z.object({ mac: macName }).strict(),
  // Remote access: the same options as `capmac remote`.
  'remote.server': z.object({}).strict(),
  'remote.setServer': z.object({ url: z.string().max(2048).nullable() }).strict(),
  'macs.remote.enable': z.object({ name: macName, keepAwake: z.boolean().optional() }).strict(),
  'macs.remote.disable': z.object({ name: macName, localOnly: z.boolean().optional() }).strict(),
  'macs.remote.set': z.object({ name: macName, route: z.enum(ROUTE_CHOICES).optional(), relay: z.enum(RELAY_CHOICES).optional(), keepAwake: z.boolean().optional(), signalUrl: z.string().min(1).max(2048).optional() }).strict(),
  'macs.remote.status': z.object({ name: macName }).strict(),
  'macs.remote.revoke': z.object({ name: macName, key: z.string().regex(PUBLIC_KEY_RE) }).strict(),
  'macs.remote.test': z.object({ name: macName }).strict(),
  // This PC, with no Mac: the same as `capmac wsl setup | doctor | targets`, with the same saved setup.
  'wsl.status': z.object({ projectPath: fsPath }).strict(),
  /** Starts setup (it reports with `wsl-setup` events, then `setup-ended`); `appleLogin`: sign in to Apple again. */
  'wsl.setup': z.object({ projectPath: fsPath, appleLogin: z.boolean().optional() }).strict(),
  'wsl.stopSetup': z.object({ setupId: id }).strict(),
  'wsl.doctor': z.object({ projectPath: fsPath }).strict(),
  'wsl.devices': z.object({ projectPath: fsPath }).strict(),
} as const;

export type EngineMethod = keyof typeof engineMethods;
export type MethodParams<M extends EngineMethod> = z.input<(typeof engineMethods)[M]>;

export interface MacSummary {
  name: string;
  host: string;
  port: number;
  username: string;
  /** "IK's M1" */
  label: string;
  xcode: string | null;
  /** macOS version ("26.6.1"), as last seen. */
  macos: string | null;
  isDefault: boolean;
  pairedAt: string;
  state: ConnectionState | 'idle';
  latencyMs: number | null;
  error: string | null;
  /** Remote access ("Reach this Mac from anywhere"). */
  remote: RemoteSettings;
  /** How the current connection goes (null when not connected). */
  route: Route | null;
  /** The round trip WebRTC measures, over the internet. */
  rttMs: number | null;
}

/** Remote access for one Mac, as the Macs page shows it (needs a connection). */
export interface RemoteStatusReport {
  door: RemoteDoorStatus | null;
  thisPc: { key: string; name: string };
  pcs: Array<RemotePc & { current: boolean }>;
  route: Route | null;
  rttMs: number | null;
  /** The health check's Remote access row, as of now (it replaces the one in the last check). */
  check: Check;
}

export interface DiscoveredMac {
  name: string;
  host: string;
  port: number;
  addresses: string[];
  /** How it was found: on this network (Bonjour), or on your tailnet (Tailscale). */
  via?: 'bonjour' | 'tailscale';
}

export interface ProjectSummary {
  /** A Capacitor app, an Electron app on its own, or a Flutter app. */
  kind: 'capacitor' | 'electron' | 'flutter';
  path: string;
  appName: string;
  appId: string;
  projectId: string;
  iosPackageManager: 'SPM' | 'CocoaPods' | 'unknown';
  hasIos: boolean;
  webDir: string;
  packageManager: string;
  iconPath: string | null;
  host: string | null;
  hasNodeModules: boolean;
  devCommand: string | null;
  /** The Electron app (the project itself, or Capacitor's Electron platform), which runs on the Mac's desktop. */
  electron: { flavor: ElectronFlavor; rel: string; name: string; electronRange: string | null } | null;
  /** A Flutter app: which of its platform folders are there, its entry point, and the Flutter it asks for. */
  flutter: { name: string; platforms: { ios: boolean; macos: boolean; windows: boolean }; target: string; flavor: string | null; wants: string | null } | null;
  /** Its apps: the iOS app, the Electron app, a Flutter app's Mac and Windows apps, when it has them. */
  apps: ProjectApp[];
  /** The app Run and Live use: the one picked for the project, else the iOS app, else the Electron app. */
  app: RunnableApp;
  /** Whether that app was picked (in Studio, or with `capmac apps use`) rather than taken by default. */
  appChosen: boolean;
  /** Where the iOS app builds: a paired Mac, or this PC (picked in the toolbar, or with `capmac backend`). */
  backend: BuildBackend;
}

/** Building on this PC: what setup has put in place (see core's wslSetupState), and whether it runs now. */
export interface WslStatus extends WslSetupState {
  /** The setup running for this project in CapMac Studio now. */
  setupId: string | null;
  /** Apple's device server, which reaches iPhones over USB (from the Apple Devices app). */
  server: 'running' | 'stopped' | 'missing';
}

/** iPhones plugged into this PC, and Apple's device server that reaches them. */
export interface WslDevices {
  server: 'running' | 'stopped' | 'missing';
  devices: import('@capmac/core/shared/protocol').Target[];
  /** Why the list could not be read (the iPhone tools are not set up yet, …). */
  error: ErrorInfo | null;
}

export interface HealthReport {
  mac: string;
  checks: import('@capmac/core/engine/events').Check[];
  probe: ProbeResult | null;
  latencyMs: number | null;
}

/** What each method resolves with. */
export interface MethodResults {
  'macs.list': MacSummary[];
  'macs.discover': DiscoveredMac[];
  'macs.pair': { mac: MacSummary; isDefault: boolean; remote?: { ok: boolean; test: RemoteTestResult | null; error?: ErrorInfo } };
  'macs.unpair': void;
  'macs.setDefault': void;
  'macs.connect': MacSummary;
  'macs.health': HealthReport;
  'macs.fix': void;
  'macs.unlockKeychain': void;
  'targets.list': TargetsResult;
  'targets.watch': { watchId: string; targets: TargetsResult | null };
  'targets.unwatch': void;
  'targets.refresh': void;
  'simulators.boot': void;
  'simulators.shutdown': void;
  'projects.inspect': ProjectSummary;
  'projects.detect': AppSearch;
  /** The project as it is now, with the app picked. */
  'projects.setApp': ProjectSummary;
  'projects.syncSize': { files: number; bytes: number };
  'projects.createSample': { path: string };
  'projects.installDeps': void;
  'sessions.start': { sessionId: string };
  'sessions.stop': void;
  'sessions.rebuild': void;
  'sessions.relaunch': void;
  'sessions.reload': void;
  'builds.ipa': { sessionId: string };
  'xcode.open': void;
  'logs.buildLog': { text: string };
  'screen.stop': void;
  'screen.screenshot': { png: ArrayBuffer; width: number | null; height: number | null };
  'debug.dropConnection': void;
  'remote.server': SignalServerSetting;
  'remote.setServer': SignalServerSetting;
  'macs.remote.enable': { mac: MacSummary; test: RemoteTestResult | null };
  'macs.remote.disable': { mac: MacSummary; check: Check };
  'macs.remote.set': { mac: MacSummary; reconnecting: boolean };
  'macs.remote.status': RemoteStatusReport;
  'macs.remote.revoke': Array<RemotePc & { current: boolean }>;
  'macs.remote.test': RemoteTestResult;
  'projects.setBackend': ProjectSummary;
  'wsl.status': WslStatus;
  'wsl.setup': { setupId: string };
  'wsl.stopSetup': void;
  'wsl.doctor': { ready: boolean; checks: Check[] };
  'wsl.devices': WslDevices;
}

// ─── Events ────────────────────────────────────────────────────────────────

/** Who an event is about. */
export interface Scope {
  sessionId?: string;
  projectPath?: string;
  mac?: string;
  watchId?: string;
  streamId?: string;
  /** Setting up this PC for the project at this path. */
  setup?: string;
}

/** Engine events plus the host's own bookkeeping. */
export type HostEvent =
  | EngineEvent
  | { type: 'session-started'; mode: SessionMode; projectPath: string; mac: string | null; target: string | null; backend?: BuildBackend }
  /** Setting up this PC ended: done, stopped, or failed. */
  | { type: 'setup-ended'; ok: boolean; cancelled: boolean; error?: ErrorInfo }
  | { type: 'session-ended'; mode: SessionMode; ok: boolean; cancelled: boolean; error?: ErrorInfo; ms: number }
  | { type: 'screen-info'; info: ScreenInfo }
  | { type: 'screen-ended'; error?: ErrorInfo }
  | { type: 'ipa-ready'; file: string; size: number }
  | { type: 'macs-changed' };

export interface Envelope {
  scope: Scope;
  event: HostEvent;
}

export type EngineStatus = { state: 'starting' } | { state: 'ready' } | { state: 'crashed'; restarting: boolean };

// ─── Prompts (engine asks, the renderer answers with a dialog) ────────────

export type PromptRequest =
  | { id: string; kind: 'password'; purpose: 'pair' | 'keychain' | 'sudo' | 'signing' | 'apple'; message: string; mac?: string; user?: string }
  | { id: string; kind: 'confirm'; message: string; detail?: string; danger?: boolean; confirmLabel?: string; cancelLabel?: string; defaultYes?: boolean; link?: { label: string; url: string }; waiting?: string }
  | { id: string; kind: 'choose'; message: string; detail?: string; items: Array<{ label: string; hint?: string }> }
  | { id: string; kind: 'text'; message: string; defaultValue?: string; placeholder?: string; purpose?: 'apple-email' | 'apple-code' };

export const promptResponseSchema = z.object({
  id: z.string().max(64),
  ok: z.boolean(),
  /** password/text: string, confirm: boolean, choose: index. */
  value: z.union([z.string().max(4096), z.boolean(), z.number().int().min(0).max(1000)]).optional(),
}).strict();
export type PromptResponse = z.infer<typeof promptResponseSchema>;

// ─── Screen input (renderer → engine over the screen MessagePort) ─────────

const unit = z.number().min(0).max(1);
const points = z.number().min(-2000).max(2000);
export const inputEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap'), x: unit, y: unit }).strict(),
  z.object({ kind: z.literal('swipe'), x1: unit, y1: unit, x2: unit, y2: unit, durationMs: z.number().int().min(16).max(10_000) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(20_000), via: z.enum(['type', 'paste']).optional() }).strict(),
  z.object({ kind: z.literal('key'), key: z.enum(['return', 'enter', 'escape', 'delete', 'backspace', 'tab', 'space']) }).strict(),
  z.object({ kind: z.literal('button'), button: z.enum(['home', 'lock', 'siri', 'side', 'apple-pay']), phase: z.enum(['down', 'up']).optional() }).strict(),
  z.object({ kind: z.literal('touch'), phase: z.enum(['down', 'move', 'up', 'cancel']), x: unit, y: unit }).strict(),
  z.object({ kind: z.literal('touch2'), phase: z.enum(['down', 'move', 'up']), x1: unit, y1: unit, x2: unit, y2: unit }).strict(),
  z.object({ kind: z.literal('scroll'), x: unit, y: unit, dx: points, dy: points }).strict(),
  z.object({ kind: z.literal('keypress'), usage: z.number().int().min(1).max(0xffff), modifiers: z.number().int().min(0).max(15).optional() }).strict(),
  // An Electron app's window: the pointer, the wheel and keys, as on a Mac.
  z.object({
    kind: z.literal('mouse'),
    phase: z.enum(['down', 'up', 'move', 'leave']),
    x: unit,
    y: unit,
    button: z.enum(['left', 'right', 'middle']).optional(),
    clicks: z.number().int().min(1).max(3).optional(),
    buttons: z.number().int().min(0).max(31).optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }).strict(),
  z.object({ kind: z.literal('wheel'), x: unit, y: unit, dx: points, dy: points, modifiers: z.number().int().min(0).max(15).optional() }).strict(),
  z.object({
    kind: z.literal('keyboard'),
    phase: z.enum(['down', 'up']),
    key: z.string().min(1).max(32),
    code: z.string().max(32),
    modifiers: z.number().int().min(0).max(15).optional(),
    repeat: z.boolean().optional(),
  }).strict(),
]);

/** Messages on a screen port, engine → renderer. Frames are ArrayBuffers sent with a transfer list. */
export type ScreenPortMessage =
  /** Compatible stream: one JPEG. */
  | { type: 'frame'; data: ArrayBuffer; seq: number }
  /** Smooth stream: one message from the helper (header and payload, see core's shared/stream.ts). */
  | { type: 'video'; data: ArrayBuffer; seq: number; key: boolean; config: boolean; captureUs: number }
  | { type: 'info'; info: ScreenInfo }
  | { type: 'state'; state: 'connecting' | 'streaming' | 'reconnecting' | 'ended'; error?: ErrorInfo }
  /** Which stream is showing, and why it is the compatible one when the smooth one was wanted. */
  | { type: 'codec'; codec: 'h264' | 'jpeg'; fallback: StreamFallback | null }
  /** Smooth stream: preparing the helper on the Mac (compiling it the first time). */
  | { type: 'preparing'; stage: 'building' | 'starting'; xcode?: string }
  /** A device's screen: waiting for its cable or for Allow on the Mac; null once the picture comes. */
  | { type: 'device-wait'; wait: 'device' | 'permission' | null }
  /** The Mac's clock minus this PC's (µs), for the latency readout. */
  | { type: 'clock'; offsetUs: number; rttUs: number }
  /** Smooth stream: the bitrate adaptive bitrate chose, and frames dropped to catch up (every few seconds). */
  | { type: 'status'; bitrate: number | null; dropped: number }
  /** An Electron app: its windows, and which one is showing. */
  | { type: 'windows'; windows: AppWindowInfo[]; watched: number | null }
  /** An Electron app: the pointer's shape over the window (Electron's cursor type). */
  | { type: 'cursor'; cursor: string }
  /** An Electron app: text copied in the app, for this PC's clipboard. */
  | { type: 'clipboard'; text: string }
  /** An Electron app: not running (or restarting), or showing again. */
  | { type: 'waiting'; waiting: boolean }
  /** An Electron app: its dialogs waiting for an answer here (it is in the background on the Mac). */
  | { type: 'dialogs'; dialogs: AppDialog[]; closed?: { id: number; how: AppDialogClosed } }
  /** An Electron app: the answer to a dialog command (`req` is the command's). */
  | { type: 'dialog-reply'; req: number; ok: boolean; data?: unknown; error?: string }
  /** An Electron app: where its sound plays, and whether it can play on this PC. */
  | { type: 'sound'; mode: SoundMode; toPc: boolean }
  /** An Electron app: its sound on this PC, Opus packets in order. */
  | { type: 'audio'; packets: ArrayBuffer[] };

/** Messages on a screen port, renderer → engine. */
export type ScreenPortCommand =
  /** Compatible stream: a frame was drawn. Smooth stream: frames up to `seq` were taken. */
  | { type: 'ack'; seq: number }
  | { type: 'input'; event: unknown }
  | { type: 'restart' }
  /** Smooth stream: the decoder needs a keyframe (it reset, or dropped frames to catch up). */
  | { type: 'keyframe' }
  /** Smooth stream: the video's longest side in pixels, to match the pane. */
  | { type: 'size'; maxSize: number }
  /** After a fallback: try the smooth stream again. */
  | { type: 'retry-smooth' }
  /** An Electron app: show this window (null: follow the focused one). */
  | { type: 'window'; window: number | null }
  /** An Electron app: the window's traffic lights. */
  | { type: 'window-action'; window: number; action: 'close' | 'minimize' | 'zoom' }
  /** An Electron app's dialogs: an answer, a folder on the Mac to list, a folder to make (answered with `dialog-reply`). */
  | { type: 'dialog-answer'; req: number; dialog: number; answer: AppDialogAnswer }
  | { type: 'dialog-list'; req: number; path: string; hidden?: boolean }
  | { type: 'dialog-mkdir'; req: number; path: string }
  /** An Electron app: where its sound plays from now on (remembered for the project). */
  | { type: 'sound'; mode: SoundMode };

// ─── App (main process) ────────────────────────────────────────────────────

export const themeSchema = z.enum(['system', 'light', 'dark']);
export const editorSchema = z.enum(['vscode', 'cursor', 'system']);

export const recentProjectSchema = z.object({
  path: fsPath,
  name: z.string().max(200),
  appId: z.string().max(200),
  lastOpened: z.number(),
  lastRun: z.object({ at: z.number(), mode: z.enum(['run', 'live']), ok: z.boolean(), target: z.string().max(200).optional(), ms: z.number().optional() }).optional(),
});
export type RecentProject = z.infer<typeof recentProjectSchema>;

export const settingsSchema = z.object({
  theme: themeSchema,
  editor: editorSchema,
  notifications: z.boolean(),
  keepInTray: z.boolean(),
  consoleLimit: z.number().int().min(10_000).max(1_000_000),
  consoleTimestamps: z.boolean(),
  consoleWrap: z.boolean(),
  osLogs: z.boolean(),
  verbose: z.boolean(),
  dependencyWarnings: z.boolean(),
  deviceFrame: z.boolean(),
  /** Smooth: H.264 from capmac's helper (falls back by itself); compatible: screenshots. */
  simulatorStream: z.enum(['smooth', 'compatible']),
  sidebarCollapsed: z.boolean(),
  onboardingDone: z.boolean(),
  trayHintShown: z.boolean(),
  recentProjects: z.array(recentProjectSchema).max(50),
  lastProject: z.string().max(4096).nullable(),
  /** Per project: the Mac and target picked in the toolbar. */
  projectPrefs: z.record(z.string().max(4096), z.object({ mac: z.string().max(100).optional(), target: z.string().max(64).optional() })),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  editor: 'vscode',
  notifications: true,
  keepInTray: true,
  consoleLimit: 100_000,
  consoleTimestamps: true,
  consoleWrap: true,
  osLogs: false,
  verbose: false,
  dependencyWarnings: false,
  deviceFrame: true,
  simulatorStream: 'smooth',
  sidebarCollapsed: false,
  onboardingDone: false,
  trayHintShown: false,
  recentProjects: [],
  lastProject: null,
  projectPrefs: {},
};

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  agent: string;
  platform: string;
  arch: string;
  osRelease: string;
  packaged: boolean;
  dev: boolean;
  configDir: string;
  /** "#rrggbb" of the Windows accent colour. */
  accent: string | null;
  /** Windows 11 Mica backdrop is on. */
  mica: boolean;
  /** The Windows user name (a good first guess for the Mac user name). */
  userName: string;
}

/** IPC channels handled by main (renderer → main, invoke). */
export const appChannels = {
  'app:info': z.undefined(),
  'app:get-settings': z.undefined(),
  'app:set-settings': settingsPatchSchema,
  'app:pick-folder': z.undefined(),
  'app:open-in-editor': z.object({ file: fsPath, line: z.number().int().min(1).optional(), column: z.number().int().min(1).optional() }).strict(),
  'app:show-in-folder': z.object({ path: fsPath }).strict(),
  'app:open-path': z.object({ path: fsPath }).strict(),
  'app:open-external': z.object({ url: z.string().url().max(2048).refine((u) => /^https:\/\//.test(u), 'only https links') }).strict(),
  'app:project-icon': z.object({ path: fsPath }).strict(),
  'app:save-image': z.object({ data: z.union([z.instanceof(ArrayBuffer), z.instanceof(Uint8Array)]), name: text(200) }).strict(),
  'app:copy-image': z.object({ data: z.union([z.instanceof(ArrayBuffer), z.instanceof(Uint8Array)]) }).strict(),
  'app:save-text': z.object({ text: z.string().max(200 * 1024 * 1024), name: text(200) }).strict(),
  /** With `projectPath` and the Mac's desktop as `udid`: the project's Electron app's windows. */
  'app:screen-open': z.object({
    mac: macName,
    udid,
    maxSize: z.number().int().min(320).max(4096).optional(),
    projectPath: fsPath.optional(),
    /** A real iPhone or iPad plugged into the Mac, not a simulator. */
    device: z.object({ name: z.string().max(200) }).strict().optional(),
  }).strict(),
  'app:project-opened': z.object({ path: fsPath, name: z.string().max(200), appId: z.string().max(200) }).strict(),
  'app:forget-project': z.object({ path: fsPath }).strict(),
  'app:engine-call': z.object({ method: z.string().max(64), params: z.unknown() }).strict(),
  'app:prompt-response': promptResponseSchema,
  'app:visibility': z.object({ visible: z.boolean() }).strict(),
  'app:takeover-status': z.undefined(),
  'app:takeover-set': z.object({ on: z.boolean() }).strict(),
  'app:skills-status': z.object({ projectDir: fsPath.optional() }).strict(),
  'app:skills-install': z.object({ ...skillTarget, force: z.boolean().optional() }).strict().refine(hasProject, 'a project skill needs projectDir'),
  'app:skills-remove': z.object(skillTarget).strict().refine(hasProject, 'a project skill needs projectDir'),
  'app:capmac-command': z.object({ install: z.boolean() }).strict(),
  'app:update-status': z.undefined(),
  'app:update-check': z.undefined(),
  /** Quit and install the downloaded update (asks first when a session is running). */
  'app:update-install': z.undefined(),
} as const;

export type AppChannel = keyof typeof appChannels;

export interface AppResults {
  'app:info': AppInfo;
  'app:get-settings': Settings;
  'app:set-settings': Settings;
  'app:pick-folder': string | null;
  'app:open-in-editor': void;
  'app:show-in-folder': void;
  'app:open-path': void;
  'app:open-external': void;
  'app:project-icon': string | null;
  'app:save-image': string | null;
  'app:copy-image': void;
  'app:save-text': string | null;
  'app:screen-open': { streamId: string };
  'app:project-opened': void;
  'app:forget-project': void;
  'app:engine-call': CallResult<unknown>;
  'app:prompt-response': void;
  'app:visibility': void;
  'app:takeover-status': TakeoverInfo;
  'app:takeover-set': TakeoverInfo;
  'app:skills-status': SkillsInfo;
  'app:skills-install': SkillChange[];
  'app:skills-remove': SkillChange[];
  'app:capmac-command': CapmacCommandStatus;
  'app:update-status': UpdateInfo;
  'app:update-check': UpdateInfo;
  'app:update-install': void;
}

/** Where capmac Studio's own update stands. */
export type UpdateState =
  /** Updates are off: a development build, or a build with no update feed. */
  | { state: 'unavailable'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; checkedAt: number }
  /** A newer version exists; the portable exe can't install it, so it links to the download. */
  | { state: 'available'; version: string; download?: string }
  | { state: 'downloading'; version: string; percent: number }
  /** Downloaded: installs on restart, or when capmac Studio quits. */
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string; checkedAt: number };

export interface UpdateInfo {
  current: string;
  /** The portable exe: it checks, but cannot update itself. */
  portable: boolean;
  /** Where updates come from (the feed's host), or null when there is none. */
  feed: string | null;
  /** Release notes for the version on offer (or the current one), when the build knows where they are. */
  notesUrl: string | null;
  state: UpdateState;
}

/** Takeover: `npx cap run ios` and `ionic capacitor run ios` typed in a terminal run on the Mac. */
export interface TakeoverInfo extends TakeoverStatus {
  /** The capmac that runs them is the one inside capmac Studio (not an npm install of the CLI). */
  bundled: boolean;
}

/** The capmac skill for AI coding agents: where it is, for every agent capmac knows. */
export interface SkillsInfo {
  version: string;
  /** Where a project skill goes for the project asked about (its repository root). */
  projectRoot: string | null;
  agents: AgentSkillStatus[];
  /** Agents run `capmac` as a command: whether new terminals can. */
  command: CapmacCommandStatus;
}

/** Commands main sends to the renderer (tray, second instance, menu). */
export type AppCommand =
  | { type: 'open-project'; path: string }
  | { type: 'start'; mode: 'run' | 'live'; projectPath?: string }
  | { type: 'stop' }
  | { type: 'navigate'; to: 'home' | 'settings' | 'macs' | 'devices' };

/** Engine calls resolve with this envelope; errors keep their hint and details across IPC. */
export type CallResult<T> = { ok: true; value: T } | { ok: false; error: ErrorInfo };

/** The API the preload script exposes as `window.capmac`. */
export interface CapmacApi {
  invoke<C extends AppChannel>(channel: C, payload?: z.input<(typeof appChannels)[C]>): Promise<AppResults[C]>;
  call<M extends EngineMethod>(method: M, params: MethodParams<M>): Promise<CallResult<MethodResults[M]>>;
  onEvents(listener: (batch: Envelope[]) => void): () => void;
  onPrompt(listener: (prompt: PromptRequest) => void): () => void;
  /** The engine took a question back: it no longer needs an answer. */
  onPromptWithdraw(listener: (id: string) => void): () => void;
  onEngineStatus(listener: (status: EngineStatus) => void): () => void;
  onSettings(listener: (settings: Settings) => void): () => void;
  onCommand(listener: (command: AppCommand) => void): () => void;
  onAccent(listener: (accent: string | null) => void): () => void;
  onUpdate(listener: (info: UpdateInfo) => void): () => void;
  /** Local path of a file or folder dropped on the window. */
  pathForFile(file: File): string;
  /** The page is listening: main re-sends state it may have missed (open prompts, engine status). */
  ready(): void;
}

declare global {
  interface Window {
    capmac: CapmacApi;
  }
}
