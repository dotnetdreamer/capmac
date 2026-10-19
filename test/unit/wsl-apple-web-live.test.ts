/**
 * The browser CapMac drives on Apple's website, for real: a Chromium browser
 * on this PC against a stand-in for developer.apple.com served here, so no
 * Apple account is touched. Opt in with CAPMAC_LIVE_BROWSER=1 (or the path of
 * a Chromium browser); add CAPMAC_LIVE_BROWSER_WINDOW=1 for the sign-in window
 * tests, which show a browser window for a few seconds.
 */
import { createPublicKey, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nonInteractivePrompter, silentContext, type ConfirmRequest, type Prompter } from '../../packages/core/src/engine/context.js';
import { AppleWebsite, chromiumBrowser, findWebBrowser, makeCertificateOnAppleWeb, WebPage, xcodeDownloadOnAppleWebsite, type WebBrowser } from '../../packages/core/src/engine/wsl/apple-web.js';

const live = process.env.CAPMAC_LIVE_BROWSER;
const TEAM = 'ABCDE12345';
const fixture = (name: string) => path.resolve('test/fixtures/apple-web', name);

/** What the stand-in site saw and how it behaves. */
const site = {
  team: TEAM, apiMakes: false, needsSignIn: false,
  apiCreates: [] as { csrf?: string; body: { data?: { attributes?: { csrContent?: string; teamId?: string; certificateType?: string } } } }[],
  otherCreates: [] as { type: string; csrf?: string; body: { data?: { attributes?: Record<string, unknown>; relationships?: Record<string, unknown> } } }[],
  pageCreates: [] as string[], addLoads: 0, made: false,
  /** The downloads page's requests: its list, and the permission for a file. */
  grants: true, downloadAsks: [] as string[],
};
const XCODE_26_6 = '/Developer_Tools/Xcode_26.6/Xcode_26.6_Apple_silicon.xip';
let certificate: Buffer;
let other: Buffer;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const html = (body: string) => ({ status: 200, body: `<!doctype html><html><head><meta charset="utf-8"><title>Stand-in</title></head><body>${body}</body></html>`, headers: { 'content-type': 'text/html' } });
const ADD_PAGE = () => html(`
  <h1>Create a New Certificate</h1>
  <div id="step1">
    <label><input type="radio" name="type" value="dev"> <b>Apple Development</b> <small>Sign development versions of your apps.</small></label>
    <label><input type="radio" name="type" value="dist"> <b>Apple Distribution</b> <small>Sign your apps for the App Store.</small></label>
    <button id="continue1" disabled>Continue</button>
  </div>
  <div id="step2" hidden><h2>Upload a Certificate Signing Request</h2><input type="file" id="csr"><button id="continue2" disabled>Continue</button></div>
  <div id="step3" hidden><h2>Download Your Certificate</h2><button>Download</button></div>
  <script>
    const team = ${JSON.stringify(site.team)};
    fetch('/services-account/v1/certificates', { method: 'POST', headers: { 'Content-Type': 'application/vnd.api+json', 'X-HTTP-Method-Override': 'GET' }, body: JSON.stringify({ urlEncodedQueryParams: 'limit=20', teamId: team }) });
    for (const radio of document.querySelectorAll('input[name=type]')) radio.addEventListener('change', () => { continue1.disabled = !document.querySelector('input[value=dev]').checked; });
    // Only a person's clicks count, as on a real website that checks.
    continue1.addEventListener('click', (event) => { if (event.isTrusted) { step1.hidden = true; step2.hidden = false; } });
    csr.addEventListener('change', () => { continue2.disabled = !csr.files.length; });
    continue2.addEventListener('click', async (event) => {
      if (!event.isTrusted) return;
      const response = await fetch('/services-account/v1/certificates', { method: 'POST', headers: { 'Content-Type': 'application/vnd.api+json', 'X-Website': '1' },
        body: JSON.stringify({ data: { type: 'certificates', attributes: { certificateType: 'DEVELOPMENT', csrContent: await csr.files[0].text(), teamId: team } } }) });
      if (response.ok) { step2.hidden = true; step3.hidden = false; }
    });
  </script>`);

function answer(request: IncomingMessage, body: string) {
  const url = new URL(request.url!, 'http://stand-in');
  const signedIn = !site.needsSignIn || /(?:^|; )signedin=1/.test(request.headers.cookie ?? '');
  if (url.pathname === '/signin') {
    // A person signing in: a moment later the site keeps them signed in and goes on.
    return html(`<h1>Sign In</h1><script>setTimeout(() => { document.cookie = 'signedin=1; max-age=86400; path=/'; location.href = ${JSON.stringify(url.searchParams.get('path') ?? '/account')}; }, 1500);</script>`);
  }
  if (url.pathname.startsWith('/account') && !signedIn) return { status: 302, body: '', headers: { location: `/signin?path=${encodeURIComponent(url.pathname)}` } };
  if (url.pathname === '/account') return html('<h1>Account</h1>');
  if (url.pathname === '/account/resources/certificates/list') return html('<h1>Certificates</h1>');
  if (url.pathname === '/services-account/QH65B2/downloadws/listDownloads.action' && request.method === 'POST') {
    site.downloadAsks.push(`list ${request.headers['content-type']} ${body}`);
    const file = (remotePath: string, fileSize: number) => ({ remotePath, filename: remotePath.split('/').pop(), fileSize });
    return json(200, { resultCode: 0, downloads: [
      { name: 'Xcode 26.5', files: [file('/Developer_Tools/Xcode_26.5/Xcode_26.5_Apple_silicon.xip', 2_200_000_000)] },
      { name: 'Xcode 26.6', files: [file('/Developer_Tools/Xcode_26.6/Xcode_26.6_Universal.xip', 2_965_708_631), file(XCODE_26_6, 2_318_258_791)] },
    ] });
  }
  if (url.pathname === '/services-account/download') {
    site.downloadAsks.push(`permission ${url.searchParams.get('path')}`);
    // As Apple answers: its cookie, and on to the file (which the browser must not fetch).
    if (site.grants) return { status: 302, body: '', headers: { 'set-cookie': 'ADCDownloadAuth=stand-in-grant; Path=/; HttpOnly', location: `https://download.developer.apple.com${url.searchParams.get('path')}` } };
    return json(403, { resultCode: 1100, userString: 'Downloads are not available for this account.' });
  }
  if (url.pathname === '/account/resources/certificates/add') { site.addLoads++; return ADD_PAGE(); }
  if (url.pathname === '/services-account/v1/certificates' && request.method === 'POST') {
    if (!signedIn) return json(401, { errors: [{ status: '401', title: 'Unauthorized' }] });
    const parsed = JSON.parse(body || '{}');
    const resource = (der: Buffer, id: string) => ({ id, type: 'certificates', attributes: { certificateType: 'DEVELOPMENT', certificateContent: der.toString('base64') } });
    if (request.headers['x-http-method-override'] === 'GET') {
      if (parsed.teamId !== TEAM) return json(403, { errors: [{ status: '403', title: 'Forbidden', detail: 'Not a member of this team' }] });
      return json(200, { data: [resource(other, 'OLDCERT'), ...site.made ? [resource(certificate, 'NEWCERT')] : []] }, { csrf: 'csrf-token', csrf_ts: '1700000000' });
    }
    if (request.headers['x-website']) {
      site.pageCreates.push(parsed.data.attributes.csrContent);
      site.made = true;
      return json(201, { data: { id: 'NEWCERT', type: 'certificates', attributes: { certificateType: 'DEVELOPMENT' } } });
    }
    site.apiCreates.push({ csrf: request.headers.csrf as string | undefined, body: parsed });
    if (!site.apiMakes) return json(421, { errors: [{ status: '421', code: 'MISDIRECTED', title: 'Bad Request' }] });
    site.made = true;
    return json(201, { data: resource(certificate, 'NEWCERT') });
  }
  const created = /^\/services-account\/v1\/(devices|profiles)$/.exec(url.pathname);
  if (created && request.method === 'POST' && !request.headers['x-http-method-override']) {
    const parsed = JSON.parse(body || '{}');
    site.otherCreates.push({ type: created[1]!, csrf: request.headers.csrf as string | undefined, body: parsed });
    if (parsed.data?.attributes?.teamId !== TEAM) return json(403, { errors: [{ status: '403', title: 'Forbidden' }] });
    return created[1] === 'devices'
      ? json(201, { data: { id: 'NEWDEVICE', type: 'devices', attributes: parsed.data.attributes } })
      : json(201, { data: { id: 'NEWPROFILE', type: 'profiles', attributes: { profileContent: Buffer.from('profile bytes').toString('base64') } } });
  }
  return { status: 404, body: 'not here', headers: { 'content-type': 'text/plain' } };
}

let server: Server;
let base: string;
let browser: WebBrowser;
let root: string;
const request = () => ({
  csr: '-----BEGIN CERTIFICATE REQUEST-----\nstand-in request\n-----END CERTIFICATE REQUEST-----\n',
  csrFile: path.join(root, 'request.certSigningRequest'),
  team: { id: TEAM, name: 'Example Team' },
  ours: (der: Buffer) => { try { return new X509Certificate(der).publicKey.equals(createPublicKey(keyPem)); } catch { return false; } },
});
let keyPem: string;

/** Questions as CapMac Studio asks them: a question taken back closes, answered "no". */
function prompter(onConfirm: (request: ConfirmRequest) => Promise<boolean> | boolean = () => new Promise(() => undefined)): Prompter & { confirm: ReturnType<typeof vi.fn> } {
  const confirm = vi.fn((request: ConfirmRequest) => new Promise<boolean>((resolve) => {
    request.signal?.addEventListener('abort', () => resolve(false), { once: true });
    void Promise.resolve(onConfirm(request)).then(resolve);
  }));
  return { ...nonInteractivePrompter, interactive: true, confirm } as never;
}

describe.skipIf(!live)('Apple’s website in a real browser (stand-in site)', () => {
  beforeAll(async () => {
    certificate = await readFile(fixture('cert.der'));
    other = await readFile(fixture('other-cert.der'));
    keyPem = await readFile(fixture('key.pem'), 'utf8');
    browser = live === '1' ? (await findWebBrowser())! : chromiumBrowser(live!) ?? { name: 'Browser', exe: live!, key: 'browser' };
    expect(browser, 'no Chromium browser found').toBeTruthy();
    server = createServer((incoming, response) => {
      let body = '';
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => {
        const reply = answer(incoming, body);
        response.writeHead(reply.status, reply.headers);
        response.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server?.close(resolve)); });
  beforeEach(async () => {
    Object.assign(site, { team: TEAM, apiMakes: false, needsSignIn: false, apiCreates: [], otherCreates: [], pageCreates: [], addLoads: 0, made: false, grants: true, downloadAsks: [] });
    root = await mkdtemp(path.join(os.tmpdir(), 'capmac-apple-web-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(request().csrFile, request().csr);
    return async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); };
  });
  /** A browser profile from an earlier sign-in, so CapMac first tries hidden. */
  const signedInBefore = () => mkdir(path.join(root, 'Profiles', browser.key), { recursive: true });

  it('clicks through the website’s pages when Apple refuses the API, hidden, and finds its certificate', async () => {
    await signedInBefore();
    const ask = prompter();
    const made = await makeCertificateOnAppleWeb(request(), silentContext(ask), undefined, { root, browser, site: base });
    expect(made.id).toBe('NEWCERT');
    expect(made.certificate.equals(certificate)).toBe(true);
    // The API was asked first, the way the website asks, with its CSRF token; then the pages.
    // (The browser itself asks once more on a new connection after a 421, as HTTP allows.)
    expect(site.apiCreates.length).toBeGreaterThan(0);
    for (const sent of site.apiCreates) expect(sent).toMatchObject({ csrf: 'csrf-token', body: { data: { attributes: { certificateType: 'DEVELOPMENT', teamId: TEAM, csrContent: request().csr } } } });
    expect(site.pageCreates).toEqual([request().csr]);
    expect(ask.confirm).not.toHaveBeenCalled();
  }, 120_000);

  it('takes the certificate from Apple’s answer when the API makes it', async () => {
    await signedInBefore();
    site.apiMakes = true;
    const made = await makeCertificateOnAppleWeb(request(), silentContext(prompter()), undefined, { root, browser, site: base });
    expect(made).toMatchObject({ id: 'NEWCERT' });
    expect(site.addLoads).toBe(0);
  }, 60_000);

  it('never clicks “make” while the website works in another team', async () => {
    await signedInBefore();
    site.team = 'OTHERTEAM1';
    await expect(makeCertificateOnAppleWeb(request(), silentContext(prompter()), undefined, { root, browser, site: base }))
      .rejects.toMatchObject({ message: 'Apple’s website is working in another team, not “Example Team”.', details: [expect.stringContaining('last-attempt')] });
    expect(site.pageCreates).toEqual([]);
    const notes = await readFile(path.join(root, 'last-attempt', 'notes.txt'), 'utf8');
    expect(notes).toContain('teams seen: OTHERTEAM1');
  }, 120_000);

  it('registers an iPhone and makes a profile the way the website asks, in one hidden browser', async () => {
    await signedInBefore();
    const website = await AppleWebsite.open({ id: TEAM, name: 'Example Team' }, silentContext(prompter()), undefined, { root, browser, site: base });
    try {
      expect(await website.device({ name: 'Test iPhone', udid: '00008120-0001' })).toBe('NEWDEVICE');
      expect(await website.profile({ name: 'CapMac dev.example.app', bundleId: 'APPID', certificateId: 'CERT', deviceIds: ['DEV1', 'NEWDEVICE'] }))
        .toEqual({ id: 'NEWPROFILE', content: Buffer.from('profile bytes').toString('base64') });
    } finally { await website.close(); }
    expect(site.otherCreates).toEqual([
      { type: 'devices', csrf: 'csrf-token', body: { data: { type: 'devices', attributes: { name: 'Test iPhone', udid: '00008120-0001', platform: 'IOS', teamId: TEAM } } } },
      { type: 'profiles', csrf: 'csrf-token', body: { data: { type: 'profiles', attributes: { name: 'CapMac dev.example.app', profileType: 'IOS_APP_DEVELOPMENT', teamId: TEAM }, relationships: {
        bundleId: { data: { type: 'bundleIds', id: 'APPID' } }, certificates: { data: [{ type: 'certificates', id: 'CERT' }] }, devices: { data: [{ type: 'devices', id: 'DEV1' }, { type: 'devices', id: 'NEWDEVICE' }] },
      } } } },
    ]);
  }, 60_000);

  it('gets the Xcode download’s permission as Apple’s downloads page does, hidden', async () => {
    await signedInBefore();
    const ask = prompter();
    const got = await xcodeDownloadOnAppleWebsite('26.6', silentContext(ask), { root, browser, site: base });
    expect(got).toEqual({
      download: { version: '26.6', name: 'Xcode 26.6', url: `https://download.developer.apple.com${XCODE_26_6}`, fileName: 'Xcode_26.6_Apple_silicon.xip', size: 2_318_258_791 },
      cookies: ['ADCDownloadAuth=stand-in-grant'],
    });
    // The list as the page asks for it, then the permission for the Apple silicon archive only.
    expect(site.downloadAsks).toEqual(['list application/json;charset=UTF-8 {}', `permission ${XCODE_26_6}`]);
    expect(ask.confirm).not.toHaveBeenCalled();
  }, 60_000);

  it('says how to download Xcode by hand when Apple won’t allow it', async () => {
    await signedInBefore();
    site.grants = false;
    await expect(xcodeDownloadOnAppleWebsite('26.6', silentContext(prompter()), { root, browser, site: base })).rejects.toMatchObject({
      message: 'Apple didn’t allow the Xcode download.', hint: expect.stringContaining('developer.apple.com/download/all'),
      details: expect.arrayContaining(['Apple answered HTTP 403', 'Downloads are not available for this account.']),
    });
  }, 60_000);

  it('puts back saved apple.com cookies the profile lacks, session cookies included', async () => {
    const page = await WebPage.launch(browser, path.join(root, 'Profiles', 'cookies'), false);
    try {
      await page.restore([
        { name: 'myacinfo', value: 'session-value', domain: '.apple.com', path: '/', expires: -1, httpOnly: true, secure: true, session: true, sameSite: 'Lax' },
        { name: 'dslang', value: 'GB-EN', domain: '.apple.com', path: '/', expires: Date.now() / 1000 + 86_400, httpOnly: false, secure: true, session: false },
      ]);
      const cookies = await page.cookies();
      expect(cookies.map((cookie) => [cookie.name, cookie.value, cookie.session]).sort()).toEqual([['dslang', 'GB-EN', false], ['myacinfo', 'session-value', true]]);
    } finally { await page.close(); }
  }, 60_000);

  it('sees Apple’s real site send a signed-out browser to its sign-in page', async () => {
    const page = await WebPage.launch(browser, path.join(root, 'Profiles', 'apple'), false);
    try {
      const at = await page.goto('https://developer.apple.com/account/resources/certificates/list');
      expect(at.hostname).toBe('idmsa.apple.com');
      expect(await page.evaluate<boolean>('navigator.webdriver')).toBe(false);
      expect(await page.evaluate<string>('navigator.userAgent')).not.toContain('Headless');
    } finally { await page.close(); }
  }, 60_000);

  describe.skipIf(!process.env.CAPMAC_LIVE_BROWSER_WINDOW)('with the sign-in window', () => {
    it('shows the window until the person is in, takes its question back, then works hidden', async () => {
      site.needsSignIn = true;
      site.apiMakes = true;
      const ask = prompter();
      const made = await makeCertificateOnAppleWeb(request(), silentContext(ask), undefined, { root, browser, site: base });
      expect(made.id).toBe('NEWCERT');
      expect(ask.confirm).toHaveBeenCalledOnce();
      const question = ask.confirm.mock.calls[0]![0] as ConfirmRequest;
      expect(question).toMatchObject({ message: `Sign in to Apple in ${browser.name}`, waiting: 'Waiting for you to sign in…', confirmLabel: 'Restart', cancelLabel: 'Cancel' });
      expect(question.signal?.aborted).toBe(true);
    }, 120_000);

    it('Restart starts over with nothing saved', async () => {
      site.needsSignIn = true;
      site.apiMakes = true;
      let asked = 0;
      // The first time, the person presses Restart at once; the second time they sign in.
      const ask = prompter(() => (++asked === 1 ? true : new Promise(() => undefined)));
      const made = await makeCertificateOnAppleWeb(request(), silentContext(ask), undefined, { root, browser, site: base });
      expect(made.id).toBe('NEWCERT');
      expect(ask.confirm).toHaveBeenCalledTimes(2);
    }, 120_000);

    it('signs in for the Xcode download with any Apple Account, saying why', async () => {
      site.needsSignIn = true;
      const ask = prompter();
      const got = await xcodeDownloadOnAppleWebsite('26.6', silentContext(ask), { root, browser, site: base });
      expect(got.cookies).toEqual(['ADCDownloadAuth=stand-in-grant']);
      expect(ask.confirm).toHaveBeenCalledOnce();
      const question = ask.confirm.mock.calls[0]![0] as ConfirmRequest;
      expect(question.detail).toContain('Xcode comes from Apple’s website, which needs its own sign-in');
      expect(question.detail).toContain('Sign in there with your Apple Account (a free one works)');
      expect(question.detail).toContain('closes the window and downloads Xcode');
    }, 120_000);

    it('Cancel stops without asking anything else', async () => {
      site.needsSignIn = true;
      const ask = prompter(() => false);
      await expect(makeCertificateOnAppleWeb(request(), silentContext(ask), undefined, { root, browser, site: base }))
        .rejects.toMatchObject({ message: 'Signing is waiting for your certificate from Apple’s website.' });
      expect(site.apiCreates).toEqual([]);
    }, 60_000);
  });
});
