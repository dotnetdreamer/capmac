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
  grant: vi.fn(), download: vi.fn(), sdk: vi.fn(),
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
  chooseAppleSignIn: async () => ({ way: 'free' }), signInOnAppleWebsite: vi.fn(),
}));
vi.mock('../../packages/core/src/engine/wsl/apple-account.js', () => ({
  loginAppleAccount: vi.fn(), downloadXcodeWithGrant: boundary.download,
  pinnedXcodeDownload: (version: string) => ({ version, name: `Xcode ${version}`, fileName: `Xcode_${version}_Apple_silicon.xip`,
    url: `https://download.developer.apple.com/Developer_Tools/Xcode_${version}/Xcode_${version}_Apple_silicon.xip` }),
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
  FreeApple: class { login = boundary.login; close = boundary.close; downloadGrant = boundary.grant; },
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

  it('downloads the managed Xcode with the free sign-in’s grant when this PC has none', async () => {
    boundary.options.mockResolvedValue({ python: configuredPython }); // no iPhone SDK yet, none in Downloads
    boundary.grant.mockResolvedValue(['ADCDownloadAuth=grant']);
    boundary.download.mockImplementation(async (_cookies: unknown, _download: unknown, destination: string) => destination);
    boundary.sdk.mockResolvedValue({ sdkPath: '/audit/iPhoneOS.sdk', swiftResourcePath: '/audit/swift', xcodeVersion: '26.6' });
    await guidedWslSetup({}, directory, context(), new AbortController().signal);
    expect(boundary.grant).toHaveBeenCalledWith('/Developer_Tools/Xcode_26.6/Xcode_26.6_Apple_silicon.xip');
    expect(boundary.download).toHaveBeenCalledWith(['ADCDownloadAuth=grant'], expect.objectContaining({ fileName: 'Xcode_26.6_Apple_silicon.xip' }),
      archive(), expect.objectContaining({ onProgress: expect.any(Function) }));
    // The archive then goes on to the SDK import like a paid account's.
    expect(boundary.sdk).toHaveBeenCalledWith(expect.anything(), archive(), expect.anything());
    expect(boundary.save).toHaveBeenLastCalledWith(expect.objectContaining({ sdk: '/audit/iPhoneOS.sdk', xcodeVersion: '26.6' }), directory);
    expect(boundary.close).toHaveBeenCalled();
  });

  it('says how to get it by hand when Apple won’t grant the download', async () => {
    boundary.options.mockResolvedValue({ python: configuredPython });
    boundary.grant.mockRejectedValue(new UserError('Apple did not allow the Xcode download (HTTP 403).'));
    await expect(guidedWslSetup({}, directory, context(), new AbortController().signal)).rejects.toMatchObject({
      message: 'Apple didn’t let CapMac download Xcode on this free sign-in.',
      hint: expect.stringContaining('developer.apple.com/download/all'),
      details: ['Apple did not allow the Xcode download (HTTP 403).'],
    });
    expect(boundary.download).not.toHaveBeenCalled();
    expect(boundary.close).toHaveBeenCalled();
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
    // Free setup now downloads Xcode itself; here Apple turns the download away.
    boundary.grant.mockRejectedValue(new UserError('Apple did not allow the Xcode download (HTTP 403).'));
    await expect(guidedWslSetup({}, directory, context(), new AbortController().signal)).rejects.toBeInstanceOf(UserError);
    const status = JSON.parse(await readFile(path.join(directory, '.capmac', 'wsl', 'setup-status.json'), 'utf8'));
    expect(status).toMatchObject({ phase: 'apple-download', state: 'failed' });
  });
});
