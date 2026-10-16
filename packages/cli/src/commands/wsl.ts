import { findProjectDir, silentContext, type EngineContext } from '@capmac/core/engine';
import {
  buildWsl,
  devWsl,
  doctorWsl,
  runWsl,
  setupWsl,
  type WslOptions,
} from '@capmac/core/engine/wsl/index';
import { listWslDevices } from '@capmac/core/engine/wsl/device';
import { requireAppleDeviceServer } from '@capmac/core/engine/wsl/apple-devices';
import { loadWslOptions } from '@capmac/core/engine/wsl/settings';
import { cancelOnSigint } from '../cli-context.js';
import { terminalContext } from '../terminal.js';
import { log, pc, sym } from '../ui.js';

export interface WslCommandOptions extends WslOptions {
  backend?: 'mac' | 'wsl';
}

/** Each command owns its cancellation lifetime; no Mac session is opened. */
async function withWsl<T>(
  options: WslCommandOptions,
  action: (options: WslOptions, ctx: EngineContext, signal: AbortSignal) => Promise<T>,
  mode: 'run' | 'dev' | 'other' = 'other',
): Promise<T> {
  const { ctx } = terminalContext({ mode, attach: options.logs !== false, allWarnings: options.allWarnings });
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  try {
    return await action({ ...options, cwd: options.cwd ?? process.cwd() }, options.json ? silentContext() : ctx, controller.signal);
  } finally {
    restore();
  }
}

export async function wslDoctorCommand(options: WslCommandOptions): Promise<void> {
  const result = await withWsl(options, doctorWsl);
  if (options.json) {
    log.line(JSON.stringify(result, null, 2));
  } else {
    log.line(pc.bold('iOS on Windows · WSL'));
    for (const check of result.checks) {
      const mark = check.level === 'ok' ? sym.ok : check.level === 'fail' ? sym.fail : check.level === 'warn' ? sym.warn : sym.info;
      log.line(`  ${mark} ${check.label}${check.detail ? pc.dim(`  ${check.detail}`) : ''}`);
      if (check.fix && check.level !== 'ok') log.line(`      ${pc.dim('→')} ${check.fix}`);
    }
    log.line();
    if (result.ready) log.success('Ready to build. Connect and trust your iPhone, then run `capmac wsl run`.');
    else log.info('Follow the steps above, or run `capmac wsl setup` for the setup guide.');
  }
  if (!result.ready) process.exitCode = 1;
}

export async function wslSetupCommand(options: WslCommandOptions): Promise<void> {
  await withWsl(options, (input, ctx, signal) => setupWsl(input, ctx, signal, { guided: !!process.stdin.isTTY && !!process.stdout.isTTY }));
}

export async function wslTargetsCommand(options: WslCommandOptions): Promise<void> {
  const devices = await withWsl(options, async (input, _ctx, signal) => {
    const cwd = findProjectDir(input.cwd ?? process.cwd())?.dir ?? input.cwd;
    const saved = await loadWslOptions({ ...input, cwd });
    await requireAppleDeviceServer(signal);
    return listWslDevices({ python: saved.python, signal });
  });
  if (options.json) {
    log.line(JSON.stringify(devices, null, 2));
    return;
  }
  if (!devices.length) {
    log.info('No iPhones found. Connect and unlock your iPhone, then accept the Trust prompt.');
    return;
  }
  for (const device of devices) {
    log.line(`${pc.bold(device.name)}${device.productVersion ? pc.dim(` · iOS ${device.productVersion}`) : ''}`);
    log.dim(`  ${device.udid}`);
  }
  log.line();
  log.dim('Choose a device with `capmac wsl run --target <udid>`.');
}

export async function wslBuildCommand(options: WslCommandOptions): Promise<void> {
  const result = await withWsl(options, buildWsl);
  log.success(`Built ${pc.bold(result.bundleId)}${result.signed === false ? ' (unsigned; compilation check)' : ''}`);
  log.line(`  App: ${result.appPath}`);
  log.line(`  IPA: ${pc.bold(result.ipaPath)}`);
}

export async function wslRunCommand(options: WslCommandOptions): Promise<void> {
  await withWsl(options, runWsl, 'run');
}

export async function wslDevCommand(options: WslCommandOptions): Promise<void> {
  await withWsl(options, devWsl, 'dev');
}
