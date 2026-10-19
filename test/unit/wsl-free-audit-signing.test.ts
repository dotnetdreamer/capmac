/** Independent audit: use the real profile parser and coverage checks.
 * Only Windows password protection and the Apple transport are substituted.
 * These are acceptance tests; failures identify gaps in the experimental path.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nonInteractivePrompter, silentContext } from '../../packages/core/src/engine/context.js';
import type { SigningTarget } from '../../packages/core/src/engine/wsl/apple-auto-signing.js';
import { inspectAppleProfileContent, appleProfileCovers } from '../../packages/core/src/engine/wsl/apple-signing.js';
import type { FreeApple, FreeProvisionResult } from '../../packages/core/src/engine/wsl/free/free-apple.js';
import { planFreeCapabilities } from '../../packages/core/src/engine/wsl/free/free-capabilities.js';
import { setUpFreeSigning } from '../../packages/core/src/engine/wsl/free/free-signing.js';

vi.mock('../../packages/core/src/engine/wsl/protect.js', () => ({
  dpapi: async (_action: string, data: Buffer) => data,
}));

const team = { id: 'ABCDE12345', name: 'Audit account', free: true };
const app: SigningTarget = { name: 'App', bundleIdentifier: 'com.example.audit', extension: false, entitlements: {} };
const selected = { udid: 'AUDIT-SELECTED-IPHONE', name: 'Selected iPhone' };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function directory() {
  const result = await mkdtemp(path.join(os.tmpdir(), 'capmac-free-audit-'));
  directories.push(result);
  return result;
}

function profile(entitlements: Record<string, plist.PlistValue> = {}, devices = [selected.udid]): string {
  // Synthetic XML exercises the production parser; no live Apple CMS is claimed.
  return Buffer.from(plist.build({
    ExpirationDate: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    ProvisionedDevices: devices,
    Entitlements: { 'application-identifier': `${team.id}.${app.bundleIdentifier}`, ...entitlements },
  })).toString('base64');
}

function runner(content = profile()) {
  const provision = vi.fn(async (): Promise<FreeProvisionResult> => ({
    certificate: { serial: 'AUDIT', notAfter: '2030-01-01T00:00:00Z' },
    p12: Buffer.from('new-identity-from-transport').toString('base64'), password: 'new-password',
    profiles: { [app.bundleIdentifier]: content }, notes: [],
  }));
  return { instance: { provision } as unknown as FreeApple, provision };
}

const context = () => silentContext({ ...nonInteractivePrompter, interactive: true, confirm: async () => true });

describe('free signing independent acceptance audit', () => {
  it('uses a real profile parser that detects an absent required entitlement (control)', () => {
    const details = inspectAppleProfileContent(profile());
    expect(appleProfileCovers(details, { bundleIdentifier: app.bundleIdentifier, entitlements: {} })).toBe(true);
    expect(appleProfileCovers(details, { bundleIdentifier: app.bundleIdentifier, entitlements: { 'com.apple.developer.healthkit': true } })).toBe(false);
  });

  it('refuses a profile that did not grant the requested HealthKit entitlement', async () => {
    const transport = runner(profile());
    const target = { ...app, entitlements: { 'com.apple.developer.healthkit': true } };
    await expect(setUpFreeSigning(transport.instance, team, [target], context(), {
      directory: await directory(), connectedDevice: selected,
    })).rejects.toThrow();
  });

  it('refuses a profile that cannot be installed on the selected iPhone', async () => {
    const transport = runner(profile({}, ['SOME-OTHER-IPHONE']));
    await expect(setUpFreeSigning(transport.instance, team, [app], context(), {
      directory: await directory(), connectedDevice: selected,
    })).rejects.toThrow();
  });

  it('preserves a working local identity when the returned profile is invalid', async () => {
    const root = await directory();
    const teamDir = path.join(root, team.id);
    await mkdir(teamDir);
    const identity = path.join(teamDir, 'development.p12');
    await writeFile(identity, 'previous-working-identity');
    await writeFile(`${identity}.dpapi`, 'previous-working-password');
    const transport = runner(Buffer.from('not a profile').toString('base64'));
    await expect(setUpFreeSigning(transport.instance, team, [app], context(), { directory: root })).rejects.toThrow();
    expect(await readFile(identity, 'utf8')).toBe('previous-working-identity');
    expect(await readFile(`${identity}.dpapi`, 'utf8')).toBe('previous-working-password');
  });

  it('rejects Network Extensions for a free account according to Apple’s capability table', () => {
    // https://developer.apple.com/help/account/reference/supported-capabilities-ios/
    // Network extensions has no checkmark in the free Apple Developer column.
    expect(planFreeCapabilities(['NETWORK_EXTENSIONS'], []).unsupported).toEqual(['NETWORK_EXTENSIONS']);
  });
});
