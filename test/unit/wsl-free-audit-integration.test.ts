/**
 * Audit probes for free signing's integration boundaries. These acceptance tests
 * express required behavior missing from the current implementation.
 * They run locally with no Apple requests, credentials, WSL, or device changes.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  paidLogin: vi.fn(), choose: vi.fn(), selectDevice: vi.fn(), project: vi.fn(),
  loadOptions: vi.fn(), profileTeam: vi.fn(), inspect: vi.fn(), provision: vi.fn(),
}));

vi.mock('../../packages/core/src/engine/wsl/apple-account.js', () => ({ loginAppleAccount: boundary.paidLogin }));
vi.mock('../../packages/core/src/engine/wsl/apple-web.js', () => ({
  chooseAppleSignIn: boundary.choose, signInOnAppleWebsite: vi.fn(), appleWeb: {},
}));
vi.mock('../../packages/core/src/engine/wsl/device.js', () => ({
  selectWslDevice: boundary.selectDevice, deviceHelperCommand: vi.fn(), listWslDevices: vi.fn(),
}));
vi.mock('../../packages/core/src/engine/wsl/index.js', () => ({ toolchainConfig: vi.fn(() => ({})) }));
vi.mock('../../packages/core/src/engine/wsl/toolchain.js', () => ({
  inspectWslToolchain: boundary.inspect, WslExecutor: class {},
}));
vi.mock('../../packages/core/src/engine/iphone/wda.js', () => ({
  profileTeam: boundary.profileTeam, wdaBundleId: (team: string) => `dev.capmac.wda.${team.toLowerCase()}`,
}));
vi.mock('../../packages/core/src/engine/project.js', () => ({ loadProject: boundary.project }));
vi.mock('../../packages/core/src/engine/wsl/settings.js', () => ({ loadWslOptions: boundary.loadOptions }));
vi.mock('../../packages/core/src/engine/wsl/bootstrap.js', () => ({
  devicePythonCurrent: () => true, MANAGED_XCODE_VERSION: '26.6',
}));
vi.mock('../../packages/core/src/engine/wsl/apple-signing.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../packages/core/src/engine/wsl/apple-signing.js')>(),
  prepareAppleSigningDirectory: async (directory?: string) => directory ?? 'C:\\audit-unused-signing',
}));
vi.mock('../../packages/core/src/engine/wsl/protect.js', () => ({ dpapi: async (_action: string, data: Buffer) => data }));

import { silentContext, nonInteractivePrompter } from '../../packages/core/src/engine/context.js';
import { setUpIphoneTouch } from '../../packages/core/src/engine/iphone/touch.js';
import { wslSetupState } from '../../packages/core/src/engine/wsl/setup.js';
import { setUpFreeSigning } from '../../packages/core/src/engine/wsl/free/free-signing.js';
import type { FreeApple } from '../../packages/core/src/engine/wsl/free/free-apple.js';

let directory: string;
const team = { id: 'ABCDE12345', name: 'Free personal team', free: true };
const bundleIdentifier = 'com.example.audit';

function profileContent(expirationDate: Date, groups?: string[], extraEntitlements: Record<string, plist.PlistValue> = {}): string {
  return Buffer.from(plist.build({
    ExpirationDate: expirationDate,
    TeamIdentifier: [team.id],
    ProvisionedDevices: ['00008120-AUDIT'],
    Entitlements: {
      'application-identifier': `${team.id}.${bundleIdentifier}`,
      ...(groups ? { 'com.apple.security.application-groups': groups } : {}),
      ...extraEntitlements,
    },
  })).toString('base64');
}

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-free-integration-audit-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('free signing integration audit: missing behavior', () => {
  it('routes the free choice in touch setup to free signing instead of paid login', async () => {
    boundary.loadOptions.mockResolvedValue({ certificate: path.join(directory, 'development.p12'), profile: path.join(directory, 'app.mobileprovision') });
    boundary.selectDevice.mockResolvedValue({ udid: '00008120-AUDIT', name: 'Audit iPhone', developerMode: 'enabled' });
    boundary.profileTeam.mockResolvedValue(team.id);
    boundary.inspect.mockResolvedValue({ ready: true, distro: 'Audit-Ubuntu', tools: {} });
    boundary.choose.mockResolvedValue({ way: 'free' });
    boundary.paidLogin.mockRejectedValue(new Error('AUDIT: free account was incorrectly sent to the paid login'));
    // Stop at the wrong login boundary; the probe never signs or installs anything.
    await setUpIphoneTouch({ cwd: directory, udid: '00008120-AUDIT' }, silentContext(), new AbortController().signal).catch(() => undefined);
    expect(boundary.choose).toHaveBeenCalledOnce();
    expect(boundary.paidLogin).not.toHaveBeenCalled();
  });

  it('marks an expired seven-day profile as needing setup again', async () => {
    const certificate = path.join(directory, 'development.p12');
    const profile = path.join(directory, 'app.mobileprovision');
    await writeFile(certificate, 'audit-certificate');
    await writeFile(profile, Buffer.from(profileContent(new Date('2020-01-01T00:00:00Z')), 'base64'));
    boundary.loadOptions.mockResolvedValue({ certificate, profile });
    boundary.project.mockResolvedValue({ kind: 'capacitor', capDir: directory });
    const state = await wslSetupState(directory);
    expect(state.signing).toBe(false);
  });

  it('hands the requested app-group identifiers to the provisioner so they can be assigned', async () => {
    await mkdir(path.join(directory, team.id), { recursive: true });
    const groups = ['group.com.example.audit'];
    boundary.provision.mockResolvedValue({
      certificate: { serial: 'AABB', notAfter: '2030-01-01T00:00:00Z' },
      p12: Buffer.from('audit-p12').toString('base64'), password: 'audit-password', notes: [],
      profiles: { [bundleIdentifier]: profileContent(new Date('2030-01-01T00:00:00Z'), groups) },
    });
    const runner = { provision: boundary.provision } as unknown as FreeApple;
    const ctx = silentContext({ ...nonInteractivePrompter, interactive: true, confirm: vi.fn(async () => true) });
    await setUpFreeSigning(runner, team, [{ name: 'Audit app', bundleIdentifier, extension: false, entitlements: { 'com.apple.security.application-groups': groups } }], ctx, { directory });
    expect(boundary.provision).toHaveBeenCalledWith(team.id, [expect.objectContaining({ appGroups: groups })], undefined, path.join(directory, team.id));
  });

  // Apple's current Supported capabilities (iOS) table marks both capabilities
  // available in the free "Apple Developer" column.
  it.each([
    ['com.apple.developer.default-data-protection', 'NSFileProtectionComplete'],
    ['com.apple.external-accessory.wireless-configuration', true],
  ])('allows the free-supported entitlement %s', async (key, value) => {
    const entitlements = { [key as string]: value as plist.PlistValue };
    boundary.provision.mockResolvedValue({
      certificate: { serial: 'AABB', notAfter: '2030-01-01T00:00:00Z' },
      p12: Buffer.from('audit-p12').toString('base64'), password: 'audit-password', notes: [],
      profiles: { [bundleIdentifier]: profileContent(new Date('2030-01-01T00:00:00Z'), undefined, entitlements) },
    });
    const runner = { provision: boundary.provision } as unknown as FreeApple;
    const ctx = silentContext({ ...nonInteractivePrompter, interactive: true, confirm: vi.fn(async () => true) });
    await expect(setUpFreeSigning(runner, team, [{ name: 'Audit app', bundleIdentifier, extension: false, entitlements }], ctx, { directory })).resolves.toBeDefined();
  });
});
