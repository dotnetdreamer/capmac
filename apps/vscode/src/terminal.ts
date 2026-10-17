/**
 * The `capmac` command in VS Code's terminals, with nothing installed: the
 * extension ships the CLI (the same version as its engine), writes small
 * launchers for it (core's launcherFiles, as CapMac Studio does) and adds
 * their folder to the end of PATH in VS Code's terminals only. A capmac
 * installed with npm comes first on PATH, so it still wins.
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { launcherFiles } from '@capmac/core/engine/capmac-command';

export async function provideCapmacCommand(context: vscode.ExtensionContext, output: vscode.LogOutputChannel): Promise<void> {
  const collection = context.environmentVariableCollection;
  const apply = async () => {
    const wanted = vscode.workspace.getConfiguration('capmac').get<boolean>('terminal.capmacCommand', true);
    collection.clear();
    if (!wanted) return;
    const cli = context.asAbsolutePath(path.join('dist', 'cli', 'cli.mjs'));
    if (!existsSync(cli)) return;
    const bin = path.join(context.globalStorageUri.fsPath, 'bin');
    try {
      await fs.mkdir(bin, { recursive: true });
      for (const [name, content] of Object.entries(launcherFiles(cli))) await fs.writeFile(path.join(bin, name), content, { mode: 0o755 });
    } catch (err) {
      output.warn(`Couldn’t write the capmac launchers: ${(err as Error).message}`);
      return;
    }
    collection.description = 'Adds the capmac command (CapMac’s CLI)';
    collection.append('PATH', `${path.delimiter}${bin}`);
  };
  await apply();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('capmac.terminal.capmacCommand') && void apply()));
}
