/** Free-path orchestration acceptance checks; no live tools or Apple state. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nonInteractivePrompter, silentContext } from '../../packages/core/src/engine/context.js';
import { UserError } from '../../packages/core/src/engine/errors.js';

const boundary = vi.hoisted(() => ({
  options: vi.fn(), save: vi.fn(), project: vi.fn(), login: vi.fn(), close: vi.fn(),
  python: vi.fn(), support: vi.fn(), provision: vi.fn(), directory: vi.fn(), devices: vi.fn(),
  website: vi.fn(), download: vi.fn(), sdk: vi.fn(),
}));
vi.mock('../../packages/core/src/engine/wsl/settings.js', () => ({
  loadWslOptions: boundary.options, saveWslOptions: boundary.save,
  settingsPath: (cwd: string) => path.join(cwd, '.capmac', 'wsl.json'),
}));
vi.mock('../../packages/core/src/engine/project.js', () => ({ loadProject: boundary.project }));
vi.mock('../../packages/core/src/engine/wsl/bootstrap.js', () => ({
  ensureManagedWslDistro: async () => 'Audit-Ubuntu',
  bootstrapWslDependencies: async () => ({ python: 'C:\\audit\\configured-python.exe' }),
  devicePythonCurrent: () => true, MANAGED_XCODE_VERSION: '26.6',
}));
vi.mock('../../packages/core/src/engine/wsl/apple-devices.js', () => ({
  startAppleDeviceServer: async () => 'running', installAppleDevices: vi.fn(),
}));
vi.mock('../../packages/core/src/engine/wsl/toolchain.js', () => ({ WslExecutor: class {} }));
vi.mock('../../packages/core/src/engine/wsl/apple-web.js', () => ({
  chooseAppleSignIn: async () => ({ way: 'free' }), signInOnAppleWebsite: vi.fn(), xcodeDownloadOnAppleWebsite: boundary.website,
}));
vi.mock('../../packages/core/src/engine/wsl/apple-account.js', () => ({
  loginAppleAccount: vi.fn(), downloadXcodeWithGrant: boundary.download,
}));
vi.mock('../../packages/core/src/engine/wsl/apple-auto-signing.js', () => ({
  readSigningTargets: async () => [{ name: 'App', bundleIdentifier: 'com.example.audit', extension: false, entitlements: {} }],
  setUpAutomaticSigning: vi.fn(),
}));
vi.mock('../../packages/core/src/engine/wsl/apple-signing.js', () => ({ prepareAppleSigningDirectory: boundary.directory }));
vi.mock('../../packages/core/src/engine/wsl/device.js', () => ({
  deviceHelperCommand: boundary.python, listWslDevices: boundary.devices,
}));
vi.mock('../../packages/core/src/engine/wsl/free/free-apple.js', () => ({
  ensureFreeSigningSupport: boundary.support,
  FreeApple: class { login = boundary.login; close = boundary.close; },
}));
vi.mock('../../packages/core/src/engine/wsl/free/free-signing.js', () => ({
  chooseFreeTeam: async (teams: unknown[]) => teams[0], freeCodeMessage: () => 'Audit code',
  setUpFreeSigning: boundary.provision,
}));
vi.mock('../../packages/core/src/engine/wsl/sdk.js', () => ({ setupSDKFromXcode: boundary.sdk }));

import { guidedWslSetup } from '../../packages/core/src/engine/wsl/setup.js';

let directory: string;
const configuredPython = 'C:\\audit\\configured-python.exe';
const context = () => silentContext({ ...nonInteractivePrompter, interactive: true,
  text: async () => 'nobody@example.invalid', password: async () => 'fake-audit-password',
});
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-free-setup-audit-'));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  boundary.options.mockResolvedValue({ sdk: '/audit/existing.sdk', python: configuredPython });
  boundary.project.mockResolvedValue({ kind: 'capacitor', capDir: directory });
  boundary.python.mockResolvedValue({ executable: configuredPython, prefix: [] });
  boundary.directory.mockResolvedValue(directory);
  boundary.login.mockResolvedValue({ teams: [{ id: 'ABCDE12345', name: 'Audit', free: true }], expiry: 42 });
  boundary.provision.mockResolvedValue({ certificate: '/audit/development.p12', profile: '/audit/app.mobileprovision', extensionProfiles: {} });
  boundary.devices.mockResolvedValue([]);
});
const phones = [
  { udid: 'IPHONE-8-UDID', name: 'iPhone', productVersion: '16.7.11', connection: 'usb' },
  { udid: 'IPHONE-14-UDID', name: 'IK 14 Pro Max', productVersion: '26.6.2', connection: 'usb' },
];
const registered = () => boundary.provision.mock.calls[0]?.[4]?.connectedDevice;
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe('Xcode for a free Apple Account', () => {
  const archive = () => path.join(directory, 'Downloads', 'Xcode_26.6_Apple_silicon.xip');
  const download = { version: '26.6', name: 'Xcode 26.6', fileName: 'Xcode_26.6_Apple_silicon.xip',
    url: 'https://download.developer.apple.com/Developer_Tools/Xcode_26.6/Xcode_26.6_Apple_silicon.xip' };
  const downloads = () => {
    boundary.website.mockResolvedValue({ download, cookies: ['ADCDownloadAuth=grant'] });
    boundary.download.mockImplementation(async (_cookies: unknown, _download: unknown, destination: string) => destination);
    boundary.sdk.mockResolvedValue({ sdkPath: '/audit/iPhoneOS.sdk', swiftResourcePath: '/audit/swift', xcodeVersion: '26.6' });
  };

  it('downloads the managed Xcode through Apple’s website when this PC has none', async () => {
    boundary.options.mockResolvedValue({ python: configuredPython }); // no iPhone SDK yet, none in Downloads
    downloads();
    const signal = new AbortController().signal;
    const ctx = context();
    await guidedWslSetup({}, directory, ctx, signal);
    // Xcode's own sign-in is turned away from Apple's downloads (HTTP 403), so the website gives the permission.
    expect(boundary.website).toHaveBeenCalledWith('26.6', ctx, { signal });
    expect(boundary.download).toHaveBeenCalledWith(['ADCDownloadAuth=grant'], download, archive(), expect.objectContaining({ signal, onProgress: expect.any(Function) }));
    // The archive then goes on to the SDK import like a paid account's.
    expect(boundary.sdk).toHaveBeenCalledWith(expect.anything(), archive(), expect.anything());
    expect(boundary.save).toHaveBeenLastCalledWith(expect.objectContaining({ sdk: '/audit/iPhoneOS.sdk', xcodeVersion: '26.6' }), directory);
    // The free sign-in was for signing, and its helper has ended before the long download.
    expect(boundary.login).toHaveBeenCalledOnce();
    expect(boundary.close.mock.invocationCallOrder[0]).toBeLessThan(boundary.download.mock.invocationCallOrder[0]!);
  });

  it('asks for no free sign-in when only Xcode is missing', async () => {
    boundary.project.mockRejectedValue(new Error('not an app')); // outside an app: nothing to sign
    boundary.options.mockResolvedValue({ python: configuredPython });
    downloads();
    await guidedWslSetup({}, directory, context(), new AbortController().signal);
    expect(boundary.python).not.toHaveBeenCalled();
    expect(boundary.login).not.toHaveBeenCalled();
    expect(boundary.download).toHaveBeenCalledWith(['ADCDownloadAuth=grant'], download, archive(), expect.anything());
  });

  it('stops with the website’s own message when Apple won’t allow the download', async () => {
    boundary.options.mockResolvedValue({ python: configuredPython });
    const refused = new UserError('Apple didn’t allow the Xcode download.', 'Or download it yourself: open developer.apple.com/download/all');
    boundary.website.mockRejectedValue(refused);
    await expect(guidedWslSetup({}, directory, context(), new AbortController().signal)).rejects.toBe(refused);
    expect(boundary.download).not.toHaveBeenCalled();
    expect(boundary.close).toHaveBeenCalledOnce();
    const status = JSON.parse(await readFile(path.join(directory, '.capmac', 'wsl', 'setup-status.json'), 'utf8'));
    expect(status).toMatchObject({ phase: 'apple-catalog', state: 'failed', message: 'Apple didn’t allow the Xcode download.' });
  });
});

describe('free signing setup acceptance audit', () => {
  it('routes the free choice through free login, saves its signing result and closes (control)', async () => {
    await guidedWslSetup({}, directory, context(), new AbortController().signal);
    expect(boundary.login).toHaveBeenCalledOnce();
    expect(boundary.provision).toHaveBeenCalledOnce();
    expect(boundary.save).toHaveBeenLastCalledWith(expect.objectContaining({ certificate: '/audit/development.p12' }), directory);
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it('closes the free helper when Apple login fails', async () => {
    boundary.login.mockRejectedValue(new UserError('Audit login failed'));
    await expect(guidedWslSetup({}, directory, context(), new AbortController().signal)).rejects.toThrow('Audit login failed');
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it('passes the configured Python and cancellation signal to helper discovery', async () => {
    const signal = new AbortController().signal;
    await guidedWslSetup({}, directory, context(), signal);
    expect(boundary.python).toHaveBeenCalledWith({ python: configuredPython, signal });
  });

  it('asks which iPhone to register when more than one is connected', async () => {
    boundary.devices.mockResolvedValue(phones);
    const choose = vi.fn(async ({ items }: { items: Array<{ value: unknown }> }) => items[1]!.value);
    const ctx = silentContext({ ...nonInteractivePrompter, interactive: true,
      text: async () => 'nobody@example.invalid', password: async () => 'fake-audit-password', choose: choose as never,
    });
    await guidedWslSetup({}, directory, ctx, new AbortController().signal);
    expect(choose).toHaveBeenCalledOnce();
    expect(registered()).toEqual({ udid: 'IPHONE-14-UDID', name: 'IK 14 Pro Max' });
  });

  it('registers the saved target iPhone without asking', async () => {
    boundary.options.mockResolvedValue({ sdk: '/audit/existing.sdk', python: configuredPython, target: 'iphone-14-udid' });
    boundary.devices.mockResolvedValue(phones);
    await guidedWslSetup({}, directory, context(), new AbortController().signal);
    expect(registered()).toEqual({ udid: 'IPHONE-14-UDID', name: 'IK 14 Pro Max' });
  });

  it('persists the actual failing download phase when free setup has no SDK or Xcode archive', async () => {
    boundary.options.mockResolvedValue({ python: configuredPython });
    // Free setup downloads Xcode itself; here the transfer stops.
    boundary.website.mockResolvedValue({ download: { version: '26.6', name: 'Xcode 26.6', fileName: 'Xcode_26.6_Apple_silicon.xip', url: 'https://download.developer.apple.com/Developer_Tools/Xcode_26.6/Xcode_26.6_Apple_silicon.xip' }, cookies: ['ADCDownloadAuth=grant'] });
    boundary.download.mockRejectedValue(new UserError('The Xcode download stopped before it finished.'));
    await expect(guidedWslSetup({}, directory, context(), new AbortController().signal)).rejects.toBeInstanceOf(UserError);
    const status = JSON.parse(await readFile(path.join(directory, '.capmac', 'wsl', 'setup-status.json'), 'utf8'));
    expect(status).toMatchObject({ phase: 'apple-download', state: 'failed' });
  });
});
