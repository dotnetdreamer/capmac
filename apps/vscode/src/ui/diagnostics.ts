/**
 * Build errors and warnings in VS Code's Problems panel: Xcode's, Flutter's,
 * an Electron build's and the web build's, at the line in the project's own
 * files on this PC.
 * Warnings from packages (Pods, Swift packages, node_modules) stay out unless
 * `capmac.problems.packageWarnings` is on, as with CapMac Studio's setting.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Diagnostic } from '../../../desktop/src/shared/contract.js';
import { keyOf, type Model } from '../state/model.js';

const SEVERITY: Record<Diagnostic['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  note: vscode.DiagnosticSeverity.Information,
};

/** A file on this PC (the engine maps the Mac's paths back; anything else stays a Mac path). */
const isLocal = (file: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(file) || (process.platform !== 'win32' && file.startsWith('/'));

export class Problems implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('capmac');
  /** Per project: the run its problems belong to, and the files they were put on. */
  private readonly shown = new Map<string, { runNumber: number; count: number; files: vscode.Uri[] }>();
  private readonly disposable: vscode.Disposable;
  private readonly settings: vscode.Disposable;

  constructor(private readonly model: Model) {
    this.disposable = model.onDidChange((change) => {
      if (change === 'runs') this.update();
    });
    // Packages' warnings in or out: every run's problems again.
    this.settings = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('capmac.problems.packageWarnings')) return;
      this.shown.clear();
      this.collection.clear();
      this.update();
    });
  }

  private update(): void {
    const packageWarnings = vscode.workspace.getConfiguration('capmac').get<boolean>('problems.packageWarnings', false);
    for (const [key, run] of this.model.runs) {
      const last = this.shown.get(key);
      if (last && last.runNumber === run.runNumber && last.count === run.diagnostics.length) continue;
      // A new run starts with a clean slate.
      for (const uri of last?.files ?? []) this.collection.delete(uri);
      const byFile = new Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }>();
      const fallback = configFile(run.path);
      for (const d of run.diagnostics) {
        if (d.severity === 'note') continue;
        if (d.severity === 'warning' && !d.own && !packageWarnings) continue;
        const file = d.file && isLocal(d.file) && existsSync(d.file) ? d.file : fallback;
        if (!file) continue;
        const uri = vscode.Uri.file(file);
        const line = file === d.file && d.line ? d.line - 1 : 0;
        const column = file === d.file && d.column ? d.column - 1 : 0;
        // A Mac path (an SDK header, DerivedData) can't open here: it goes with the message.
        const where = d.file && file !== d.file ? `${d.file}${d.line ? `:${d.line}` : ''}\n` : '';
        const excerpt = d.context?.length ? `\n${d.context.join('\n')}` : '';
        const diagnostic = new vscode.Diagnostic(new vscode.Range(line, column, line, Number.MAX_SAFE_INTEGER), `${where}${d.message}${excerpt}`, SEVERITY[d.severity]);
        diagnostic.source = 'CapMac';
        let entry = byFile.get(uri.toString());
        if (!entry) byFile.set(uri.toString(), (entry = { uri, items: [] }));
        entry.items.push(diagnostic);
      }
      for (const { uri, items } of byFile.values()) this.collection.set(uri, items);
      this.shown.set(key, { runNumber: run.runNumber, count: run.diagnostics.length, files: [...byFile.values()].map((e) => e.uri) });
    }
  }

  /** The number of errors CapMac shows for a project now. */
  errorsFor(projectPath: string): number {
    const shown = this.shown.get(keyOf(projectPath));
    if (!shown) return 0;
    return shown.files.reduce((n, uri) => n + (this.collection.get(uri)?.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length ?? 0), 0);
  }

  dispose(): void {
    this.disposable.dispose();
    this.settings.dispose();
    this.collection.dispose();
  }
}

/** The project's config file: where a problem with no file of its own goes. */
function configFile(projectPath: string): string | null {
  for (const name of ['capacitor.config.ts', 'capacitor.config.json', 'capacitor.config.js', 'pubspec.yaml', 'capmac.json', 'package.json']) {
    const file = path.join(projectPath, name);
    if (existsSync(file)) return file;
  }
  return null;
}
