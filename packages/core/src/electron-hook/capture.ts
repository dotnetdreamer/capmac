/**
 * CapMac's hidden page inside the app. It captures the app's windows the way
 * Chromium captures a tab, with no macOS permission involved
 * (getMediaSourceId, then getUserMedia with the "tab" source): their sound,
 * for the PC (sound.ts), and their pictures, as H.264 video (video.ts).
 *
 * The page is a WebContentsView in a session of its own: it is never shown,
 * it is not one of the app's windows, and none of the app's handlers see it.
 * It is served once on this Mac's loopback, because capturing needs a secure
 * context and a real origin (a data: or file: page cannot). One page serves
 * both parts: it opens when the first one needs it and closes when the last
 * one lets go.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

/* eslint-disable @typescript-eslint/no-explicit-any -- Electron is loaded at run time from the app's own copy. */

type Listener = (...args: any[]) => void;

export class CapturePage {
  private view: any = null;
  private ready: Promise<any> | null = null;
  private readonly owners = new Set<object>();
  /** Bumped when the page closes: one still loading then closes as soon as it loads. */
  private generation = 0;
  private readonly listeners = new Map<string, Listener>();

  /** `scripts`: each part's code, run in the page with `ipcRenderer` at hand (each in a block of its own). */
  constructor(private readonly electron: any, private readonly scripts: string[]) {}

  /** This Electron can capture: Electron 30 and later (29's WebContentsView is a preview that never loads the page). */
  get available(): boolean {
    const major = Number(process.versions.electron?.split('.')[0]);
    if (major < 30) return false;
    return typeof this.electron.WebContentsView === 'function' && typeof this.electron.session?.fromPartition === 'function';
  }

  /** The loaded page's webContents (what getMediaSourceId is asked for), or null. */
  get contents(): any | null {
    try {
      return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
    } catch {
      return null;
    }
  }

  /** Listens to a message from the page (on every page this opens). */
  on(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener);
    try {
      this.contents?.ipc.on(channel, listener);
    } catch {
      // closing
    }
  }

  /**
   * The page, for `owner` (opened when nobody had it open): its webContents
   * once loaded, or null when it closed meanwhile. Rejects when it cannot load.
   */
  hold(owner: object): Promise<any | null> {
    this.owners.add(owner);
    if (!this.ready) {
      const generation = this.generation;
      const opening = this.open(generation);
      this.ready = opening.then(
        (view) => (generation === this.generation ? view.webContents : null),
        (err) => {
          if (generation === this.generation) this.ready = null;
          throw err;
        },
      );
    }
    return this.ready;
  }

  /** `owner` is done with the page: it closes once nobody needs it. */
  drop(owner: object): void {
    if (!this.owners.delete(owner) || this.owners.size > 0) return;
    this.close();
  }

  /** A command for the page (nothing happens while it is not loaded). */
  send(channel: string, command: unknown): void {
    try {
      this.contents?.send(channel, command);
    } catch {
      // closing
    }
  }

  close(): void {
    this.owners.clear();
    this.generation += 1;
    const view = this.view;
    this.view = null;
    this.ready = null;
    if (view) closeView(view);
  }

  private async open(generation: number): Promise<any> {
    const { WebContentsView, session } = this.electron;
    const token = randomBytes(12).toString('hex');
    const page = `<!doctype html><meta charset="utf-8"><title>CapMac capture</title><script>\nconst { ipcRenderer } = require('electron');\n${this.scripts.join('\n')}\n</script>`;
    const server = http.createServer((req, res) => {
      if (req.url !== `/${token}`) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    let view: any = null;
    try {
      const ses = session.fromPartition('capmac-capture');
      // Only CapMac's page lives in this session: it may capture.
      const allowed = (permission: string) => permission === 'media' || permission === 'display-capture';
      ses.setPermissionRequestHandler((_wc: unknown, permission: string, callback: (ok: boolean) => void) => callback(allowed(permission)));
      ses.setPermissionCheckHandler((_wc: unknown, permission: string) => allowed(permission));
      view = new WebContentsView({ webPreferences: { session: ses, nodeIntegration: true, contextIsolation: false, sandbox: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, devTools: false } });
      const wc = view.webContents;
      // CapMac's page only.
      wc.on('will-navigate', (e: { preventDefault(): void }) => e.preventDefault());
      wc.setWindowOpenHandler?.(() => ({ action: 'deny' }));
      for (const [channel, listener] of this.listeners) wc.ipc.on(channel, listener);
      await wc.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}/${token}`);
    } catch (err) {
      if (view) closeView(view);
      throw err;
    } finally {
      // Loaded once: nothing listens on the Mac afterwards.
      server.close();
    }
    if (generation !== this.generation) {
      closeView(view);
      return view;
    }
    this.view = view;
    return view;
  }
}

function closeView(view: any): void {
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close?.();
  } catch {
    // closing
  }
}
