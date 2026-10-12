// Production build of capmac Studio into apps/desktop/out:
//   main/ preload/ engine/   esbuild bundles (all JS dependencies inlined; no node_modules shipped)
//   renderer/                Vite build of the React UI
//   agent/agent.mjs          the Mac agent (identical to the CLI's)
//   sample/                  the "Run the sample app" project, with prebuilt web assets
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { buildAgent } from '@capmac/core/scripts/agent-build';
import { bundles, desktopDir, pkg, repoDir } from './config.mjs';

const out = (...parts) => path.join(desktopDir, 'out', ...parts);
const started = Date.now();

await fs.rm(out(), { recursive: true, force: true });
await Promise.all([
  buildAgent(out('agent', 'agent.mjs')),
  ...Object.values(bundles({ production: true })).map((options) => build(options)),
]);
await viteBuild({ configFile: path.join(desktopDir, 'vite.config.ts'), logLevel: 'warn' });

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

console.log(`capmac Studio ${pkg.version}: built out/ in ${((Date.now() - started) / 1000).toFixed(1)} s`);
