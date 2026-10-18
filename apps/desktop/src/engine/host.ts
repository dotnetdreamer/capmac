/**
 * capmac Studio's engine host. Runs @capmac/core in an Electron utility
 * process, so SSH crypto, file hashing and compression never block the main
 * process or the UI. Main forwards validated renderer requests here; engine
 * events go back in batches (at most one message per frame).
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { MessagePortMain } from 'electron';
import {
  appFor,
  applyFix,
  AppScreenStream,
  backendOf,
  bootSimulator,
  buildApp,
  buildFlutterOnMac,
  CancelledError,
  chooseApp,
  chooseBackend,
  disableRemote,
  discoverMacs,
  ElectronLiveSession,
  enableRemote,
  findApps,
  FlutterLiveSession,
  FlutterPcLiveSession,
  ReactNativeLiveSession,
  ReactNativePcLiveSession,
  inspectProject,
  installLocalDependencies,
  LiveSession,
  loadGlobalConfig,
  loadProject,
  localChecks,
  MAC_TARGET_ID,
  MacLink,
  macChecks,
  openInXcode,
  pairMac,
  PC_TARGET_ID,
  readFromMac,
  remoteChecks,
  remoteDoorStatus,
  remoteSettings,
  requireIos,
  resolveHost,
  restoreAppChoices,
  soundFor,
  revokeRemotePc,
  runApp,
  runElectronApp,
  runFlutterOnMac,
  runFlutterOnPc,
  runReactNativeOnMac,
  runReactNativeOnPc,
  runsOnMac,
  ScreenStream,
  setAgentBundlePath,
  setDefaultMac,
  setNodeDataChannelDir,
  setRemoteOptions,
  setSignalServer,
  signalServer,
  testRemote,
  thisPc,
  shutdownSimulator,
  summarizeProject,
  syncApp,
  syncSize,
  takeAppScreenshot,
  takeScreenshot,
  TargetWatch,
  toErrorInfo,
  unlockKeychain,
  unpairMac,
  UserError,
  type Check,
  type EngineContext,
  type HostConfig,
  type ProjectInfo,
  type Prompter,
  type VideoPacket,
} from '@capmac/core/engine';
import { PhoneScreen, iphoneTouchState, iphoneTouchTarget, mirrorReceiver, setUpIphoneTouch, receiverInstalled, setBundledReceiver } from '@capmac/core/engine/iphone/index';
import { isSoundMode } from '@capmac/core/shared/electron';
import { STREAM_CONFIG } from '@capmac/core/shared/stream';
import type { ProbeResult, Target, TargetsResult } from '@capmac/core/shared/protocol';
import type { RemoteDoorStatus } from '@capmac/core/shared/remote-door';
import {
  inputEventSchema,
  phoneTargetSchema,
  type CallResult,
  type EngineMethod,
  type Envelope,
  type HealthReport,
  type HostEvent,
  type MacSummary,
  type MethodParams,
  type MethodResults,
  type PromptRequest,
  type PromptResponse,
  type Scope,
  type ScreenPortCommand,
  type ScreenPortMessage,
} from '../shared/contract.js';
import type { HostInit, HostSettings, HostToMain, MainToHost } from '../shared/host-protocol.js';
import { t } from '../shared/i18n/index.js';
import { createWslHost } from './wsl-host.js';

const parent = process.parentPort;
let init: HostInit | null = null;
let settings: HostSettings = { verbose: false, osLogs: false };
let visible = true;

function send(message: HostToMain): void {
  parent.postMessage(message);
}

// ─── Events, batched ───────────────────────────────────────────────────────

let queue: Envelope[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function emit(scope: Scope, event: HostEvent): void {
  queue.push({ scope, event });
  flushTimer ??= setTimeout(flush, 16);
}

function flush(): void {
  flushTimer = null;
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  send({ kind: 'events', batch });
}

let nextId = 1;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;

// ─── Prompts: the engine asks, the renderer answers with a dialog ─────────

const pendingPrompts = new Map<string, (response: PromptResponse) => void>();

type PromptBody = PromptRequest extends infer P ? (P extends unknown ? Omit<P, 'id'> : never) : never;

/** `signal` takes the question back: the dialog closes and the answer is "no". */
function ask(prompt: PromptBody, signal?: AbortSignal): Promise<PromptResponse> {
  const id = newId('p');
  if (signal?.aborted) return Promise.resolve({ id, ok: false });
  return new Promise((resolve) => {
    const withdraw = () => {
      if (!pendingPrompts.delete(id)) return;
      send({ kind: 'prompt-withdraw', id });
      resolve({ id, ok: false });
    };
    pendingPrompts.set(id, (response) => {
      signal?.removeEventListener('abort', withdraw);
      resolve(response);
    });
    signal?.addEventListener('abort', withdraw, { once: true });
    send({ kind: 'prompt', prompt: { ...prompt, id } as PromptRequest });
  });
}

const prompter: Prompter = {
  interactive: true,
  async password(request) {
    const r = await ask({ kind: 'password', purpose: request.purpose, message: request.message, mac: request.mac, user: request.user });
    if (!r.ok || typeof r.value !== 'string') throw new CancelledError();
    return r.value;
  },
  async confirm(request) {
    const r = await ask({
      kind: 'confirm', message: request.message, detail: request.detail, danger: request.danger, confirmLabel: request.confirmLabel,
      cancelLabel: request.cancelLabel, defaultYes: request.defaultYes, link: request.link, waiting: request.waiting,
    }, request.signal);
    return r.ok && r.value === true;
  },
  async choose(request) {
    const r = await ask({ kind: 'choose', message: request.message, detail: request.detail, items: request.items.map(({ label, hint }) => ({ label, hint })) });
    const item = r.ok && typeof r.value === 'number' ? request.items[r.value] : undefined;
    if (!item) throw new CancelledError();
    return item.value;
  },
  async text(request) {
    const r = await ask({ kind: 'text', message: request.message, defaultValue: request.defaultValue, placeholder: request.placeholder, purpose: request.purpose });
    if (!r.ok || typeof r.value !== 'string') throw new CancelledError();
    return r.value;
  },
};

function contextFor(scope: Scope): EngineContext {
  return { emit: (event) => emit(scope, event), prompter, verbose: settings.verbose };
}

/** Building on this PC, with no Mac (`capmac wsl …`). */
const wslHost = createWslHost({ emit, contextFor, newId });

// ─── Macs ──────────────────────────────────────────────────────────────────

const links = new Map<string, MacLink>();

function link(name: string): MacLink {
  let l = links.get(name);
  if (!l || l.closed) {
    l = new MacLink(name, contextFor({ mac: name }), { autoReconnect: true });
    links.set(name, l);
  }
  return l;
}

async function hostConfig(name: string): Promise<HostConfig> {
  const host = resolveHost(await loadGlobalConfig(), name);
  if (!host) throw new UserError(t.host.noSuchMac(name), t.host.pairAgain);
  return host;
}

async function defaultMacName(): Promise<string> {
  const config = await loadGlobalConfig();
  const host = resolveHost(config);
  if (!host) {
    if (Object.keys(config.hosts).length === 0) throw new UserError(t.host.noMacYet, t.host.pairOneInMacs);
    throw new UserError(t.host.noDefault, t.host.noDefaultHint);
  }
  return host.name;
}

function summarize(host: HostConfig, defaultHost: string | undefined): MacSummary {
  const l = links.get(host.name);
  return {
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    label: host.macName ?? host.host,
    xcode: host.xcode ?? null,
    macos: host.macos ?? null,
    isDefault: defaultHost === host.name,
    pairedAt: host.pairedAt,
    state: l ? (l.state === 'idle' ? 'idle' : l.state) : 'idle',
    latencyMs: l?.latencyMs ?? null,
    error: l?.lastError ?? null,
    remote: remoteSettings(host),
    route: l?.connected ? l.route : null,
    rttMs: l?.currentSession?.rttMs ?? null,
  };
}

async function summaryOf(name: string): Promise<MacSummary> {
  const config = await loadGlobalConfig();
  const host = resolveHost(config, name);
  if (!host) throw new UserError(t.host.noSuchMac(name));
  return summarize(host, config.defaultHost);
}

/** Something is running on this Mac that a reconnect would interrupt. */
function macBusy(name: string): boolean {
  return [...sessions.values()].some((s) => s.mac === name);
}

async function listMacSummaries(): Promise<MacSummary[]> {
  const config = await loadGlobalConfig();
  return Object.values(config.hosts).map((h) => summarize(h, config.defaultHost));
}

/** Node.js on this PC (the web build and the dev server need it). */
function pcNodeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'node.exe' : 'node', ['--version'], { timeout: 10_000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function health(name: string, projectPath?: string): Promise<HealthReport> {
  const scope = { mac: name };
  const host = await hostConfig(name);
  const project = projectPath ? await loadProject(projectPath).catch(() => null) : null;
  const nodeVersion = await pcNodeVersion();
  const pc: Check[] = localChecks(project, host, nodeVersion ?? 'v0.0.0').map((c) =>
    c.id === 'pc-node' && !nodeVersion ? { ...c, level: 'warn', label: t.host.pcNode, detail: t.host.notFound, fix: t.host.pcNodeFix } : c);
  for (const check of pc) emit(scope, { type: 'check', check });
  const l = link(name);
  const started = Date.now();
  let session;
  try {
    session = await l.session();
  } catch (err) {
    const info = toErrorInfo(err);
    const check: Check = { id: 'connect', group: 'mac', level: 'fail', label: t.host.connectTo(host.macName ?? host.host), detail: info.message, fix: info.hint ?? t.host.connectFix };
    emit(scope, { type: 'check', check });
    return { mac: name, checks: [...pc, check], probe: null, latencyMs: null };
  }
  const latencyMs = Date.now() - started;
  const probe = await session.call<ProbeResult>('probe');
  const door = await remoteDoorStatus(session).catch(() => null);
  const mac = [...macChecks(probe, project), ...remoteChecks(host, door, session.route, (await thisPc()).key)];
  for (const check of mac) emit(scope, { type: 'check', check });
  return { mac: name, checks: [...pc, ...mac], probe, latencyMs: l.latencyMs ?? latencyMs };
}

// ─── Targets ───────────────────────────────────────────────────────────────

const watches = new Map<string, { watch: TargetWatch; ids: Set<string> }>();

function watchTargets(mac: string): { watchId: string; targets: TargetsResult | null } {
  let entry = watches.get(mac);
  if (!entry) {
    const watch = new TargetWatch(
      link(mac),
      (targets) => emit({ mac }, { type: 'targets', targets }),
      (error) => emit({ mac }, { type: 'error', error }),
      { simulatorsEveryMs: 4000, devicesEveryMs: 15_000 },
    );
    entry = { watch, ids: new Set() };
    watches.set(mac, entry);
  }
  const watchId = newId('w');
  entry.ids.add(watchId);
  if (visible) void entry.watch.start();
  return { watchId, targets: entry.watch.latest };
}

function unwatchTargets(watchId: string): void {
  for (const [mac, entry] of watches) {
    if (!entry.ids.delete(watchId)) continue;
    if (entry.ids.size === 0) {
      entry.watch.dispose();
      watches.delete(mac);
    }
  }
}

async function findTarget(mac: string, udid: string): Promise<Target> {
  const known = watches.get(mac)?.watch.latest;
  const all = known ?? (await (await link(mac).session()).call<TargetsResult>('targets'));
  const target = [...all.simulators, ...all.devices].find((item) => item.udid === udid);
  if (!target) throw new UserError(t.host.targetGone, t.host.targetGoneHint);
  return target;
}

// ─── Sessions (run, live, ipa, sync) ───────────────────────────────────────

interface HostSession {
  id: string;
  mode: 'run' | 'live' | 'ipa' | 'sync';
  projectPath: string;
  /** None when it builds on this PC. */
  mac: string | null;
  controller: AbortController;
  /** Live reload: an iOS app's, an Electron app's on the Mac's desktop, or a Flutter app's (on the Mac, or its Windows app here). */
  live: LiveSession | ElectronLiveSession | FlutterLiveSession | FlutterPcLiveSession | ReactNativeLiveSession | ReactNativePcLiveSession | null;
  done: Promise<void>;
}

/** Live reload until stopped: starts it, and ends the session when it fails or is stopped. */
function untilStopped(live: NonNullable<HostSession['live']>, controller: AbortController, end: (err?: unknown) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      void live.stop().then(() => {
        end();
        resolve();
      });
    };
    live.start().then(
      () => {
        // Stays up until stopped (it may have been stopped while starting).
        if (controller.signal.aborted) finish();
        else controller.signal.addEventListener('abort', finish, { once: true });
      },
      (err) => {
        end(err);
        resolve();
      },
    );
  });
}

const sessions = new Map<string, HostSession>();

function sessionFor(projectPath: string): HostSession | undefined {
  const key = projectPath.toLowerCase();
  return [...sessions.values()].find((s) => s.projectPath.toLowerCase() === key);
}

async function stopSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  session.controller.abort();
  if (session.live) await session.live.stop();
  await session.done.catch(() => undefined);
}

async function startSession(params: MethodParams<'sessions.start'> | (MethodParams<'builds.ipa'> & { mode: 'ipa' })): Promise<{ sessionId: string }> {
  const existing = sessionFor(params.projectPath);
  if (existing) await stopSession(existing.id);
  const project = await loadProject(params.projectPath);
  // Sync is Capacitor's `cap sync ios`, on the Mac.
  if (params.mode === 'sync' && (project.kind === 'flutter' || project.kind === 'react-native')) throw new UserError(t.host.syncCapacitorOnly, t.host.syncCapacitorOnlyHint);
  if (project.kind === 'flutter') return startFlutterSession(params, project);
  if (project.kind === 'react-native') return startReactNativeSession(params, project);
  // The app asked for (the toolbar's app picker), else the Mac's desktop as the target, else the one picked for the project.
  // A sync is the iOS app's (`cap sync ios`).
  const onMac = params.mode !== 'ipa' && params.mode !== 'sync' && runsOnMac(project, { app: 'app' in params ? params.app : undefined, target: 'target' in params && params.target === MAC_TARGET_ID ? 'mac' : undefined });
  if (!onMac) requireIos(project);
  // An Electron app runs on the Mac's desktop; the iOS app builds where the project builds.
  if (params.mode !== 'ipa' && !onMac && ((params.backend ?? (await backendOf(project))) === 'wsl')) return startPcSession(params, project);
  if (params.mode === 'build') throw new UserError(t.host.buildOnPcOnly, t.host.buildOnPcOnlyHint);
  const mac = params.mac ?? project.config.host ?? (await defaultMacName());
  const id = newId('s');
  const scope: Scope = { sessionId: id, projectPath: project.capDir, mac };
  const ctx = contextFor(scope);
  const controller = new AbortController();
  const l = link(mac);
  const started = Date.now();
  const target = 'target' in params && !onMac && params.mode !== 'sync' && params.target !== MAC_TARGET_ID ? params.target : undefined;
  // Run without building: the timeline and "Try again" keep to it.
  const keepsWebFiles = params.mode === 'run' && params.options?.webBuild === false;
  emit(scope, { type: 'session-started', mode: params.mode, projectPath: project.capDir, mac, target: onMac ? MAC_TARGET_ID : target ?? null, ...(keepsWebFiles ? { webBuild: false as const } : {}) });
  const end = (err?: unknown) => {
    sessions.delete(id);
    const info = err === undefined ? undefined : toErrorInfo(err);
    const cancelled = Boolean(info?.cancelled) || controller.signal.aborted;
    emit(scope, { type: 'session-ended', mode: params.mode, ok: err === undefined || cancelled, cancelled, error: cancelled ? undefined : info, ms: Date.now() - started });
  };
  const session: HostSession = { id, mode: params.mode, projectPath: project.capDir, mac, controller, live: null, done: Promise.resolve() };
  sessions.set(id, session);

  if (params.mode === 'run' && onMac) {
    const options = params.options ?? {};
    session.done = runElectronApp(project, l, { full: options.full || options.clean, webBuild: options.webBuild }, ctx, controller.signal).then(() => end(), end);
  } else if (params.mode === 'run') {
    const options = params.options ?? {};
    session.done = runApp(project, l, { target, ...options, osLogs: options.osLogs ?? settings.osLogs }, ctx, controller.signal).then(() => end(), end);
  } else if (params.mode === 'sync') {
    const options = params.options ?? {};
    session.done = l.session().then((s) => syncApp(project, s, { full: options.full }, ctx, controller.signal)).then(() => end(), end);
  } else if (params.mode === 'live') {
    const options = params.options ?? {};
    const live = onMac
      ? new ElectronLiveSession(project, l, { full: options.full || options.clean }, ctx)
      : new LiveSession(project, l, { target, clean: options.clean, full: options.full, configuration: options.configuration, showSimulator: options.showSimulator, osLogs: options.osLogs ?? settings.osLogs }, ctx);
    session.live = live;
    session.done = untilStopped(live, controller, end);
  } else {
    const p = params as MethodParams<'builds.ipa'>;
    session.done = buildApp(project, l, { ipa: true, exportKind: p.exportKind, upload: p.upload, outDir: p.outDir, team: p.team }, ctx, controller.signal).then((result) => {
      if (result.kind === 'ipa') emit(scope, { type: 'ipa-ready', file: result.file, size: result.size });
      end();
    }, end);
  }
  return { sessionId: id };
}

/** Run, live or build on this PC: no Mac, the iPhone plugged into this PC. */
function startPcSession(params: MethodParams<'sessions.start'>, project: ProjectInfo): { sessionId: string } {
  // Sync copies the project to a Mac: here every Run brings it up to date.
  if (params.mode === 'sync') throw new UserError(t.host.syncMacOnly, t.host.syncMacOnlyHint);
  const id = newId('s');
  const scope: Scope = { sessionId: id, projectPath: project.capDir };
  const ctx = contextFor(scope);
  const controller = new AbortController();
  const started = Date.now();
  // A build here makes the .ipa: it shows like the Mac's IPA builds.
  const mode = params.mode === 'build' ? 'ipa' : params.mode;
  const target = params.target && params.target !== MAC_TARGET_ID ? params.target : undefined;
  // Run without building: the timeline and "Try again" keep to it.
  const keepsWebFiles = params.mode === 'run' && params.options?.webBuild === false;
  emit(scope, { type: 'session-started', mode, projectPath: project.capDir, mac: null, target: target ?? null, backend: 'wsl', ...(keepsWebFiles ? { webBuild: false as const } : {}) });
  const end = (err?: unknown) => {
    sessions.delete(id);
    const info = err === undefined ? undefined : toErrorInfo(err);
    const cancelled = Boolean(info?.cancelled) || controller.signal.aborted;
    emit(scope, { type: 'session-ended', mode, ok: err === undefined || cancelled, cancelled, error: cancelled ? undefined : info, ms: Date.now() - started });
  };
  const session: HostSession = { id, mode, projectPath: project.capDir, mac: null, controller, live: null, done: Promise.resolve() };
  sessions.set(id, session);
  session.done = wslHost.session(params.mode, project, target, ctx, controller.signal, (file, size) => emit(scope, { type: 'ipa-ready', file, size }), { clean: params.options?.clean, webBuild: params.options?.webBuild, flutterMode: params.options?.flutterMode, configuration: params.options?.configuration }).then(() => end(), end);
  return { sessionId: id };
}

/**
 * A React Native app: its iOS app (in a simulator or on a device through the
 * Mac, or on an iPhone plugged into this PC), its Mac app (react-native-macos,
 * on the Mac's desktop, its window here) or its Windows app
 * (react-native-windows, on this PC, in its own window). Metro runs on this
 * PC for all of them: a save shows in the app at once.
 */
async function startReactNativeSession(params: MethodParams<'sessions.start'> | (MethodParams<'builds.ipa'> & { mode: 'ipa' }), project: ProjectInfo): Promise<{ sessionId: string }> {
  const picked = 'target' in params ? params.target : undefined;
  const app = params.mode === 'ipa' ? 'ios' : appFor(project, { app: 'app' in params ? params.app : undefined, target: picked === MAC_TARGET_ID ? 'mac' : picked === PC_TARGET_ID ? 'pc' : undefined });
  // An .ipa of a React Native app is made on this PC (it signs with this PC's setup).
  if (params.mode === 'ipa') throw new UserError(t.host.reactNativeIpaOnPc, t.host.reactNativeIpaOnPcHint);
  const options = params.options ?? {};
  const onPc = app === 'windows';
  // The iOS app builds where the project builds: through the Mac, or on this PC.
  if (app === 'ios' && (params.backend ?? (await backendOf(project))) === 'wsl') return startPcSession(params, project);
  if (params.mode === 'build') throw new UserError(t.host.buildOnPcOnly, t.host.buildOnPcOnlyHint);
  const mac = onPc ? null : params.mac ?? project.config.host ?? (await defaultMacName());
  const id = newId('s');
  const scope: Scope = { sessionId: id, projectPath: project.capDir, ...(mac ? { mac } : {}) };
  const ctx = contextFor(scope);
  const controller = new AbortController();
  const started = Date.now();
  const target = app === 'ios' && picked !== MAC_TARGET_ID && picked !== PC_TARGET_ID ? picked : undefined;
  emit(scope, { type: 'session-started', mode: params.mode, projectPath: project.capDir, mac, target: app === 'macos' ? MAC_TARGET_ID : onPc ? PC_TARGET_ID : target ?? null });
  const end = (err?: unknown) => {
    sessions.delete(id);
    const info = err === undefined ? undefined : toErrorInfo(err);
    const cancelled = Boolean(info?.cancelled) || controller.signal.aborted;
    emit(scope, { type: 'session-ended', mode: params.mode, ok: err === undefined || cancelled, cancelled, error: cancelled ? undefined : info, ms: Date.now() - started });
  };
  const session: HostSession = { id, mode: params.mode, projectPath: project.capDir, mac, controller, live: null, done: Promise.resolve() };
  sessions.set(id, session);
  const release = options.configuration === 'Release';
  if (onPc) {
    if (params.mode === 'live') {
      session.live = new ReactNativePcLiveSession(project, {}, ctx);
      session.done = untilStopped(session.live, controller, end);
    } else {
      session.done = runReactNativeOnPc(project, { release }, ctx, controller.signal).then(() => end(), end);
    }
    return { sessionId: id };
  }
  const l = link(mac!);
  const macApp = app === 'macos' ? 'macos' : 'ios';
  const common = { app: macApp, target, clean: options.clean, configuration: options.configuration, showSimulator: options.showSimulator, osLogs: options.osLogs ?? settings.osLogs } as const;
  if (params.mode === 'run') {
    session.done = runReactNativeOnMac(project, l, common, ctx, controller.signal).then(() => end(), end);
  } else {
    session.live = new ReactNativeLiveSession(project, l, common, ctx);
    session.done = untilStopped(session.live, controller, end);
  }
  return { sessionId: id };
}

/**
 * A Flutter app: its iOS app (in a simulator or on a device through the Mac,
 * or on an iPhone plugged into this PC), its Mac app (on the Mac's desktop,
 * its window here) or its Windows app (on this PC, in its own window).
 */
async function startFlutterSession(params: MethodParams<'sessions.start'> | (MethodParams<'builds.ipa'> & { mode: 'ipa' }), project: ProjectInfo): Promise<{ sessionId: string }> {
  const picked = 'target' in params ? params.target : undefined;
  // An IPA is the iOS app's, whichever app is picked.
  const app = params.mode === 'ipa' ? 'ios' : appFor(project, { app: 'app' in params ? params.app : undefined, target: picked === MAC_TARGET_ID ? 'mac' : picked === PC_TARGET_ID ? 'pc' : undefined });
  if (params.mode === 'ipa' && !project.flutter?.platforms.ios) throw new UserError(t.host.flutterIpaIosOnly);
  if (params.mode === 'ipa' && params.upload) throw new UserError(t.host.flutterNoUpload, t.host.flutterNoUploadHint);
  const options = params.mode === 'ipa' ? {} : params.options ?? {};
  const mode = options.flutterMode;
  const onPc = app === 'windows';
  // The iOS app builds where the project builds: through the Mac, or on this PC.
  if (app === 'ios' && params.mode !== 'ipa' && (params.backend ?? (await backendOf(project))) === 'wsl') return startPcSession(params, project);
  if (params.mode === 'build') throw new UserError(t.host.buildOnPcOnly, t.host.buildOnPcOnlyHint);
  const mac = onPc ? null : params.mac ?? project.config.host ?? (await defaultMacName());
  const id = newId('s');
  const scope: Scope = { sessionId: id, projectPath: project.capDir, ...(mac ? { mac } : {}) };
  const ctx = contextFor(scope);
  const controller = new AbortController();
  const started = Date.now();
  const target = app === 'ios' && picked !== MAC_TARGET_ID && picked !== PC_TARGET_ID ? picked : undefined;
  emit(scope, { type: 'session-started', mode: params.mode, projectPath: project.capDir, mac, target: app === 'macos' ? MAC_TARGET_ID : onPc ? PC_TARGET_ID : target ?? null });
  const end = (err?: unknown) => {
    sessions.delete(id);
    const info = err === undefined ? undefined : toErrorInfo(err);
    const cancelled = Boolean(info?.cancelled) || controller.signal.aborted;
    emit(scope, { type: 'session-ended', mode: params.mode, ok: err === undefined || cancelled, cancelled, error: cancelled ? undefined : info, ms: Date.now() - started });
  };
  const session: HostSession = { id, mode: params.mode, projectPath: project.capDir, mac, controller, live: null, done: Promise.resolve() };
  sessions.set(id, session);
  if (onPc) {
    if (params.mode === 'live') {
      session.live = new FlutterPcLiveSession(project, {}, ctx);
      session.done = untilStopped(session.live, controller, end);
    } else {
      session.done = runFlutterOnPc(project, { mode }, ctx, controller.signal).then(() => end(), end);
    }
    return { sessionId: id };
  }
  const l = link(mac!);
  const macApp = app === 'macos' ? 'macos' : 'ios';
  if (params.mode === 'run') {
    session.done = runFlutterOnMac(project, l, { app: macApp, target, mode }, ctx, controller.signal).then(() => end(), end);
  } else if (params.mode === 'live') {
    session.live = new FlutterLiveSession(project, l, { app: macApp, target }, ctx);
    session.done = untilStopped(session.live, controller, end);
  } else {
    const p = params as MethodParams<'builds.ipa'>;
    session.done = buildFlutterOnMac(project, l, { app: 'ios', what: 'ipa', exportMethod: p.exportKind, team: p.team, outDir: p.outDir }, ctx, controller.signal).then((result) => {
      if (result.kind === 'ipa') emit(scope, { type: 'ipa-ready', file: result.file, size: result.size });
      end();
    }, end);
  }
  return { sessionId: id };
}

// ─── Screen streams (frames go straight to the renderer's MessagePort) ────

const toArrayBuffer = (buffer: Buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

const screens = new Map<string, { stream: ScreenStream | AppScreenStream | PhoneScreen; port: MessagePortMain }>();

/** Smooth stream: frames posted to the renderer and not taken yet before it counts as falling behind. */
const VIDEO_MAX_IN_FLIGHT = 30;

/**
 * Frames on their way to the renderer, for either stream. Compatible: at most
 * two JPEGs in flight; under backpressure only the newest waiting one is kept.
 * Smooth: every message goes on in order (a delta is useless without the ones
 * before it); when the renderer falls behind, drop up to the next keyframe and
 * ask for one.
 */
/** `dropWhenBehind: false`: send every frame even when the renderer falls behind (for a stream with no keyframes on request). */
function screenFlow(post: (message: ScreenPortMessage) => void, requestKeyframe: () => void, { dropWhenBehind = true }: { dropWhenBehind?: boolean } = {}) {
  let jpegSeq = 0;
  let jpegInFlight = 0;
  let jpegPending: Buffer | null = null;
  let videoInFlight = 0;
  let videoDropping = false;
  const sendJpeg = (jpeg: Buffer) => {
    if (jpegInFlight >= 2) {
      jpegPending = jpeg;
      return;
    }
    jpegInFlight += 1;
    post({ type: 'frame', data: toArrayBuffer(jpeg), seq: ++jpegSeq });
  };
  return {
    sendJpeg,
    sendVideo({ data, header }: VideoPacket): void {
      const config = header.type === STREAM_CONFIG;
      if (!config && dropWhenBehind) {
        if (videoDropping) {
          if (!header.key || videoInFlight > 4) return;
          videoDropping = false;
        } else if (!header.key && videoInFlight >= VIDEO_MAX_IN_FLIGHT) {
          videoDropping = true;
          requestKeyframe();
          return;
        }
        videoInFlight += 1;
      }
      post({ type: 'video', data: toArrayBuffer(data), seq: header.seq, key: header.key, config, captureUs: header.captureUs });
    },
    /** The renderer took a frame of the stream that is on. */
    ack(video: boolean): void {
      if (video) {
        videoInFlight = Math.max(0, videoInFlight - 1);
        // Caught up after dropping: a fresh keyframe resumes the picture.
        if (videoDropping && videoInFlight <= 4) requestKeyframe();
        return;
      }
      jpegInFlight = Math.max(0, jpegInFlight - 1);
      if (jpegPending) {
        const next = jpegPending;
        jpegPending = null;
        sendJpeg(next);
      }
    },
    reset(): void {
      jpegInFlight = 0;
      jpegPending = null;
      videoInFlight = 0;
      videoDropping = false;
    },
  };
}

/** An Electron app's windows: video (or JPEG frames) from the app, mouse and keyboard back (see core's AppScreenStream). */
async function openAppScreen(streamId: string, mac: string, projectPath: string, port: MessagePortMain, prefer: 'smooth' | 'compatible', maxSize?: number): Promise<void> {
  const post = (message: ScreenPortMessage) => port.postMessage(message);
  let project;
  try {
    project = await loadProject(projectPath);
  } catch (err) {
    post({ type: 'state', state: 'ended', error: toErrorInfo(err) });
    return;
  }
  const flow = screenFlow(post, () => stream.requestKeyframe());
  const scope = { mac, streamId };
  const stream: AppScreenStream = new AppScreenStream(link(mac), project.projectId, { prefer, fps: 30, quality: 75, maxSize: Math.min(2400, maxSize ?? 1400), audio: true }, {
    onFrame: flow.sendJpeg,
    onVideo: flow.sendVideo,
    onCodec: (codec, fallback) => {
      flow.reset();
      post({ type: 'codec', codec, fallback });
      if (fallback) emit(scope, { type: 'log', level: 'note', message: `Window: using the compatible stream. ${fallback.message}` });
    },
    onStatus: (status) => post({ type: 'status', bitrate: status.bitrate ?? null, dropped: status.dropped }),
    onInfo: (info) => {
      post({ type: 'info', info });
      emit(scope, { type: 'screen-info', info });
    },
    onWindows: (windows, watched) => post({ type: 'windows', windows, watched }),
    onCursor: (cursor) => post({ type: 'cursor', cursor }),
    onClipboard: (text) => post({ type: 'clipboard', text }),
    onDialogs: (dialogs, closed) => post({ type: 'dialogs', dialogs, closed }),
    onSound: (mode, toPc) => post({ type: 'sound', mode, toPc }),
    onAudio: (packets) => post({ type: 'audio', packets: packets.map(toArrayBuffer) }),
    onWaiting: (waiting) => post({ type: 'waiting', waiting }),
    onEnd: (error) => post({ type: 'state', state: 'ended', error }),
    onState: (state) => {
      if (state === 'streaming') flow.reset();
      post({ type: 'state', state });
    },
    onClock: (offsetUs, rttUs) => post({ type: 'clock', offsetUs, rttUs }),
  });
  port.on('message', (e) => {
    const message = e.data as ScreenPortCommand;
    switch (message?.type) {
      case 'ack':
        flow.ack(stream.currentCodec === 'h264');
        break;
      case 'keyframe':
        stream.requestKeyframe();
        break;
      case 'retry-smooth':
        flow.reset();
        stream.retrySmooth();
        break;
      case 'input': {
        const parsed = inputEventSchema.safeParse(message.event);
        if (parsed.success) stream.input(parsed.data);
        break;
      }
      case 'size':
        if (typeof message.maxSize === 'number' && Number.isFinite(message.maxSize)) stream.setVideoSize(message.maxSize);
        break;
      case 'window':
        stream.selectWindow(typeof message.window === 'number' ? message.window : null);
        break;
      case 'window-action':
        if (typeof message.window === 'number' && ['close', 'minimize', 'zoom'].includes(message.action)) stream.windowAction(message.window, message.action);
        break;
      case 'sound':
        if (isSoundMode(message.mode)) {
          stream.setSound(message.mode);
          // The next run of this project plays its sound here too (the CLI reads the same).
          void soundFor(project.projectId, message.mode);
        }
        break;
      case 'dialog-answer':
      case 'dialog-list':
      case 'dialog-mkdir': {
        const req = Number(message.req) || 0;
        const work = message.type === 'dialog-answer'
          ? stream.answerDialog(Number(message.dialog), message.answer)
          : message.type === 'dialog-list'
            ? stream.listFolder(String(message.path ?? '~'), Boolean(message.hidden))
            : stream.makeFolder(String(message.path ?? ''));
        work.then(
          (data) => post({ type: 'dialog-reply', req, ok: true, data }),
          (err) => post({ type: 'dialog-reply', req, ok: false, error: toErrorInfo(err).message }),
        );
        break;
      }
      case 'restart':
        flow.reset();
        void stream.start().catch((err) => post({ type: 'state', state: 'ended', error: toErrorInfo(err) }));
        break;
    }
  });
  port.on('close', () => closeScreen(streamId));
  port.start();
  screens.set(streamId, { stream, port });
  post({ type: 'state', state: 'connecting' });
  stream.start().then(
    () => post({ type: 'state', state: 'streaming' }),
    (err) => post({ type: 'state', state: 'ended', error: toErrorInfo(err) }),
  );
}

/** A simulator's screen, or (with `device`) the screen of an iPhone plugged into the Mac. */
function openScreen(streamId: string, mac: string, udid: string, port: MessagePortMain, prefer: 'smooth' | 'compatible', maxSize?: number, device?: { name: string }): void {
  const post = (message: ScreenPortMessage) => port.postMessage(message);
  const flow = screenFlow(post, () => stream.requestKeyframe());
  const resetFlow = () => flow.reset();
  const scope = { mac, streamId };
  const stream: ScreenStream = new ScreenStream(link(mac), udid, { prefer, fps: 15, quality: 72, maxSize: Math.min(1400, maxSize ?? 1400), device }, {
    onFrame: flow.sendJpeg,
    onVideo: flow.sendVideo,
    onInfo: (info) => {
      post({ type: 'info', info });
      emit(scope, { type: 'screen-info', info });
    },
    onLog: (level, message) => emit(scope, { type: 'log', level: level === 'info' ? 'note' : level, message: `Screen: ${message}` }),
    onEnd: (error) => post({ type: 'state', state: 'ended', error }),
    onState: (state) => {
      if (state === 'streaming') resetFlow();
      post({ type: 'state', state });
    },
    onCodec: (codec, fallback) => {
      resetFlow();
      post({ type: 'codec', codec, fallback });
      if (fallback) emit(scope, { type: 'log', level: 'note', message: `Screen: using the compatible stream. ${fallback.message}` });
    },
    onPreparing: (stage, xcode) => post({ type: 'preparing', stage, xcode }),
    onClock: (offsetUs, rttUs) => post({ type: 'clock', offsetUs, rttUs }),
    onStatus: (status) => post({ type: 'status', bitrate: status.bitrate ?? null, dropped: status.dropped }),
    onWaiting: (wait) => post({ type: 'device-wait', wait }),
  });
  if (maxSize) stream.setVideoSize(maxSize);
  port.on('message', (e) => {
    const message = e.data as ScreenPortCommand;
    switch (message?.type) {
      case 'ack':
        flow.ack(stream.currentCodec === 'h264');
        break;
      case 'input': {
        const parsed = inputEventSchema.safeParse(message.event);
        if (parsed.success) stream.input(parsed.data);
        break;
      }
      case 'keyframe':
        stream.requestKeyframe();
        break;
      case 'size':
        if (typeof message.maxSize === 'number' && Number.isFinite(message.maxSize)) stream.setVideoSize(message.maxSize);
        break;
      case 'retry-smooth':
        resetFlow();
        stream.retrySmooth();
        break;
      case 'restart':
        resetFlow();
        void stream.start().catch((err) => post({ type: 'state', state: 'ended', error: toErrorInfo(err) }));
        break;
    }
  });
  port.on('close', () => closeScreen(streamId));
  port.start();
  screens.set(streamId, { stream, port });
  post({ type: 'state', state: 'connecting' });
  stream.start().then(
    () => post({ type: 'state', state: 'streaming' }),
    (err) => post({ type: 'state', state: 'ended', error: toErrorInfo(err) }),
  );
}

/** How long after mirroring stopped touch goes back to the pane's iPhone (a session that comes straight back keeps it). */
const BACK_TO_PANE_MS = 3000;

/**
 * A real iPhone at this PC, with no Mac: its screen mirrored over Wi-Fi (or, while nothing mirrors,
 * over the cable), and touch through WebDriverAgent. Studio keeps this stream open while it runs (the
 * iPhone can't send its keyframe again), so touch follows Studio's pane to another iPhone or app
 * ('phone-target'). Touch drives the iPhone in the picture: the one that mirrors when this PC knows
 * it, else the pane's.
 */
async function openPhoneScreen(streamId: string, udid: string, projectPath: string, port: MessagePortMain, maxSize?: number): Promise<void> {
  const post = (message: ScreenPortMessage) => port.postMessage(message);
  let project;
  try {
    project = await loadProject(projectPath);
  } catch (err) {
    post({ type: 'state', state: 'ended', error: toErrorInfo(err) });
    return;
  }
  let scope = { projectPath, streamId };
  // The iPhone sends a keyframe only when mirroring starts: a dropped frame could never be made up.
  const flow = screenFlow(post, () => stream.requestKeyframe(), { dropWhenBehind: false });
  let pane = { udid, projectPath };
  let mirroring = mirrorReceiver().client;
  let backToPane: NodeJS.Timeout | null = null;
  const target = await iphoneTouchTarget(project.capDir, udid, mirroring);
  let retargets = 0;
  const retarget = async () => {
    const mine = ++retargets;
    const wanted = pane;
    const next = await loadProject(wanted.projectPath).catch(() => null);
    if (!next) return;
    const nextTarget = await iphoneTouchTarget(next.capDir, wanted.udid, mirroring);
    if (mine !== retargets || screens.get(streamId)?.stream !== stream) return;
    scope = { projectPath: wanted.projectPath, streamId };
    stream.retarget(nextTarget.device, nextTarget.touch);
  };
  const stream: PhoneScreen = new PhoneScreen(target.device, { touch: target.touch }, {
    // The picture over the cable, while nothing mirrors.
    onFrame: flow.sendJpeg,
    onVideo: flow.sendVideo,
    onInfo: (info) => {
      post({ type: 'info', info });
      emit(scope, { type: 'screen-info', info });
    },
    onLog: (level, message) => emit(scope, { type: 'log', level: level === 'info' ? 'note' : level, message: `Screen: ${message}` }),
    onEnd: (error) => post({ type: 'state', state: 'ended', error }),
    onState: (state) => {
      if (state === 'streaming') flow.reset();
      post({ type: 'state', state });
    },
    onCodec: (codec, fallback) => {
      flow.reset();
      post({ type: 'codec', codec, fallback });
    },
    onWaiting: (wait) => post({ type: 'device-wait', wait }),
    onClient: (client) => {
      post({ type: 'mirror-client', name: client?.name ?? null, model: client?.model ?? null });
      // Another iPhone started mirroring: touch goes to it. When mirroring stops, touch goes back to
      // the pane's iPhone a moment later (its picture can come over the cable then).
      if (!client) {
        if (mirroring && !backToPane) {
          backToPane = setTimeout(() => {
            backToPane = null;
            if (!mirroring) void retarget();
          }, BACK_TO_PANE_MS);
          backToPane.unref();
        }
        mirroring = null;
        return;
      }
      if (backToPane) clearTimeout(backToPane);
      backToPane = null;
      if (client.name === mirroring?.name && client.model === mirroring?.model) return;
      mirroring = client;
      void retarget();
    },
    onTouch: (ready, reason) => emit(scope, { type: 'log', level: 'note', message: ready ? t.pc.screen.touchOn : reason ?? t.pc.screen.touchOffWhy }),
  });
  port.on('message', (e) => {
    const message = e.data as ScreenPortCommand;
    switch (message?.type) {
      case 'ack':
        flow.ack(stream.currentCodec === 'h264');
        break;
      case 'keyframe':
        stream.requestKeyframe();
        break;
      case 'input': {
        const parsed = inputEventSchema.safeParse(message.event);
        if (parsed.success) stream.input(parsed.data);
        break;
      }
      case 'restart':
        flow.reset();
        void stream.start().catch((err) => post({ type: 'state', state: 'ended', error: toErrorInfo(err) }));
        break;
      case 'phone-target': {
        const parsed = phoneTargetSchema.safeParse(message);
        if (!parsed.success) break;
        pane = { udid: parsed.data.udid, projectPath: parsed.data.projectPath };
        void retarget();
        break;
      }
    }
  });
  // The window closed or reloaded: the receiver keeps running a while, for a reloaded one to catch up.
  port.on('close', () => closeScreen(streamId));
  port.start();
  screens.set(streamId, { stream, port });
  post({ type: 'state', state: 'connecting' });
  stream.start().then(
    () => post({ type: 'state', state: 'streaming' }),
    (err) => post({ type: 'state', state: 'ended', error: toErrorInfo(err) }),
  );
}

/** `forGood`: the renderer closed it (not a closed or reloaded window), so a This-PC iPhone's receiver can stop at once. */
function closeScreen(streamId: string, { forGood = false }: { forGood?: boolean } = {}): void {
  const entry = screens.get(streamId);
  if (!entry) return;
  screens.delete(streamId);
  if (entry.stream instanceof PhoneScreen) entry.stream.dispose({ forGood });
  else entry.stream.dispose();
  try {
    entry.port.close();
  } catch {
    // already closed
  }
}

// ─── The sample app ────────────────────────────────────────────────────────

const SAMPLE_SKIP = new Set(['node_modules', '.git', 'build', 'DerivedData', 'Pods', 'xcuserdata']);

async function createSample(kind: 'ios' | 'electron' | 'flutter' | 'react-native' = 'ios'): Promise<{ path: string }> {
  if (kind === 'react-native') {
    if (!init?.reactNativeSampleDir || !existsSync(init.reactNativeSampleDir)) throw new UserError(t.host.noSample);
    const target = path.join(init.samplesHome, 'Hello React Native');
    if (!existsSync(path.join(target, 'package.json'))) {
      await fs.mkdir(init.samplesHome, { recursive: true });
      // Source only: packages, CocoaPods' and Visual Studio's files hold the machine's paths (they come back on the first run).
      const skip = new Set(['node_modules', '.git', '.capmac', 'Pods', 'build', 'DerivedData', 'xcuserdata', '.xcode.env.local', 'vendor', '.bundle', 'x64', 'ARM64', 'AppPackages', 'BundleArtifacts', 'Generated Files', 'packages']);
      await fs.cp(init.reactNativeSampleDir, target, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
    }
    return { path: target };
  }
  if (kind === 'flutter') {
    if (!init?.flutterSampleDir || !existsSync(init.flutterSampleDir)) throw new UserError(t.host.noSample);
    const target = path.join(init.samplesHome, 'Hello Flutter');
    if (!existsSync(path.join(target, 'pubspec.yaml'))) {
      await fs.mkdir(init.samplesHome, { recursive: true });
      // Source only: what Flutter makes on a machine holds that machine's paths.
      const skip = new Set(['build', '.dart_tool', '.git', '.capmac', '.idea', 'ephemeral', 'Pods', '.symlinks', '.flutter-plugins', '.flutter-plugins-dependencies', 'xcuserdata', 'Generated.xcconfig', 'flutter_export_environment.sh', 'GeneratedPluginRegistrant.h', 'GeneratedPluginRegistrant.m']);
      await fs.cp(init.flutterSampleDir, target, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && !src.endsWith('.iml') });
    }
    return { path: target };
  }
  if (kind === 'electron') {
    if (!init?.electronSampleDir || !existsSync(init.electronSampleDir)) throw new UserError(t.host.noSample);
    const target = path.join(init.samplesHome, 'Hello Electron');
    if (!existsSync(path.join(target, 'package.json'))) {
      await fs.mkdir(init.samplesHome, { recursive: true });
      // Its icon lives in build/, which the iOS sample's copy leaves out.
      await fs.cp(init.electronSampleDir, target, { recursive: true, filter: (src) => !['node_modules', '.git', 'out', 'dist'].includes(path.basename(src)) });
    }
    return { path: target };
  }
  if (!init?.sampleDir || !existsSync(init.sampleDir)) throw new UserError(t.host.noSample);
  const target = path.join(init.samplesHome, 'Hello CapMac');
  if (!existsSync(path.join(target, 'capacitor.config.json'))) {
    await fs.mkdir(init.samplesHome, { recursive: true });
    await fs.cp(init.sampleDir, target, {
      recursive: true,
      filter: (src) => !SAMPLE_SKIP.has(path.basename(src)) && !/[\\/]App[\\/]App[\\/]public$/.test(src),
    });
    // The copy has no node_modules: Run uses the web assets it ships with (dist/),
    // and once dependencies are installed it builds from source like any project.
  }
  return { path: target };
}

// ─── Calls ─────────────────────────────────────────────────────────────────

type Handlers = { [M in EngineMethod]: (params: MethodParams<M>) => Promise<MethodResults[M]> };

const handlers: Handlers = {
  'macs.list': () => listMacSummaries(),
  'macs.discover': async ({ timeoutMs }) => discoverMacs(timeoutMs ?? 3000),
  'macs.pair': async ({ host, port, username, password, name, label, remote }) => {
    const ctx = contextFor({ mac: '#pairing' });
    const result = await pairMac({ host, port: port ?? 22, username, label }, username, { password, name }, ctx);
    emit({}, { type: 'macs-changed' });
    let remoteResult: MethodResults['macs.pair']['remote'];
    if (remote) {
      // Pairing worked either way; remote access can be turned on later from Macs.
      try {
        const r = await enableRemote(await link(result.host.name).session(), {}, ctx);
        remoteResult = { ok: true, test: r.test };
      } catch (err) {
        remoteResult = { ok: false, test: null, error: toErrorInfo(err) };
      }
      emit({}, { type: 'macs-changed' });
    }
    return { mac: await summaryOf(result.host.name), isDefault: result.isDefault, remote: remoteResult };
  },
  'macs.unpair': async ({ name }) => {
    links.get(name)?.close();
    links.delete(name);
    await unpairMac(name);
    emit({}, { type: 'macs-changed' });
  },
  'macs.setDefault': async ({ name }) => {
    await setDefaultMac(name);
    emit({}, { type: 'macs-changed' });
  },
  'macs.connect': async ({ name }) => {
    const host = await hostConfig(name);
    await link(name).session();
    const config = await loadGlobalConfig();
    return summarize(host, config.defaultHost);
  },
  'macs.health': ({ name, projectPath }) => health(name, projectPath),
  'macs.fix': async ({ name, fix }) => {
    const session = await link(name).session();
    await applyFix(fix, session, contextFor({ mac: name }));
  },
  'macs.unlockKeychain': async ({ name }) => {
    const session = await link(name).session();
    await unlockKeychain(session, contextFor({ mac: name }), true);
  },
  'targets.list': async ({ mac }) => (await link(mac).session()).call<TargetsResult>('targets'),
  'targets.watch': async ({ mac }) => watchTargets(mac),
  'targets.unwatch': async ({ watchId }) => unwatchTargets(watchId),
  'targets.refresh': async ({ mac }) => watches.get(mac)?.watch.refresh(),
  'simulators.boot': async ({ mac, udid }) => {
    const target = await findTarget(mac, udid);
    await bootSimulator(await link(mac).session(), target, contextFor({ mac }));
    watches.get(mac)?.watch.refresh();
  },
  'simulators.shutdown': async ({ mac, udid }) => {
    const target = await findTarget(mac, udid);
    await shutdownSimulator(await link(mac).session(), target, contextFor({ mac }));
    watches.get(mac)?.watch.refresh();
  },
  'projects.inspect': ({ path: dir }) => inspectProject(dir),
  'projects.detect': async ({ path: dir }) => restoreAppChoices(await findApps(dir)),
  'projects.setApp': async ({ path: dir, app }) => {
    // The project as it is now, from the same load: no second look at its config.
    const project = await loadProject(dir);
    return summarizeProject({ ...project, chosenApp: await chooseApp(project, app) });
  },
  'projects.syncSize': async ({ path: dir }) => syncSize(await loadProject(dir)),
  'projects.createSample': async ({ kind }) => {
    const sample = await createSample(kind);
    // A sample is opened for one of its apps: no need to ask which (the Flutter and React Native samples' iOS app; the toolbar switches).
    await chooseApp(await loadProject(sample.path), kind === 'electron' ? 'electron' : 'ios').catch(() => undefined);
    return sample;
  },
  'projects.installDeps': async ({ path: dir }) => {
    const project = await loadProject(dir);
    await installLocalDependencies(project, contextFor({ projectPath: project.capDir }));
  },
  'sessions.start': (params) => startSession(params),
  'sessions.stop': ({ sessionId }) => stopSession(sessionId),
  'sessions.rebuild': async ({ sessionId, clean }) => {
    const live = sessions.get(sessionId)?.live;
    if (!live) throw new UserError(t.host.liveNotRunning);
    // (A Flutter app's rebuild starts from its current files: there is nothing to clean first; nor for a Windows app.)
    if (live instanceof FlutterLiveSession || live instanceof FlutterPcLiveSession || live instanceof ReactNativePcLiveSession) live.rebuild();
    else live.rebuild({ clean });
  },
  'sessions.relaunch': async ({ sessionId }) => {
    const live = sessions.get(sessionId)?.live;
    if (!live) throw new UserError(t.host.liveNotRunning);
    live.relaunch();
  },
  'sessions.reload': async ({ sessionId }) => {
    const live = sessions.get(sessionId)?.live;
    if (live instanceof FlutterLiveSession || live instanceof FlutterPcLiveSession) return live.reload();
    // A React Native app reloads its JavaScript from Metro.
    if (live instanceof ReactNativeLiveSession || live instanceof ReactNativePcLiveSession) return live.reload();
    if (!(live instanceof ElectronLiveSession)) throw new UserError(t.host.liveNotRunning);
    await live.reload();
  },
  'sessions.devtools': async ({ sessionId }) => {
    const live = sessions.get(sessionId)?.live;
    if (!(live instanceof ReactNativeLiveSession || live instanceof ReactNativePcLiveSession)) throw new UserError(t.host.liveNotRunning);
    return { opened: await live.openDevTools() };
  },
  'builds.ipa': (params) => startSession({ ...params, mode: 'ipa' }),
  'xcode.open': async ({ projectPath, mac }) => {
    const project = await loadProject(projectPath);
    const name = mac ?? project.config.host ?? (await defaultMacName());
    await openInXcode(await link(name).session(), project, contextFor({ projectPath: project.capDir, mac: name }));
  },
  'logs.buildLog': async ({ projectPath, mac, path: logPath }) => {
    const project = await loadProject(projectPath);
    const name = mac ?? project.config.host ?? (await defaultMacName());
    return { text: await readFromMac(await link(name).session(), project, logPath) };
  },
  'screen.stop': async ({ streamId }) => closeScreen(streamId, { forGood: true }),
  // ── A real iPhone on this PC (the WSL backend), with no Mac ──
  'iphone.screenReady': async ({ projectPath, udid }) => {
    const project = await loadProject(projectPath);
    const touch = await iphoneTouchState(project.capDir, { udid }).catch(() => ({ unavailable: 'Touch is unavailable', canSetUp: false }));
    return { receiverReady: receiverInstalled(), touch };
  },
  'iphone.setUpTouch': async ({ projectPath, udid }) => {
    const scope = { projectPath };
    const controller = new AbortController();
    return setUpIphoneTouch({ cwd: projectPath, udid }, contextFor(scope), controller.signal);
  },
  'iphone.screenshot': async ({ streamId }) => {
    const entry = screens.get(streamId);
    if (!(entry?.stream instanceof PhoneScreen)) throw new UserError('That iPhone screen is not open.');
    const png = await entry.stream.still();
    return { png: toArrayBuffer(png), width: png.length > 24 ? png.readUInt32BE(16) : null, height: png.length > 24 ? png.readUInt32BE(20) : null };
  },
  'screen.screenshot': async ({ mac, udid, projectPath, window }) => {
    // A plugged-in iPhone: the newest picture of its open screen, at the iPhone's own size.
    const device = [...screens.values()].find((s) => s.stream instanceof ScreenStream && s.stream.isDevice && s.stream.udid === udid)?.stream as ScreenStream | undefined;
    if (device) {
      const png = await device.still();
      return { png: toArrayBuffer(png), width: png.length > 24 ? png.readUInt32BE(16) : null, height: png.length > 24 ? png.readUInt32BE(20) : null };
    }
    const session = await link(mac).session();
    const shot = udid === MAC_TARGET_ID && projectPath ? await takeAppScreenshot(session, (await loadProject(projectPath)).projectId, window) : await takeScreenshot(session, udid);
    return { png: toArrayBuffer(shot.png), width: shot.width, height: shot.height };
  },
  'debug.dropConnection': async ({ mac }) => links.get(mac)?.dropConnection(),
  'remote.server': () => signalServer(),
  'remote.setServer': async ({ url }) => setSignalServer(url),
  'macs.remote.enable': async ({ name, keepAwake }) => {
    const result = await enableRemote(await link(name).session(), { keepAwake }, contextFor({ mac: name }));
    emit({}, { type: 'macs-changed' });
    return { mac: await summaryOf(name), test: result.test };
  },
  'macs.remote.disable': async ({ name, localOnly }) => {
    const ctx = contextFor({ mac: name });
    let door: RemoteDoorStatus | null = null;
    if (localOnly) {
      await disableRemote(name, ctx, { localOnly: true });
    } else {
      const session = await link(name).session();
      await disableRemote(session, ctx);
      door = await remoteDoorStatus(session).catch(() => null);
    }
    // A connection over the internet ends with remote access: dial in again the local way.
    const l = links.get(name);
    if (l?.connected && l.route !== 'lan') l.dropConnection();
    emit({}, { type: 'macs-changed' });
    return { mac: await summaryOf(name), check: remoteChecks(await hostConfig(name), door, null, null)[0]! };
  },
  'macs.remote.set': async ({ name, route, relay, keepAwake, signalUrl }) => {
    const session = keepAwake !== undefined || signalUrl !== undefined ? await link(name).session() : null;
    await setRemoteOptions(name, { route, relay, keepAwake, signalUrl }, session, contextFor({ mac: name }));
    // A new route applies to the next connection: reconnect now, unless that would interrupt a run.
    let reconnecting = false;
    const l = links.get(name);
    if ((route !== undefined || relay !== undefined) && l?.connected && !macBusy(name)) {
      l.dropConnection();
      reconnecting = true;
    }
    emit({}, { type: 'macs-changed' });
    return { mac: await summaryOf(name), reconnecting };
  },
  'macs.remote.status': async ({ name }) => {
    const session = await link(name).session();
    const [door, me, host] = await Promise.all([remoteDoorStatus(session).catch(() => null), thisPc(), hostConfig(name)]);
    return {
      door,
      thisPc: me,
      pcs: (door?.pcs ?? []).map((pc) => ({ ...pc, current: pc.key === me.key })),
      route: session.route,
      rttMs: session.rttMs,
      check: remoteChecks(host, door, session.route, me.key)[0]!,
    };
  },
  'macs.remote.revoke': async ({ name, key }) => revokeRemotePc(await link(name).session(), key, contextFor({ mac: name })),
  'macs.remote.test': async ({ name }) => testRemote(await hostConfig(name)),
  'projects.setBackend': async ({ path: dir, backend }) => {
    const project = await loadProject(dir);
    await chooseBackend(project, backend);
    return summarizeProject(project);
  },
  'wsl.status': ({ projectPath }) => wslHost.status(projectPath),
  'wsl.setup': async ({ projectPath, appleLogin }) => wslHost.setup(projectPath, appleLogin),
  'wsl.stopSetup': ({ setupId }) => wslHost.stopSetup(setupId),
  'wsl.doctor': ({ projectPath }) => wslHost.doctor(projectPath),
  'wsl.devices': ({ projectPath }) => wslHost.devices(projectPath),
};

async function handleCall(id: number, method: EngineMethod, params: unknown): Promise<void> {
  let result: CallResult<unknown>;
  try {
    const handler = handlers[method] as (p: unknown) => Promise<unknown>;
    if (!handler) throw new UserError(`Unknown request "${method}".`);
    result = { ok: true, value: await handler(params) };
  } catch (err) {
    result = { ok: false, error: toErrorInfo(err) };
  }
  flush(); // events caused by the call arrive before its result
  send({ kind: 'result', id, result });
}

function setVisible(next: boolean): void {
  if (visible === next) return;
  visible = next;
  // Nobody is looking: stop polling the Mac for target changes.
  for (const entry of watches.values()) {
    if (next) void entry.watch.start();
    else entry.watch.stop();
  }
}

async function shutdown(): Promise<void> {
  for (const watchEntry of watches.values()) watchEntry.watch.dispose();
  for (const id of [...screens.keys()]) closeScreen(id);
  await Promise.race([
    Promise.all([...[...sessions.keys()].map((id) => stopSession(id)), wslHost.shutdown()]),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  for (const l of links.values()) l.close();
  flush();
  send({ kind: 'shutdown-done' });
}

parent.on('message', (e) => {
  const message = e.data as MainToHost;
  switch (message.kind) {
    case 'init':
      init = message.init;
      settings = message.init.settings;
      setAgentBundlePath(message.init.agentPath);
      if (message.init.remoteModulesDir) setNodeDataChannelDir(message.init.remoteModulesDir);
      setBundledReceiver(message.init.mirrorReceiverDir);
      send({ kind: 'ready' });
      break;
    case 'call':
      void handleCall(message.id, message.method, message.params);
      break;
    case 'prompt-response': {
      const resolve = pendingPrompts.get(message.response.id);
      pendingPrompts.delete(message.response.id);
      resolve?.(message.response);
      break;
    }
    case 'screen-open': {
      const port = e.ports[0];
      if (!port) break;
      if (message.backend === 'wsl' && message.projectPath) void openPhoneScreen(message.streamId, message.udid, message.projectPath, port, message.maxSize);
      else if (message.udid === MAC_TARGET_ID && message.projectPath && message.mac) void openAppScreen(message.streamId, message.mac, message.projectPath, port, message.prefer, message.maxSize);
      else if (message.mac) openScreen(message.streamId, message.mac, message.udid, port, message.prefer, message.maxSize, message.device);
      break;
    }
    case 'settings':
      settings = message.settings;
      break;
    case 'visibility':
      setVisible(message.visible);
      break;
    case 'shutdown':
      void shutdown();
      break;
  }
});

process.on('unhandledRejection', (reason) => {
  send({ kind: 'log', level: 'error', message: `unhandled rejection: ${String((reason as Error)?.stack ?? reason)}` });
});
