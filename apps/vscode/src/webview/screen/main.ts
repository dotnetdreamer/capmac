/**
 * The live screen in a VS Code tab: an iOS simulator, an iPhone plugged into
 * the Mac, or an app's window on the Mac's desktop. Frames come from the
 * extension and go straight to CapMac Studio's own decoder worker (H.264 with
 * WebCodecs, or JPEG), through a MessageChannel that stands in for Studio's
 * screen port; input goes back the same way.
 */
import { AppAudioPlayer } from '../../../../desktop/src/renderer/lib/app-audio';
import { CSS_CURSORS } from '@capmac/core/shared/electron';
import type { AppDialog, AppWindowInfo, ErrorInfo, InputEvent, ScreenInfo, ScreenPortCommand, ScreenPortMessage, SoundMode, StreamFallback } from '../../../../desktop/src/shared/contract';
import { t, tidy } from '../../../../desktop/src/shared/i18n/index';
import { DialogLayer, type DialogCommand } from './dialogs';
import { button, h, icon } from './dom';
import { attachInput, type InputMode } from './input';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

/** What the extension opens the page with. */
export interface ScreenInit {
  kind: 'simulator' | 'device' | 'app';
  name: string;
  macLabel: string;
  frame: boolean;
  /** An app's window: live reload runs (its Reload button shows). */
  live: boolean;
  /** The app is running (an app's window waits for it otherwise). */
  running: boolean;
  /** Over the internet: 'direct' or 'relay', with the round trip. */
  route: string | null;
  rttMs: number | null;
  prefer: 'smooth' | 'compatible';
}

type FromExtension =
  | { type: 'init'; streamId: string; init: ScreenInit }
  | { type: 'port'; streamId: string; message: ScreenPortMessage }
  | { type: 'closed' }
  | { type: 'run-state'; running: boolean; live: boolean }
  | { type: 'route'; route: string | null; rttMs: number | null }
  | { type: 'frame'; frame: boolean }
  /** The app has no screen to stream here: where to look instead. */
  | { type: 'none'; text: string };

type StreamState = { kind: 'connecting' } | { kind: 'streaming' } | { kind: 'reconnecting' } | { kind: 'ended'; error?: ErrorInfo };

const vscode = acquireVsCodeApi();
const PADDING = 11;
const TITLE_BAR = 28;

const formatRate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`);
/** The video's longest side for a canvas this tall: a little above it (crisp text), in steps, within limits. */
const videoSizeFor = (canvasPixels: number, devicePixels: number | null) => Math.max(640, Math.min(2400, devicePixels ?? 2400, Math.ceil(canvasPixels / 64) * 64));

// ─── State ─────────────────────────────────────────────────────────────────

let init: ScreenInit | null = null;
let worker: Worker | null = null;
let port: MessagePort | null = null;
/** The stream shown now; messages of an older one (still on their way) are dropped. */
let streamId = '';
/** Messages that came before the decoder was ready (the stream's state, its video config, …), in order. */
let early: Array<{ message: ScreenPortMessage; transfer: Transferable[] }> = [];
let state: StreamState = { kind: 'connecting' };
let info: ScreenInfo | null = null;
let codec: 'h264' | 'jpeg' | null = null;
let fallback: StreamFallback | null = null;
let preparing: { stage: 'building' | 'starting'; xcode?: string } | null = null;
let wait: 'device' | 'permission' | null = null;
let frameSize: { width: number; height: number } | null = null;
let hasFrame = false;
let stats: { fps: number; kbps: number; decodeMs: number; latencyMs: number | null; latencyP95Ms: number | null; inputMs: number | null } | null = null;
let targetBitrate: number | null = null;
let windows: AppWindowInfo[] = [];
let watched: number | null = null;
let appWaiting = true;
let sound: { mode: SoundMode; toPc: boolean } | null = null;
let player: AppAudioPlayer | null = null;
let box = { width: 0, height: 0 };
let canvasPixels = 0;
let sentVideoSize = 0;
let videoTimer = 0;
let nextReq = 1;
const replies = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: number }>();

// ─── Page ──────────────────────────────────────────────────────────────────

const root = document.getElementById('root')!;
const stage = h('div', { class: 'stage' });
const device = h('div', { class: 'device' });
const titlebar = h('div', { class: 'appwin__titlebar' });
const screen = h('div', { class: 'screen' });
const host = h('div', { class: 'host', tabindex: '0', role: 'img' });
const overlay = h('div', { class: 'overlay' });
const dialogLayerEl = h('div', { class: 'dlg-layer', hidden: true });
const toolbar = h('div', { class: 'toolbar', role: 'toolbar' });
const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
screen.append(host, overlay, dialogLayerEl);
device.append(titlebar, screen);
stage.append(device);
root.append(stage, toolbar, live);

const dialogs = new DialogLayer(dialogLayerEl, (command) => dialogRequest(command));

function post(message: unknown): void {
  vscode.postMessage(message);
}

function action(name: string, extra: Record<string, unknown> = {}): void {
  post({ type: 'action', name, ...extra });
}

// ─── The stream ────────────────────────────────────────────────────────────

let workerSource: Promise<string> | null = null;

async function startWorker(): Promise<void> {
  stopWorker();
  const forStream = streamId;
  // A webview can't start a worker from its resource URLs: load it once, then start it from a blob.
  workerSource ??= fetch(document.body.dataset.worker!).then((r) => r.text());
  const source = await workerSource;
  if (forStream !== streamId) return;
  const canvas = h('canvas', { class: 'canvas', 'aria-hidden': 'true' });
  host.prepend(canvas);
  const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const w = new Worker(blob, { name: 'capmac screen' });
  URL.revokeObjectURL(blob);
  worker = w;
  const offscreen = canvas.transferControlToOffscreen();
  w.postMessage({ type: 'canvas', canvas: offscreen }, [offscreen]);
  const channel = new MessageChannel();
  // The worker's end stands in for Studio's screen port: what it sends goes to the engine.
  channel.port2.onmessage = (e: MessageEvent<ScreenPortCommand>) => post({ type: 'port', streamId: forStream, command: e.data });
  w.postMessage({ type: 'port', port: channel.port1 }, [channel.port1]);
  w.onmessage = (e) => onWorker(e.data);
  port = channel.port2;
  sendSize();
  // What came while the worker loaded, in order.
  for (const { message, transfer } of early.splice(0)) port.postMessage(message, transfer);
}

function stopWorker(): void {
  worker?.terminate();
  worker = null;
  port?.close();
  port = null;
  host.querySelector('canvas')?.remove();
  for (const waiting of replies.values()) {
    window.clearTimeout(waiting.timer);
    waiting.reject(new Error(t.appWindow.stopped));
  }
  replies.clear();
}

function toWorker(message: unknown): void {
  worker?.postMessage(message);
}

function onWorker(m: any): void {
  switch (m.type) {
    case 'frame-size':
      frameSize = { width: m.width, height: m.height };
      layout();
      break;
    case 'first-frame':
      hasFrame = true;
      preparing = null;
      render();
      break;
    case 'stats':
      stats = m;
      renderToolbar();
      break;
    case 'info':
      info = m.info;
      host.setAttribute('aria-label', screenLabel());
      render();
      break;
    case 'status':
      targetBitrate = m.bitrate;
      break;
    case 'preparing':
      preparing = { stage: m.stage, xcode: m.xcode };
      render();
      break;
    case 'device-wait':
      wait = m.wait;
      render();
      break;
    case 'codec':
      codec = m.codec;
      fallback = m.fallback;
      if (m.fallback) live.textContent = t.simulator.switched(tidy(m.fallback.message) ?? '');
      render();
      break;
    case 'state':
      state = m.state === 'ended' ? { kind: 'ended', error: m.error } : { kind: m.state };
      render();
      break;
    case 'windows':
      windows = m.windows;
      watched = m.watched;
      layout();
      break;
    case 'waiting':
      appWaiting = m.waiting;
      render();
      break;
    case 'cursor':
      host.style.cursor = canInput() ? CSS_CURSORS[m.cursor] ?? 'default' : '';
      break;
    case 'clipboard':
      // Copied in the app: on this PC's clipboard too.
      action('clipboard', { text: m.text });
      break;
    case 'dialogs':
      dialogs.update(m.dialogs as AppDialog[]);
      break;
    case 'sound':
      sound = { mode: m.mode, toPc: m.toPc };
      if (m.mode === 'pc') (player ??= new AppAudioPlayer()).start();
      else player?.stop();
      renderToolbar();
      break;
    case 'audio':
      for (const packet of m.packets as ArrayBuffer[]) player?.push(packet);
      break;
    case 'dialog-reply': {
      const waiting = replies.get(m.req);
      if (!waiting) break;
      replies.delete(m.req);
      window.clearTimeout(waiting.timer);
      if (m.ok) waiting.resolve(m.data);
      else waiting.reject(new Error(m.error ?? ''));
      break;
    }
  }
}

function dialogRequest(command: DialogCommand): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error(t.appWindow.stopped));
    const req = nextReq++;
    const timer = window.setTimeout(() => {
      replies.delete(req);
      reject(new Error(t.appWindow.stopped));
    }, 20_000);
    replies.set(req, { resolve, reject, timer });
    toWorker({ type: 'dialog', command: { ...command, req } });
  });
}

// ─── Input ─────────────────────────────────────────────────────────────────

const isApp = () => init?.kind === 'app';
const inputMode = (): InputMode | null => {
  if (isApp()) return info?.input && !appWaiting && state.kind === 'streaming' ? 'mouse' : null;
  return info?.input ? (info.inputMode === 'touch' ? 'touch' : 'gestures') : null;
};
const canInput = () => inputMode() !== null;
const send = (event: InputEvent) => toWorker({ type: 'input', event });

attachInput({
  host,
  send,
  mode: inputMode,
  points: () => {
    if (isApp()) {
      const current = windows.find((w) => w.id === watched);
      return current ? { width: current.width, height: current.height } : null;
    }
    return info?.points ?? null;
  },
  ripple: (x, y) => {
    const dot = h('span', { class: 'ripple', style: { left: `${x}px`, top: `${y}px` } });
    screen.append(dot);
    window.setTimeout(() => dot.remove(), 500);
  },
  onPointerDown: () => {
    // A click lets the page play sound (browsers wait for one).
    if (sound?.mode === 'pc') player?.start();
  },
});

function screenLabel(): string {
  if (!init) return '';
  if (isApp()) return t.appWindow.screen(windowTitle(), t.appWindow.help);
  const mode = inputMode();
  return t.simulator.screen(init.name, mode === 'touch' ? t.simulator.helpTouch : mode ? t.simulator.helpBasic : null);
}

function windowTitle(): string {
  const current = windows.find((w) => w.id === watched);
  return current?.title || (current ? t.appWindow.untitled(current.id) : init?.name ?? '');
}

// ─── Layout ────────────────────────────────────────────────────────────────

new ResizeObserver(([entry]) => {
  const { width, height } = entry!.contentRect;
  requestAnimationFrame(() => {
    if (box.width === width && box.height === height) return;
    box = { width, height };
    layout();
  });
}).observe(stage);

function layout(): void {
  if (!init) return;
  const frame = init.frame;
  let screenW: number;
  let screenH: number;
  if (isApp()) {
    const current = windows.find((w) => w.id === watched) ?? null;
    const aspect = frameSize ? frameSize.width / frameSize.height : current ? current.width / Math.max(1, current.height) : 1.45;
    const bar = frame && (current?.titleBar ?? 28) > 0 ? TITLE_BAR : 0;
    const maxW = Math.max(0, box.width - 24);
    const maxH = Math.max(0, box.height - 24 - bar);
    screenW = Math.floor(Math.min(maxW, maxH * aspect));
    screenH = Math.floor(screenW / aspect);
    titlebar.hidden = bar === 0;
    titlebar.style.height = `${bar}px`;
    titlebar.replaceChildren(trafficLights(), h('span', { class: 'appwin__title truncate' }, windowTitle()));
    device.className = `device device--app${frame ? ' has-frame' : ''}${current?.dark ? ' is-dark' : ''}`;
    device.style.cssText = `width:${screenW}px;border-radius:${frame ? 10 : 4}px`;
    screen.style.cssText = `width:${screenW}px;height:${screenH}px;border-radius:${frame && bar ? '0 0 10px 10px' : `${frame ? 10 : 4}px`}`;
  } else {
    const aspect = frameSize ? frameSize.width / frameSize.height : 0.46;
    const pad = frame ? PADDING : 0;
    const maxH = Math.max(0, box.height - 2 * pad - 8);
    const maxW = Math.max(0, box.width - 2 * pad - 8);
    screenH = Math.floor(Math.min(maxH, maxW / aspect));
    screenW = Math.floor(screenH * aspect);
    titlebar.hidden = true;
    const radius = frame ? Math.round(screenW * 0.13) : 4;
    device.className = `device${frame ? ' has-frame' : ''}`;
    device.style.cssText = `width:${screenW + 2 * pad}px;height:${screenH + 2 * pad}px;padding:${pad}px;border-radius:${frame ? radius + pad : 0}px`;
    screen.style.cssText = `width:${screenW}px;height:${screenH}px;border-radius:${radius}px`;
  }
  host.style.width = `${screenW}px`;
  host.style.height = `${screenH}px`;
  const dpr = window.devicePixelRatio || 1;
  canvasPixels = Math.round(Math.max(screenW, screenH) * dpr);
  sendSize(screenW, screenH);
  scheduleVideoSize();
}

let lastSize = { width: 0, height: 0 };
function sendSize(width = lastSize.width, height = lastSize.height): void {
  lastSize = { width, height };
  const dpr = window.devicePixelRatio || 1;
  if (width && height) toWorker({ type: 'size', width: Math.round(width * dpr), height: Math.round(height * dpr) });
}

/** Ask for video about as sharp as the canvas shows it (settled sizes only). */
function scheduleVideoSize(): void {
  window.clearTimeout(videoTimer);
  videoTimer = window.setTimeout(() => {
    if (!canvasPixels) return;
    if (!isApp() && codec !== 'h264') return;
    const devicePixels = !isApp() && info?.points && info.scale ? Math.round(Math.max(info.points.width, info.points.height) * info.scale) : null;
    const want = isApp() ? Math.max(640, Math.min(2400, Math.ceil(canvasPixels / 64) * 64)) : videoSizeFor(canvasPixels, devicePixels);
    if (sentVideoSize && Math.abs(want - sentVideoSize) / sentVideoSize < 0.12) return;
    sentVideoSize = want;
    toWorker({ type: 'video-size', maxSize: want });
  }, 600);
}

function trafficLights(): HTMLElement {
  const windowAction = (name: 'close' | 'minimize' | 'zoom') => {
    if (watched !== null) toWorker({ type: 'window-action', window: watched, action: name });
  };
  return h(
    'span',
    { class: 'appwin__lights' },
    h('button', { type: 'button', class: 'appwin__light appwin__light--close', title: t.appWindow.close, 'aria-label': t.appWindow.close, onclick: () => windowAction('close') }),
    h('button', { type: 'button', class: 'appwin__light appwin__light--min', title: t.appWindow.minimize, 'aria-label': t.appWindow.minimize, onclick: () => windowAction('minimize') }),
    h('button', { type: 'button', class: 'appwin__light appwin__light--zoom', title: t.appWindow.zoom, 'aria-label': t.appWindow.zoom, onclick: () => windowAction('zoom') }),
  );
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function render(): void {
  renderOverlay();
  renderToolbar();
  host.classList.toggle('can-input', canInput());
  host.setAttribute('aria-label', screenLabel());
  scheduleVideoSize();
}

function renderOverlay(): void {
  if (!init) return;
  const ended = state.kind === 'ended';
  const reconnecting = state.kind === 'reconnecting';
  const app = isApp();
  const noWindow = app && !appWaiting && state.kind === 'streaming' && windows.length === 0;
  const notRunning = app && !init.running && (appWaiting || !hasFrame);
  const waiting = !ended && wait !== null;
  const show = !hasFrame || ended || reconnecting || waiting || (app && (appWaiting || noWindow));
  overlay.hidden = !show;
  overlay.classList.toggle('is-dimmed', Boolean((reconnecting || waiting || (app && appWaiting)) && hasFrame));
  if (!show) return;
  const lines: Array<HTMLElement | null> = [];
  if (ended) {
    lines.push(
      icon(state.kind === 'ended' && state.error?.code === 'DEVICE_SCREEN_DENIED' ? 'shield' : 'debug-disconnect', 'overlay__icon'),
      h('span', null, tidy(state.kind === 'ended' ? state.error?.message : undefined) ?? (app ? t.appWindow.stopped : t.simulator.stopped)),
      state.kind === 'ended' && state.error?.hint ? h('span', { class: 'faint' }, tidy(state.error.hint) ?? '') : null,
      button(init.kind === 'device' ? t.simulator.tryAgain : t.simulator.reconnect, () => action('reconnect'), { small: true }),
    );
  } else if (notRunning) {
    lines.push(
      icon('debug-start', 'overlay__icon'),
      h('span', null, t.appWindow.notRunning),
      h('span', { class: 'overlay__buttons' }, button(t.common.live, () => action('live'), { icon: 'zap', small: true, primary: true }), button(t.common.run, () => action('run'), { icon: 'play', small: true })),
    );
  } else if (noWindow) {
    lines.push(icon('window', 'overlay__icon'), h('span', null, t.appWindow.noWindow), h('span', { class: 'faint' }, t.appWindow.noWindowBody));
  } else if (waiting && !reconnecting) {
    lines.push(
      icon(wait === 'device' ? 'plug' : 'shield', 'overlay__icon'),
      h('span', null, wait === 'device' ? t.simulator.plugIn(init.name, init.macLabel) : t.simulator.allowOnMac(init.macLabel)),
      h('span', { class: 'faint' }, wait === 'device' ? t.simulator.plugInBody : t.simulator.allowOnMacBody),
    );
  } else {
    const text = reconnecting
      ? app ? t.appWindow.reconnectingMac : t.simulator.reconnectingMac
      : app
        ? state.kind === 'connecting' ? t.appWindow.connectingTo(init.macLabel) : t.appWindow.waiting
        : init.kind === 'device'
          ? preparing?.stage === 'building' ? t.simulator.deviceSettingUp : preparing?.stage === 'starting' || info ? t.simulator.deviceStarting(init.name) : t.simulator.connectingTo(init.name)
          : preparing?.stage === 'building' ? t.simulator.settingUp(preparing.xcode) : preparing?.stage === 'starting' ? t.simulator.startingSmooth : t.simulator.connectingTo(init.name);
    lines.push(h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, text));
    if (!reconnecting && preparing?.stage === 'building' && !app) lines.push(h('span', { class: 'faint' }, t.simulator.firstTime));
  }
  overlay.replaceChildren(...lines.filter((l): l is HTMLElement => l !== null));
}

function statsTip(): string {
  if (!init) return '';
  const app = isApp();
  const overInternet = init.route === 'direct' || init.route === 'relay';
  return [
    codec === 'h264' ? (app ? t.appWindow.streamSmooth : t.simulator.streamSmooth) : codec === 'jpeg' ? (app ? t.appWindow.streamCompatible : t.simulator.streamCompatible) : null,
    overInternet ? t.simulator.overInternetRoute(init.route as 'direct' | 'relay', init.rttMs) : null,
    codec === 'h264' && targetBitrate ? t.simulator.upTo(formatRate(Math.round(targetBitrate / 1000))) : null,
    stats && codec === 'h264' && stats.latencyMs !== null ? t.simulator.delay(Math.round(stats.latencyMs), Math.round(stats.latencyP95Ms ?? stats.latencyMs)) : null,
    stats && stats.fps > 0 ? t.simulator.decode(stats.decodeMs.toFixed(1)) : null,
    stats?.inputMs != null ? (app ? t.appWindow.clickResponse(Math.round(stats.inputMs)) : t.simulator.touch(Math.round(stats.inputMs))) : null,
    stats && stats.fps === 0 ? (app ? t.appWindow.still : t.simulator.still) : null,
  ].filter(Boolean).join(' · ');
}

function typeBox(placeholder: string, label: string): HTMLElement {
  const field = h('input', { class: 'input toolbar__type', placeholder, 'aria-label': label });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && field.value) {
      e.preventDefault();
      send({ kind: 'text', text: field.value.slice(0, 20_000) });
      field.value = '';
    }
    e.stopPropagation();
  });
  return field;
}

function renderToolbar(): void {
  if (!init) return;
  const app = isApp();
  const items: Array<HTMLElement | null> = [];
  const streaming = state.kind === 'streaming';
  const dot = h('span', { class: `status-dot${streaming ? ' is-live' : state.kind === 'ended' ? ' is-off' : ''}`, title: streaming ? t.simulator.live : t.simulator.disconnected });
  items.push(h('span', { class: 'toolbar__name truncate', title: init.name }, dot, app ? windowTitle() : init.name));
  if (app) {
    if (windows.length > 1) {
      const select = h('select', { class: 'toolbar__select', 'aria-label': t.appWindow.chooseWindow, onchange: (e: Event) => {
        const value = (e.target as HTMLSelectElement).value;
        toWorker({ type: 'window', window: value === 'follow' ? null : Number(value) });
      } },
      ...windows.map((w) => h('option', { value: String(w.id), selected: w.id === watched }, `${w.title || t.appWindow.untitled(w.id)}${w.minimized ? ` (${t.appWindow.minimizedOnMac})` : ''}`)),
      h('option', { value: 'follow' }, t.appWindow.followActive));
      items.push(select);
    }
    items.push(typeBox(t.appWindow.typePlaceholder, t.appWindow.typeTitle));
    if (sound) {
      const select = h('select', { class: 'toolbar__select', title: t.appWindow.sound, 'aria-label': t.appWindow.sound, onchange: (e: Event) => {
        const mode = (e.target as HTMLSelectElement).value as SoundMode;
        if (mode === 'pc') (player ??= new AppAudioPlayer()).start();
        toWorker({ type: 'dialog', command: { type: 'sound', mode } });
      } },
      h('option', { value: 'off', selected: sound.mode === 'off' }, t.appWindow.soundOff),
      h('option', { value: 'mac', selected: sound.mode === 'mac' }, t.appWindow.soundMac),
      h('option', { value: 'pc', selected: sound.mode === 'pc', disabled: !sound.toPc }, sound.toPc ? t.appWindow.soundPc : `${t.appWindow.soundPc} (${t.appWindow.soundNeedsNewer})`));
      items.push(select);
    }
    if (init.live) items.push(button('', () => action('reload-app'), { icon: 'refresh', title: t.appWindow.reload, small: true }));
  } else {
    if (inputMode()) {
      items.push(button('', () => send({ kind: 'button', button: 'home' }), { icon: 'home', title: `${t.simulator.home} (Ctrl+Shift+H)`, small: true }));
      items.push(button('', () => send({ kind: 'button', button: 'lock' }), { icon: 'lock', title: `${t.simulator.lock} (Ctrl+Shift+L)`, small: true }));
      items.push(typeBox(t.simulator.typePlaceholder, t.simulator.typeTitle));
    } else if (info && init.kind === 'simulator') {
      items.push(h('span', { class: 'chip', title: tidy(info.inputReason) ?? t.simulator.viewOnlyWhy }, t.simulator.viewOnly));
      items.push(button(t.simulator.installAxe, () => action('fix-axe'), { small: true }));
    } else if (info && init.kind === 'device') {
      items.push(h('span', { class: 'chip', title: t.simulator.deviceViewOnly }, t.simulator.viewOnly));
    }
  }
  items.push(h('span', { class: 'toolbar__spacer' }));
  if (fallback) {
    const note = h('details', { class: 'compat' },
      h('summary', null, icon('info'), t.simulator.compatible),
      h('div', { class: 'compat__body' },
        h('strong', null, t.simulator.usingCompatible),
        h('p', null, tidy(fallback.message) ?? ''),
        fallback.hint ? h('p', { class: 'faint' }, tidy(fallback.hint) ?? '') : null,
        fallback.details?.length ? h('pre', null, fallback.details.join('\n')) : null,
        h('div', { class: 'compat__actions' },
          fallback.restartSimulator && !app ? button(t.simulator.restart, () => action('restart-simulator'), { icon: 'debug-restart', small: true }) : null,
          button(t.simulator.trySmooth, () => {
            fallback = null;
            toWorker({ type: 'retry-smooth' });
            renderToolbar();
          }, { icon: 'refresh', small: true, primary: true }),
        ),
      ),
    );
    items.push(note);
  }
  if (stats && streaming) items.push(h('span', { class: 'chip chip--stats', title: statsTip() }, codec === 'h264' ? `${stats.fps} fps` : `${stats.fps} fps · ${formatRate(stats.kbps)}`));
  items.push(button('', () => action('screenshot', app ? { window: watched } : {}), { icon: 'device-camera', title: app ? t.simulator.screenshot : `${t.simulator.screenshot} (Ctrl+Shift+S)`, small: true }));
  toolbar.replaceChildren(...items.filter((i): i is HTMLElement => i !== null));
  toolbar.setAttribute('aria-label', app ? t.appWindow.controls : init.kind === 'device' ? t.simulator.deviceControls : t.simulator.controls);
}

// ─── Messages from the extension ───────────────────────────────────────────

window.addEventListener('message', (e: MessageEvent<FromExtension>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      init = m.init;
      streamId = m.streamId;
      early = [];
      device.hidden = false;
      toolbar.hidden = false;
      stage.querySelector('.none')?.remove();
      state = { kind: 'connecting' };
      info = null;
      codec = null;
      fallback = null;
      preparing = null;
      wait = null;
      frameSize = null;
      hasFrame = false;
      stats = null;
      windows = [];
      watched = null;
      appWaiting = m.init.kind === 'app';
      sentVideoSize = 0;
      dialogs.clear();
      document.body.dataset.kind = m.init.kind;
      void startWorker().then(() => {
        layout();
        render();
      });
      render();
      break;
    case 'port': {
      if (m.streamId !== streamId) break;
      const message = m.message as ScreenPortMessage & { data?: ArrayBuffer; packets?: ArrayBuffer[] };
      const transfer: Transferable[] = message.data instanceof ArrayBuffer ? [message.data] : message.packets?.filter((p) => p instanceof ArrayBuffer) ?? [];
      if (port) port.postMessage(message, transfer);
      else early.push({ message, transfer });
      break;
    }
    case 'closed':
      state = { kind: 'ended' };
      render();
      break;
    case 'run-state':
      if (init) {
        init = { ...init, running: m.running, live: m.live };
        render();
      }
      break;
    case 'route':
      if (init) init = { ...init, route: m.route, rttMs: m.rttMs };
      break;
    case 'frame':
      if (init) {
        init = { ...init, frame: m.frame };
        layout();
      }
      break;
    case 'none':
      // No stream: the device and toolbar give way to a note.
      streamId = '';
      stopWorker();
      init = null;
      dialogs.clear();
      player?.stop();
      device.hidden = true;
      toolbar.hidden = true;
      toolbar.replaceChildren();
      stage.querySelector('.none')?.remove();
      stage.append(h('div', { class: 'none' }, icon('window', 'none__icon'), h('span', null, m.text)));
      break;
  }
});

// Ctrl+Shift+S: a screenshot, as in Studio.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    action('screenshot', isApp() ? { window: watched } : {});
  }
});

post({ type: 'ready' });
