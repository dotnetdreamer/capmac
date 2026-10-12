import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  disableTakeover,
  enableTakeover,
  ensureTakeoverDefault,
  loadGlobalConfig,
  refreshTakeover,
  requireOption,
  resolveHost,
  takeoverPreloadFile,
  takeoverStatus,
  UserError,
  type TakeoverInstall,
} from '@capmac/core/engine';
import { log, pc } from '../ui.js';

declare const __CAPMAC_VERSION__: string | undefined;
const VERSION = typeof __CAPMAC_VERSION__ === 'string' ? __CAPMAC_VERSION__ : 'dev';

/** This capmac: dist/cli.js, with the preload built next to it. */
export function thisInstall(): TakeoverInstall {
  const cli = fileURLToPath(import.meta.url);
  return { cli, preload: path.join(path.dirname(cli), 'takeover.cjs'), version: VERSION };
}

/** Before any command: takeover is on by default, so turn it on the first time (and say so once). */
export async function takeoverByDefault(): Promise<void> {
  try {
    if (!(await ensureTakeoverDefault(thisInstall()))) return;
    const say = (text: string) => process.stderr.write(`${text}\n`);
    say(`${pc.cyan('●')} ${pc.bold('npx cap run ios')} and ${pc.bold('ionic capacitor run ios')} now run on your Mac too, in new terminals.`);
    say(pc.dim(`  ${pc.bold('capmac takeover off')} turns that off; ${pc.bold('capmac takeover')} shows how it works.`));
  } catch {
    // never stand in the way of the command itself
  }
}

/** On each taken-over command: keeps the copied preload in step with this capmac. */
export async function refreshThisTakeover(): Promise<void> {
  await refreshTakeover(thisInstall());
}

export async function takeoverCommand(action = 'status'): Promise<void> {
  if (action === 'on') return takeoverOn();
  if (action === 'off') return takeoverOff();
  if (action === 'status') return showStatus();
  throw new UserError(`Unknown takeover action "${action}".`, 'Use `capmac takeover on`, `capmac takeover off` or `capmac takeover status`.');
}

async function macLabel(): Promise<string | null> {
  const host = resolveHost(await loadGlobalConfig());
  return host ? host.macName ?? host.host : null;
}

function printCommands(): void {
  const rows: Array<[string, string]> = [
    ['npx cap run ios', 'build on the Mac, install, launch, show the app\'s console'],
    ['npx cap run ios -l --port 5173', 'live reload from your dev server'],
    ['ionic capacitor run ios -l', 'Ionic live reload, through CapMac\'s tunnel (no --external needed)'],
    ['npx cap run ios --list', 'the Mac\'s simulators and devices'],
    ['npx cap open ios', 'Xcode, on the Mac\'s screen'],
    ['npx cap build ios', 'a signed .ipa in ios/App/output'],
  ];
  for (const [cmd, what] of rows) log.line(`  ${pc.cyan(cmd.padEnd(33))} ${pc.dim(what)}`);
  log.line(pc.dim('  Everything else (sync, copy, add, Android) still runs on this PC.'));
}

async function takeoverOn(): Promise<void> {
  await enableTakeover(thisInstall());
  const mac = await macLabel();
  log.success(`Takeover is on: your usual Capacitor and Ionic iOS commands run on ${mac ? pc.bold(mac) : 'your Mac'}.`);
  log.line();
  printCommands();
  log.line();
  if (process.platform === 'win32') {
    log.line(`  ${pc.cyan('→')} Open a new terminal for it to apply. Restart VS Code so its terminals get it too.`);
  } else {
    log.line(`  ${pc.cyan('→')} Add this to your shell profile, then open a new terminal:`);
    log.line(`    export NODE_OPTIONS="$NODE_OPTIONS ${requireOption(takeoverPreloadFile()).replace(/"/g, '\\"')}"`);
  }
  log.line(`  ${pc.cyan('→')} One command with plain Capacitor: set ${pc.bold('CAPMAC_TAKEOVER=0')}. Turn it off with ${pc.bold('capmac takeover off')}.`);
  if (!mac) log.warn('No Mac is paired yet: run `capmac pair` first.');
}

async function takeoverOff(): Promise<void> {
  await disableTakeover();
  log.success('Takeover is off: `npx cap run ios` and `ionic capacitor run ios` run Capacitor itself again, in every terminal.');
  log.dim(`  It stays off until you run ${pc.bold('capmac takeover on')}.`);
  if (process.platform !== 'win32') log.dim(`  Remove ${requireOption(takeoverPreloadFile())} from NODE_OPTIONS in your shell profile.`);
}

async function showStatus(): Promise<void> {
  const s = await takeoverStatus();
  log.line(`${pc.bold('Takeover')}  ${s.on ? pc.green('on') : pc.dim('off')}${s.choice === 'off' ? pc.dim('  (turned off)') : ''}`);
  if (s.cli) log.line(`  ${pc.dim('capmac'.padEnd(16))} ${s.cli}${s.cliMissing ? pc.red('  (missing: run `capmac takeover on` again)') : ''}`);
  if (s.userEnv !== null) log.line(`  ${pc.dim('NODE_OPTIONS'.padEnd(16))} ${s.userEnv ? 'set for your Windows user' : 'not set'}`);
  log.line(`  ${pc.dim('This terminal'.padEnd(16))} ${s.thisProcess ? (s.cli ? 'taken over' : 'loads the preload, which is idle') : 'not taken over'}`);
  log.line();
  if (s.on) {
    printCommands();
    if (!s.thisProcess) {
      log.line();
      log.line(`  ${pc.cyan('→')} Open a new terminal (or restart VS Code) for it to apply here.`);
    }
  } else {
    log.line(`  ${pc.cyan('→')} ${pc.bold('capmac takeover on')} makes \`npx cap run ios\` and \`ionic capacitor run ios\` run on your Mac.`);
  }
}
