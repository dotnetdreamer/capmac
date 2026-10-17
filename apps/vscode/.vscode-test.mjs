// Integration tests in a real VS Code (`npm run test:integration`): the extension
// in development, the Capacitor sample as the workspace, an empty CapMac config.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  label: 'integration',
  files: 'out/test/**/*.test.cjs',
  version: 'stable',
  workspaceFolder: path.join(here, '..', '..', 'examples', 'hello-capacitor'),
  // A profile of its own, no other extensions, no trust prompt.
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--user-data-dir', mkdtempSync(path.join(os.tmpdir(), 'capmac-vscode-ud-')), '--skip-welcome', '--skip-release-notes'],
  env: { CAPMAC_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'capmac-vscode-config-')) },
  mocha: { ui: 'bdd', timeout: 90_000 },
});
