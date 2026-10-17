// Integration tests in a real VS Code (`npm run test:integration`): the extension
// in development, an empty CapMac config, and three workspaces: the Capacitor
// sample, several folders (a Capacitor app, a Flutter app, a folder with no app),
// then two apps of their own that get CapMac's skill for AI agents by themselves.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A profile of its own, no other extensions, no trust prompt. CapMac adds its
 * skill by itself only where the run says (the samples are in this repository:
 * it would go at its root).
 */
const run = (label, workspaceFolder, { settings = { 'capmac.agents.addSkill': 'off' }, env = {} } = {}) => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'capmac-vscode-ud-'));
  mkdirSync(path.join(userData, 'User'));
  writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(settings));
  return {
    label,
    files: `out/test/${label}/**/*.test.cjs`,
    version: 'stable',
    workspaceFolder,
    launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--user-data-dir', userData, '--skip-welcome', '--skip-release-notes'],
    env: { CAPMAC_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'capmac-vscode-config-')), ...env },
    mocha: { ui: 'bdd', timeout: 90_000 },
  };
};

/**
 * What a first install meets: two Capacitor apps, each its own git repository
 * (cafe already has a different skill named capmac for Claude Code), and a
 * home folder where only Claude Code is set up.
 */
function skillFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-vscode-skill-'));
  const home = path.join(dir, 'home');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const sample = path.join(here, '..', '..', 'examples', 'hello-capacitor');
  for (const name of ['shop', 'cafe']) {
    cpSync(sample, path.join(dir, name), { recursive: true, filter: (src) => !/[\\/](node_modules|electron|dist|\.capmac|Pods|build|DerivedData|xcuserdata)$/.test(src) });
    mkdirSync(path.join(dir, name, '.git'));
  }
  const theirs = path.join(dir, 'cafe', '.claude', 'skills', 'capmac');
  mkdirSync(theirs, { recursive: true });
  writeFileSync(path.join(theirs, 'SKILL.md'), '---\nname: capmac\ndescription: The cafe team’s own notes\n---\nOur own notes\n');
  const workspace = path.join(dir, 'apps.code-workspace');
  writeFileSync(workspace, JSON.stringify({ folders: [{ path: 'shop' }, { path: 'cafe' }] }));
  const env = { USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  for (const [name, folder] of [['CODEX_HOME', '.codex'], ['COPILOT_HOME', '.copilot'], ['XDG_CONFIG_HOME', '.config']]) env[name] = path.join(home, folder);
  return { workspace, env };
}

const skill = skillFixture();

export default defineConfig([
  run('integration', path.join(here, '..', '..', 'examples', 'hello-capacitor')),
  run('workspace', path.join(here, 'test', 'workspace', 'fixture', 'several-folders.code-workspace')),
  run('skill', skill.workspace, { settings: {}, env: skill.env }),
]);
