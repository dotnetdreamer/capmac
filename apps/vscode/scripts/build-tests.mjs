// Bundles the integration tests for @vscode/test-cli: test/<suite>/*.test.ts → out/test/<suite>/*.test.cjs,
// one suite per workspace .vscode-test.mjs opens.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const extensionDir = fileURLToPath(new URL('..', import.meta.url));
const suites = ['integration', 'workspace'];
const entryPoints = suites.flatMap((suite) => {
  const dir = path.join(extensionDir, 'test', suite);
  return readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(dir, f));
});

await build({
  absWorkingDir: extensionDir,
  entryPoints,
  outbase: path.join(extensionDir, 'test'),
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
