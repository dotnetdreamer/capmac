// Builds the Mac agent (agent.mjs): one self-contained, dependency-free file
// that the CLI and capmac Studio upload to ~/.capmac/agent/<hash>/ on the Mac.
// Both front ends call this, so they ship byte-identical agents and share one
// upload on the Mac.
import { build, context } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = fileURLToPath(new URL('..', import.meta.url));
const core = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The core version, which the agent reports as its own. */
export const agentVersion = core.version;

/**
 * esbuild options for the door (remote access's service on the Mac). It runs
 * with the Mac's Node.js 22+ and loads node-datachannel from its own runtime
 * folder, so that stays out of the bundle.
 */
export function doorBuildOptions() {
  return {
    absWorkingDir: coreDir,
    entryPoints: ['src/door/main.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    metafile: true,
    external: ['node-datachannel'],
    define: { __CAPMAC_VERSION__: JSON.stringify(core.version) },
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: '// CapMac door: remote access for this Mac (LaunchAgent dev.capmac.remote). Turn it off in CapMac.' },
  };
}

/** Builds the door and returns its code (one ES module). */
export async function buildDoor() {
  const result = await build(doorBuildOptions());
  return { code: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs).map((file) => path.join(coreDir, file)) };
}

/** Puts the bundled door into the agent, in place of src/agent/door-source.ts (rebuilt when its sources change). */
const doorPlugin = {
  name: 'capmac-door',
  setup(b) {
    b.onLoad({ filter: /[\\/]agent[\\/]door-source\.ts$/ }, async () => {
      const door = await buildDoor();
      return { contents: `export const DOOR_SOURCE = ${JSON.stringify(door.code)};`, loader: 'js', watchFiles: door.inputs };
    });
  },
};

/**
 * esbuild options for CapMac's module inside Electron apps. The agent preloads
 * it into every Node.js process an Electron launch starts (npm, dev servers,
 * Electron), so it is CommonJS with nothing to install.
 */
export function electronHookBuildOptions() {
  return {
    absWorkingDir: coreDir,
    entryPoints: ['src/electron-hook/hook.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    metafile: true,
    // Electron's own module, inside the app (never the npm package of the same name).
    external: ['electron'],
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: "// CapMac's module for Electron apps on this Mac: loaded only when CapMac launches an app. Safe to delete." },
  };
}

/** Builds the module and returns its code. */
export async function buildElectronHook() {
  const result = await build(electronHookBuildOptions());
  return { code: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs).map((file) => path.join(coreDir, file)) };
}

/** Puts the bundled module into the agent, in place of src/agent/electron-hook-source.ts. */
const electronHookPlugin = {
  name: 'capmac-electron-hook',
  setup(b) {
    b.onLoad({ filter: /[\\/]agent[\\/]electron-hook-source\.ts$/ }, async () => {
      const hook = await buildElectronHook();
      return { contents: `export const ELECTRON_HOOK_SOURCE = ${JSON.stringify(hook.code)};`, loader: 'js', watchFiles: hook.inputs };
    });
  },
};

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
    // The H.264 helper's Objective-C source ships inside the agent; it is compiled on the Mac.
    loader: { '.m': 'text' },
    plugins: [doorPlugin, electronHookPlugin],
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: '// CapMac agent — uploaded to the Mac by CapMac. Safe to delete; it is re-uploaded on demand.' },
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
