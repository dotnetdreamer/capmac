/** Apple ID sessions use Expo's maintained SRP/2FA implementation, entirely in memory. */
import { createWriteStream } from 'node:fs';
import { mkdir, link, unlink, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type * as ExpoApple from '@expo/apple-utils';
import type { EngineContext } from '../context.js';
import { throwIfAborted } from '../context.js';
import { CancelledError, UserError } from '../errors.js';
import { answerTwoFactorWithPrompter, type TwoFactorClient } from './apple-two-factor.js';

type Expo = typeof ExpoApple;
type AuthState = NonNullable<Awaited<ReturnType<Expo['Auth']['loginWithUserCredentialsAsync']>>>;
type AuthRequestConfig = { timeout?: number; signal?: AbortSignal; url?: string; baseURL?: string };

/** apple-utils reaches the developer portal on one of these two hosts. */
const PORTAL_HOSTS = ['https://developer.apple.com/', 'https://developer-mdn.apple.com/'];
/** The same address on the other portal host. */
export function otherPortalHost(address: string): string {
  const [first, second] = PORTAL_HOSTS as [string, string];
  if (address.startsWith(first)) return second + address.slice(first.length);
  if (address.startsWith(second)) return first + address.slice(second.length);
  return address;
}
export type AppleRequestContext = AuthState['context'];
type Fetch = typeof fetch;
/** The session's tough-cookie jar. Only these two callback methods are used. */
interface CookieJarLike {
  getCookieString(url: string, callback: (error: Error | null, cookies?: string) => void): void;
  setCookie(cookie: string, url: string, options: { ignoreError: boolean }, callback: (error: Error | null) => void): void;
}
const CATALOG_HOSTS = ['https://developer.apple.com', 'https://developer-mdn.apple.com'];
const CATALOG_PATH = '/services-account/QH65B2/downloadws/listDownloads.action';
/** The grant Apple's downloads page uses. (developerservices2's, Xcode's own, wants Xcode's sign-in: 403.) */
const DOWNLOAD_AUTH = 'https://developer.apple.com/services-account/download';
const AGREEMENT_HINT = 'Open developer.apple.com/download in a browser, sign in once and accept any terms Apple shows, then run capmac wsl setup again.';
let queue: Promise<unknown> = Promise.resolve();

/** apple-utils owns singleton cookie/CSRF state. Serialize access, including scoped cache hooks. */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

/** Plaintext Expo cookie/username caches are deliberately not used by CapMac. */
async function memoryOnly<T>(expo: Expo, fn: () => Promise<T>): Promise<T> {
  const writeCookies = expo.CookieFileCache.writeCookiesToFileAsync;
  const cache = expo.JsonFileCache.cacheAsync;
  expo.CookieFileCache.writeCookiesToFileAsync = async () => undefined;
  expo.JsonFileCache.cacheAsync = async () => undefined;
  try { return await fn(); }
  finally { expo.CookieFileCache.writeCookiesToFileAsync = writeCookies; expo.JsonFileCache.cacheAsync = cache; }
}

interface AppleHttpResponse { status: number; data?: unknown; config?: { url?: string; baseURL?: string } }

/**
 * What Apple said when it refused a request: the endpoint, its error codes and
 * text. Never request data, headers or cookies (only the response body's error fields).
 */
export function appleRefusal(response: AppleHttpResponse): string[] {
  const clean = (text: string) => text.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  let where = '';
  try { where = new URL(response.config?.url ?? '', response.config?.baseURL || undefined).pathname.split('/').filter(Boolean).slice(-2).join('/'); } catch { /* no usable address */ }
  const lines = [`Apple answered HTTP ${response.status}${where ? ` to ${where}` : ''}`];
  const data = response.data;
  if (data && typeof data === 'object') {
    const body = data as Record<string, unknown>;
    for (const item of Array.isArray(body.errors) ? body.errors.slice(0, 4) : []) {
      const error = item as Record<string, unknown> | null;
      const parts = [error?.code, error?.title, error?.detail].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
      if (parts.length) lines.push(clean(parts.join(' · ')));
    }
    for (const key of ['error', 'message', 'userString', 'resultString']) if (typeof body[key] === 'string' && body[key]) lines.push(clean(`${key}: ${body[key]}`));
  } else if (typeof data === 'string' && data.trim()) lines.push(clean(data.replace(/<[^>]*>/g, ' ')));
  return lines.slice(0, 6);
}

/**
 * apple-utils shows a "Logging in..." spinner on stderr for the whole sign-in,
 * and the two-factor code is asked inside it: in a terminal the spinner would
 * redraw over the question (and on macOS and Linux swallow the keys typed).
 * While signing in, stderr reads as not a terminal, so it prints plain lines.
 */
function plainSpinners(): () => void {
  if (!process.stderr.isTTY) return () => undefined;
  const own = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
  return () => {
    if (own) Object.defineProperty(process.stderr, 'isTTY', own);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  };
}

function safeError(error: unknown, signal?: AbortSignal, operation = 'Apple account request'): Error {
  if (signal?.aborted || error instanceof CancelledError || (error as { isCancelledPrompt?: boolean })?.isCancelledPrompt) return new CancelledError();
  if (error instanceof UserError) return error;
  const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? '';
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (name === 'InvalidUserCredentialsError' || status === 401) return new UserError('Apple did not accept this sign-in. Try again with your Apple Account password.', 'Use your regular Apple Account password, not an app-specific password.');
  if (status === 403) return new UserError('Apple denied this account operation.', 'Check this team’s permissions and accept any pending agreements at developer.apple.com.');
  // Only bounded, predefined diagnostics escape Axios. Its config/message/stack may contain secrets.
  // fetch() reports network failures as a TypeError with the system code on `cause`.
  const suppliedCode = (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code;
  const code = typeof suppliedCode === 'string' && ['ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_NETWORK', 'ERR_CANCELED', 'ERR_INVALID_URL', 'ERR_FR_TOO_MANY_REDIRECTS', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPROTO', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'EEXIST', 'ENOSPC', 'EACCES'].includes(suppliedCode) ? suppliedCode : undefined;
  const details = [Number.isInteger(status) && status! >= 100 && status! <= 599 ? `HTTP ${status}` : '', code ?? '', ['TypeError', 'RangeError', 'AssertionError'].includes(name) ? name : ''].filter(Boolean);
  const message = String((error as { message?: unknown })?.message);
  const reason = /maxContentLength size of \d+ exceeded/.test(message) ? 'response exceeded the configured size limit' : message.includes("Cookie not in this host's domain") ? 'Apple portal cookie-domain mismatch' : undefined;
  return new UserError(`${operation} failed${details.length ? ` (${details.join('; ')})` : ''}${reason ? ': ' + reason : ''}.`, 'Try again, or sign in at developer.apple.com to check for pending agreements.');
}

/**
 * Apple's download service spans developer.apple.com, developer-mdn.apple.com and
 * developerservices2.apple.com, and its responses set cookies for sibling hosts. A
 * strict jar inside Axios rejects those and throws the whole response away, so the
 * download requests use fetch with the session's jar and skip only such cookies.
 */
async function appleFetch(transport: Fetch, jar: CookieJarLike, url: string, init: RequestInit & { headers?: Record<string, string> },
  options: { signal?: AbortSignal; totalMs?: number; headersMs?: number }): Promise<Response> {
  const cookie = await new Promise<string>((resolve, reject) => jar.getCookieString(url, (error, value) => error ? reject(error) : resolve(value ?? '')));
  const waiting = new AbortController();
  const timer = options.headersMs ? setTimeout(() => waiting.abort(new UserError('Apple did not answer in time. Check the internet connection and run capmac wsl setup again.')), options.headersMs) : undefined;
  const signals = [waiting.signal, ...(options.signal ? [options.signal] : []), ...(options.totalMs ? [AbortSignal.timeout(options.totalMs)] : [])];
  try {
    const response = await transport(url, { ...init, headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'manual', signal: AbortSignal.any(signals) });
    for (const value of response.headers.getSetCookie()) await new Promise<void>((resolve) => jar.setCookie(value, url, { ignoreError: true }, () => resolve()));
    return response;
  } catch (error) {
    if (waiting.signal.aborted && !options.signal?.aborted) throw waiting.signal.reason;
    throw error;
  } finally { clearTimeout(timer); }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new UserError('Apple returned an unexpectedly large response.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Apple's own result text is safe to show; it never carries cookies or tokens. */
function appleResult(document: unknown): { code?: number; text?: string } {
  const value = document as { resultCode?: unknown; userString?: unknown; resultString?: unknown } | undefined;
  const text = [value?.userString, value?.resultString].find((item): item is string => typeof item === 'string' && item.trim() !== '');
  return { ...(typeof value?.resultCode === 'number' ? { code: value.resultCode } : {}), ...(text ? { text: text.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 200) } : {}) };
}

/** Follows Apple's redirects within apple.com only; sign-in and "unauthorized" pages end the download. */
async function openAppleDownload(transport: Fetch, jar: CookieJarLike, start: URL, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  let current = start;
  for (let hop = 0; hop < 5; hop++) {
    const response = await appleFetch(transport, jar, current.href, { method: 'GET', headers }, { signal, headersMs: 60_000 });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    const next = location ? new URL(location, current) : undefined;
    if (!next || next.protocol !== 'https:' || next.username || next.password || !(next.hostname === 'apple.com' || next.hostname.endsWith('.apple.com'))) throw new UserError('Apple sent the Xcode download to an unexpected address.');
    if (/^\/(?:unauthorized|account|sign-?in|login)\b/i.test(next.pathname)) throw new UserError('Apple did not allow this Xcode download.', AGREEMENT_HINT);
    current = next;
  }
  throw new UserError('Apple redirected the Xcode download too many times.');
}

export interface AppleAccountOptions {
  signal?: AbortSignal;
}
export interface SessionRequestOptions {
  /** Send developer-portal requests to apple-utils' other portal host (after Apple answered 421 on the usual one). */
  otherPortalHost?: boolean;
}
export interface AppleXcodeDownload { version: string; name: string; url: string; fileName: string; size?: number }
export interface AppleAppGroupRequirement { bundleIdentifier: string; appGroups: string[] }
export interface AppleAppGroupPlan {
  teamId: string;
  groupsToCreate: string[];
  assignments: { bundleIdentifier: string; bundleId: string; requiredGroups: string[]; existingGroups: string[]; needsUpdate: boolean }[];
}

/** How a session was signed in: in CapMac (password and code), or on Apple's website in a browser. */
export type AppleSignInWay = 'password' | 'website';

function checkSignInAllowed(ctx: EngineContext): void {
  if (!ctx.prompter.interactive) throw new UserError('Apple sign-in needs someone to answer.', 'Run capmac wsl setup in PowerShell, or set up this PC in CapMac Studio.');
  // Expo's opt-in HTTP debugging may include auth data. Do not let it run during this flow.
  if (process.env.EXPO_APP_STORE_DEBUG && !['0', 'false'].includes(process.env.EXPO_APP_STORE_DEBUG.toLowerCase())) throw new UserError('Disable EXPO_APP_STORE_DEBUG before signing in to Apple.');
}

/**
 * One apple-utils sign-in, whichever way: CapMac asks the team (and a two-factor
 * code) through `ctx.prompter`, and nothing is cached on disk. Resolves null
 * when Apple turns down saved cookies.
 */
async function signIn(ctx: EngineContext, signal: AbortSignal | undefined, via: AppleSignInWay, login: (expo: Expo) => Promise<AuthState | null>): Promise<AppleAccountSession | null> {
  return exclusive(async () => {
    throwIfAborted(signal);
    // Node exposes this NCC-bundled CommonJS package through `default`; bundlers may
    // expose named exports. Keep the external ESM CLI and test runner interoperable.
    const imported = await import('@expo/apple-utils');
    const expo = (imported as unknown as { default?: Expo }).default ?? imported;
    return memoryOnly(expo, async () => {
      expo.Auth.resetInMemoryData();
      const client = expo.getRequestClient();
      const interceptor = client.interceptors.request.use((config: AuthRequestConfig) => {
        throwIfAborted(signal);
        config.timeout = 30_000;
        if (signal) config.signal = signal;
        return config;
      });
      // Apple's two-factor code is asked here, not by apple-utils' terminal prompts.
      const stopAnswering = answerTwoFactorWithPrompter(client as unknown as TwoFactorClient, ctx, signal);
      const selectTeam = expo.Teams.selectTeamAsync;
      let chosenTeam: ExpoApple.Teams.AppStoreTeam | undefined;
      expo.Teams.selectTeamAsync = async (props = {}) => {
        throwIfAborted(signal);
        const teams = await expo.Teams.getTeamsAsync(props.restoringSession);
        if (!teams.length) throw new UserError('This Apple Account has no developer team.', 'A free Apple Account can’t sign apps here yet. Join the Apple Developer Program (US$99 a year) at developer.apple.com/programs, then run setup again.');
        chosenTeam = props.teamId ? teams.find((team) => team.teamId === props.teamId) : teams.length === 1 ? teams[0] : await ctx.prompter.choose({
          message: 'Choose your Apple developer team:', items: teams.map((team) => ({ label: `${team.name} (${team.teamId})`, value: team })),
        });
        if (!chosenTeam || !teams.some((team) => team.teamId === chosenTeam!.teamId)) throw new UserError('The selected Apple developer team is unavailable.');
        return chosenTeam;
      };
      const restoreSpinners = plainSpinners();
      try {
        const state = await login(expo);
        throwIfAborted(signal);
        if (!state) return null;
        if (!chosenTeam || state.context.teamId !== chosenTeam.teamId) throw new UserError('Apple sign-in did not return a developer-team session.');
        delete state.password;
        return new AppleAccountSession(expo, state, { id: chosenTeam.teamId, name: chosenTeam.name }, { via });
      } finally {
        restoreSpinners();
        expo.Teams.selectTeamAsync = selectTeam;
        stopAnswering();
        client.interceptors.request.eject(interceptor);
        expo.Auth.resetInMemoryData();
      }
    });
  });
}

/**
 * Every question (email, password, two-factor code, team) goes through
 * `ctx.prompter`: the terminal, or CapMac Studio's dialogs. Passwords, cookies
 * and codes never enter settings, logs or Expo's keychain.
 */
export async function loginAppleAccount(ctx: EngineContext, options: AppleAccountOptions = {}): Promise<AppleAccountSession> {
  throwIfAborted(options.signal);
  checkSignInAllowed(ctx);
  const username = (await ctx.prompter.text({ purpose: 'apple-email', message: 'Apple Account email:' })).trim();
  if (!username || /[\r\n\0]/.test(username)) throw new UserError('Enter your Apple Account email address.');
  let password = await ctx.prompter.password({ purpose: 'apple', message: 'Apple Account password:', user: username });
  if (!password) throw new UserError('An Apple Account password is required to sign in.');
  try {
    // This direct entrypoint bypasses Expo's filesystem-session/keychain restoration.
    const session = await signIn(ctx, options.signal, 'password', (expo) => expo.Auth.loginWithUserCredentialsAsync({ username, password }, { autoResolveProvider: true }));
    if (!session) throw new UserError('Apple sign-in did not return a developer-team session.');
    return session;
  } catch (error) { throw safeError(error, options.signal, 'Apple sign-in'); }
  finally { password = ''; }
}

/** A browser cookie, as the DevTools protocol reports it. */
export interface BrowserCookie { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; session: boolean; sameSite?: string }

/** Browser cookies as a serialized tough-cookie jar, the form apple-utils restores sessions from. */
export function cookieJarOf(cookies: BrowserCookie[], now = new Date()): { cookies: Record<string, unknown>[] } {
  return {
    cookies: cookies.map((cookie) => ({
      key: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
      // ".apple.com" is a cookie for apple.com and its subdomains; "developer.apple.com" for that host only.
      domain: cookie.domain.replace(/^\./, '').toLowerCase(), hostOnly: !cookie.domain.startsWith('.'),
      ...!cookie.session && cookie.expires > 0 ? { expires: new Date(cookie.expires * 1000).toISOString() } : {},
      ...cookie.sameSite ? { sameSite: cookie.sameSite.toLowerCase() } : {},
      creation: now.toISOString(), lastAccessed: now.toISOString(),
    })),
  };
}

/**
 * The session of a sign-in made on Apple's website, from its browser's cookies:
 * like a password sign-in, without CapMac ever seeing the password. Null when
 * Apple no longer accepts those cookies.
 */
export async function loginAppleAccountWithCookies(ctx: EngineContext, cookies: BrowserCookie[], options: AppleAccountOptions = {}): Promise<AppleAccountSession | null> {
  throwIfAborted(options.signal);
  checkSignInAllowed(ctx);
  const jar = cookieJarOf(cookies) as unknown as NonNullable<ExpoApple.Auth.UserCredentials['cookies']>;
  try { return await signIn(ctx, options.signal, 'website', (expo) => expo.Auth.loginWithCookiesAsync({ cookies: jar }, { autoResolveProvider: true })); }
  catch (error) { throw safeError(error, options.signal, 'Apple sign-in'); }
}

function appleDownloadUrl(value: string): URL {
  const url = new URL(value, 'https://download.developer.apple.com');
  if (url.origin !== 'https://download.developer.apple.com' || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/Developer_Tools/') || !/\.xip$/i.test(url.pathname)) throw new UserError('Apple returned an invalid Xcode download URL.');
  return url;
}

/** Parse Apple's authenticated download catalog, rather than guessing a URL. */
export function selectAppleXcodeDownload(document: unknown, version: string): AppleXcodeDownload {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new UserError('Choose a stable Xcode version such as 26.6.');
  const downloads = (document as { downloads?: unknown[] })?.downloads;
  if (!Array.isArray(downloads)) throw new UserError('Apple did not return its download catalog.', 'Sign in again and accept any pending download agreements.');
  const exact = downloads.filter((item): item is { name: string; files: unknown[] } => !!item && typeof item === 'object' && (item as { name?: unknown }).name === `Xcode ${version}` && Array.isArray((item as { files?: unknown }).files));
  const candidates: AppleXcodeDownload[] = [];
  for (const item of exact) for (const unknownFile of item.files) {
    const file = unknownFile as { remotePath?: unknown; filename?: unknown; fileSize?: unknown };
    if (typeof file.remotePath !== 'string' || !/\.xip$/i.test(file.remotePath)) continue;
    const url = appleDownloadUrl(file.remotePath);
    const fileName = path.posix.basename(url.pathname);
    const size = Number(file.fileSize);
    candidates.push({ version, name: item.name, url: url.href, fileName, ...(Number.isSafeInteger(size) && size > 0 ? { size } : {}) });
  }
  // Apple silicon and universal archives both contain the platform-independent iPhoneOS SDK.
  candidates.sort((a, b) => Number(/Apple_silicon/i.test(b.fileName)) - Number(/Apple_silicon/i.test(a.fileName)) || a.fileName.localeCompare(b.fileName));
  if (!candidates[0]) throw new UserError(`Apple’s catalog does not contain the stable Xcode ${version} archive.`);
  return candidates[0];
}

/** No enumerable cookie jar, password, token, or Axios client escapes this object. */
export class AppleAccountSession {
  #expo: Expo;
  #state: AuthState | undefined;
  #fetch: Fetch;
  readonly team: Readonly<{ id: string; name: string }>;
  /** Signed in with a password in CapMac, or on Apple's website (which then also makes what the API won't). */
  readonly via: AppleSignInWay;
  constructor(expo: Expo, state: AuthState, team: { id: string; name: string }, options: { fetch?: Fetch; via?: AppleSignInWay } = {}) {
    this.#expo = expo; this.#state = state; this.team = Object.freeze({ ...team }); this.#fetch = options.fetch ?? fetch; this.via = options.via ?? 'password';
  }
  close(): void { this.#state = undefined; }
  async #use<T>(fn: (expo: Expo, state: AuthState) => Promise<T>, signal?: AbortSignal, operation = 'Apple account request', options: SessionRequestOptions = {}): Promise<T> {
    return exclusive(async () => {
      throwIfAborted(signal);
      const state = this.#state;
      if (!state) throw new UserError('This Apple sign-in session has ended. Sign in again.');
      const expo = this.#expo;
      return memoryOnly(expo, async () => {
        expo.Auth.resetInMemoryData();
        const client = expo.getRequestClient();
        const defaults = client.defaults as typeof client.defaults & { jar?: AuthState['session']['jar']; withCredentials?: boolean };
        defaults.jar = state.session.jar; defaults.withCredentials = true;
        // apple-utils keeps only the title of Apple's error ("Bad Request"): keep what Apple said to the last request.
        let refused: string[] = [];
        const interceptor = client.interceptors.request.use((config: AuthRequestConfig) => {
          throwIfAborted(signal);
          refused = [];
          if (options.otherPortalHost) for (const key of ['baseURL', 'url'] as const) { const value = config[key]; if (typeof value === 'string') config[key] = otherPortalHost(value); }
          config.timeout ||= 30_000;
          if (signal) config.signal = signal;
          return config;
        });
        const watch = client.interceptors.response.use(
          (response: AppleHttpResponse) => { if (response.status >= 400) refused = appleRefusal(response); return response; },
          (error: unknown) => { const response = (error as { response?: AppleHttpResponse })?.response; if (response && response.status >= 400) refused = appleRefusal(response); throw error; },
        );
        try { return await fn(expo, state); }
        catch (error) {
          const safe = safeError(error, signal, operation);
          if (!(safe instanceof UserError) || !refused.length) throw safe;
          throw new UserError(safe.message, safe.hint, [...(safe.details ?? []).filter((line) => !refused.includes(line)), ...refused]);
        }
        finally { client.interceptors.response.eject(watch); client.interceptors.request.eject(interceptor); expo.Auth.resetInMemoryData(); }
      });
    });
  }
  /** The download service needs only the session's cookies, not apple-utils' Axios client. */
  async #withJar<T>(fn: (jar: CookieJarLike) => Promise<T>, signal: AbortSignal | undefined, operation: string): Promise<T> {
    throwIfAborted(signal);
    const state = this.#state;
    if (!state) throw new UserError('This Apple sign-in session has ended. Sign in again.');
    try { return await fn(state.session.jar as unknown as CookieJarLike); }
    catch (error) { throw safeError(error, signal, operation); }
  }
  /** Apple developer-portal calls on this session, for signing setup. No cookie or credential is handed out. */
  async connect<T>(fn: (expo: Expo, context: AppleRequestContext) => Promise<T>, signal?: AbortSignal, operation?: string, options: SessionRequestOptions = {}): Promise<T> {
    return this.#use((expo, state) => fn(expo, state.context), signal, operation, options);
  }
  async discoverXcodeDownload(version: string, signal?: AbortSignal): Promise<AppleXcodeDownload> {
    return this.#withJar(async (jar) => {
      const failures: string[] = [];
      for (const host of CATALOG_HOSTS) {
        // As Apple's own downloads page asks: an empty form body gets HTTP 415 now.
        const response = await appleFetch(this.#fetch, jar, host + CATALOG_PATH, {
          method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json, text/plain, */*' }, body: '{}',
        }, { signal, totalMs: 180_000 });
        // Apple's catalog lists every historical developer download and can pass 20 MB.
        const text = await boundedText(response, 128_000_000);
        let document: unknown;
        try { document = JSON.parse(text); } catch { document = undefined; }
        if (response.ok && Array.isArray((document as { downloads?: unknown })?.downloads)) return selectAppleXcodeDownload(document, version);
        const result = appleResult(document);
        failures.push(`${new URL(host).hostname}: HTTP ${response.status}${result.code !== undefined ? `, result ${result.code}` : ''}${result.text ? `, “${result.text}”` : ''}`);
      }
      throw new UserError(`Apple did not return its list of downloads (${failures.join('; ')}).`, AGREEMENT_HINT);
    }, signal, 'Apple Xcode catalog request');
  }
  /** `onProgress`'s `resumedFrom`: the bytes an interrupted download had already, when it continues. */
  async downloadXcode(download: AppleXcodeDownload, destination: string, options: { signal?: AbortSignal; onProgress?: (received: number, total?: number, resumedFrom?: number) => void } = {}): Promise<string> {
    const url = appleDownloadUrl(download.url);
    if (!path.isAbsolute(destination)) throw new UserError('The Xcode archive destination must be an absolute path.');
    return this.#withJar(async (jar) => {
      // Apple serves a developer file only after this call sets its ADCDownloadAuth cookie (for
      // all of apple.com). Like a link on Apple's downloads page, it then sends the browser on to
      // the file; sent anywhere else (a sign-in page), there is no grant.
      const authorization = new URL(DOWNLOAD_AUTH);
      authorization.searchParams.set('path', decodeURIComponent(url.pathname));
      const granted = await appleFetch(this.#fetch, jar, authorization.href, { method: 'GET', headers: { Accept: '*/*' } }, { signal: options.signal, totalMs: 60_000 });
      await granted.body?.cancel().catch(() => undefined);
      const onward = granted.headers.get('location');
      const toFile = !!onward && new URL(onward, authorization).hostname === url.hostname;
      if (granted.status >= 400 || (granted.status >= 300 && !toFile)) throw new UserError(`Apple did not allow this Xcode download (HTTP ${granted.status}).`, AGREEMENT_HINT);
      const directory = path.dirname(destination);
      await mkdir(directory, { recursive: true });
      // A fixed partial name lets an interrupted multi-gigabyte download continue on the next run.
      const partial = path.join(directory, `.capmac-${path.basename(destination)}.part`);
      let offset = await stat(partial).then((info) => info.isFile() ? info.size : 0, () => 0);
      const response = await openAppleDownload(this.#fetch, jar, url, { Accept: '*/*', ...(offset ? { Range: `bytes=${offset}-` } : {}) }, options.signal);
      if (response.status !== 200 && response.status !== 206) { await response.body?.cancel().catch(() => undefined); throw new UserError(`Apple did not send the Xcode archive (HTTP ${response.status}).`, AGREEMENT_HINT); }
      if (/text\/html|application\/json/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel().catch(() => undefined); throw new UserError('Apple returned a sign-in page instead of the Xcode archive.', AGREEMENT_HINT); }
      // Apple may ignore the range and send the whole file again.
      if (response.status === 200) offset = 0;
      const range = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      const length = Number(response.headers.get('content-length'));
      const total = range ? Number(range[1]) : Number.isSafeInteger(length) && length > 0 ? offset + length : download.size;
      if (!response.body) throw new UserError('Apple sent an empty Xcode download.');
      let received = offset;
      const resumedFrom = offset || undefined;
      options.onProgress?.(received, total, resumedFrom);
      // Abort a stalled transfer; the partial file is kept for the next run.
      const idle = new AbortController();
      let timer = setTimeout(() => idle.abort(), 120_000);
      const progress = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        clearTimeout(timer); timer = setTimeout(() => idle.abort(), 120_000);
        received += chunk.length; options.onProgress?.(received, total, resumedFrom); callback(null, chunk);
      } });
      try {
        await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), progress, createWriteStream(partial, { flags: offset ? 'a' : 'w' }),
          { signal: AbortSignal.any([idle.signal, ...(options.signal ? [options.signal] : [])]) });
      } catch (error) {
        if (options.signal?.aborted) throw new CancelledError();
        throw new UserError(idle.signal.aborted ? 'Apple stopped sending the Xcode download.' : 'The Xcode download stopped before it finished.', 'Run capmac wsl setup again; the download continues where it stopped.', [(error as Error)?.name ?? 'Error']);
      } finally { clearTimeout(timer); }
      if (total && received !== total) throw new UserError('The Xcode download stopped before it finished.', 'Run capmac wsl setup again; the download continues where it stopped.');
      const header = Buffer.alloc(4);
      const file = await open(partial, 'r');
      try { await file.read(header, 0, 4, 0); } finally { await file.close(); }
      if (header.toString('ascii') !== 'xar!') {
        await unlink(partial).catch(() => undefined);
        throw new UserError('Apple did not send a valid Xcode archive.', 'Run capmac wsl setup again to download it once more.');
      }
      // Hard-link publication is atomic and cannot overwrite an existing download.
      await link(partial, destination);
      await unlink(partial);
      return destination;
    }, options.signal, 'Apple Xcode download');
  }
  async planAppGroupAssignments(requirements: AppleAppGroupRequirement[], signal?: AbortSignal): Promise<AppleAppGroupPlan> {
    return this.#use(async (expo, state) => {
      const required = new Map<string, Set<string>>();
      for (const requirement of requirements) {
        if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(requirement.bundleIdentifier)) throw new UserError('Invalid bundle identifier in App Group requirements.');
        const values = required.get(requirement.bundleIdentifier) ?? new Set<string>();
        for (const group of requirement.appGroups) {
          if (!/^group\.[A-Za-z0-9][A-Za-z0-9.-]+$/.test(group)) throw new UserError(`Invalid App Group identifier for ${requirement.bundleIdentifier}.`);
          values.add(group);
        }
        required.set(requirement.bundleIdentifier, values);
      }
      const groups = await expo.AppGroup.getAsync(state.context);
      const identifiers = new Set(groups.map((group) => group.attributes.identifier));
      const plan: AppleAppGroupPlan = { teamId: this.team.id, groupsToCreate: [], assignments: [] };
      for (const [bundleIdentifier, values] of required) {
        if (!values.size) continue;
        const bundle = await expo.BundleId.findAsync(state.context, { identifier: bundleIdentifier });
        if (!bundle || bundle.attributes.identifier !== bundleIdentifier) throw new UserError(`Apple has no registered App ID for ${bundleIdentifier}.`);
        const assigned = await appGroupsOf(expo, state.context, bundle.id);
        const existingGroups = assigned.groups.map((group) => group.identifier);
        const requiredGroups = [...values].sort();
        plan.assignments.push({ bundleIdentifier, bundleId: bundle.id, requiredGroups, existingGroups: existingGroups.sort(), needsUpdate: !assigned.enabled || requiredGroups.some((group) => !existingGroups.includes(group)) });
        plan.groupsToCreate.push(...requiredGroups.filter((group) => !identifiers.has(group)));
      }
      plan.groupsToCreate = [...new Set(plan.groupsToCreate)].sort();
      return plan;
    }, signal);
  }
  /** Call only after reviewing plan. Re-read assignments before applying so no existing group is lost. */
  async applyAppGroupAssignments(plan: AppleAppGroupPlan, signal?: AbortSignal): Promise<void> {
    if (plan.teamId !== this.team.id) throw new UserError('The App Group plan belongs to another Apple developer team.');
    return this.#use(async (expo, state) => {
      const groups = await expo.AppGroup.getAsync(state.context);
      const byIdentifier = new Map(groups.map((group) => [group.attributes.identifier, group]));
      const requirements = plan.assignments.flatMap((assignment) => assignment.requiredGroups);
      for (const identifier of [...new Set(requirements)]) {
        if (!/^group\.[A-Za-z0-9][A-Za-z0-9.-]+$/.test(identifier)) throw new UserError('Invalid App Group identifier in the reviewed plan.');
        if (!byIdentifier.has(identifier)) {
          if (!plan.groupsToCreate.includes(identifier)) throw new UserError(`App Group ${identifier} changed after planning. Review the plan again.`);
          byIdentifier.set(identifier, await expo.AppGroup.createAsync(state.context, { identifier, name: identifier }));
        }
      }
      for (const assignment of plan.assignments) {
        const bundle = await expo.BundleId.findAsync(state.context, { identifier: assignment.bundleIdentifier });
        if (!bundle || bundle.id !== assignment.bundleId || bundle.attributes.identifier !== assignment.bundleIdentifier) throw new UserError(`The App ID ${assignment.bundleIdentifier} changed after planning.`);
        const before = await appGroupsOf(expo, state.context, bundle.id);
        // The update sets the App ID's whole list: keep every group it has, add the ones needed.
        const ids = new Set(before.groups.map((group) => group.id));
        for (const identifier of assignment.requiredGroups) ids.add(byIdentifier.get(identifier)!.id);
        if (before.enabled && ids.size === before.groups.length) continue;
        await bundle.updateBundleIdCapabilityAsync({ capabilityType: expo.CapabilityType.APP_GROUP, option: expo.CapabilityTypeOption.ON, relationships: { appGroups: [...ids] } });
        // Apple can take a moment to show a change it accepted.
        let missing = [...ids];
        for (let attempt = 0; attempt < 3 && missing.length; attempt++) {
          if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500));
          throwIfAborted(signal);
          const after = new Set((await appGroupsOf(expo, state.context, bundle.id)).groups.map((group) => group.id));
          missing = [...ids].filter((id) => !after.has(id));
        }
        if (missing.length) throw new UserError(`Apple did not confirm all App Group assignments for ${assignment.bundleIdentifier}.`);
      }
    }, signal);
  }
}

/**
 * The app groups an App ID has. Apple sends them only when asked to include
 * them: a plain lookup (BundleId.findAsync, hasCapabilityAsync) leaves them out.
 */
async function appGroupsOf(expo: Expo, context: AppleRequestContext, bundleId: string): Promise<{ enabled: boolean; groups: { id: string; identifier: string }[] }> {
  const info = await expo.BundleId.infoAsync(context, { id: bundleId, query: { includes: ['bundleIdCapabilities', 'bundleIdCapabilities.appGroups'] } });
  const capability = (info.attributes.bundleIdCapabilities ?? []).find((item) => item?.isType(expo.CapabilityType.APP_GROUP));
  const groups = (capability?.attributes.appGroups ?? []).filter((group) => group?.id).map((group) => ({ id: group.id, identifier: group.attributes.identifier }));
  return { enabled: !!capability, groups };
}
