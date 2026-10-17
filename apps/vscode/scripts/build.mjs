// Build of the CapMac VS Code extension into apps/vscode/dist:
//   extension.cjs      the extension (VS Code's extension host)
//   engine.cjs         CapMac Studio's engine host behind a Node.js parent port (its own process)
//   agent/agent.mjs    the Mac agent (byte-identical to the CLI's and Studio's: one upload on the Mac)
//   webview/           the live screen page, its decoder worker (CapMac Studio's) and VS Code's icon font
//   cli/               the capmac CLI, for the `capmac` command in VS Code's terminals
//   samples/           the sample projects ("Try a sample")
//   remote/            node-datachannel for remote access (with --remote): the engine and the CLI load
//                      remote/node_modules; it picks its native binary (x64, arm64) by architecture
//
//   node scripts/build.mjs [--watch] [--production] [--remote [--target win32-x64|win32-arm64]]
//   (--target keeps one architecture's binary, for that platform's .vsix: vsce package --target …)
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, context } from 'esbuild';
import { agentVersion, buildAgent } from '@capmac/core/scripts/agent-build';

const extensionDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = path.resolve(extensionDir, '..', '..');
const pkg = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
const core = JSON.parse(readFileSync(path.join(repoDir, 'packages', 'core', 'package.json'), 'utf8'));

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const production = args.has('--production');
const dist = (...parts) => path.join(extensionDir, 'dist', ...parts);
const started = Date.now();

/**
 * The modes `sessions.start` takes, from CapMac Studio's contract: the
 * extension offers Sync only with an engine that has it (feature/run-options-
 * console), without bundling zod to look at the schema at run time.
 */
const contract = readFileSync(path.join(repoDir, 'apps', 'desktop', 'src', 'shared', 'contract.ts'), 'utf8');

/** The values of a `z.enum([...])` named `field` in an engine method's params, from the contract's text. */
function contractEnum(method, field, fallback) {
  const start = contract.indexOf(`'${method}'`);
  const found = start >= 0 ? contract.slice(start, start + 1500).match(new RegExp(`${field}:\\s*z\\.enum\\(\\[([^\\]]*)\\]\\)`)) : null;
  return found ? [...found[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]) : fallback;
}

// The same build-time values CapMac Studio's engine is built with (apps/desktop/scripts/config.mjs).
const define = {
  __CAPMAC_SESSION_MODES__: JSON.stringify(contractEnum('sessions.start', 'mode', ['run', 'live'])),
  // The samples the engine can copy (a React Native one arrives with feature/react-native).
  __CAPMAC_SAMPLE_KINDS__: JSON.stringify(contractEnum('projects.createSample', 'kind', ['ios', 'electron'])),
  // React Native DevTools for a live session (feature/react-native's `sessions.devtools`).
  __CAPMAC_HAS_DEVTOOLS__: JSON.stringify(/^\s*'sessions\.devtools':/m.test(contract)),
  __APP_VERSION__: JSON.stringify(pkg.version),
  __AGENT_VERSION__: JSON.stringify(agentVersion),
  __CAPMAC_VERSION__: JSON.stringify(core.version),
  __RELEASE_NOTES_URL__: JSON.stringify(process.env.CAPMAC_RELEASE_NOTES_URL ?? ''),
  __CAPMAC_SIGNAL_URL__: JSON.stringify(process.env.CAPMAC_DEFAULT_SIGNAL_URL ?? ''),
};

/** @type {import('esbuild').BuildOptions} */
const node = {
  absWorkingDir: extensionDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // VS Code 1.95+ runs Node.js 20 or newer.
  target: 'node20',
  // The WSL backend and Flutter ship scripts and sources as text.
  loader: { '.rb': 'text', '.sh': 'text', '.py': 'text', '.c': 'text' },
  define,
  sourcemap: production ? false : 'linked',
  minify: production,
  legalComments: 'none',
  logLevel: 'warning',
  // core's agent lookup guards import.meta (unused in a CommonJS bundle).
  logOverride: { 'empty-import-meta': 'silent' },
};

/** @type {Record<string, import('esbuild').BuildOptions>} */
const bundles = {
  // The extension reads CapMac's config but never makes SSH keys (config.ts loads ssh2 only for that): ssh2 stays in the engine.
  extension: { ...node, entryPoints: ['src/extension.ts'], outfile: dist('extension.cjs'), external: ['vscode', 'ssh2', 'cpu-features', '*.node'] },
  // ssh2's optional native add-ons are not shipped (it falls back to pure JS);
  // node-datachannel is native and comes from dist/remote (or node_modules in development).
  engine: { ...node, entryPoints: ['src/engine/main.ts'], outfile: dist('engine.cjs'), external: ['electron', 'cpu-features', '*.node', 'node-datachannel'] },
  webview: {
    absWorkingDir: extensionDir,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    entryPoints: { screen: 'src/webview/screen/main.ts' },
    outdir: dist('webview'),
    loader: { '.svg': 'text' },
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
    sourcemap: production ? false : 'inline',
    minify: production,
    legalComments: 'none',
    logLevel: 'warning',
  },
  // The screen's decoder runs in a worker (H.264 and JPEG off the page's thread).
  worker: {
    absWorkingDir: extensionDir,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    entryPoints: { 'screen-worker': 'src/webview/screen/worker.ts' },
    outdir: dist('webview'),
    sourcemap: production ? false : 'inline',
    minify: production,
    legalComments: 'none',
    logLevel: 'warning',
  },
};

async function copySamples() {
  const SKIP = new Set(['node_modules', '.git', 'build', 'DerivedData', 'Pods', 'xcuserdata', '.capmac']);
  const ios = path.join(repoDir, 'examples', 'hello-capacitor');
  await fs.rm(dist('samples'), { recursive: true, force: true });
  // The Capacitor sample carries its built web assets when the repo has them (Run then needs no npm install).
  await fs.cp(ios, dist('samples', 'hello-capacitor'), {
    recursive: true,
    filter: (src) => !SKIP.has(path.basename(src)) && !/[\\/]App[\\/]App[\\/](public|capacitor\.config\.json|config\.xml)$/.test(src),
  });
  await fs.cp(path.join(repoDir, 'examples', 'hello-electron'), dist('samples', 'hello-electron'), {
    recursive: true,
    filter: (src) => !['node_modules', '.git', 'out', 'dist', '.capmac'].includes(path.basename(src)),
  });
  const flutter = path.join(repoDir, 'examples', 'hello-flutter');
  if (existsSync(flutter)) {
    // Source only: what Flutter makes on each machine holds that machine's paths.
    const FLUTTER_SKIP = new Set(['build', '.dart_tool', '.git', '.capmac', '.idea', 'ephemeral', 'Pods', '.symlinks', '.flutter-plugins', '.flutter-plugins-dependencies', 'xcuserdata', 'Generated.xcconfig', 'flutter_export_environment.sh', 'GeneratedPluginRegistrant.h', 'GeneratedPluginRegistrant.m']);
    await fs.cp(flutter, dist('samples', 'hello-flutter'), { recursive: true, filter: (src) => !FLUTTER_SKIP.has(path.basename(src)) && !src.endsWith('.iml') });
  }
  const reactNative = path.join(repoDir, 'examples', 'hello-react-native');
  if (existsSync(reactNative)) {
    // Source only, as CapMac Studio ships it: its packages install where it runs; CocoaPods and MSBuild make the rest.
    const REACT_NATIVE_SKIP = new Set(['node_modules', '.git', '.capmac', 'Pods', 'build', 'DerivedData', 'xcuserdata', '.xcode.env.local', 'vendor', '.bundle', 'x64', 'ARM64', 'AppPackages', 'BundleArtifacts', 'Generated Files', 'packages', 'obj', '.vs']);
    await fs.cp(reactNative, dist('samples', 'hello-react-native'), { recursive: true, filter: (src) => !REACT_NATIVE_SKIP.has(path.basename(src)) && !/(^msbuild_\d+_build\.(binlog|err|wrn)|\.user)$/.test(path.basename(src)) });
  }
}

/** VS Code's icon font, for the webview's buttons. */
async function copyCodicons() {
  const from = path.dirname(createRequire(import.meta.url).resolve('@vscode/codicons/package.json'));
  await fs.mkdir(dist('webview', 'codicons'), { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) await fs.copyFile(path.join(from, 'dist', file), dist('webview', 'codicons', file));
}

if (!watch) await fs.rm(dist(), { recursive: true, force: true });
await fs.mkdir(dist(), { recursive: true });
await Promise.all([buildAgent(dist('agent', 'agent.mjs')), copySamples(), copyCodicons()]);

// The CLI the terminal's `capmac` runs: the same build CapMac Studio ships for takeover.
const { buildStandaloneCli } = await import(pathToFileURL(path.join(repoDir, 'packages', 'cli', 'scripts', 'bundles.mjs')).href);
await buildStandaloneCli(dist('cli'), { agent: dist('agent', 'agent.mjs'), version: pkg.version });

if (args.has('--remote')) {
  // CapMac Studio's staging (one folder per architecture, for its per-architecture installers), made one
  // folder with both binaries: node-datachannel requires @node-datachannel/win32-<arch>-msvc for the running one.
  const { stageRemoteModules } = await import(pathToFileURL(path.join(repoDir, 'apps', 'desktop', 'scripts', 'remote-modules.mjs')).href);
  const staging = dist('.remote');
  await stageRemoteModules(repoDir, staging);
  const target = process.argv.find((a, i) => process.argv[i - 1] === '--target');
  const arches = target ? [target.replace(/^win32-/, '')] : ['x64', 'arm64'];
  if (!arches.every((arch) => existsSync(path.join(staging, arch)))) throw new Error(`No remote modules for --target ${target} (win32-x64 or win32-arm64)`);
  const modules = dist('remote', 'node_modules');
  for (const arch of arches) await fs.cp(path.join(staging, arch, 'node_modules'), modules, { recursive: true, force: true });
  await fs.rm(staging, { recursive: true, force: true });
}

if (watch) {
  const contexts = await Promise.all(Object.values(bundles).map((options) => context(options)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('CapMac for VS Code: watching for changes…');
} else {
  await Promise.all(Object.values(bundles).map((options) => build(options)));
  console.log(`CapMac for VS Code ${pkg.version}: built dist/ in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
