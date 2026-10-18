/**
 * The Apps view: every app CapMac found in the workspace (a Capacitor app's
 * iOS and Electron apps, a Flutter or React Native app's iOS, Mac and Windows
 * apps, and the ones it only recognises yet), grouped by project when there
 * are several.
 */
import path from 'node:path';
import * as vscode from 'vscode';
import type { DetectedProject } from '../../../desktop/src/shared/contract.js';
import { s, studio, tidy } from '../i18n.js';
import { keyOf, type Model, type WorkspaceApp } from '../state/model.js';
import { appIcon, appKind, formatBytes, frameworkName } from './format.js';

type Node = { kind: 'project'; project: DetectedProject; apps: WorkspaceApp[] } | { kind: 'app'; app: WorkspaceApp };

export class AppsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposable: vscode.Disposable;
  /** What a sync copies to the Mac, per project (Studio's project cards show it), asked once. */
  private readonly sizes = new Map<string, { files: number; bytes: number } | 'asking'>();

  constructor(private readonly model: Model) {
    this.disposable = model.onDidChange((change) => {
      if (change === 'apps') this.sizes.clear();
      if (change === 'apps' || change === 'selection' || change === 'runs') this.changed.fire(undefined);
    });
  }

  /** The project's sync size, once the engine has counted it (it asks the first time). */
  private syncSize(dir: string): { files: number; bytes: number } | null {
    const key = keyOf(dir);
    const size = this.sizes.get(key);
    if (size === undefined) {
      this.sizes.set(key, 'asking');
      void this.model.client.call('projects.syncSize', { path: dir }).then((result) => {
        // Not counted (sizes are a nicety): not asked again until the apps change.
        if (this.sizes.get(key) !== 'asking' || !result.ok) return;
        this.sizes.set(key, result.value);
        this.changed.fire(undefined);
      });
    }
    return size && size !== 'asking' ? size : null;
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === 'project') return node.apps.map((app) => ({ kind: 'app', app }));
    if (node) return [];
    const byProject = new Map<string, { project: DetectedProject; apps: WorkspaceApp[] }>();
    for (const app of this.model.apps) {
      const key = keyOf(app.project.dir);
      let entry = byProject.get(key);
      if (!entry) byProject.set(key, (entry = { project: app.project, apps: [] }));
      entry.apps.push(app);
    }
    const projects = [...byProject.values()];
    if (projects.length === 1) return projects[0]!.apps.map((app) => ({ kind: 'app', app }));
    return projects.map(({ project, apps }) => ({ kind: 'project', project, apps }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'project') {
      const item = new vscode.TreeItem(node.project.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = projectPlace(node.project);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.tooltip = node.project.dir;
      item.resourceUri = vscode.Uri.file(node.project.dir);
      return item;
    }
    const { app } = node;
    const current = this.model.current();
    const isCurrent = current?.key === app.key;
    const run = this.model.runOf(app);
    const running = this.model.isRunning(app);
    const item = new vscode.TreeItem(app.app.name);
    item.id = app.key;
    const where = studio.apps.whereShort[app.app.id];
    const parts = [frameworkName(app), app.runnable ? where ?? appKind(app) : s.apps.notYet];
    if (app.app.status === 'setup') parts.push(s.apps.needsSetup);
    if (running) parts.push(run?.mode === 'live' ? `⚡ ${s.run.live}` : `▶ ${s.run.run}`);
    else if (isCurrent && this.model.runnableApps().length > 1) parts.push(s.apps.currentShort);
    item.description = parts.join(' · ');
    item.iconPath = app.runnable ? appIcon(app) : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${app.app.name}** · ${appKind(app)}\n\n`);
    if (app.runnable) md.appendMarkdown(`${studio.apps.where[app.app.id] ?? ''}\n\n`);
    else md.appendMarkdown(`${studio.apps.notYet}. ${studio.apps.notYetHint}\n\n`);
    if (app.app.hint) md.appendMarkdown(`→ ${tidy(app.app.hint)}\n\n`);
    if (app.app.version) md.appendMarkdown(`${studio.apps.version(frameworkName(app), app.app.version)}\n\n`);
    // An app built on the Mac: how much of the project a sync copies there.
    const onMac = app.runnable && (app.app.id === 'electron' || app.app.id === 'macos' || (app.app.id === 'ios' && this.model.backendOf(app) === 'mac'));
    const size = onMac ? this.syncSize(app.project.dir) : null;
    if (size) md.appendMarkdown(`${s.apps.syncSize(studio.count.files(size.files), formatBytes(size.bytes))}\n\n`);
    if (app.app.evidence.length) md.appendMarkdown(`_${studio.apps.foundFrom(app.app.evidence)}_`);
    if (isCurrent) md.appendMarkdown(`\n\n$(check) ${s.apps.current}`);
    item.tooltip = md;
    item.contextValue = app.runnable ? (isCurrent ? 'app.ready.current' : 'app.ready') : 'app.unsupported';
    if (app.runnable && !isCurrent) item.command = { command: 'capmac.useApp', title: s.apps.pickTitle, arguments: [node] };
    return item;
  }

  dispose(): void {
    this.disposable.dispose();
    this.changed.dispose();
  }
}

/**
 * Where a project is, beside its name: its folder in the workspace folder it
 * was found in, and with several workspace folders, that folder's name too
 * (two of them may hold apps of one name).
 */
function projectPlace(project: DetectedProject): string | undefined {
  const folder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.dir)) : undefined;
  if (!folder) return project.rel || undefined;
  const rel = path.relative(folder.uri.fsPath, project.dir).split(path.sep).join('/');
  return rel ? `${folder.name}/${rel}` : folder.name;
}

/** The app a tree item stands for (commands get the node). */
export function appOfNode(node: unknown): WorkspaceApp | null {
  const n = node as Node | undefined;
  return n?.kind === 'app' ? n.app : null;
}
