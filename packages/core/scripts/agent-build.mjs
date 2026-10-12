// Builds the Mac agent (agent.mjs): one self-contained, dependency-free file
// that the CLI and capmac Studio upload to ~/.capmac/agent/<hash>/ on the Mac.
// Both front ends call this, so they ship byte-identical agents and share one
// upload on the Mac.
import { build, context } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const coreDir = fileURLToPath(new URL('..', import.meta.url));
const core = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The core version, which the agent reports as its own. */
export const agentVersion = core.version;

/** esbuild options for agent.mjs written to `outfile`. */
export function agentBuildOptions(outfile) {
  return {
    absWorkingDir: coreDir,
    entryPoints: ['src/agent/main.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    define: { __CAPMAC_VERSION__: JSON.stringify(core.version) },
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: '// capmac agent — uploaded to the Mac by capmac. Safe to delete; it is re-uploaded on demand.' },
  };
}

/** Builds agent.mjs once, or keeps rebuilding it when `watch` is set. */
export async function buildAgent(outfile, { watch = false } = {}) {
  const options = agentBuildOptions(outfile);
  if (!watch) return build(options);
  const ctx = await context(options);
  await ctx.watch();
  return ctx;
}
