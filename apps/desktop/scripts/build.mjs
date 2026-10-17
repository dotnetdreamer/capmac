// Production build of capmac Studio into apps/desktop/out:
//   main/ preload/ engine/   esbuild bundles (all JS dependencies inlined; no node_modules shipped)
//   renderer/                Vite build of the React UI
//   agent/agent.mjs          the Mac agent (identical to the CLI's)
//   cli/                     a standalone capmac CLI for takeover (`npx cap run ios` in a terminal)
//   remote/<arch>/           node-datachannel, WebRTC for remote access (native, so outside app.asar)
//   sample/                  the "Run the sample app" project, with prebuilt web assets
//   sample-electron/         the Electron sample ("Try the Electron sample")
//   sample-flutter/          the Flutter sample: its iOS, Mac and Windows apps
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { buildAgent } from '@capmac/core/scripts/agent-build';
import { bundles, desktopDir, pkg, repoDir } from './config.mjs';
import { stageRemoteModules } from './remote-modules.mjs';

const out = (...parts) => path.join(desktopDir, 'out', ...parts);
const started = Date.now();

await fs.rm(out(), { recursive: true, force: true });
await Promise.all([
  buildAgent(out('agent', 'agent.mjs')),
  ...Object.values(bundles({ production: true })).map((options) => build(options)),
]);
await viteBuild({ configFile: path.join(desktopDir, 'vite.config.ts'), logLevel: 'warn' });

// The terminal's Node.js runs this copy of the CLI, so it is shipped outside app.asar.
const { buildStandaloneCli } = await import(pathToFileURL(path.join(repoDir, 'packages', 'cli', 'scripts', 'bundles.mjs')).href);
await buildStandaloneCli(out('cli'), { agent: out('agent', 'agent.mjs'), version: pkg.version });

// Remote access's WebRTC module, for the engine and that CLI: one copy per architecture.
await stageRemoteModules(repoDir, out('remote'));

// The sample app ships without node_modules, so it carries its built web assets.
const sampleSrc = path.join(repoDir, 'examples', 'hello-capacitor');
if (!existsSync(path.join(sampleSrc, 'dist', 'index.html'))) {
  if (!existsSync(path.join(sampleSrc, 'node_modules'))) {
    spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: sampleSrc, stdio: 'inherit', shell: true });
  }
  const r = spawnSync('npm', ['run', 'build'], { cwd: sampleSrc, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error('Building the sample app failed.');
}
const SKIP = new Set(['node_modules', '.git', 'build', 'DerivedData', 'Pods', 'xcuserdata', '.capmac']);
await fs.cp(sampleSrc, out('sample'), {
  recursive: true,
  filter: (src) => !SKIP.has(path.basename(src)) && !/[\\/]App[\\/]App[\\/](public|capacitor\.config\.json|config\.xml)$/.test(src),
});

// The Electron sample: plain Electron, nothing to build (the Mac installs Electron for itself).
const electronSampleSrc = path.join(repoDir, 'examples', 'hello-electron');
await fs.cp(electronSampleSrc, out('sample-electron'), { recursive: true, filter: (src) => !['node_modules', '.git', 'out', 'dist', '.capmac'].includes(path.basename(src)) });

// The Flutter sample: source only (Flutter builds it where it runs).
// (What Flutter makes on each machine stays out: it holds that machine's paths.)
const FLUTTER_SKIP = new Set(['build', '.dart_tool', '.git', '.capmac', '.idea', 'ephemeral', 'Pods', '.symlinks', '.flutter-plugins', '.flutter-plugins-dependencies', 'xcuserdata', 'Generated.xcconfig', 'flutter_export_environment.sh', 'GeneratedPluginRegistrant.h', 'GeneratedPluginRegistrant.m']);
await fs.cp(path.join(repoDir, 'examples', 'hello-flutter'), out('sample-flutter'), { recursive: true, filter: (src) => !FLUTTER_SKIP.has(path.basename(src)) && !src.endsWith('.iml') });

console.log(`CapMac Studio ${pkg.version}: built out/ in ${((Date.now() - started) / 1000).toFixed(1)} s`);
