import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import plist from 'plist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nonInteractivePrompter, silentContext, type Prompter } from '../../packages/core/src/engine/context.js';

// Windows data protection is replaced by a reversible stand-in so the flow runs anywhere.
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn((_command: string, args: string[]) => {
    const protect = args.at(-1)!.includes('::Protect(');
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let input = '';
    child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString(); });
    child.stdin.on('end', () => {
      const data = Buffer.from(input.trim(), 'base64');
      child.stdout.end((protect ? Buffer.concat([Buffer.from('sealed:'), data]) : data.subarray(7)).toString('base64'));
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }),
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const { savedCertificatePassword, setUpAutomaticSigning, signingNeeds } = await import('../../packages/core/src/engine/wsl/apple-auto-signing.js');
const { AppleWebStopped } = await import('../../packages/core/src/engine/wsl/apple-web.js');
const { CancelledError, UserError } = await import('../../packages/core/src/engine/errors.js');

const TEAM = 'ABCDE12345';
const appEntitlements = { 'aps-environment': 'development', 'com.apple.developer.applesignin': ['Default'], 'com.apple.developer.game-center': true, 'com.apple.developer.associated-domains': ['applinks:play.example.test'], 'com.apple.security.application-groups': ['group.dev.example'] };
const app = { name: 'App', bundleIdentifier: 'dev.example.app', extension: false, entitlements: appEntitlements };
const widget = { name: 'Widget', bundleIdentifier: 'dev.example.app.widget', extension: true, entitlements: { 'com.apple.security.application-groups': ['group.dev.example'] } };
/** A profile as Apple returns it: a CMS envelope around a property list, base64-encoded. */
const profileContent = (bundleIdentifier: string, entitlements: Record<string, plist.PlistValue>) => Buffer.from('cms-header' + plist.build({
  ExpirationDate: new Date(Date.now() + 365 * 86_400_000), ProvisionedDevices: ['00008120-0001'],
  Entitlements: { 'application-identifier': `${TEAM}.${bundleIdentifier}`, ...entitlements },
}) + 'cms-signature').toString('base64');
const grants = { 'aps-environment': 'development', 'com.apple.developer.applesignin': ['Default'], 'com.apple.developer.game-center': true, 'com.apple.developer.associated-domains': '*', 'com.apple.security.application-groups': ['group.dev.example'] };

let directory: string;
let expo: ReturnType<typeof fakeExpo>;
let session: ReturnType<typeof fakeSession>;
function fakeExpo() {
  const appBundle = { id: 'APPID', attributes: { identifier: 'dev.example.app' }, getBundleIdCapabilitiesAsync: vi.fn(async () => [{ id: 'APPID_PUSH_NOTIFICATIONS', attributes: { capabilityType: 'PUSH_NOTIFICATIONS' } }, { id: 'APPID_GAME_CENTER', attributes: {} }]), updateBundleIdCapabilityAsync: vi.fn() };
  const widgetBundle = { id: 'WIDGETID', attributes: { identifier: 'dev.example.app.widget' }, getBundleIdCapabilitiesAsync: vi.fn(async () => []), updateBundleIdCapabilityAsync: vi.fn() };
  // App IDs Apple's website added: Apple's API lists them from then on.
  const listed = new Set<string>();
  return {
    appBundle, widgetBundle, listed,
    BundleId: { findAsync: vi.fn(async (_context, { identifier }) => identifier === 'dev.example.app' ? appBundle : listed.has(identifier) ? widgetBundle : null), createAsync: vi.fn(async () => widgetBundle) },
    Device: {
      getAllIOSProfileDevicesAsync: vi.fn(async () => [{ id: 'DEV1', attributes: { udid: '00008120-0001', status: 'ENABLED', deviceClass: 'IPHONE' } }, { id: 'TV', attributes: { udid: 'tv', status: 'ENABLED', deviceClass: 'APPLE_TV' } }]),
      createAsync: vi.fn(async () => ({ id: 'DEV2' })),
    },
    Certificate: { getAsync: vi.fn(async () => []) },
    createCertificateAndP12Async: vi.fn(async () => ({ certificate: { id: 'CERT', attributes: { serialNumber: '01', expirationDate: '2027-10-16T00:00:00.000+0000' } }, certificateP12: Buffer.from('p12-bytes').toString('base64'), password: 'p12-password', privateSigningKey: 'never-saved' })),
    Profile: { createAsync: vi.fn(async (_context, { bundleId }) => ({ id: `PROFILE-${bundleId}`, attributes: { profileContent: profileContent(bundleId === 'APPID' ? 'dev.example.app' : 'dev.example.app.widget', grants) } })) },
    CapabilityTypeOption: { ON: 'ON' }, CertificateType: { DEVELOPMENT: 'DEVELOPMENT', IOS_DEVELOPMENT: 'IOS_DEVELOPMENT' },
    BundleIdPlatform: { IOS: 'IOS' }, ProfileType: { IOS_APP_DEVELOPMENT: 'IOS_APP_DEVELOPMENT' },
  };
}
function fakeSession() {
  return {
    team: { id: TEAM, name: 'Example Team' },
    via: 'password' as 'password' | 'website',
    connect: vi.fn(async (fn: (expo: unknown, context: unknown) => Promise<unknown>) => fn(expo, { teamId: TEAM })),
    planAppGroupAssignments: vi.fn(async () => ({ teamId: TEAM, groupsToCreate: ['group.dev.example'], assignments: [{ bundleIdentifier: 'dev.example.app', bundleId: 'APPID', requiredGroups: ['group.dev.example'], existingGroups: [], needsUpdate: true }] })),
    applyAppGroupAssignments: vi.fn(async () => undefined),
  };
}
const prompter = (answer = true): Prompter => ({ ...nonInteractivePrompter, interactive: true, confirm: vi.fn(async () => answer) });
const run = (ctxPrompter = prompter(), options: Record<string, unknown> = {}) =>
  setUpAutomaticSigning(session as never, [app, widget], silentContext(ctxPrompter), { directory, connectedDevices: [{ udid: '00008120-0001', name: 'Known' }, { udid: '00008120-0002', name: 'New iPhone' }], ...options });

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-auto-signing-'));
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  expo = fakeExpo(); session = fakeSession();
});
afterEach(async () => { Object.defineProperty(process, 'platform', platform); await rm(directory, { recursive: true, force: true }); });

describe('which capabilities an app needs', () => {
  it('maps entitlements to App ID capabilities, app groups and portal-only features', () => {
    expect(signingNeeds(app)).toEqual({ capabilities: ['APPLE_ID_AUTH', 'ASSOCIATED_DOMAINS', 'GAME_CENTER', 'PUSH_NOTIFICATIONS'], appGroups: ['group.dev.example'], portalOnly: [], unknown: [] });
    expect(signingNeeds({ ...app, entitlements: { 'com.apple.developer.icloud-container-identifiers': ['iCloud.dev'], 'keychain-access-groups': ['$(AppIdentifierPrefix)dev'], 'com.apple.developer.future-thing': true } }))
      .toEqual({ capabilities: [], appGroups: [], portalOnly: ['iCloud'], unknown: ['com.apple.developer.future-thing'] });
  });
});

describe('automatic development signing', () => {
  it('shows every account change, then adds only what is missing and saves the files', async () => {
    const ask = prompter();
    const result = await run(ask);
    const detail = vi.mocked(ask.confirm).mock.calls[0]![0].detail!;
    expect(detail).toContain('Make an Apple Development certificate for this PC');
    expect(detail).toContain('Register the iPhone “New iPhone”');
    expect(detail).toContain('Add the App ID dev.example.app.widget');
    expect(detail).toContain('Turn on Sign in with Apple, Associated Domains for dev.example.app');
    expect(detail).not.toContain('Push Notifications');
    expect(detail).toContain('Nothing in your account is removed');
    // Additive: only the missing capabilities, no deletions.
    expect(expo.appBundle.updateBundleIdCapabilityAsync.mock.calls.map(([update]) => update.capabilityType)).toEqual(['APPLE_ID_AUTH', 'ASSOCIATED_DOMAINS']);
    expect(expo.BundleId.createAsync).toHaveBeenCalledWith(expect.anything(), { name: 'CapMac dev example app widget', identifier: 'dev.example.app.widget', platform: 'IOS' });
    expect(session.applyAppGroupAssignments).toHaveBeenCalledOnce();
    expect(expo.Device.createAsync).toHaveBeenCalledWith(expect.anything(), { name: 'New iPhone', udid: '00008120-0002', platform: 'IOS' });
    expect(expo.Profile.createAsync).toHaveBeenCalledTimes(2);
    expect(expo.Profile.createAsync.mock.calls[0]![1]).toMatchObject({ bundleId: 'APPID', certificates: ['CERT'], devices: ['DEV1', 'DEV2'], profileType: 'IOS_APP_DEVELOPMENT' });
    const team = path.join(directory, TEAM);
    expect(result).toEqual({ certificate: path.join(team, 'development.p12'), profile: path.join(team, 'dev.example.app.mobileprovision'), extensionProfiles: { 'dev.example.app.widget': path.join(team, 'dev.example.app.widget.mobileprovision') } });
    expect(await readFile(result.certificate, 'utf8')).toBe('p12-bytes');
    // The password is stored only in protected form and comes back for builds.
    expect(await readFile(`${result.certificate}.dpapi`, 'utf8')).not.toContain('p12-password');
    expect(await savedCertificatePassword(result.certificate)).toBe('p12-password');
    expect((await readdir(team)).sort()).toEqual(['dev.example.app.mobileprovision', 'dev.example.app.widget.mobileprovision', 'development.json', 'development.p12', 'development.p12.dpapi']);
    expect(await readFile(path.join(team, 'development.json'), 'utf8')).not.toContain('never-saved');
  });

  it('reuses the certificate it made before while Apple still lists it', async () => {
    const first = await run();
    expo = fakeExpo(); session = fakeSession();
    expo.Certificate.getAsync.mockResolvedValue([{ id: 'CERT', attributes: { expirationDate: new Date(Date.now() + 200 * 86_400_000).toISOString() } }] as never);
    const ask = prompter();
    const second = await run(ask);
    expect(expo.createCertificateAndP12Async).not.toHaveBeenCalled();
    expect(vi.mocked(ask.confirm).mock.calls[0]![0].detail).not.toContain('certificate');
    expect(second.certificate).toBe(first.certificate);
  });

  it('changes nothing when the developer says no', async () => {
    await expect(run(prompter(false))).rejects.toThrow('Signing setup was skipped.');
    expect(expo.BundleId.createAsync).not.toHaveBeenCalled();
    expect(expo.createCertificateAndP12Async).not.toHaveBeenCalled();
    expect(expo.Profile.createAsync).not.toHaveBeenCalled();
  });

  it('stops before any change for features that need the developer portal, or with no iPhone at all', async () => {
    const ask = prompter();
    await expect(setUpAutomaticSigning(session as never, [{ ...app, entitlements: { 'com.apple.developer.icloud-services': ['CloudKit'] } }], silentContext(ask), { directory })).rejects.toThrow('This app uses iCloud');
    expo.Device.getAllIOSProfileDevicesAsync.mockResolvedValue([]);
    await expect(setUpAutomaticSigning(session as never, [app], silentContext(ask), { directory })).rejects.toThrow('no iPhone registered');
    expect(ask.confirm).not.toHaveBeenCalled();
  });

  it('explains Apple’s certificate limit and rejects a profile that misses a capability', async () => {
    expo.createCertificateAndP12Async.mockRejectedValueOnce(new Error('There is a problem with the request entity - You already have a current Development certificate or a pending certificate request.'));
    await expect(run()).rejects.toMatchObject({ message: 'Apple could not make an Apple Development certificate.', hint: expect.stringContaining('Revoke one you no longer use'), details: [expect.stringContaining('already have a current Development certificate')] });
    expo.Profile.createAsync.mockResolvedValueOnce({ id: 'P', attributes: { profileContent: profileContent('dev.example.app', { 'aps-environment': 'development' }) } } as never);
    await expect(run()).rejects.toThrow('profile for dev.example.app is missing some of the app’s capabilities');
  });
});

describe('making the development certificate', () => {
  const misdirected = () => new Error('Apple answered HTTP 421 to v1/certificates');
  const certificateCalls = () => session.connect.mock.calls.filter((call) => (call as unknown[])[2] === 'Apple certificate setup').map((call) => ((call as unknown[])[3] as { otherPortalHost?: boolean }).otherPortalHost);

  it('when Apple answers 421 (nothing made), tries the other portal host, then the iOS App Development type', async () => {
    expo.createCertificateAndP12Async.mockRejectedValueOnce(misdirected()).mockRejectedValueOnce(misdirected());
    const result = await run();
    expect(expo.createCertificateAndP12Async.mock.calls.map((call) => ((call as unknown[])[1] as { certificateType: string }).certificateType)).toEqual(['DEVELOPMENT', 'DEVELOPMENT', 'IOS_DEVELOPMENT']);
    expect(certificateCalls()).toEqual([false, true, false]);
    expect(await readFile(result.certificate, 'utf8')).toBe('p12-bytes');
  });

  it('stops at once on any other answer, with every answer and no guess about limits', async () => {
    expo.createCertificateAndP12Async.mockRejectedValueOnce(new Error('ENTITY_ERROR · The certificate request is not valid'));
    await expect(run()).rejects.toMatchObject({ details: ['ENTITY_ERROR · The certificate request is not valid'], hint: expect.stringContaining('pass --certificate and --profile') });
    expect(expo.createCertificateAndP12Async).toHaveBeenCalledOnce();
  });

  it('says to revoke an old certificate only when Apple says the limit is reached', async () => {
    expo.createCertificateAndP12Async.mockRejectedValueOnce(misdirected()).mockRejectedValueOnce(new Error('You have already reached the maximum allowed number of certificates for this type'));
    await expect(run()).rejects.toMatchObject({
      hint: expect.stringContaining('Revoke one you no longer use'),
      details: ['Apple answered HTTP 421 to v1/certificates', 'Then on the other portal host:', 'You have already reached the maximum allowed number of certificates for this type'],
    });
  });
});

describe('the certificate from Apple’s website', () => {
  const misdirected = () => new Error('Apple answered HTTP 421 to v1/certificates');
  const fixture = (name: string) => path.resolve('test/fixtures/apple-web', name);
  /** CapMac's WSL: OpenSSL makes the key and request, then the .p12 from the certificate it is given. */
  function wsl(made: Partial<{ matches: boolean; subject: string; key: string; certificate: Buffer }> = {}) {
    return {
      run: vi.fn(async (command: string[], options: { stdin?: string } = {}) => {
        if (command[2]!.includes("'req', '-new'")) return { code: 0, stderr: '', stdout: JSON.stringify({ key: made.key ?? '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n', request: '-----BEGIN CERTIFICATE REQUEST-----\nrequest\n-----END CERTIFICATE REQUEST-----\n' }) };
        const given = JSON.parse(options.stdin!);
        expect(given.key).toContain('BEGIN PRIVATE KEY');
        expect(Buffer.from(given.certificate, 'base64').equals(made.certificate ?? Buffer.from('downloaded certificate'))).toBe(true);
        return { code: 0, stderr: '', stdout: JSON.stringify({ matches: made.matches ?? true, serial: '0ABC123', notAfter: '2027-10-16 10:00:00Z', subject: made.subject ?? `UID=X,CN=Apple Development: Someone,OU=${TEAM},O=Someone,C=US`, p12: Buffer.from('web-p12').toString('base64') }) };
      }),
    };
  }
  /** Apple's website in a browser, as signing setup uses it. */
  function website(options: Partial<{ browser: string | null; signedIn: boolean }> = {}) {
    const page = {
      bundleId: vi.fn(async ({ identifier }: { name: string; identifier: string }) => { expo.listed.add(identifier); return 'WIDGETID'; }),
      device: vi.fn(async ({ udid }: { name: string; udid: string }) => `WEB-${udid}`),
      profile: vi.fn(async ({ bundleId }: { name: string; bundleId: string; certificateId: string; deviceIds: string[] }) => ({ id: `WEBPROFILE-${bundleId}`, content: profileContent(bundleId === 'APPID' ? 'dev.example.app' : 'dev.example.app.widget', grants) })),
      close: vi.fn(async () => undefined),
    };
    return {
      page,
      findBrowser: vi.fn(async () => (options.browser === null ? undefined : { name: options.browser ?? 'Brave', exe: 'C:\\Brave\\brave.exe', key: 'brave' })),
      hasSignIn: vi.fn(() => options.signedIn ?? false),
      makeCertificate: vi.fn(async (_request: unknown, _ctx?: unknown, _signal?: unknown, _options?: unknown) => ({ certificate: Buffer.from('downloaded certificate'), id: 'WEBCERT' })),
      open: vi.fn(async (_team: unknown, _ctx?: unknown, _signal?: unknown) => page),
    };
  }
  /** Who makes the certificate: answers `ways` in turn, by value. */
  function choosing(ways: string[], base: Prompter = prompter()) {
    const asked = [...ways];
    return { ...base, choose: vi.fn(async (request: { items: { value: unknown }[] }) => {
      const way = asked.shift();
      const item = request.items.find((choice) => choice.value === way);
      if (!item) throw new Error(`no choice ${way}`);
      return item.value;
    }) } as Prompter & { choose: ReturnType<typeof vi.fn> };
  }
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    for (let i = 0; i < 3; i++) expo.createCertificateAndP12Async.mockRejectedValueOnce(misdirected());
    expo.Certificate.getAsync.mockResolvedValue([{ id: 'WEBCERT', attributes: { serialNumber: 'ABC123' } }] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('when Apple won’t make it, saves a request to upload, and turns the downloaded .cer into the .p12 builds use', async () => {
    const executor = wsl();
    const downloads = path.join(directory, 'Downloads');
    // Signed in with a password, the developer makes it by hand: nobody asks who.
    const ask = choosing([], { ...prompter(), confirm: vi.fn(async () => true) } as Prompter);
    vi.mocked(ask.confirm).mockImplementation(async (request) => {
      if (request.confirmLabel !== 'I downloaded it') return true;
      // The developer uploads the request on Apple's website and downloads the certificate.
      expect(await readFile(path.join(downloads, `CapMac-${TEAM}.certSigningRequest`), 'utf8')).toContain('BEGIN CERTIFICATE REQUEST');
      expect(request.link).toEqual({ label: 'Open Apple’s website', url: 'https://developer.apple.com/account/resources/certificates/add' });
      await writeFile(path.join(downloads, 'development.cer'), 'downloaded certificate');
      return true;
    });
    const result = await run(ask, { executor, web: website() });
    expect(await readFile(result.certificate, 'utf8')).toBe('web-p12');
    expect(JSON.parse(await readFile(path.join(directory, TEAM, 'development.json'), 'utf8'))).toMatchObject({ id: 'WEBCERT', serialNumber: 'ABC123', expirationDate: '2027-10-16T10:00:00.000Z' });
    expect(expo.Profile.createAsync.mock.calls[0]![1]).toMatchObject({ certificates: ['WEBCERT'] });
    // Its password is protected like any certificate CapMac made; the key and request are gone.
    expect(await readFile(`${result.certificate}.dpapi`, 'utf8')).not.toContain('BEGIN');
    expect((await readdir(path.join(directory, TEAM))).filter((name) => name.startsWith('pending'))).toEqual([]);
    expect(await readdir(downloads)).toEqual(['development.cer']);
  });

  it('keeps the request when the developer stops, and the next setup finishes with the certificate downloaded meanwhile', async () => {
    const executor = wsl();
    const stop = choosing([], { ...prompter(), confirm: vi.fn(async (request: { confirmLabel?: string }) => request.confirmLabel !== 'I downloaded it') } as Prompter);
    await expect(run(stop, { executor, web: website() })).rejects.toThrow('Signing is waiting for your certificate');
    const pending = (await readdir(path.join(directory, TEAM))).filter((name) => name.startsWith('pending'));
    expect(pending.sort()).toEqual(['pending-key.dpapi', 'pending.certSigningRequest']);
    // Meanwhile the certificate was downloaded: the next run uses it without asking, and without a new request.
    await writeFile(path.join(directory, 'Downloads', 'development.cer'), 'downloaded certificate');
    expo = fakeExpo(); session = fakeSession();
    expo.Certificate.getAsync.mockResolvedValue([{ id: 'WEBCERT', attributes: { serialNumber: 'ABC123' } }] as never);
    const ask = choosing([]);
    const result = await run(ask, { executor, web: website() });
    expect(await readFile(result.certificate, 'utf8')).toBe('web-p12');
    expect(vi.mocked(ask.confirm).mock.calls.map(([request]) => request.confirmLabel)).toEqual(['Set up signing']);
    expect(ask.choose).not.toHaveBeenCalled();
    expect(expo.createCertificateAndP12Async).not.toHaveBeenCalled();
    expect(executor.run.mock.calls.filter(([command]) => command[2]!.includes("'req', '-new'"))).toHaveLength(1);
  });

  it('refuses a certificate made from another request or for another team', async () => {
    await writeFile(path.join(await (async () => { await mkdir(path.join(directory, 'Downloads'), { recursive: true }); return path.join(directory, 'Downloads'); })(), 'development.cer'), 'downloaded certificate');
    await expect(run(prompter(), { executor: wsl({ matches: false }), web: website() })).rejects.toThrow('made from another request');
    expo = fakeExpo(); session = fakeSession();
    expo.Certificate.getAsync.mockResolvedValue([] as never);
    await expect(run(prompter(), { executor: wsl({ subject: 'CN=Apple Development: Other,OU=OTHERTEAM1,C=US' }), web: website() })).rejects.toThrow('belongs to another Apple team');
  });

  it('signed in on Apple’s website, CapMac makes it there too with the request it keeps, without asking', async () => {
    session.via = 'website';
    const web = website();
    const ask = choosing([]);
    const result = await run(ask, { executor: wsl(), web });
    expect(await readFile(result.certificate, 'utf8')).toBe('web-p12');
    expect(ask.choose).not.toHaveBeenCalled();
    const [request, , , options] = web.makeCertificate.mock.calls[0]! as unknown as [{ csr: string; csrFile: string; team: unknown; fresh: boolean }, unknown, unknown, { browser: { name: string } }];
    expect(request).toMatchObject({ csr: expect.stringContaining('BEGIN CERTIFICATE REQUEST'), csrFile: path.join(directory, TEAM, 'pending.certSigningRequest'), team: { id: TEAM, name: 'Example Team' }, fresh: false });
    expect(options.browser.name).toBe('Brave');
    // Apple's id came with the certificate; nothing was left in Downloads.
    expect(web.page.profile.mock.calls[0]![0]).toMatchObject({ certificateId: 'WEBCERT' });
    expect(vi.mocked(ask.confirm).mock.calls.map(([asked]) => asked.confirmLabel)).toEqual(['Set up signing']);
    await expect(readdir(path.join(directory, 'Downloads'))).rejects.toThrow();
  });

  it('signed in on Apple’s website, adds App IDs, registers iPhones and makes profiles there, closing the hidden browser after', async () => {
    session.via = 'website';
    const web = website();
    const result = await run(choosing([]), { executor: wsl(), web });
    // Once for the App ID, once for the iPhones and profiles (the certificate comes in between).
    expect(web.open).toHaveBeenCalledTimes(2);
    expect(web.page.bundleId).toHaveBeenCalledWith({ name: 'CapMac dev example app widget', identifier: 'dev.example.app.widget' });
    expect(expo.BundleId.createAsync).not.toHaveBeenCalled();
    expect(web.page.device).toHaveBeenCalledWith({ name: 'New iPhone', udid: '00008120-0002' });
    expect(web.page.profile.mock.calls.map(([made]) => made)).toEqual([
      expect.objectContaining({ bundleId: 'APPID', certificateId: 'WEBCERT', deviceIds: ['DEV1', 'WEB-00008120-0002'] }),
      expect.objectContaining({ bundleId: 'WIDGETID', certificateId: 'WEBCERT', deviceIds: ['DEV1', 'WEB-00008120-0002'] }),
    ]);
    // Apple's API isn't asked to make what it only makes on the website.
    expect(expo.Device.createAsync).not.toHaveBeenCalled();
    expect(expo.Profile.createAsync).not.toHaveBeenCalled();
    expect(web.page.close).toHaveBeenCalledTimes(2);
    expect(await readFile(result.profile)).toEqual(Buffer.from(profileContent('dev.example.app', grants), 'base64'));
  });

  it('signed in with a password, a profile Apple makes only on its website points to “Let CapMac do it”', async () => {
    expo.Profile.createAsync.mockRejectedValueOnce(new UserError('Apple signing setup failed (HTTP 421).', undefined, ['Apple answered HTTP 421 to v1/profiles', 'Bad Request']));
    await expect(run(choosing([], { ...prompter(), confirm: vi.fn(async (request) => {
      if (request.confirmLabel === 'I downloaded it') await writeFile(path.join(directory, 'Downloads', 'development.cer'), 'downloaded certificate');
      return true;
    }) } as Prompter), { executor: wsl(), web: website() })).rejects.toMatchObject({
      message: 'Apple could not make a development profile for dev.example.app.',
      hint: expect.stringContaining('choose “Let CapMac do it”'),
    });
  });

  it('signed in with a password, never opens the website for it', async () => {
    const web = website();
    const ask = choosing([], { ...prompter(), confirm: vi.fn(async (request) => {
      if (request.confirmLabel === 'I downloaded it') await writeFile(path.join(directory, 'Downloads', 'development.cer'), 'downloaded certificate');
      return true;
    }) } as Prompter);
    await run(ask, { executor: wsl(), web });
    expect(web.makeCertificate).not.toHaveBeenCalled();
    expect(vi.mocked(ask.confirm).mock.calls.map(([request]) => request.confirmLabel)).toEqual(['Set up signing', 'I downloaded it']);
  });

  it('when CapMac can’t, says why and offers another try, a fresh sign-in, or doing it by hand', async () => {
    session.via = 'website';
    const web = website();
    web.makeCertificate.mockRejectedValueOnce(new UserError('CapMac couldn’t find “Continue” on Apple’s website (after the upload).', 'Apple may have changed its website.', ['What CapMac saw is in C:\\x']));
    const ask = choosing(['manual'], { ...prompter(), confirm: vi.fn(async (request) => {
      if (request.confirmLabel === 'I downloaded it') await writeFile(path.join(directory, 'Downloads', 'development.cer'), 'downloaded certificate');
      return true;
    }) } as Prompter);
    const result = await run(ask, { executor: wsl(), web });
    expect(await readFile(result.certificate, 'utf8')).toBe('web-p12');
    const failed = ask.choose.mock.calls[0]![0] as { message: string; detail: string; items: { value: string }[] };
    expect(failed.message).toBe('CapMac couldn’t make the certificate on Apple’s website');
    expect(failed.detail).toContain('couldn’t find “Continue”');
    expect(failed.detail).toContain('What CapMac saw is in');
    // One line each, without closing periods.
    expect(failed.detail.split('\n').some((line) => line.endsWith('.'))).toBe(false);
    expect(failed.items.map((item) => item.value)).toEqual(['web', 'web-fresh', 'manual']);
  });

  it('Cancel in the browser sign-in stops there, keeping the request', async () => {
    session.via = 'website';
    const web = website();
    web.makeCertificate.mockRejectedValueOnce(new AppleWebStopped('Signing is waiting for your certificate from Apple’s website.', 'Run setup again when you are ready.'));
    const ask = choosing([]);
    await expect(run(ask, { executor: wsl(), web })).rejects.toThrow('Signing is waiting for your certificate');
    expect(ask.choose).not.toHaveBeenCalled();
    expect((await readdir(path.join(directory, TEAM))).filter((name) => name.startsWith('pending')).sort()).toEqual(['pending-key.dpapi', 'pending.certSigningRequest']);
  });

  it('dismissing the question after a failure keeps the request too', async () => {
    session.via = 'website';
    const web = website();
    web.makeCertificate.mockRejectedValueOnce(new UserError('Apple’s website didn’t make the certificate.'));
    const ask = { ...prompter(), choose: vi.fn(async () => { throw new CancelledError(); }) } as Prompter;
    await expect(run(ask, { executor: wsl(), web })).rejects.toThrow('Signing is waiting for your certificate');
  });

  it('without a browser CapMac can drive, goes straight to doing it by hand', async () => {
    session.via = 'website';
    const ask = choosing([], { ...prompter(), confirm: vi.fn(async (request) => {
      if (request.confirmLabel === 'I downloaded it') await writeFile(path.join(directory, 'Downloads', 'development.cer'), 'downloaded certificate');
      return true;
    }) } as Prompter);
    await run(ask, { executor: wsl(), web: website({ browser: null }) });
    expect(ask.choose).not.toHaveBeenCalled();
    expect(vi.mocked(ask.confirm).mock.calls.map(([request]) => request.confirmLabel)).toEqual(['Set up signing', 'I downloaded it']);
  });

  it('uses a certificate Apple already made from the request, without asking', async () => {
    const certificate = await readFile(fixture('cert.der'));
    expo.Certificate.getAsync.mockResolvedValue([
      { id: 'OTHER', attributes: { serialNumber: '01', certificateContent: (await readFile(fixture('other-cert.der'))).toString('base64') } },
      { id: 'LISTED', attributes: { serialNumber: 'ABC123', certificateContent: certificate.toString('base64') } },
    ] as never);
    const web = website();
    const ask = choosing([]);
    await run(ask, { executor: wsl({ key: await readFile(fixture('key.pem'), 'utf8'), certificate }), web });
    expect(ask.choose).not.toHaveBeenCalled();
    expect(web.makeCertificate).not.toHaveBeenCalled();
    expect(expo.Profile.createAsync.mock.calls[0]![1]).toMatchObject({ certificates: ['LISTED'] });
  });
});
