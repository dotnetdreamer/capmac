/**
 * CapMac's module inside an Electron app on the Mac. The agent launches the
 * app with NODE_OPTIONS=--require <this file>, so every Node.js process the
 * launch starts loads it (npm, a dev server, Electron): it does nothing unless
 * it is in Electron's main process and the agent asked for it (ENV_SOCKET).
 *
 * In the app it:
 *  - marks what the main process prints, and reports windows and the pages'
 *    console on stdout (marked lines, see shared/electron.ts);
 *  - serves the windows on a Unix socket: frames from the app's own
 *    compositor (no Screen Recording permission needed), input through
 *    sendInputEvent (no Accessibility permission, no focus stealing), menu
 *    shortcuts the way macOS runs them, screenshots, reloads;
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
import { encodeBinary, encodeJson, FrameDecoder } from '../shared/frames.js';
import {
  ENV_LIVE_SCHEME,
  ENV_LIVE_URL,
  ENV_SOCKET,
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

/** The app's own `require('electron')`, with window classes that open windows the guard way. */
export function guardedElectron(electron: Electron): Electron {
  const classes = new Map<unknown, unknown>();
  return new Proxy(electron, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if ((prop !== 'BrowserWindow' && prop !== 'BaseWindow') || typeof value !== 'function') return value;
      // A proxy may only change what a property it could change reads.
      const own = Object.getOwnPropertyDescriptor(target, prop);
      if (own && !own.configurable && 'value' in own && !own.writable) return value;
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
  let focusOrder: number[] = [];

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
      if (virtualFocus === win) virtualFocus = null;
      windows.delete(id);
      focusOrder = focusOrder.filter((other) => other !== id);
      for (const client of clients) client.windowClosed(id);
      report({ e: 'window-closed', id });
      changed();
    });
    wc.on('console-message', (...args: any[]) => {
      // Electron 35+: one event object; before: (event, level, message, line, sourceId).
      const e = args[0] ?? {};
      const legacy = typeof args[1] === 'number';
      const levels = ['debug', 'info', 'warning', 'error'] as const;
      const level = legacy ? levels[args[1]] ?? 'info' : (levels as readonly string[]).includes(e.level) ? e.level : 'info';
      const text = String(legacy ? args[2] : e.message ?? '');
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
    report({ e: 'window', window: infoOf(win) });
    changed();
  }

  // ─── Frames ────────────────────────────────────────────────────────────

  interface Subscription {
    win: BrowserWindow;
    latest: NativeImage | null;
    /** Bumped on every paint. */
    version: number;
    clients: Set<Client>;
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

  function subscribe(win: BrowserWindow, client: Client): Subscription {
    let sub = subscriptions.get(win.id);
    if (!sub) {
      const wc = win.webContents;
      let throttling: boolean | null = null;
      try {
        throttling = wc.getBackgroundThrottling?.() ?? null;
      } catch {
        throttling = null;
      }
      const created: Subscription = { win, latest: null, version: 0, clients: new Set(), throttling };
      sub = created;
      subscriptions.set(win.id, created);
      // A covered, minimized or hidden window keeps painting while CapMac shows it.
      wc.setBackgroundThrottling(false);
      wc.beginFrameSubscription(false, (image: NativeImage) => {
        created.latest = image;
        created.version += 1;
        for (const c of created.clients) c.offer();
      });
      updatePowerBlocker();
    }
    sub.clients.add(client);
    // Paint now, so the first frame does not wait for the page to change.
    try {
      win.webContents.invalidate();
    } catch {
      // closing
    }
    const current = sub;
    setTimeout(() => {
      if (current.version === 0 && current.clients.has(client) && alive(win)) {
        win.webContents.capturePage().then((image: NativeImage) => {
          if (current.version === 0) {
            current.latest = image;
            current.version = 1;
            for (const c of current.clients) c.offer();
          }
        }, () => undefined);
      }
    }, 400);
    return sub;
  }

  function unsubscribe(sub: Subscription, client: Client): void {
    sub.clients.delete(client);
    if (sub.clients.size > 0) return;
    subscriptions.delete(sub.win.id);
    if (alive(sub.win)) {
      try {
        sub.win.webContents.endFrameSubscription();
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

  class Client {
    role: 'screen' | 'control' = 'control';
    watching: Subscription | null = null;
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
    private readonly decoder = new FrameDecoder();
    private closed = false;
    private inputs: Promise<void> = Promise.resolve();

    constructor(private readonly socket: net.Socket) {
      clients.add(this);
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
          case 'watch':
            this.maxSize = Math.min(4096, Math.max(320, Number(request.maxSize) || 1400));
            this.fps = Math.min(60, Math.max(1, Number(request.fps) || 30));
            this.quality = Math.min(95, Math.max(30, Number(request.quality) || 70));
            this.pinned = typeof request.window === 'number' ? request.window : null;
            this.follow();
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

    /** Watches the pinned window, or the one to follow. */
    follow(): void {
      const pinned = this.pinned !== null ? windows.get(this.pinned) : null;
      const win = alive(pinned) ? pinned : autoWindow();
      if (this.watching?.win === win) {
        // New size or quality: paint again so the next frame shows it.
        try {
          win.webContents.invalidate();
        } catch {
          // closing
        }
        this.windowsChanged();
        return;
      }
      this.stopWatching();
      if (win) {
        this.watching = subscribe(win, this);
        this.sentVersion = -1;
        this.inFlight = 0;
      }
      this.windowsChanged();
    }

    private stopWatching(): void {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (this.watching) unsubscribe(this.watching, this);
      this.watching = null;
    }

    focusChanged(): void {
      if (this.role === 'screen' && this.pinned === null && this.watching) this.follow();
    }

    windowClosed(id: number): void {
      if (this.watching?.win.id === id) {
        this.watching = null;
        if (this.pinned === id) this.pinned = null;
        this.follow();
      }
    }

    windowsChanged(): void {
      if (this.role === 'screen') this.send({ t: 'windows', windows: listWindows(), watched: this.watching?.win.id ?? null });
    }

    /** Sends the newest frame when the client can take one (two in flight, at most `fps` a second). */
    offer(): void {
      const sub = this.watching;
      if (!sub || this.closed || this.timer || this.inFlight >= 2 || sub.version === this.sentVersion || !sub.latest) return;
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
  });

  const server = net.createServer((socket) => new Client(socket));
  server.on('error', (err) => {
    report({ e: 'error', message: `CapMac could not show the app's windows: ${err.message}` });
    report({ e: 'hello', ...appInfo() });
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
    report({ e: 'hello', ...appInfo() });
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
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // gone
    }
  });
}

if (process.versions.electron && (process as { type?: string }).type === 'browser' && process.env[ENV_SOCKET]) {
  const socketPath = process.env[ENV_SOCKET]!;
  // Only this process: Node.js processes the app starts must not load CapMac.
  try {
    const options = (process.env.NODE_OPTIONS ?? '').replace(/--require[= ]+("[^"]*capmac[^"]*"|\S*capmac\S*)/g, '').trim();
    if (options) process.env.NODE_OPTIONS = options;
    else delete process.env.NODE_OPTIONS;
    delete process.env[ENV_SOCKET];
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
