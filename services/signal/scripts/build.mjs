// Builds dist/capmac-signal.mjs: the whole server in one file (ws included),
// for any Node.js 22+. Copy it to your server, or build the Docker image
// (deploy/Dockerfile).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  absWorkingDir: dir,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/capmac-signal.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ws's optional native speed-ups; it works without them.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __capmacRequire } from 'node:module';\nconst require = __capmacRequire(import.meta.url);" },
  define: { __CAPMAC_SIGNAL_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`capmac-signal ${pkg.version}: built dist/capmac-signal.mjs`);
