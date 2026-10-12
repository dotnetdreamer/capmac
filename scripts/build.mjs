// Bundles the CLI (dist/cli.js, dependencies stay external) and the Mac agent
// (dist/agent.mjs, a single self-contained file that only needs Node.js).
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const watch = process.argv.includes('--watch');
const define = { __CAPMAC_VERSION__: JSON.stringify(pkg.version) };

const configs = [
  {
    entryPoints: ['src/agent/main.ts'],
    outfile: 'dist/agent.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    define,
    legalComments: 'none',
    banner: { js: '// capmac agent — uploaded to the Mac by the capmac CLI. Safe to delete; it is re-uploaded on demand.' },
  },
  {
    entryPoints: ['src/cli/main.ts'],
    outfile: 'dist/cli.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    define,
    sourcemap: true,
  },
];

mkdirSync('dist', { recursive: true });
copyFileSync('src/cli/viewer/page.html', 'dist/viewer.html');

if (watch) {
  for (const config of configs) {
    const ctx = await context(config);
    await ctx.watch();
  }
  console.log('capmac: watching for changes…');
} else {
  await Promise.all(configs.map((config) => build(config)));
  console.log(`capmac ${pkg.version}: built dist/cli.js and dist/agent.mjs`);
}
