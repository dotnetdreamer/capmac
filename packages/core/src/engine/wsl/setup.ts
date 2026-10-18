/**
 * Guided setup of builds on this PC, for the CLI and CapMac Studio alike.
 * Every question goes through `ctx.prompter`; account secrets stay in memory.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, throwIfAborted, withStep, type EngineContext } from '../context.js';
import { UserError } from '../errors.js';
import { WSL_SETUP_PHASES, type WslSetupPhase } from '../events.js';
import type { WslSetupState, WslSetupStatus } from '../../shared/wsl-setup.js';

export type { WslSetupState, WslSetupStatus } from '../../shared/wsl-setup.js';
import { loadProject, type ProjectInfo } from '../project.js';
import { loginAppleAccount } from './apple-account.js';
import { readSigningTargets, setUpAutomaticSigning } from './apple-auto-signing.js';
import { chooseAppleSignIn, signInOnAppleWebsite } from './apple-web.js';
import { installAppleDevices, startAppleDeviceServer } from './apple-devices.js';
import { listWslDevices } from './device.js';
import { bootstrapWslDependencies, devicePythonCurrent, ensureManagedWslDistro, MANAGED_XCODE_VERSION } from './bootstrap.js';
import { setupSDKFromXcode } from './sdk.js';
import { SDK_IMPORT_VERSION } from './sdk-runtime.js';
import { loadWslOptions, saveWslOptions, settingsPath, type WslOptions } from './settings.js';
import { WslExecutor } from './toolchain.js';

/** Only the Xcode release paired with CapMac's Linux Swift can be used. */
export async function findDownloadedXcode(version = MANAGED_XCODE_VERSION, directory = path.join(os.homedir(), 'Downloads')): Promise<string | undefined> {
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const pattern = new RegExp(`^Xcode[_ ]${version.replace(/\./g, '\\.')}(?:[_ -][^.]*)?\\.xip$`, 'i');
  const candidates = await Promise.all(names.filter((name) => pattern.test(name)).map(async (name) => {
    const file = path.join(directory, name); const info = await fs.stat(file);
    return info.isFile() && info.size > 0 ? { file, modified: info.mtimeMs } : undefined;
  }));
  return candidates.filter((item) => item !== undefined).sort((a, b) => b.modified - a.modified)[0]?.file;
}

/** The bytes of an Xcode download that stopped, which the next setup continues (see AppleAccountSession.downloadXcode). */
async function partialXcodeDownload(version = MANAGED_XCODE_VERSION, directory = path.join(os.homedir(), 'Downloads')): Promise<number | undefined> {
  const pattern = new RegExp(`^\\.capmac-Xcode[_ ]${version.replace(/\./g, '\\.')}(?:[_ -][^.]*)?\\.xip\\.part$`, 'i');
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const sizes = await Promise.all(names.filter((name) => pattern.test(name)).map((name) => fs.stat(path.join(directory, name)).then((info) => (info.isFile() ? info.size : 0), () => 0)));
  const largest = Math.max(0, ...sizes);
  return largest > 0 ? largest : undefined;
}

const statusFile = (cwd: string) => path.join(cwd, '.capmac', 'wsl', 'setup-status.json');

export async function readWslSetupStatus(cwd: string): Promise<WslSetupStatus | null> {
  try {
    const value = JSON.parse(await fs.readFile(statusFile(cwd), 'utf8')) as Partial<WslSetupStatus>;
    const phases: readonly string[] = [...WSL_SETUP_PHASES, 'complete'];
    if (!value || typeof value.phase !== 'string' || !phases.includes(value.phase) || !['running', 'failed', 'complete'].includes(String(value.state)) || typeof value.updatedAt !== 'string') return null;
    return { phase: value.phase as WslSetupStatus['phase'], state: value.state!, updatedAt: value.updatedAt, ...(typeof value.message === 'string' ? { message: value.message.slice(0, 500) } : {}) };
  } catch {
    return null;
  }
}

function setupNeeds(options: WslOptions, cwd: string) {
  // An SDK imported for another Xcode release does not match the managed Linux Swift, and
  // one CapMac took out of Xcode with an older importer is taken out again.
  const extracted = !!options.sdk && options.sdk.includes('/capmac/apple-sdk/');
  const sdk = !!options.sdk && (!options.xcodeVersion || options.xcodeVersion === MANAGED_XCODE_VERSION)
    && (!extracted || options.sdkImporter === String(SDK_IMPORT_VERSION));
  const signingFiles = [options.certificate, options.profile, ...Object.values(options.extensionProfiles ?? {})];
  const signing = signingFiles.every((file) => !!file && existsSync(path.resolve(cwd, file)));
  const tools = !!(options.distro && options.swift && options.linker && options.signer) && devicePythonCurrent(options.python);
  return { sdk, signing, tools };
}

/** What setup has put in place for a project. Changes nothing. */
export async function wslSetupState(cwd: string): Promise<WslSetupState> {
  let project: ProjectInfo | undefined;
  try { project = await loadProject(cwd); cwd = project.capDir; } catch { /* Tools can be set up outside an app. */ }
  const options = await loadWslOptions({}, cwd).catch(() => ({} as WslOptions));
  const ready = setupNeeds(options, cwd);
  const partial = ready.sdk ? undefined : await partialXcodeDownload();
  return { status: await readWslSetupStatus(cwd), ...ready, inApp: hasIosApp(project), partialDownload: partial ? { bytes: partial } : null };
}

const gigabytes = (bytes: number) => (bytes / 1_000_000_000).toFixed(1);

/** An app with an iPhone app to sign here: a Capacitor app, or a Flutter or React Native app with its iOS app. */
function hasIosApp(project: ProjectInfo | undefined): project is ProjectInfo {
  return project?.kind === 'capacitor' || (project?.kind === 'flutter' && Boolean(project.flutter?.platforms.ios)) || (project?.kind === 'react-native' && Boolean(project.reactNative?.platforms.ios));
}

export async function guidedWslSetup(input: WslOptions, cwd: string, ctx: EngineContext, signal: AbortSignal): Promise<void> {
  if (!ctx.prompter.interactive) throw new UserError('Setup needs someone to answer its questions.', 'Run `capmac wsl setup` in PowerShell, or set up this PC in CapMac Studio.');
  throwIfAborted(signal);
  let options = await loadWslOptions(input, cwd);
  await saveWslOptions(options, cwd);
  const file = statusFile(cwd);
  async function status(phase: WslSetupPhase | 'complete', state: WslSetupStatus['state'], error?: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Account exceptions are already sanitized at their owning boundary. Never
    // serialize arbitrary exceptions, request configs, cookies, or prompt answers.
    const message = error instanceof UserError ? error.message : error ? 'Setup stopped before this step completed.' : undefined;
    await fs.writeFile(file, JSON.stringify({ phase, state, updatedAt: new Date().toISOString(), ...(message ? { message } : {}) }, null, 2) + '\n', { mode: 0o600 });
  }
  const report = (phase: WslSetupPhase | 'complete', state: 'running' | 'done' | 'failed' | 'skipped', detail?: string) => ctx.emit({ type: 'wsl-setup', phase, state, ...(detail ? { detail } : {}) });
  async function track<T>(phase: WslSetupPhase, action: () => Promise<T>, done?: (value: T) => string | undefined): Promise<T> {
    await status(phase, 'running');
    report(phase, 'running');
    try {
      const value = await action();
      report(phase, 'done', done?.(value));
      return value;
    } catch (error) {
      await status(phase, 'failed', error);
      report(phase, 'failed', error instanceof UserError ? error.message : undefined);
      throw error;
    }
  }
  let project: ProjectInfo | undefined;
  try { project = await loadProject(cwd); } catch { /* Outside an app, setup prepares only the tools. */ }
  if (!hasIosApp(project)) project = undefined;
  const ready = setupNeeds(options, cwd);
  let archive = input.xcode ? path.resolve(cwd, input.xcode) : !ready.sdk ? await findDownloadedXcode() : undefined;
  const needsDownload = !ready.sdk && !archive;
  const needsSigning = !!project && (!!input.appleLogin || !ready.signing);
  // A free Apple Account stops at the sign-in, after the long tools step: say so first.
  if (input.appleLogin || needsDownload || needsSigning) log(ctx, 'info', 'Building on this PC needs a paid Apple Developer Program membership (US$99 a year). A free Apple Account can’t sign apps here yet.');

  // 1. Tools first: no sign-in needed, and the longest step on a new PC.
  const output = (text: string, stream: 'stdout' | 'stderr') => ctx.emit({ type: 'tool-output', text, stream });
  const distro = await track('wsl', () => withStep(ctx, 'Preparing the CapMac WSL environment', 'deps', () => ensureManagedWslDistro({ distro: options.distro, signal, onOutput: output })));
  const executor = new WslExecutor(distro);
  const installed = await track('dependencies', () => withStep(ctx, 'Preparing compilers and iPhone tools', 'deps', () => bootstrapWslDependencies(executor, {
    signal, onOutput: output, swift: options.swift, python: options.python,
  })));
  options = { ...options, ...installed, distro };
  await saveWslOptions(options, cwd);
  // Windows reaches the iPhone over USB through Apple's own device server.
  const devices = await track('apple-devices', async () => {
    if (await startAppleDeviceServer(signal) !== 'missing') return 'running';
    const install = await ctx.prompter.confirm({
      message: 'Install Apple Devices from the Microsoft Store?', confirmLabel: 'Install', defaultYes: true,
      detail: 'Windows needs this free app from Apple to talk to your iPhone over USB.',
    });
    if (!install) return 'skipped';
    await withStep(ctx, 'Installing Apple Devices', 'deps', () => installAppleDevices(signal));
    return startAppleDeviceServer(signal);
  }, (state) => (state === 'skipped' ? 'Not installed' : undefined));
  if (devices === 'skipped') log(ctx, 'info', 'Skipped Apple Devices. Install it from the Microsoft Store before running on your iPhone.');

  // 2. One Apple sign-in covers signing and the Xcode download: on Apple's website, where
  // CapMac then does everything, or here with a password (the certificate may be by hand).
  if (input.appleLogin || needsDownload || needsSigning) {
    const account = await track('apple-sign-in', async () => {
      const choice = await chooseAppleSignIn(ctx);
      if (choice.way === 'website') return signInOnAppleWebsite(ctx, { signal, fresh: choice.fresh });
      log(ctx, 'info', 'Sign in to Apple. Apple then sends a verification code to your devices. Your password is not saved.');
      return loginAppleAccount(ctx, { signal });
    }, (session) => session.team.name);
    try {
      if (needsSigning && project) {
        await track('signing', async () => {
          const targets = await withStep(ctx, 'Reading the app’s signing settings', 'deps', () => readSigningTargets(project!, executor, {
            ruby: options.ruby, scheme: options.scheme, configuration: options.configuration, signal,
          }));
          // A plugged-in iPhone the team doesn't know yet is registered with the profiles.
          const connected = await listWslDevices({ python: options.python, signal }).catch(() => []);
          const signing = await setUpAutomaticSigning(account, targets, ctx, { signal, executor, connectedDevices: connected.map((device) => ({ udid: device.udid, name: device.name })) });
          options = { ...options, ...signing };
          await saveWslOptions(options, cwd);
          log(ctx, 'success', `iPhone signing is set up for ${targets.map((target) => target.bundleIdentifier).join(' and ')}.`);
        });
      } else if (project) report('signing', 'done', 'Already set up');
      else report('signing', 'skipped', 'Not in an app');
      if (needsDownload) {
        const download = await track('apple-catalog', () => withStep(ctx, `Finding Xcode ${MANAGED_XCODE_VERSION} on Apple’s download site`, 'deps', () => account.discoverXcodeDownload(MANAGED_XCODE_VERSION, signal)));
        const directory = path.join(os.homedir(), 'Downloads');
        await fs.mkdir(directory, { recursive: true });
        archive = path.join(directory, download.fileName);
        await track('apple-download', () => withStep(ctx, 'Downloading Xcode from Apple (about 3 GB)', 'deps', (step) => {
          let shown = 0;
          return account.downloadXcode(download, archive!, {
            signal, onProgress: (received, total, resumedFrom) => {
              // Chunks arrive many times a second: report a few times a second.
              const now = Date.now();
              if (now - shown < 250 && received !== total) return;
              shown = now;
              step.update(`${gigabytes(received)} GB${total ? ` of ${gigabytes(total)} GB` : ''}${resumedFrom ? ` · continued from ${gigabytes(resumedFrom)} GB` : ''}`, total ? received / total : undefined);
              ctx.emit({ type: 'wsl-setup', phase: 'apple-download', state: 'running', bytes: { received, ...(total ? { total } : {}), ...(resumedFrom ? { resumedFrom } : {}) } });
            },
          });
        }));
      } else {
        // A step done earlier shows as done, not as "not needed".
        report('apple-catalog', 'skipped');
        report('apple-download', 'done', archive ? 'Already downloaded' : 'Already in place');
      }
    } finally { account.close(); }
  } else {
    for (const phase of ['apple-sign-in', 'apple-catalog'] as const) report(phase, 'skipped', 'Not needed');
    if (project) report('signing', 'done', 'Already set up');
    else report('signing', 'skipped', 'Not in an app');
    report('apple-download', 'done', archive ? 'Already downloaded' : 'Already in place');
  }

  // 3. Only the iPhone SDK and Swift resources are taken from the archive.
  if (archive) {
    const sdk = await track('sdk-import', () => withStep(ctx, 'Extracting the iPhone SDK and Swift resources', 'deps', (step) => setupSDKFromXcode(executor, archive!, {
      signal, onOutput: output, onProgress: (fraction) => {
        step.update(`${Math.round(fraction * 100)}%`, fraction);
        ctx.emit({ type: 'wsl-setup', phase: 'sdk-import', state: 'running', fraction });
      },
    })));
    options = { ...options, sdk: sdk.sdkPath, swiftResources: sdk.swiftResourcePath, xcodeVersion: sdk.xcodeVersion, sdkImporter: String(SDK_IMPORT_VERSION) };
    await saveWslOptions(options, cwd);
  } else report('sdk-import', 'done', 'Already in place');
  await status('complete', 'complete');
  report('complete', 'done');
  log(ctx, 'success', `Saved this computer's setup to ${settingsPath(cwd)}.`);
  if (!project) log(ctx, 'info', 'Run `capmac wsl setup` again inside your app’s folder to set up iPhone signing for it.');
  log(ctx, 'info', 'Next: plug in your iPhone and run `capmac wsl run`.');
}
