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
  applyFix,
  bootSimulator,
  buildApp,
  CancelledError,
  discoverMacs,
  inspectProject,
  installLocalDependencies,
  LiveSession,
  loadGlobalConfig,
  loadProject,
  localChecks,
  MacLink,
  macChecks,
  openInXcode,
  pairMac,
  readFromMac,
  requireIos,
  resolveHost,
  runApp,
  ScreenStream,
  setAgentBundlePath,
  setDefaultMac,
  shutdownSimulator,
  syncSize,
  takeScreenshot,
  TargetWatch,
  toErrorInfo,
  unlockKeychain,
  unpairMac,
  UserError,
  type Check,
  type EngineContext,
  type HostConfig,
  type Prompter,
  type VideoPacket,
} from '@capmac/core/engine';
import { STREAM_CONFIG } from '@capmac/core/shared/stream';
import type { ProbeResult, Target, TargetsResult } from '@capmac/core/shared/protocol';
import {
  inputEventSchema,
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

function ask(prompt: PromptBody): Promise<PromptResponse> {
  const id = newId('p');
  return new Promise((resolve) => {
    pendingPrompts.set(id, resolve);
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
    const r = await ask({ kind: 'confirm', message: request.message, detail: request.detail, danger: request.danger, confirmLabel: request.confirmLabel, defaultYes: request.defaultYes });
    return r.ok && r.value === true;
  },
  async choose(request) {
    const r = await ask({ kind: 'choose', message: request.message, items: request.items.map(({ label, hint }) => ({ label, hint })) });
    const item = r.ok && typeof r.value === 'number' ? request.items[r.value] : undefined;
    if (!item) throw new CancelledError();
    return item.value;
  },
  async text(request) {
    const r = await ask({ kind: 'text', message: request.message, defaultValue: request.defaultValue, placeholder: request.placeholder });
    if (!r.ok || typeof r.value !== 'string') throw new CancelledError();
    return r.value;
  },
};

function contextFor(scope: Scope): EngineContext {
  return { emit: (event) => emit(scope, event), prompter, verbose: settings.verbose };
}

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
  if (!host) throw new UserError(`No paired Mac called "${name}".`, 'Pair it again from Macs › Pair a Mac.');
  return host;
}

async function defaultMacName(): Promise<string> {
  const config = await loadGlobalConfig();
  const host = resolveHost(config);
  if (!host) {
    if (Object.keys(config.hosts).length === 0) throw new UserError('No Mac is paired yet.', 'Pair your Mac first: Macs › Pair a Mac.');
    throw new UserError('Several Macs are paired and none is the default.', 'Pick one in the toolbar, or make one the default in Macs.');
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
    isDefault: defaultHost === host.name,
    pairedAt: host.pairedAt,
    state: l ? (l.state === 'idle' ? 'idle' : l.state) : 'idle',
    latencyMs: l?.latencyMs ?? null,
    error: l?.lastError ?? null,
  };
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
    c.id === 'pc-node' && !nodeVersion ? { ...c, level: 'warn', label: 'Node.js on this PC', detail: 'not found', fix: 'Install Node.js 20+ (https://nodejs.org): building your web app and live reload need it.' } : c);
  for (const check of pc) emit(scope, { type: 'check', check });
  const l = link(name);
  const started = Date.now();
  let session;
  try {
    session = await l.session();
  } catch (err) {
    const info = toErrorInfo(err);
    const check: Check = { id: 'connect', group: 'mac', level: 'fail', label: `Connect to ${host.macName ?? host.host}`, detail: info.message, fix: info.hint ?? 'Check that the Mac is awake and Remote Login is on.' };
    emit(scope, { type: 'check', check });
    return { mac: name, checks: [...pc, check], probe: null, latencyMs: null };
  }
  const latencyMs = Date.now() - started;
  const probe = await session.call<ProbeResult>('probe');
  const mac = macChecks(probe, project);
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
  const target = [...all.simulators, ...all.devices].find((t) => t.udid === udid);
  if (!target) throw new UserError('That simulator or device is no longer available on the Mac.', 'Pick another one in the target list.');
  return target;
}

// ─── Sessions (run, live, ipa) ─────────────────────────────────────────────

interface HostSession {
  id: string;
  mode: 'run' | 'live' | 'ipa';
  projectPath: string;
  mac: string;
  controller: AbortController;
  live: LiveSession | null;
  done: Promise<void>;
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
  requireIos(project);
  const mac = params.mac ?? project.config.host ?? (await defaultMacName());
  const id = newId('s');
  const scope: Scope = { sessionId: id, projectPath: project.capDir, mac };
  const ctx = contextFor(scope);
  const controller = new AbortController();
  const l = link(mac);
  const started = Date.now();
  const target = 'target' in params ? params.target : undefined;
  emit(scope, { type: 'session-started', mode: params.mode, projectPath: project.capDir, mac, target: target ?? null });
  const end = (err?: unknown) => {
    sessions.delete(id);
    const info = err === undefined ? undefined : toErrorInfo(err);
    const cancelled = Boolean(info?.cancelled) || controller.signal.aborted;
    emit(scope, { type: 'session-ended', mode: params.mode, ok: err === undefined || cancelled, cancelled, error: cancelled ? undefined : info, ms: Date.now() - started });
  };
  const session: HostSession = { id, mode: params.mode, projectPath: project.capDir, mac, controller, live: null, done: Promise.resolve() };
  sessions.set(id, session);

  if (params.mode === 'run') {
    const options = params.options ?? {};
    session.done = runApp(project, l, { target, ...options, osLogs: options.osLogs ?? settings.osLogs }, ctx, controller.signal).then(() => end(), end);
  } else if (params.mode === 'live') {
    const options = params.options ?? {};
    const live = new LiveSession(project, l, { target, clean: options.clean, full: options.full, configuration: options.configuration, showSimulator: options.showSimulator, osLogs: options.osLogs ?? settings.osLogs }, ctx);
    session.live = live;
    session.done = new Promise<void>((resolve) => {
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
  } else {
    const p = params as MethodParams<'builds.ipa'>;
    session.done = buildApp(project, l, { ipa: true, exportKind: p.exportKind, upload: p.upload, outDir: p.outDir, team: p.team }, ctx, controller.signal).then((result) => {
      if (result.kind === 'ipa') emit(scope, { type: 'ipa-ready', file: result.file, size: result.size });
      end();
    }, end);
  }
  return { sessionId: id };
}

// ─── Screen streams (frames go straight to the renderer's MessagePort) ────

const toArrayBuffer = (buffer: Buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

const screens = new Map<string, { stream: ScreenStream; port: MessagePortMain }>();

/** Smooth stream: frames posted to the renderer and not taken yet before it counts as falling behind. */
const VIDEO_MAX_IN_FLIGHT = 30;

function openScreen(streamId: string, mac: string, udid: string, port: MessagePortMain, prefer: 'smooth' | 'compatible', maxSize?: number): void {
  const post = (message: ScreenPortMessage) => port.postMessage(message);
  // Compatible stream: at most two JPEGs in flight; under backpressure only the newest waiting one is kept.
  let jpegSeq = 0;
  let jpegInFlight = 0;
  let jpegPending: Buffer | null = null;
  const sendJpeg = (jpeg: Buffer) => {
    if (jpegInFlight >= 2) {
      jpegPending = jpeg;
      return;
    }
    jpegInFlight += 1;
    post({ type: 'frame', data: toArrayBuffer(jpeg), seq: ++jpegSeq });
  };
  // Smooth stream: every message goes on in order (a delta is useless without the ones before it).
  // When the renderer falls behind, drop up to the next keyframe and ask for one.
  let videoInFlight = 0;
  let videoDropping = false;
  const sendVideo = ({ data, header }: VideoPacket) => {
    const config = header.type === STREAM_CONFIG;
    if (!config) {
      if (videoDropping) {
        if (!header.key || videoInFlight > 4) return;
        videoDropping = false;
      } else if (!header.key && videoInFlight >= VIDEO_MAX_IN_FLIGHT) {
        videoDropping = true;
        stream.requestKeyframe();
        return;
      }
      videoInFlight += 1;
    }
    post({ type: 'video', data: toArrayBuffer(data), seq: header.seq, key: header.key, config, captureUs: header.captureUs });
  };
  const resetFlow = () => {
    jpegInFlight = 0;
    jpegPending = null;
    videoInFlight = 0;
    videoDropping = false;
  };
  const scope = { mac, streamId };
  const stream = new ScreenStream(link(mac), udid, { prefer, fps: 15, quality: 72, maxSize: Math.min(1400, maxSize ?? 1400) }, {
    onFrame: sendJpeg,
    onVideo: sendVideo,
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
  });
  if (maxSize) stream.setVideoSize(maxSize);
  port.on('message', (e) => {
    const message = e.data as ScreenPortCommand;
    switch (message?.type) {
      case 'ack':
        if (stream.currentCodec === 'h264') {
          videoInFlight = Math.max(0, videoInFlight - 1);
          // Caught up after dropping: a fresh keyframe resumes the picture.
          if (videoDropping && videoInFlight <= 4) stream.requestKeyframe();
        } else {
          jpegInFlight = Math.max(0, jpegInFlight - 1);
          if (jpegPending) {
            const next = jpegPending;
            jpegPending = null;
            sendJpeg(next);
          }
        }
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

function closeScreen(streamId: string): void {
  const entry = screens.get(streamId);
  if (!entry) return;
  screens.delete(streamId);
  entry.stream.dispose();
  try {
    entry.port.close();
  } catch {
    // already closed
  }
}

// ─── The sample app ────────────────────────────────────────────────────────

const SAMPLE_SKIP = new Set(['node_modules', '.git', 'build', 'DerivedData', 'Pods', 'xcuserdata']);

async function createSample(): Promise<{ path: string }> {
  if (!init?.sampleDir || !existsSync(init.sampleDir)) throw new UserError('The sample app is not included in this build of capmac Studio.');
  const target = path.join(init.samplesHome, 'Hello capmac');
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
  'macs.pair': async ({ host, port, username, password, name, label }) => {
    const ctx = contextFor({ mac: '#pairing' });
    const result = await pairMac({ host, port: port ?? 22, username, label }, username, { password, name }, ctx);
    emit({}, { type: 'macs-changed' });
    const config = await loadGlobalConfig();
    return { mac: summarize(result.host, config.defaultHost), isDefault: result.isDefault };
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
  'projects.syncSize': async ({ path: dir }) => syncSize(await loadProject(dir)),
  'projects.createSample': () => createSample(),
  'projects.installDeps': async ({ path: dir }) => {
    const project = await loadProject(dir);
    await installLocalDependencies(project, contextFor({ projectPath: project.capDir }));
  },
  'sessions.start': (params) => startSession(params),
  'sessions.stop': ({ sessionId }) => stopSession(sessionId),
  'sessions.rebuild': async ({ sessionId, clean }) => {
    const live = sessions.get(sessionId)?.live;
    if (!live) throw new UserError('Live mode is not running for this project.');
    live.rebuild({ clean });
  },
  'sessions.relaunch': async ({ sessionId }) => {
    const live = sessions.get(sessionId)?.live;
    if (!live) throw new UserError('Live mode is not running for this project.');
    live.relaunch();
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
  'screen.stop': async ({ streamId }) => closeScreen(streamId),
  'screen.screenshot': async ({ mac, udid }) => {
    const shot = await takeScreenshot(await link(mac).session(), udid);
    return { png: toArrayBuffer(shot.png), width: shot.width, height: shot.height };
  },
  'debug.dropConnection': async ({ mac }) => links.get(mac)?.dropConnection(),
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
    Promise.all([...sessions.keys()].map((id) => stopSession(id))),
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
      if (port) openScreen(message.streamId, message.mac, message.udid, port, message.prefer, message.maxSize);
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
