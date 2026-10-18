import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nonInteractivePrompter, silentContext } from '../../packages/core/src/engine/context.js';
import { UserError } from '../../packages/core/src/engine/errors.js';
import type { EngineEvent } from '../../packages/core/src/engine/events.js';
import { guidedWslSetup, wslSetupState } from '../../packages/core/src/engine/wsl/setup.js';
import { SDK_IMPORT_VERSION } from '../../packages/core/src/engine/wsl/sdk-runtime.js';

const boundary = vi.hoisted(() => ({
  login: vi.fn(), catalog: vi.fn(), download: vi.fn(), close: vi.fn(), distro: vi.fn(), bootstrap: vi.fn(), sdk: vi.fn(),
  project: vi.fn(), targets: vi.fn(), signing: vi.fn(), devices: vi.fn(), server: vi.fn(), installDevices: vi.fn(), order: [] as string[],
  chooseSignIn: vi.fn(), websiteLogin: vi.fn(), pythonCurrent: vi.fn(),
}));
vi.mock('../../packages/core/src/engine/wsl/apple-account.js', () => ({ loginAppleAccount: boundary.login }));
vi.mock('../../packages/core/src/engine/wsl/apple-web.js', () => ({ chooseAppleSignIn: boundary.chooseSignIn, signInOnAppleWebsite: boundary.websiteLogin }));
vi.mock('../../packages/core/src/engine/wsl/apple-auto-signing.js', () => ({ readSigningTargets: boundary.targets, setUpAutomaticSigning: boundary.signing }));
vi.mock('../../packages/core/src/engine/wsl/device.js', () => ({ listWslDevices: boundary.devices }));
vi.mock('../../packages/core/src/engine/project.js', () => ({ loadProject: boundary.project }));
vi.mock('../../packages/core/src/engine/wsl/bootstrap.js', () => ({ ensureManagedWslDistro: boundary.distro, bootstrapWslDependencies: boundary.bootstrap, devicePythonCurrent: boundary.pythonCurrent, MANAGED_XCODE_VERSION: '26.6' }));
vi.mock('../../packages/core/src/engine/wsl/sdk.js', () => ({ setupSDKFromXcode: boundary.sdk }));
vi.mock('../../packages/core/src/engine/wsl/apple-devices.js', () => ({ startAppleDeviceServer: boundary.server, installAppleDevices: boundary.installDevices }));
vi.mock('../../packages/core/src/engine/wsl/toolchain.js', () => ({ WslExecutor: class { constructor(readonly distro: string) {} } }));

let directory: string;
const ctx = () => silentContext({ ...nonInteractivePrompter, interactive: true });
const signal = () => new AbortController().signal;
const installed = { distro: 'CapMac-Ubuntu', swift: '/tools/swiftc', python: 'C:\\CapMac\\python.exe', ibtool: '/tools/ibtool' };
const imported = { sdkPath: '/apple/iPhoneOS26.5.sdk', swiftResourcePath: '/apple/swift', xcodeVersion: '26.6' };
const archiveName = 'Xcode_26.6_Apple_silicon.xip';
const readStatus = async () => JSON.parse(await readFile(path.join(directory, '.capmac', 'wsl', 'setup-status.json'), 'utf8'));
const readSaved = async () => JSON.parse(await readFile(path.join(directory, '.capmac', 'wsl.json'), 'utf8'));
const app = { name: 'App', bundleIdentifier: 'dev.example.app', extension: false, entitlements: {} };
const widget = { name: 'Widget', bundleIdentifier: 'dev.example.app.widget', extension: true, entitlements: {} };

beforeEach(async () => {
  vi.resetAllMocks();
  boundary.order.length = 0;
  directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-wsl-setup-'));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  boundary.project.mockRejectedValue(new UserError('No Capacitor project here.'));
  boundary.login.mockImplementation(async () => { boundary.order.push('sign-in'); return { team: { id: 'TEAM123456', name: 'Example Team' }, discoverXcodeDownload: boundary.catalog, downloadXcode: boundary.download, close: boundary.close, password: 'never-save-account-secret', cookies: { private: 'never-save-cookie' } }; });
  boundary.chooseSignIn.mockImplementation(async () => { boundary.order.push('choose'); return { way: 'password' }; });
  boundary.websiteLogin.mockImplementation(async () => { boundary.order.push('website'); return { team: { id: 'TEAM123456', name: 'Example Team' }, discoverXcodeDownload: boundary.catalog, downloadXcode: boundary.download, close: boundary.close }; });
  boundary.catalog.mockResolvedValue({ version: '26.6', name: 'Xcode 26.6', fileName: archiveName, url: `https://download.developer.apple.com/Developer_Tools/Xcode_26.6/${archiveName}` });
  boundary.download.mockImplementation(async (_download, destination) => { boundary.order.push('download'); await writeFile(destination, 'xar!'); return destination; });
  boundary.distro.mockResolvedValue('CapMac-Ubuntu');
  boundary.bootstrap.mockImplementation(async () => { boundary.order.push('tools'); return installed; });
  boundary.sdk.mockResolvedValue(imported);
  boundary.server.mockResolvedValue('running');
  boundary.pythonCurrent.mockReturnValue(true);
  boundary.targets.mockResolvedValue([app, widget]);
  boundary.devices.mockResolvedValue([{ udid: '00008120-0001', name: 'Test iPhone' }]);
  boundary.signing.mockImplementation(async () => { boundary.order.push('signing'); return { certificate: 'C:\\Signing\\development.p12', profile: 'C:\\Signing\\dev.example.app.mobileprovision', extensionProfiles: { 'dev.example.app.widget': 'C:\\Signing\\dev.example.app.widget.mobileprovision' } }; });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe('guided WSL setup', () => {
  it('prepares the tools before sign-in, then downloads and imports the paired Xcode, saving only paths', async () => {
    await guidedWslSetup({}, directory, ctx(), signal());
    expect(boundary.order).toEqual(['tools', 'choose', 'sign-in', 'download']);
    expect(boundary.catalog).toHaveBeenCalledWith('26.6', expect.anything());
    expect(boundary.download).toHaveBeenCalledWith(expect.objectContaining({ version: '26.6' }), path.join(directory, 'Downloads', archiveName), expect.anything());
    expect(boundary.sdk).toHaveBeenCalledWith(expect.anything(), path.join(directory, 'Downloads', archiveName), expect.anything());
    expect(boundary.close).toHaveBeenCalledOnce();
    expect(boundary.signing).not.toHaveBeenCalled();
    const saved = await readFile(path.join(directory, '.capmac', 'wsl.json'), 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ ...installed, sdk: imported.sdkPath, swiftResources: imported.swiftResourcePath, xcodeVersion: '26.6' });
    expect(saved).not.toContain('never-save');
    expect(await readStatus()).toMatchObject({ phase: 'complete', state: 'complete' });
  });

  it('records the failed catalog step and closes the verified account without exposing raw transport data', async () => {
    boundary.catalog.mockRejectedValue(Object.assign(new Error('Authorization: never-save-cookie'), { config: { password: 'never-save-account-secret' } }));
    await expect(guidedWslSetup({}, directory, ctx(), signal())).rejects.toThrow();
    expect(await readStatus()).toMatchObject({ phase: 'apple-catalog', state: 'failed', message: 'Setup stopped before this step completed.' });
    expect(JSON.stringify(await readStatus())).not.toContain('never-save');
    expect(boundary.close).toHaveBeenCalledOnce();
    expect(boundary.sdk).not.toHaveBeenCalled();
  });

  it('preserves a sanitized account error so the failed step can be inspected locally', async () => {
    boundary.catalog.mockRejectedValue(new UserError('Apple did not return its list of downloads (developer.apple.com: HTTP 302).'));
    await expect(guidedWslSetup({}, directory, ctx(), signal())).rejects.toThrow('HTTP 302');
    expect(await readStatus()).toMatchObject({ phase: 'apple-catalog', state: 'failed', message: 'Apple did not return its list of downloads (developer.apple.com: HTTP 302).' });
  });

  it('reuses a downloaded archive of the paired Xcode release, and ignores other releases', async () => {
    await mkdir(path.join(directory, 'Downloads'));
    await writeFile(path.join(directory, 'Downloads', 'Xcode_26.2.xip'), 'xar!');
    await writeFile(path.join(directory, 'Downloads', 'Xcode_26.6.xip'), 'xar!');
    await writeFile(path.join(directory, 'Downloads', '.capmac-Xcode_26.6_Apple_silicon.xip.part'), 'incomplete');
    await guidedWslSetup({}, directory, ctx(), signal());
    expect(boundary.login).not.toHaveBeenCalled();
    expect(boundary.sdk).toHaveBeenCalledWith(expect.anything(), path.join(directory, 'Downloads', 'Xcode_26.6.xip'), expect.anything());
  });

  it('reuses an SDK of the paired release, and replaces one imported for another release', async () => {
    await guidedWslSetup({ sdk: '/apple/existing.sdk', xcodeVersion: '26.6' }, directory, ctx(), signal());
    expect(boundary.login).not.toHaveBeenCalled();
    expect(boundary.sdk).not.toHaveBeenCalled();
    await guidedWslSetup({ sdk: '/apple/old.sdk', xcodeVersion: '26.2' }, directory, ctx(), signal());
    expect(boundary.download).toHaveBeenCalledOnce();
    expect(await readSaved()).toMatchObject({ sdk: imported.sdkPath, xcodeVersion: '26.6' });
  });

  it('takes the SDK out of Xcode again after a newer CapMac importer, without downloading Xcode again', async () => {
    const extracted = '/root/.local/share/capmac/apple-sdk/0170bdd7/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk';
    await mkdir(path.join(directory, 'Downloads'), { recursive: true });
    await writeFile(path.join(directory, 'Downloads', 'Xcode_26.6.xip'), 'xar!');
    await guidedWslSetup({ sdk: extracted, xcodeVersion: '26.6' }, directory, ctx(), signal());
    expect(boundary.sdk).toHaveBeenCalledOnce();
    expect(boundary.login).not.toHaveBeenCalled();
    expect(boundary.download).not.toHaveBeenCalled();
    expect(await readSaved()).toMatchObject({ sdk: imported.sdkPath, sdkImporter: String(SDK_IMPORT_VERSION) });
    // Taken out by this importer: kept.
    await guidedWslSetup({ sdk: extracted, xcodeVersion: '26.6', sdkImporter: String(SDK_IMPORT_VERSION) }, directory, ctx(), signal());
    expect(boundary.sdk).toHaveBeenCalledOnce();
  });

  it('in an app, one sign-in sets up signing first and then downloads Xcode', async () => {
    boundary.project.mockResolvedValue({ kind: 'capacitor', capDir: directory });
    await guidedWslSetup({}, directory, ctx(), signal());
    expect(boundary.order).toEqual(['tools', 'choose', 'sign-in', 'signing', 'download']);
    expect(boundary.login).toHaveBeenCalledOnce();
    expect(boundary.signing).toHaveBeenCalledWith(expect.anything(), [app, widget], expect.anything(), expect.objectContaining({ connectedDevices: [{ udid: '00008120-0001', name: 'Test iPhone' }] }));
    expect(await readSaved()).toMatchObject({
      certificate: 'C:\\Signing\\development.p12', profile: 'C:\\Signing\\dev.example.app.mobileprovision',
      extensionProfiles: { 'dev.example.app.widget': 'C:\\Signing\\dev.example.app.widget.mobileprovision' },
    });
  });

  it('asks how to sign in first; letting CapMac do it signs in once on Apple’s website, with no password in CapMac', async () => {
    boundary.project.mockResolvedValue({ kind: 'capacitor', capDir: directory });
    boundary.chooseSignIn.mockImplementation(async () => { boundary.order.push('choose'); return { way: 'website', fresh: true }; });
    await guidedWslSetup({}, directory, ctx(), signal());
    expect(boundary.order).toEqual(['tools', 'choose', 'website', 'signing', 'download']);
    expect(boundary.websiteLogin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fresh: true }));
    expect(boundary.login).not.toHaveBeenCalled();
    // The website's session signs the app and downloads Xcode, like a password sign-in.
    expect(boundary.signing.mock.calls[0]![0]).toMatchObject({ team: { id: 'TEAM123456' } });
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it('skips sign-in when the SDK and every signing file are already in place', async () => {
    boundary.project.mockResolvedValue({ kind: 'capacitor', capDir: directory });
    const files = ['development.p12', 'app.mobileprovision', 'widget.mobileprovision'].map((name) => path.join(directory, name));
    for (const file of files) await writeFile(file, 'x');
    await guidedWslSetup({ sdk: '/apple/existing.sdk', xcodeVersion: '26.6', certificate: files[0], profile: files[1], extensionProfile: [`dev.example.app.widget=${files[2]}`] }, directory, ctx(), signal());
    expect(boundary.login).not.toHaveBeenCalled();
    expect(boundary.signing).not.toHaveBeenCalled();
  });

  it('a declined signing change stops setup, records it and closes the account', async () => {
    boundary.project.mockResolvedValue({ kind: 'capacitor', capDir: directory });
    boundary.signing.mockRejectedValue(new UserError('Signing setup was skipped.'));
    await expect(guidedWslSetup({ sdk: '/apple/existing.sdk', xcodeVersion: '26.6' }, directory, ctx(), signal())).rejects.toThrow('Signing setup was skipped.');
    expect(await readStatus()).toMatchObject({ phase: 'signing', state: 'failed', message: 'Signing setup was skipped.' });
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it('offers Apple Devices when Windows has no iPhone connection, and goes on without it if declined', async () => {
    boundary.server.mockResolvedValueOnce('missing').mockResolvedValueOnce('running');
    const yes = silentContext({ ...nonInteractivePrompter, interactive: true, confirm: vi.fn(async () => true) });
    await guidedWslSetup({ sdk: '/apple/existing.sdk', xcodeVersion: '26.6' }, directory, yes, signal());
    expect(yes.prompter.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Install Apple Devices from the Microsoft Store?' }));
    expect(boundary.installDevices).toHaveBeenCalledOnce();
    expect(boundary.server).toHaveBeenCalledTimes(2);
    boundary.server.mockResolvedValueOnce('missing');
    await guidedWslSetup({ sdk: '/apple/existing.sdk', xcodeVersion: '26.6' }, directory, ctx(), signal());
    expect(boundary.installDevices).toHaveBeenCalledOnce();
    expect(await readStatus()).toMatchObject({ phase: 'complete' });
  });

  it('reports every step as it goes (CapMac Studio shows them), the download with where it continued from, and how far the SDK is', async () => {
    boundary.project.mockResolvedValue({ kind: 'capacitor', capDir: directory });
    boundary.sdk.mockImplementation(async (_executor, _archive, options: { onProgress: (fraction: number) => void }) => {
      options.onProgress(0.42);
      return imported;
    });
    boundary.download.mockImplementation(async (_download, destination, options: { onProgress: (received: number, total?: number, resumedFrom?: number) => void }) => {
      options.onProgress(800, 3000, 800);
      options.onProgress(3000, 3000, 800);
      await writeFile(destination, 'xar!');
      return destination;
    });
    const events: EngineEvent[] = [];
    const context = ctx();
    context.emit = (event) => events.push(event);
    await guidedWslSetup({}, directory, context, signal());
    expect(events.flatMap((event) => (event.type === 'wsl-setup' ? [`${event.phase}:${event.state}`] : []))).toEqual([
      'wsl:running', 'wsl:done', 'dependencies:running', 'dependencies:done', 'apple-devices:running', 'apple-devices:done',
      'apple-sign-in:running', 'apple-sign-in:done', 'signing:running', 'signing:done', 'apple-catalog:running', 'apple-catalog:done',
      'apple-download:running', 'apple-download:running', 'apple-download:running', 'apple-download:done', 'sdk-import:running', 'sdk-import:running', 'sdk-import:done', 'complete:done',
    ]);
    expect(events).toContainEqual({ type: 'wsl-setup', phase: 'sdk-import', state: 'running', fraction: 0.42 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'step-progress', text: '42%', done: 0.42 }));
    expect(events).toContainEqual({ type: 'wsl-setup', phase: 'apple-download', state: 'running', bytes: { received: 800, total: 3000, resumedFrom: 800 } });
    expect(events).toContainEqual({ type: 'wsl-setup', phase: 'apple-sign-in', state: 'done', detail: 'Example Team' });
    expect(events.some((event) => event.type === 'step-progress' && /continued from/.test(event.text))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('never-save');
  });

  it('says a paid Apple developer account is needed before the long tools step, only when it signs in', async () => {
    const events: EngineEvent[] = [];
    const context = ctx();
    context.emit = (event) => events.push(event);
    boundary.bootstrap.mockImplementation(async () => { boundary.order.push(events.some((event) => event.type === 'log' && /paid Apple Developer Program/.test(event.message)) ? 'told, then tools' : 'tools'); return installed; });
    await guidedWslSetup({}, directory, context, signal());
    expect(boundary.order[0]).toBe('told, then tools');

    events.length = 0;
    await guidedWslSetup({ sdk: '/apple/existing.sdk', xcodeVersion: '26.6' }, directory, context, signal());
    expect(events.some((event) => event.type === 'log' && /paid Apple Developer Program/.test(event.message))).toBe(false);
  });

  it('says which steps were not needed, and which were done before', async () => {
    const events: EngineEvent[] = [];
    const context = ctx();
    context.emit = (event) => events.push(event);
    await guidedWslSetup({ sdk: '/apple/existing.sdk', xcodeVersion: '26.6' }, directory, context, signal());
    const phases = (state: string) => events.flatMap((event) => (event.type === 'wsl-setup' && event.state === state && event.phase !== 'complete' ? [`${event.phase}${'detail' in event && event.detail ? `: ${event.detail}` : ''}`] : []));
    expect(phases('skipped')).toEqual(['apple-sign-in: Not needed', 'apple-catalog: Not needed', 'signing: Not in an app']);
    expect(phases('done').filter((phase) => /^(apple-download|sdk-import)/.test(phase))).toEqual(['apple-download: Already in place', 'sdk-import: Already in place']);
  });

  it('shows signing done before as done, in an app', async () => {
    boundary.project.mockResolvedValue({ kind: 'capacitor', capDir: directory });
    const files = ['development.p12', 'app.mobileprovision', 'widget.mobileprovision'].map((name) => path.join(directory, name));
    for (const file of files) await writeFile(file, 'x');
    const events: EngineEvent[] = [];
    const context = ctx();
    context.emit = (event) => events.push(event);
    await guidedWslSetup({ sdk: '/apple/existing.sdk', xcodeVersion: '26.6', certificate: files[0], profile: files[1], extensionProfile: [`dev.example.app.widget=${files[2]}`] }, directory, context, signal());
    expect(events).toContainEqual({ type: 'wsl-setup', phase: 'signing', state: 'done', detail: 'Already set up' });
  });

  it('needs someone to answer: a script gets a clear error before anything changes', async () => {
    await expect(guidedWslSetup({}, directory, silentContext(), signal())).rejects.toThrow('needs someone to answer');
    expect(boundary.distro).not.toHaveBeenCalled();
  });
});

describe('what setup has put in place', () => {
  it('reads the tools, SDK, signing, a stopped download and the last status, changing nothing', async () => {
    boundary.project.mockResolvedValue({ kind: 'capacitor', capDir: directory });
    expect(await wslSetupState(directory)).toEqual({ status: null, tools: false, sdk: false, signing: false, inApp: true, partialDownload: null });
    await mkdir(path.join(directory, 'Downloads'));
    await writeFile(path.join(directory, 'Downloads', '.capmac-Xcode_26.6_Apple_silicon.xip.part'), Buffer.alloc(2048));
    const certificate = path.join(directory, 'development.p12');
    const profile = path.join(directory, 'app.mobileprovision');
    await writeFile(certificate, 'x');
    await writeFile(profile, 'x');
    await mkdir(path.join(directory, '.capmac', 'wsl'), { recursive: true });
    await writeFile(path.join(directory, '.capmac', 'wsl.json'), JSON.stringify({ distro: 'CapMac-Ubuntu', swift: '/tools/swiftc', linker: '/usr/bin/ld64.lld-18', signer: '/tools/zsign', certificate, profile }));
    const stopped = { phase: 'apple-download', state: 'failed', updatedAt: '2026-10-16T10:00:00.000Z', message: 'Apple stopped sending the Xcode download.' };
    await writeFile(path.join(directory, '.capmac', 'wsl', 'setup-status.json'), JSON.stringify(stopped));
    expect(await wslSetupState(directory)).toEqual({ status: stopped, tools: true, sdk: false, signing: true, inApp: true, partialDownload: { bytes: 2048 } });
    // An SDK from another Xcode release is not the paired one.
    await writeFile(path.join(directory, '.capmac', 'wsl.json'), JSON.stringify({ sdk: '/apple/old.sdk', xcodeVersion: '26.2' }));
    expect((await wslSetupState(directory)).sdk).toBe(false);
    // One CapMac took out of Xcode with an older importer is taken out again.
    const extracted = '/root/.local/share/capmac/apple-sdk/abc/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk';
    await writeFile(path.join(directory, '.capmac', 'wsl.json'), JSON.stringify({ sdk: extracted, xcodeVersion: '26.6', sdkImporter: '2' }));
    expect((await wslSetupState(directory)).sdk).toBe(false);
    await writeFile(path.join(directory, '.capmac', 'wsl.json'), JSON.stringify({ sdk: extracted, xcodeVersion: '26.6', sdkImporter: String(SDK_IMPORT_VERSION) }));
    expect((await wslSetupState(directory)).sdk).toBe(true);
    // iPhone tools in a Python CapMac set up earlier are set up again, in its own Python.
    await writeFile(path.join(directory, '.capmac', 'wsl.json'), JSON.stringify({ distro: 'CapMac-Ubuntu', swift: '/tools/swiftc', linker: '/usr/bin/ld64.lld-18', signer: '/tools/zsign', python: 'C:\\old\\python.exe' }));
    expect((await wslSetupState(directory)).tools).toBe(true);
    boundary.pythonCurrent.mockReturnValue(false);
    expect((await wslSetupState(directory)).tools).toBe(false);
    expect(boundary.pythonCurrent).toHaveBeenLastCalledWith('C:\\old\\python.exe');
  });
});
