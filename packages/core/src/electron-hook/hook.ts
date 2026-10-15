/**
 * CapMac's module inside an Electron app on the Mac. The agent launches the
 * app with NODE_OPTIONS=--require <this file>, so every Node.js process the
 * launch starts loads it (npm, a dev server, Electron): it does nothing unless
 * it is in Electron's main process and the agent asked for it (ENV_SOCKET).
 *
 * In the app it:
 *  - marks what the main process prints, and reports windows and the pages'
 *    console on stdout (marked lines, see shared/electron.ts);
 *  - serves the windows on a Unix socket: H.264 video captured the way
 *    Chromium captures a tab (video.ts), or JPEG frames from the app's own
 *    compositor (no Screen Recording permission needed either way), input
 *    through sendInputEvent (no Accessibility permission, no focus stealing),
 *    menu shortcuts the way macOS runs them, screenshots, reloads;
 *  - keeps the app from taking the Mac's focus: someone may be working there
 *    (see "The Mac's focus");
 *  - for Capacitor live reload, loads the dev server instead of the bundled
 *    assets.
 *
 * It must never break the app: everything is guarded, and it changes app
 * behaviour only while CapMac watches (background throttling, App Nap), in
 * ways CapMac's view needs (DevTools open in their own window), or to leave
 * the Mac's focus alone.
 */
import fs from 'node:fs';
import Module from 'node:module';
import net from 'node:net';
import os from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { encodeBinary, encodeJson, FrameDecoder } from '../shared/frames.js';
import { STREAM_CONFIG } from '../shared/stream.js';
import { CapturePage } from './capture.js';
import { DialogService, runDialogWorker } from './dialogs.js';
import { SoundControl, soundPageScript } from './sound.js';
import { VideoCapture, videoPageScript, videoSize } from './video.js';
import {
  dialogSocket,
  ENV_LIVE_SCHEME,
  ENV_LIVE_URL,
  ENV_PROJECT,
  ENV_SOCKET,
  ENV_SOUND,
  isSoundMode,
  frontFile,
  HOOK_MARK,
  KEY_ALT,
  KEY_CONTROL,
  KEY_META,
  KEY_SHIFT,
  MAIN_MARK,
  ROLE_ACCELERATORS,
  electronKeyCode,
  electronModifiers,
  matchesAccelerator,
  parseAccelerator,
  typedText,
  type AppInputEvent,
  type AppWindowInfo,
  type HookAppInfo,
  type HookEvent,
  type HookMessage,
  type HookRequest,
  formatConsoleArgs,
  formatConsoleValue,
  withoutConsoleStyles,
} from '../shared/electron.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Electron is loaded at run time from the app's own copy. */
type Electron = any;
type BrowserWindow = any;
type NativeImage = any;

let rawStdout: (text: string) => void = (text) => {
  process.stdout.write(text);
};

/** Reports an event on the app's stdout, past the main-process marking. */
function report(event: HookEvent): void {
  try {
    rawStdout(`${HOOK_MARK}${JSON.stringify(event)}\n`);
  } catch {
    // stdout is gone: nothing to report to
  }
}

/** Marks every line the main process prints, so CapMac can tell it from a dev server's output. */
function markMainOutput(): void {
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = process[name] as NodeJS.WriteStream & { write: (...args: any[]) => boolean };
    const original = stream.write;
    const raw = (text: string) => original.call(stream, text);
    if (name === 'stdout') rawStdout = raw;
    let lineStart = true;
    stream.write = function (chunk: any, encoding?: any, callback?: any): boolean {
      try {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
        let out = '';
        for (const part of text.split(/(?<=\n)/)) {
          if (lineStart && part) out += MAIN_MARK;
          out += part;
          if (part) lineStart = part.endsWith('\n');
        }
        return original.call(stream, out, 'utf8', typeof encoding === 'function' ? encoding : callback);
      } catch {
        return original.apply(stream, arguments as any);
      }
    } as typeof stream.write;
  }
}

const clamp01 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// ─── The Mac's focus ─────────────────────────────────────────────────────
//
// Someone may be working on the Mac while CapMac runs the app: it must not
// take their keyboard or cover their work. While the app is not the active
// app, its windows open behind every other window without activating it,
// focus requests give the page the keyboard and nothing more, and DevTools
// and full screen wait until someone switches to the app. CapMac's view
// treats the window the app brought forward (or the one used through CapMac)
// as the focused one. Once someone uses the app on the Mac (clicks it or its
// Dock icon, its menu bar icon, a global shortcut), it behaves as usual.

const GUARDED = Symbol.for('capmac.guarded');
let guardInstalled = false;
/** Electron's own methods, before the guard wrapped them. */
const raw: Record<string, (...args: any[]) => any> = {};
/** Builds a window the guard way (set once the guard is installed). */
let constructWindow: (target: any, args: any[], newTarget: any) => object = (target, args, newTarget) => Reflect.construct(target, args, newTarget);
/** The window CapMac treats as focused while the app is in the background. */
let virtualFocus: BrowserWindow | null = null;
/** Tells CapMac's view that another window came forward. */
let onForward: ((win: BrowserWindow) => void) | null = null;
const pageFocused = new WeakSet<object>();
/** The app's dialogs while it is in the background (see dialogs.ts); set with the guard. */
let dialogs: DialogService | null = null;
/** The project's folder on the Mac, for file dialogs (the agent says, see ENV_PROJECT). */
let projectDir: string | null = null;
/** Where the app's sound plays when it starts (the agent says, see ENV_SOUND; off unless asked). */
let initialSound: 'off' | 'mac' | 'pc' = 'off';

/** Wraps a method once; a read-only one stays as it is. */
function wrap(target: any, name: string, make: (original: (...args: any[]) => any) => (...args: any[]) => any): void {
  try {
    const original = target?.[name];
    if (typeof original !== 'function' || original[GUARDED]) return;
    const replacement = make(original) as any;
    replacement[GUARDED] = true;
    target[name] = replacement;
  } catch {
    // read-only in this Electron
  }
}

/** The window came forward in the app (it showed or focused it, or someone used it through CapMac). */
function bringForward(win: BrowserWindow): void {
  if (virtualFocus === win) return;
  virtualFocus = win;
  try {
    onForward?.(win);
  } catch {
    // CapMac's view is closing
  }
}

/** Gives the window's page the keyboard (a caret, focus events) without making the app active. */
function givePageFocus(win: BrowserWindow): void {
  try {
    const focused = raw.isFocused ? raw.isFocused.call(win) : win.isFocused();
    if (focused || pageFocused.has(win)) return;
    win.focusOnWebView();
    pageFocused.add(win);
  } catch {
    // closing, or a window without a page
  }
}

export function guardFocus(electron: Electron, socketPath: string): void {
  if (guardInstalled) return;
  guardInstalled = true;
  const { app, BrowserWindow } = electron;
  const base = electron.BaseWindow?.prototype ?? Object.getPrototypeOf(BrowserWindow.prototype);
  for (const name of ['showInactive', 'blur', 'isFocused', 'setFullScreen', 'setSimpleFullScreen', 'setKiosk']) {
    if (typeof base?.[name] === 'function') raw[name] = base[name];
  }

  let active = false;
  /** Until then the app's own requests go ahead: someone used the app on the Mac, or it was in front before a restart. */
  let allowedUntil = 0;
  let quitting = false;
  const inBackground = () => !active && Date.now() > allowedUntil;
  const allowBriefly = () => {
    allowedUntil = Math.max(allowedUntil, Date.now() + 1500);
  };
  const front = frontFile(socketPath);
  try {
    if (fs.readFileSync(front, 'utf8').trim() === '1') allowedUntil = Date.now() + 15_000;
  } catch {
    // a new launch
  }
  const remember = (isFront: boolean) => {
    if (quitting) return;
    try {
      fs.writeFileSync(front, isFront ? '1' : '0');
    } catch {
      // the run folder is gone
    }
  };
  const told = new Set<string>();
  const note = (message: string) => {
    if (told.has(message)) return;
    told.add(message);
    report({ e: 'note', message });
  };
  // A message box or file picker would activate the app: while it is in the background, CapMac shows it instead.
  dialogs = new DialogService({
    inBackground,
    windowId: (win) => {
      try {
        return typeof (win as BrowserWindow)?.id === 'number' && !(win as BrowserWindow).isDestroyed() ? (win as BrowserWindow).id : null;
      } catch {
        return null;
      }
    },
    appName: () => {
      try {
        return String(app.getName());
      } catch {
        return '';
      }
    },
  }, { project: projectDir });

  /** Shows a window without activating the app: behind every other window (a child window stays on its parent). */
  function showBehind(win: BrowserWindow): void {
    try {
      if (win.isDestroyed() || win.isMinimized()) return;
      raw.showInactive?.call(win);
      if (!win.getParentWindow?.()) raw.blur?.call(win);
    } catch {
      // closing
    }
  }
  /** A sheet: macOS shows it on its window without switching apps. */
  const isSheet = (win: BrowserWindow) => {
    try {
      return Boolean(win.isModal?.() && win.getParentWindow?.());
    } catch {
      return false;
    }
  };

  type ScreenMode = 'setFullScreen' | 'setSimpleFullScreen' | 'setKiosk';
  const pendingScreen = new Map<BrowserWindow, Set<ScreenMode>>();
  const deferScreen = (win: BrowserWindow, mode: ScreenMode) => {
    let modes = pendingScreen.get(win);
    if (!modes) {
      const created = new Set<ScreenMode>();
      modes = created;
      pendingScreen.set(win, created);
      win.once?.('closed', () => pendingScreen.delete(win));
    }
    modes.add(mode);
    note('Full screen waits until you switch to the app on the Mac, so it does not take over the screen');
  };
  const pendingDevTools = new Map<any, Record<string, unknown>>();

  constructWindow = (target, args, newTarget) => {
    const options = args[0] && typeof args[0] === 'object' ? args[0] : {};
    if (!inBackground() || (options.modal && options.parent)) return Reflect.construct(target, args, newTarget);
    const show = options.show !== false;
    const screens = ([['fullscreen', 'setFullScreen'], ['simpleFullscreen', 'setSimpleFullScreen'], ['kiosk', 'setKiosk']] as const).filter(([key]) => options[key] === true);
    if (!show && screens.length === 0) return Reflect.construct(target, args, newTarget);
    const next = { ...options, show: false };
    for (const [key] of screens) delete next[key];
    const win = Reflect.construct(target, [next, ...args.slice(1)], newTarget) as BrowserWindow;
    for (const [, mode] of screens) deferScreen(win, mode);
    if (show) {
      showBehind(win);
      bringForward(win);
    }
    return win;
  };

  for (const proto of [base, BrowserWindow.prototype]) {
    wrap(proto, 'show', (show) => function (this: BrowserWindow) {
      if (!inBackground() || isSheet(this)) return show.call(this);
      showBehind(this);
      bringForward(this);
    });
    wrap(proto, 'showInactive', (showInactive) => function (this: BrowserWindow) {
      if (!inBackground() || this.getParentWindow?.()) return showInactive.call(this);
      showBehind(this);
    });
    wrap(proto, 'focus', (focus) => function (this: BrowserWindow) {
      if (!inBackground()) return focus.call(this);
      if (!this.isVisible()) showBehind(this);
      givePageFocus(this);
      bringForward(this);
    });
    wrap(proto, 'moveTop', (moveTop) => function (this: BrowserWindow) {
      if (!inBackground()) return moveTop.call(this);
    });
    wrap(proto, 'isFocused', (isFocused) => function (this: BrowserWindow) {
      if (isFocused.call(this)) return true;
      return inBackground() && this === virtualFocus && !this.isDestroyed() && this.isVisible();
    });
    for (const mode of ['setFullScreen', 'setSimpleFullScreen', 'setKiosk'] as const) {
      wrap(proto, mode, (set) => function (this: BrowserWindow, flag: unknown, ...rest: unknown[]) {
        if (flag && inBackground()) return deferScreen(this, mode);
        pendingScreen.get(this)?.delete(mode);
        return set.call(this, flag, ...rest);
      });
    }
  }
  wrap(app, 'focus', (focus) => function (this: unknown, ...args: unknown[]) {
    if (!inBackground()) return focus.apply(this, args);
  });
  // A link the app opens goes to the Mac's browser without bringing it forward.
  wrap(electron.shell, 'openExternal', (open) => function (this: unknown, url: unknown, options?: Record<string, unknown>) {
    return open.call(this, url, inBackground() ? { ...options, activate: false } : options);
  });

  let contentsGuarded = false;
  const guardContents = (wc: any) => {
    if (contentsGuarded || !wc) return;
    contentsGuarded = true;
    const proto = Object.getPrototypeOf(wc);
    wrap(proto, 'openDevTools', (open) => {
      raw.openDevTools = open;
      return function (this: any, options?: Record<string, unknown>) {
        // Docked DevTools would squeeze the page CapMac shows: they get their own window, which never takes the keyboard.
        const next = { ...options, mode: 'detach', activate: false };
        if (!inBackground()) return open.call(this, next);
        pendingDevTools.set(this, next);
        note('DevTools open once you switch to the app on the Mac, so they do not pop up over other work');
      };
    });
    wrap(proto, 'toggleDevTools', (toggle) => function (this: any) {
      if (pendingDevTools.delete(this)) return;
      if (this.isDevToolsOpened()) return toggle.call(this);
      return this.openDevTools();
    });
    wrap(proto, 'closeDevTools', (close) => function (this: any) {
      pendingDevTools.delete(this);
      return close.call(this);
    });
    // On the Mac, focusing a page focuses its window too, which activates the app.
    wrap(proto, 'focus', (focus) => function (this: any) {
      if (!inBackground()) return focus.call(this);
      const win = BrowserWindow.fromWebContents?.(this);
      if (!win) return;
      if (!win.isVisible()) showBehind(win);
      givePageFocus(win);
      bringForward(win);
    });
  };
  app.on('web-contents-created', (_e: unknown, wc: any) => guardContents(wc));
  try {
    guardContents(electron.webContents?.getAllWebContents?.()[0]);
  } catch {
    // before the app is ready
  }

  const onReady = () => {
    // Someone clicked the app's menu bar icon on the Mac: what it opens comes forward as usual.
    wrap(electron.Tray?.prototype, 'emit', (emit) => function (this: unknown, name: unknown, ...args: unknown[]) {
      if (typeof name === 'string' && !/^mouse-(move|enter|leave)$/.test(name)) allowBriefly();
      return emit.call(this, name, ...args);
    });
    // Same for the app's global shortcuts, which only someone at the Mac can press.
    for (const name of ['register', 'registerAll']) {
      wrap(electron.globalShortcut, name, (register) => function (this: unknown, accelerator: unknown, callback: unknown, ...rest: unknown[]) {
        const run = typeof callback === 'function'
          ? function (this: unknown, ...args: unknown[]) {
            allowBriefly();
            return (callback as (...a: unknown[]) => unknown).apply(this, args);
          }
          : callback;
        return register.call(this, accelerator, run, ...rest);
      });
    }
  };
  if (app.isReady()) onReady();
  else app.once('ready', onReady);

  app.on('did-become-active', () => {
    active = true;
    remember(true);
    // Someone at the Mac comes first: dialogs waiting in CapMac show there now.
    dialogs?.appActivated();
    for (const [win, modes] of pendingScreen) {
      if (win.isDestroyed()) continue;
      for (const mode of modes) {
        try {
          raw[mode]?.call(win, true);
        } catch {
          // closing
        }
      }
    }
    pendingScreen.clear();
    for (const [wc, options] of pendingDevTools) {
      try {
        if (!wc.isDestroyed()) raw.openDevTools?.call(wc, options);
      } catch {
        // closing
      }
    }
    pendingDevTools.clear();
  });
  app.on('did-resign-active', () => {
    active = false;
    remember(false);
  });
  app.on('before-quit', () => {
    quitting = true;
  });
}

/** The app's own `require('electron')`, with window classes that open windows the guard way, and dialogs that stay off the Mac's screen. */
export function guardedElectron(electron: Electron): Electron {
  const classes = new Map<unknown, unknown>();
  let dialogModule: { original: unknown; wrapped: unknown } | null = null;
  return new Proxy(electron, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      // A proxy may only change what a property it could change reads.
      const own = Object.getOwnPropertyDescriptor(target, prop);
      if (own && !own.configurable && 'value' in own && !own.writable) return value;
      if (prop === 'dialog' && dialogs && value && typeof value === 'object') {
        // Electron's dialog module is read-only: the app gets one whose methods go through CapMac.
        if (!dialogModule || dialogModule.original !== value) dialogModule = { original: value, wrapped: dialogs.wrap(value) };
        return dialogModule!.wrapped;
      }
      if ((prop !== 'BrowserWindow' && prop !== 'BaseWindow') || typeof value !== 'function') return value;
      let guarded = classes.get(value);
      if (!guarded) {
        const proxy: any = new Proxy(value, {
          construct(windowClass, args, newTarget) {
            return constructWindow(windowClass, args, newTarget === proxy ? windowClass : newTarget);
          },
        });
        guarded = proxy;
        classes.set(value, proxy);
      }
      return guarded;
    },
  });
}

/**
 * Installs the focus guard when the app first loads `electron` (before it
 * opens a window). Preloads run before Electron sets the module up, so this
 * watches Node.js's loader instead.
 */
function watchElectronRequire(socketPath: string): void {
  try {
    const loader = Module as unknown as { _load: (...args: any[]) => any };
    const load = loader._load;
    if (typeof load !== 'function') return;
    let source: unknown = null;
    let guarded: unknown = null;
    loader._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
      const result = load.call(this, request, ...rest);
      if (typeof request !== 'string' || (request !== 'electron' && !request.startsWith('electron/')) || !result || typeof result !== 'object' || !(result as Electron).app) return result;
      if (source !== result) {
        guardFocus(result, socketPath);
        source = result;
        guarded = guardedElectron(result);
      }
      return guarded;
    };
  } catch {
    // a loader CapMac cannot watch: the guard starts with the rest of CapMac
  }
}

const ELECTRON_IMPORT = 'capmac:electron';
const IMPORTED = Symbol.for('capmac.electron');

/**
 * An app written as ES modules (`import { BrowserWindow } from 'electron'`)
 * skips that loader: its imports of `electron` get a module that re-exports
 * the guarded one (Node.js 22.15+, Electron 35+).
 */
function watchElectronImport(): void {
  const registerHooks = (Module as unknown as { registerHooks?: (hooks: unknown) => unknown }).registerHooks;
  if (typeof registerHooks !== 'function') return;
  try {
    registerHooks({
      resolve(specifier: string, context: { conditions?: string[] }, next: (specifier: string, context: unknown) => unknown) {
        const electronModule = specifier === 'electron' || specifier.startsWith('electron/');
        if (electronModule && context?.conditions?.includes('import')) return { url: ELECTRON_IMPORT, shortCircuit: true };
        return next(specifier, context);
      },
      load(url: string, context: unknown, next: (url: string, context: unknown) => unknown) {
        if (url !== ELECTRON_IMPORT) return next(url, context);
        // Through require: the guarded module (and the guard installed).
        const electron = require('electron');
        (globalThis as Record<symbol, unknown>)[IMPORTED] = electron;
        const names = Object.keys(electron).filter((name) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
        const source = [
          `const electron = globalThis[Symbol.for('capmac.electron')];`,
          'const read = (name) => { try { return electron[name]; } catch { return undefined; } };',
          'export default electron;',
          ...names.map((name) => `export const ${name} = read(${JSON.stringify(name)});`),
        ].join('\n');
        return { format: 'module', source, shortCircuit: true };
      },
    });
  } catch {
    // hooks not available: the guard starts with the rest of CapMac
  }
}

function start(electron: Electron, socketPath: string): void {
  // Already installed when the app loaded `electron` the usual way (require).
  guardFocus(electron, socketPath);
  const { app, BrowserWindow, Menu, clipboard, nativeTheme, powerSaveBlocker, screen } = electron;
  const windows = new Map<number, BrowserWindow>();
  const clients = new Set<Client>();
  const clientsById = new Map<number, Client>();
  let focusOrder: number[] = [];

  // ─── Sound and video ───────────────────────────────────────────────────
  //
  // One hidden page of CapMac's captures the windows for both (capture.ts).

  const capture = new CapturePage(electron, [soundPageScript(), videoPageScript()]);
  const sound = new SoundControl(electron, initialSound, {
    pages: () => [...windows.values()].filter((w) => w && !w.isDestroyed()).map((w) => w.webContents),
    onPackets: (packets) => {
      const data = packets.map((p) => p.toString('base64'));
      for (const client of clients) if (client.wantsAudio) client.send({ t: 'audio', packets: data });
    },
    note: (message) => report({ e: 'note', message }),
  }, capture);
  const video = new VideoCapture(capture, {
    onMessage: (key, message) => clientsById.get(key)?.sendVideo(message),
    onFailed: (key, reason) => clientsById.get(key)?.videoFailed(reason),
  });
  /** Why a client asking for video gets JPEG frames (null: it gets video). */
  function noVideoReason(failure: string | null): string | null {
    if (!capture.available) return `Electron ${process.versions.electron} can’t send its windows as video (that needs Electron 30 or later)`;
    const why = failure ?? video.broken;
    return why ? `The window couldn’t be sent as video: ${why}` : null;
  }
  /** The clients watching with sound, for the capture. */
  function listenersChanged(): void {
    let count = 0;
    for (const client of clients) if (client.wantsAudio) count += 1;
    sound.setListeners(count);
  }
  function soundChanged(): void {
    for (const client of clients) if (client.role === 'screen') client.send({ t: 'sound', mode: sound.mode, toPc: sound.canSendToPc });
  }

  // ─── Windows ───────────────────────────────────────────────────────────

  const alive = (win: BrowserWindow) => win && !win.isDestroyed();

  function infoOf(win: BrowserWindow): AppWindowInfo {
    const [width, height] = win.getContentSize();
    const bounds = win.getBounds();
    const content = win.getContentBounds();
    let scale = 1;
    try {
      scale = screen.getDisplayMatching(bounds).scaleFactor || 1;
    } catch {
      // before the app is ready
    }
    let buttons: AppWindowInfo['buttons'] = null;
    try {
      buttons = win.getWindowButtonPosition?.() ?? null;
    } catch {
      // not a macOS build
    }
    return {
      id: win.id,
      title: win.getTitle(),
      width,
      height,
      scale,
      focused: win.isFocused(),
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      titleBar: Math.max(0, bounds.height - content.height),
      buttons,
      url: win.webContents.getURL(),
      dark: Boolean(nativeTheme?.shouldUseDarkColors),
    };
  }

  function listWindows(): AppWindowInfo[] {
    return [...windows.values()].filter(alive).map(infoOf);
  }

  /** The size of a window's video, its longest side at most `maxSize` (see videoSize). */
  function videoSizeOf(win: BrowserWindow, maxSize: number): { width: number; height: number } {
    const info = infoOf(win);
    return videoSize(info.width, info.height, info.scale, maxSize);
  }

  /** The window to show when nobody picked one: the focused one, else the last focused, else the first visible. */
  function autoWindow(): BrowserWindow | null {
    const all = [...windows.values()].filter(alive);
    const focused = all.find((w) => w.isFocused());
    if (focused) return focused;
    for (const id of focusOrder) {
      const win = windows.get(id);
      if (alive(win) && win.isVisible()) return win;
    }
    return all.find((w) => w.isVisible()) ?? all[0] ?? null;
  }

  let windowsTimer: NodeJS.Timeout | null = null;
  /** Tells watching clients the windows changed (coalesced). */
  function windowsChanged(): void {
    if (windowsTimer) return;
    windowsTimer = setTimeout(() => {
      windowsTimer = null;
      for (const client of clients) client.windowsChanged();
    }, 30);
  }

  /** A window came forward while the app is in the background: CapMac's view follows it, the way it follows focus. */
  function cameForward(win: BrowserWindow): void {
    const id = win?.id;
    if (!windows.has(id)) return;
    focusOrder = [id, ...focusOrder.filter((other) => other !== id)];
    for (const client of clients) client.focusChanged();
    windowsChanged();
  }
  onForward = cameForward;

  function track(win: BrowserWindow): void {
    if (!win || windows.has(win.id)) return;
    const id = win.id;
    windows.set(id, win);
    if (liveUrl) patchLoadUrl(win);
    const wc = win.webContents;
    sound.track(wc);
    const changed = () => windowsChanged();
    for (const event of ['page-title-updated', 'show', 'hide', 'minimize', 'restore', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(event, changed);
    win.on('focus', () => {
      virtualFocus = win;
      focusOrder = [id, ...focusOrder.filter((other) => other !== id)];
      for (const client of clients) client.focusChanged();
      changed();
    });
    win.on('blur', () => {
      // The page lost the keyboard with its window: CapMac gives it back on the next input.
      pageFocused.delete(win);
      changed();
    });
    win.once('closed', () => {
      sound.forget(wc);
      if (virtualFocus === win) virtualFocus = null;
      windows.delete(id);
      focusOrder = focusOrder.filter((other) => other !== id);
      // Nothing to give back to a window that is gone, but App Nap may come back.
      if (subscriptions.delete(id)) updatePowerBlocker();
      for (const client of clients) client.windowClosed(id);
      report({ e: 'window-closed', id });
      changed();
    });
    wc.on('console-message', (...args: any[]) => {
      // The DevTools protocol reports this page's console (see consoleOverProtocol).
      if (protocolConsole.has(wc)) return;
      // Electron 35+: one event object; before: (event, level, message, line, sourceId).
      const e = args[0] ?? {};
      const legacy = typeof args[1] === 'number';
      const levels = ['debug', 'info', 'warning', 'error'] as const;
      const level = legacy ? levels[args[1]] ?? 'info' : (levels as readonly string[]).includes(e.level) ? e.level : 'info';
      const text = withoutConsoleStyles(String(legacy ? args[2] : e.message ?? ''));
      const line = legacy ? args[3] : e.lineNumber;
      const source = legacy ? args[4] : e.sourceId;
      report({ e: 'console', level, text, source: source || undefined, line: typeof line === 'number' && line > 0 ? line : undefined, window: id });
    });
    wc.on('did-fail-load', (_e: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
      // -3 is a load that was replaced by another one (not a failure).
      if (isMainFrame !== false && code !== -3) report({ e: 'load-failed', window: id, code, description, url });
    });
    wc.on('render-process-gone', (_e: unknown, details: { reason?: string }) => report({ e: 'crashed', window: id, reason: String(details?.reason ?? 'unknown') }));
    wc.on('unresponsive', () => report({ e: 'unresponsive', window: id }));
    wc.on('did-navigate', changed);
    wc.on('cursor-changed', (_e: unknown, type: string) => {
      for (const client of clients) if (client.watching?.win === win) client.send({ t: 'cursor', cursor: String(type) });
    });
    consoleOverProtocol(wc, id);
    report({ e: 'window', window: infoOf(win) });
    changed();
  }

  // ─── The pages' console, through the DevTools protocol ─────────────────
  //
  // Electron's console-message event hands over "dispatch [object Object]";
  // the protocol gives each argument with a preview, so the line reads as in
  // DevTools: "dispatch {type: 'roll', by: 'red'}". CapMac steps aside when
  // the app wants the page's debugger itself (it falls back to the event).

  const protocolConsole = new WeakSet<object>();
  const ownDebugger = new WeakSet<object>();
  let debuggerGuarded = false;
  const CONSOLE_LEVELS: Record<string, 'debug' | 'info' | 'warning' | 'error'> = { debug: 'debug', info: 'info', warning: 'warning', error: 'error', assert: 'error', trace: 'info' };

  /** The app attaches its own debugger: CapMac lets go of the page first. */
  function guardDebugger(dbg: any): void {
    if (debuggerGuarded) return;
    debuggerGuarded = true;
    const proto = Object.getPrototypeOf(dbg);
    wrap(proto, 'attach', (attach) => function (this: any, ...args: unknown[]) {
      if (ownDebugger.has(this)) {
        ownDebugger.delete(this);
        try {
          raw.detachDebugger?.call(this);
        } catch {
          // gone already
        }
      }
      return attach.apply(this, args);
    });
    wrap(proto, 'isAttached', (isAttached) => function (this: any) {
      return ownDebugger.has(this) ? false : isAttached.call(this);
    });
    raw.detachDebugger = proto.detach;
  }

  function consoleOverProtocol(wc: any, id: number): void {
    const dbg = wc.debugger;
    if (!dbg || typeof dbg.attach !== 'function' || typeof dbg.sendCommand !== 'function') return;
    try {
      guardDebugger(dbg);
      if (dbg.isAttached()) return;
      dbg.attach('1.3');
    } catch {
      return;
    }
    ownDebugger.add(dbg);
    let count = 0;
    // Enabling replays what the page logged before: already reported through the event.
    const since = Date.now();
    const report1 = (level: 'debug' | 'info' | 'warning' | 'error', text: string, url?: string, line?: number) =>
      report({ e: 'console', level, text, source: url || undefined, line: typeof line === 'number' && line >= 0 ? line + 1 : undefined, window: id });
    const onMessage = (_event: unknown, method: string, params: any) => {
      try {
        if (method === 'Runtime.consoleAPICalled') {
          if (params.timestamp < since || params.type === 'endGroup' || params.type === 'clear' || params.type === 'profile' || params.type === 'profileEnd') return;
          const frame = params.stackTrace?.callFrames?.[0];
          const text = params.type === 'assert' ? `Assertion failed: ${formatConsoleArgs(params.args ?? [])}` : formatConsoleArgs(params.args ?? []);
          report1(CONSOLE_LEVELS[params.type] ?? 'info', text, frame?.url, frame?.lineNumber);
          // The page keeps what it logged for DevTools: let it go now and then (objects stay alive otherwise).
          if (++count % 200 === 0) dbg.sendCommand('Runtime.discardConsoleEntries').catch(() => undefined);
        } else if (method === 'Runtime.exceptionThrown') {
          const details = params.exceptionDetails ?? {};
          if (params.timestamp < since) return;
          const what = details.exception ? formatConsoleValue(details.exception) : details.text;
          report1('error', /^Uncaught/.test(what) ? what : `Uncaught ${what}`, details.url, details.lineNumber);
        } else if (method === 'Log.entryAdded') {
          const entry = params.entry ?? {};
          if (entry.timestamp < since) return;
          report1(entry.level === 'verbose' ? 'debug' : CONSOLE_LEVELS[entry.level] ?? 'info', String(entry.text ?? ''), entry.url, entry.lineNumber);
        }
      } catch {
        // a message CapMac does not read
      }
    };
    const stop = () => {
      protocolConsole.delete(wc);
      ownDebugger.delete(dbg);
      dbg.removeListener('message', onMessage);
      dbg.removeListener('detach', stop);
    };
    dbg.on('message', onMessage);
    dbg.on('detach', stop);
    protocolConsole.add(wc);
    Promise.all([dbg.sendCommand('Runtime.enable'), dbg.sendCommand('Log.enable')]).catch(() => {
      stop();
      try {
        dbg.detach();
      } catch {
        // gone already
      }
    });
  }

  // ─── Frames ────────────────────────────────────────────────────────────

  interface Subscription {
    win: BrowserWindow;
    latest: NativeImage | null;
    /** Bumped on every paint. */
    version: number;
    /** The clients showing the window: it keeps painting while there are any. */
    clients: Set<Client>;
    /** Those taking JPEG frames: the app's compositor hands them over while there are any (video comes from the capture page). */
    jpeg: Set<Client>;
    throttling: boolean | null;
  }

  const subscriptions = new Map<number, Subscription>();
  let blocker: number | null = null;

  function updatePowerBlocker(): void {
    // App Nap would slow a hidden or covered app down while CapMac shows it.
    const want = subscriptions.size > 0;
    try {
      if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
      if (!want && blocker !== null) {
        powerSaveBlocker.stop(blocker);
        blocker = null;
      }
    } catch {
      // not available
    }
  }

  /** `client` shows the window, with JPEG frames (`jpeg`) or video. */
  function subscribe(win: BrowserWindow, client: Client, jpeg: boolean): Subscription {
    let sub = subscriptions.get(win.id);
    if (!sub) {
      const wc = win.webContents;
      let throttling: boolean | null = null;
      try {
        throttling = wc.getBackgroundThrottling?.() ?? null;
      } catch {
        throttling = null;
      }
      const created: Subscription = { win, latest: null, version: 0, clients: new Set(), jpeg: new Set(), throttling };
      sub = created;
      subscriptions.set(win.id, created);
      // A covered, minimized or hidden window keeps painting while CapMac shows it.
      wc.setBackgroundThrottling(false);
      updatePowerBlocker();
    }
    sub.clients.add(client);
    if (jpeg) takeFrames(sub, client, true);
    return sub;
  }

  /** Whether `client` takes JPEG frames of the window from now on. */
  function takeFrames(sub: Subscription, client: Client, on: boolean): void {
    if (!on) {
      if (!sub.jpeg.delete(client) || sub.jpeg.size > 0) return;
      sub.latest = null;
      try {
        if (alive(sub.win)) sub.win.webContents.endFrameSubscription();
      } catch {
        // closing
      }
      return;
    }
    if (sub.jpeg.has(client) || !alive(sub.win)) return;
    sub.jpeg.add(client);
    try {
      if (sub.jpeg.size === 1) {
        sub.win.webContents.beginFrameSubscription(false, (image: NativeImage) => {
          sub.latest = image;
          sub.version += 1;
          for (const c of sub.jpeg) c.offer();
        });
      }
      // Paint now, so the first frame does not wait for the page to change; a window that does not paint gets a capture.
      sub.win.webContents.invalidate();
    } catch {
      // closing
    }
    const before = sub.version;
    setTimeout(() => {
      if (sub.version !== before || !sub.jpeg.has(client) || !alive(sub.win)) return;
      sub.win.webContents.capturePage().then((image: NativeImage) => {
        if (sub.version !== before || sub.jpeg.size === 0) return;
        sub.latest = image;
        sub.version += 1;
        for (const c of sub.jpeg) c.offer();
      }, () => undefined);
    }, 400);
  }

  function unsubscribe(sub: Subscription, client: Client): void {
    takeFrames(sub, client, false);
    sub.clients.delete(client);
    if (sub.clients.size > 0 || subscriptions.get(sub.win.id) !== sub) return;
    subscriptions.delete(sub.win.id);
    if (alive(sub.win)) {
      try {
        if (sub.throttling !== null) sub.win.webContents.setBackgroundThrottling(sub.throttling);
      } catch {
        // closing
      }
    }
    updatePowerBlocker();
  }

  // ─── Input ─────────────────────────────────────────────────────────────

  let lastClipboard: string | null = null;
  /** After a copy or cut, hands the copied text to the PC. */
  function clipboardChanged(): void {
    const check = () => {
      try {
        const text = clipboard.readText();
        if (text && text !== lastClipboard) {
          lastClipboard = text;
          for (const client of clients) if (client.role === 'screen') client.send({ t: 'clipboard', text: text.slice(0, 200_000) });
        }
      } catch {
        // no clipboard
      }
    };
    setTimeout(check, 120);
    setTimeout(check, 400);
  }

  /** What a menu role does, run on `win` (the window CapMac shows) instead of the focused one. */
  function runRole(role: string, win: BrowserWindow): boolean {
    const wc = win.webContents;
    switch (role) {
      case 'undo':
        wc.undo();
        return true;
      case 'redo':
        wc.redo();
        return true;
      case 'cut':
        wc.cut();
        clipboardChanged();
        return true;
      case 'copy':
        wc.copy();
        clipboardChanged();
        return true;
      case 'paste':
        wc.paste();
        return true;
      case 'pasteandmatchstyle':
        wc.pasteAndMatchStyle();
        return true;
      case 'delete':
        wc.delete();
        return true;
      case 'selectall':
        wc.selectAll();
        return true;
      case 'reload':
        wc.reload();
        return true;
      case 'forcereload':
        wc.reloadIgnoringCache();
        return true;
      case 'toggledevtools':
        wc.toggleDevTools();
        return true;
      case 'resetzoom':
        wc.setZoomLevel(0);
        return true;
      case 'zoomin':
        wc.setZoomLevel(wc.getZoomLevel() + 0.5);
        return true;
      case 'zoomout':
        wc.setZoomLevel(wc.getZoomLevel() - 0.5);
        return true;
      case 'togglefullscreen':
        win.setFullScreen(!win.isFullScreen());
        return true;
      case 'close':
        win.close();
        return true;
      case 'minimize':
        win.minimize();
        return true;
      case 'quit':
        app.quit();
        return true;
      case 'hide':
        app.hide();
        return true;
      default:
        return false;
    }
  }

  /**
   * A ⌘ shortcut, the way macOS runs it: the menu item with that key
   * equivalent. Synthetic key events never reach the menu by themselves.
   */
  function menuShortcut(win: BrowserWindow, key: string, code: string, modifiers: number): boolean {
    const menu = Menu.getApplicationMenu();
    if (!menu) return false;
    const visit = (items: any[]): any => {
      for (const item of items ?? []) {
        if (item.visible === false) continue;
        if (item.submenu) {
          const found = visit(item.submenu.items);
          if (found) return found;
          continue;
        }
        const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
        const accelerator = typeof item.accelerator === 'string' ? item.accelerator : ROLE_ACCELERATORS[role];
        const parsed = accelerator ? parseAccelerator(accelerator) : null;
        if (parsed && matchesAccelerator(parsed, key, code, modifiers)) return item;
      }
      return null;
    };
    const item = visit(menu.items);
    if (!item) return false;
    // A disabled item swallows its shortcut (the Mac beeps).
    if (item.enabled === false) return true;
    const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
    if (role && runRole(role, win)) return true;
    if (typeof item.click === 'function') {
      const event = { shiftKey: Boolean(modifiers & KEY_SHIFT), ctrlKey: Boolean(modifiers & KEY_CONTROL), altKey: Boolean(modifiers & KEY_ALT), metaKey: Boolean(modifiers & KEY_META), triggeredByAccelerator: true };
      item.click(event, win, win.webContents);
      return true;
    }
    return false;
  }

  /**
   * Waits until the page handled what went before it. Editing commands
   * (paste, select all) and inserted text travel apart from key events, so
   * without this a key sent right after can overtake them.
   */
  function settle(wc: any): Promise<void> {
    return Promise.race([wc.executeJavaScript('0', false), new Promise((resolve) => setTimeout(resolve, 400))]).then(() => undefined, () => undefined);
  }

  async function input(win: BrowserWindow, event: AppInputEvent): Promise<void> {
    const wc = win.webContents;
    const [width, height] = win.getContentSize();
    if (event.kind !== 'wheel' && (event.kind !== 'mouse' || event.phase === 'down')) {
      // Someone is using this window through CapMac: it gets the keyboard, without taking the Mac's.
      givePageFocus(win);
      bringForward(win);
    }
    switch (event.kind) {
      case 'mouse': {
        const x = Math.round(clamp01(event.x) * width);
        const y = Math.round(clamp01(event.y) * height);
        const modifiers = electronModifiers(event.modifiers);
        const buttons = event.buttons ?? 0;
        if (buttons & 1) modifiers.push('leftButtonDown');
        if (buttons & 2) modifiers.push('rightButtonDown');
        if (buttons & 4) modifiers.push('middleButtonDown');
        if (event.phase === 'move') wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
        else if (event.phase === 'leave') wc.sendInputEvent({ type: 'mouseLeave', x, y, modifiers });
        else wc.sendInputEvent({ type: event.phase === 'down' ? 'mouseDown' : 'mouseUp', x, y, button: event.button ?? 'left', clickCount: Math.min(3, Math.max(1, event.clicks ?? 1)), modifiers });
        break;
      }
      case 'wheel': {
        const x = Math.round(clamp01(event.x) * width);
        const y = Math.round(clamp01(event.y) * height);
        const dx = Number(event.dx) || 0;
        const dy = Number(event.dy) || 0;
        // Small steps come from a touchpad: apply them as they are (a wheel notch scrolls smoothly).
        const precise = Math.abs(dx) < 40 && Math.abs(dy) < 40;
        wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -dx, deltaY: -dy, canScroll: true, hasPreciseScrollingDeltas: precise, modifiers: electronModifiers(event.modifiers) });
        break;
      }
      case 'keyboard': {
        const mods = event.modifiers ?? 0;
        if (event.phase === 'down' && mods & (KEY_META | KEY_CONTROL) && menuShortcut(win, event.key, event.code, mods)) {
          await settle(wc);
          return;
        }
        const keyCode = electronKeyCode(event.key, event.code);
        if (!keyCode) return;
        const modifiers = electronModifiers(mods);
        if (event.repeat) modifiers.push('isAutoRepeat');
        if (event.phase === 'up') {
          wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
          return;
        }
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        const text = typedText(event.key, mods);
        if (text !== null) wc.sendInputEvent({ type: 'char', keyCode: text === '\r' ? 'Enter' : text === ' ' ? 'Space' : text === '+' ? 'Plus' : text, modifiers });
        break;
      }
      case 'text': {
        const text = String(event.text ?? '').slice(0, 200_000).replace(/\r\n?/g, '\n');
        if (!text) return;
        if (event.via === 'paste') {
          clipboard.writeText(text);
          lastClipboard = text;
          wc.paste();
          await settle(wc);
        } else if (text.length <= 500) {
          // Typed as characters, in order with the keys around them (any character, emoji too).
          for (const ch of text) {
            if (ch === '\n') {
              wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
              wc.sendInputEvent({ type: 'char', keyCode: 'Enter' });
              wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
            } else {
              wc.sendInputEvent({ type: 'char', keyCode: ch === ' ' ? 'Space' : ch === '+' ? 'Plus' : ch });
            }
          }
        } else {
          await wc.insertText(text);
          await settle(wc);
        }
        break;
      }
    }
  }

  // ─── Socket clients ────────────────────────────────────────────────────

  /** Video waiting on a client's socket beyond this is a reader that fell behind: skip to a keyframe. */
  const VIDEO_BACKLOG = 2 * 1024 * 1024;
  let nextClientId = 1;

  class Client {
    readonly id = nextClientId++;
    role: 'screen' | 'control' = 'control';
    watching: Subscription | null = null;
    /** Wants the app's sound when it plays on the PC. */
    wantsAudio = false;
    /** The window the client asked for (null: follow the focused one). */
    pinned: number | null = null;
    private maxSize = 1400;
    private fps = 30;
    private quality = 70;
    private inFlight = 0;
    private sentVersion = -1;
    private lastSent = 0;
    private timer: NodeJS.Timeout | null = null;
    private seq = 0;
    /** Asked for video (H.264), and whether the watched window comes as video now. */
    private wantsVideo = false;
    private videoOn = false;
    /** Why video gave up for this client: it gets JPEG frames until asked to try again. */
    private videoFailure: string | null = null;
    private bitrate = 4_000_000;
    /** Video waits for its next keyframe: the socket was full. */
    private videoBlocked = false;
    /** The number of this client's last video frame. */
    private videoSeq = 0;
    private sentCodec = '';
    private readonly decoder = new FrameDecoder();
    private closed = false;
    private inputs: Promise<void> = Promise.resolve();

    constructor(private readonly socket: net.Socket) {
      clients.add(this);
      clientsById.set(this.id, this);
      socket.on('data', (chunk) => {
        let frames;
        try {
          frames = this.decoder.push(chunk);
        } catch {
          this.close();
          return;
        }
        for (const frame of frames) if (frame.kind === 'json') this.handle(frame.value as HookRequest);
      });
      socket.on('close', () => this.close());
      socket.on('error', () => this.close());
    }

    send(message: HookMessage, binary?: Buffer): void {
      if (this.closed) return;
      this.socket.write(encodeJson(message));
      if (binary) this.socket.write(encodeBinary(binary));
    }

    private reply(id: number, ok: boolean, data?: unknown, error?: string): void {
      this.send({ t: 'result', id, ok, data, error });
    }

    private target(window?: number | null): BrowserWindow | null {
      if (typeof window === 'number') {
        const win = windows.get(window);
        if (alive(win)) return win;
      }
      return this.watching?.win ?? autoWindow();
    }

    private handle(request: HookRequest): void {
      try {
        switch (request?.t) {
          case 'hello':
            this.role = request.role === 'screen' ? 'screen' : 'control';
            this.send({ t: 'hello', app: appInfo(), windows: listWindows() });
            break;
          case 'watch': {
            const maxSize = Math.min(4096, Math.max(320, Number(request.maxSize) || 1400));
            const resized = maxSize !== this.maxSize;
            this.maxSize = maxSize;
            this.fps = Math.min(60, Math.max(1, Number(request.fps) || 30));
            this.quality = Math.min(95, Math.max(30, Number(request.quality) || 70));
            this.pinned = typeof request.window === 'number' ? request.window : null;
            this.wantsVideo = this.role === 'screen' && request.codec === 'h264';
            if (typeof request.bitrate === 'number' && Number.isFinite(request.bitrate)) this.bitrate = Math.min(50_000_000, Math.max(100_000, Math.round(request.bitrate)));
            this.follow(resized);
            if (this.wantsAudio !== (this.role === 'screen' && Boolean(request.audio))) {
              this.wantsAudio = !this.wantsAudio;
              listenersChanged();
            }
            this.send({ t: 'sound', mode: sound.mode, toPc: sound.canSendToPc });
            break;
          }
          case 'keyframe':
            if (this.videoOn) video.keyframe(this.id);
            break;
          case 'bitrate':
            if (typeof request.bitrate !== 'number' || !Number.isFinite(request.bitrate)) break;
            this.bitrate = Math.min(50_000_000, Math.max(100_000, Math.round(request.bitrate)));
            if (this.videoOn) video.setBitrate(this.id, this.bitrate);
            break;
          case 'retry-video':
            // Asked to try video again (after it gave up).
            this.videoFailure = null;
            video.broken = null;
            this.follow();
            break;
          case 'sound':
            if (isSoundMode(request.mode)) {
              sound.setMode(request.mode);
              soundChanged();
              this.reply(request.id, true, sound.mode);
            } else {
              this.reply(request.id, false, undefined, 'Not a sound setting');
            }
            break;
          case 'unwatch':
            this.stopWatching();
            break;
          case 'ack':
            this.inFlight = Math.max(0, this.inFlight - 1);
            this.offer();
            break;
          case 'input': {
            const win = this.target();
            // One at a time, in order: some input waits for the page (see settle).
            if (win) this.inputs = this.inputs.then(() => input(win, request.event)).catch(() => undefined);
            break;
          }
          case 'screenshot': {
            const win = this.target(request.window);
            if (!win) {
              this.reply(request.id, false, undefined, 'The app has no window open.');
              break;
            }
            win.webContents.capturePage().then(
              (image: NativeImage) => {
                const size = image.getSize();
                this.send({ t: 'screenshot', id: request.id, width: size.width, height: size.height }, image.toPNG());
              },
              (err: Error) => this.reply(request.id, false, undefined, String(err?.message ?? err)),
            );
            break;
          }
          case 'reload':
            for (const win of windows.values()) if (alive(win)) win.webContents.reloadIgnoringCache();
            this.reply(request.id, true);
            break;
          case 'modules': {
            const cache = (typeof require === 'function' ? require.cache : {}) ?? {};
            this.reply(request.id, true, Object.keys(cache).filter((file) => file.startsWith('/')));
            break;
          }
          case 'window-action': {
            const win = windows.get(request.window);
            if (!alive(win)) break;
            if (request.action === 'close') win.close();
            else if (request.action === 'minimize') win.minimize();
            else if (request.action === 'zoom') {
              if (win.isMaximized()) win.unmaximize();
              else win.maximize();
            }
            break;
          }
          case 'ping':
            this.send({ t: 'pong', id: request.id });
            break;
        }
      } catch (err) {
        report({ e: 'error', message: `CapMac: ${String((err as Error)?.message ?? err)}` });
      }
    }

    /** Watches the pinned window, or the one to follow (`resized`: the longest side changed). */
    follow(resized = false): void {
      const pinned = this.pinned !== null ? windows.get(this.pinned) : null;
      const win = alive(pinned) ? pinned : autoWindow();
      const wantsVideo = this.wantsVideo && noVideoReason(this.videoFailure) === null;
      if (win && this.watching?.win === win) {
        if (wantsVideo !== this.videoOn) {
          this.switchTo(wantsVideo);
        } else if (this.videoOn) {
          if (resized) video.setSize(this.id, videoSizeOf(win, this.maxSize));
        } else {
          // New size or quality: paint again so the next frame shows it.
          try {
            win.webContents.invalidate();
          } catch {
            // closing
          }
        }
        this.codecChanged();
        this.windowsChanged();
        return;
      }
      this.stopWatching();
      if (win) {
        this.watching = subscribe(win, this, !wantsVideo);
        this.sentVersion = -1;
        this.inFlight = 0;
        if (wantsVideo) this.startVideo(win);
      }
      this.codecChanged();
      this.windowsChanged();
    }

    private startVideo(win: BrowserWindow): void {
      this.videoOn = true;
      this.videoBlocked = false;
      video.start(this.id, win.webContents, { ...videoSizeOf(win, this.maxSize), fps: this.fps, bitrate: this.bitrate });
    }

    private stopVideo(): void {
      if (!this.videoOn) return;
      this.videoOn = false;
      video.stop(this.id);
    }

    /** The same window, as video or as JPEG frames from now on. */
    private switchTo(asVideo: boolean): void {
      const sub = this.watching!;
      if (asVideo) {
        takeFrames(sub, this, false);
        this.startVideo(sub.win);
      } else {
        this.stopVideo();
        this.sentVersion = -1;
        this.inFlight = 0;
        takeFrames(sub, this, true);
      }
    }

    /** Video gave up for this client (the session stopped already): JPEG frames from now on, and why. */
    videoFailed(reason: string): void {
      this.videoOn = false;
      this.videoFailure = reason;
      if (this.watching) {
        this.sentVersion = -1;
        this.inFlight = 0;
        takeFrames(this.watching, this, true);
      }
      this.codecChanged();
    }

    /** Tells the client how the watched window's pictures come (when that changed). */
    private codecChanged(): void {
      if (this.role !== 'screen' || !this.watching) return;
      const codec = this.videoOn ? 'h264' : 'jpeg';
      const reason = codec === 'jpeg' && this.wantsVideo ? noVideoReason(this.videoFailure) : null;
      const key = `${codec} ${reason ?? ''}`;
      if (key === this.sentCodec) return;
      this.sentCodec = key;
      this.send({ t: 'codec', codec, reason: reason ?? undefined });
    }

    /** One message of this client's video (shared/stream.ts). A reader that fell behind skips to the next keyframe. */
    sendVideo(message: Buffer): void {
      if (this.closed || !this.videoOn || message.length < 16) return;
      if (message[0] !== STREAM_CONFIG) {
        const key = ((message[1] ?? 0) & 1) === 1;
        if (!key) {
          if (this.videoBlocked) return;
          if (this.socket.writableLength > VIDEO_BACKLOG) {
            this.videoBlocked = true;
            this.socket.once('drain', () => {
              if (this.videoOn) video.keyframe(this.id);
            });
            return;
          }
        }
        this.videoBlocked = false;
        this.videoSeq += 1;
      }
      // Numbered here, not by the capture: they keep counting up when the capture starts over
      // (a new size, another window), and frames are acknowledged by the highest number that came.
      message.writeUInt32BE(this.videoSeq >>> 0, 12);
      this.send({ t: 'video' }, message);
    }

    private stopWatching(): void {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.stopVideo();
      if (this.watching) unsubscribe(this.watching, this);
      this.watching = null;
    }

    focusChanged(): void {
      if (this.role === 'screen' && this.pinned === null && this.watching) this.follow();
    }

    windowClosed(id: number): void {
      if (this.watching?.win.id === id) {
        // Its subscription went with it (see track).
        this.stopVideo();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.watching = null;
        if (this.pinned === id) this.pinned = null;
        this.follow();
      }
    }

    windowsChanged(): void {
      if (this.role !== 'screen') return;
      this.send({ t: 'windows', windows: listWindows(), watched: this.watching?.win.id ?? null });
      // The window was resized (or moved to another display): the video follows its shape.
      if (this.videoOn && this.watching && alive(this.watching.win)) video.setSize(this.id, videoSizeOf(this.watching.win, this.maxSize));
    }

    /** Sends the newest frame when the client can take one (two in flight, at most `fps` a second). */
    offer(): void {
      const sub = this.watching;
      if (!sub || !sub.jpeg.has(this) || this.closed || this.timer || this.inFlight >= 2 || sub.version === this.sentVersion || !sub.latest) return;
      const due = this.lastSent + 1000 / this.fps;
      const now = Date.now();
      if (now < due) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.offer();
        }, due - now);
        return;
      }
      try {
        let image: NativeImage = sub.latest;
        if (image.isEmpty()) return;
        const size = image.getSize();
        const longest = Math.max(size.width, size.height);
        if (longest > this.maxSize) {
          const ratio = this.maxSize / longest;
          image = image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'good' });
        }
        const jpeg: Buffer = image.toJPEG(this.quality);
        this.sentVersion = sub.version;
        this.lastSent = now;
        this.inFlight += 1;
        this.send({ t: 'frame', window: sub.win.id, seq: ++this.seq }, jpeg);
      } catch {
        // the window is closing
      }
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.stopWatching();
      clients.delete(this);
      clientsById.delete(this.id);
      if (this.wantsAudio) listenersChanged();
      this.socket.destroy();
    }
  }

  // ─── Capacitor live reload ─────────────────────────────────────────────

  const liveUrl = process.env[ENV_LIVE_URL] ? new URL(process.env[ENV_LIVE_URL]!) : null;
  const liveScheme = process.env[ENV_LIVE_SCHEME] || 'capacitor-electron';
  let loadPatched = false;

  /** The app loads its bundled assets from `<scheme>://-`: load the dev server instead. */
  function patchLoadUrl(win: BrowserWindow): void {
    if (loadPatched || !liveUrl) return;
    loadPatched = true;
    const proto = Object.getPrototypeOf(win.webContents);
    const load = proto?.loadURL;
    if (typeof load !== 'function') return;
    proto.loadURL = function (url: unknown, ...rest: unknown[]) {
      if (typeof url === 'string' && url.startsWith(`${liveScheme}://`)) {
        const after = url.slice(`${liveScheme}://`.length).replace(/^[^/?#]*/, '');
        const next = new URL(after.replace(/^\//, '') || '', liveUrl).href;
        return load.call(this, next, ...rest);
      }
      return load.call(this, url, ...rest);
    };
    // The app guards navigation for its own scheme ("stay on capacitor-electron://"); the dev
    // server reloads its page by navigating, so navigation within the dev server always goes
    // ahead (like server.url on iOS). Electron raises these events through `emit`.
    const emit = proto.emit;
    if (typeof emit !== 'function') return;
    const origin = liveUrl.origin;
    const guarded = new Set(['will-navigate', 'will-frame-navigate', 'will-redirect']);
    proto.emit = function (name: unknown, ...args: any[]) {
      const event = args[0];
      if (typeof name === 'string' && guarded.has(name) && event && typeof event === 'object') {
        const url = typeof event.url === 'string' ? event.url : args[1];
        if (typeof url === 'string' && url.startsWith(origin)) {
          args[0] = new Proxy(event, {
            get(target, prop) {
              if (prop === 'preventDefault') return () => undefined;
              const value = Reflect.get(target, prop, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        }
      }
      return emit.call(this, name, ...args);
    };
  }

  /** The app's Content-Security-Policy allows only its own scheme: the dev server's pages go without it. */
  function relaxCspForDevServer(): void {
    if (!liveUrl) return;
    try {
      // The session keeps one WebRequest object, whose methods are its own (not a prototype's).
      const webRequest = electron.session.defaultSession.webRequest;
      const register = webRequest?.onHeadersReceived;
      if (typeof register !== 'function') return;
      const origin = liveUrl.origin;
      webRequest.onHeadersReceived = function (...args: any[]) {
        const index = args.length - 1;
        const listener = args[index];
        if (typeof listener === 'function') {
          args[index] = (details: { url: string }, callback: (response: any) => void) =>
            listener(details, (response: any) => {
              if (details.url.startsWith(origin) && response?.responseHeaders) {
                const headers = { ...response.responseHeaders };
                for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-security-policy') delete headers[name];
                return callback({ ...response, responseHeaders: headers });
              }
              return callback(response);
            });
        }
        return register.apply(webRequest, args);
      };
    } catch {
      // read-only in this Electron: the app's policy stays
    }
  }

  // ─── Start ─────────────────────────────────────────────────────────────

  let listening = false;
  const appInfo = (): HookAppInfo => ({
    pid: process.pid,
    name: app.getName(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    socket: listening ? socketPath : null,
    dialogs: dialogs?.socketPath ?? null,
    sound: sound.mode,
    soundToPc: sound.canSendToPc,
    h264: video.available,
  });

  // The dialogs' own socket, served by a worker thread (this same file, see the end).
  const dialogPath = dialogSocket(socketPath);
  const dialogsReady = dialogs
    ? dialogs.start(() => (HOOK_FILE ? new Worker(HOOK_FILE, { workerData: { capmacDialogs: { socket: dialogPath, home: os.homedir(), project: projectDir } } }) : null))
    : Promise.resolve(null);

  const server = net.createServer((socket) => new Client(socket));
  server.on('error', (err) => {
    report({ e: 'error', message: `CapMac could not show the app's windows: ${err.message}` });
    void dialogsReady.then(() => report({ e: 'hello', ...appInfo() }));
  });
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // not there
  }
  server.listen(socketPath, () => {
    listening = true;
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // the folder is private anyway
    }
    void dialogsReady.then(() => report({ e: 'hello', ...appInfo() }));
  });
  server.unref();

  app.on('browser-window-created', (_e: unknown, win: BrowserWindow) => track(win));
  for (const win of BrowserWindow.getAllWindows?.() ?? []) track(win);
  if (app.isReady()) relaxCspForDevServer();
  else app.once('ready', relaxCspForDevServer);

  // Electron's error dialog for an uncaught exception in main would sit on the Mac's screen: log it instead.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`Uncaught exception in the main process: ${String(err?.stack ?? err)}\n`);
  });

  app.once('will-quit', () => {
    for (const client of [...clients]) client.close();
    server.close();
    dialogs?.stop();
    sound.stop();
    video.stopAll();
    capture.close();
    for (const file of [socketPath, dialogPath]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // gone
      }
    }
  });
}

/** This file, which also runs the dialogs' worker thread (null when loaded from source, in tests). */
const HOOK_FILE: string | null = typeof __filename === 'string' && /\.c?js$/.test(__filename) ? __filename : null;
const DIALOG_WORKER = Symbol.for('capmac.dialogWorker');

if (isMainThread && process.versions.electron && (process as { type?: string }).type === 'browser' && process.env[ENV_SOCKET]) {
  const socketPath = process.env[ENV_SOCKET]!;
  projectDir = process.env[ENV_PROJECT] || null;
  const sound = process.env[ENV_SOUND];
  if (isSoundMode(sound)) initialSound = sound;
  // Only this process: Node.js processes the app starts must not load CapMac.
  try {
    const options = (process.env.NODE_OPTIONS ?? '').replace(/--require[= ]+("[^"]*capmac[^"]*"|\S*capmac\S*)/g, '').trim();
    if (options) process.env.NODE_OPTIONS = options;
    else delete process.env.NODE_OPTIONS;
    delete process.env[ENV_SOCKET];
    delete process.env[ENV_PROJECT];
    delete process.env[ENV_SOUND];
  } catch {
    // read-only environment
  }
  markMainOutput();
  watchElectronRequire(socketPath);
  watchElectronImport();
  // `require('electron')` works once Electron has set up the main process, right after the preloads.
  setImmediate(() => {
    try {
      const electron = require('electron');
      if (!electron || typeof electron !== 'object' || !electron.app) throw new Error('the electron module is not available');
      start(electron, socketPath);
    } catch (err) {
      report({ e: 'error', message: `CapMac could not attach to the app: ${String((err as Error)?.message ?? err)}` });
    }
  });
}

// The dialogs' worker thread (started by `start` with this file). A worker also loads
// the preloads of NODE_OPTIONS, so this file may run twice in it: the flag keeps one.
if (!isMainThread && parentPort && (workerData as { capmacDialogs?: unknown } | null)?.capmacDialogs && !(globalThis as Record<symbol, unknown>)[DIALOG_WORKER]) {
  (globalThis as Record<symbol, unknown>)[DIALOG_WORKER] = true;
  const port = parentPort;
  runDialogWorker((workerData as { capmacDialogs: { socket: string; home: string; project: string | null } }).capmacDialogs, {
    postMessage: (message) => port.postMessage(message),
    on: (event, listener) => port.on(event, listener),
  });
}
