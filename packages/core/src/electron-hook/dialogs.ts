/**
 * The app's native dialogs (message boxes, file pickers), while CapMac runs it.
 *
 * On the Mac, a dialog activates the app and comes to the front: it would take
 * the keyboard of whoever works there. While the app is in the background,
 * CapMac's module keeps the dialog off the Mac's screen and serves it on a
 * socket of its own, where CapMac Studio, the CLI's viewer and the terminal
 * show and answer it. Someone who switches to the app on the Mac gets the
 * dialog there instead.
 *
 * The socket is served by a worker thread: a `…Sync` dialog blocks the app's
 * main thread until it is answered, and the worker hands the answer over
 * through shared memory (Atomics). The worker is this same file (see the end
 * of hook.ts), so nothing else is written to the Mac.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { encodeJson, FrameDecoder } from '../shared/frames.js';
import {
  cancelledMessage,
  checkAnswer,
  type AppDialog,
  type AppDialogAnswer,
  type AppDialogClosed,
  type AppFileDialog,
  type AppMessageDialog,
  type HookMessage,
  type HookRequest,
  type MacFolder,
} from '../shared/electron.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Electron's dialog module, loaded at run time. */

// ─── Main thread ↔ worker ─────────────────────────────────────────────────

export type ToWorker =
  /** `sync`: shared memory the worker writes the answer into (the main thread waits on it). */
  | { t: 'open'; dialog: AppDialog; sync?: SharedArrayBuffer }
  | { t: 'close'; id: number; how: AppDialogClosed };

export type FromWorker =
  | { t: 'ready'; socket: string }
  | { t: 'failed'; message: string }
  | { t: 'answer'; id: number; answer: AppDialogAnswer };

/** Shared memory of a blocking dialog: [state, length, heartbeat] then the answer as JSON. */
const SYNC_HEADER = 12;
const SYNC_BYTES = 1024 * 1024;
const STATE_WAITING = 0;
const STATE_ANSWERED = 1;

/** Writes a blocking dialog's answer and wakes the main thread. */
export function writeSyncAnswer(buffer: SharedArrayBuffer, answer: AppDialogAnswer): void {
  let json = JSON.stringify(answer);
  let bytes = Buffer.from(json, 'utf8');
  if (bytes.length > SYNC_BYTES && answer.kind === 'files') {
    // Thousands of files: as many as fit.
    const paths = [...answer.paths];
    while (paths.length > 1 && bytes.length > SYNC_BYTES) {
      paths.length = Math.floor(paths.length / 2);
      json = JSON.stringify({ kind: 'files', paths });
      bytes = Buffer.from(json, 'utf8');
    }
  }
  const header = new Int32Array(buffer, 0, 3);
  new Uint8Array(buffer, SYNC_HEADER, Math.min(bytes.length, SYNC_BYTES)).set(bytes.subarray(0, SYNC_BYTES));
  Atomics.store(header, 1, Math.min(bytes.length, SYNC_BYTES));
  Atomics.store(header, 0, STATE_ANSWERED);
  Atomics.notify(header, 0);
}

function readSyncAnswer(buffer: SharedArrayBuffer): AppDialogAnswer | null {
  const header = new Int32Array(buffer, 0, 3);
  const length = Atomics.load(header, 1);
  try {
    return JSON.parse(Buffer.from(new Uint8Array(buffer, SYNC_HEADER, length)).toString('utf8')) as AppDialogAnswer;
  } catch {
    return null;
  }
}

/** The part of a worker_threads Worker the service uses (a fake one in tests). */
export interface WorkerLike {
  postMessage(message: ToWorker): void;
  on(event: 'message', listener: (message: FromWorker) => void): void;
  on(event: 'error' | 'exit', listener: (arg: unknown) => void): void;
  terminate(): unknown;
  unref?(): void;
}

// ─── What the app passed ──────────────────────────────────────────────────

const text = (value: unknown, max = 4000) => (typeof value === 'string' ? value.slice(0, max) : '');
const index = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : -1);
const MESSAGE_TYPES = ['none', 'info', 'error', 'question', 'warning'] as const;

/** A message box as Electron shows it on macOS (default and cancel buttons included). */
export function messageDialog(id: number, options: any, window: number | null, blocking: boolean, app: string): AppMessageDialog {
  const o = options && typeof options === 'object' ? options : {};
  const buttons = Array.isArray(o.buttons) ? o.buttons.slice(0, 16).map((b: unknown) => text(b, 200)) : [];
  const count = Math.max(1, buttons.length);
  const requestedDefault = index(o.defaultId);
  // Electron: the first button is the default one unless the app picked another.
  const defaultId = requestedDefault >= 0 && requestedDefault < count ? requestedDefault : 0;
  let cancelId = index(o.cancelId);
  if (cancelId < 0 || cancelId >= count) {
    // Electron's rule: a button labelled "Cancel" or "No", else the second one when the first is the default, else the first.
    cancelId = requestedDefault === 0 && buttons.length > 1 ? 1 : 0;
    const named = buttons.findIndex((b: string) => /^(cancel|no)$/i.test(b));
    if (named >= 0) cancelId = named;
  }
  return {
    id,
    kind: 'message',
    window,
    blocking,
    app,
    type: MESSAGE_TYPES.includes(o.type) ? o.type : 'none',
    title: text(o.title, 300),
    message: text(o.message),
    detail: text(o.detail),
    buttons,
    defaultId,
    cancelId,
    checkboxLabel: text(o.checkboxLabel, 300),
    checkboxChecked: Boolean(o.checkboxChecked),
  };
}

/** An open or save panel. */
export function fileDialog(id: number, kind: 'open' | 'save', options: any, window: number | null, blocking: boolean, app: string, places: { home: string; project: string | null }): AppFileDialog {
  const o = options && typeof options === 'object' ? options : {};
  const filters = Array.isArray(o.filters)
    ? o.filters.slice(0, 32).map((f: any) => ({ name: text(f?.name, 200), extensions: Array.isArray(f?.extensions) ? f.extensions.slice(0, 64).map((e: unknown) => text(e, 40).replace(/^\./, '')).filter(Boolean) : [] }))
    : [];
  const properties = Array.isArray(o.properties) ? o.properties.filter((p: unknown): p is string => typeof p === 'string').slice(0, 16) : [];
  return {
    id,
    kind,
    window,
    blocking,
    app,
    title: text(o.title, 300),
    message: text(o.message),
    defaultPath: text(o.defaultPath, 4096),
    buttonLabel: text(o.buttonLabel, 100),
    filters,
    properties: kind === 'open' && !properties.includes('openFile') && !properties.includes('openDirectory') ? ['openFile', ...properties] : properties,
    nameFieldLabel: text(o.nameFieldLabel, 100),
    home: places.home,
    project: places.project,
  };
}

/** What Electron's own method would have returned for this answer. */
export function electronResult(dialog: AppDialog, answer: AppDialogAnswer, sync: boolean): unknown {
  if (dialog.kind === 'message') {
    const a = answer.kind === 'message' ? answer : cancelledMessage(dialog) as Extract<AppDialogAnswer, { kind: 'message' }>;
    return sync ? a.response : { response: a.response, checkboxChecked: Boolean(a.checkboxChecked) };
  }
  const paths = answer.kind === 'files' ? answer.paths : [];
  if (dialog.kind === 'open') return sync ? (paths.length ? paths : undefined) : { canceled: paths.length === 0, filePaths: paths };
  return sync ? (paths[0] ?? '') : { canceled: paths.length === 0, filePath: paths[0] ?? '' };
}

const cancelled = (dialog: AppDialog): AppDialogAnswer => (dialog.kind === 'message' ? cancelledMessage(dialog) : { kind: 'files', paths: [] });

// ─── Main thread: the dialog module the app gets ──────────────────────────

export interface DialogHost {
  /** The app is in the background on the Mac: its dialogs stay off the Mac's screen. */
  inBackground(): boolean;
  /** The window's id, when it is one of the app's windows. */
  windowId(win: unknown): number | null;
  appName(): string;
}

interface Pending {
  dialog: AppDialog;
  resolve: (answer: AppDialogAnswer) => void;
  /** Shows it on the Mac instead (someone switched to the app there); resolves with what they picked. */
  native: () => Promise<AppDialogAnswer>;
  cleanup: () => void;
}

const isWindow = (value: unknown) => Boolean(value) && typeof value === 'object' && typeof (value as any).getNativeWindowHandle === 'function';

/** Electron's `([window, ]options)`. */
function splitArgs(args: unknown[]): { win: unknown; options: any } {
  return isWindow(args[0]) ? { win: args[0], options: args[1] ?? {} } : { win: null, options: args[0] ?? {} };
}

export class DialogService {
  private worker: WorkerLike | null = null;
  private ready = false;
  private socket: string | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly places: { home: string; project: string | null };

  constructor(private readonly host: DialogHost, options: { project?: string | null } = {}) {
    this.places = { home: os.homedir(), project: options.project ?? null };
  }

  /** Starts the worker; resolves with its socket, or null when dialogs stay native. */
  start(spawn: () => WorkerLike | null, timeoutMs = 4000): Promise<string | null> {
    let worker: WorkerLike | null = null;
    try {
      worker = spawn();
    } catch {
      worker = null;
    }
    if (!worker) return Promise.resolve(null);
    this.worker = worker;
    worker.unref?.();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      worker!.on('message', (message: FromWorker) => {
        if (message?.t === 'ready') {
          this.ready = true;
          this.socket = message.socket;
          clearTimeout(timer);
          resolve(message.socket);
        } else if (message?.t === 'failed') {
          clearTimeout(timer);
          this.stop();
          resolve(null);
        } else if (message?.t === 'answer') {
          this.answered(message.id, message.answer);
        }
      });
      const gone = () => {
        clearTimeout(timer);
        const was = this.worker;
        this.worker = null;
        this.ready = false;
        // Dialogs that were waiting go to the Mac rather than nowhere.
        if (was) for (const id of [...this.pending.keys()]) this.toMac(id);
        resolve(null);
      };
      worker!.on('error', gone);
      worker!.on('exit', gone);
    });
  }

  get available(): boolean {
    return this.ready && this.worker !== null;
  }

  get socketPath(): string | null {
    return this.socket;
  }

  /** Whether a dialog opened now goes to CapMac. */
  private remote(): boolean {
    return this.available && this.host.inBackground();
  }

  private answered(id: number, answer: AppDialogAnswer): void {
    const p = this.pending.get(id);
    if (!p) return;
    const checked = checkAnswer(p.dialog, answer) ?? cancelled(p.dialog);
    this.pending.delete(id);
    p.cleanup();
    p.resolve(checked);
  }

  /** Closes a waiting dialog in CapMac and resolves it with `answer`. */
  private settle(id: number, how: AppDialogClosed, answer?: AppDialogAnswer): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.cleanup();
    this.worker?.postMessage({ t: 'close', id, how });
    p.resolve(answer ?? cancelled(p.dialog));
  }

  /** Moves a waiting dialog to the Mac: shown there natively, answered there. */
  private toMac(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.cleanup();
    this.worker?.postMessage({ t: 'close', id, how: 'mac' });
    p.native().then(p.resolve, () => p.resolve(cancelled(p.dialog)));
  }

  /** Someone switched to the app on the Mac: the dialogs waiting in CapMac show there. */
  appActivated(): void {
    for (const id of [...this.pending.keys()]) this.toMac(id);
  }

  /** Opens a dialog in CapMac; resolves with the answer. */
  private openAsync(dialog: AppDialog, native: () => Promise<AppDialogAnswer>, win: any, signal?: AbortSignal): Promise<AppDialogAnswer> {
    return new Promise((resolve) => {
      const cleanups: Array<() => void> = [];
      // The app gave up on it (AbortSignal) or closed its window: like a cancel, as in Electron.
      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => this.settle(dialog.id, 'app');
        signal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', onAbort));
      }
      if (win && typeof win.once === 'function') {
        const onClosed = () => this.settle(dialog.id, 'app');
        win.once('closed', onClosed);
        cleanups.push(() => win.removeListener?.('closed', onClosed));
      }
      this.pending.set(dialog.id, { dialog, resolve, native, cleanup: () => cleanups.forEach((fn) => fn()) });
      this.worker!.postMessage({ t: 'open', dialog });
      if (signal?.aborted) this.settle(dialog.id, 'app');
    });
  }

  /**
   * Opens a blocking dialog in CapMac and waits for the answer (the app's
   * main thread stops, as it would on the Mac). Null when it cannot: the
   * caller shows it natively.
   */
  private openSync(dialog: AppDialog): AppDialogAnswer | null {
    const worker = this.worker;
    if (!worker) return null;
    let buffer: SharedArrayBuffer;
    try {
      buffer = new SharedArrayBuffer(SYNC_HEADER + SYNC_BYTES);
    } catch {
      return null;
    }
    const header = new Int32Array(buffer, 0, 3);
    worker.postMessage({ t: 'open', dialog, sync: buffer });
    let beat = Atomics.load(header, 2);
    let lastBeat = Date.now();
    try {
      while (Atomics.load(header, 0) === STATE_WAITING) {
        Atomics.wait(header, 0, STATE_WAITING, 1000);
        const now = Atomics.load(header, 2);
        if (now !== beat) {
          beat = now;
          lastBeat = Date.now();
        } else if (Date.now() - lastBeat > 10_000) {
          // The worker stopped answering: the Mac shows the dialog after all.
          worker.postMessage({ t: 'close', id: dialog.id, how: 'mac' });
          return null;
        }
      }
    } catch {
      // Atomics.wait is not allowed on this thread.
      worker.postMessage({ t: 'close', id: dialog.id, how: 'mac' });
      return null;
    }
    const answer = readSyncAnswer(buffer);
    return (answer && checkAnswer(dialog, answer)) ?? cancelled(dialog);
  }

  /** Electron's `dialog`, with the methods that show a dialog going through CapMac while the app is in the background. */
  wrap(original: any): any {
    if (!original || typeof original !== 'object') return original;
    const service = this;
    const wrapped = Object.create(original);
    const define = (name: string, fn: (...args: any[]) => any) => {
      if (typeof original[name] !== 'function') return;
      Object.defineProperty(wrapped, name, { value: fn, enumerable: true, configurable: true, writable: true });
    };
    const windowOf = (win: unknown) => (win ? this.host.windowId(win) : null);
    const nativeCall = (name: string, args: unknown[]) => original[name].apply(original, args);

    for (const name of ['showMessageBox', 'showOpenDialog', 'showSaveDialog'] as const) {
      define(name, function (this: unknown, ...args: unknown[]) {
        if (!service.remote()) return nativeCall(name, args);
        const { win, options } = splitArgs(args);
        const id = service.nextId++;
        const app = service.host.appName();
        const dialog = name === 'showMessageBox'
          ? messageDialog(id, options, windowOf(win), false, app)
          : fileDialog(id, name === 'showOpenDialog' ? 'open' : 'save', options, windowOf(win), false, app, service.places);
        const native = () => Promise.resolve(nativeCall(name, args)).then((result: any) => fromElectron(dialog, result));
        return service.openAsync(dialog, native, win, name === 'showMessageBox' ? options?.signal : undefined).then((answer) => electronResult(dialog, answer, false));
      });
    }
    for (const name of ['showMessageBoxSync', 'showOpenDialogSync', 'showSaveDialogSync'] as const) {
      define(name, function (this: unknown, ...args: unknown[]) {
        if (!service.remote()) return nativeCall(name, args);
        const { win, options } = splitArgs(args);
        const id = service.nextId++;
        const app = service.host.appName();
        const dialog = name === 'showMessageBoxSync'
          ? messageDialog(id, options, windowOf(win), true, app)
          : fileDialog(id, name === 'showOpenDialogSync' ? 'open' : 'save', options, windowOf(win), true, app, service.places);
        const answer = service.openSync(dialog);
        return answer ? electronResult(dialog, answer, true) : nativeCall(name, args);
      });
    }
    define('showErrorBox', function (this: unknown, title: unknown, content: unknown) {
      if (!service.remote()) return nativeCall('showErrorBox', [title, content]);
      const dialog = messageDialog(service.nextId++, { type: 'error', message: title, detail: content, buttons: ['OK'] }, null, true, service.host.appName());
      if (!service.openSync(dialog)) return nativeCall('showErrorBox', [title, content]);
      return undefined;
    });
    return wrapped;
  }

  /** The app quits: nothing waits any more. */
  stop(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, 'app');
    try {
      this.worker?.terminate();
    } catch {
      // gone already
    }
    this.worker = null;
    this.ready = false;
  }
}

/** Electron's result for a dialog shown on the Mac, as an answer. */
function fromElectron(dialog: AppDialog, result: any): AppDialogAnswer {
  if (dialog.kind === 'message') return { kind: 'message', response: typeof result?.response === 'number' ? result.response : dialog.cancelId, checkboxChecked: Boolean(result?.checkboxChecked) };
  if (result?.canceled) return { kind: 'files', paths: [] };
  const paths = dialog.kind === 'open' ? (Array.isArray(result?.filePaths) ? result.filePaths : []) : result?.filePath ? [result.filePath] : [];
  return { kind: 'files', paths: paths.filter((p: unknown): p is string => typeof p === 'string') };
}

// ─── Worker: the dialog socket ────────────────────────────────────────────

export interface DialogPort {
  post(message: FromWorker): void;
}

/** A connected client (CapMac's agent): a socket, or a stream in tests. */
export interface DialogClientStream {
  write(data: Buffer): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
  destroy(): unknown;
}

const PACKAGE_DIR = /\.(app|bundle|framework|plugin|kext|pkg|mpkg|rtfd|xcodeproj|xcworkspace|playground|photoslibrary|musiclibrary|tvlibrary|logarchive|xcarchive)$/i;
const MAX_ENTRIES = 3000;

/** A folder on the Mac, for a file dialog answered in CapMac. */
export function listFolder(requested: string, options: { hidden?: boolean; home: string; project: string | null }): MacFolder {
  const raw = requested.trim() || '~';
  const expanded = raw === '~' ? options.home : raw.startsWith('~/') ? path.join(options.home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) throw new Error('Not a folder on the Mac');
  let folder = path.resolve(expanded);
  // A file's folder (a save dialog's default path names a file).
  try {
    if (!fs.statSync(folder).isDirectory()) folder = path.dirname(folder);
  } catch {
    folder = path.dirname(folder);
    if (!fs.existsSync(folder)) throw new Error('That folder is not on the Mac');
  }
  const entries: MacFolder['entries'] = [];
  let truncated = false;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const hidden = entry.name.startsWith('.');
    if (hidden && !options.hidden) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const full = path.join(folder, entry.name);
    let dir = entry.isDirectory();
    let size = 0;
    let modified = 0;
    try {
      const st = fs.statSync(full);
      dir = st.isDirectory();
      size = dir ? 0 : st.size;
      modified = Math.round(st.mtimeMs);
    } catch {
      // a broken link: listed as a file
    }
    // Apps and other packages are files to the Mac's own dialogs.
    entries.push({ name: entry.name, dir: dir && !PACKAGE_DIR.test(entry.name), size, modified, hidden });
  }
  entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
  const places: MacFolder['places'] = [];
  const add = (name: string, p: string | null) => {
    if (p && fs.existsSync(p) && !places.some((pl) => pl.path === p)) places.push({ name, path: p });
  };
  add('Project', options.project);
  add('Home', options.home);
  add('Desktop', path.join(options.home, 'Desktop'));
  add('Documents', path.join(options.home, 'Documents'));
  add('Downloads', path.join(options.home, 'Downloads'));
  add('Applications', '/Applications');
  add('Mac', '/');
  const parent = path.dirname(folder);
  return { path: folder, parent: parent === folder ? null : parent, entries, places, truncated };
}

/**
 * The worker's side: dialogs waiting for an answer, the clients that show
 * them, and their requests (answers, folders to list, folders to make).
 */
export class DialogBroker {
  private readonly dialogs = new Map<number, { dialog: AppDialog; sync?: SharedArrayBuffer }>();
  private readonly clients = new Set<DialogClientStream>();
  private beat: NodeJS.Timeout | null = null;

  constructor(private readonly port: DialogPort, private readonly places: { home: string; project: string | null }) {}

  list(): AppDialog[] {
    return [...this.dialogs.values()].map((d) => d.dialog);
  }

  private broadcast(closed?: { id: number; how: AppDialogClosed }): void {
    const frame = encodeJson({ t: 'dialogs', dialogs: this.list(), ...(closed ? { closed } : {}) } satisfies HookMessage);
    for (const client of this.clients) client.write(frame);
  }

  /** From the main thread. */
  handle(message: ToWorker): void {
    if (message?.t === 'open') {
      this.dialogs.set(message.dialog.id, { dialog: message.dialog, sync: message.sync });
      this.updateBeat();
      this.broadcast();
    } else if (message?.t === 'close') {
      if (!this.dialogs.delete(message.id)) return;
      this.updateBeat();
      this.broadcast({ id: message.id, how: message.how });
    }
  }

  /** While a blocking dialog waits, the main thread watches this heartbeat to know the worker is alive. */
  private updateBeat(): void {
    const blocking = [...this.dialogs.values()].some((d) => d.sync);
    if (blocking && !this.beat) {
      this.beat = setInterval(() => {
        for (const d of this.dialogs.values()) if (d.sync) Atomics.add(new Int32Array(d.sync, 0, 3), 2, 1);
      }, 500);
    } else if (!blocking && this.beat) {
      clearInterval(this.beat);
      this.beat = null;
    }
  }

  answer(id: number, answer: unknown): string | null {
    const entry = this.dialogs.get(id);
    if (!entry) return 'That dialog is not open any more';
    const checked = checkAnswer(entry.dialog, answer);
    if (!checked) return 'That answer does not fit the dialog';
    this.dialogs.delete(id);
    this.updateBeat();
    if (entry.sync) writeSyncAnswer(entry.sync, checked);
    else this.port.post({ t: 'answer', id, answer: checked });
    this.broadcast({ id, how: 'answered' });
    return null;
  }

  addClient(stream: DialogClientStream): void {
    const decoder = new FrameDecoder();
    this.clients.add(stream);
    const reply = (message: HookMessage) => stream.write(encodeJson(message));
    stream.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        stream.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.kind !== 'json') continue;
        const request = frame.value as HookRequest;
        try {
          switch (request?.t) {
            case 'hello':
              reply({ t: 'dialogs', dialogs: this.list() });
              break;
            case 'dialog-answer': {
              const error = this.answer(request.dialog, request.answer);
              reply({ t: 'result', id: request.id, ok: !error, error: error ?? undefined });
              break;
            }
            case 'dialog-list':
              reply({ t: 'result', id: request.id, ok: true, data: listFolder(String(request.path ?? '~'), { hidden: Boolean(request.hidden), ...this.places }) });
              break;
            case 'dialog-mkdir': {
              const target = String(request.path ?? '');
              if (!path.isAbsolute(target)) throw new Error('Not a folder on the Mac');
              fs.mkdirSync(target);
              reply({ t: 'result', id: request.id, ok: true, data: target });
              break;
            }
            case 'ping':
              reply({ t: 'pong', id: request.id });
              break;
            default:
              break;
          }
        } catch (err) {
          const id = (request as { id?: unknown })?.id;
          if (typeof id === 'number') reply({ t: 'result', id, ok: false, error: friendlyFsError(err) });
        }
      }
    });
    const drop = () => {
      this.clients.delete(stream);
    };
    stream.on('close', drop);
    stream.on('error', drop);
  }

  stop(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    for (const client of this.clients) client.destroy();
    this.clients.clear();
  }
}

function friendlyFsError(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === 'ENOENT') return 'That folder is not on the Mac';
  if (code === 'EACCES' || code === 'EPERM') return 'macOS does not let CapMac open that folder';
  if (code === 'EEXIST') return 'Something with that name is there already';
  if (code === 'ENOTDIR') return 'That is a file, not a folder';
  return String((err as Error)?.message ?? err);
}

/** The worker thread's entry (started from hook.ts with this file and `workerData.capmacDialogs`). */
export function runDialogWorker(data: { socket: string; home: string; project: string | null }, parent: { postMessage(message: FromWorker): void; on(event: 'message', listener: (message: ToWorker) => void): void }): void {
  const broker = new DialogBroker({ post: (message) => parent.postMessage(message) }, { home: data.home, project: data.project });
  parent.on('message', (message) => broker.handle(message));
  const server = net.createServer((socket) => broker.addClient(socket));
  server.on('error', (err) => parent.postMessage({ t: 'failed', message: err.message }));
  try {
    fs.rmSync(data.socket, { force: true });
  } catch {
    // not there
  }
  server.listen(data.socket, () => {
    try {
      fs.chmodSync(data.socket, 0o600);
    } catch {
      // the folder is private anyway
    }
    parent.postMessage({ t: 'ready', socket: data.socket });
  });
}
