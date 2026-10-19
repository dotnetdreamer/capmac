import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nonInteractivePrompter, silentContext, type Prompter } from '../../packages/core/src/engine/context.js';
import { UserError } from '../../packages/core/src/engine/errors.js';
import { AppleAccountSession, cookieJarOf, downloadGrantJar, downloadXcodeWithGrant, loginAppleAccount, loginAppleAccountWithCookies, pinnedXcodeDownload, selectAppleXcodeDownload } from '../../packages/core/src/engine/wsl/apple-account.js';

const mock = vi.hoisted(() => {
  const client = { defaults: {}, interceptors: { request: { use: vi.fn(() => 4), eject: vi.fn() }, response: { use: vi.fn(() => 7), eject: vi.fn() } }, request: vi.fn() };
  const expo = {
    Auth: { resetInMemoryData: vi.fn(), loginWithUserCredentialsAsync: vi.fn(), loginWithCookiesAsync: vi.fn() },
    Teams: { selectTeamAsync: vi.fn(), getTeamsAsync: vi.fn() },
    CookieFileCache: { writeCookiesToFileAsync: vi.fn() }, JsonFileCache: { cacheAsync: vi.fn() },
    getRequestClient: () => client,
    AppGroup: { getAsync: vi.fn(), createAsync: vi.fn() }, BundleId: { findAsync: vi.fn(), infoAsync: vi.fn() },
    CapabilityType: { APP_GROUP: 'APP_GROUPS' }, CapabilityTypeOption: { ON: 'ON' },
  };
  return { expo, client };
});
vi.mock('@expo/apple-utils', () => ({ ...mock.expo, default: mock.expo }));

const team = { teamId: 'TEAM', name: 'Example Team', type: 'Company' };
const prompter = (): Prompter => ({ interactive: true, text: vi.fn(async () => 'developer@example.test'), password: vi.fn(async () => 'secret-password'), choose: vi.fn(async <T>(request: { items: { value: T }[] }) => request.items[0]!.value) as Prompter['choose'], confirm: vi.fn(async () => true) });
const authState = () => ({ username: 'developer@example.test', password: 'secret-password', cookies: { cookies: ['private-cookie'] }, context: { teamId: 'TEAM', providerId: 12 }, session: { jar: { private: 'private-cookie' } } });
const seedSession = () => new AppleAccountSession(mock.expo as never, authState() as never, { id: 'TEAM', name: 'Example Team' });
const catalog = { downloads: [{ name: 'Xcode 26.2 beta', files: [{ remotePath: '/Developer_Tools/Xcode_26.2_beta/Xcode_26.2_beta.xip' }] }, { name: 'Xcode 26.2', files: [{ remotePath: '/Developer_Tools/Xcode_26.2/Xcode_26.2_Apple_silicon.xip', fileSize: 123 }] }] };
const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
let temporary: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  vi.stubEnv('EXPO_APP_STORE_DEBUG', 'false');
  mock.expo.Teams.getTeamsAsync.mockResolvedValue([team]);
  mock.expo.Auth.loginWithUserCredentialsAsync.mockImplementation(async () => {
    await mock.expo.Teams.selectTeamAsync({});
    await mock.expo.CookieFileCache.writeCookiesToFileAsync();
    await mock.expo.JsonFileCache.cacheAsync();
    return authState();
  });
});
afterEach(async () => {
  if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  vi.unstubAllEnvs();
  if (temporary) { await rm(temporary, { recursive: true, force: true }); temporary = undefined; }
});

describe('Apple Account login', () => {
  it('uses the actual maintained package API and writable persistence/team hooks', async () => {
    const actual = await vi.importActual<typeof import('@expo/apple-utils')>('@expo/apple-utils');
    expect(typeof actual.Auth.loginWithUserCredentialsAsync).toBe('function');
    // A sign-in made on Apple's website comes in as cookies.
    expect(typeof actual.Auth.loginWithCookiesAsync).toBe('function');
    expect(typeof actual.Teams.getTeamsAsync).toBe('function');
    expect(typeof actual.BundleId.prototype.updateBundleIdCapabilityAsync).toBe('function');
    expect(typeof actual.AppGroup.createAsync).toBe('function');
    // App groups are read with them included: the plain lookup leaves them out.
    expect(typeof actual.BundleId.infoAsync).toBe('function');
    expect(Object.getOwnPropertyDescriptor(actual.CookieFileCache, 'writeCookiesToFileAsync')?.writable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(actual.Teams, 'selectTeamAsync')?.writable).toBe(true);
    // Vitest synthesizes CJS named exports. The external ESM CLI gets a default
    // export instead, so verify the exact Node import boundary separately.
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', "const imported=await import('@expo/apple-utils'); const expo=imported.default??imported; console.log(JSON.stringify({auth:typeof expo.Auth.loginWithUserCredentialsAsync,cookies:typeof expo.CookieFileCache.writeCookiesToFileAsync}));"]);
    expect(JSON.parse(result.stdout)).toEqual({ auth: 'function', cookies: 'function' });
  });
  it('fails before asking anything when nobody can answer (CI, a script)', async () => {
    const ctx = silentContext({ ...nonInteractivePrompter, password: vi.fn(), text: vi.fn() });
    await expect(loginAppleAccount(ctx)).rejects.toThrow(/needs someone to answer/);
    expect(ctx.prompter.text).not.toHaveBeenCalled();
    expect(ctx.prompter.password).not.toHaveBeenCalled();
    expect(mock.expo.Auth.loginWithUserCredentialsAsync).not.toHaveBeenCalled();
  });
  it('signs in without a terminal (CapMac Studio asks with dialogs) and answers two-factor itself only while signing in', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const ctx = silentContext(prompter());
    const session = await loginAppleAccount(ctx);
    expect(session.team.id).toBe('TEAM');
    expect(ctx.prompter.text).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'apple-email' }));
    expect(ctx.prompter.password).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'apple', user: 'developer@example.test' }));
    // The two-factor interceptor is on the request client only during the sign-in.
    expect(mock.client.interceptors.response.use).toHaveBeenCalledOnce();
    expect(mock.client.interceptors.response.eject).toHaveBeenCalledWith(7);
  });
  it('selects the only team automatically, keeps cookies in memory, and never exposes password/session data', async () => {
    const ctx = silentContext(prompter()); const events: unknown[] = []; ctx.emit = (event) => events.push(event);
    const selectTeam = mock.expo.Teams.selectTeamAsync;
    const writeCookies = mock.expo.CookieFileCache.writeCookiesToFileAsync;
    const cache = mock.expo.JsonFileCache.cacheAsync;
    const session = await loginAppleAccount(ctx);
    expect(mock.expo.Auth.loginWithUserCredentialsAsync).toHaveBeenCalledWith({ username: 'developer@example.test', password: 'secret-password' }, { autoResolveProvider: true });
    expect(ctx.prompter.password).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'apple' }));
    expect(ctx.prompter.choose).not.toHaveBeenCalled();
    expect(session.team).toEqual({ id: 'TEAM', name: 'Example Team' });
    expect(JSON.stringify(session)).not.toMatch(/secret-password|private-cookie|developer@example/);
    expect(JSON.stringify(events)).not.toMatch(/secret-password|private-cookie/);
    expect(writeCookies).not.toHaveBeenCalled(); expect(cache).not.toHaveBeenCalled();
    expect(mock.expo.CookieFileCache.writeCookiesToFileAsync).toBe(writeCookies);
    expect(mock.expo.Teams.selectTeamAsync).toBe(selectTeam);
    expect(mock.client.interceptors.request.eject).toHaveBeenCalledWith(4);
  });
  it('lets the developer choose among teams instead of guessing the first', async () => {
    mock.expo.Teams.getTeamsAsync.mockResolvedValue([{ ...team, teamId: 'OTHER' }, team]);
    const ctx = silentContext(prompter()); vi.mocked(ctx.prompter.choose).mockResolvedValue(team);
    expect((await loginAppleAccount(ctx)).team.id).toBe('TEAM');
    expect(ctx.prompter.choose).toHaveBeenCalledOnce();
  });
  it('restores persistence and singleton hooks after auth fails without exposing Axios credentials', async () => {
    const writer = mock.expo.CookieFileCache.writeCookiesToFileAsync; const selector = mock.expo.Teams.selectTeamAsync;
    mock.expo.Auth.loginWithUserCredentialsAsync.mockRejectedValue({ response: { status: 403 }, config: { password: 'secret-password', headers: { Cookie: 'private-cookie' } } });
    await expect(loginAppleAccount(silentContext(prompter()))).rejects.toThrow('Apple denied this account operation');
    expect(mock.expo.CookieFileCache.writeCookiesToFileAsync).toBe(writer); expect(mock.expo.Teams.selectTeamAsync).toBe(selector);
  });
  it('makes the session of a sign-in on Apple’s website from its cookies: no password, the same team question, nothing cached', async () => {
    mock.expo.Teams.getTeamsAsync.mockResolvedValue([{ ...team, teamId: 'OTHER' }, team]);
    mock.expo.Auth.loginWithCookiesAsync.mockImplementation(async () => {
      await mock.expo.Teams.selectTeamAsync({ restoringSession: true });
      await mock.expo.CookieFileCache.writeCookiesToFileAsync();
      return authState();
    });
    const ctx = silentContext(prompter()); vi.mocked(ctx.prompter.choose).mockResolvedValue(team);
    const cookies = [{ name: 'myacinfo', value: 'private-cookie', domain: '.apple.com', path: '/', expires: -1, httpOnly: true, secure: true, session: true, sameSite: 'Lax' }];
    const session = await loginAppleAccountWithCookies(ctx, cookies);
    expect(session).toMatchObject({ team: { id: 'TEAM', name: 'Example Team' }, via: 'website' });
    const [credentials, options] = mock.expo.Auth.loginWithCookiesAsync.mock.calls[0]! as unknown as [{ cookies: { cookies: unknown[] } }, unknown];
    expect(credentials.cookies.cookies).toEqual([expect.objectContaining({ key: 'myacinfo', value: 'private-cookie', domain: 'apple.com', hostOnly: false })]);
    expect(options).toEqual({ autoResolveProvider: true });
    expect(mock.expo.Teams.getTeamsAsync).toHaveBeenCalledWith(true);
    expect(ctx.prompter.choose).toHaveBeenCalledOnce();
    expect(ctx.prompter.text).not.toHaveBeenCalled(); expect(ctx.prompter.password).not.toHaveBeenCalled();
    expect(mock.expo.CookieFileCache.writeCookiesToFileAsync).not.toHaveBeenCalled();
    expect(mock.expo.Auth.loginWithUserCredentialsAsync).not.toHaveBeenCalled();
  });
  it('answers null when Apple no longer takes the website’s cookies', async () => {
    mock.expo.Auth.loginWithCookiesAsync.mockResolvedValue(null);
    await expect(loginAppleAccountWithCookies(silentContext(prompter()), [])).resolves.toBeNull();
    // A password sign-in remembers how it was made too.
    expect(seedSession().via).toBe('password');
  });
  it('turns browser cookies into the cookie jar apple-utils restores', () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    const jar = cookieJarOf([
      { name: 'myacinfo', value: 'a', domain: '.apple.com', path: '/', expires: -1, httpOnly: true, secure: true, session: true },
      { name: 'dqsid', value: 'b', domain: 'developer.apple.com', path: '/', expires: 1_800_000_000, httpOnly: false, secure: true, session: false, sameSite: 'None' },
    ], now);
    expect(jar.cookies).toEqual([
      { key: 'myacinfo', value: 'a', path: '/', secure: true, httpOnly: true, domain: 'apple.com', hostOnly: false, creation: now.toISOString(), lastAccessed: now.toISOString() },
      { key: 'dqsid', value: 'b', path: '/', secure: true, httpOnly: false, domain: 'developer.apple.com', hostOnly: true, expires: '2027-01-15T08:00:00.000Z', sameSite: 'none', creation: now.toISOString(), lastAccessed: now.toISOString() },
    ]);
  });
  it('honors cancellation and rejects unsafe HTTP debug logging before asking for secrets', async () => {
    const ctx = silentContext(prompter());
    await expect(loginAppleAccount(ctx, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
    vi.stubEnv('EXPO_APP_STORE_DEBUG', '1');
    await expect(loginAppleAccount(ctx)).rejects.toThrow('Disable EXPO_APP_STORE_DEBUG');
    expect(ctx.prompter.password).not.toHaveBeenCalled();
  });
});

describe('authenticated official Xcode downloads', () => {
  const CATALOG = 'https://developer.apple.com/services-account/QH65B2/downloadws/listDownloads.action';
  const MDN = 'https://developer-mdn.apple.com/services-account/QH65B2/downloadws/listDownloads.action';
  const ARCHIVE = 'https://download.developer.apple.com/Developer_Tools/Xcode_26.6/Xcode_26.6_Apple_silicon.xip';
  // The grant Apple's downloads page uses (developerservices2's answers 403 to a web sign-in).
  const AUTH = 'https://developer.apple.com/services-account/download?path=%2FDeveloper_Tools%2FXcode_26.6%2FXcode_26.6_Apple_silicon.xip';
  type Route = (init: RequestInit) => Response | Promise<Response>;
  /** A fake fetch keyed by URL; every request is recorded with its headers. */
  function transport(routes: Record<string, Route | Route[]>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input); calls.push({ url, init });
      const route = routes[url]; const handler = Array.isArray(route) ? route.shift() : route;
      if (!handler) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return handler(init);
    });
    return { fetcher: fetcher as unknown as typeof fetch, calls };
  }
  function cookieJar() {
    const setCookie = vi.fn((_cookie: string, _url: string, _options: unknown, callback: (error: Error | null) => void) => callback(null));
    return { setCookie, getCookieString: vi.fn((_url: string, callback: (error: Error | null, cookies?: string) => void) => callback(null, 'myacinfo=private-cookie')) };
  }
  const session = (fetcher: typeof fetch, jar = cookieJar()) => new AppleAccountSession(mock.expo as never, { ...authState(), session: { jar } } as never, { id: 'TEAM', name: 'Example Team' }, { fetch: fetcher });
  const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
  const catalog26 = { resultCode: 0, downloads: [{ name: 'Xcode 26.6', files: [{ remotePath: '/Developer_Tools/Xcode_26.6/Xcode_26.6_Apple_silicon.xip', fileSize: 21 }] }] };
  const download26 = () => selectAppleXcodeDownload(catalog26, '26.6');

  it('documents why downloads avoid apple-utils’ Axios client: its strict jar drops Apple’s sibling-domain cookies', async () => {
    const actual = await vi.importActual<typeof import('@expo/apple-utils')>('@expo/apple-utils');
    actual.Auth.resetInMemoryData();
    const server = createServer((_request, response) => { response.setHeader('Set-Cookie', 'fixture=value; Domain=developer-mdn.apple.com; Path=/'); response.end('{}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP fixture server');
      await expect(actual.getRequestClient().request({ method: 'post', url: `http://127.0.0.1:${address.port}/`, timeout: 3000 })).rejects.toThrow("Cookie not in this host's domain");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); actual.Auth.resetInMemoryData(); }
  });
  it('selects the stable exact release from Apple metadata and refuses external archive URLs', () => {
    expect(selectAppleXcodeDownload(catalog, '26.2')).toMatchObject({ version: '26.2', fileName: 'Xcode_26.2_Apple_silicon.xip', url: 'https://download.developer.apple.com/Developer_Tools/Xcode_26.2/Xcode_26.2_Apple_silicon.xip' });
    expect(() => selectAppleXcodeDownload({ downloads: catalog.downloads.slice(0, 1) }, '26.2')).toThrow('stable Xcode 26.2');
    expect(() => selectAppleXcodeDownload({ downloads: [{ name: 'Xcode 26.2', files: [{ remotePath: 'https://unrelated.test/Developer_Tools/Xcode.xip' }] }] }, '26.2')).toThrow('invalid Xcode download URL');
  });
  it('posts for the catalog with the session’s cookies, keeps redirects manual and leaves apple-utils alone', async () => {
    const jar = cookieJar();
    const { fetcher, calls } = transport({ [CATALOG]: () => { const response = json(catalog26); response.headers.append('set-cookie', 'dslang=US; Domain=apple.com'); return response; } });
    const live = session(fetcher, jar);
    await expect(live.discoverXcodeDownload('26.6')).resolves.toMatchObject({ fileName: 'Xcode_26.6_Apple_silicon.xip', size: 21 });
    expect(calls[0]).toMatchObject({ url: CATALOG, init: { method: 'POST', redirect: 'manual', headers: expect.objectContaining({ Cookie: 'myacinfo=private-cookie' }) } });
    // As Apple's downloads page asks (an empty form body gets HTTP 415).
    expect(calls[0]).toMatchObject({ init: { body: '{}', headers: expect.objectContaining({ 'Content-Type': 'application/json;charset=UTF-8' }) } });
    // Cookies a host may not set are skipped instead of failing the request.
    expect(jar.setCookie).toHaveBeenCalledWith('dslang=US; Domain=apple.com', CATALOG, { ignoreError: true }, expect.any(Function));
    expect(mock.client.request).not.toHaveBeenCalled();
    live.close(); await expect(live.discoverXcodeDownload('26.6')).rejects.toThrow('session has ended');
  });
  it('asks Apple’s MDN host when the main portal does not accept the session', async () => {
    const expired = { resultCode: 1100, resultString: 'Your session has expired. Please log in.' };
    const { fetcher, calls } = transport({ [CATALOG]: () => json(expired), [MDN]: () => json(catalog26) });
    await expect(session(fetcher).discoverXcodeDownload('26.6')).resolves.toMatchObject({ version: '26.6' });
    expect(calls.map((call) => call.url)).toEqual([CATALOG, MDN]);
  });
  it('reports Apple’s own reason when neither host lists downloads, without cookie values', async () => {
    const expired = { resultCode: 1100, userString: 'Your session has expired. Please log in.' };
    const { fetcher } = transport({ [CATALOG]: () => json(expired), [MDN]: () => new Response('<html>', { status: 302, headers: { location: '/login' } }) });
    const error = await session(fetcher).discoverXcodeDownload('26.6').then(() => new Error('expected a failure'), (caught: unknown) => caught as Error);
    expect(error.message).toContain('developer.apple.com: HTTP 200, result 1100, “Your session has expired. Please log in.”');
    expect(error.message).toContain('developer-mdn.apple.com: HTTP 302');
    expect(JSON.stringify(error)).not.toContain('private-cookie');
  });
  it('keeps network diagnostics useful but private', async () => {
    const { fetcher } = transport({});
    await expect(session(fetcher).discoverXcodeDownload('26.6')).rejects.toThrow('Apple Xcode catalog request failed (ENOTFOUND; TypeError).');
  });
  it('gets Apple’s download permission first, then streams a verified XIP with progress', async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'capmac-apple-download-'));
    const data = Buffer.from('xar!fake-test-archive');
    // As Apple answers: the grant cookie, and on to the file.
    const { fetcher, calls } = transport({ [AUTH]: () => new Response('', { status: 302, headers: { 'set-cookie': 'ADCDownloadAuth=grant; Domain=apple.com; Path=/; Secure; HttpOnly', location: ARCHIVE } }), [ARCHIVE]: () => new Response(data, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length) } }) });
    const destination = path.join(temporary, 'Xcode.xip'); const progress = vi.fn();
    await expect(session(fetcher).downloadXcode(download26(), destination, { onProgress: progress })).resolves.toBe(destination);
    expect(calls.map((call) => call.url)).toEqual([AUTH, ARCHIVE]);
    expect(await readFile(destination)).toEqual(data); expect(progress).toHaveBeenLastCalledWith(data.length, data.length, undefined);
    expect(await readdir(temporary)).toEqual(['Xcode.xip']);
  });
  it('stops with Apple’s terms hint when the download is not allowed', async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'capmac-apple-download-'));
    const denied = transport({ [AUTH]: () => new Response('', { status: 403 }) });
    await expect(session(denied.fetcher).downloadXcode(download26(), path.join(temporary, 'Xcode.xip'))).rejects.toMatchObject({ message: 'Apple did not allow this Xcode download (HTTP 403).', hint: expect.stringContaining('accept any terms') });
    // Sent to a sign-in page instead of the file: no grant either.
    const signIn = transport({ [AUTH]: () => new Response('', { status: 302, headers: { location: 'https://idmsa.apple.com/IDMSWebAuth/signin?path=%2Fdownload' } }) });
    await expect(session(signIn.fetcher).downloadXcode(download26(), path.join(temporary, 'Xcode.xip'))).rejects.toThrow('Apple did not allow this Xcode download (HTTP 302).');
    const unauthorized = transport({ [AUTH]: () => new Response(''), [ARCHIVE]: () => new Response('', { status: 302, headers: { location: 'https://developer.apple.com/unauthorized/' } }) });
    await expect(session(unauthorized.fetcher).downloadXcode(download26(), path.join(temporary, 'Xcode.xip'))).rejects.toThrow('Apple did not allow this Xcode download.');
    const elsewhere = transport({ [AUTH]: () => new Response(''), [ARCHIVE]: () => new Response('', { status: 302, headers: { location: 'https://example.test/Xcode.xip' } }) });
    await expect(session(elsewhere.fetcher).downloadXcode(download26(), path.join(temporary, 'Xcode.xip'))).rejects.toThrow('unexpected address');
    expect(await readdir(temporary)).toEqual([]);
  });
  it('downloads for a free Apple Account by name, with the grant from the Xcode sign-in', async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'capmac-apple-download-'));
    // The free sign-in can't read Apple's download list, so it names the managed Xcode's archive.
    expect(pinnedXcodeDownload('26.6')).toEqual({ version: '26.6', name: 'Xcode 26.6', url: ARCHIVE, fileName: 'Xcode_26.6_Apple_silicon.xip' });
    expect(() => pinnedXcodeDownload('26.6 beta')).toThrow(UserError);
    const data = Buffer.from('xar!fake-test-archive');
    const CDN = 'https://download-cdn.apple.com/Xcode_26.6_Apple_silicon.xip';
    const { fetcher, calls } = transport({
      // On the way, Apple's host may set a cookie of its own: the next hop carries it too.
      [ARCHIVE]: () => new Response('', { status: 302, headers: { 'set-cookie': 'edge=ok; Path=/', location: CDN } }),
      [CDN]: () => new Response(data, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length) } }),
    });
    const destination = path.join(temporary, 'Xcode.xip'); const progress = vi.fn();
    await expect(downloadXcodeWithGrant(['ADCDownloadAuth=grant'], pinnedXcodeDownload('26.6'), destination, { fetch: fetcher, onProgress: progress })).resolves.toBe(destination);
    expect(calls.map((call) => [call.url, (call.init.headers as Record<string, string>).Cookie])).toEqual([[ARCHIVE, 'ADCDownloadAuth=grant'], [CDN, 'ADCDownloadAuth=grant; edge=ok']]);
    expect(await readFile(destination)).toEqual(data); expect(progress).toHaveBeenLastCalledWith(data.length, data.length, undefined);
    // The grant is Apple's: no other host is sent it.
    const jar = downloadGrantJar(['ADCDownloadAuth=grant']);
    const sent = (url: string) => new Promise<string | undefined>((resolve) => jar.getCookieString(url, (_error, cookies) => resolve(cookies)));
    expect(await sent('https://example.test/x')).toBe(''); expect(await sent('http://download.developer.apple.com/x')).toBe('');
    expect(await sent('https://notapple.com/x')).toBe(''); expect(await sent('https://download.developer.apple.com/x')).toBe('ADCDownloadAuth=grant');
  });
  it('continues an interrupted download from its partial file', async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'capmac-apple-download-'));
    const data = Buffer.from('xar!fake-test-archive');
    await writeFile(path.join(temporary, '.capmac-Xcode.xip.part'), data.subarray(0, 8));
    const { fetcher, calls } = transport({ [AUTH]: () => new Response(''), [ARCHIVE]: () => new Response(data.subarray(8), { status: 206, headers: { 'content-range': `bytes 8-${data.length - 1}/${data.length}` } }) });
    const destination = path.join(temporary, 'Xcode.xip'); const progress = vi.fn();
    await session(fetcher).downloadXcode(download26(), destination, { onProgress: progress });
    expect(calls[1]!.init.headers).toMatchObject({ Range: 'bytes=8-' });
    expect(await readFile(destination)).toEqual(data); expect(await readdir(temporary)).toEqual(['Xcode.xip']);
    // Progress says where it continued from, so CapMac Studio and the CLI can show it.
    expect(progress).toHaveBeenNthCalledWith(1, 8, data.length, 8);
    expect(progress).toHaveBeenLastCalledWith(data.length, data.length, 8);
  });
  it('keeps the partial file when the transfer stops, and removes it when the archive is invalid', async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'capmac-apple-download-'));
    const destination = path.join(temporary, 'Xcode.xip');
    const broken = new ReadableStream({ async start(controller) { controller.enqueue(new TextEncoder().encode('xar!part')); await new Promise((resolve) => setTimeout(resolve, 50)); controller.error(new Error('socket hang up')); } });
    const stopped = transport({ [AUTH]: () => new Response(''), [ARCHIVE]: () => new Response(broken, { status: 200, headers: { 'content-length': '21' } }) });
    await expect(session(stopped.fetcher).downloadXcode(download26(), destination)).rejects.toMatchObject({ message: 'The Xcode download stopped before it finished.', hint: expect.stringContaining('continues where it stopped') });
    expect(await readFile(path.join(temporary, '.capmac-Xcode.xip.part'), 'utf8')).toBe('xar!part');
    await writeFile(destination, 'existing'); await rm(path.join(temporary, '.capmac-Xcode.xip.part'));
    const invalid = transport({ [AUTH]: () => new Response(''), [ARCHIVE]: () => new Response('not-a-xip', { headers: { 'content-length': '9' } }) });
    await expect(session(invalid.fetcher).downloadXcode(download26(), destination)).rejects.toThrow('valid Xcode archive');
    expect(await readFile(destination, 'utf8')).toBe('existing'); expect(await readdir(temporary)).toEqual(['Xcode.xip']);
  });
});

describe('reviewable, additive App Group assignment', () => {
  const group = (id: string, identifier: string) => ({ id, attributes: { identifier } });
  /**
   * Like Apple: an App ID's app groups come only when the request includes
   * them. A plain lookup's capability has none, which is what broke the first
   * real setup (every assignment looked empty, and its check always failed).
   */
  function appleAppIds(assigned: Map<string, ReturnType<typeof group>[]>, update = vi.fn()) {
    const capability = (id: string, withGroups: boolean) => ({ isType: (type: string) => type === 'APP_GROUPS', attributes: withGroups ? { appGroups: assigned.get(id) } : {} });
    mock.expo.BundleId.findAsync.mockImplementation(async (_context, { identifier }) => {
      const id = identifier.endsWith('.widget') ? 'WIDGET' : 'APP';
      return { id, attributes: { identifier }, hasCapabilityAsync: async () => (assigned.has(id) ? capability(id, false) : null), updateBundleIdCapabilityAsync: (options: unknown) => update(id, options) };
    });
    mock.expo.BundleId.infoAsync.mockImplementation(async (_context, { id, query }) => ({
      id, attributes: { bundleIdCapabilities: assigned.has(id) ? [capability(id, Boolean(query?.includes?.includes('bundleIdCapabilities.appGroups')))] : [] },
    }));
    return update;
  }
  it('plans requirements from app and widget without making account changes', async () => {
    const existing = group('OLD', 'group.dev.example.old');
    mock.expo.AppGroup.getAsync.mockResolvedValue([existing]);
    const update = appleAppIds(new Map([['APP', [existing]]]));
    const plan = await seedSession().planAppGroupAssignments([{ bundleIdentifier: 'dev.example.app', appGroups: ['group.dev.example.shared'] }, { bundleIdentifier: 'dev.example.app.widget', appGroups: ['group.dev.example.shared'] }]);
    expect(plan.groupsToCreate).toEqual(['group.dev.example.shared']); expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments[0]).toMatchObject({ existingGroups: ['group.dev.example.old'], needsUpdate: true });
    // The widget's App ID has no App Groups capability yet.
    expect(plan.assignments[1]).toMatchObject({ existingGroups: [], needsUpdate: true });
    expect(update).not.toHaveBeenCalled(); expect(mock.expo.AppGroup.createAsync).not.toHaveBeenCalled();
  });
  it('sees groups already in place: nothing to change', async () => {
    const shared = group('SHARED', 'group.dev.example.shared');
    mock.expo.AppGroup.getAsync.mockResolvedValue([shared]);
    const update = appleAppIds(new Map([['APP', [shared]]]));
    const plan = await seedSession().planAppGroupAssignments([{ bundleIdentifier: 'dev.example.app', appGroups: ['group.dev.example.shared'] }]);
    expect(plan).toMatchObject({ groupsToCreate: [], assignments: [{ existingGroups: ['group.dev.example.shared'], needsUpdate: false }] });
    await seedSession().applyAppGroupAssignments(plan);
    expect(update).not.toHaveBeenCalled();
  });
  it('unions current assignments with required groups, preserving concurrent additions and every other capability', async () => {
    const existing = group('OLD', 'group.dev.example.old'); const concurrent = group('NEW', 'group.dev.example.concurrent'); const wanted = group('WANTED', 'group.dev.example.shared');
    mock.expo.AppGroup.getAsync.mockResolvedValue([existing, concurrent, wanted]);
    const assigned = new Map([['APP', [existing, concurrent]]]);
    const update = appleAppIds(assigned, vi.fn(async (id: string, options: { relationships: { appGroups: string[] } }) => {
      assigned.set(id, options.relationships.appGroups.map((groupId) => [existing, concurrent, wanted].find((entry) => entry.id === groupId)!));
    }));
    await seedSession().applyAppGroupAssignments({ teamId: 'TEAM', groupsToCreate: [], assignments: [{ bundleIdentifier: 'dev.example.app', bundleId: 'APP', requiredGroups: ['group.dev.example.shared'], existingGroups: ['group.dev.example.old'], needsUpdate: true }] });
    expect(update).toHaveBeenCalledWith('APP', { capabilityType: 'APP_GROUPS', option: 'ON', relationships: { appGroups: ['OLD', 'NEW', 'WANTED'] } });
    expect(mock.expo.AppGroup.createAsync).not.toHaveBeenCalled();
  });
  it('fails when Apple still doesn’t show the assignment after a few looks', async () => {
    const wanted = group('WANTED', 'group.dev.example.shared');
    mock.expo.AppGroup.getAsync.mockResolvedValue([wanted]);
    appleAppIds(new Map([['APP', []]]));
    await expect(seedSession().applyAppGroupAssignments({ teamId: 'TEAM', groupsToCreate: [], assignments: [{ bundleIdentifier: 'dev.example.app', bundleId: 'APP', requiredGroups: ['group.dev.example.shared'], existingGroups: [], needsUpdate: true }] }))
      .rejects.toThrow('Apple did not confirm all App Group assignments for dev.example.app.');
  });
  it('does not mutate a plan from another team or create an unreviewed group', async () => {
    await expect(seedSession().applyAppGroupAssignments({ teamId: 'OTHER', groupsToCreate: [], assignments: [] })).rejects.toThrow('another Apple developer team');
    mock.expo.AppGroup.getAsync.mockResolvedValue([]);
    await expect(seedSession().applyAppGroupAssignments({ teamId: 'TEAM', groupsToCreate: [], assignments: [{ bundleIdentifier: 'dev.example.app', bundleId: 'APP', requiredGroups: ['group.dev.example.shared'], existingGroups: [], needsUpdate: true }] })).rejects.toThrow('changed after planning');
    expect(mock.expo.AppGroup.createAsync).not.toHaveBeenCalled();
  });
});

describe('what Apple said when it refused', () => {
  it('keeps Apple’s error codes and text, the endpoint, and nothing from the request', async () => {
    const { appleRefusal } = await import('../../packages/core/src/engine/wsl/apple-account.js');
    expect(appleRefusal({ status: 400, config: { url: 'certificates', baseURL: 'https://developer.apple.com/services-account/v1/' }, data: { errors: [{ code: 'PARAMETER_ERROR.INVALID', title: 'A parameter has an invalid value', detail: 'csrContent is not valid' }] } }))
      .toEqual(['Apple answered HTTP 400 to v1/certificates', 'PARAMETER_ERROR.INVALID · A parameter has an invalid value · csrContent is not valid']);
    expect(appleRefusal({ status: 400, data: { error: 'Bad Request', message: 'Required request body is missing' } }))
      .toEqual(['Apple answered HTTP 400', 'error: Bad Request', 'message: Required request body is missing']);
    expect(appleRefusal({ status: 409, data: '<html><body>Too many\r\nrequests</body></html>' })).toEqual(['Apple answered HTTP 409', 'Too many requests']);
  });

  it('adds it to the error of the session request that failed', async () => {
    const client = mock.client as unknown as { interceptors: { response: { use: ReturnType<typeof vi.fn> } } };
    client.interceptors.response.use.mockImplementation((_ok: unknown, bad: (error: unknown) => unknown) => {
      // Apple refuses the request the session makes: the interceptor records its answer.
      (client as unknown as { refuse: typeof bad }).refuse = bad;
      return 8;
    });
    const session = seedSession();
    const failure = session.connect(async () => {
      try { (client as unknown as { refuse: (error: unknown) => unknown }).refuse({ response: { status: 400, data: { error: 'Bad Request', message: 'certificateType is not supported' } } }); } catch { /* apple-utils turns it into its own error */ }
      throw new UserError('Apple could not make an Apple Development certificate.', 'Check the account', ['Bad Request']);
    });
    await expect(failure).rejects.toMatchObject({ details: ['Bad Request', 'Apple answered HTTP 400', 'error: Bad Request', 'message: certificateType is not supported'] });
  });
});

describe('apple-utils’ two developer portal hosts', () => {
  it('swaps one for the other, and leaves any other address alone', async () => {
    const { otherPortalHost } = await import('../../packages/core/src/engine/wsl/apple-account.js');
    expect(otherPortalHost('https://developer.apple.com/services-account/v1/')).toBe('https://developer-mdn.apple.com/services-account/v1/');
    expect(otherPortalHost('https://developer-mdn.apple.com/services-account/v1/certificates')).toBe('https://developer.apple.com/services-account/v1/certificates');
    expect(otherPortalHost('https://idmsa.apple.com/appleauth/auth')).toBe('https://idmsa.apple.com/appleauth/auth');
    expect(otherPortalHost('certificates')).toBe('certificates');
  });
});
