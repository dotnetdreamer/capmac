// Shared build settings for capmac Studio's main, preload and engine bundles.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentVersion } from '@capmac/core/scripts/agent-build';

export const desktopDir = fileURLToPath(new URL('..', import.meta.url));
export const repoDir = fileURLToPath(new URL('../../..', import.meta.url));
export const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __AGENT_VERSION__: JSON.stringify(agentVersion),
  __CAPMAC_VERSION__: JSON.stringify(pkg.version),
};

// ssh2's optional native add-ons are not shipped: it falls back to pure JS.
const external = ['electron', 'cpu-features', '*.node'];

// Main and the engine are CommonJS: bundled CommonJS packages (ssh2, …) expect
// require/__dirname, which ES module bundles do not have.
/** @param {{ production: boolean }} options */
export function bundles({ production }) {
  /** @type {import('esbuild').BuildOptions} */
  const common = {
    absWorkingDir: desktopDir,
    bundle: true,
    platform: 'node',
    target: 'node24',
    external,
    define,
    sourcemap: production ? false : 'linked',
    minify: production,
    legalComments: 'none',
    logLevel: 'warning',
    // core's agent lookup guards import.meta (unused in this CommonJS bundle).
    logOverride: { 'empty-import-meta': 'silent' },
  };
  return {
    main: { ...common, entryPoints: ['src/main/main.ts'], outfile: 'out/main/main.cjs', format: 'cjs' },
    preload: { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'out/preload/preload.cjs', format: 'cjs' },
    engine: { ...common, entryPoints: ['src/engine/host.ts'], outfile: 'out/engine/engine.cjs', format: 'cjs' },
  };
}
