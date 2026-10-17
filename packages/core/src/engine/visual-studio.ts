/**
 * Visual Studio for the Windows apps CapMac builds on this PC (a Flutter
 * app's, a React Native app's): each framework needs its own parts of it.
 * CapMac checks before a build (the tools themselves only say "toolchain not
 * found") and offers to add what is missing with Visual Studio's own
 * installer.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { withStep, type EngineContext } from './context.js';
import { UserError } from './errors.js';

/** What a framework needs from Visual Studio. */
export interface VsRequirement {
  /** Installer ids of the components it needs, with their names in the installer. */
  components: Record<string, string>;
  /** Workloads it needs, all of them (installer ids and names). */
  workloads?: Record<string, string>;
  /** A Visual Studio that has one of these workloads can carry the components (Flutter: Visual Studio's C++ workload, or the Build Tools'). */
  anyWorkload?: string[];
  /** The Visual Studio versions it builds with, as vswhere takes them ("[17.11,18.0)"); default 16 or later. */
  versions?: string;
  /** The framework, for messages ("Flutter"). */
  framework: string;
  /** Where the installer shows them, for the manual steps. */
  installerHint: string;
}

/** PowerShell's exit code when the permission prompt was declined (Start-Process throws). */
const DECLINED = 1223;

/** Arguments as one Windows command line (the C runtime's rules: quotes around spaces, backslashes before a quote doubled). */
export function windowsCommandLine(args: string[]): string {
  return args.map((arg) => {
    if (arg && !/[\s"]/.test(arg)) return arg;
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  }).join(' ');
}

function installerDir(): string {
  return path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer');
}

interface VsInstall {
  installationPath: string;
  displayName: string;
  installationVersion?: string;
  productId?: string;
  isComplete?: boolean;
  isLaunchable?: boolean;
}

function vswhere(args: string[]): Promise<VsInstall[]> {
  const bin = path.join(installerDir(), 'vswhere.exe');
  if (!existsSync(bin)) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(bin, [...args, '-format', 'json', '-utf8'], { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const parsed = JSON.parse(stdout) as VsInstall[];
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

export type VsState =
  | { ok: true; name: string; path: string }
  /** `install`: the Visual Studio to add the `missing` parts to (null: there is none to add them to). */
  | { ok: false; install: { name: string; path: string } | null; missing: string[] };

/** Whether this PC's Visual Studio has what `req` needs, and if not, what it lacks. */
export async function visualStudioState(req: VsRequirement): Promise<VsState> {
  const required = [...Object.keys(req.components), ...Object.keys(req.workloads ?? {})];
  const version = ['-version', req.versions ?? '16'];
  for (const prerelease of [false, true]) {
    for (const workload of req.anyWorkload ?? [null]) {
      const found = await vswhere(['-products', '*', ...version, ...(prerelease ? ['-prerelease'] : []), '-requires', ...(workload ? [workload] : []), ...required]);
      const usable = found.find((vs) => vs.isComplete !== false && vs.isLaunchable !== false);
      if (usable) return { ok: true, name: usable.displayName, path: usable.installationPath };
    }
  }
  // The Visual Studio to complete: one of the versions it builds with that has the most of what it needs (not SQL Server Management Studio, which lists itself too).
  const all = (await vswhere(['-products', '*', ...version, '-prerelease'])).filter((vs) => /VisualStudio\.Product\.(Community|Professional|Enterprise|BuildTools)/.test(vs.productId ?? '') || /^Visual Studio/.test(vs.displayName));
  if (!all.length) return { ok: false, install: null, missing: required };
  const missingFor = new Map<string, string[]>(all.map((vs) => [vs.installationPath, [] as string[]]));
  for (const id of required) {
    // (vswhere's -path takes no -requires: list the installs that have it instead.)
    const has = await vswhere(['-products', '*', ...version, '-prerelease', '-requires', id]);
    for (const vs of all) if (!has.some((h) => h.installationPath === vs.installationPath)) missingFor.get(vs.installationPath)!.push(id);
  }
  const best = [...all].sort((a, b) => missingFor.get(a.installationPath)!.length - missingFor.get(b.installationPath)!.length || (b.installationVersion ?? '').localeCompare(a.installationVersion ?? '', undefined, { numeric: true }))[0]!;
  const missing = missingFor.get(best.installationPath)!;
  return { ok: false, install: { name: best.displayName, path: best.installationPath }, missing: missing.length ? missing : required };
}

/** A part's name in Visual Studio's installer. */
function partName(req: VsRequirement, id: string): string {
  return req.components[id] ?? req.workloads?.[id] ?? id;
}

/**
 * Makes sure Visual Studio has what `req` needs to build the Windows app.
 * When it lacks a part, CapMac offers to open Visual Studio's installer with
 * it picked (Windows asks for permission; the installer shows its progress).
 */
export async function ensureVisualStudio(req: VsRequirement, ctx: EngineContext, signal?: AbortSignal): Promise<void> {
  const state = await visualStudioState(req);
  if (state.ok) return;
  const names = state.missing.map((id) => partName(req, id));
  const more = names.length - 3;
  const what = more > 0 ? `${names.slice(0, 3).map((n) => `“${n}”`).join(', ')} and ${more} more part${more === 1 ? '' : 's'}` : names.map((name) => `“${name}”`).join(' and ');
  if (!state.install) {
    throw new UserError(`Building the Windows app needs Visual Studio with ${what}.`, `Install Visual Studio Community (https://visualstudio.microsoft.com) with ${req.installerHint}, then try again.`);
  }
  const manual = `Open Visual Studio Installer, click Modify on ${state.install.name}, tick ${req.installerHint}, then click Modify.`;
  const setup = path.join(installerDir(), 'setup.exe');
  if (!ctx.prompter.interactive || !existsSync(setup)) throw new UserError(`Building the Windows app needs ${what} in ${state.install.name}.`, manual);
  const yes = await ctx.prompter.confirm({
    message: `Add ${what} to ${state.install.name}?`,
    detail: `${req.framework} builds the Windows app with them. Visual Studio’s installer adds them: Windows asks for permission first, then it takes a few minutes${names.length > 3 ? ' (a few GB to download)' : ''}.`,
    confirmLabel: 'Add them',
    defaultYes: true,
    signal,
  });
  if (!yes) throw new UserError(`Building the Windows app needs ${what} in ${state.install.name}.`, manual);
  await withStep(ctx, `Adding ${names.length > 3 ? `${names.length} parts` : names.join(' and ')} to ${state.install.name}`, 'deps', async (step) => {
    step.update('Waiting for Visual Studio’s installer (Windows asks for permission)');
    const args = ['modify', '--installPath', state.install!.path, ...state.missing.flatMap((id) => ['--add', id]), '--includeRecommended', '--passive', '--norestart'];
    // The installer runs --passive only when it starts elevated (else it stops at once with code 5007):
    // PowerShell starts it with Windows' permission prompt, then it installs on its own, showing its progress.
    // Start-Process joins -ArgumentList items with spaces, unquoted (--installPath C:\Program Files\… broke apart):
    // it gets one command line, quoted as Windows programs read it. It waits for the installer itself, not with
    // -Wait, which also waits for what the installer leaves running (Windows features it adds through DISM).
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const script = `try { $p = Start-Process -FilePath ${quote(setup)} -ArgumentList ${quote(windowsCommandLine(args))} -Verb RunAs -PassThru } catch { exit ${DECLINED} }; $p.WaitForExit(); exit $p.ExitCode`;
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
      const onAbort = () => child.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', reject);
      child.on('close', (exitCode) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(exitCode);
      });
    }).catch(() => null);
    if (code === DECLINED) throw new UserError('Windows didn’t give Visual Studio’s installer permission to make changes.', `Run again and click Yes when Windows asks, or: ${manual}`);
    const after = await visualStudioState(req);
    if (!after.ok) throw new UserError(`Visual Studio’s installer did not add ${what}${code !== null && code !== 0 ? ` (it ended with code ${code})` : ''}.`, manual);
  });
}
