/**
 * Runs the door (door.ts), CapMac's remote-access service on the Mac. A
 * LaunchAgent (dev.capmac.remote) starts it with the Mac's Node.js while the
 * user is logged in:
 *
 *   node door.mjs <config.json>
 *
 * The agent op `remote-install` writes its files and loads the LaunchAgent.
 * Exits 0 on problems that retrying cannot fix (launchd then leaves it
 * stopped) and on SIGTERM; anything else is restarted by launchd.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOOR_MIN_NODE_MAJOR } from '../shared/remote.js';
import type { DoorConfig, DoorStatusFile } from '../shared/remote-door.js';
import { loadIdentity } from '../shared/remote-keys.js';
import { Door, fileLog } from './door.js';

declare const __CAPMAC_VERSION__: string | undefined;
const VERSION = typeof __CAPMAC_VERSION__ === 'string' ? __CAPMAC_VERSION__ : 'dev';

const configPath = process.argv[2] ?? path.join(os.homedir(), '.capmac', 'remote', 'config.json');
let config: DoorConfig;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8')) as DoorConfig;
} catch (err) {
  process.stderr.write(`CapMac door: cannot read ${configPath}: ${(err as Error).message}\n`);
  process.exit(0);
}
const log = fileLog(config.logFile);

function giveUp(message: string): never {
  log('error', message);
  const status: DoorStatusFile = { state: 'error', since: new Date().toISOString(), pid: process.pid, version: VERSION, error: message, sessions: 0, server: null, node: process.version };
  try {
    writeFileSync(`${config.statusFile}.tmp`, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    renameSync(`${config.statusFile}.tmp`, config.statusFile);
  } catch {
    // the status file is only for the health check
  }
  process.exit(0);
}

if (Number(process.versions.node.split('.')[0]) < DOOR_MIN_NODE_MAJOR || typeof WebSocket !== 'function') {
  giveUp(`Remote access needs Node.js ${DOOR_MIN_NODE_MAJOR} or later; this door runs with ${process.version}.`);
}

let door: Door;
try {
  door = new Door(config, loadIdentity(readFileSync(config.keyFile, 'utf8')), { version: VERSION, log });
} catch (err) {
  giveUp(`The door's key (${config.keyFile}) is unreadable: ${(err as Error).message}`);
}

const stop = (signal: string) => {
  void door.stop(signal).finally(() => setTimeout(() => process.exit(0), 200));
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('uncaughtException', (err) => log('error', `uncaught: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (reason) => log('error', `unhandled: ${String((reason as Error)?.stack ?? reason)}`));

door.start();
