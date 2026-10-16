import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';
import { describe, expect, it } from 'vitest';
import { PREPARE_ENTITLEMENTS } from '../../packages/core/src/engine/wsl/compiler.js';

const python = ['python3', 'python'].find((name) => spawnSync(name, ['-c', 'import plistlib'], { timeout: 3000, windowsHide: true }).status === 0);

describe.skipIf(!python)('native application signing capabilities', () => {
  async function prepare(requested: Record<string, plist.PlistValue>, grantOverrides: Record<string, plist.PlistValue> = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-entitlements-'));
    try {
      const profile = path.join(directory, 'profile.plist');
      const request = path.join(directory, 'requested.plist');
      const output = path.join(directory, 'signed.plist');
      await writeFile(profile, plist.build({
        ApplicationIdentifierPrefix: ['PREFIX1234'], TeamIdentifier: ['TEAM123456'],
        Entitlements: {
          'application-identifier': 'PREFIX1234.com.example.*', 'com.apple.developer.team-identifier': 'TEAM123456',
          'get-task-allow': true, 'keychain-access-groups': ['PREFIX1234.*'],
          'com.apple.developer.associated-domains': ['*'], 'aps-environment': 'development',
          'com.apple.security.application-groups': ['group.com.example.shared'],
          ...grantOverrides,
        },
      }));
      await writeFile(request, plist.build(requested));
      const result = spawnSync(python!, ['-c', PREPARE_ENTITLEMENTS, profile, request, 'com.example.app', output], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const entitlements = result.status === 0 ? plist.parse(await readFile(output, 'utf8')) : undefined;
      return { ...result, entitlements };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  it('expands Apple identifier variables and retains the requested capabilities', async () => {
    const result = await prepare({
      'keychain-access-groups': ['$(AppIdentifierPrefix)${PRODUCT_BUNDLE_IDENTIFIER}'],
      'com.apple.developer.associated-domains': ['applinks:example.com'],
      'aps-environment': 'development',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.entitlements).toMatchObject({
      'application-identifier': 'PREFIX1234.com.example.app', 'com.apple.developer.team-identifier': 'TEAM123456',
      'keychain-access-groups': ['PREFIX1234.com.example.app'], 'com.apple.developer.associated-domains': ['applinks:example.com'],
      'aps-environment': 'development',
    });
  });

  it.each([
    { 'aps-environment': 'production' },
    { 'com.apple.security.application-groups': ['group.someone.else'] },
    { 'com.apple.developer.healthkit': true },
  ])('rejects capabilities absent from the provisioning profile: %j', async (request) => {
    const result = await prepare(request as unknown as Record<string, plist.PlistValue>);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not grant entitlement');
    expect(result.entitlements).toBeUndefined();
  });

  it('accepts a list entitlement that Apple grants as one wildcard string, as real profiles write associated domains', async () => {
    const result = await prepare({ 'com.apple.developer.associated-domains': ['applinks:play.example.com', 'webcredentials:example.com'] }, { 'com.apple.developer.associated-domains': '*' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.entitlements).toMatchObject({ 'com.apple.developer.associated-domains': ['applinks:play.example.com', 'webcredentials:example.com'] });
    const narrow = await prepare({ 'com.apple.developer.associated-domains': ['applinks:other.com'] }, { 'com.apple.developer.associated-domains': 'applinks:example.com' });
    expect(narrow.stderr).toContain('does not grant entitlement com.apple.developer.associated-domains');
  });

  it('rejects unresolved build variables before signing', async () => {
    const result = await prepare({ 'keychain-access-groups': ['$(CUSTOM_GROUP)'] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown entitlement build variable');
  });

  it('requires the signed application identifier to match the built app', async () => {
    const result = await prepare({ 'application-identifier': 'PREFIX1234.com.example.other' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match the application bundle identifier');
  });
});
