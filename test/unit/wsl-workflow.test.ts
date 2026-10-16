import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentContext, type EngineContext } from '../../packages/core/src/engine/context.js';
import { CancelledError } from '../../packages/core/src/engine/errors.js';
import type { ProjectInfo } from '../../packages/core/src/engine/project.js';
import type { WslBuildPlan } from '../../packages/core/src/engine/wsl/compiler.js';
import type { WslNativeBuildPlan } from '../../packages/core/src/engine/wsl/native-compiler.js';
import type { WslDeviceOptions } from '../../packages/core/src/engine/wsl/device.js';
import { buildWsl, devWsl, doctorWsl, runWsl, setupWsl } from '../../packages/core/src/engine/wsl/index.js';

const boundary = vi.hoisted(() => ({
  project: undefined as unknown as ProjectInfo,
  sequence: [] as string[],
  loadProject: vi.fn(), buildWeb: vi.fn(), prepare: vi.fn(), frameworks: vi.fn(), compile: vi.fn(),
  preparePods: vi.fn(), compileNative: vi.fn(),
  findPods: vi.fn(), inspectPods: vi.fn(), inspectResources: vi.fn(),
  toolchain: vi.fn(), selectDevice: vi.fn(), listDevices: vi.fn(), install: vi.fn(), launch: vi.fn(), logs: vi.fn(), stopApp: vi.fn(),
  startServer: vi.fn(), serverStop: vi.fn(), startRelay: vi.fn(), relayStop: vi.fn(), chooseHost: vi.fn(),
  watch: vi.fn(), watcherClose: vi.fn(), macLink: vi.fn(), macSession: vi.fn(),
  wslCommands: [] as string[][],
}));

vi.mock('../../packages/core/src/engine/project.js', async (importOriginal) => ({
  ...await importOriginal<object>(), loadProject: boundary.loadProject,
}));
vi.mock('../../packages/core/src/engine/pipeline.js', () => ({ buildWeb: boundary.buildWeb }));
vi.mock('../../packages/core/src/engine/link.js', () => ({ MacLink: boundary.macLink }));
vi.mock('../../packages/core/src/engine/session.js', () => ({ MacSession: { open: boundary.macSession } }));
vi.mock('../../packages/core/src/engine/wsl/toolchain.js', () => ({
  inspectWslToolchain: boundary.toolchain,
  WslExecutor: class {
    constructor(readonly distro: string) {}
    async path(value: string) { return value.replace(/\\/g, '/'); }
    async run(command: string[]) { boundary.wslCommands.push(command); return { code: 0, stdout: '', stderr: '' }; }
  },
}));
vi.mock('../../packages/core/src/engine/wsl/compiler.js', () => ({ buildWithToolchain: boundary.compile }));
vi.mock('../../packages/core/src/engine/wsl/xcode.js', () => ({ prepareXcodeProject: boundary.prepare }));
vi.mock('../../packages/core/src/engine/wsl/cocoapods.js', () => ({ findCocoaPodsDirectory: boundary.findPods, prepareCocoaPodsProject: boundary.preparePods, inspectCocoaPods: boundary.inspectPods }));
vi.mock('../../packages/core/src/engine/wsl/native-compiler.js', () => ({ buildNativeWithToolchain: boundary.compileNative }));
vi.mock('../../packages/core/src/engine/wsl/resources.js', () => ({ inspectWslResourceTools: boundary.inspectResources, installWslResourceTools: vi.fn() }));
vi.mock('../../packages/core/src/engine/wsl/capacitor.js', () => ({
  capacitorFrameworks: boundary.frameworks,
  capacitorIosVersion: () => '8.5.3',
  discoverCapacitorPlugins: async () => [],
  prepareCapacitorPlan: boundary.prepare,
}));
vi.mock('../../packages/core/src/engine/wsl/device.js', async (importOriginal) => ({
  // The real mapping to a target: the phone picked is announced like the Mac's targets.
  wslDeviceTarget: (await importOriginal<typeof import('../../packages/core/src/engine/wsl/device.js')>()).wslDeviceTarget,
  inspectWslDeviceTools: async () => ({ ready: true, pythonVersion: '3.13.2', pymobiledevice3Version: '11.32.0', issues: [] }),
  selectWslDevice: boundary.selectDevice, listWslDevices: boundary.listDevices,
  installWslApp: boundary.install, launchWslApp: boundary.launch,
  streamWslDeviceLogs: boundary.logs, stopWslApp: boundary.stopApp,
}));
vi.mock('../../packages/core/src/engine/devserver.js', () => ({ startDevServer: boundary.startServer }));
vi.mock('../../packages/core/src/engine/wsl/live.js', () => ({
  chooseLiveHost: boundary.chooseHost, startWslLiveRelay: boundary.startRelay,
}));
vi.mock('../../packages/core/src/engine/watch.js', () => ({ watchNativeChanges: boundary.watch }));

const device = { udid: '00008110-local-phone', name: 'Local iPhone', productVersion: '18.5' };
const signingSecret = 'workflow-test-certificate-secret';
let directory: string;
let ctx: EngineContext;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const inputs = () => ({ cwd: directory, certificate: 'Development.p12', profile: 'Development.mobileprovision' });
const signal = () => new AbortController().signal;

async function filesBelow(root: string): Promise<string[]> {
  const groups = await Promise.all((await readdir(root, { withFileTypes: true })).map((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(full) : Promise.resolve([full]);
  }));
  return groups.flat();
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv('CAPMAC_IOS_PASSWORD', signingSecret);
  vi.stubEnv('CAPMAC_IOS_SDK', '');
  vi.stubEnv('CAPMAC_IOS_CERTIFICATE', '');
  vi.stubEnv('CAPMAC_IOS_PROFILE', '');
  directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-wsl-workflow-'));
  await Promise.all(['Development.p12', 'Development.mobileprovision'].map((name) => writeFile(path.join(directory, name), 'test signing input')));
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'dist', 'index.html'), '<html>existing web build for live reload</html>');
  await mkdir(path.join(directory, 'ios', 'App', 'App'), { recursive: true });
  await writeFile(path.join(directory, 'ios', 'App', 'App', 'AppDelegate.swift'), '// original custom native app host');
  ctx = silentContext();
  boundary.sequence = [];
  boundary.project = {
    kind: 'capacitor', capDir: directory, syncRoot: directory, projectRel: '',
    configFile: path.join(directory, 'capacitor.config.json'), appId: 'dev.test.local', appName: 'Test App',
    webDir: 'dist', iosDir: 'ios', scheme: 'App', iosPackageManager: 'SPM', hasIos: true,
    packageManager: 'npm', projectId: 'local-test', config: {}, scripts: { build: 'vite build', dev: 'vite' }, electron: null,
  };
  boundary.loadProject.mockResolvedValue(boundary.project);
  boundary.findPods.mockResolvedValue(path.join(directory, 'ios', 'App'));
  boundary.inspectPods.mockResolvedValue({ ready: true, checks: [{ name: 'CocoaPods', ok: true, message: '1.17.0' }] });
  boundary.inspectResources.mockResolvedValue({ ready: true, checks: [{ name: 'ibtool resource compiler', ok: true, message: '/tools/ibtool' }] });
  boundary.macLink.mockImplementation(() => { throw new Error('WSL opened a forbidden Mac link'); });
  boundary.macSession.mockRejectedValue(new Error('WSL opened a forbidden Mac session'));
  boundary.toolchain.mockResolvedValue({
    ready: true, distro: 'Ubuntu', checks: [{ name: 'iOS compile and link', ok: true, message: 'UIKit and WebKit link' }],
    tools: { sdkPath: '/sdk', swiftcPath: 'swiftc', linkerPath: 'ld64.lld', signerPath: 'zsign' },
  });
  boundary.buildWeb.mockImplementation(async () => { boundary.sequence.push('web'); });
  boundary.frameworks.mockResolvedValue([{ path: '/sdk/Capacitor.framework' }]);
  boundary.prepare.mockImplementation(async (project: ProjectInfo, options: { directory: string; outputDirectory: string; signing: WslBuildPlan['signing']; liveUrl?: string; configuration: string }) => {
    boundary.sequence.push('prepare');
    await mkdir(options.directory, { recursive: true });
    await writeFile(path.join(options.directory, 'workspace.marker'), 'isolated cached native inputs');
    return {
      graph: { version: 1, projectRoot: project.capDir, rootTargetId: 'App', configuration: options.configuration, sdk: 'iphoneos', targets: [{
        id: 'App', name: 'App', productType: 'application', productName: 'App.app', moduleName: 'App', dependencies: [],
        sourceFiles: [{ path: path.join(project.capDir, 'ios', 'App', 'App', 'AppDelegate.swift') }], publicHeaders: [], resources: [], frameworks: [], scripts: [],
        settings: { PRODUCT_BUNDLE_IDENTIFIER: project.appId, EXECUTABLE_NAME: 'App', INFOPLIST_FILE: path.join(project.capDir, 'ios', 'App', 'App', 'Info.plist') },
      }] }, outputDirectory: options.outputDirectory, signing: options.signing,
    } satisfies WslNativeBuildPlan;
  });
  boundary.compile.mockImplementation(async (plan: WslNativeBuildPlan) => {
    boundary.sequence.push(plan.unsigned ? 'compile' : 'sign');
    const appPath = path.join(plan.outputDirectory, 'App.app');
    const ipaPath = path.join(plan.outputDirectory, 'App.ipa');
    await mkdir(appPath, { recursive: true });
    await writeFile(ipaPath, 'signed IPA output');
    const app = plan.graph.targets.find((target) => target.id === plan.graph.rootTargetId)!;
    return { appPath, ipaPath, bundleIdentifier: app.settings.PRODUCT_BUNDLE_IDENTIFIER, executableName: app.settings.EXECUTABLE_NAME, signed: !plan.unsigned };
  });
  boundary.preparePods.mockImplementation(async (_project, options) => {
    boundary.sequence.push('pods');
    return { graph: { version: 1, rootTargetId: 'PodsOriginal' }, signing: options.signing, outputDirectory: options.outputDirectory };
  });
  boundary.compileNative.mockImplementation(async (plan, ...args) => {
    if (plan.graph.rootTargetId !== 'PodsOriginal') return boundary.compile(plan, ...args);
    boundary.sequence.push('native');
    await mkdir(plan.outputDirectory, { recursive: true });
    return { appPath: path.join(plan.outputDirectory, 'Original App.app'), ipaPath: path.join(plan.outputDirectory, 'Original App.ipa'), bundleIdentifier: 'dev.native.original', executableName: 'Original App', signed: !plan.unsigned };
  });
  boundary.selectDevice.mockImplementation(async () => { boundary.sequence.push('device'); return device; });
  boundary.listDevices.mockResolvedValue([device]);
  boundary.install.mockImplementation(async () => { boundary.sequence.push('install'); });
  boundary.launch.mockImplementation(async () => { boundary.sequence.push('launch'); });
  boundary.logs.mockImplementation(async () => { boundary.sequence.push('logs'); });
  boundary.stopApp.mockImplementation(async () => { boundary.sequence.push('stop'); });
  boundary.serverStop.mockResolvedValue(undefined);
  boundary.relayStop.mockResolvedValue(undefined);
  boundary.startServer.mockResolvedValue({
    url: new URL('http://localhost:5173'), external: false, command: 'npm run dev',
    stop: boundary.serverStop, exited: new Promise(() => undefined),
  });
  boundary.startRelay.mockResolvedValue({ url: 'http://192.168.1.20:7374', stop: boundary.relayStop });
  boundary.chooseHost.mockResolvedValue('192.168.1.20');
  boundary.watch.mockReturnValue({ close: boundary.watcherClose } as unknown as FSWatcher);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  expect(boundary.macLink).not.toHaveBeenCalled();
  expect(boundary.macSession).not.toHaveBeenCalled();
  await rm(directory, { recursive: true, force: true });
});

describe('local WSL build and deployment', () => {
  it('checks the CocoaPods and resource tools for the actual project instead of applying the SPM subset checks', async () => {
    boundary.project.iosPackageManager = 'CocoaPods';
    const result = await doctorWsl(inputs(), ctx, signal());
    expect(result.ready).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Capacitor CocoaPods project', level: 'ok' }), expect.objectContaining({ label: 'CocoaPods', level: 'ok' })]));
    expect(boundary.toolchain).toHaveBeenCalledWith(expect.objectContaining({ native: true }), expect.anything());
    expect(boundary.inspectPods).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ directory: path.join(directory, 'ios', 'App').replace(/\\/g, '/'), rootDirectory: directory.replace(/\\/g, '/') }));
  });

  it('builds CocoaPods through its native graph and deploys the original target identity', async () => {
    boundary.project.iosPackageManager = 'CocoaPods';
    await runWsl({ ...inputs(), scheme: 'Original App', configuration: 'Staging', logs: false }, ctx, signal());
    expect(boundary.sequence).toEqual(['device', 'web', 'pods', 'native', 'install', 'launch']);
    expect(boundary.preparePods).toHaveBeenCalledWith(boundary.project, expect.objectContaining({ configuration: 'Staging', scheme: 'Original App', directory: path.join(directory, '.capmac', 'wsl', 'pods-inputs') }), ctx, expect.any(AbortSignal));
    expect(boundary.launch).toHaveBeenCalledWith('dev.native.original', device, expect.anything());
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(boundary.frameworks).not.toHaveBeenCalled();
    expect(boundary.compile).not.toHaveBeenCalled();
    expect(existsSync(path.join(directory, '.capmac', 'wsl', 'pods-build.lock'))).toBe(false);
    const metadata = await readFile(path.join(directory, '.capmac', 'wsl', 'last-build.json'), 'utf8');
    expect(metadata).toContain('Original App');
    expect(metadata).not.toContain(signingSecret);
  });

  it('releases the CocoaPods sandbox after resolution fails and never deploys a partial app', async () => {
    boundary.project.iosPackageManager = 'CocoaPods';
    boundary.preparePods.mockRejectedValue(new Error('pod install failed'));
    await expect(runWsl({ ...inputs(), logs: false }, ctx, signal())).rejects.toThrow('pod install failed');
    expect(existsSync(path.join(directory, '.capmac', 'wsl', 'pods-build.lock'))).toBe(false);
    expect(boundary.compileNative).not.toHaveBeenCalled();
    expect(boundary.install).not.toHaveBeenCalled();
  });

  it('prevents overlapping builds from changing the cached CocoaPods workspace', async () => {
    boundary.project.iosPackageManager = 'CocoaPods';
    const resolving = deferred();
    const released = deferred<never>();
    boundary.preparePods.mockImplementation(() => { resolving.resolve(); return released.promise; });
    const first = buildWsl(inputs(), ctx, signal());
    const outcome = expect(first).rejects.toThrow('cancel fixture');
    await resolving.promise;
    await expect(buildWsl(inputs(), ctx, signal())).rejects.toThrow('Another CocoaPods build');
    released.reject(new Error('cancel fixture'));
    await outcome;
    expect(boundary.preparePods).toHaveBeenCalledOnce();
    expect(existsSync(path.join(directory, '.capmac', 'wsl', 'pods-build.lock'))).toBe(false);
  });

  it('uses saved machine settings, signs locally, and persists no certificate password or build plan', async () => {
    await setupWsl({ ...inputs(), sdk: '/sdk/iPhoneOS.sdk', passwordEnv: 'CAPMAC_IOS_PASSWORD' }, ctx, signal());
    const built = await buildWsl({ cwd: directory, release: true }, ctx, signal());
    expect(built).toMatchObject({ bundleId: 'dev.test.local', ipaPath: expect.stringContaining('App.ipa') });
    expect(boundary.sequence).toEqual(['web', 'prepare', 'sign']);
    expect(boundary.compile.mock.calls[0]?.[0]).toMatchObject({ graph: { configuration: 'Release' }, signing: { password: signingSecret, certificatePath: path.join(directory, 'Development.p12') } });
    expect(boundary.install).not.toHaveBeenCalled();
    expect(await readdir(path.join(directory, '.capmac', 'wsl', 'xcode-inputs'))).toEqual(['workspace.marker']);
    const settings = JSON.parse(await readFile(path.join(directory, '.capmac', 'wsl.json'), 'utf8'));
    expect(settings).toMatchObject({ certificate: 'Development.p12', sdk: '/sdk/iPhoneOS.sdk', passwordEnv: 'CAPMAC_IOS_PASSWORD' });
    const last = JSON.parse(await readFile(path.join(directory, '.capmac', 'wsl', 'last-build.json'), 'utf8'));
    expect(last).toEqual(built);
    for (const file of await filesBelow(path.join(directory, '.capmac'))) {
      expect(await readFile(file, 'utf8')).not.toContain(signingSecret);
    }
  });

  it('installs and launches only after signing succeeds, using the selected Windows-connected phone', async () => {
    const controller = new AbortController();
    await runWsl({ ...inputs(), target: device.udid, logs: false }, ctx, controller.signal);
    expect(boundary.sequence).toEqual(['device', 'web', 'prepare', 'sign', 'install', 'launch']);
    expect(boundary.selectDevice).toHaveBeenCalledWith(device.udid, expect.objectContaining({ signal: controller.signal }));
    expect(boundary.install).toHaveBeenCalledWith(expect.stringContaining('App.ipa'), device, expect.objectContaining({ signal: controller.signal }));
    expect(boundary.launch).toHaveBeenCalledWith('dev.test.local', device, expect.anything());
    expect(boundary.logs).not.toHaveBeenCalled();
  });

  it('a clean build drops the prepared native project and the compilers’ module cache first; a normal one keeps them', async () => {
    boundary.wslCommands.length = 0;
    await runWsl({ ...inputs(), target: device.udid, logs: false }, ctx, signal());
    const generated = boundary.prepare.mock.calls[0]?.[1].directory as string;
    expect(existsSync(path.join(generated, 'workspace.marker'))).toBe(true);
    expect(boundary.wslCommands).toEqual([]);
    await writeFile(path.join(generated, 'stale.txt'), 'from an earlier build');
    await runWsl({ ...inputs(), target: device.udid, logs: false, clean: true }, ctx, signal());
    expect(boundary.wslCommands).toEqual([['sh', '-c', 'rm -rf "$HOME/.cache/capmac/module-cache"']]);
    // The prepared project was removed, then made again by this build.
    expect(existsSync(path.join(generated, 'stale.txt'))).toBe(false);
    expect(existsSync(path.join(generated, 'workspace.marker'))).toBe(true);
  });

  it('does not install or launch when signing fails and releases the cached native workspace', async () => {
    boundary.compile.mockRejectedValue(new Error('certificate does not match profile'));
    await expect(runWsl({ ...inputs(), logs: false }, ctx, signal())).rejects.toThrow('certificate does not match profile');
    expect(boundary.install).not.toHaveBeenCalled();
    expect(boundary.launch).not.toHaveBeenCalled();
    const generated = boundary.prepare.mock.calls[0]?.[1].directory as string;
    expect(existsSync(path.join(generated, 'workspace.marker'))).toBe(true);
    expect(existsSync(path.join(directory, '.capmac', 'wsl', 'pods-build.lock'))).toBe(false);
    expect(existsSync(path.join(directory, '.capmac', 'wsl', 'last-build.json'))).toBe(false);
  });

  it('never invokes the compiler after a web build failure', async () => {
    boundary.buildWeb.mockRejectedValue(new Error('web compilation failed'));
    await expect(buildWsl(inputs(), ctx, signal())).rejects.toThrow('web compilation failed');
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(boundary.compile).not.toHaveBeenCalled();
  });
  it('imports an existing Capacitor 8.5.0 SPM app with its original host into the shared native compiler', async () => {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ dependencies: { '@capacitor/ios': '8.5.0' } }));
    await buildWsl({ ...inputs(), configuration: 'Staging' }, ctx, signal());
    expect(boundary.prepare).toHaveBeenCalledWith(boundary.project, expect.objectContaining({ configuration: 'Staging', directory: path.join(directory, '.capmac', 'wsl', 'xcode-inputs') }), ctx, expect.any(AbortSignal));
    expect(boundary.compileNative).toHaveBeenCalledOnce();
    const graph = boundary.compileNative.mock.calls[0]![0].graph;
    expect(graph.configuration).toBe('Staging');
    expect(graph.targets[0].sourceFiles).toEqual([{ path: path.join(directory, 'ios', 'App', 'App', 'AppDelegate.swift') }]);
    expect(await readFile(graph.targets[0].sourceFiles[0].path, 'utf8')).toBe('// original custom native app host');
    expect(boundary.frameworks).not.toHaveBeenCalled();
  });
  it('allows unsigned compilation without requesting a password or requiring a certificate', async () => {
    vi.stubEnv('CAPMAC_IOS_PASSWORD', undefined);
    ctx.prompter = { ...ctx.prompter, password: vi.fn(async () => { throw new Error('Unsigned build requested a secret'); }) };
    const built = await buildWsl({ cwd: directory, unsigned: true }, ctx, signal());
    expect(built.signed).toBe(false); expect(boundary.sequence).toEqual(['web', 'prepare', 'compile']);
    expect(boundary.compile.mock.calls[0]![0]).toMatchObject({ unsigned: true, signing: { certificatePath: '', provisioningProfilePath: '', password: '' } });
    expect(ctx.prompter.password).not.toHaveBeenCalled(); expect(boundary.install).not.toHaveBeenCalled();
  });
  it('persists separate extension profile paths and forwards them without storing signing secrets', async () => {
    await writeFile(path.join(directory, 'Widget.mobileprovision'), 'widget profile input');
    await setupWsl({ ...inputs(), sdk: '/sdk', extensionProfiles: { 'dev.test.local.HomeCard': 'Widget.mobileprovision' } }, ctx, signal());
    await buildWsl({ cwd: directory }, ctx, signal());
    expect(boundary.compileNative.mock.calls[0]![0].signing.extensionProfiles).toEqual({ 'dev.test.local.HomeCard': path.join(directory, 'Widget.mobileprovision') });
    const saved = await readFile(path.join(directory, '.capmac', 'wsl.json'), 'utf8');
    expect(JSON.parse(saved).extensionProfiles).toEqual({ 'dev.test.local.HomeCard': 'Widget.mobileprovision' });
    expect(saved).not.toContain(signingSecret);
  });
  it('refuses unsigned installation and development before selecting a phone or starting a server', async () => {
    await expect(runWsl({ cwd: directory, unsigned: true }, ctx, signal())).rejects.toThrow(/running requires signing/);
    await expect(devWsl({ cwd: directory, unsigned: true }, ctx, signal())).rejects.toThrow(/live development requires signing/);
    expect(boundary.selectDevice).not.toHaveBeenCalled(); expect(boundary.startServer).not.toHaveBeenCalled(); expect(boundary.compileNative).not.toHaveBeenCalled();
  });
});

describe('WSL development lifecycle', () => {
  it('does not start a web process when the iOS toolchain is missing', async () => {
    boundary.toolchain.mockResolvedValue({ ready: false, checks: [{ name: 'SDK', ok: false, message: 'missing' }] });
    await expect(devWsl(inputs(), ctx, signal())).rejects.toThrow('toolchain is not ready');
    expect(boundary.startServer).not.toHaveBeenCalled();
    expect(boundary.startRelay).not.toHaveBeenCalled();
    expect(boundary.compile).not.toHaveBeenCalled();
  });

  it('closes the server, relay and native watcher when the first native build fails', async () => {
    boundary.compile.mockRejectedValue(new Error('native compilation failed'));
    await expect(devWsl(inputs(), ctx, signal())).rejects.toThrow('native compilation failed');
    expect(boundary.serverStop).toHaveBeenCalledOnce();
    expect(boundary.relayStop).toHaveBeenCalledOnce();
    expect(boundary.watcherClose).toHaveBeenCalledOnce();
    expect(boundary.install).not.toHaveBeenCalled();
    expect(boundary.launch).not.toHaveBeenCalled();
    expect(boundary.stopApp).not.toHaveBeenCalled();
    expect(existsSync(path.join(boundary.prepare.mock.calls[0]?.[1].directory, 'workspace.marker'))).toBe(true);
    expect(existsSync(path.join(directory, '.capmac', 'wsl', 'pods-build.lock'))).toBe(false);
  });

  it('cancels device logs and cleans up the running development session on abort', async () => {
    const logging = deferred();
    boundary.logs.mockImplementation((_device, options: WslDeviceOptions) => new Promise<void>((_resolve, reject) => {
      logging.resolve();
      if (options.signal?.aborted) reject(new CancelledError());
      else options.signal?.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    }));
    const controller = new AbortController();
    const running = devWsl(inputs(), ctx, controller.signal);
    const outcome = expect(running).rejects.toBeInstanceOf(CancelledError);
    await logging.promise;
    controller.abort();
    await outcome;
    expect(boundary.startRelay).toHaveBeenCalledWith(expect.any(URL), '192.168.1.20');
    expect(boundary.prepare.mock.calls[0]?.[1]).toMatchObject({ liveUrl: 'http://192.168.1.20:7374' });
    expect(boundary.buildWeb).not.toHaveBeenCalled();
    expect(boundary.serverStop).toHaveBeenCalledOnce();
    expect(boundary.relayStop).toHaveBeenCalledOnce();
    expect(boundary.watcherClose).toHaveBeenCalledOnce();
    expect(boundary.stopApp).toHaveBeenCalledWith('dev.test.local', device, expect.anything());
  });

  it('cancels an in-flight native rebuild before closing the server and never deploys partial output', async () => {
    const logging = deferred();
    boundary.logs.mockImplementation((_device, options: WslDeviceOptions) => new Promise<void>((_resolve, reject) => {
      logging.resolve();
      options.signal?.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    }));
    const compiling = deferred();
    let calls = 0;
    const originalCompiler = boundary.compile.getMockImplementation()!;
    boundary.compile.mockImplementation(async (...args) => {
      if (++calls === 1) return originalCompiler(...args);
      const hooks = args[3] as { signal: AbortSignal };
      compiling.resolve();
      return new Promise((_resolve, reject) => {
        hooks.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
      });
    });
    const controller = new AbortController();
    const running = devWsl(inputs(), ctx, controller.signal);
    const outcome = expect(running).rejects.toBeInstanceOf(CancelledError);
    await logging.promise;
    const change = boundary.watch.mock.calls[0]?.[1] as (kinds: Set<string>, files: string[]) => void;
    change(new Set(['native']), ['ios/App/App/AppDelegate.swift']);
    await compiling.promise;
    controller.abort();
    await outcome;
    expect(boundary.compile).toHaveBeenCalledTimes(2);
    expect(boundary.install).toHaveBeenCalledOnce();
    expect(boundary.launch).toHaveBeenCalledOnce();
    expect(boundary.serverStop).toHaveBeenCalledOnce();
    expect(boundary.relayStop).toHaveBeenCalledOnce();
    expect(await readdir(path.join(directory, '.capmac', 'wsl', 'xcode-inputs'))).toEqual(['workspace.marker']);
    expect(existsSync(path.join(directory, '.capmac', 'wsl', 'pods-build.lock'))).toBe(false);
  });
});
