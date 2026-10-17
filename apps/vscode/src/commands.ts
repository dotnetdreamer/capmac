/** Every CapMac command: the palette's, the views' buttons and menus, the debug toolbar's. */
import * as vscode from 'vscode';
import type { Check, MacSummary } from '../../desktop/src/shared/contract.js';
import { EngineError } from './engine/client.js';
import { s, studio, tidy } from './i18n.js';
import { checkPc, setupPc } from './pcSetup.js';
import { setStreamPreference, streamPreference, type ScreenPanel } from './screen/panel.js';
import type { Sessions } from './session.js';
import { addSkill } from './skill.js';
import { errorText, type Model, type WorkspaceApp } from './state/model.js';
import { appOfNode } from './ui/appsTree.js';
import type { DeviceNode } from './ui/devicesTree.js';
import { pairMac, pickApp, pickBackend, pickFlutterMode, pickIpaKind, pickSample, pickTarget } from './ui/pickers.js';

export function registerCommands(context: vscode.ExtensionContext, model: Model, sessions: Sessions, screen: ScreenPanel, output: vscode.LogOutputChannel): void {
  /** The app a command is about: the one it was given (a tree item), else the current one. */
  const appFrom = (node?: unknown): WorkspaceApp | null => appOfNode(node) ?? model.current();
  const needApp = (node?: unknown): WorkspaceApp | null => {
    const app = appFrom(node);
    if (!app) void vscode.window.showWarningMessage(s.session.noApp, { detail: s.session.noAppHint } as vscode.MessageOptions);
    return app;
  };
  /** The Mac a command is about: the tree item's, else the current app's, else the only or default one. */
  const macFrom = async (node?: unknown): Promise<MacSummary | null> => {
    const n = node as DeviceNode | undefined;
    if (n && 'mac' in n && n.mac) return n.mac;
    const app = model.current();
    const fromApp = app ? model.macFor(app) : null;
    if (fromApp) return fromApp;
    if (model.macs.length === 1) return model.macs[0]!;
    if (!model.macs.length) {
      void vscode.commands.executeCommand('capmac.pairMac');
      return null;
    }
    const picked = await vscode.window.showQuickPick(model.macs.map((m) => ({ label: m.label, description: m.isDefault ? s.devices.defaultMac : undefined, mac: m })), { title: s.pick.macTitle });
    return picked?.mac ?? null;
  };
  /** Runs `work`, and says what went wrong in a notification. */
  const guard = (work: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
    try {
      await work(...args);
    } catch (err) {
      if (err instanceof EngineError && err.cancelled) return;
      const { message, hint } = errorText(err);
      output.error(`${message}${hint ? ` (${hint})` : ''}`);
      void vscode.window.showErrorMessage(message, ...(hint ? [{ title: s.engine.showLog }] : [])).then((answer) => answer && output.show());
    }
  };
  const register = (id: string, work: (...args: any[]) => Promise<unknown> | unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, guard(async (...args) => work(...args))));

  // ─── Run ─────────────────────────────────────────────────────────────────
  register('capmac.run', async (node?: unknown) => {
    const app = needApp(node);
    if (app) await sessions.start(app, 'run');
  });
  register('capmac.live', async (node?: unknown) => {
    const app = needApp(node);
    if (app) await sessions.start(app, 'live');
  });
  register('capmac.runApp', async (node?: unknown) => {
    const app = appOfNode(node);
    if (!app) return;
    if (model.current()?.key !== app.key) await model.useApp(app);
    await sessions.start(app, 'run');
  });
  register('capmac.liveApp', async (node?: unknown) => {
    const app = appOfNode(node);
    if (!app) return;
    if (model.current()?.key !== app.key) await model.useApp(app);
    await sessions.start(app, 'live');
  });
  register('capmac.stop', async () => {
    const app = model.current();
    if (app) await sessions.stop(app);
  });
  register('capmac.runWithoutBuilding', async () => {
    const app = needApp();
    if (app) await sessions.start(app, 'run', { webBuild: false, name: `${studio.commands.run}: ${app.app.name} (${s.cmdLabel.noWebBuild})` });
  });
  register('capmac.runInMode', async () => {
    const app = needApp();
    if (!app) return;
    const mode = await pickFlutterMode();
    if (mode) await sessions.start(app, 'run', { flutterMode: mode, name: `${studio.commands.run}: ${app.app.name} (${s.pick.flutterModes[mode].label.toLowerCase()})` });
  });
  register('capmac.sync', async () => {
    const app = needApp();
    if (app) await sessions.sync(app);
  });
  register('capmac.buildIpa', async () => {
    const app = needApp();
    if (!app) return;
    // On this PC the profile from setup decides; through the Mac, the kind of build.
    const kind = model.backendOf(app) === 'wsl' ? null : await pickIpaKind();
    if (kind === undefined) return;
    await sessions.buildIpa(app, kind);
  });
  register('capmac.reload', async () => {
    const app = needApp();
    if (app) await sessions.reload(app);
  });
  register('capmac.hotRestart', async () => {
    const app = needApp();
    if (app) await sessions.restart(app);
  });
  register('capmac.relaunch', async () => {
    const app = needApp();
    if (app) await sessions.restart(app);
  });
  register('capmac.rebuild', async () => {
    const app = needApp();
    if (app) await sessions.rebuild(app);
  });
  register('capmac.cleanRebuild', async () => {
    const app = needApp();
    if (app) await sessions.rebuild(app, true);
  });
  register('capmac.showScreen', async () => {
    const app = needApp();
    if (app) await sessions.showScreen(app);
  });
  register('capmac.devtools', async () => {
    const app = needApp();
    if (app) await sessions.devtools(app);
  });
  register('capmac.runRelease', async () => {
    const app = needApp();
    if (app) await sessions.runRelease(app);
  });
  register('capmac.screenshot', async () => {
    const app = needApp();
    if (app) await sessions.screenshot(app);
  });
  register('capmac.openInXcode', async () => {
    const app = needApp();
    if (!app) return;
    const mac = model.macFor(app);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${studio.commands.openXcode}…` }, () => model.client.invoke('xcode.open', { projectPath: app.project.dir, mac: mac?.name }));
  });
  register('capmac.showBuildLog', async () => {
    const app = needApp();
    const run = model.runOf(app);
    if (!app || !run?.buildLogPath) return;
    const log = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: studio.buildLog.loading }, () => model.client.invoke('logs.buildLog', { projectPath: app.project.dir, mac: run.mac ?? undefined, path: run.buildLogPath! }));
    const doc = await vscode.workspace.openTextDocument({ content: log.text, language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  register('capmac.showLog', () => output.show());
  register('capmac.openProblems', () => vscode.commands.executeCommand('workbench.actions.view.problems'));
  register('capmac.openIpa', async (file?: string) => {
    if (file) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
  });
  register('capmac.openDevServer', async (url?: string) => {
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  // ─── The app and where it runs ───────────────────────────────────────────
  register('capmac.pickApp', async () => {
    const app = await pickApp(model);
    if (app) await useApp(app);
  });
  const useApp = async (app: WorkspaceApp) => {
    const running = model.activeSession(model.current());
    const current = model.current();
    if (running && current && current.key !== app.key && current.project === app.project) {
      // Another app of the same project: the running one stops first (as in Studio).
      const answer = await vscode.window.showWarningMessage(studio.apps.switchTitle(studio.apps.kind[app.app.id] ?? app.app.name), { modal: true, detail: studio.apps.switchBody(studio.apps.kind[current.app.id] ?? current.app.name) }, studio.apps.switch);
      if (!answer) return;
      await sessions.stop(current);
    }
    await model.useApp(app);
    vscode.window.setStatusBarMessage(`$(check) ${s.apps.switched(studio.apps.kind[app.app.id] ?? app.app.name)}`, 3000);
  };
  register('capmac.useApp', async (node?: unknown) => {
    const app = appOfNode(node);
    if (app) await useApp(app);
  });
  register('capmac.pickTarget', async () => {
    const app = needApp();
    if (app) await pickTarget(model, app);
  });
  register('capmac.pickBackend', async () => {
    const app = needApp();
    if (app) await pickBackend(model, app);
  });
  const useTargetNode = async (node: DeviceNode | undefined): Promise<WorkspaceApp | null> => {
    const app = model.current();
    if (!app || !node) return null;
    if (node.kind === 'target' && app.app.id === 'ios') {
      if (model.backendOf(app) !== 'mac') await model.setBackend(app, 'mac');
      await model.setDestination(app, { mac: node.mac.name, target: node.target.udid });
      return app;
    }
    if (node.kind === 'pcPhone') {
      if (model.backendOf(app) !== 'wsl') await model.setBackend(app, 'wsl');
      await model.setDestination(app, { target: node.target.udid });
      return app;
    }
    if (node.kind === 'macDesktop' && (app.app.id === 'electron' || app.app.id === 'macos')) {
      await model.setDestination(app, { mac: node.mac.name });
      return app;
    }
    if (node.kind === 'pcWindows' && app.app.id === 'windows') return app;
    return null;
  };
  register('capmac.useTarget', async (node?: DeviceNode) => {
    await useTargetNode(node);
  });
  register('capmac.runOnTarget', async (node?: DeviceNode) => {
    const app = await useTargetNode(node);
    if (app) await sessions.start(app, 'run');
  });
  register('capmac.showTargetScreen', async (node?: DeviceNode) => {
    const app = await useTargetNode(node);
    if (app) await sessions.showScreen(app);
  });
  register('capmac.bootSimulator', async (node?: DeviceNode) => {
    if (node?.kind !== 'target') return;
    await model.client.invoke('simulators.boot', { mac: node.mac.name, udid: node.target.udid });
    await model.refreshTargets(node.mac.name);
  });
  register('capmac.shutdownSimulator', async (node?: DeviceNode) => {
    if (node?.kind !== 'target') return;
    await model.client.invoke('simulators.shutdown', { mac: node.mac.name, udid: node.target.udid });
    await model.refreshTargets(node.mac.name);
  });

  // ─── Macs ────────────────────────────────────────────────────────────────
  register('capmac.pairMac', () => pairMac(model));
  register('capmac.unpairMac', async (node?: unknown) => {
    const mac = await macFrom(node);
    if (!mac) return;
    const answer = await vscode.window.showWarningMessage(s.macs.unpairConfirm(mac.label), { modal: true, detail: s.macs.unpairDetail }, s.macs.unpair);
    if (answer !== s.macs.unpair) return;
    await model.client.invoke('macs.unpair', { name: mac.name });
    await model.refreshMacs();
    vscode.window.setStatusBarMessage(s.macs.unpaired(mac.label), 4000);
  });
  register('capmac.setDefaultMac', async (node?: unknown) => {
    const mac = await macFrom(node);
    if (!mac) return;
    await model.client.invoke('macs.setDefault', { name: mac.name });
    await model.refreshMacs();
    vscode.window.setStatusBarMessage(`$(star-full) ${s.macs.defaultSet(mac.label)}`, 4000);
  });
  register('capmac.connectMac', async (node?: unknown) => {
    const mac = await macFrom(node);
    if (!mac) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: studio.macState.connecting }, () => model.client.invoke('macs.connect', { name: mac.name }));
    await model.refreshMacs();
    await model.refreshTargets(mac.name);
  });
  register('capmac.checkMac', async (node?: unknown) => {
    const mac = await macFrom(node);
    if (!mac) return;
    const health = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: s.macs.checking(mac.label) }, () => model.checkMac(mac.name));
    if (health.error) {
      void vscode.window.showErrorMessage(health.error);
      return;
    }
    const issues = health.checks.filter((c) => c.level === 'fail' || c.level === 'warn');
    if (!issues.length) {
      void vscode.window.showInformationMessage(s.macs.allGood(mac.label));
      return;
    }
    const answer = await vscode.window.showWarningMessage(s.macs.issues(mac.label, issues.length), s.macs.showIssues);
    if (answer) await vscode.commands.executeCommand('capmac.devices.focus');
  });
  register('capmac.fix', async (node?: DeviceNode) => {
    if (node?.kind !== 'check' || !node.check.action || !node.mac) return;
    const { action } = node.check as Check & { action: NonNullable<Check['action']> };
    if (action.confirm) {
      const answer = await vscode.window.showWarningMessage(action.label, { modal: true, detail: tidy(action.confirm) }, s.devices.fixIt);
      if (!answer) return;
    }
    const mac = node.mac;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: s.macs.fixing(action.label) }, () => model.client.invoke('macs.fix', { name: mac.name, fix: action.id }));
    vscode.window.setStatusBarMessage(`$(check) ${s.macs.fixed}`, 3000);
    await model.checkMac(mac.name);
  });
  register('capmac.unlockKeychain', async (node?: unknown) => {
    const mac = await macFrom(node);
    if (!mac) return;
    await model.client.invoke('macs.unlockKeychain', { name: mac.name });
    vscode.window.setStatusBarMessage(`$(unlock) ${s.macs.keychainUnlocked}`, 4000);
  });
  register('capmac.remoteOn', async (node?: unknown) => {
    const mac = await macFrom(node);
    if (!mac) return;
    const server = await model.client.invoke('remote.server', {});
    if (!server.url) {
      const url = await vscode.window.showInputBox({ title: s.macs.remoteNeedsServer, prompt: s.macs.remoteServerPrompt, placeHolder: 'wss://signal.example.com', ignoreFocusOut: true, validateInput: (v) => (/^wss?:\/\/\S+$/.test(v.trim()) ? undefined : s.macs.remoteServerPrompt) });
      if (!url) return;
      await model.client.invoke('remote.setServer', { url: url.trim() });
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: studio.commands.remoteOn(mac.label) }, () => model.client.invoke('macs.remote.enable', { name: mac.name }));
    await model.refreshMacs();
    void vscode.window.showInformationMessage(s.macs.remoteOn(mac.label));
  });
  register('capmac.remoteOff', async (node?: unknown) => {
    const mac = await macFrom(node);
    if (!mac) return;
    const answer = await vscode.window.showWarningMessage(s.macs.remoteOffConfirm(mac.label), { modal: true, detail: s.macs.remoteOffDetail }, s.macs.turnOff);
    if (answer !== s.macs.turnOff) return;
    await model.client.invoke('macs.remote.disable', { name: mac.name });
    await model.refreshMacs();
    vscode.window.setStatusBarMessage(s.macs.remoteOff(mac.label), 4000);
  });

  // ─── This PC (no Mac) ────────────────────────────────────────────────────
  const iosApp = () => {
    const current = model.current();
    return current?.app.id === 'ios' ? current : model.runnableApps().find((a) => a.app.id === 'ios') ?? null;
  };
  register('capmac.setupPc', async () => {
    const app = iosApp();
    if (!app) {
      void vscode.window.showWarningMessage(s.session.noApp, { detail: s.session.noAppHint } as vscode.MessageOptions);
      return;
    }
    await setupPc(model, app);
  });
  register('capmac.stopPcSetup', async () => {
    const app = iosApp();
    const setupId = app ? model.pcFor(app.project.dir).setupId : null;
    if (setupId) await model.client.invoke('wsl.stopSetup', { setupId });
  });
  register('capmac.checkPc', async () => {
    const app = iosApp();
    if (app) await checkPc(model, app);
  });

  // ─── Project ─────────────────────────────────────────────────────────────
  register('capmac.installDependencies', async () => {
    const app = needApp();
    if (!app) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: s.deps.installing }, () => model.client.invoke('projects.installDeps', { path: app.project.dir }));
    vscode.window.setStatusBarMessage(`$(check) ${s.deps.done}`, 4000);
  });
  register('capmac.trySample', async () => {
    const kind = await pickSample();
    if (!kind) return;
    // A kind this engine may not have yet (React Native) is read from the contract at build time.
    const sample = await model.client.invoke('projects.createSample', { kind } as Parameters<typeof model.client.invoke<'projects.createSample'>>[1]);
    const uri = vscode.Uri.file(sample.path);
    const here = s.pick.sampleOpenHere;
    const fresh = s.pick.sampleOpenNew;
    const empty = !vscode.workspace.workspaceFolders?.length;
    const answer = empty ? here : await vscode.window.showInformationMessage(s.sample.created(s.pick.samples[kind].label), { detail: sample.path } as vscode.MessageOptions, fresh, here);
    if (!answer) return;
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: answer === fresh });
  });
  register('capmac.refresh', async () => {
    await Promise.all([model.refreshMacs(), model.detect()]);
    for (const mac of model.macs) void model.refreshTargets(mac.name);
  });
  register('capmac.toggleStream', async () => {
    const current = await streamPreference();
    const picked = await vscode.window.showQuickPick(
      [
        { label: `${current === 'smooth' ? '$(check)' : '$(blank)'} ${s.screen.smooth}`, detail: s.screen.smoothHint, value: 'smooth' as const },
        { label: `${current === 'compatible' ? '$(check)' : '$(blank)'} ${s.screen.compatible}`, detail: s.screen.compatibleHint, value: 'compatible' as const },
      ],
      { title: studio.settings.stream },
    );
    if (!picked || picked.value === current) return;
    await setStreamPreference(picked.value);
    vscode.window.setStatusBarMessage(s.screen.streamSet(picked.value === 'smooth' ? s.screen.smooth : s.screen.compatible), 4000);
    await screen.reopen();
  });
  register('capmac.addSkill', () => addSkill(context, model));
  register('capmac.getStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#capmac.start`, false));
}
