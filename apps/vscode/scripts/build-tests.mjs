// Bundles the integration tests for @vscode/test-cli: test/integration/*.test.ts → out/test/*.test.cjs.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const extensionDir = fileURLToPath(new URL('..', import.meta.url));
const dir = path.join(extensionDir, 'test', 'integration');
const entryPoints = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(dir, f));

await build({
  absWorkingDir: extensionDir,
  entryPoints,
  outdir: path.join(extensionDir, 'out', 'test'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // VS Code's API and mocha come from the test host; the extension itself is loaded by VS Code.
  external: ['vscode', 'mocha'],
  sourcemap: 'inline',
  logLevel: 'warning',
});
console.log(`Built ${entryPoints.length} integration test file(s) into out/test`);
