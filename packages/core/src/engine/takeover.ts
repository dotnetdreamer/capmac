/**
 * Takeover: `npx cap run ios`, `ionic capacitor run ios` and friends run on
 * the Mac. A small preload (takeover.cjs) in the Windows user's NODE_OPTIONS
 * spots those Capacitor commands and hands them to capmac's CLI. It is on by
 * default; the CLI and capmac Studio share this state, and turning it off is
 * remembered in capmac's config.
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRELOAD_FILE, STATE_FILE, type TakeoverState, type TakeoverStatus } from '../shared/takeover.js';

export type { TakeoverStatus } from '../shared/takeover.js';
import { capmacDir, loadGlobalConfig, saveGlobalConfig } from './config.js';
import { UserError } from './errors.js';

/** A capmac that takeover can run: its CLI entry and the preload built next to it. */
export interface TakeoverInstall {
  cli: string;
  preload: string;
  version: string;
}

const ENV_NAME = 'NODE_OPTIONS';

export const takeoverStateFile = (): string => path.join(capmacDir(), STATE_FILE);
export const takeoverPreloadFile = (): string => path.join(capmacDir(), PRELOAD_FILE);

// --- NODE_OPTIONS -----------------------------------------------------------

/**
 * `--require <file>` as NODE_OPTIONS reads it. Node treats a backslash inside
 * quotes as an escape, so the path uses forward slashes (fine on Windows) and
 * is quoted only when it contains spaces.
 */
export function requireOption(file: string): string {
  const p = file.replace(/\\/g, '/');
  return `--require ${/\s/.test(p) ? `"${p}"` : p}`;
}

// --require/-r followed by a quoted or bare path ending in takeover.cjs inside a capmac folder.
const OURS = /(^|\s)(?:--require|-r)(?:\s+|=)(?:"[^"]*capmac[^"]*[\\/]takeover\.cjs"|[^\s"]*capmac[^\s"]*[\\/]takeover\.cjs)(?=\s|$)/gi;

export function hasPreload(value: string | undefined): boolean {
  OURS.lastIndex = 0;
  return Boolean(value && OURS.test(value));
}

/** The value without capmac's preload; the user's own options stay as they were. */
export function removePreload(value: string | undefined): string {
  return (value ?? '').replace(OURS, '$1').replace(/\s+/g, ' ').trim();
}

export function addPreload(value: string | undefined, file: string): string {
  return [removePreload(value), requireOption(file)].filter(Boolean).join(' ');
}

function powershell(script: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) reject(new UserError('Could not update your Windows environment variables.', String(stderr || err.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

/** NODE_OPTIONS as saved for the Windows user (what new terminals get). Tests swap in a fake. */
export const userEnvironment = {
  /** False only for a test's stand-in: guards below protect the real environment until a test says otherwise. */
  real: true,
  async read(): Promise<string | undefined> {
    const value = (await powershell(`[Environment]::GetEnvironmentVariable('${ENV_NAME}', 'User')`)).trim();
    return value || undefined;
  },
  /**
   * A fast read for display: reg.exe takes milliseconds where PowerShell takes
   * over a second. Never written back, since reg.exe may garble non-ASCII text.
   */
  async peek(): Promise<string | undefined> {
    const out = await new Promise<string>((resolve) => {
      execFile('reg.exe', ['query', 'HKCU\\Environment', '/v', ENV_NAME], { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? '' : stdout));
    });
    return out.match(/^\s+NODE_OPTIONS\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/m)?.[1] || undefined;
  },
  /** Saves it, or removes it when empty; Windows tells running apps. */
  async write(value: string): Promise<void> {
    await powershell(
      `$v = $env:CAPMAC_NODE_OPTIONS; if (-not $v) { $v = $null }; [Environment]::SetEnvironmentVariable('${ENV_NAME}', $v, 'User')`,
      { CAPMAC_NODE_OPTIONS: value },
    );
  },
};
/** Changes reach the real Windows user environment (unless a test marked its stand-in). */
function writesRealEnvironment(): boolean {
  return userEnvironment.real;
}

/**
 * Node.js refuses to start when a NODE_OPTIONS --require file is missing, and
 * the variable reaches every new process. So the real user environment only
 * ever points at a preload that stays put: never one in the temp folder (a
 * test's or a sandbox's config dir, deleted afterwards).
 */
function assertLastingPreload(file: string): void {
  if (!writesRealEnvironment()) return;
  const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(file));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new UserError('Takeover will not point NODE_OPTIONS at a temporary folder.', `${file} would vanish and stop Node.js from starting. Unset CAPMAC_CONFIG_DIR, or point it at a lasting folder.`);
  }
}

// --- state -----------------------------------------------------------------

export async function readTakeoverState(): Promise<TakeoverState | null> {
  try {
    return JSON.parse(await fs.readFile(takeoverStateFile(), 'utf8')) as TakeoverState;
  } catch {
    return null;
  }
}

async function remember(choice: 'on' | 'off'): Promise<void> {
  const config = await loadGlobalConfig();
  if (config.takeover !== choice) await saveGlobalConfig({ ...config, takeover: choice });
}

async function installFiles(install: TakeoverInstall): Promise<void> {
  await fs.mkdir(capmacDir(), { recursive: true });
  await fs.copyFile(install.preload, takeoverPreloadFile());
  const state: TakeoverState = { cli: install.cli, version: install.version };
  await fs.writeFile(takeoverStateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

/** Whether this capmac can be pointed at: present, and not a throwaway `npx capmac` copy. */
export function usableInstall(install: TakeoverInstall | null): install is TakeoverInstall {
  return Boolean(install && existsSync(install.cli) && existsSync(install.preload) && !/[\\/]_npx[\\/]/.test(install.cli));
}

// --- turning it on and off ---------------------------------------------------

/** Turns takeover on with this capmac. New terminals pick it up. */
export async function enableTakeover(install: TakeoverInstall, options: { remember?: boolean } = {}): Promise<void> {
  if (!usableInstall(install)) {
    throw new UserError('Takeover needs CapMac installed, not run through npx.', 'Install it once with `npm install -g capmac` (or install CapMac Studio), then turn takeover on.');
  }
  if (process.platform === 'win32') assertLastingPreload(takeoverPreloadFile());
  await installFiles(install);
  if (process.platform === 'win32') {
    const current = await userEnvironment.read();
    const next = addPreload(current, takeoverPreloadFile());
    if (next !== current) await userEnvironment.write(next);
  }
  if (options.remember !== false) await remember('on');
}

/**
 * Turns takeover off, at once in every terminal: without takeover.json the
 * preload does nothing. The preload file itself stays, because terminals that
 * are already open still load it (Node.js stops if a --require file is missing).
 */
export async function disableTakeover(): Promise<void> {
  if (process.platform === 'win32') {
    const current = await userEnvironment.read();
    const next = removePreload(current);
    if (next !== (current ?? '')) await userEnvironment.write(next);
  }
  await fs.rm(takeoverStateFile(), { force: true });
  await remember('off');
}

/**
 * Takeover is on by default: turns it on unless the user turned it off, or
 * repoints it when the capmac it used has gone (uninstalled, moved). Returns
 * true when it just turned it on, so the front end can say so.
 */
export async function ensureTakeoverDefault(install: TakeoverInstall | null): Promise<boolean> {
  if (process.platform !== 'win32' || process.env.CI === 'true' || process.env.CAPMAC_VIA) return false;
  // A custom config folder means a test, CI or a sandbox: never change the user's real
  // environment on its behalf (the variable would point into a folder that may vanish).
  if (process.env.CAPMAC_CONFIG_DIR && writesRealEnvironment()) return false;
  const config = await loadGlobalConfig();
  if (config.takeover === 'off') return false;
  const state = await readTakeoverState();
  if (state && existsSync(state.cli) && existsSync(takeoverPreloadFile())) return false;
  if (!usableInstall(install)) return false;
  await enableTakeover(install, { remember: false });
  return true;
}

/**
 * Whether two paths name the same file. Windows paths ignore case, which
 * matters when an installer's folder name changes case ("capmac Studio" →
 * "CapMac Studio") but the folder on disk stays the same.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/** After an upgrade, brings the copied preload up to date. Runs on each taken-over command. */
export async function refreshTakeover(install: TakeoverInstall): Promise<void> {
  const state = await readTakeoverState();
  if (state && samePath(state.cli, install.cli) && state.version !== install.version && existsSync(install.preload)) await installFiles(install);
}

export async function takeoverStatus(): Promise<TakeoverStatus> {
  const [config, state] = await Promise.all([loadGlobalConfig(), readTakeoverState()]);
  const userEnv = process.platform === 'win32' ? hasPreload(await userEnvironment.peek().catch(() => undefined)) : null;
  const cliMissing = state ? !existsSync(state.cli) : false;
  return {
    on: state !== null && !cliMissing && userEnv !== false,
    choice: config.takeover,
    cli: state?.cli,
    cliMissing,
    userEnv,
    thisProcess: hasPreload(process.env[ENV_NAME]),
  };
}
