/**
 * The extension inside a real VS Code (run by @vscode/test-cli, see
 * .vscode-test.mjs): it activates for a Capacitor project, starts its engine,
 * finds the project's apps, and offers its commands, debugger and tools. The
 * CapMac config is an empty temporary one: no Mac is paired.
 */
import { strict as assert } from 'node:assert';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Envelope } from '../../../desktop/src/shared/contract.js';
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

describe('CapMac for VS Code', function () {
  this.timeout(90_000);
  let api: CapmacApi;

  before(async () => {
    const extension = vscode.extensions.getExtension<CapmacApi>(ID);
    assert.ok(extension, 'the extension is installed');
    api = await extension.activate();
    await until(() => api.model.engine.state === 'ready');
  });

  it('starts its engine in a process of its own', () => {
    assert.equal(api.model.engine.state, 'ready');
    assert.ok(api.model.client.running);
  });

  it('finds the workspace’s apps, and works on the iOS app', async () => {
    await until(() => api.model.apps.length > 0);
    const ids = api.model.apps.map((a) => a.app.id).sort();
    assert.deepEqual(ids, ['electron', 'ios']);
    assert.equal(api.model.current()?.app.id, 'ios');
    assert.equal(api.model.current()?.app.name, 'Hello CapMac');
  });

  it('has every command of its menus', async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    const manifest = vscode.extensions.getExtension(ID)!.packageJSON as { contributes: { commands: Array<{ command: string }> } };
    const missing = manifest.contributes.commands.map((c) => c.command).filter((id) => !all.has(id));
    assert.deepEqual(missing, []);
  });

  it('says what it sees, with no Mac paired', async () => {
    const report = await api.statusReport();
    assert.match(report, /Hello CapMac/);
    assert.match(report, /no Mac paired/);
  });

  it('offers its tools to AI agents', async () => {
    const names = vscode.lm.tools.map((t) => t.name);
    for (const name of ['capmac_status', 'capmac_run', 'capmac_stop', 'capmac_screenshot', 'capmac_logs']) assert.ok(names.includes(name), `${name} is registered`);
    const result = await vscode.lm.invokeTool('capmac_status', { input: {}, toolInvocationToken: undefined });
    const text = result.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('');
    assert.match(text, /Apps in this workspace/);
    assert.match(text, /Hello CapMac/);
  });

  it('reads the app’s console for agents (nothing yet)', async () => {
    const result = await vscode.lm.invokeTool('capmac_logs', { input: { lines: 10 }, toolInvocationToken: undefined });
    const text = result.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('');
    assert.match(text, /No console output yet/);
  });

  it('does not start a run with no Mac paired (it says what to do instead)', async () => {
    const folder = vscode.workspace.workspaceFolders![0]!;
    const started = await vscode.debug.startDebugging(folder, { type: 'capmac', request: 'launch', name: 'CapMac: Live', mode: 'live' });
    assert.equal(started, false);
    assert.equal(vscode.debug.activeDebugSession, undefined);
  });

  it('lists the debug configurations of its apps', async () => {
    // The dynamic provider: Live and Run for each runnable app.
    const app = api.model.current()!;
    const where = api.model.resolveDestination(app);
    assert.equal(where.kind, 'none');
  });

  it('puts the web build’s errors in Problems, at their place', async () => {
    // What the engine sends while the web build of a run fails (Vite 8's output), straight into the model.
    const dir = api.model.current()!.project.dir;
    const scope = { sessionId: 'web-build-test', projectPath: dir };
    const feed = (events: Envelope['event'][]) => (api.model as unknown as { onEvents(batch: Envelope[]): void }).onEvents(events.map((event) => ({ scope, event })));
    feed([
      { type: 'session-started', mode: 'run', projectPath: dir, mac: 'Test Mac', target: null },
      { type: 'step', id: 'web', title: 'Building web assets (npm run build)', phase: 'web' },
      ...['✗ Build failed in 48ms', 'error during build:', '[PARSE_ERROR] Unexpected token', '    ╭─[ src/main.js:4:11 ]', '    │'].map((text): Envelope['event'] => ({ type: 'tool-output', stream: 'stdout', text })),
    ]);
    const uri = vscode.Uri.file(path.join(dir, 'src', 'main.js'));
    const problem = await until(() => vscode.languages.getDiagnostics(uri).find((d) => d.source === 'CapMac'));
    assert.equal(problem.message, 'Unexpected token');
    assert.equal(problem.severity, vscode.DiagnosticSeverity.Error);
    assert.deepEqual([problem.range.start.line, problem.range.start.character], [3, 10]);
    feed([{ type: 'session-ended', mode: 'run', ok: false, cancelled: false, ms: 50 }]);
  });

  it('ends what the engine was doing when it stops, and starts it again', async () => {
    const dir = api.model.current()!.project.dir;
    const scope = { sessionId: 'crash-test', projectPath: dir };
    (api.model as unknown as { onEvents(batch: Envelope[]): void }).onEvents([
      { scope, event: { type: 'session-started', mode: 'live', projectPath: dir, mac: 'Test Mac', target: null } },
      { scope, event: { type: 'step', id: 'web', title: 'Starting the dev server', phase: 'web' } },
    ]);
    assert.equal(api.model.runOf(api.model.current())?.sessionId, 'crash-test');
    // The engine process dies (out of memory, say).
    (api.model.client as unknown as { child: { kill(): void } }).child.kill();
    const run = await until(() => {
      const r = api.model.runOf(api.model.current());
      return r && !r.sessionId ? r : null;
    });
    assert.equal(run.status, 'failed');
    assert.equal(run.error?.code, 'ENGINE_CRASHED');
    await until(() => api.model.engine.state === 'ready');
    assert.match(await api.statusReport(), /Hello CapMac/);
  });
});
