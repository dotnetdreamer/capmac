/**
 * Visual Studio for a Flutter app's Windows app: Flutter builds it with
 * Visual Studio's C++ tools and the CMake that comes with them. CapMac checks
 * before a build (Flutter itself only says "Unable to find suitable Visual
 * Studio toolchain") and offers to add what is missing with Visual Studio's
 * own installer.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { withStep, type EngineContext } from '../context.js';
import { UserError } from '../errors.js';

/** What Flutter needs from Visual Studio 2019 or later, by its installer ids (as Flutter's visual_studio.dart asks). */
export const VS_COMPONENTS: Record<string, string> = {
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64': 'MSVC C++ x64/x86 build tools',
  'Microsoft.VisualStudio.Component.VC.CMake.Project': 'C++ CMake tools for Windows',
};
/** Either workload carries those components: Visual Studio's, or the Build Tools'. */
const WORKLOADS = ['Microsoft.VisualStudio.Workload.NativeDesktop', 'Microsoft.VisualStudio.Workload.VCTools'];

function installerDir(): string {
  return path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer');
}

interface VsInstall {
  installationPath: string;
  displayName: string;
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
  /** `install`: the Visual Studio to add the `missing` components to (null: there is none to add them to). */
  | { ok: false; install: { name: string; path: string } | null; missing: string[] };

/** Whether this PC's Visual Studio can build a Flutter app's Windows app, and if not, what it lacks. */
export async function windowsToolchain(): Promise<VsState> {
  const required = Object.keys(VS_COMPONENTS);
  for (const prerelease of [false, true]) {
    for (const workload of WORKLOADS) {
      const found = await vswhere(['-products', '*', '-version', '16', ...(prerelease ? ['-prerelease'] : []), '-requires', workload, ...required]);
      const usable = found.find((vs) => vs.isComplete !== false && vs.isLaunchable !== false);
      if (usable) return { ok: true, name: usable.displayName, path: usable.installationPath };
    }
  }
  // The Visual Studio to complete: one with the C++ workload, else any Visual Studio (not SQL Server Management Studio, which lists itself too).
  const all = (await vswhere(['-products', '*', '-version', '16', '-prerelease'])).filter((vs) => /VisualStudio\.Product\.(Community|Professional|Enterprise|BuildTools)/.test(vs.productId ?? '') || /^Visual Studio/.test(vs.displayName));
  const withCpp = await vswhere(['-products', '*', '-version', '16', '-prerelease', '-requires', WORKLOADS[0]!]);
  const install = withCpp.find((vs) => all.some((a) => a.installationPath === vs.installationPath)) ?? all.at(-1) ?? null;
  if (!install) return { ok: false, install: null, missing: required };
  const missing: string[] = [];
  for (const id of required) {
    // (vswhere's -path takes no -requires: list the installs that have it instead.)
    const has = await vswhere(['-products', '*', '-version', '16', '-prerelease', '-requires', id]);
    if (!has.some((vs) => vs.installationPath === install.installationPath)) missing.push(id);
  }
  return { ok: false, install: { name: install.displayName, path: install.installationPath }, missing: missing.length ? missing : required };
}

/**
 * Makes sure Visual Studio can build the Windows app. When it lacks a
 * component, CapMac offers to open Visual Studio's installer with it picked
 * (Windows asks for permission; the installer shows its progress).
 */
export async function ensureWindowsToolchain(ctx: EngineContext, signal?: AbortSignal): Promise<void> {
  const state = await windowsToolchain();
  if (state.ok) return;
  const names = state.missing.map((id) => VS_COMPONENTS[id] ?? id);
  const what = names.map((name) => `“${name}”`).join(' and ');
  if (!state.install) {
    throw new UserError('Building the Windows app needs Visual Studio with its C++ tools.', 'Install Visual Studio Community (https://visualstudio.microsoft.com) with “Desktop development with C++”, then try again.');
  }
  const manual = `Open Visual Studio Installer, click Modify on ${state.install.name}, tick ${what} under “Desktop development with C++”, then click Modify.`;
  const setup = path.join(installerDir(), 'setup.exe');
  if (!ctx.prompter.interactive || !existsSync(setup)) throw new UserError(`Building the Windows app needs ${what} in ${state.install.name}.`, manual);
  const yes = await ctx.prompter.confirm({
    message: `Add ${what} to ${state.install.name}?`,
    detail: `Flutter builds the Windows app with them. Visual Studio’s installer adds them: Windows asks for permission first, then it takes a few minutes.`,
    confirmLabel: 'Add them',
    defaultYes: true,
    signal,
  });
  if (!yes) throw new UserError(`Building the Windows app needs ${what} in ${state.install.name}.`, manual);
  await withStep(ctx, `Adding ${names.join(' and ')} to ${state.install.name}`, 'deps', async (step) => {
    step.update('Waiting for Visual Studio’s installer (Windows asks for permission)');
    const code = await new Promise<number | null>((resolve, reject) => {
      const args = ['modify', '--installPath', state.install!.path, ...state.missing.flatMap((id) => ['--add', id]), '--passive', '--norestart'];
      const child = spawn(setup, args, { windowsHide: false, stdio: 'ignore' });
      const onAbort = () => child.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', reject);
      child.on('close', (exitCode) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(exitCode);
      });
    }).catch(() => null);
    const after = await windowsToolchain();
    if (!after.ok) throw new UserError(`Visual Studio’s installer did not add ${what}${code !== null && code !== 0 ? ` (it ended with code ${code})` : ''}.`, manual);
  });
}
