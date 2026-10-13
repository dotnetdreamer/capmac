/**
 * The contract between capmac Studio's processes: renderer ⇄ main ⇄ engine
 * host. Every renderer request is validated in main with these schemas
 * before it reaches the engine; screen input arriving on a MessagePort is
 * validated by the engine host.
 */
import { z } from 'zod';
import type { ErrorInfo } from '@capmac/core/engine/errors';
import type { ConnectionState, EngineEvent, FixId, SessionMode } from '@capmac/core/engine/events';
import type { ProbeResult, ScreenInfo, StreamFallback, TargetsResult } from '@capmac/core/shared/protocol';
import { PUBLIC_KEY_RE, RELAY_CHOICES, ROUTE_CHOICES } from '@capmac/core/shared/remote';
import type { RemoteSettings, RemoteTestResult, Route, SignalServerSetting } from '@capmac/core/shared/remote';
import type { RemoteDoorStatus, RemotePc } from '@capmac/core/shared/remote-door';
import type { AgentSkillStatus, CapmacCommandStatus, SkillChange } from '@capmac/core/shared/skills';
import type { TakeoverStatus } from '@capmac/core/shared/takeover';

export type { ErrorInfo } from '@capmac/core/engine/errors';
export type { AppLogEntry, Check, CheckLevel, ConnectionState, EngineEvent, FixId, Phase, SessionMode, SessionState, StepStatus } from '@capmac/core/engine/events';
export type { Diagnostic, InputEvent, ProbeResult, ScreenInfo, StreamFallback, StreamHelperState, Target, TargetsResult } from '@capmac/core/shared/protocol';
export type { RelayChoice, RemoteSettings, RemoteTestResult, Route, RouteChoice, SignalServerSetting } from '@capmac/core/shared/remote';
export type { RemoteDoorStatus, RemotePc } from '@capmac/core/shared/remote-door';

// ─── Values ────────────────────────────────────────────────────────────────

const text = (max: number) => z.string().min(1).max(max);
const macName = text(100);
const fsPath = text(4096);
const udid = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'not a device id');
const id = z.string().regex(/^[a-z0-9-]{1,64}$/);
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
  'projects.syncSize': z.object({ path: fsPath }).strict(),
  'projects.createSample': z.object({}).strict(),
  'projects.installDeps': z.object({ path: fsPath }).strict(),
  'sessions.start': z.object({
    projectPath: fsPath,
    mode: z.enum(['run', 'live']),
    mac: macName.optional(),
    target: udid.optional(),
    options: sessionOptionsSchema.optional(),
  }).strict(),
  'sessions.stop': z.object({ sessionId: id }).strict(),
  'sessions.rebuild': z.object({ sessionId: id, clean: z.boolean().optional() }).strict(),
  'sessions.relaunch': z.object({ sessionId: id }).strict(),
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
  'screen.screenshot': z.object({ mac: macName, udid }).strict(),
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
}

export interface DiscoveredMac {
  name: string;
  host: string;
  port: number;
  addresses: string[];
}

export interface ProjectSummary {
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
  'projects.syncSize': { files: number; bytes: number };
  'projects.createSample': { path: string };
  'projects.installDeps': void;
  'sessions.start': { sessionId: string };
  'sessions.stop': void;
  'sessions.rebuild': void;
  'sessions.relaunch': void;
  'builds.ipa': { sessionId: string };
  'xcode.open': void;
  'logs.buildLog': { text: string };
  'screen.stop': void;
  'screen.screenshot': { png: ArrayBuffer; width: number | null; height: number | null };
  'debug.dropConnection': void;
  'remote.server': SignalServerSetting;
  'remote.setServer': SignalServerSetting;
  'macs.remote.enable': { mac: MacSummary; test: RemoteTestResult | null };
  'macs.remote.disable': MacSummary;
  'macs.remote.set': { mac: MacSummary; reconnecting: boolean };
  'macs.remote.status': RemoteStatusReport;
  'macs.remote.revoke': Array<RemotePc & { current: boolean }>;
  'macs.remote.test': RemoteTestResult;
}

// ─── Events ────────────────────────────────────────────────────────────────

/** Who an event is about. */
export interface Scope {
  sessionId?: string;
  projectPath?: string;
  mac?: string;
  watchId?: string;
  streamId?: string;
}

/** Engine events plus the host's own bookkeeping. */
export type HostEvent =
  | EngineEvent
  | { type: 'session-started'; mode: SessionMode; projectPath: string; mac: string | null; target: string | null }
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
  | { id: string; kind: 'password'; purpose: 'pair' | 'keychain' | 'sudo'; message: string; mac?: string; user?: string }
  | { id: string; kind: 'confirm'; message: string; detail?: string; danger?: boolean; confirmLabel?: string; defaultYes?: boolean }
  | { id: string; kind: 'choose'; message: string; items: Array<{ label: string; hint?: string }> }
  | { id: string; kind: 'text'; message: string; defaultValue?: string; placeholder?: string };

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
  /** The Mac's clock minus this PC's (µs), for the latency readout. */
  | { type: 'clock'; offsetUs: number; rttUs: number }
  /** Smooth stream: the bitrate adaptive bitrate chose, and frames dropped to catch up (every few seconds). */
  | { type: 'status'; bitrate: number | null; dropped: number };

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
  | { type: 'retry-smooth' };

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
  'app:screen-open': z.object({ mac: macName, udid, maxSize: z.number().int().min(320).max(4096).optional() }).strict(),
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
