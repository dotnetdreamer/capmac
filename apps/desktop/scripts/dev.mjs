// npm run desktop:dev — Vite (renderer, with HMR) + esbuild watch (main,
// preload, engine, agent) + Electron, restarted when main-side code changes.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { context } from 'esbuild';
import { createServer } from 'vite';
import electronPath from 'electron';
import { buildAgent } from '@capmac/core/scripts/agent-build';
import { bundles, desktopDir } from './config.mjs';

const log = (msg) => console.log(`\x1b[2m[desktop:dev]\x1b[0m ${msg}`);

// An ephemeral port: never collide with the developer's own dev servers.
const vite = await createServer({ configFile: path.join(desktopDir, 'vite.config.ts'), server: { port: 0, strictPort: false } });
await vite.listen();
const rendererUrl = vite.resolvedUrls.local[0];
log(`renderer on ${rendererUrl}`);

await buildAgent(path.join(desktopDir, 'out', 'agent', 'agent.mjs'), { watch: true });

let electron = null;
let restartTimer = null;
let restarting = false;
let shuttingDown = false;

function startElectron() {
  const env = { ...process.env, ELECTRON_RENDERER_URL: rendererUrl, CAPMAC_STUDIO_DEV: '1' };
  // Set when running inside another Electron app (e.g. VS Code); it would make Electron act as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  // A loopback debugging port lets tools (Playwright connectOverCDP) drive the dev app.
  const debugPort = process.env.CAPMAC_DEV_DEBUG_PORT ?? '39217';
  electron = spawn(electronPath, ['.', `--remote-debugging-port=${debugPort}`, ...process.argv.slice(2)], { cwd: desktopDir, env, stdio: 'inherit' });
  electron.on('exit', (code) => {
    electron = null;
    if (restarting || shuttingDown) return;
    log(`Electron exited (${code ?? 'signal'})`);
    void shutdown(code ?? 0);
  });
}

/** Stops Electron and everything it started (engine, dev servers of live sessions). */
function killElectron() {
  if (!electron?.pid) return Promise.resolve();
  const child = electron;
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  });
}

function scheduleRestart(reason) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    log(`${reason} changed, restarting Electron`);
    restarting = true;
    await killElectron();
    // Give Windows a moment to release the single-instance lock.
    await new Promise((resolve) => setTimeout(resolve, 400));
    restarting = false;
    startElectron();
  }, 150);
}

const contexts = [];
const firstBuilds = [];
for (const [name, options] of Object.entries(bundles({ production: false }))) {
  let initial = true;
  let markBuilt;
  firstBuilds.push(new Promise((resolve) => (markBuilt = resolve)));
  const ctx = await context({
    ...options,
    plugins: [{
      name: 'restart-electron',
      setup(build) {
        build.onEnd((result) => {
          // watch() starts with a full build of its own: that one just launches Electron.
          if (initial) {
            initial = false;
            markBuilt();
            return;
          }
          if (result.errors.length === 0) scheduleRestart(name);
        });
      },
    }],
  });
  await ctx.watch();
  contexts.push(ctx);
}
await Promise.all(firstBuilds);

startElectron();

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await killElectron();
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  await vite.close();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
