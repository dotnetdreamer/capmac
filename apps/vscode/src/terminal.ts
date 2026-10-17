/**
 * The `capmac` command in VS Code, with nothing installed: the extension ships
 * the CLI (the same version as its engine), writes small launchers for it
 * (core's launcherFiles, as CapMac Studio does) and adds their folder to the
 * end of PATH, in VS Code's terminals and in the extension host's own
 * environment. AI agents that other extensions start (the Claude Code and
 * Codex panels) inherit that one, not the terminals', and CapMac's skill tells
 * them to run `capmac`. A capmac installed with npm comes first on PATH, so it
 * still wins.
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { launcherFiles } from '@capmac/core/engine/capmac-command';
import { keyOf } from './state/pure.js';

export async function provideCapmacCommand(context: vscode.ExtensionContext, output: vscode.LogOutputChannel): Promise<void> {
  const collection = context.environmentVariableCollection;
  const bin = path.join(context.globalStorageUri.fsPath, 'bin');
  const apply = async () => {
    const wanted = vscode.workspace.getConfiguration('capmac').get<boolean>('terminal.capmacCommand', true);
    collection.clear();
    hostPath(bin, false);
    if (!wanted) return;
    const cli = context.asAbsolutePath(path.join('dist', 'cli', 'cli.mjs'));
    if (!existsSync(cli)) return;
    // On PATH before the launchers are written: an agent starting now keeps the PATH it starts with.
    hostPath(bin, true);
    try {
      await fs.mkdir(bin, { recursive: true });
      for (const [name, content] of Object.entries(launcherFiles(cli))) await fs.writeFile(path.join(bin, name), content, { mode: 0o755 });
    } catch (err) {
      hostPath(bin, false);
      output.warn(`Couldn’t write the capmac launchers: ${(err as Error).message}`);
      return;
    }
    collection.description = 'Adds the capmac command (CapMac’s CLI)';
    collection.append('PATH', `${path.delimiter}${bin}`);
  };
  await apply();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('capmac.terminal.capmacCommand') && void apply()));
}

/** The extension host's PATH, with `bin` at its end or without it (what processes other extensions start get). */
function hostPath(bin: string, on: boolean): void {
  const current = process.env.PATH ?? '';
  const parts = current ? current.split(path.delimiter).filter((p) => !p || keyOf(p) !== keyOf(bin)) : [];
  if (on) parts.push(bin);
  process.env.PATH = parts.join(path.delimiter);
}
