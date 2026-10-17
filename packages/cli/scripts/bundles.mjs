// esbuild settings for the capmac CLI, shared by its own build (build.mjs) and
// capmac Studio's, which ships a standalone copy for takeover.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cliDir = fileURLToPath(new URL('..', import.meta.url));
export const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * The CLI. For npm, runtime dependencies stay external (installed with the
 * package); standalone, everything is bundled in except ssh2's optional native
 * add-ons (it falls back to pure JS).
 * @param {{ outfile: string, standalone?: boolean, version?: string }} options
 * @returns {import('esbuild').BuildOptions}
 */
export function cliOptions({ outfile, standalone = false, version = pkg.version }) {
  return {
    absWorkingDir: cliDir,
    entryPoints: ['src/main.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    loader: { '.rb': 'text' },
    // node-datachannel is native: npm installs it with the CLI; CapMac Studio ships it next to its copy.
    external: standalone ? ['cpu-features', '*.node', 'node-datachannel'] : [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})],
    // Bundled CommonJS dependencies (ssh2, …) call require and read __dirname.
    banner: standalone
      ? {
          js: [
            "import { createRequire as __capmacRequire } from 'node:module';",
            "import { fileURLToPath as __capmacPath } from 'node:url';",
            'const require = __capmacRequire(import.meta.url);',
            'const __filename = __capmacPath(import.meta.url);',
            "const __dirname = __capmacPath(new URL('.', import.meta.url));",
          ].join('\n'),
        }
      : undefined,
    define: {
      __CAPMAC_VERSION__: JSON.stringify(version),
      __CAPMAC_IN_STUDIO__: JSON.stringify(standalone),
      // The signaling server for remote access a release is built with (people can set their own).
      __CAPMAC_SIGNAL_URL__: JSON.stringify(process.env.CAPMAC_DEFAULT_SIGNAL_URL ?? ''),
    },
    sourcemap: !standalone,
    minify: standalone,
    legalComments: 'none',
    logLevel: 'warning',
  };
}

/**
 * The takeover preload. It runs inside every Node.js process once takeover is
 * on, including old Node versions in other projects: CommonJS, no
 * dependencies, conservative syntax.
 * @param {{ outfile: string }} options
 * @returns {import('esbuild').BuildOptions}
 */
export function preloadOptions({ outfile }) {
  return {
    absWorkingDir: cliDir,
    entryPoints: ['src/takeover/preload.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node12',
    logLevel: 'warning',
  };
}

/**
 * A self-contained capmac CLI in `outDir` (cli.mjs, agent.mjs, viewer.html,
 * takeover.cjs) that any Node.js 20+ can run with no node_modules: the one capmac
 * Studio ships.
 * @param {string} outDir
 * @param {{ agent: string, version?: string }} options  agent: the built agent.mjs to copy in
 */
export async function buildStandaloneCli(outDir, { agent, version }) {
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    build(cliOptions({ outfile: path.join(outDir, 'cli.mjs'), standalone: true, version })),
    build(preloadOptions({ outfile: path.join(outDir, 'takeover.cjs') })),
    copyFile(agent, path.join(outDir, 'agent.mjs')),
    copyFile(path.join(cliDir, 'src', 'viewer', 'page.html'), path.join(outDir, 'viewer.html')),
  ]);
}
