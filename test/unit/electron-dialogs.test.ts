import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { duplexPair } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DialogBroker,
  DialogService,
  electronResult,
  fileDialog,
  listFolder,
  messageDialog,
  type FromWorker,
  type ToWorker,
  type WorkerLike,
} from '../../packages/core/src/electron-hook/dialogs.js';
import { checkAnswer, type AppDialog, type AppDialogAnswer, type HookMessage } from '../../packages/core/src/shared/electron.js';
import { encodeJson, FrameDecoder } from '../../packages/core/src/shared/frames.js';
import { resolveMacPath } from '../../packages/cli/src/terminal.js';

const places = { home: '/Users/me', project: '/Users/me/.capmac/projects/app/src' };

describe('what the app passed', () => {
  it('reads a message box the way Electron shows it on the Mac', () => {
    const plain = messageDialog(1, { message: 'Hi' }, null, false, 'App');
    expect(plain).toMatchObject({ kind: 'message', type: 'none', buttons: [], defaultId: 0, cancelId: 0, message: 'Hi' });
    // A "Cancel" or "No" button cancels.
    expect(messageDialog(2, { buttons: ['Save', 'Don’t save', 'Cancel'] }, 3, false, 'App')).toMatchObject({ defaultId: 0, cancelId: 2, window: 3 });
    expect(messageDialog(3, { buttons: ['Yes', 'No'] }, null, false, 'App').cancelId).toBe(1);
    // The default first button: the second one cancels.
    expect(messageDialog(4, { buttons: ['OK', 'Later'], defaultId: 0 }, null, false, 'App').cancelId).toBe(1);
    expect(messageDialog(5, { buttons: ['A', 'B'], defaultId: 7, cancelId: 9, type: 'odd' }, null, true, 'App')).toMatchObject({ defaultId: 0, cancelId: 0, type: 'none', blocking: true });
  });

  it('reads a file dialog: an open dialog picks files unless it says otherwise, and extensions lose their dot', () => {
    const open = fileDialog(1, 'open', { filters: [{ name: 'Images', extensions: ['.png', 'jpg'] }] }, null, false, 'App', places);
    expect(open.properties).toEqual(['openFile']);
    expect(open.filters).toEqual([{ name: 'Images', extensions: ['png', 'jpg'] }]);
    expect(open).toMatchObject({ home: '/Users/me', project: places.project });
    expect(fileDialog(2, 'open', { properties: ['openDirectory'] }, null, false, 'App', places).properties).toEqual(['openDirectory']);
    expect(fileDialog(3, 'save', { defaultPath: '/tmp/a.txt' }, 1, true, 'App', places)).toMatchObject({ kind: 'save', defaultPath: '/tmp/a.txt', properties: [] });
  });

  it('checks answers against their dialog', () => {
    const box = messageDialog(1, { buttons: ['A', 'B'] }, null, false, 'App');
    expect(checkAnswer(box, { kind: 'message', response: 1 })).toEqual({ kind: 'message', response: 1, checkboxChecked: false });
    expect(checkAnswer(box, { kind: 'message', response: 2 })).toBeNull();
    expect(checkAnswer(box, { kind: 'files', paths: [] })).toBeNull();
    // No buttons: one OK button.
    expect(checkAnswer(messageDialog(2, {}, null, false, 'App'), { kind: 'message', response: 0 })).not.toBeNull();
    const open = fileDialog(3, 'open', {}, null, false, 'App', places);
    expect(checkAnswer(open, { kind: 'files', paths: ['/a'] })).toEqual({ kind: 'files', paths: ['/a'] });
    expect(checkAnswer(open, { kind: 'files', paths: ['/a', '/b'] })).toBeNull();
    expect(checkAnswer(open, { kind: 'files', paths: ['relative'] })).toBeNull();
    expect(checkAnswer(fileDialog(4, 'open', { properties: ['openFile', 'multiSelections'] }, null, false, 'App', places), { kind: 'files', paths: ['/a', '/b'] })).not.toBeNull();
    expect(checkAnswer(fileDialog(5, 'save', {}, null, false, 'App', places), { kind: 'files', paths: ['/a', '/b'] })).toBeNull();
  });

  it('answers in the shape Electron returns', () => {
    const box = messageDialog(1, { buttons: ['A', 'B'], checkboxLabel: 'x' }, null, false, 'App');
    expect(electronResult(box, { kind: 'message', response: 1, checkboxChecked: true }, false)).toEqual({ response: 1, checkboxChecked: true });
    expect(electronResult(box, { kind: 'message', response: 1 }, true)).toBe(1);
    const open = fileDialog(2, 'open', {}, null, false, 'App', places);
    expect(electronResult(open, { kind: 'files', paths: ['/a'] }, false)).toEqual({ canceled: false, filePaths: ['/a'] });
    expect(electronResult(open, { kind: 'files', paths: [] }, false)).toEqual({ canceled: true, filePaths: [] });
    expect(electronResult(open, { kind: 'files', paths: [] }, true)).toBeUndefined();
    const save = fileDialog(3, 'save', {}, null, false, 'App', places);
    expect(electronResult(save, { kind: 'files', paths: ['/a.txt'] }, false)).toEqual({ canceled: false, filePath: '/a.txt' });
    expect(electronResult(save, { kind: 'files', paths: [] }, true)).toBe('');
  });
});

/** A client of the dialog socket (CapMac's agent), over an in-memory stream. */
function client(broker: DialogBroker) {
  const [ours, theirs] = duplexPair();
  broker.addClient(theirs);
  const decoder = new FrameDecoder();
  const messages: HookMessage[] = [];
  ours.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) if (frame.kind === 'json') messages.push(frame.value as HookMessage);
  });
  let id = 0;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return {
    messages,
    send: async (request: Record<string, unknown>) => {
      const req = ++id;
      ours.write(encodeJson({ ...request, id: req }));
      await settle();
      return messages.find((m) => m.t === 'result' && m.id === req) as Extract<HookMessage, { t: 'result' }> | undefined;
    },
    hello: async () => {
      ours.write(encodeJson({ t: 'hello', role: 'control' }));
      await settle();
    },
    lastDialogs: () => [...messages].reverse().find((m) => m.t === 'dialogs') as Extract<HookMessage, { t: 'dialogs' }> | undefined,
    close: () => ours.destroy(),
  };
}

/**
 * The worker thread, in this thread: the real broker behind a fake Worker.
 * `answerSync` answers a blocking dialog as soon as it opens (the main thread waits for it).
 */
function fakeWorker(options: { answerSync?: (dialog: AppDialog) => AppDialogAnswer } = {}) {
  const emitter = new EventEmitter();
  const posted: ToWorker[] = [];
  const broker = new DialogBroker({ post: (message: FromWorker) => setImmediate(() => emitter.emit('message', message)) }, places);
  const worker: WorkerLike = {
    postMessage(message: ToWorker) {
      posted.push(message);
      broker.handle(message);
      if (message.t === 'open' && message.sync && options.answerSync) broker.answer(message.dialog.id, options.answerSync(message.dialog));
    },
    on(event: string, listener: (arg: any) => void) {
      emitter.on(event, listener);
    },
    terminate() {
      broker.stop();
      emitter.emit('exit', 0);
    },
  };
  return { worker, broker, posted, ready: () => emitter.emit('message', { t: 'ready', socket: '/tmp/test.dlg' } satisfies FromWorker), crash: () => emitter.emit('exit', 1) };
}

/** Electron's dialog module: records what was shown natively. */
function fakeDialog() {
  const shown: string[] = [];
  const dialog = {
    showMessageBox: (...args: unknown[]) => {
      shown.push('showMessageBox');
      return Promise.resolve({ response: 0, checkboxChecked: false, args });
    },
    showMessageBoxSync: () => {
      shown.push('showMessageBoxSync');
      return 0;
    },
    showOpenDialog: () => {
      shown.push('showOpenDialog');
      return Promise.resolve({ canceled: false, filePaths: ['/native/pick'] });
    },
    showOpenDialogSync: () => {
      shown.push('showOpenDialogSync');
      return ['/native/pick'];
    },
    showSaveDialog: () => {
      shown.push('showSaveDialog');
      return Promise.resolve({ canceled: false, filePath: '/native/save' });
    },
    showSaveDialogSync: () => {
      shown.push('showSaveDialogSync');
      return '/native/save';
    },
    showErrorBox: () => {
      shown.push('showErrorBox');
    },
    showCertificateTrustDialog: () => 'untouched',
  };
  // Electron's own module is read-only: the wrapper must not need to write to it.
  Object.freeze(dialog);
  return { dialog, shown };
}

class FakeWindow extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
  getNativeWindowHandle() {
    return Buffer.alloc(8);
  }
  isDestroyed() {
    return false;
  }
}

describe('dialogs while the app is in the background', () => {
  let background: boolean;
  let service: DialogService;
  let fake: ReturnType<typeof fakeWorker>;
  let electron: ReturnType<typeof fakeDialog>;
  let dialog: any;

  async function start(options: Parameters<typeof fakeWorker>[0] = {}) {
    fake = fakeWorker(options);
    const started = service.start(() => fake.worker);
    fake.ready();
    expect(await started).toBe('/tmp/test.dlg');
  }

  beforeEach(() => {
    background = true;
    service = new DialogService({ inBackground: () => background, windowId: (win) => (win as FakeWindow).id, appName: () => 'Hello' }, { project: places.project });
    electron = fakeDialog();
    dialog = service.wrap(electron.dialog);
  });

  it('shows the Mac’s own dialog when CapMac cannot (no worker) or someone uses the app there', async () => {
    expect(await service.start(() => null)).toBeNull();
    await dialog.showMessageBox({ message: 'a' });
    await start();
    background = false;
    await dialog.showMessageBox({ message: 'b' });
    expect(dialog.showMessageBoxSync({ message: 'c' })).toBe(0);
    expect(electron.shown).toEqual(['showMessageBox', 'showMessageBox', 'showMessageBoxSync']);
    // What CapMac does not handle stays Electron's.
    expect(dialog.showCertificateTrustDialog()).toBe('untouched');
  });

  it('keeps a message box off the Mac and answers it from CapMac', async () => {
    await start();
    const agent = client(fake.broker);
    const win = new FakeWindow(4);
    const pending = dialog.showMessageBox(win, { type: 'question', message: 'Keep?', buttons: ['Keep', 'Discard', 'Cancel'], checkboxLabel: 'Always' });
    await agent.hello();
    const shown = agent.lastDialogs()!.dialogs;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ kind: 'message', window: 4, blocking: false, app: 'Hello', message: 'Keep?', cancelId: 2 });
    // An answer that does not fit is refused, and the dialog stays.
    expect((await agent.send({ t: 'dialog-answer', dialog: shown[0]!.id, answer: { kind: 'message', response: 5 } }))?.ok).toBe(false);
    expect(fake.broker.list()).toHaveLength(1);
    expect((await agent.send({ t: 'dialog-answer', dialog: shown[0]!.id, answer: { kind: 'message', response: 1, checkboxChecked: true } }))?.ok).toBe(true);
    expect(await pending).toEqual({ response: 1, checkboxChecked: true });
    expect(agent.lastDialogs()).toMatchObject({ dialogs: [], closed: { id: shown[0]!.id, how: 'answered' } });
    expect(electron.shown).toEqual([]);
  });

  it('answers a blocking dialog while the app waits for it', async () => {
    await start({ answerSync: (d) => (d.kind === 'message' ? { kind: 'message', response: d.buttons.length > 1 ? 1 : 0 } : { kind: 'files', paths: d.kind === 'open' ? ['/x/a.png', '/x/b.png'] : [] }) });
    expect(dialog.showMessageBoxSync({ message: 'Sure?', buttons: ['Yes', 'No'] })).toBe(1);
    expect(dialog.showOpenDialogSync({ properties: ['openFile', 'multiSelections'] })).toEqual(['/x/a.png', '/x/b.png']);
    expect(dialog.showSaveDialogSync({ defaultPath: '/x/a.txt' })).toBe('');
    expect(dialog.showErrorBox('Oops', 'It broke')).toBeUndefined();
    const opened = fake.posted.filter((m): m is Extract<ToWorker, { t: 'open' }> => m.t === 'open');
    expect(opened.map((m) => [m.dialog.kind, m.dialog.blocking])).toEqual([['message', true], ['open', true], ['save', true], ['message', true]]);
    expect(opened[3]!.dialog).toMatchObject({ type: 'error', message: 'Oops', detail: 'It broke', buttons: ['OK'] });
    expect(electron.shown).toEqual([]);
  });

  it('answers file dialogs with paths, and a cancel with none', async () => {
    await start();
    const agent = client(fake.broker);
    const opening = dialog.showOpenDialog({ title: 'Pick', filters: [{ name: 'Text', extensions: ['txt'] }] });
    const saving = dialog.showSaveDialog(new FakeWindow(1), { defaultPath: '/Users/me/a.txt' });
    await agent.hello();
    const [open, save] = agent.lastDialogs()!.dialogs;
    expect(open).toMatchObject({ kind: 'open', title: 'Pick', window: null, home: os.homedir() });
    await agent.send({ t: 'dialog-answer', dialog: open!.id, answer: { kind: 'files', paths: ['/Users/me/notes.txt'] } });
    await agent.send({ t: 'dialog-answer', dialog: save!.id, answer: { kind: 'files', paths: [] } });
    expect(await opening).toEqual({ canceled: false, filePaths: ['/Users/me/notes.txt'] });
    expect(await saving).toEqual({ canceled: true, filePath: '' });
  });

  it('moves waiting dialogs to the Mac when someone switches to the app there', async () => {
    await start();
    const agent = client(fake.broker);
    await agent.hello();
    const pending = dialog.showOpenDialog({ title: 'Pick' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agent.lastDialogs()!.dialogs).toHaveLength(1);
    service.appActivated();
    expect(await pending).toEqual({ canceled: false, filePaths: ['/native/pick'] });
    expect(electron.shown).toEqual(['showOpenDialog']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agent.lastDialogs()).toMatchObject({ dialogs: [], closed: { how: 'mac' } });
  });

  it('closes a dialog the app gave up on (its AbortSignal, or its window closed) as a cancel', async () => {
    await start();
    const controller = new AbortController();
    const aborted = dialog.showMessageBox({ message: 'Wait', buttons: ['OK', 'Cancel'], signal: controller.signal });
    const win = new FakeWindow(2);
    const sheet = dialog.showMessageBox(win, { message: 'On a window', buttons: ['Go', 'Stop'], cancelId: 1 });
    expect(fake.broker.list()).toHaveLength(2);
    controller.abort();
    win.emit('closed');
    expect(await aborted).toEqual({ response: 1, checkboxChecked: false });
    expect(await sheet).toEqual({ response: 1, checkboxChecked: false });
    expect(fake.broker.list()).toHaveLength(0);
    expect(fake.posted.filter((m) => m.t === 'close').map((m) => (m as Extract<ToWorker, { t: 'close' }>).how)).toEqual(['app', 'app']);
  });

  it('sends waiting dialogs to the Mac when the worker stops', async () => {
    await start();
    const pending = dialog.showSaveDialog({ title: 'Save' });
    fake.crash();
    expect(await pending).toEqual({ canceled: false, filePath: '/native/save' });
    // From now on the Mac shows them.
    await dialog.showMessageBox({ message: 'later' });
    expect(electron.shown).toEqual(['showSaveDialog', 'showMessageBox']);
  });
});

describe('folders on the Mac, for file dialogs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-dlg-'));
    mkdirSync(path.join(dir, 'beta'));
    mkdirSync(path.join(dir, 'Alpha'));
    mkdirSync(path.join(dir, 'Tool.app'));
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, 'b10.txt'), 'x');
    writeFileSync(path.join(dir, 'b9.txt'), 'hello');
    writeFileSync(path.join(dir, '.env'), 'secret');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists folders first, sorted the way people read them, apps as files, hidden ones only when asked', () => {
    const folder = listFolder(dir, { home: dir, project: null });
    expect(folder.path).toBe(path.resolve(dir));
    expect(folder.entries.map((e) => `${e.dir ? 'd' : 'f'} ${e.name}`)).toEqual(['d Alpha', 'd beta', 'f b9.txt', 'f b10.txt', 'f Tool.app']);
    expect(folder.entries.find((e) => e.name === 'b9.txt')).toMatchObject({ size: 5, hidden: false });
    expect(listFolder(dir, { home: dir, project: null, hidden: true }).entries.map((e) => e.name)).toContain('.env');
    expect(folder.places.find((p) => p.name === 'Home')?.path).toBe(dir);
  });

  it('opens a file’s folder, the home folder for "~", and refuses what is not on the Mac', () => {
    expect(listFolder(path.join(dir, 'b9.txt'), { home: dir, project: null }).path).toBe(path.resolve(dir));
    // A save dialog's suggested name, not there yet.
    expect(listFolder(path.join(dir, 'new.txt'), { home: dir, project: null }).path).toBe(path.resolve(dir));
    expect(listFolder('~', { home: dir, project: null }).path).toBe(path.resolve(dir));
    expect(() => listFolder('relative/path', { home: dir, project: null })).toThrow();
  });

  it('serves listings and new folders on the dialog socket', async () => {
    const broker = new DialogBroker({ post: () => undefined }, { home: dir, project: null });
    const agent = client(broker);
    const listed = await agent.send({ t: 'dialog-list', path: dir });
    expect(listed?.ok).toBe(true);
    expect((listed?.data as { entries: unknown[] }).entries).toHaveLength(5);
    const made = await agent.send({ t: 'dialog-mkdir', path: path.join(dir, 'gamma') });
    expect(made?.ok).toBe(true);
    const again = await agent.send({ t: 'dialog-mkdir', path: path.join(dir, 'gamma') });
    expect(again).toMatchObject({ ok: false, error: 'Something with that name is there already' });
    expect(await agent.send({ t: 'dialog-list', path: path.join(dir, 'missing', 'deeper') })).toMatchObject({ ok: false });
    agent.close();
    broker.stop();
  });
});

describe('paths typed in the terminal', () => {
  it('reads them as full paths on the Mac', () => {
    expect(resolveMacPath('~/Desktop/a.png', '/Users/me/Documents', '/Users/me')).toBe('/Users/me/Desktop/a.png');
    expect(resolveMacPath('notes.txt', '/Users/me/Documents', '/Users/me')).toBe('/Users/me/Documents/notes.txt');
    expect(resolveMacPath('"../My File.txt"', '~/Documents', '/Users/me')).toBe('/Users/me/My File.txt');
    expect(resolveMacPath('/tmp/./x', '/', '/Users/me')).toBe('/tmp/x');
    expect(resolveMacPath('   ', '/', '/Users/me')).toBe('');
  });
});

describe('the app’s electron module', () => {
  it('hands the app a dialog module that goes through CapMac, and leaves the rest as it is', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const hook = await import('../../packages/core/src/electron-hook/hook.js');
    const app = Object.assign(new EventEmitter(), { isReady: () => true, focus: () => undefined, getName: () => 'Hello' });
    class BrowserWindow extends EventEmitter {}
    const { dialog, shown } = fakeDialog();
    const electron = { app, BrowserWindow, dialog, shell: { openExternal: () => undefined }, globalShortcut: { register: () => true, registerAll: () => undefined }, webContents: { getAllWebContents: () => [] } };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-hookdlg-'));
    try {
      hook.guardFocus(electron, path.join(dir, 'app.sock'));
      const guarded = hook.guardedElectron(electron) as typeof electron;
      expect(guarded.dialog).not.toBe(dialog);
      expect(guarded.dialog).toBe(guarded.dialog);
      expect(guarded.shell).toBe(electron.shell);
      // No dialog worker here (CapMac did not start one): the Mac's own dialog shows.
      await guarded.dialog.showMessageBox({ message: 'hi' });
      expect(shown).toEqual(['showMessageBox']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
