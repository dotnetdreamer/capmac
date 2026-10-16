import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';
import { describe, expect, it, vi } from 'vitest';
import { AppleSigningClient, appleProfileCovers, applyAppleSigningPlan, createAppleSigningRequest, createAppleSigningToken, exportAppleSigningIdentity, inspectAppleProfileContent, planAppleSigning, readAppleSigningInventory, removeAppleSigningRequest, type AppleResource, type AppleSigningInventory } from '../../packages/core/src/engine/wsl/apple-signing.js';
import type { WslExecutor, WslRunOptions } from '../../packages/core/src/engine/wsl/toolchain.js';

const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentials = { issuerId: '00000000-1111-2222-3333-444444444444', keyId: 'TESTKEY123', privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
function content(groups = ['group.dev.example.app']): string { return Buffer.from('CMS prefix' + plist.build({ ExpirationDate: new Date('2030-01-01T00:00:00Z'), ProvisionedDevices: ['DEVICE'], Entitlements: { 'application-identifier': 'TEAM.dev.example.app', 'aps-environment': 'development', 'com.apple.security.application-groups': groups, 'com.apple.developer.associated-domains': ['*'] } }) + 'CMS suffix').toString('base64'); }
const requirement = { bundleIdentifier: 'dev.example.app', entitlements: { 'aps-environment': 'development', 'com.apple.security.application-groups': ['group.dev.example.app'] } };
function inventory(): AppleSigningInventory {
  const profile: AppleResource = { type: 'profiles', id: 'PROFILE', attributes: { profileType: 'IOS_APP_DEVELOPMENT', profileState: 'ACTIVE', expirationDate: '2030-01-01', profileContent: content() }, relationships: { bundleId: { data: { type: 'bundleIds', id: 'BUNDLE' } }, certificates: { data: [{ type: 'certificates', id: 'CERT' }] }, devices: { data: [{ type: 'devices', id: 'DEVICE' }] } } };
  return { bundleIds: [{ type: 'bundleIds', id: 'BUNDLE', attributes: { identifier: 'dev.example.app' } }], certificates: [{ type: 'certificates', id: 'CERT', attributes: { certificateType: 'DEVELOPMENT', expirationDate: '2030-01-01' } }], devices: [{ type: 'devices', id: 'DEVICE', attributes: { platform: 'IOS', status: 'ENABLED' } }], profiles: [profile], capabilities: { 'dev.example.app': [{ type: 'bundleIdCapabilities', id: 'CAP', attributes: { capabilityType: 'APP_GROUPS' } }, { type: 'bundleIdCapabilities', id: 'PUSH', attributes: { capabilityType: 'PUSH_NOTIFICATIONS' } }] }, appGroups: { assignmentApiAvailable: false, identifiersFromProfiles: ['group.dev.example.app'] } };
}

describe('Apple signing inventory and additive provisioning', () => {
  it('creates a verifiable ES256 token with bounded expiration and never serializes the API private key', () => {
    const token = createAppleSigningToken(credentials, 1_800_000_000); const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toMatchObject({ alg: 'ES256', kid: credentials.keyId });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ iat: 1_799_999_995, exp: 1_800_000_600, aud: 'appstoreconnect-v1' });
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(JSON.stringify(new AppleSigningClient(credentials))).not.toContain('PRIVATE KEY');
  });
  it('refuses credential forwarding through external pagination links', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [], links: { next: 'https://unrelated.example/v1/profiles' } }), { status: 200 }));
    const client = new AppleSigningClient(credentials, { fetch: fetcher as typeof fetch });
    await expect(client.list('/v1/profiles')).rejects.toThrow(/unrelated API/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('explains an insufficient API role without disclosing authentication', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 'FORBIDDEN', title: 'Operation forbidden' }] }), { status: 403 }));
    const client = new AppleSigningClient(credentials, { fetch: fetcher as typeof fetch });
    await expect(client.request('POST', '/v1/certificates', {})).rejects.toMatchObject({ status: 403, hint: expect.stringContaining('does not have permission') });
  });
  it('uses the actual capabilities endpoint without an unsupported limit and restricts prefix-matched App IDs', async () => {
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/bundleIds') return new Response(JSON.stringify({ data: [{ type: 'bundleIds', id: 'APP', attributes: { identifier: 'dev.example.app' } }, { type: 'bundleIds', id: 'DESKTOP', attributes: { identifier: 'dev.example.app.desktop' } }] }));
      if (url.pathname.endsWith('/bundleIdCapabilities')) {
        expect(url.pathname).toBe('/v1/bundleIds/APP/bundleIdCapabilities'); expect(url.search).toBe('');
        return new Response(JSON.stringify({ data: [{ type: 'bundleIdCapabilities', id: 'GROUPS', attributes: { capabilityType: 'APP_GROUPS' } }] }));
      }
      return new Response(JSON.stringify({ data: [] }));
    });
    const result = await readAppleSigningInventory(new AppleSigningClient(credentials, { fetch: fetcher as typeof fetch }), ['dev.example.app']);
    expect(result.bundleIds.map((item) => item.id)).toEqual(['APP']);
    expect(result.capabilities['dev.example.app']![0]!.attributes.capabilityType).toBe('APP_GROUPS');
  });
  it('reuses only profiles granting every declared app capability and matching a locally available signing identity', () => {
    const plan = planAppleSigning(inventory(), [requirement], { certificateIds: ['CERT'] });
    expect(plan).toMatchObject({ createCertificate: false, reuseProfiles: [{ bundleIdentifier: 'dev.example.app', profileId: 'PROFILE' }], createProfiles: [], blockers: [] });
    expect(appleProfileCovers(inspectAppleProfileContent(content([])), requirement)).toBe(false);
    expect(appleProfileCovers(inspectAppleProfileContent(content()), { ...requirement, entitlements: { 'com.apple.developer.associated-domains': ['applinks:example.com'] } })).toBe(true);
  });
  it('plans new certificates when only Mac identities exist, preserving all existing account resources', () => {
    const state = inventory(); state.certificates[0]!.attributes.certificateType = 'MAC_APP_DISTRIBUTION'; const before = JSON.stringify(state);
    const plan = planAppleSigning(state, [requirement], { certificateIds: ['CERT'] });
    expect(plan.createCertificate).toBe(true); expect(plan.createProfiles).toHaveLength(1); expect(plan.reuseProfiles).toEqual([]);
    expect(JSON.stringify(state)).toBe(before);
  });
  it('plans separate host and widget profiles and never weakens their shared app-group requirement', () => {
    const state = inventory(); state.bundleIds.push({ type: 'bundleIds', id: 'WIDGET', attributes: { identifier: 'dev.example.app.HomeCard' } });
    const widget = { bundleIdentifier: 'dev.example.app.HomeCard', entitlements: { 'com.apple.security.application-groups': ['group.dev.example.app'] } };
    const plan = planAppleSigning(state, [requirement, widget], { certificateIds: ['CERT'] });
    expect(plan.reuseProfiles).toHaveLength(1); expect(plan.createProfiles[0]).toMatchObject({ bundleId: 'WIDGET', entitlements: widget.entitlements });
    expect(plan.enableCapabilities).toEqual([{ bundleIdentifier: widget.bundleIdentifier, bundleId: 'WIDGET', capabilityType: 'APP_GROUPS' }]);
  });
  it('stops before mutations when required App IDs or devices are absent', async () => {
    const state = inventory(); state.devices = []; const plan = planAppleSigning(state, [requirement], { certificateIds: ['CERT'] });
    const fetcher = vi.fn(); const client = new AppleSigningClient(credentials, { fetch: fetcher });
    await expect(applyAppleSigningPlan(client, plan)).rejects.toThrow(/unresolved prerequisites/); expect(fetcher).not.toHaveBeenCalled();
  });
  it('downloads a reusable profile privately without making any account mutation', async () => {
    const state = inventory(); const plan = planAppleSigning(state, [requirement], { certificateIds: ['CERT'] });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: state.profiles[0] }), { status: 200 }));
    const client = new AppleSigningClient(credentials, { fetch: fetcher as typeof fetch }); const directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-signing-test-'));
    try {
      const result = await applyAppleSigningPlan(client, plan, { directory });
      expect(await readFile(result.profilePaths[requirement.bundleIdentifier]!)).toEqual(Buffer.from(content(), 'base64'));
      expect(fetcher.mock.calls[0]).toBeDefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps generated identity keys in a private WSL directory and transmits the export password only on stdin', async () => {
    const calls: { argv: string[]; options: WslRunOptions }[] = [];
    const executor = { path: async (value: string) => value, run: async (argv: string[], options: WslRunOptions = {}) => { calls.push({ argv, options }); return { code: 0, stderr: '', stdout: argv[0] === 'mktemp' ? '/tmp/capmac-csr.ABC12345\n' : argv[0] === 'cat' ? '-----BEGIN CERTIFICATE REQUEST-----\npublic-csr\n-----END CERTIFICATE REQUEST-----\n' : '' }; } } as unknown as WslExecutor;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-identity-test-'));
    try {
      const request = await createAppleSigningRequest(executor);
      const password = 'private-identity-password'; await exportAppleSigningIdentity(executor, request, '/private/certificate.cer', password, { directory });
      expect(calls.some((call) => call.argv.join(' ') === 'chmod 600 /tmp/capmac-csr.ABC12345/identity.key')).toBe(true);
      const exported = calls.find((call) => call.argv[0] === 'openssl' && call.argv[1] === 'pkcs12')!;
      expect(exported.argv).toContain('stdin'); expect(exported.options.stdin).toBe(password + '\n');
      expect(JSON.stringify(calls.map((call) => call.argv))).not.toContain(password);
      await removeAppleSigningRequest(executor, request);
      expect(calls.at(-1)!.argv).toEqual(['rm', '-rf', '--', '/tmp/capmac-csr.ABC12345']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
