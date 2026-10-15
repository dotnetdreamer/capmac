import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frontFile, HOOK_MARK } from '../../packages/core/src/shared/electron.js';

type Hook = typeof import('../../packages/core/src/electron-hook/hook.js');

/**
 * A stand-in for Electron on the Mac: records what the app's windows do, and
 * "ACTIVATED" whenever the app would take the Mac's focus.
 */
function fakeElectron() {
  const events: string[] = [];
  let active = false;
  const app = Object.assign(new EventEmitter(), {
    isReady: () => true,
    focus: (options?: unknown) => {
      events.push(`app.focus ${JSON.stringify(options ?? {})}`);
      activate();
    },
  });
  function activate(): void {
    events.push('ACTIVATED');
    if (active) return;
    active = true;
    app.emit('did-become-active');
  }
  let ids = 0;
  class BaseWindow extends EventEmitter {
    static all: BaseWindow[] = [];
    id = ++ids;
    options: Record<string, any>;
    visible = false;
    key = false;
    fullscreen = false;
    constructor(options: Record<string, any> = {}) {
      super();
      this.options = options;
      BaseWindow.all.push(this);
      this.created();
      if (options.fullscreen) this.fullscreen = true;
      // Electron shows the window natively, before the constructor returns (no JS method involved).
      if (options.show !== false) {
        this.visible = true;
        events.push(`native show ${this.id}`);
        if (!(options.modal && options.parent)) activate();
      }
    }
    protected created(): void {}
    show() {
      this.visible = true;
      events.push(`show ${this.id}`);
      activate();
    }
    showInactive() {
      this.visible = true;
      events.push(`showInactive ${this.id}`);
    }
    blur() {
      events.push(`blur ${this.id}`);
    }
    focus() {
      events.push(`focus ${this.id}`);
      activate();
    }
    moveTop() {
      events.push(`moveTop ${this.id}`);
    }
    isFocused() {
      return this.key;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return false;
    }
    isDestroyed() {
      return false;
    }
    isModal() {
      return Boolean(this.options.modal);
    }
    getParentWindow() {
      return this.options.parent ?? null;
    }
    setFullScreen(flag: boolean) {
      this.fullscreen = flag;
      events.push(`setFullScreen ${flag}`);
    }
    setSimpleFullScreen(flag: boolean) {
      events.push(`setSimpleFullScreen ${flag}`);
    }
    setKiosk(flag: boolean) {
      events.push(`setKiosk ${flag}`);
    }
    isFullScreen() {
      return this.fullscreen;
    }
  }
  class WebContents extends EventEmitter {
    devTools = false;
    constructor(readonly owner: BrowserWindow) {
      super();
    }
    openDevTools(options?: Record<string, unknown>) {
      this.devTools = true;
      events.push(`openDevTools ${JSON.stringify(options ?? {})}`);
      if (options?.activate !== false) activate();
    }
    closeDevTools() {
      this.devTools = false;
      events.push('closeDevTools');
    }
    toggleDevTools() {
      if (this.devTools) return this.closeDevTools();
      this.devTools = true;
      events.push('toggleDevTools');
      activate();
    }
    isDevToolsOpened() {
      return this.devTools;
    }
    focus() {
      events.push(`webContents.focus ${this.owner.id}`);
      activate();
    }
    isDestroyed() {
      return false;
    }
  }
  class BrowserWindow extends BaseWindow {
    declare webContents: WebContents;
    protected override created(): void {
      this.webContents = new WebContents(this);
      app.emit('web-contents-created', {}, this.webContents);
      app.emit('browser-window-created', {}, this);
    }
    focusOnWebView() {
      events.push(`focusOnWebView ${this.id}`);
    }
    static fromWebContents(wc: WebContents) {
      return wc.owner;
    }
    static getFocusedWindow() {
      return BaseWindow.all.find((w) => w.isFocused()) ?? null;
    }
  }
  class Tray extends EventEmitter {}
  const shortcuts = new Map<string, () => void>();
  const electron = {
    app,
    BaseWindow,
    BrowserWindow,
    Tray,
    shell: {
      openExternal: (url: string, options?: unknown) => {
        events.push(`openExternal ${url} ${JSON.stringify(options ?? {})}`);
      },
    },
    globalShortcut: {
      register: (accelerator: string, callback: () => void) => {
        shortcuts.set(accelerator, callback);
        return true;
      },
      registerAll: () => undefined,
    },
    webContents: { getAllWebContents: () => [] },
  };
  return {
    electron,
    events,
    shortcuts,
    becomeActive: () => {
      active = true;
      app.emit('did-become-active');
    },
    resign: () => {
      active = false;
      app.emit('did-resign-active');
    },
  };
}

let dir: string;
let hook: Hook;
let notes: string[];

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-focus-'));
  // A fresh module per test: the guard installs once per app.
  vi.resetModules();
  hook = await import('../../packages/core/src/electron-hook/hook.js');
  notes = [];
  const write = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    const text = String(chunk);
    if (!text.startsWith(HOOK_MARK)) return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    const event = JSON.parse(text.slice(HOOK_MARK.length));
    if (event.e === 'note') notes.push(event.message);
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** The app as CapMac launches it: the guard installed, `require('electron')` guarded. */
function launch(options: { front?: '1' | '0' } = {}) {
  const fake = fakeElectron();
  const socket = path.join(dir, 'app.sock');
  if (options.front) writeFileSync(frontFile(socket), options.front);
  hook.guardFocus(fake.electron, socket);
  const electron = hook.guardedElectron(fake.electron) as typeof fake.electron;
  return { ...fake, electron, socket };
}

describe('CapMac leaves the Mac’s focus alone', () => {
  it('opens a window behind the other apps without activating the app', () => {
    const { electron, events } = launch();
    const win = new electron.BrowserWindow({ width: 800 });
    expect(events).toEqual([`showInactive ${win.id}`, `blur ${win.id}`]);
    expect(win.options).toEqual({ width: 800, show: false });
    expect(win.isVisible()).toBe(true);
    // CapMac's view follows the window the app brought forward.
    expect(win.isFocused()).toBe(true);
    expect(electron.BrowserWindow.getFocusedWindow()).toBe(win);
  });

  it('keeps show, focus, moveTop and app.focus from taking the Mac', () => {
    const { electron, events } = launch();
    const win = new electron.BrowserWindow({ show: false });
    win.show();
    win.focus();
    win.webContents.focus();
    win.moveTop();
    electron.app.focus({ steal: true });
    expect(events).not.toContain('ACTIVATED');
    expect(events).toEqual([`showInactive ${win.id}`, `blur ${win.id}`, `focusOnWebView ${win.id}`]);
  });

  it('holds DevTools and full screen until someone switches to the app', () => {
    const { electron, events, becomeActive } = launch();
    const win = new electron.BrowserWindow({ fullscreen: true });
    win.webContents.openDevTools({ mode: 'right' });
    win.setSimpleFullScreen(true);
    expect(win.options.fullscreen).toBeUndefined();
    expect(win.isFullScreen()).toBe(false);
    expect(win.webContents.isDevToolsOpened()).toBe(false);
    expect(notes).toHaveLength(2);
    becomeActive();
    expect(events).toContain('openDevTools {"mode":"detach","activate":false}');
    expect(events).toContain('setFullScreen true');
    expect(events).toContain('setSimpleFullScreen true');
    expect(events).not.toContain('ACTIVATED');
  });

  it('cancels waiting DevTools when the app toggles them off', () => {
    const { electron, events, becomeActive } = launch();
    const win = new electron.BrowserWindow({ show: false });
    win.webContents.toggleDevTools();
    win.webContents.toggleDevTools();
    becomeActive();
    expect(events.some((e) => e.startsWith('openDevTools') || e === 'toggleDevTools')).toBe(false);
  });

  it('lets the app behave as usual while it is the active app, and guards again after', () => {
    const { electron, events, becomeActive, resign } = launch();
    becomeActive();
    const win = new electron.BrowserWindow({});
    expect(events).toEqual([`native show ${win.id}`, 'ACTIVATED']);
    win.webContents.openDevTools();
    expect(events).toContain('openDevTools {"mode":"detach","activate":false}');
    resign();
    events.length = 0;
    win.show();
    expect(events).toEqual([`showInactive ${win.id}`, `blur ${win.id}`]);
  });

  it('shows a sheet the usual way: it stays on its window, the app stays inactive', () => {
    const { electron, events } = launch();
    const parent = new electron.BrowserWindow({ show: false });
    const sheet = new electron.BrowserWindow({ parent, modal: true });
    expect(sheet.options.show).toBeUndefined();
    expect(events).toEqual([`native show ${sheet.id}`]);
  });

  it('lets a click on the app’s menu bar icon bring it forward', () => {
    const { electron, events } = launch();
    const win = new electron.BrowserWindow({ show: false });
    const tray = new electron.Tray();
    tray.emit('mouse-move');
    win.show();
    expect(events).not.toContain('ACTIVATED');
    tray.emit('click');
    win.show();
    expect(events).toContain(`show ${win.id}`);
    expect(events).toContain('ACTIVATED');
  });

  it('lets the app’s global shortcut bring it forward', () => {
    const { electron, events, shortcuts } = launch();
    const win = new electron.BrowserWindow({ show: false });
    electron.globalShortcut.register('Alt+Space', () => win.focus());
    shortcuts.get('Alt+Space')!();
    expect(events).toContain(`focus ${win.id}`);
    expect(events).toContain('ACTIVATED');
  });

  it('goes back to guarding once the click’s moment has passed', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { electron, events } = launch();
    const win = new electron.BrowserWindow({ show: false });
    new electron.Tray().emit('click');
    vi.setSystemTime(1_005_000);
    win.show();
    expect(events).not.toContain('ACTIVATED');
  });

  it('brings a restarted app back in front when someone was using it', () => {
    const { electron, events } = launch({ front: '1' });
    const win = new electron.BrowserWindow({});
    expect(events).toEqual([`native show ${win.id}`, 'ACTIVATED']);
  });

  it('remembers whether the app is in front, until it quits', () => {
    const { electron, socket, becomeActive, resign } = launch();
    const front = () => readFileSync(frontFile(socket), 'utf8');
    becomeActive();
    expect(front()).toBe('1');
    resign();
    expect(front()).toBe('0');
    becomeActive();
    electron.app.emit('before-quit');
    resign();
    expect(front()).toBe('1');
  });

  it('opens links without bringing the browser forward', () => {
    const { electron, events, becomeActive } = launch();
    electron.shell.openExternal('https://example.com');
    expect(events).toEqual(['openExternal https://example.com {"activate":false}']);
    becomeActive();
    events.length = 0;
    electron.shell.openExternal('https://example.com', { activate: true });
    expect(events).toEqual(['openExternal https://example.com {"activate":true}']);
  });

  it('keeps the window classes working: statics, instanceof, subclasses', () => {
    const { electron, events } = launch();
    class MainWindow extends electron.BrowserWindow {
      constructor() {
        super({ title: 'main' });
      }
    }
    const win = new MainWindow();
    expect(win).toBeInstanceOf(MainWindow);
    expect(win).toBeInstanceOf(electron.BrowserWindow);
    expect(electron.BrowserWindow.fromWebContents(win.webContents)).toBe(win);
    expect(events).not.toContain('ACTIVATED');
  });

  it('leaves a read-only electron export as it is', () => {
    const fake = fakeElectron();
    const frozen = Object.defineProperty({ app: fake.electron.app }, 'BrowserWindow', { value: fake.electron.BrowserWindow, writable: false, configurable: false, enumerable: true }) as { app: unknown; BrowserWindow: unknown };
    expect((hook.guardedElectron(frozen) as typeof frozen).BrowserWindow).toBe(fake.electron.BrowserWindow);
  });
});
