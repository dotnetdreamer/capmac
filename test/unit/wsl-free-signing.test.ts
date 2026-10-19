/**
 * setUpFreeSigning: turns a free sign-in into the same result the build consumes.
 * The Apple-facing parts (the signing directory, profile inspection, Windows data
 * protection) are faked, so this checks the policy: capabilities are filtered,
 * unsupported entitlements are refused up front, and the files land where the
 * build reads them.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../packages/core/src/engine/wsl/apple-signing.js', () => ({
  prepareAppleSigningDirectory: async (directory?: string) => directory ?? os.tmpdir(),
  inspectAppleProfileContent: () => ({ entitlements: {}, bundleIdentifier: '', deviceUdids: ['00008120-TEST'] }),
  appleProfileCovers: () => true,
}));
vi.mock('../../packages/core/src/engine/wsl/protect.js', () => ({
  dpapi: async (_action: string, data: Buffer) => data,
}));

import { silentContext, type Prompter } from '../../packages/core/src/engine/context.js';
import type { SigningTarget } from '../../packages/core/src/engine/wsl/apple-auto-signing.js';
import type { FreeApple, FreeProvisionResult, FreeProvisionTarget } from '../../packages/core/src/engine/wsl/free/free-apple.js';
import { setUpFreeSigning } from '../../packages/core/src/engine/wsl/free/free-signing.js';

const team = { id: 'ABCDE12345', name: 'My Free Account', free: true };
const app: SigningTarget = { name: 'App', bundleIdentifier: 'com.example.app', extension: false, entitlements: {} };

function fakeRunner(onProvision: (team: string, targets: FreeProvisionTarget[]) => FreeProvisionResult) {
  const provision = vi.fn(async (teamId: string, targets: FreeProvisionTarget[]) => onProvision(teamId, targets));
  return { provision } as unknown as FreeApple & { provision: ReturnType<typeof vi.fn> };
}

const okResult = (bundleIds: string[]): FreeProvisionResult => ({
  certificate: { serial: 'AABB', notAfter: '2030-01-01T00:00:00Z' },
  p12: Buffer.from('p12-bytes').toString('base64'), password: 'secret',
  profiles: Object.fromEntries(bundleIds.map((id) => [id, Buffer.from(`profile ${id}`).toString('base64')])),
  notes: [],
});

let tempDir: string | undefined;
afterEach(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); tempDir = undefined; });

describe('setUpFreeSigning', () => {
  it('provisions an app with no extra capabilities and saves the files the build reads', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'capmac-free-'));
    const runner = fakeRunner((_teamId, _targets) => okResult(['com.example.app']));
    const prompter: Prompter = { interactive: true, text: vi.fn(), password: vi.fn(), choose: vi.fn(), confirm: vi.fn(async () => true) };

    const result = await setUpFreeSigning(runner, team, [app], silentContext(prompter), {
      directory: tempDir, connectedDevice: { udid: '00008120-TEST', name: 'Test iPhone' },
    });

    expect(runner.provision).toHaveBeenCalledWith('ABCDE12345', [{ bundleIdentifier: 'com.example.app', capabilities: [] }], { udid: '00008120-TEST', name: 'Test iPhone' }, path.join(tempDir, 'ABCDE12345'));
    expect(result.certificate).toBe(path.join(tempDir, 'ABCDE12345', 'development.p12'));
    expect(result.profile).toBe(path.join(tempDir, 'ABCDE12345', 'com.example.app.mobileprovision'));
    expect(result.extensionProfiles).toEqual({});
    expect((await readFile(result.profile)).toString()).toBe('profile com.example.app');
    const saved = JSON.parse((await readFile(path.join(tempDir, 'ABCDE12345', 'development.json'))).toString());
    expect(saved).toMatchObject({ serialNumber: 'AABB', free: true });
  });

  it('keeps only the capabilities a free account supports', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'capmac-free-'));
    const target: SigningTarget = { name: 'App', bundleIdentifier: 'com.example.app', extension: false,
      entitlements: { 'com.apple.developer.healthkit': true, 'com.apple.developer.homekit': true } };
    const runner = fakeRunner(() => okResult(['com.example.app']));
    const prompter: Prompter = { interactive: true, text: vi.fn(), password: vi.fn(), choose: vi.fn(), confirm: vi.fn(async () => true) };

    await setUpFreeSigning(runner, team, [target], silentContext(prompter), { directory: tempDir });

    const [, targets] = runner.provision.mock.calls[0]!;
    expect((targets as FreeProvisionTarget[])[0]!.capabilities.sort()).toEqual(['HEALTHKIT', 'HOMEKIT']);
  });

  it('refuses up front when the app needs entitlements a free account can’t sign', async () => {
    const target: SigningTarget = { name: 'App', bundleIdentifier: 'com.example.app', extension: false,
      entitlements: { 'aps-environment': 'development' } };
    const runner = fakeRunner(() => okResult(['com.example.app']));
    const prompter: Prompter = { interactive: true, text: vi.fn(), password: vi.fn(), choose: vi.fn(), confirm: vi.fn(async () => true) };

    await expect(setUpFreeSigning(runner, team, [target], silentContext(prompter), {})).rejects.toThrow(/aps-environment/);
    expect(runner.provision).not.toHaveBeenCalled();
  });

  it('forwards App Group identifiers to the provisioner (a free account supports them)', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'capmac-free-'));
    const target: SigningTarget = { name: 'App', bundleIdentifier: 'com.example.app', extension: false,
      entitlements: { 'com.apple.security.application-groups': ['group.com.example'] } };
    const runner = fakeRunner(() => okResult(['com.example.app']));
    const prompter: Prompter = { interactive: true, text: vi.fn(), password: vi.fn(), choose: vi.fn(), confirm: vi.fn(async () => true) };

    await setUpFreeSigning(runner, team, [target], silentContext(prompter), { directory: tempDir });

    const [, targets] = runner.provision.mock.calls[0]!;
    expect((targets as FreeProvisionTarget[])[0]!.appGroups).toEqual(['group.com.example']);
    expect((targets as FreeProvisionTarget[])[0]!.capabilities).toContain('APP_GROUPS');
  });

  it('stops when the developer does not confirm', async () => {
    const runner = fakeRunner(() => okResult(['com.example.app']));
    const prompter: Prompter = { interactive: true, text: vi.fn(), password: vi.fn(), choose: vi.fn(), confirm: vi.fn(async () => false) };

    await expect(setUpFreeSigning(runner, team, [app], silentContext(prompter), {})).rejects.toThrow(/skipped/i);
    expect(runner.provision).not.toHaveBeenCalled();
  });
});
