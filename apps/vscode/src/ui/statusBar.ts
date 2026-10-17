/**
 * The status bar: which app runs, where it runs (click to change), and what
 * the run is doing now.
 */
import * as vscode from 'vscode';
import { s, studio } from '../i18n.js';
import { keyOf, pcReady, type Model } from '../state/model.js';
import { isActive, phaseNow, runningPhase } from '../state/runs.js';
import { appKind } from './format.js';

export class StatusBar implements vscode.Disposable {
  private readonly app = vscode.window.createStatusBarItem('capmac.app', vscode.StatusBarAlignment.Left, -100);
  private readonly target = vscode.window.createStatusBarItem('capmac.target', vscode.StatusBarAlignment.Left, -101);
  private readonly session = vscode.window.createStatusBarItem('capmac.session', vscode.StatusBarAlignment.Left, -102);
  private readonly disposable: vscode.Disposable;

  constructor(private readonly model: Model) {
    this.app.name = 'CapMac: app';
    this.target.name = 'CapMac: where it runs';
    this.session.name = 'CapMac: run';
    this.app.command = 'capmac.pickApp';
    this.target.command = 'capmac.pickTarget';
    this.session.command = 'capmac.run.focus';
    this.disposable = model.onDidChange(() => this.update());
    this.update();
  }

  update(): void {
    const app = this.model.current();
    if (!app || this.model.engine.state !== 'ready') {
      this.app.hide();
      this.target.hide();
      this.session.hide();
      return;
    }
    // The app: only worth showing when there is a choice.
    if (this.model.runnableApps().length > 1) {
      this.app.text = `$(package) ${app.app.name} · ${studio.apps.whereShort[app.app.id] ?? app.app.id}`;
      this.app.tooltip = s.status.appTip(app.app.name, appKind(app));
      this.app.show();
    } else this.app.hide();

    const dest = this.model.resolveDestination(app);
    this.target.backgroundColor = undefined;
    if (dest.kind === 'none') {
      this.target.text = `$(plug) ${s.status.pairMac}`;
      this.target.tooltip = s.status.pairMacTip;
      this.target.command = 'capmac.pairMac';
      this.target.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (dest.kind === 'pc-iphone' && !pcReady(this.model.pc.get(keyOf(app.project.dir))?.status)) {
      this.target.text = `$(desktop-download) ${s.status.setUpPc}`;
      this.target.tooltip = studio.pc.bannerBody;
      this.target.command = 'capmac.setupPc';
    } else {
      const icon = dest.kind === 'mac-desktop' ? 'vm' : dest.kind === 'pc-desktop' ? 'window' : 'device-mobile';
      this.target.text = `$(${icon}) ${dest.label}`;
      this.target.tooltip = s.status.targetTip(app.app.name, dest.detail ? `${dest.label} (${dest.detail})` : dest.label);
      this.target.command = 'capmac.pickTarget';
    }
    this.target.show();

    const run = this.model.runOf(app);
    if (!run || run.runNumber === 0) {
      this.session.hide();
      return;
    }
    this.session.backgroundColor = undefined;
    if (isActive(run)) {
      const where = run.target?.name ?? dest.label;
      if (run.status === 'running' || run.status === 'idle') {
        this.session.text = run.mode === 'live' ? `$(zap) ${s.status.live(where)}` : `$(play) ${s.status.running(where)}`;
      } else if (run.status === 'failed') {
        this.session.text = `$(error) ${s.status.failed}`;
        this.session.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      } else {
        this.session.text = `$(sync~spin) ${s.status.building(phaseNow(runningPhase(run), run.backend === 'wsl'))}`;
      }
      this.session.tooltip = s.status.sessionTip;
      this.session.show();
    } else if (run.status === 'failed') {
      this.session.text = `$(error) ${s.status.failed}`;
      this.session.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.session.tooltip = s.status.sessionTip;
      this.session.show();
    } else {
      this.session.hide();
    }
  }

  dispose(): void {
    this.disposable.dispose();
    this.app.dispose();
    this.target.dispose();
    this.session.dispose();
  }
}
