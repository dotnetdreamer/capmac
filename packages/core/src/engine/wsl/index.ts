/** Local WSL execution: no MacLink, SSH session, or xtool dependency. */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'node:fs';
import { log, throwIfAborted, withStep, type EngineContext, type StepHandle } from '../context.js';
import { startDevServer, type DevServer } from '../devserver.js';
import { CancelledError, isCancelled, toErrorInfo, UserError } from '../errors.js';
import { buildWeb, skipWebBuild } from '../pipeline.js';
import { loadProject, type ProjectInfo } from '../project.js';
import { watchNativeChanges } from '../watch.js';
import type { WslBuildPlan } from './compiler.js';
import { findCocoaPodsDirectory, inspectCocoaPods, prepareCocoaPodsProject } from './cocoapods.js';
import { buildNativeWithToolchain } from './native-compiler.js';
import { prepareXcodeProject } from './xcode.js';
import { prepareFlutterIos, type WslFlutterMode } from './flutter.js';
import { dropReactNativePods, prepareReactNativeIos, reactNativeWorkDir } from './react-native.js';
import { ensureIosFolder } from '../react-native/mac.js';
import { ReactNativeLogClassifier } from '../react-native/logs.js';
import { startMetro, type MetroServer } from '../react-native/metro.js';
import { classifyReactNativeChange, metroLaunchArgs, needsNativeRebuild } from '../../shared/react-native.js';
import { classifyFlutterChange } from '../flutter/changes.js';
import { flutterLogEntry } from '../flutter/runner.js';
import { watchWrites } from '../watch.js';
import { inspectWslResourceTools, installWslResourceTools } from './resources.js';
import {
  DEVELOPER_MODE_STEPS, ensureWslWifiPairing, inspectWslDeviceTools, installWslApp, launchWslApp, listWslDevices, selectWslDevice, stopWslApp, streamWslDeviceLogs,
  waitForDeveloperMode, wslDeviceTarget, type WslDevice,
} from './device.js';
import { chooseLiveHost, startWslLiveRelay } from './live.js';
import { loadWslOptions, saveWslOptions, settingsPath, validateWslOptions, type WslOptions } from './settings.js';
import { inspectWslToolchain, WslExecutor, type WslToolchainConfig, type WslToolchainReport } from './toolchain.js';
import { guidedWslSetup } from './setup.js';
import { setupSDKFromXcode } from './sdk.js';
import { SDK_IMPORT_VERSION } from './sdk-runtime.js';
import { savedCertificatePassword } from './apple-auto-signing.js';
import { inspectAppleDeviceServer, requireAppleDeviceServer } from './apple-devices.js';

export type { WslOptions } from './settings.js';
export type { WslBuildPlan } from './compiler.js';
export { DEVELOPER_MODE_STEPS, listWslDevices, wslDeviceTarget } from './device.js';
export { readWslSetupStatus, wslSetupState, type WslSetupState, type WslSetupStatus } from './setup.js';
export { inspectAppleDeviceServer, startAppleDeviceServer, type AppleDeviceServerState } from './apple-devices.js';
export { loadWslOptions } from './settings.js';

export interface WslCheck { id: string; level: 'ok' | 'warn' | 'fail' | 'info'; label: string; detail?: string; fix?: string }
export interface WslDoctorResult { ready: boolean; checks: WslCheck[] }
export interface WslBuildResult { appPath: string; ipaPath: string; bundleId: string; processName?: string; signed?: boolean }

/** The builder's output: all of it with --verbose, and its own notes ("capmac note: …", such as a resource built differently) for everyone. */
function builderOutput(ctx: EngineContext): (text: string, stream: 'stdout' | 'stderr') => void {
  return (text, stream) => {
    ctx.emit({ type: 'tool-output', text, stream });
    for (const match of text.matchAll(/^\s*capmac note: (.+)$/gm)) log(ctx, 'info', match[1]!.trim());
  };
}

function toolchainConfig(options: WslOptions, native = false): WslToolchainConfig {
  return { distro: options.distro, native, sdkPath: options.sdk, swiftcPath: options.swift, linkerPath: options.linker, signerPath: options.signer, swiftResourcePath: options.swiftResources,
    clangPath: options.clang, archivePath: options.archive, lipoPath: options.lipo, stripPath: options.strip,
    actoolPath: options.actool, ibtoolPath: options.ibtool, momcPath: options.momc, xcstringsPath: options.xcstrings };
}

async function projectAndOptions(input: WslOptions): Promise<{ project: ProjectInfo; options: WslOptions }> {
  validateWslOptions(input);
  const project = await loadProject(input.cwd ?? process.cwd());
  if (project.kind === 'electron') throw new UserError('An Electron app runs on a Mac’s desktop: it has no iPhone app to build on this PC.');
  if (project.kind === 'flutter' && !project.flutter?.platforms.ios) throw new UserError('This Flutter app has no iOS app.', 'Add one with `flutter create --platforms ios .` in its folder.');
  if (project.kind === 'react-native' && !project.reactNative?.platforms.ios) throw new UserError('This React Native app has no iOS app.', 'Its Windows app runs on this PC with `capmac run --app windows`.');
  const options = await loadWslOptions(input, project.capDir);
  return { project, options };
}

export async function doctorWsl(input: WslOptions, _ctx: EngineContext, signal: AbortSignal): Promise<WslDoctorResult> {
  validateWslOptions(input);
  let cwd = path.resolve(input.cwd ?? process.cwd());
  let project: ProjectInfo | undefined;
  try { project = await loadProject(cwd); cwd = project.capDir; } catch { /* Setup can be checked before opening a project. */ }
  const options = await loadWslOptions(input, cwd);
  const [toolchain, device, server] = await Promise.all([
    inspectWslToolchain(toolchainConfig(options, project?.kind === 'capacitor' || project?.kind === 'flutter' || project?.kind === 'react-native'), { signal }),
    inspectWslDeviceTools({ python: options.python, signal }),
    inspectAppleDeviceServer(signal),
  ]);
  const checks: WslCheck[] = toolchain.checks.map((check, index) => ({ id: `wsl-${index}`, level: check.ok ? 'ok' : 'fail', label: check.name, detail: check.message,
    fix: check.ok ? undefined : 'Run `capmac wsl setup`; supply the matching SDK/tool paths, then check again.' }));
  checks.push({ id: 'device-tools', level: device.ready ? 'ok' : 'fail', label: 'Windows iPhone tools', detail: device.ready ? `Python ${device.pythonVersion} · pymobiledevice3 ${device.pymobiledevice3Version}` : device.issues.join('; '), fix: device.ready ? undefined : 'On Windows: py -3 -m pip install pymobiledevice3==11.32.0' });
  checks.push({ id: 'apple-devices', level: server === 'missing' ? 'fail' : 'ok', label: 'iPhone connection (Apple Devices)',
    detail: server === 'running' ? 'Apple’s device server is running' : server === 'stopped' ? 'Starts by itself when you run on the iPhone' : 'Apple Devices is not installed',
    fix: server === 'missing' ? 'Run `capmac wsl setup` to install it, or install “Apple Devices” from the Microsoft Store.' : undefined });
  for (const [key, label] of [['certificate', 'Signing certificate (.p12)'], ['profile', 'Development provisioning profile']] as const) {
    const file = options[key] ? path.resolve(cwd, options[key]!) : undefined;
    checks.push({ id: key, level: file && existsSync(file) ? 'ok' : 'fail', label, detail: file ?? 'not configured', fix: 'Run `capmac wsl setup` in your app’s folder: it sets up signing with your Apple Account. To use your own files, add --certificate <file.p12> --profile <file.mobileprovision>.' });
  }
  if (project?.kind === 'react-native') {
    checks.push({ id: 'project', level: project.reactNative?.platforms.ios ? 'ok' : 'fail', label: 'React Native iOS app',
      detail: project.reactNative?.platforms.ios ? 'CocoaPods runs in WSL with React Native’s prebuilt core; the first build also gets Node.js for WSL. A debug build loads its JavaScript from Metro on this PC over Wi-Fi.' : 'This React Native app has no ios/ folder.' });
  } else if (project?.kind === 'flutter') {
    checks.push({ id: 'project', level: project.flutter?.platforms.ios ? 'ok' : 'fail', label: 'Flutter iOS app',
      detail: project.flutter?.platforms.ios ? 'Flutter compiles the Dart code in WSL; the first build also gets Flutter for Linux, Dart’s iPhone compiler (built once, about 5 minutes) and Flutter’s iPhone engine.' : 'This Flutter app has no ios/ folder.',
      fix: project.flutter?.platforms.ios ? undefined : 'Add it with `flutter create --platforms ios .`' });
  } else if (project) {
    try {
      if (project.iosPackageManager === 'CocoaPods') {
        checks.push({ id: 'project', level: 'ok', label: 'Capacitor CocoaPods project', detail: 'Builds the original native application and the dependency graph produced by CocoaPods.' });
        if (toolchain.distro) {
          const executor = new WslExecutor(toolchain.distro);
          const [directory, rootDirectory] = await Promise.all([
            findCocoaPodsDirectory(project).then((directory) => executor.path(directory, signal)),
            executor.path(project.syncRoot, signal),
          ]);
          const reports = await Promise.all([
            inspectCocoaPods(executor, { rubyPath: options.ruby, podPath: options.pod, directory, rootDirectory, signal }),
            inspectWslResourceTools(executor, { ...toolchain.tools, ...toolchainConfig(options), sdkPath: options.sdk ?? '', swiftcPath: options.swift ?? 'swiftc', signerPath: options.signer ?? 'zsign', linkerPath: options.linker ?? 'ld64.lld' }, { signal }),
          ]);
          for (const [index, report] of reports.entries()) for (const [item, check] of report.checks.entries()) checks.push({ id: `native-${index}-${item}`, level: check.ok ? 'ok' : 'fail', label: check.name, detail: check.message });
        }
      } else {
        if (project.iosPackageManager !== 'SPM') throw new UserError('No CocoaPods or SPM iOS project was detected.');
        checks.push({ id: 'project', level: 'info', label: 'Capacitor SPM project', detail: 'Imports the original application, extensions, and locked Swift packages. The native build validates their toolchain compatibility.' });
        if (toolchain.distro) {
          const executor = new WslExecutor(toolchain.distro);
          const ruby = await executor.run([options.ruby ?? 'ruby', '-rxcodeproj', '-e', 'puts Xcodeproj::VERSION'], { signal, allowFailure: true });
          checks.push({ id: 'xcode-parser', level: ruby.code === 0 ? 'ok' : 'fail', label: 'Ruby Xcode project parser', detail: ruby.code === 0 ? ruby.stdout.trim() : 'Install the xcodeproj gem inside WSL.' });
          const resources = await inspectWslResourceTools(executor, toolchain.tools ?? toolchainConfig(options), { signal });
          for (const [index, check] of resources.checks.entries()) checks.push({ id: `spm-resource-${index}`, level: check.ok ? 'ok' : 'fail', label: check.name, detail: check.message });
        }
      }
    } catch (error) { checks.push({ id: 'project', level: 'fail', label: 'Project compatibility', detail: (error as Error).message, fix: (error as UserError).hint }); }
  } else checks.push({ id: 'project', level: 'info', label: 'Project', detail: 'Run this command in your Capacitor application to check its compatibility.' });
  return { ready: checks.every((check) => check.level !== 'fail'), checks };
}

/** `guided`: someone is there to answer (a terminal, or CapMac Studio), so setup does everything itself. */
export async function setupWsl(input: WslOptions, ctx: EngineContext, signal: AbortSignal, runtime: { guided?: boolean } = {}): Promise<void> {
  throwIfAborted(signal);
  validateWslOptions(input);
  let cwd = path.resolve(input.cwd ?? process.cwd());
  try { cwd = (await loadProject(cwd)).capDir; } catch { /* Setup outside a project still gives the guide. */ }
  if ((runtime.guided && ctx.prompter.interactive) || input.appleLogin) {
    return guidedWslSetup(input, cwd, ctx, signal);
  }
  await saveWslOptions(input, cwd);
  if (input.xcode) {
    const options = await loadWslOptions(input, cwd);
    const report = await inspectWslToolchain(toolchainConfig(options), { signal });
    if (!report.distro) throw new UserError('The Xcode archive importer needs a WSL development distribution.', 'Run `capmac wsl setup` in an interactive PowerShell terminal.');
    const sdk = await withStep(ctx, 'Extracting the iPhone SDK and Swift resources', 'deps', (step) => setupSDKFromXcode(new WslExecutor(report.distro!), path.resolve(cwd, input.xcode!), {
      signal, onOutput: (text, stream) => ctx.emit({ type: 'tool-output', text, stream }),
      onProgress: (fraction) => step.update(`${Math.round(fraction * 100)}%`, fraction),
    }));
    await saveWslOptions({ ...options, sdk: sdk.sdkPath, swiftResources: sdk.swiftResourcePath, xcodeVersion: sdk.xcodeVersion, sdkImporter: String(SDK_IMPORT_VERSION) }, cwd);
  }
  if (input.installResources) {
    const options = await loadWslOptions(input, cwd);
    const report = await inspectWslToolchain(toolchainConfig(options), { signal });
    if (!report.distro) throw new UserError('Install a development WSL distribution before installing resource tools.', 'Run `wsl --install -d Ubuntu-24.04`, complete its first launch, and retry.');
    const installed = await withStep(ctx, 'Installing native resource compilers in WSL', 'deps', () => installWslResourceTools(new WslExecutor(report.distro!), {
      signal, swiftPath: options.swift?.replace(/swiftc$/, 'swift'), onOutput: (text, stream) => ctx.emit({ type: 'tool-output', text, stream }),
    }));
    await saveWslOptions({ ...options, actool: installed.actoolPath, ibtool: installed.ibtoolPath, momc: installed.momcPath, xcstrings: installed.xcstringsPath }, cwd);
  }
  log(ctx, 'success', `Saved machine-local setup to ${settingsPath(cwd)}.`);
  for (const message of [
    '1. Install a development WSL distribution, e.g. `wsl --install -d Ubuntu-24.04`. Docker Desktop is not a build distribution.',
    '2. In that distribution install a matching Linux Swift toolchain, LLVM ld64.lld/llvm-ar, Clang, Python 3, OpenSSL, and zsign. CocoaPods projects also use Ruby and CocoaPods (`gem install cocoapods --no-document`).',
    '3. Supply your extracted iPhoneOS SDK and matching Darwin Swift resources: `capmac wsl setup --sdk <SDK-path> --swift-resources <resources-path>`. Apple SDK licensing applies; CapMac does not redistribute it.',
    '4. On Windows install Apple Devices for USB drivers and run `py -3 -m pip install pymobiledevice3==11.32.0`.',
    '5. Save your Apple development .p12 and device provisioning profile paths with --certificate and --profile. Passwords are requested at build time or read from CAPMAC_IOS_PASSWORD.',
    '6. For CocoaPods apps run `capmac wsl setup --install-resources` once to install the open-source asset/storyboard/model/string compilers. Then connect and trust the iPhone, enable Developer Mode, run `capmac wsl doctor` and `capmac dev --backend wsl`.',
  ]) log(ctx, 'info', message);
}

async function password(options: WslOptions, ctx: EngineContext, capDir: string): Promise<string> {
  const name = options.passwordEnv ?? 'CAPMAC_IOS_PASSWORD';
  if (process.env[name] !== undefined) return process.env[name]!;
  // A certificate that setup made keeps its password protected for this Windows user.
  const saved = options.certificate ? await savedCertificatePassword(path.resolve(capDir, options.certificate)) : undefined;
  if (saved !== undefined) return saved;
  if (!ctx.prompter.interactive) throw new UserError('The signing certificate password is not available.', `Set ${name}, including an empty value for a certificate with an empty password, or use an interactive terminal.`);
  return ctx.prompter.password({ purpose: 'signing', message: 'Password for the Apple signing certificate (.p12):' });
}

async function checkedToolchain(options: WslOptions, ctx: EngineContext, signal: AbortSignal, native = false): Promise<WslToolchainReport & { distro: string; tools: NonNullable<WslToolchainReport['tools']> }> {
  const report = await withStep(ctx, 'Checking this PC’s build tools', 'other', () => inspectWslToolchain(toolchainConfig(options, native), { signal, reuseProbe: true, onOutput: (text, stream) => ctx.emit({ type: 'tool-output', text, stream }) }));
  if (!report.ready || !report.distro || !report.tools) throw new UserError('The WSL iOS toolchain is not ready.', 'Run `capmac wsl doctor` or `capmac wsl setup` for the exact missing requirements.', report.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.message}`));
  return report as WslToolchainReport & { distro: string; tools: NonNullable<WslToolchainReport['tools']> };
}

/** A Flutter app's build mode here: release, or profile when asked (debug builds need Xcode's debugger on the iPhone). */
function flutterModeOf(options: WslOptions): WslFlutterMode {
  if (options.mode === 'debug') throw new UserError('On this PC a Flutter app runs on the iPhone in release or profile mode.', 'Debug builds need Xcode’s debugger: use `--mode profile` here, or a paired Mac for debug runs and hot reload.');
  if (options.mode && options.mode !== 'release' && options.mode !== 'profile') throw new UserError(`Unknown Flutter mode "${options.mode}".`, 'Use release or profile.');
  return options.mode === 'profile' || options.configuration === 'Profile' ? 'profile' : 'release';
}

/** A Flutter app's iOS app: Flutter's work done in WSL (see flutter.ts), then the Runner project built and signed like any app. */
async function buildFlutterProject(project: ProjectInfo, options: WslOptions, ctx: EngineContext, signal: AbortSignal, cachedPassword?: string): Promise<WslBuildResult> {
  const mode = flutterModeOf(options);
  const toolchain = await checkedToolchain(options, ctx, signal, true);
  if (!options.unsigned && (!options.certificate || !options.profile)) throw new UserError('Apple development signing is not configured.', 'Run `capmac wsl setup` in your app’s folder: it sets up signing with your Apple Account. Or build with --unsigned to check the build first.');
  const signing: WslBuildPlan['signing'] = {
    certificatePath: options.certificate ? path.resolve(project.capDir, options.certificate) : '',
    provisioningProfilePath: options.profile ? path.resolve(project.capDir, options.profile) : '',
    password: options.unsigned ? '' : cachedPassword ?? await password(options, ctx, project.capDir),
    extensionProfiles: Object.fromEntries(Object.entries(options.extensionProfiles ?? {}).map(([id, file]) => [id, path.resolve(project.capDir, file)])),
  };
  const generated = path.join(project.capDir, '.capmac', 'wsl');
  const executor = new WslExecutor(toolchain.distro);
  return withPodsBuildLock(generated, async () => {
    if (options.clean) await withStep(ctx, 'Removing earlier native build files', 'other', async () => {
      await fs.rm(path.join(generated, 'flutter-inputs'), { recursive: true, force: true });
      await executor.run(['sh', '-c', 'rm -rf "$HOME/.cache/capmac/module-cache" "$HOME/.cache/capmac/flutter-builds/$1"', 'sh', project.projectId], { signal, allowFailure: true });
    });
    const plan = await prepareFlutterIos(project, {
      executor, tools: toolchain.tools, directory: path.join(generated, 'flutter-inputs'), mode,
      outputDirectory: path.resolve(project.capDir, options.out ?? '.capmac/wsl/output'), signing, rubyPath: options.ruby, xcodeVersion: options.xcodeVersion,
    }, ctx, signal);
    const built = await withStep(ctx, options.unsigned ? 'Compiling the native app in WSL' : 'Building and signing the native app in WSL', 'build', () => buildNativeWithToolchain({ ...plan, unsigned: options.unsigned }, executor, toolchain.tools, {
      signal, onOutput: builderOutput(ctx),
    }));
    const result = { appPath: built.appPath, ipaPath: built.ipaPath, bundleId: built.bundleIdentifier, processName: built.executableName, signed: built.signed };
    await fs.writeFile(path.join(generated, 'last-build.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  });
}

/** The Xcode configuration of a React Native build here: Debug (JavaScript from Metro on this PC) unless asked otherwise. */
function reactNativeConfiguration(options: WslOptions): string {
  return options.configuration ?? (options.release ? 'Release' : 'Debug');
}

/** A React Native app's iOS app: CocoaPods in WSL with React Native's prebuilt core (see react-native.ts), then built and signed like any app. */
async function buildReactNativeProject(project: ProjectInfo, options: WslOptions, ctx: EngineContext, signal: AbortSignal, cachedPassword?: string): Promise<WslBuildResult> {
  project = await ensureIosFolder(project, ctx, signal);
  const toolchain = await checkedToolchain(options, ctx, signal, true);
  if (!options.unsigned && (!options.certificate || !options.profile)) throw new UserError('Apple development signing is not configured.', 'Run `capmac wsl setup` in your app’s folder: it sets up signing with your Apple Account. Or build with --unsigned to check the build first.');
  const signing: WslBuildPlan['signing'] = {
    certificatePath: options.certificate ? path.resolve(project.capDir, options.certificate) : '',
    provisioningProfilePath: options.profile ? path.resolve(project.capDir, options.profile) : '',
    password: options.unsigned ? '' : cachedPassword ?? await password(options, ctx, project.capDir),
    extensionProfiles: Object.fromEntries(Object.entries(options.extensionProfiles ?? {}).map(([id, file]) => [id, path.resolve(project.capDir, file)])),
  };
  // Outside the project: Metro watches its folder (see reactNativeWorkDir).
  const generated = reactNativeWorkDir(project);
  const executor = new WslExecutor(toolchain.distro);
  return withPodsBuildLock(generated, async () => {
    if (options.clean) await withStep(ctx, 'Removing earlier native build files', 'other', async () => {
      await dropReactNativePods(path.join(generated, 'rn-inputs'), project.projectId, executor, signal);
      await fs.rm(path.join(generated, 'rn-inputs'), { recursive: true, force: true });
      await executor.run(['sh', '-c', 'rm -rf "$HOME/.cache/capmac/module-cache"'], { signal, allowFailure: true });
    });
    const plan = await prepareReactNativeIos(project, {
      executor, tools: toolchain.tools, directory: path.join(generated, 'rn-inputs'), configuration: reactNativeConfiguration(options),
      outputDirectory: options.out ? path.resolve(project.capDir, options.out) : path.join(generated, 'output'), signing, rubyPath: options.ruby, podPath: options.pod, xcodeVersion: options.xcodeVersion,
    }, ctx, signal);
    const built = await withStep(ctx, options.unsigned ? 'Compiling the native app in WSL' : 'Building and signing the native app in WSL', 'build', () => buildNativeWithToolchain({ ...plan, unsigned: options.unsigned }, executor, toolchain.tools, {
      signal, onOutput: builderOutput(ctx),
    }));
    const result = { appPath: built.appPath, ipaPath: built.ipaPath, bundleId: built.bundleIdentifier, processName: built.executableName, signed: built.signed };
    await fs.writeFile(path.join(generated, 'last-build.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  });
}

async function buildProject(project: ProjectInfo, options: WslOptions, ctx: EngineContext, signal: AbortSignal, liveUrl?: string, cachedPassword?: string): Promise<WslBuildResult> {
  throwIfAborted(signal);
  if (project.kind === 'flutter') return buildFlutterProject(project, options, ctx, signal, cachedPassword);
  if (project.kind === 'react-native') return buildReactNativeProject(project, options, ctx, signal, cachedPassword);
  const pods = project.iosPackageManager === 'CocoaPods';
  if (!pods && project.iosPackageManager !== 'SPM') throw new UserError('No CocoaPods or SPM iOS project was detected.');
  const toolchain = await checkedToolchain(options, ctx, signal, true);
  if (!options.unsigned && (!options.certificate || !options.profile)) throw new UserError('Apple development signing is not configured.', 'Use `capmac wsl setup --certificate <file.p12> --profile <file.mobileprovision>`, or build with --unsigned to validate compilation first.');
  const signing: WslBuildPlan['signing'] = {
    certificatePath: options.certificate ? path.resolve(project.capDir, options.certificate) : '',
    provisioningProfilePath: options.profile ? path.resolve(project.capDir, options.profile) : '',
    password: options.unsigned ? '' : cachedPassword ?? await password(options, ctx, project.capDir),
    extensionProfiles: Object.fromEntries(Object.entries(options.extensionProfiles ?? {}).map(([id, file]) => [id, path.resolve(project.capDir, file)])),
  };
  if (options.webBuild === false) skipWebBuild(ctx);
  else if (!liveUrl || !existsSync(path.join(project.capDir, project.webDir, 'index.html'))) await buildWeb(project, ctx, signal);
  const generated = path.join(project.capDir, '.capmac', 'wsl');
  const executor = new WslExecutor(toolchain.distro);
  return withPodsBuildLock(generated, async () => {
      // Each build compiles in a fresh folder; a clean one also drops the prepared project and the compilers' module cache.
      if (options.clean) await withStep(ctx, 'Removing earlier native build files', 'other', async () => {
        await fs.rm(path.join(generated, pods ? 'pods-inputs' : 'xcode-inputs'), { recursive: true, force: true });
        await executor.run(['sh', '-c', 'rm -rf "$HOME/.cache/capmac/module-cache"'], { signal, allowFailure: true });
      });
      const prepare = pods ? prepareCocoaPodsProject : prepareXcodeProject;
      const plan = await withStep(ctx, pods ? 'Resolving CocoaPods and the native project' : 'Importing the native project and locked Swift packages', 'deps', () => prepare(project, {
        directory: path.join(generated, pods ? 'pods-inputs' : 'xcode-inputs'), executor, tools: toolchain.tools,
        configuration: options.configuration ?? (options.release ? 'Release' : 'Debug'),
        outputDirectory: path.resolve(project.capDir, options.out ?? '.capmac/wsl/output'), signing, liveUrl,
        rubyPath: options.ruby, podPath: options.pod, scheme: options.scheme, xcodeVersion: options.xcodeVersion,
      }, ctx, signal));
      const built = await withStep(ctx, options.unsigned ? 'Compiling the native app in WSL' : 'Building and signing the native app in WSL', 'build', () => buildNativeWithToolchain({ ...plan, unsigned: options.unsigned }, executor, toolchain.tools, {
        signal, onOutput: builderOutput(ctx),
      }));
      const result = { appPath: built.appPath, ipaPath: built.ipaPath, bundleId: built.bundleIdentifier, processName: built.executableName, signed: built.signed };
      await fs.writeFile(path.join(generated, 'last-build.json'), `${JSON.stringify(result, null, 2)}\n`);
      return result;
    });
}

/** A CocoaPods sandbox is cached and mutable; only one build may own it at a time. */
async function withPodsBuildLock<T>(generated: string, build: () => Promise<T>): Promise<T> {
  await fs.mkdir(generated, { recursive: true });
  const file = path.join(generated, 'pods-build.lock');
  let lock;
  try { lock = await fs.open(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = await fs.readFile(file, 'utf8').then((text) => JSON.parse(text) as { pid: number }).catch(() => undefined);
    let alive = true;
    if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (err) { alive = (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
    }
    if (alive) throw new UserError('Another CocoaPods build owns this project workspace.', 'Wait for that build to finish before starting another one.');
    await fs.unlink(file);
    return withPodsBuildLock(generated, build);
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await build(); }
  finally { await lock.close(); await fs.unlink(file); }
}

export async function buildWsl(input: WslOptions, ctx: EngineContext, signal: AbortSignal): Promise<WslBuildResult> {
  const { project, options } = await projectAndOptions(input);
  return buildProject(project, options, ctx, signal);
}

async function chooseDevice(options: WslOptions, ctx: EngineContext, signal: AbortSignal): Promise<WslDevice> {
  const device = await pickDevice(options, ctx, signal);
  ctx.emit({ type: 'target', target: wslDeviceTarget(device) });
  // Said now, so it can be turned on while the app builds.
  if (device.developerMode === 'disabled') log(ctx, 'warn', `Developer Mode is off on ${device.name}. Your app opens after you turn it on.`, DEVELOPER_MODE_STEPS);
  return device;
}

async function pickDevice(options: WslOptions, ctx: EngineContext, signal: AbortSignal): Promise<WslDevice> {
  const deviceOptions = { python: options.python, signal };
  await requireAppleDeviceServer(signal);
  if (options.target || !ctx.prompter.interactive) return selectWslDevice(options.target, deviceOptions);
  const devices = await listWslDevices(deviceOptions);
  if (devices.length < 2) return devices[0] ?? selectWslDevice(undefined, deviceOptions);
  const hint = (device: WslDevice) => [device.productVersion, device.paired === false ? 'not trusted' : device.developerMode === 'disabled' ? 'Developer Mode off' : undefined].filter(Boolean).join(' · ') || undefined;
  return ctx.prompter.choose({ message: 'Run on which iPhone?', items: devices.map((device) => ({ label: device.name, hint: hint(device), value: device })) });
}

async function deploy(built: WslBuildResult, device: WslDevice, options: WslOptions, ctx: EngineContext, signal: AbortSignal, launchArgs: string[] = []): Promise<void> {
  if (built.signed === false) throw new UserError('An unsigned build cannot be installed on an iPhone.', 'Configure signing and rebuild without --unsigned.');
  const hooks = { python: options.python, signal, onLog: (text: string) => ctx.emit({ type: 'tool-output' as const, stream: 'stdout' as const, text }) };
  // A locked iPhone opens no apps, and an asleep one leaves the Wi-Fi: wait for the user, however long it takes.
  const unlock = (step: StepHandle, then: string) => () => {
    step.update(`Unlock your iPhone to ${then}`);
    log(ctx, 'info', `Unlock ${device.name} to ${then}. CapMac goes on as soon as you do.`);
  };
  await withStep(ctx, `Installing on ${device.name}`, 'install', (step) => installWslApp(built.ipaPath, device, { ...hooks, onLocked: unlock(step, 'install the app') }));
  // Once over the cable, the iPhone is paired for Wi-Fi too (no prompt on it), so later runs need no cable.
  const wifi = await ensureWslWifiPairing(device, hooks).catch((error: unknown) => {
    log(ctx, 'note', `${device.name} could not be set up for Wi-Fi runs: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  });
  if (wifi) log(ctx, 'info', `${device.name} can now also run your app over Wi-Fi, without the cable.`);
  await withStep(ctx, `Launching on ${device.name}`, 'launch', async (step) => {
    // iOS opens the app only with Developer Mode on: wait while the user turns it on, however long it takes.
    if (device.developerMode === 'disabled') {
      step.update('Turn on Developer Mode on your iPhone');
      log(ctx, 'info', `Waiting for Developer Mode on ${device.name}.`);
      await waitForDeveloperMode(device, hooks);
      device.developerMode = 'enabled';
      ctx.emit({ type: 'target', target: wslDeviceTarget(device) });
      log(ctx, 'info', `Developer Mode is on. Opening the app on ${device.name}.`);
      step.update(`Launching on ${device.name}`);
    }
    await launchWslApp(built.bundleId, device, { ...hooks, args: launchArgs, onLocked: unlock(step, 'open the app') });
  });
  ctx.emit({ type: 'app', state: 'running', bundleId: built.bundleId, target: device.name });
}

/** A Flutter app's Dart print() reaches the iPhone's log as "flutter: …": those lines are the console's. */
function appLogEntry(text: string, flutter: boolean) {
  const dart = flutter ? /\bflutter: (.*)$/.exec(text) : null;
  return (dart ? flutterLogEntry(`flutter: ${dart[1]}`) : null) ?? { text, kind: 'native' as const, level: 'info' as const, stream: 'stdout' as const, ts: Date.now() };
}

function logOptions(options: WslOptions, ctx: EngineContext, signal: AbortSignal, processName = 'App', flutter = false, reactNative?: ReactNativeLogClassifier) {
  return {
    python: options.python, signal, processName,
    onLog: (text: string) => {
      // A React Native app's lines: its RCTLog ones read (its console comes from Metro in a debug build).
      const entry = reactNative ? reactNative.classify(text.replace(/^.*?\b(?=\d{4}-\d{2}-\d{2} |\[(?:trace|info|warn|error|fatal)\]\[tid:)/, '')) : appLogEntry(text, flutter);
      if (entry) ctx.emit({ type: 'app-log' as const, entry });
    },
    // Over Wi-Fi, a locked or asleep iPhone drops its logs until it is unlocked again.
    onLocked: () => log(ctx, 'info', 'Unlock your iPhone to see the app’s logs. They come back as soon as you do.'),
  };
}

/**
 * Metro for an iPhone on this PC's Wi-Fi: Metro itself listens on this PC's
 * loopback only (no Windows Firewall prompt for Node.js); CapMac's relay
 * carries it, its WebSockets too, on the address the iPhone reaches.
 */
async function metroForIphone(project: ProjectInfo, options: WslOptions, ctx: EngineContext, signal: AbortSignal): Promise<{ metro: MetroServer; relay: Awaited<ReturnType<typeof startWslLiveRelay>>; hostPort: string }> {
  const metro = await startMetro(project, { signal }, ctx);
  try {
    const relay = await startWslLiveRelay(new URL(`http://127.0.0.1:${metro.port}`), await chooseLiveHost(options.liveHost, ctx));
    const hostPort = new URL(relay.url).host;
    log(ctx, 'info', `The app loads its JavaScript from Metro at ${hostPort}: keep the iPhone on this PC's Wi-Fi network, and allow CapMac through Windows Firewall if it asks.`);
    return { metro, relay, hostPort };
  } catch (err) {
    await metro.stop();
    throw err;
  }
}

/** `capmac run` for a React Native app on this PC: Metro (a debug build), build, install and open, then its logs. */
async function runWslReactNative(project: ProjectInfo, options: WslOptions, ctx: EngineContext, signal: AbortSignal): Promise<void> {
  const debug = /debug/i.test(reactNativeConfiguration(options));
  const device = await chooseDevice(options, ctx, signal);
  let served: Awaited<ReturnType<typeof metroForIphone>> | null = null;
  try {
    if (debug) served = await metroForIphone(project, options, ctx, signal);
    else ctx.emit({ type: 'phase-skipped', phase: 'devserver', reason: 'a release build carries its JavaScript' });
    const built = await buildProject(project, options, ctx, signal);
    await deploy(built, device, options, ctx, signal, served ? metroLaunchArgs(served.hostPort) : []);
    if (options.logs !== false) {
      try { await streamWslDeviceLogs(device, logOptions(options, ctx, signal, built.processName, false, new ReactNativeLogClassifier(debug))); }
      finally { await stopWslApp(built.bundleId, device, { python: options.python }).catch(() => undefined); }
    }
  } finally {
    await served?.relay.stop().catch(() => undefined);
    await served?.metro.stop().catch(() => undefined);
  }
}

/**
 * Live mode for a React Native app on this PC: a debug build on the iPhone
 * loads its JavaScript from Metro here, so every save shows at once (Fast
 * Refresh); a change to the packages or the iOS app's folder rebuilds it and
 * opens it again.
 */
async function devWslReactNative(project: ProjectInfo, options: WslOptions, ctx: EngineContext, signal: AbortSignal): Promise<void> {
  if (!/debug/i.test(reactNativeConfiguration(options))) throw new UserError('Live mode needs a debug build (its JavaScript comes from Metro).', 'Leave out --release, or use `capmac wsl run --release`.');
  const device = await chooseDevice(options, ctx, signal);
  await checkedToolchain(options, ctx, signal, true);
  const signingPassword = await password(options, ctx, project.capDir);
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  throwIfAborted(signal);
  signal.addEventListener('abort', abort, { once: true });
  let served: Awaited<ReturnType<typeof metroForIphone>> | null = null;
  let pending = false;
  let building = false;
  let first = true;
  let activeBuild: Promise<void> = Promise.resolve();
  let launched: WslBuildResult | undefined;
  let watcher: FSWatcher | undefined;
  try {
    served = await metroForIphone(project, options, ctx, lifetime.signal);
    const args = metroLaunchArgs(served.hostPort);
    const rebuild = async () => {
      building = true;
      try {
        do {
          pending = false;
          const fresh = await loadProject(project.capDir);
          const built = await buildProject(fresh, first ? options : { ...options, clean: false }, ctx, lifetime.signal, undefined, signingPassword);
          first = false;
          await deploy(built, device, options, ctx, lifetime.signal, args);
          launched = built;
        } while (pending && !lifetime.signal.aborted);
      } finally { building = false; }
    };
    if (options.watch !== false) watcher = watchWrites(project.syncRoot, (rel) => classifyReactNativeChange(rel, project.projectRel) !== 'ignore', (paths) => {
      const native = paths.some((rel) => needsNativeRebuild(classifyReactNativeChange(rel, project.projectRel), 'ios'));
      if (!native) {
        ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail: 'Sent to the app (Fast Refresh)' });
        return;
      }
      ctx.emit({ type: 'native-change', kinds: ['native'], paths });
      if (building) { pending = true; return; }
      activeBuild = rebuild().catch((error) => { if (!isCancelled(error)) ctx.emit({ type: 'error', error: toErrorInfo(error) }); });
    }, 300);
    activeBuild = rebuild();
    await activeBuild;
    const metroGone = served.metro.exited.then((code) => { throw new UserError(`Metro stopped (exit code ${code ?? 'unknown'}).`, 'The app needs it for its JavaScript: start live mode again.'); });
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (lifetime.signal.aborted) reject(new CancelledError());
      else lifetime.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    });
    const logs = options.logs === false ? cancelled : streamWslDeviceLogs(device, logOptions(options, ctx, lifetime.signal, launched?.processName, false, new ReactNativeLogClassifier(true)));
    await Promise.race([metroGone, logs, cancelled]);
  } finally {
    lifetime.abort();
    watcher?.close();
    await activeBuild.catch(() => undefined);
    signal.removeEventListener('abort', abort);
    await served?.relay.stop().catch(() => undefined);
    await served?.metro.stop().catch(() => undefined);
    if (launched) await stopWslApp(launched.bundleId, device, { python: options.python }).catch(() => undefined);
  }
}

export async function runWsl(input: WslOptions, ctx: EngineContext, signal: AbortSignal): Promise<void> {
  const { project, options } = await projectAndOptions(input);
  if (options.unsigned) throw new UserError('Use `capmac wsl build --unsigned` to validate compilation; running requires signing.');
  if (project.kind === 'react-native') return runWslReactNative(project, options, ctx, signal);
  const device = await chooseDevice(options, ctx, signal);
  const built = await buildProject(project, options, ctx, signal);
  await deploy(built, device, options, ctx, signal);
  if (options.logs !== false) {
    try { await streamWslDeviceLogs(device, logOptions(options, ctx, signal, built.processName, project.kind === 'flutter')); }
    finally { await stopWslApp(built.bundleId, device, { python: options.python }).catch(() => undefined); }
  }
}

/**
 * Live mode for a Flutter app on this PC: each save rebuilds the app and opens
 * it again on the iPhone. (Hot reload needs a debug build, and an iPhone runs
 * those only under Xcode's debugger: that is a paired Mac's.)
 */
async function devWslFlutter(project: ProjectInfo, options: WslOptions, ctx: EngineContext, signal: AbortSignal): Promise<void> {
  const device = await chooseDevice(options, ctx, signal);
  await checkedToolchain(options, ctx, signal, true);
  const signingPassword = await password(options, ctx, project.capDir);
  log(ctx, 'info', `Live on this PC: each save rebuilds ${project.appName} and opens it again on ${device.name}. Hot reload needs a paired Mac.`);
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  throwIfAborted(signal);
  signal.addEventListener('abort', abort, { once: true });
  let pending = false;
  let building = false;
  let first = true;
  let activeBuild: Promise<void> = Promise.resolve();
  let launched: WslBuildResult | undefined;
  let watcher: FSWatcher | undefined;
  const rebuild = async () => {
    building = true;
    try {
      do {
        pending = false;
        const fresh = await loadProject(project.capDir);
        const built = await buildProject(fresh, first ? options : { ...options, clean: false }, ctx, lifetime.signal, undefined, signingPassword);
        first = false;
        await deploy(built, device, options, ctx, lifetime.signal);
        launched = built;
      } while (pending && !lifetime.signal.aborted);
    } finally { building = false; }
  };
  try {
    if (options.watch !== false) watcher = watchWrites(project.syncRoot, (rel) => classifyFlutterChange(rel, project.projectRel) !== 'ignore', (paths) => {
      ctx.emit({ type: 'native-change', kinds: ['native'], paths });
      if (building) { pending = true; return; }
      activeBuild = rebuild().catch((error) => { if (!isCancelled(error)) ctx.emit({ type: 'error', error: toErrorInfo(error) }); });
    }, 300);
    activeBuild = rebuild();
    await activeBuild;
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (lifetime.signal.aborted) reject(new CancelledError());
      else lifetime.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    });
    const logs = options.logs === false ? cancelled : streamWslDeviceLogs(device, logOptions(options, ctx, lifetime.signal, launched?.processName, true));
    await Promise.race([logs, cancelled]);
  } finally {
    lifetime.abort();
    watcher?.close();
    await activeBuild.catch(() => undefined);
    signal.removeEventListener('abort', abort);
    if (launched) await stopWslApp(launched.bundleId, device, { python: options.python }).catch(() => undefined);
  }
}

export async function devWsl(input: WslOptions, ctx: EngineContext, signal: AbortSignal): Promise<void> {
  const { project, options } = await projectAndOptions(input);
  if (options.unsigned) throw new UserError('Use `capmac wsl build --unsigned` to validate compilation; live development requires signing.');
  if (project.kind === 'flutter') return devWslFlutter(project, options, ctx, signal);
  if (project.kind === 'react-native') return devWslReactNative(project, options, ctx, signal);
  const device = await chooseDevice(options, ctx, signal);
  // Preflight before starting a server. Missing SDKs must not leave a background web process behind.
  await checkedToolchain(options, ctx, signal, true);
  const signingPassword = await password(options, ctx, project.capDir);
  let server: DevServer | undefined;
  let relay: Awaited<ReturnType<typeof startWslLiveRelay>> | undefined;
  let watcher: FSWatcher | undefined;
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  throwIfAborted(signal);
  signal.addEventListener('abort', abort, { once: true });
  let pending = false;
  let building = false;
  let activeBuild: Promise<void> = Promise.resolve();
  let launched: WslBuildResult | undefined;
  try {
    server = await startDevServer(project, { url: options.url, command: options.devCommand, signal: lifetime.signal }, ctx);
    throwIfAborted(signal);
    relay = await startWslLiveRelay(server.url, await chooseLiveHost(options.liveHost, ctx));
    ctx.emit({ type: 'devserver', url: relay.url, external: server.external, command: server.command ?? undefined });
    log(ctx, 'info', `Live reload: ${relay.url} · keep the iPhone on this PC's network and allow the relay through Windows Firewall.`);
    let first = true;
    const rebuild = async () => {
      building = true;
      try {
        do {
          pending = false;
          const fresh = await loadProject(project.capDir);
          // --clean is for the first build; rebuilds after a native change reuse what it made.
          const built = await buildProject(fresh, first ? options : { ...options, clean: false }, ctx, lifetime.signal, relay!.url, signingPassword);
          first = false;
          await deploy(built, device, options, ctx, lifetime.signal);
          launched = built;
        } while (pending && !lifetime.signal.aborted);
      } finally { building = false; }
    };
    if (options.watch !== false) watcher = watchNativeChanges(project, (_kinds, paths) => {
      ctx.emit({ type: 'native-change', kinds: [..._kinds], paths });
      if (building) { pending = true; return; }
      activeBuild = rebuild().catch((error) => { if (!isCancelled(error)) ctx.emit({ type: 'error', error: toErrorInfo(error) }); });
    });
    activeBuild = rebuild();
    await activeBuild;
    const ended = server.exited.then((code) => { throw new UserError(`The development server exited (${code}).`, 'Restart the dev workflow to reconnect the iPhone.'); });
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (lifetime.signal.aborted) reject(new CancelledError());
      else lifetime.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    });
    const logs = options.logs === false ? cancelled : streamWslDeviceLogs(device, logOptions(options, ctx, lifetime.signal, launched?.processName));
    await Promise.race([ended, logs, cancelled]);
  } finally {
    lifetime.abort();
    watcher?.close();
    await activeBuild.catch(() => undefined);
    signal.removeEventListener('abort', abort);
    await Promise.allSettled([relay?.stop(), server?.stop()]);
    if (launched) await stopWslApp(launched.bundleId, device, { python: options.python }).catch(() => undefined);
  }
}
