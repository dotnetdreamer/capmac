/** Opens a file at a line in the developer's editor. */
import { pathToFileURL } from 'node:url';
import { app, shell } from 'electron';
import type { Settings } from '../shared/contract.js';

/**
 * VS Code and Cursor register vscode:// and cursor:// URL handlers on
 * Windows; using them avoids spawning `code.cmd` through a shell (and its
 * quoting pitfalls). Falls back to the file's default app.
 */
export async function openInEditor(editor: Settings['editor'], file: string, line?: number, column?: number): Promise<void> {
  const scheme = editor === 'vscode' ? 'vscode' : editor === 'cursor' ? 'cursor' : null;
  if (scheme && app.getApplicationNameForProtocol(`${scheme}://`)) {
    // vscode://file/C:/path/to/file.swift:12:9
    const target = pathToFileURL(file).pathname.replace(/^\//, '');
    const position = line ? `:${line}${column ? `:${column}` : ''}` : '';
    await shell.openExternal(`${scheme}://file/${target}${position}`);
    return;
  }
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
}

/** Which editors are installed (for the Settings page). */
export function installedEditors(): Array<Settings['editor']> {
  const found: Array<Settings['editor']> = [];
  if (app.getApplicationNameForProtocol('vscode://')) found.push('vscode');
  if (app.getApplicationNameForProtocol('cursor://')) found.push('cursor');
  found.push('system');
  return found;
}
