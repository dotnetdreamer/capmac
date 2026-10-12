/** The main window: Mica backdrop, our own title bar with native caption buttons, locked-down web contents. */
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme, protocol, screen, session } from 'electron';
import { rendererDir } from './paths.js';

export const TITLE_BAR_HEIGHT = 40;
export const APP_ORIGIN = 'app://capmac';

/** Windows 11 22H2 (build 22621) and later can draw Mica behind the window. */
export function micaSupported(): boolean {
  if (process.platform !== 'win32') return false;
  return Number(os.release().split('.')[2] ?? 0) >= 22621;
}

export function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: '#00000000', symbolColor: dark ? '#ffffff' : '#1a1a1a', height: TITLE_BAR_HEIGHT };
}

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// The Vite dev server needs inline scripts (React Refresh) and its HMR socket.
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Must run before `app.ready`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);
}

/** Serves the built renderer from app://capmac/ (never file://), with a strict CSP. */
export function serveRenderer(): void {
  const root = rendererDir();
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'capmac') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(`${root}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.readFile(file);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-security-policy': PROD_CSP, 'x-content-type-options': 'nosniff' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

export function hardenSession(devUrl: string | null): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  if (devUrl) {
    ses.webRequest.onHeadersReceived({ urls: [`${devUrl}*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [DEV_CSP] } });
    });
  }
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1320, height: 860, maximized: false };
  try {
    const state = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    if (state.x !== undefined && state.y !== undefined) {
      // Only reuse the position if it is still on a connected display.
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return state.x! + 100 > a.x && state.x! < a.x + a.width - 100 && state.y! >= a.y - 10 && state.y! < a.y + a.height - 100;
      });
      if (!visible) return { ...fallback, maximized: state.maximized };
    }
    return { ...fallback, ...state, width: Math.max(state.width, 900), height: Math.max(state.height, 600) };
  } catch {
    return fallback;
  }
}

function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const bounds = win.getNormalBounds();
      void fs.writeFile(stateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() })).catch(() => undefined);
    }, 400);
  };
  win.on('resize', save);
  win.on('move', save);
  win.on('maximize', save);
  win.on('unmaximize', save);
}

export function createMainWindow(options: { preload: string; url: string; icon: string; mica: boolean }): BrowserWindow {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'capmac Studio',
    icon: options.icon,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    ...(options.mica ? { backgroundMaterial: 'mica' as const, backgroundColor: '#00000000' } : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3' }),
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      spellcheck: false,
      navigateOnDragDrop: false,
      backgroundThrottling: true,
    },
  });
  if (state.maximized) win.maximize();
  trackWindowState(win);

  const contents = win.webContents;
  // capmac Studio never opens other windows or navigates away from itself.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const allowed = new URL(options.url).origin;
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== allowed) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-redirect', (event, url) => {
    if (new URL(url).origin !== allowed) event.preventDefault();
  });

  nativeTheme.on('updated', () => {
    if (!win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay());
    if (!options.mica && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3');
  });

  win.once('ready-to-show', () => win.show());
  void win.loadURL(options.url);
  return win;
}
