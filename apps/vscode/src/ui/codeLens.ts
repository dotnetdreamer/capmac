/**
 * "▶ Run on iPhone 17 Pro · ⚡ Live" at the top of a project's
 * capacitor.config, pubspec.yaml and capmac.json, for that project's app.
 */
import path from 'node:path';
import * as vscode from 'vscode';
import { s, studio } from '../i18n.js';
import { keyOf, type Model } from '../state/model.js';
import { isActive } from '../state/runs.js';

export class RunCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  static readonly selector: vscode.DocumentSelector = [
    { scheme: 'file', pattern: '**/capacitor.config.{json,ts,js}' },
    { scheme: 'file', pattern: '**/pubspec.yaml' },
    { scheme: 'file', pattern: '**/capmac.json' },
    // React Native and Expo apps.
    { scheme: 'file', pattern: '**/metro.config.{js,cjs,mjs,ts}' },
    { scheme: 'file', pattern: '**/app.json' },
  ];

  constructor(private readonly model: Model) {
    this.disposables.push(
      model.onDidChange((change) => {
        if (change === 'runs' || change === 'selection' || change === 'apps' || change === 'targets') this.changed.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('capmac.codeLens') && this.changed.fire()),
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('capmac').get<boolean>('codeLens', true)) return [];
    const dir = keyOf(path.dirname(document.uri.fsPath));
    const apps = this.model.runnableApps().filter((a) => keyOf(a.project.dir) === dir);
    if (!apps.length) return [];
    const current = this.model.current();
    const app = apps.find((a) => a.key === current?.key) ?? apps[0]!;
    const range = new vscode.Range(0, 0, 0, 0);
    const run = this.model.runOf(app);
    if (current?.key === app.key && run && isActive(run)) {
      const where = run.target?.name ?? this.model.resolveDestination(app).label;
      const lenses = [
        new vscode.CodeLens(range, { title: s.codeLens.running(run.mode === 'live' ? s.status.live(where) : s.status.running(where)), command: 'capmac.run.focus' }),
        new vscode.CodeLens(range, { title: s.codeLens.stop, command: 'capmac.stop' }),
      ];
      if (this.model.screenFor(app)) lenses.push(new vscode.CodeLens(range, { title: s.codeLens.screen, command: 'capmac.showScreen' }));
      return lenses;
    }
    const dest = this.model.resolveDestination(app);
    const where = dest.kind === 'none' ? studio.common.theMac : dest.label;
    const node = { kind: 'app', app };
    return [
      new vscode.CodeLens(range, { title: s.codeLens.run(where), command: 'capmac.runApp', arguments: [node], tooltip: studio.toolbar.runTip }),
      new vscode.CodeLens(range, { title: s.codeLens.live, command: 'capmac.liveApp', arguments: [node], tooltip: studio.toolbar.liveTip }),
    ];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
  }
}
