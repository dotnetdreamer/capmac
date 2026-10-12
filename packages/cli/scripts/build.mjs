// Builds the published capmac package:
//   dist/cli.js      the CLI; @capmac/core is bundled in, npm dependencies stay external
//   dist/agent.mjs   the Mac agent (shared build with capmac Studio)
//   dist/viewer.html the browser screen viewer page
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildAgent } from '@capmac/core/scripts/agent-build';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const watch = process.argv.includes('--watch');
const out = (file) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));

/** @type {import('esbuild').BuildOptions} */
const cli = {
  absWorkingDir: cliDir,
  entryPoints: ['src/main.ts'],
  outfile: out('cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Runtime dependencies are installed with the package; only our own code is bundled.
  external: Object.keys(pkg.dependencies ?? {}),
  define: { __CAPMAC_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: true,
  logLevel: 'warning',
};

mkdirSync(out(''), { recursive: true });
copyFileSync(new URL('../src/viewer/page.html', import.meta.url), out('viewer.html'));

if (watch) {
  await buildAgent(out('agent.mjs'), { watch: true });
  const ctx = await context(cli);
  await ctx.watch();
  console.log('capmac: watching for changes…');
} else {
  await Promise.all([buildAgent(out('agent.mjs')), build(cli)]);
  console.log(`capmac ${pkg.version}: built dist/cli.js and dist/agent.mjs`);
}
