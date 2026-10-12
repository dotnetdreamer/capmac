/**
 * The `capmac` command in terminals, for PCs that have capmac Studio but not
 * the npm package: AI agents run capmac as a command. capmac Studio writes
 * small launchers (capmac.cmd for cmd and PowerShell, capmac for Git Bash)
 * that run its own copy of the CLI with the terminal's Node.js, and puts their
 * folder on the Windows user's PATH.
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CapmacCommandStatus } from '../shared/skills.js';
import { UserError } from './errors.js';

export type { CapmacCommandStatus } from '../shared/skills.js';

/** %LOCALAPPDATA%\capmac\bin: where capmac Studio's launchers live. */
export function capmacCommandDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'capmac', 'bin');
}

/** The launchers for a CLI entry file (cli.mjs). */
export function launcherFiles(cli: string): Record<string, string> {
  const win = path.win32.normalize(cli);
  const posix = cli.replace(/\\/g, '/');
  return {
    'capmac.cmd': [
      '@echo off',
      'rem Written by CapMac: runs the CapMac CLI below with your Node.js.',
      `if not exist "${win}" (`,
      '  echo CapMac is no longer installed where this command points. Install it with: npm install -g capmac 1>&2',
      '  exit /b 1',
      ')',
      `node "${win}" %*`,
      '',
    ].join('\r\n'),
    capmac: ['#!/bin/sh', '# Written by CapMac: runs the CapMac CLI below with your Node.js.', `exec node "${posix}" "$@"`, ''].join('\n'),
  };
}

const sameDir = (a: string, b: string) => path.win32.normalize(a).replace(/\\+$/, '').toLowerCase() === path.win32.normalize(b).replace(/\\+$/, '').toLowerCase();

/** A PATH value with `dir` added at the end (unless it is already there). */
export function pathWith(value: string, dir: string): string {
  if (value.split(';').some((p) => p && sameDir(p, dir))) return value;
  // Appended in the PATH's own style (with or without a trailing ";"), so removing it gives back the exact text.
  if (!value) return dir;
  return value.endsWith(';') ? `${value}${dir};` : `${value};${dir}`;
}

/** A PATH value without `dir`. */
export function pathWithout(value: string, dir: string): string {
  const parts = value.split(';');
  const kept = parts.filter((p) => !p || !sameDir(p, dir));
  if (kept.length === parts.length) return value;
  // "A;B;dir" → "A;B", "A;B;dir;" → "A;B;": what pathWith added comes off without a trace.
  const joined = kept.join(';');
  return value.endsWith(';') || !joined.endsWith(';') ? joined : joined.slice(0, -1);
}

/** %VAR% references as the shell would expand them (Windows names are case-insensitive). */
function expand(value: string): string {
  const env = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%]+)%/g, (whole, name: string) => env[name.toLowerCase()] ?? whole);
}

function powershell(script: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 },
      (err, stdout, stderr) => (err ? reject(new UserError('Could not update your PATH.', String(stderr || err.message).trim())) : resolve(stdout)),
    );
  });
}

/** The user's and the machine's PATH as saved (what new terminals get), with %VAR% unexpanded. */
export const pathEnvironment = {
  async read(): Promise<{ user: string; machine: string }> {
    const out = await powershell(
      [
        "$o = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames",
        "$u = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
        "$m = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')",
        "@{ user = if ($u) { $u.GetValue('Path', '', $o) } else { '' }; machine = if ($m) { $m.GetValue('Path', '', $o) } else { '' } } | ConvertTo-Json -Compress",
      ].join('; '),
    );
    const parsed = JSON.parse(out) as { user?: string; machine?: string };
    return { user: parsed.user ?? '', machine: parsed.machine ?? '' };
  },
  /** Saves the user's PATH as REG_EXPAND_SZ (keeping %VAR% entries) and tells running apps. */
  async writeUser(value: string): Promise<void> {
    await powershell(
      [
        "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
        "$k.SetValue('Path', $env:CAPMAC_PATH_VALUE, [Microsoft.Win32.RegistryValueKind]::ExpandString)",
        // Setting any user variable through .NET broadcasts WM_SETTINGCHANGE, so new terminals see the new PATH.
        "[Environment]::SetEnvironmentVariable('CAPMAC_PATH_CHANGED', $null, 'User')",
      ].join('; '),
      { CAPMAC_PATH_VALUE: value },
    );
  },
};

/** Whether new terminals can run `capmac`, and whether it is capmac Studio's launcher. */
export async function capmacCommandStatus(): Promise<CapmacCommandStatus> {
  const saved = process.platform === 'win32' ? await pathEnvironment.read().catch(() => ({ user: '', machine: '' })) : { user: '', machine: '' };
  const dirs = [...saved.user.split(';'), ...saved.machine.split(';'), ...(process.env.PATH ?? '').split(path.delimiter)].filter(Boolean).map(expand);
  const names = process.platform === 'win32' ? ['capmac.cmd', 'capmac.exe', 'capmac.ps1'] : ['capmac'];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (existsSync(file)) return { found: file, ours: sameDir(dir, capmacCommandDir()) };
    }
  }
  return { found: null, ours: false };
}

/** Writes the launchers for this CLI and puts their folder on the user's PATH (new terminals). */
export async function installCapmacCommand(cli: string): Promise<CapmacCommandStatus> {
  if (process.platform !== 'win32') throw new UserError('CapMac Studio adds the capmac command on Windows only.', 'Install it with `npm install -g capmac`.');
  if (!existsSync(cli)) throw new UserError('CapMac Studio\'s copy of the CLI is missing.', 'Reinstall CapMac Studio, or install the CLI with `npm install -g capmac`.');
  const dir = capmacCommandDir();
  await fs.mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(launcherFiles(cli))) await fs.writeFile(path.join(dir, name), text);
  const saved = await pathEnvironment.read();
  const next = pathWith(saved.user, dir);
  if (next !== saved.user) await pathEnvironment.writeUser(next);
  return capmacCommandStatus();
}

/** Removes capmac Studio's launchers and their PATH entry (an npm install of capmac is not touched). */
export async function removeCapmacCommand(): Promise<CapmacCommandStatus> {
  const dir = capmacCommandDir();
  if (process.platform === 'win32') {
    const saved = await pathEnvironment.read();
    const next = pathWithout(saved.user, dir);
    if (next !== saved.user) await pathEnvironment.writeUser(next);
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rmdir(path.dirname(dir)).catch(() => undefined); // %LOCALAPPDATA%\capmac, when nothing else is in it
  return capmacCommandStatus();
}
