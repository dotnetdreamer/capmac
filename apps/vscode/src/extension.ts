/**
 * CapMac for VS Code: run Capacitor, Flutter and Electron apps on iPhone
 * simulators and iPhones (through a paired Mac, or plugged into this PC with
 * no Mac), on the Mac's desktop and on Windows, from the workspace that is
 * open. A third front end over CapMac's engine, beside the capmac CLI and
 * CapMac Studio: the engine runs in its own process, exactly as in Studio.
 */
import * as vscode from 'vscode';
import { registerCommands } from './commands.js';
import { ContextKeys } from './context.js';
import { CapmacDebugAdapter } from './debug/adapter.js';
import { ConfigProvider, DynamicConfigProvider } from './debug/provider.js';
import { s } from './i18n.js';
import { registerTools } from './lm/tools.js';
import { ScreenPanel } from './screen/panel.js';
import { Sessions } from './session.js';
import { Model } from './state/model.js';
import { provideCapmacCommand } from './terminal.js';
import { AppsTree } from './ui/appsTree.js';
import { RunCodeLens } from './ui/codeLens.js';
import { DevicesTree } from './ui/devicesTree.js';
import { Problems } from './ui/diagnostics.js';
import { Prompts } from './ui/prompts.js';
import { RunTree } from './ui/runTree.js';
import { StatusBar } from './ui/statusBar.js';

let model: Model | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<CapmacApi> {
  const output = vscode.window.createOutputChannel('CapMac', { log: true });
  context.subscriptions.push(output);

  // The engine asks (passwords, yes/no, choices) through VS Code's own inputs.
  let prompts: Prompts | null = null;
  const m = new Model(context, output, { ask: (p) => prompts?.ask(p), withdraw: (id) => prompts?.withdraw(id), reset: () => prompts?.reset() });
  model = m;
  prompts = new Prompts((response) => m.client.respondPrompt(response));
  context.subscriptions.push(m, prompts);

  const sessions = new Sessions(m, output);
  const screen = new ScreenPanel(context, m, {
    screenshot: async (app, window) => void (await sessions.screenshot(app, window)),
    run: async (app, mode) => void (await sessions.start(app, mode)),
    reloadApp: (app) => sessions.reload(app),
  });
  sessions.screen = screen;
  context.subscriptions.push(
    screen,
    // The screen tab comes back after a reload, on the current app's screen.
    vscode.window.registerWebviewPanelSerializer('capmac.screen', { deserializeWebviewPanel: async (panel) => screen.restore(panel) }),
  );

  // Views, status bar, problems, code lenses, context keys.
  const runTree = new RunTree(m);
  const appsTree = new AppsTree(m);
  const devicesTree = new DevicesTree(m);
  const runView = vscode.window.createTreeView('capmac.run', { treeDataProvider: runTree, showCollapseAll: false });
  const appsView = vscode.window.createTreeView('capmac.apps', { treeDataProvider: appsTree });
  const devicesView = vscode.window.createTreeView('capmac.devices', { treeDataProvider: devicesTree, showCollapseAll: true });
  const updateRunViewTitle = () => {
    const app = m.current();
    runView.description = app ? app.app.name : undefined;
    const run = m.runOf(app);
    runView.badge = run?.status === 'failed' ? { value: 1, tooltip: s.status.failed } : undefined;
  };
  context.subscriptions.push(
    runTree, appsTree, devicesTree, runView, appsView, devicesView,
    m.onDidChange(updateRunViewTitle),
    new StatusBar(m),
    new Problems(m),
    new ContextKeys(m),
    vscode.languages.registerCodeLensProvider(RunCodeLens.selector, new RunCodeLens(m)),
  );

  // Run and Debug: every run is a debug session of type "capmac".
  const configs = new ConfigProvider(m, sessions);
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('capmac', configs, vscode.DebugConfigurationProviderTriggerKind.Initial),
    vscode.debug.registerDebugConfigurationProvider('capmac', new DynamicConfigProvider(m), vscode.DebugConfigurationProviderTriggerKind.Dynamic),
    vscode.debug.registerDebugAdapterDescriptorFactory('capmac', {
      createDebugAdapterDescriptor: (session) => new vscode.DebugAdapterInlineImplementation(new CapmacDebugAdapter(m, session, sessions)),
    }),
    vscode.debug.onDidStartDebugSession((session) => session.type === 'capmac' && sessions.sessions.push(session)),
    vscode.debug.onDidTerminateDebugSession((session) => {
      const i = sessions.sessions.indexOf(session);
      if (i >= 0) sessions.sessions.splice(i, 1);
    }),
  );

  registerCommands(context, m, sessions, screen, output);
  registerTools(context, m, sessions);
  void provideCapmacCommand(context, output);

  // The engine crashed for good: say so, with a way out.
  context.subscriptions.push(m.onDidChange((change) => {
    if (change === 'engine' && m.engine.state === 'crashed' && !m.engine.restarting) {
      void vscode.window.showErrorMessage(s.engine.gaveUp, { detail: s.engine.gaveUpHint } as vscode.MessageOptions, s.engine.showLog, s.engine.reload).then((answer) => {
        if (answer === s.engine.showLog) output.show();
        else if (answer === s.engine.reload) void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    }
  }));

  m.start();
  return { statusReport: async () => (await import('./lm/tools.js')).statusReport(m), model: m };
}

export async function deactivate(): Promise<void> {
  // Stops runs (and the apps they started) cleanly, then the engine.
  await model?.client.shutdown();
  model = null;
}

/** What the extension gives other extensions and its tests. */
export interface CapmacApi {
  statusReport(): Promise<string>;
  model: Model;
}
