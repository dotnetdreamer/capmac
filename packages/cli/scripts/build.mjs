// Builds the published capmac package:
//   dist/cli.js       the CLI; @capmac/core is bundled in, npm dependencies stay external
//   dist/agent.mjs    the Mac agent (shared build with capmac Studio)
//   dist/viewer.html  the browser screen viewer page
//   dist/takeover.cjs the NODE_OPTIONS preload behind `capmac takeover`
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildAgent } from '@capmac/core/scripts/agent-build';
import { cliOptions, pkg, preloadOptions } from './bundles.mjs';

const watch = process.argv.includes('--watch');
const out = (file) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));

const cli = cliOptions({ outfile: out('cli.js') });
const preload = preloadOptions({ outfile: out('takeover.cjs') });

mkdirSync(out(''), { recursive: true });
copyFileSync(new URL('../src/viewer/page.html', import.meta.url), out('viewer.html'));

if (watch) {
  await buildAgent(out('agent.mjs'), { watch: true });
  await Promise.all([context(cli), context(preload)].map(async (c) => (await c).watch()));
  console.log('capmac: watching for changes…');
} else {
  await Promise.all([buildAgent(out('agent.mjs')), build(cli), build(preload)]);
  console.log(`capmac ${pkg.version}: built dist/cli.js, dist/agent.mjs and dist/takeover.cjs`);
}
