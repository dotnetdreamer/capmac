// capmac takeover, built to dist/takeover.cjs and loaded into every Node.js
// process through NODE_OPTIONS once `capmac takeover on` has run.
//
// It does nothing unless the process is the Capacitor CLI running `run ios`,
// `open ios` or `build ios` on a PC that is not a Mac. Then it runs that command
// with capmac on the paired Mac and exits with capmac's status, so
// `npx cap run ios` and `ionic cap run ios -l` keep working as typed.
// On any problem it gets out of the way and Capacitor runs as usual.
import { STATE_FILE, takeoverArgs, type TakeoverState } from './intercept.js';

function warn(message: string): void {
  process.stderr.write(`[capmac] ${message}\n`);
}

function main(): void {
  const args = takeoverArgs(process.argv, process.platform, process.env);
  if (!args) return;
  // Built-ins are loaded only from here on, inside the try below: this file
  // runs in every Node.js process, whatever its version.
  if (!(require('worker_threads') as typeof import('worker_threads')).isMainThread) return;
  const { existsSync, readFileSync } = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const { spawnSync } = require('child_process') as typeof import('child_process');

  const dir = process.env.CAPMAC_CONFIG_DIR || path.join(os.homedir(), '.capmac');
  let state: TakeoverState;
  try {
    state = JSON.parse(readFileSync(path.join(dir, STATE_FILE), 'utf8')) as TakeoverState;
  } catch {
    return; // `capmac takeover off` removed it: Capacitor runs as usual.
  }
  if (!state.cli || !existsSync(state.cli)) {
    warn(`Takeover is on, but CapMac is no longer at ${state.cli}. Running Capacitor as usual.`);
    warn('Reinstall CapMac and run `capmac takeover on` again, or turn it off with `capmac takeover off`.');
    return;
  }

  // Ctrl+C reaches capmac as well (same console); capmac decides how to stop.
  const ignoreSigint = () => undefined;
  process.on('SIGINT', ignoreSigint);
  const result = spawnSync(process.execPath, [state.cli, ...args], {
    stdio: 'inherit',
    env: { ...process.env, CAPMAC_TAKEOVER: '0', CAPMAC_VIA: 'capacitor' },
  });
  if (result.error) {
    process.removeListener('SIGINT', ignoreSigint);
    warn(`Could not start CapMac (${result.error.message}). Running Capacitor as usual.`);
    return;
  }
  process.exit(result.status === null ? 1 : result.status);
}

try {
  main();
} catch {
  // Never break Node.js: this file runs in every process.
}
