/**
 * The Run view: the app CapMac works on, where it runs, and the current run's
 * steps as they happen (CapMac Studio's toolbar and timeline, as a tree).
 */
import * as vscode from 'vscode';
import { s, studio, tidy } from '../i18n.js';
import { pcReady, type Model, type WorkspaceApp } from '../state/model.js';
import { isActive, isNative, phaseLabel, phasesFor, shortReason, type PhaseState, type RunState, type TimelinePhase } from '../state/runs.js';
import { appIcon, appKind, frameworkName, targetIcon } from './format.js';

type Node =
  | { kind: 'app'; app: WorkspaceApp }
  | { kind: 'target'; app: WorkspaceApp }
  | { kind: 'session'; app: WorkspaceApp; run: RunState }
  | { kind: 'phase'; app: WorkspaceApp; run: RunState; phase: TimelinePhase; state: PhaseState | undefined }
  | { kind: 'preparing'; title: string }
  | { kind: 'problems'; app: WorkspaceApp; errors: number; warnings: number }
  | { kind: 'devserver'; url: string; command: string | null }
  | { kind: 'buildlog'; app: WorkspaceApp }
  | { kind: 'ipa'; file: string; size: number }
  | { kind: 'error'; message: string; hint?: string; details?: string[] }
  | { kind: 'hint' };

const color = (id: string) => new vscode.ThemeColor(id);

export class RunTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private ticker: NodeJS.Timeout | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly model: Model) {
    this.disposables.push(model.onDidChange((change) => {
      if (change !== 'health') this.refresh();
    }));
  }

  refresh(): void {
    this.changed.fire(undefined);
    // A step is running: its time ticks every second.
    const run = this.model.runOf(this.model.current());
    const ticking = Boolean(run && isActive(run) && (run.status === 'building' || run.status === 'starting'));
    if (ticking && !this.ticker) this.ticker = setInterval(() => this.changed.fire(undefined), 1000);
    else if (!ticking && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  getChildren(node?: Node): Node[] {
    const app = this.model.current();
    if (!app) return [];
    if (node?.kind === 'session') return this.sessionChildren(node.app, node.run);
    if (node) return [];
    const run = this.model.runOf(app);
    const nodes: Node[] = [{ kind: 'app', app }, { kind: 'target', app }];
    if (!run || run.runNumber === 0) {
      nodes.push({ kind: 'hint' });
      return nodes;
    }
    nodes.push({ kind: 'session', app, run });
    const errors = run.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = run.diagnostics.filter((d) => d.severity === 'warning' && d.own).length;
    if (errors || warnings) nodes.push({ kind: 'problems', app, errors, warnings });
    if (run.error && run.status === 'failed') nodes.push({ kind: 'error', message: tidy(run.error.message), hint: tidy(run.error.hint), details: run.error.details });
    if (run.live?.devServerUrl && isActive(run)) nodes.push({ kind: 'devserver', url: run.live.devServerUrl, command: run.live.command });
    if (run.ipa) nodes.push({ kind: 'ipa', file: run.ipa.file, size: run.ipa.size });
    if (run.buildLogPath) nodes.push({ kind: 'buildlog', app });
    return nodes;
  }

  private sessionChildren(app: WorkspaceApp, run: RunState): Node[] {
    const summary = this.model.summaryOf(app);
    const phases = phasesFor(run, { flutter: app.project.framework === 'flutter', native: isNative(app.project.framework), capacitorElectron: summary?.electron?.flavor === 'capacitor' });
    const nodes: Node[] = [];
    if (run.preparing) nodes.push({ kind: 'preparing', title: run.preparing.title });
    for (const phase of phases) nodes.push({ kind: 'phase', app, run, phase, state: run.phases[phase] });
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'app': {
        const { app } = node;
        const item = new vscode.TreeItem(app.app.name);
        item.description = `${frameworkName(app)} · ${appKind(app)}`;
        item.iconPath = appIcon(app);
        item.tooltip = new vscode.MarkdownString(`**${app.app.name}** · ${appKind(app)}\n\n${studio.apps.where[app.app.id] ?? ''}\n\n$(folder) ${app.project.dir}`, true);
        item.contextValue = 'run.app';
        if (this.model.runnableApps().length > 1) item.command = { command: 'capmac.pickApp', title: s.apps.pickTitle };
        return item;
      }
      case 'target': {
        const { app } = node;
        const dest = this.model.resolveDestination(app);
        const pc = dest.backend === 'wsl' ? this.model.pc.get(this.keyOfApp(app)) : null;
        const item = new vscode.TreeItem(dest.label);
        item.contextValue = 'run.target';
        if (dest.kind === 'none') {
          item.label = s.status.pairMac;
          item.description = s.pick.pairMacHint;
          item.iconPath = new vscode.ThemeIcon('plug', color('charts.yellow'));
          item.command = { command: 'capmac.pairMac', title: s.status.pairMac };
          return item;
        }
        if (dest.kind === 'pc-iphone' && pc && !pcReady(pc.status)) {
          item.label = pc.setupId ? s.devices.pcSettingUp(studio.pc.settingUp) : s.devices.pcNeedsSetup;
          item.description = s.devices.thisPc;
          item.iconPath = new vscode.ThemeIcon(pc.setupId ? 'loading~spin' : 'desktop-download', color('charts.yellow'));
          item.command = { command: 'capmac.setupPc', title: s.devices.pcNeedsSetup };
          return item;
        }
        item.description = [dest.detail, dest.kind === 'auto' ? studio.targets.auto : null, dest.target?.os].filter(Boolean).join(' · ');
        item.iconPath = targetIcon(dest.kind, dest.target);
        item.tooltip = s.status.targetTip(app.app.name, dest.detail ? `${dest.label} (${dest.detail})` : dest.label);
        item.command = { command: 'capmac.pickTarget', title: s.run.chooseTarget };
        return item;
      }
      case 'session': {
        const { run, app } = node;
        const mode = run.mode === 'live' ? s.run.live : run.mode === 'ipa' ? s.run.ipa : run.mode === 'sync' ? s.run.sync : s.run.run;
        // An IPA or a sync is made on a machine, not run on a device.
        const machine = run.backend === 'wsl' ? s.devices.thisPc : this.model.macs.find((m) => m.name === run.mac)?.label ?? run.mac ?? '';
        const where = run.mode === 'ipa' || run.mode === 'sync' ? machine : run.target?.name ?? (run.onPc ? s.devices.windowsDesktop : run.onMac ? s.devices.macDesktop : this.model.resolveDestination(app).label);
        const item = new vscode.TreeItem(where ? s.run.session(mode, where) : mode, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `session-${run.runNumber}`;
        const elapsed = run.startedAt ? (run.endedAt ?? Date.now()) - run.startedAt : 0;
        const status = this.statusText(run);
        item.description = [status, elapsed ? s.time.clock(elapsed) : null].filter(Boolean).join(' · ');
        item.iconPath = run.status === 'failed'
          ? new vscode.ThemeIcon('error', color('errorForeground'))
          : isActive(run)
            ? run.status === 'running' || run.status === 'idle'
              ? new vscode.ThemeIcon(run.mode === 'live' ? 'zap' : 'play', color('testing.iconPassed'))
              : new vscode.ThemeIcon('loading~spin')
            : new vscode.ThemeIcon(run.status === 'done' ? 'pass' : 'circle-large-outline');
        item.tooltip = studio.timeline.run(run.runNumber);
        return item;
      }
      case 'phase': {
        const { state, run, app, phase } = node;
        const where = { onMac: run.onMac, onPc: run.onPc, pc: run.backend === 'wsl', flutter: app.project.framework === 'flutter', reactNative: isNative(app.project.framework) };
        const label = state?.status === 'running' && state.title ? state.title : phaseLabel(phase, where);
        const item = new vscode.TreeItem(label);
        const st = state?.status ?? 'pending';
        item.iconPath = {
          pending: new vscode.ThemeIcon('circle-large-outline', color('disabledForeground')),
          running: new vscode.ThemeIcon('loading~spin'),
          done: new vscode.ThemeIcon('pass', color('testing.iconPassed')),
          skipped: new vscode.ThemeIcon('circle-slash', color('disabledForeground')),
          failed: new vscode.ThemeIcon('error', color('errorForeground')),
          cancelled: new vscode.ThemeIcon('debug-stop', color('disabledForeground')),
        }[st];
        if (st === 'running') {
          const elapsed = state?.startedAt ? s.time.seconds(Date.now() - state.startedAt) : '';
          const count = state?.count ? s.count.files(state.count) : null;
          item.description = [elapsed, count, state?.progress ? tidy(state.progress) : null].filter(Boolean).join(' · ');
        } else if (st === 'done') {
          item.description = [state?.ms ? s.time.seconds(state.ms) : null, state?.detail ? tidy(state.detail) : null].filter(Boolean).join(' · ');
        } else if (st === 'skipped') {
          item.description = shortReason(state?.detail);
          item.tooltip = tidy(state?.detail);
        } else if (st === 'failed' || st === 'cancelled') {
          item.description = st === 'failed' ? studio.timeline.short.failed : studio.timeline.short.stopped;
        }
        if (!item.tooltip) item.tooltip = `${phaseLabel(phase, where)}: ${studio.timeline.status[st]}`;
        return item;
      }
      case 'preparing': {
        const item = new vscode.TreeItem(s.run.preparing);
        item.description = node.title;
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        return item;
      }
      case 'problems': {
        const item = new vscode.TreeItem(s.run.problems(node.errors, node.warnings));
        item.iconPath = node.errors ? new vscode.ThemeIcon('error', color('errorForeground')) : new vscode.ThemeIcon('warning', color('editorWarning.foreground'));
        item.tooltip = s.run.problemsTip;
        item.command = { command: 'workbench.actions.view.problems', title: s.run.problemsTip };
        item.contextValue = 'run.problems';
        return item;
      }
      case 'devserver': {
        const item = new vscode.TreeItem(s.run.devServer);
        item.description = node.url;
        item.iconPath = new vscode.ThemeIcon('globe');
        item.tooltip = s.run.devServerTip(node.command);
        item.contextValue = 'run.devServer';
        item.command = { command: 'capmac.openDevServer', title: s.run.devServer, arguments: [node.url] };
        return item;
      }
      case 'buildlog': {
        const item = new vscode.TreeItem(s.run.buildLog);
        item.iconPath = new vscode.ThemeIcon('output');
        item.tooltip = s.run.buildLogTip;
        item.contextValue = 'run.buildLog';
        item.command = { command: 'capmac.showBuildLog', title: s.run.buildLog };
        return item;
      }
      case 'ipa': {
        const item = new vscode.TreeItem(s.run.ipaReady);
        item.description = `${node.file.split(/[\\/]/).pop()} · ${(node.size / 1e6).toFixed(1)} MB`;
        item.iconPath = new vscode.ThemeIcon('package', color('testing.iconPassed'));
        item.tooltip = node.file;
        item.contextValue = 'run.ipa';
        item.command = { command: 'capmac.openIpa', title: s.run.ipaTip, arguments: [node.file] };
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(node.message);
        item.iconPath = new vscode.ThemeIcon('error', color('errorForeground'));
        item.description = node.hint;
        const md = new vscode.MarkdownString(`**${node.message}**${node.hint ? `\n\n→ ${node.hint}` : ''}`);
        if (node.details?.length) md.appendCodeblock(node.details.slice(-25).join('\n'), 'text');
        item.tooltip = md;
        item.command = { command: 'workbench.debug.action.toggleRepl', title: s.session.showOutput };
        return item;
      }
      case 'hint': {
        const item = new vscode.TreeItem(s.run.hint);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  private statusText(run: RunState): string {
    if (run.status === 'failed') return studio.timeline.failed;
    if (run.status === 'stopped') return studio.timeline.stopped;
    if (run.status === 'done') return studio.timeline.done;
    if (run.status === 'stopping') return s.session.stopping;
    if (run.status === 'idle') return s.run.appStopped;
    if (run.status === 'running') {
      if (run.live?.hmrUpdatedAt) return s.run.reloaded(new Date(run.live.hmrUpdatedAt).toLocaleTimeString());
      return s.run.appRunning;
    }
    return studio.timeline.inProgress;
  }

  private keyOfApp(app: WorkspaceApp): string {
    return app.key.split('#')[0]!;
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
  }
}
