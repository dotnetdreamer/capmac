/**
 * The extension in a workspace of several folders (.vscode-test.mjs, the
 * "workspace" run): a Capacitor app, a Flutter app, and a folder with no app.
 * No Mac is paired.
 */
import { strict as assert } from 'node:assert';
import path from 'node:path';
import * as vscode from 'vscode';
import { DynamicConfigProvider } from '../../src/debug/provider.js';
import type { CapmacApi } from '../../src/extension.js';

const ID = 'capmac.capmac-vscode';

async function until<T>(check: () => T | undefined | null | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('CapMac for VS Code, with several folders', function () {
  this.timeout(90_000);
  let api: CapmacApi;
  const projectOf = (dir: string | undefined) => (dir ? path.basename(dir) : null);

  before(async () => {
    const extension = vscode.extensions.getExtension<CapmacApi>(ID);
    assert.ok(extension, 'the extension is installed');
    api = await extension.activate();
    await until(() => api.model.engine.state === 'ready');
    await until(() => new Set(api.model.apps.map((a) => a.project.dir)).size >= 2);
  });

  it('finds the apps of every folder, and none in a folder without one', () => {
    const projects = [...new Set(api.model.apps.map((a) => projectOf(a.project.dir)))].sort();
    assert.deepEqual(projects, ['hello-capacitor', 'hello-flutter']);
    assert.equal(vscode.workspace.workspaceFolders?.length, 3);
  });

  it('lists each folder’s apps once in Run and Debug, under that folder', () => {
    const provider = new DynamicConfigProvider(api.model);
    const [capacitor, flutter, notes] = vscode.workspace.workspaceFolders!;
    const projects = (folder: vscode.WorkspaceFolder | undefined) => provider.provideDebugConfigurations(folder).map((config) => projectOf(config.projectPath as string));
    assert.ok(projects(capacitor).length > 0);
    assert.ok(projects(capacitor).every((p) => p === 'hello-capacitor'));
    assert.ok(projects(flutter).length > 0);
    assert.ok(projects(flutter).every((p) => p === 'hello-flutter'));
    assert.deepEqual(projects(notes), []);
    // VS Code asks again for the workspace and the user's settings: the apps are listed already.
    assert.deepEqual(projects(undefined), []);
  });

  it('works on the app of the file that is open, until one is picked', async () => {
    const [capacitor, flutter] = vscode.workspace.workspaceFolders!;
    const open = (folder: vscode.WorkspaceFolder, ...rel: string[]) => vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, ...rel)));
    await open(flutter!, 'lib', 'main.dart');
    await until(() => projectOf(api.model.current()?.project.dir) === 'hello-flutter');
    await open(capacitor!, 'src', 'main.js');
    await until(() => projectOf(api.model.current()?.project.dir) === 'hello-capacitor');
    // Picked: it stays, whichever file is open.
    const flutterApp = api.model.runnableApps().find((a) => projectOf(a.project.dir) === 'hello-flutter' && a.app.id === 'ios')!;
    await api.model.useApp(flutterApp);
    await open(capacitor!, 'index.html');
    assert.equal(api.model.current()?.key, flutterApp.key);
  });
});
