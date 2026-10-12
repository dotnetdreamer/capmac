import { describe, expect, it } from 'vitest';
// @ts-expect-error: a build script without type declarations
import { releaseConfig } from '../scripts/release-config.mjs';
import { describeUpdateError, feedUrl, notesUrl } from '../src/main/update-text';

const AZURE = {
  CAPMAC_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net/',
  CAPMAC_AZURE_SIGNING_ACCOUNT: 'capmac',
  CAPMAC_AZURE_SIGNING_PROFILE: 'capmac-studio',
  CAPMAC_SIGNING_PUBLISHER: 'CN=capmac contributors',
  AZURE_TENANT_ID: 'tenant',
  AZURE_CLIENT_ID: 'client',
  AZURE_CLIENT_SECRET: 'secret',
};

describe('release builds', () => {
  it('builds unsigned, without an update feed, when nothing is set', () => {
    const r = releaseConfig({});
    expect(r.signing).toBeNull();
    expect(r.config).toEqual({ win: { verifyUpdateCodeSignature: false }, publish: null });
    expect(r.notes.join(' ')).toMatch(/unsigned/);
  });

  it('signs with Azure Trusted Signing', () => {
    const r = releaseConfig(AZURE);
    expect(r.signing).toBe('azure');
    expect(r.config.win).toEqual({
      azureSignOptions: { publisherName: 'CN=capmac contributors', endpoint: 'https://weu.codesigning.azure.net/', codeSigningAccountName: 'capmac', certificateProfileName: 'capmac-studio' },
      verifyUpdateCodeSignature: true,
    });
    // The secret stays in the environment: it is not part of the build's configuration.
    expect(JSON.stringify(r.config)).not.toContain('secret');
  });

  it('says what is missing from a half-configured Azure setup', () => {
    const { AZURE_CLIENT_SECRET: _, CAPMAC_AZURE_SIGNING_PROFILE: __, ...partial } = AZURE;
    expect(() => releaseConfig(partial)).toThrow(/CAPMAC_AZURE_SIGNING_PROFILE, .*AZURE_CLIENT_SECRET/);
  });

  it('signs with a certificate file, SHA-256 only, timestamped', () => {
    const r = releaseConfig({ CSC_LINK: 'C:\\certs\\capmac.pfx', CSC_KEY_PASSWORD: 'pw' });
    expect(r.signing).toBe('certificate');
    expect(r.config.win).toEqual({ signtoolOptions: { signingHashAlgorithms: ['sha256'], rfc3161TimeStampServer: 'http://timestamp.digicert.com' }, verifyUpdateCodeSignature: true });
    expect(JSON.stringify(r.config)).not.toContain('pw');
    expect(() => releaseConfig({ CSC_LINK: 'x.pfx' })).toThrow(/CSC_KEY_PASSWORD/);
  });

  it('signs with a certificate on a token or in the Windows store, by thumbprint', () => {
    const r = releaseConfig({ CAPMAC_SIGNING_SHA1: 'AB CD EF 01', CAPMAC_TIMESTAMP_URL: 'http://timestamp.sectigo.com', CAPMAC_SIGNING_PUBLISHER: 'capmac' });
    expect(r.signing).toBe('store');
    expect(r.config.win.signtoolOptions).toEqual({ signingHashAlgorithms: ['sha256'], rfc3161TimeStampServer: 'http://timestamp.sectigo.com', certificateSha1: 'ABCDEF01', publisherName: 'capmac' });
  });

  it('turns updates on from a feed URL, and only an https one (or this PC, for testing)', () => {
    expect(releaseConfig({ CAPMAC_UPDATE_URL: 'https://downloads.example.com/studio/' }).config.publish).toEqual([{ provider: 'generic', url: 'https://downloads.example.com/studio/' }]);
    expect(releaseConfig({ CAPMAC_UPDATE_URL: 'http://127.0.0.1:47219/' }).config.publish).toEqual([{ provider: 'generic', url: 'http://127.0.0.1:47219/' }]);
    expect(() => releaseConfig({ CAPMAC_UPDATE_URL: 'http://downloads.example.com/' })).toThrow(/https/);
  });

  it('builds another version without editing package.json', () => {
    expect(releaseConfig({ CAPMAC_VERSION: '0.2.0' }).config.extraMetadata).toEqual({ version: '0.2.0' });
  });
});

describe('updater text', () => {
  it('reads the feed from app-update.yml', () => {
    expect(feedUrl("provider: generic\nurl: https://downloads.example.com/studio/\nupdaterCacheDirName: '@capmacdesktop-updater'\n")).toBe('https://downloads.example.com/studio/');
    expect(feedUrl("provider: generic\nurl: 'http://127.0.0.1:47219/'\n")).toBe('http://127.0.0.1:47219/');
    expect(feedUrl('provider: github\n')).toBeNull();
  });

  it('fills the version into the release notes link', () => {
    expect(notesUrl('https://github.com/acme/capmac/releases/tag/v{version}', '0.2.0')).toBe('https://github.com/acme/capmac/releases/tag/v0.2.0');
    expect(notesUrl('', '0.2.0')).toBeNull();
  });

  it('explains update failures in plain words', () => {
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND downloads.example.com'))).toMatch(/could not be reached/);
    expect(describeUpdateError(new Error('HttpError: 404 Not Found "method: GET url: https://x/latest.yml"'))).toMatch(/no capmac Studio release/);
    expect(describeUpdateError(new Error('sha512 checksum mismatch, expected abc'))).toMatch(/damaged/);
    expect(describeUpdateError(new Error('New version 0.2.0 is not signed by the application owner: publisherNames: capmac'))).toMatch(/not signed/);
    expect(describeUpdateError(new Error('Something odd\nstack'))).toBe('The update check failed: Something odd');
  });
});
