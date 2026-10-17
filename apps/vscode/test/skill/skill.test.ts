/**
 * CapMac's skill for AI agents, added by itself on a first install
 * (.vscode-test.mjs, the "skill" run): two Capacitor apps, each its own git
 * repository, cafe with a different skill named capmac in it, and a home
 * folder where only Claude Code is set up. GitHub Copilot is in every VS Code.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { CapmacApi } from '../../src/extension.js';

const ID = 'capmac.capmac-vscode';

async function until<T>(check: () => T | undefined | null | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('CapMac’s skill for AI agents', function () {
  this.timeout(90_000);
  let api: CapmacApi;
  const folder = (name: string) => vscode.workspace.workspaceFolders!.find((f) => f.name === name)!.uri.fsPath;
  /** The skill file an agent reads in a project: `.claude` (Claude Code) or `.agents` (the shared folder). */
  const skill = (project: string, agents: '.claude' | '.agents') => path.join(folder(project), agents, 'skills', 'capmac', 'SKILL.md');

  before(async () => {
    const extension = vscode.extensions.getExtension<CapmacApi>(ID);
    assert.ok(extension, 'the extension is installed');
    api = await extension.activate();
    await until(() => api.model.engine.state === 'ready');
  });

  it('adds it to each app’s project, for Claude Code and for the agents of the shared folder', async () => {
    await until(() => existsSync(skill('shop', '.claude')) && existsSync(skill('shop', '.agents')));
    const text = readFileSync(skill('shop', '.claude'), 'utf8');
    assert.match(text, /^---\nname: capmac\n/);
    assert.match(text, /capmac-skill-version: \d+\.\d+\.\d+/);
  });

  it('leaves a different skill named capmac as it is (it asks first)', async () => {
    await until(() => existsSync(skill('cafe', '.agents')));
    assert.match(readFileSync(skill('cafe', '.claude'), 'utf8'), /Our own notes/);
  });

  it('adds it once: a copy that was removed stays removed', async () => {
    rmSync(path.dirname(skill('shop', '.agents')), { recursive: true });
    // Looked at again from the start, as in a new window.
    const config = vscode.workspace.getConfiguration('capmac');
    await config.update('agents.addSkill', 'off', vscode.ConfigurationTarget.Global);
    await config.update('agents.addSkill', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('capmac.refresh');
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(existsSync(skill('shop', '.agents')), false);
    assert.equal(existsSync(skill('shop', '.claude')), true);
  });

  it('lets agents that other extensions start run the capmac command', () => {
    // A process started from the extension host, with its environment, as the Claude Code and Codex panels start theirs.
    const out =
      process.platform === 'win32'
        ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'capmac --version'], { env: process.env, encoding: 'utf8', timeout: 30_000 })
        : execFileSync('/bin/sh', ['-c', 'capmac --version'], { env: process.env, encoding: 'utf8', timeout: 30_000 });
    assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
  });
});
