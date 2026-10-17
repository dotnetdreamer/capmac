// Integration tests in a real VS Code (`npm run test:integration`): the extension
// in development, an empty CapMac config, and two workspaces: the Capacitor
// sample, then several folders (a Capacitor app, a Flutter app, a folder with no app).
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A profile of its own, no other extensions, no trust prompt. */
const run = (label, workspaceFolder) => ({
  label,
  files: `out/test/${label}/**/*.test.cjs`,
  version: 'stable',
  workspaceFolder,
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--user-data-dir', mkdtempSync(path.join(os.tmpdir(), 'capmac-vscode-ud-')), '--skip-welcome', '--skip-release-notes'],
  env: { CAPMAC_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'capmac-vscode-config-')) },
  mocha: { ui: 'bdd', timeout: 90_000 },
});

export default defineConfig([
  run('integration', path.join(here, '..', '..', 'examples', 'hello-capacitor')),
  run('workspace', path.join(here, 'test', 'workspace', 'fixture', 'several-folders.code-workspace')),
]);
