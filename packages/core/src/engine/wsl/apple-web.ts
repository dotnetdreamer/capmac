/**
 * Apple's developer website, in a browser CapMac drives. Some Apple ID sign-ins
 * can't make a development certificate over Apple's API (it answers 421) while
 * the website makes one fine. The developer signs in once, in a normal window of
 * their own browser; CapMac keeps that sign-in (protected for this Windows user),
 * closes the window and does the rest in a hidden copy of the browser. Passwords
 * never pass through CapMac, and the browser runs on its own CapMac profile,
 * apart from the developer's everyday one.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { log, throwIfAborted, type EngineContext } from '../context.js';
import { CancelledError, UserError } from '../errors.js';
import { loginAppleAccountWithCookies, type AppleAccountSession } from './apple-account.js';
import { prepareAppleSigningDirectory } from './apple-signing.js';
import { dpapi } from './protect.js';

const exec = promisify(execFile);
const APPLE_SITE = 'https://developer.apple.com';
const SAVED = 'sign-in.dpapi';
const LIMIT_HINT = 'Apple allows only a few development certificates per person. Revoke one you no longer use at developer.apple.com/account/resources/certificates, then run setup again.';

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new CancelledError());
  const done = () => { signal?.removeEventListener('abort', stop); resolve(); };
  const timer = setTimeout(done, ms);
  const stop = () => { clearTimeout(timer); reject(new CancelledError()); };
  signal?.addEventListener('abort', stop, { once: true });
});

// ---------------------------------------------------------------------------
// Which browser: the developer's default when CapMac can drive it (Chromium
// browsers speak the DevTools protocol), else Edge, which Windows always has.

export interface WebBrowser { name: string; exe: string; /** Names its CapMac profile folder. */ key: string }

const CHROMIUM: Record<string, string> = { 'msedge.exe': 'Microsoft Edge', 'chrome.exe': 'Google Chrome', 'brave.exe': 'Brave', 'vivaldi.exe': 'Vivaldi', 'chromium.exe': 'Chromium' };

/** The program a registry command starts, from `"C:\…\brave.exe" --single-argument %1`. */
export function commandProgram(command: string): string | undefined {
  const expanded = command.replace(/%([^%\s]+)%/g, (whole, name: string) => process.env[name] ?? whole);
  const match = /^\s*(?:"([^"]+)"|(\S+))/.exec(expanded);
  return match?.[1] ?? match?.[2];
}

export function chromiumBrowser(exe: string): WebBrowser | undefined {
  const file = path.win32.basename(exe).toLowerCase();
  const name = CHROMIUM[file];
  return name ? { name, exe, key: file.replace(/\.exe$/, '') } : undefined;
}

/** One registry value; without a name, the key's default value. */
async function registryValue(key: string, name?: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('reg.exe', ['query', key, ...(name ? ['/v', name] : ['/ve'])], { windowsHide: true, timeout: 10_000 });
    const line = stdout.split(/\r?\n/).find((item) => /\sREG_(?:EXPAND_)?SZ\s/.test(item));
    return line?.replace(/^.*?\sREG_(?:EXPAND_)?SZ\s+/, '').trim() || undefined;
  } catch { return undefined; }
}

function installedBrowsers(): string[] {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((root): root is string => !!root);
  return [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe'], ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']]
    .flatMap((parts) => roots.map((root) => path.win32.join(root, ...parts)));
}

/** The browser CapMac opens Apple's website in, or undefined when there is none it can drive. */
export async function findWebBrowser(): Promise<WebBrowser | undefined> {
  const chosen = process.env.CAPMAC_BROWSER;
  if (chosen) return existsSync(chosen) ? chromiumBrowser(chosen) ?? { name: path.win32.basename(chosen, '.exe'), exe: chosen, key: 'browser' } : undefined;
  if (process.platform !== 'win32') return undefined;
  const progId = await registryValue('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId');
  if (progId && /^[\w.-]+$/.test(progId)) {
    const exe = commandProgram(await registryValue(`HKCR\\${progId}\\shell\\open\\command`) ?? '');
    const browser = exe ? chromiumBrowser(exe) : undefined;
    if (browser && existsSync(browser.exe)) return browser;
  }
  const exe = installedBrowsers().find((file) => existsSync(file));
  return exe ? chromiumBrowser(exe) : undefined;
}

// ---------------------------------------------------------------------------
// The DevTools protocol over the pipe a browser opens with --remote-debugging-pipe:
// no network port, so no other program on this PC can reach the signed-in browser.

interface Message { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string }; sessionId?: string }

export class BrowserClosed extends Error {
  constructor() { super('The browser closed.'); }
}

class DevTools {
  #next = 0;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #listeners = new Set<(message: Message) => void>();
  #closed = false;
  constructor(private readonly input: Writable, output: Readable) {
    let buffer = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: Message;
        try { message = JSON.parse(text) as Message; } catch { continue; }
        const waiting = message.id === undefined ? undefined : this.#pending.get(message.id);
        if (!waiting) { for (const listener of this.#listeners) listener(message); continue; }
        this.#pending.delete(message.id!);
        if (message.error) waiting.reject(new Error(message.error.message ?? 'The browser refused a request.'));
        else waiting.resolve(message.result);
      }
    });
    const end = () => {
      this.#closed = true;
      for (const waiting of this.#pending.values()) waiting.reject(new BrowserClosed());
      this.#pending.clear();
    };
    output.on('close', end);
    output.on('error', end);
    input.on('error', () => undefined);
  }
  send<T>(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.#closed) return Promise.reject(new BrowserClosed());
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`The browser did not answer (${method}).`)); }, timeoutMs);
      this.#pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value as T); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  on(listener: (message: Message) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}

// ---------------------------------------------------------------------------
// One browser with one tab: shown for signing in, hidden for everything else.

export interface WebCookie {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; session: boolean; sameSite?: string; priority?: string;
}
const isApple = (domain: string) => { const host = domain.replace(/^\./, '').toLowerCase(); return host === 'apple.com' || host.endsWith('.apple.com'); };
const cookieKey = (cookie: WebCookie) => `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
function validCookie(value: unknown): value is WebCookie {
  const cookie = value as WebCookie;
  return !!cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string' && typeof cookie.domain === 'string' && typeof cookie.path === 'string' && isApple(cookie.domain);
}

/** Browsers CapMac started; none outlives it. */
const running = new Set<ChildProcess>();
let exitHook = false;
function track(child: ChildProcess): void {
  running.add(child);
  child.once('exit', () => running.delete(child));
  if (exitHook) return;
  exitHook = true;
  process.once('exit', () => { for (const item of running) item.kill(); });
}

/** A CapMac browser left running by a CapMac that was stopped hard holds the profile: end it. Only CapMac's profile. */
async function stopLeftovers(profile: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const script = "$p=[Console]::In.ReadToEnd().Trim(); Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=' + $p) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  await new Promise<void>((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
    child.stdin.end(profile);
  });
}

export interface PageEvent { method: string; params: Record<string, unknown> }

export class WebPage {
  readonly exited: Promise<void>;
  /** The browser quit, or its tab was closed. */
  readonly closed: Promise<void>;
  private constructor(private readonly child: ChildProcess, private readonly devtools: DevTools, private readonly session: string, readonly browser: WebBrowser) {
    this.exited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve()));
    const detached = new Promise<void>((resolve) => {
      const off = devtools.on((message) => { if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId === session) { off(); resolve(); } });
    });
    this.closed = Promise.race([this.exited, detached]);
  }

  static async launch(browser: WebBrowser, profile: string, visible: boolean): Promise<WebPage> {
    await fs.mkdir(profile, { recursive: true });
    try { return await WebPage.#start(browser, profile, visible); }
    catch (error) {
      if (!(error instanceof BrowserClosed)) throw error;
      // It handed its work to a browser already running on this profile and quit.
      await stopLeftovers(profile);
      try { return await WebPage.#start(browser, profile, visible); }
      catch (again) { throw again instanceof BrowserClosed ? new UserError(`${browser.name} closed as soon as it started.`, `Close any ${browser.name} window CapMac opened, then try again.`) : again; }
    }
  }

  static async #start(browser: WebBrowser, profile: string, visible: boolean): Promise<WebPage> {
    const args = [
      `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
      // Hidden, the browser doesn't call itself automated. (A window would show this flag in a warning bar: see below.)
      ...visible ? ['--new-window', '--window-size=1100,900'] : ['--headless=new', '--disable-blink-features=AutomationControlled', '--window-size=1280,900', '--mute-audio', '--hide-scrollbars'],
      'about:blank',
    ];
    const child = spawn(browser.exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: !visible });
    track(child);
    const devtools = new DevTools(child.stdio[3] as Writable, child.stdio[4] as Readable);
    const started = new Promise<never>((_, reject) => child.once('error', (error) => reject(new UserError(`CapMac could not start ${browser.name}.`, 'Make the certificate yourself on Apple’s website instead.', [error.message]))));
    started.catch(() => undefined);
    try {
      const version = await Promise.race([devtools.send<{ userAgent: string }>('Browser.getVersion', {}, undefined, 30_000), started]);
      // A window's first tab shows up a moment after the browser answers; a hidden browser has none.
      let pages: { targetId: string; type: string }[] = [];
      for (let waited = 0; ; waited += 100) {
        const { targetInfos } = await devtools.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
        pages = targetInfos.filter((target) => target.type === 'page');
        if (pages.length || !visible || waited >= 5_000) break;
        await sleep(100);
      }
      const targetId = pages[0]?.targetId ?? (await devtools.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
      // Only CapMac's tab: a browser's own welcome tabs would only confuse.
      for (const extra of pages.slice(1)) await devtools.send('Target.closeTarget', { targetId: extra.targetId }).catch(() => undefined);
      const { sessionId } = await devtools.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      await devtools.send('Page.enable', {}, sessionId);
      // Apple's sign-in sees an ordinary browser, as it is: a person signs in. Pages read
      // navigator.webdriver from the prototype, where an ordinary browser answers false.
      if (visible) await devtools.send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });" }, sessionId);
      // The hidden browser presents itself as the browser the developer signed in with.
      else await devtools.send('Emulation.setUserAgentOverride', { userAgent: version.userAgent.replace(/HeadlessChrome/g, 'Chrome') }, sessionId);
      return new WebPage(child, devtools, sessionId, browser);
    } catch (error) {
      child.kill();
      if (error instanceof UserError || error instanceof BrowserClosed) throw error;
      throw new UserError(`CapMac could not control ${browser.name}.`, 'Make the certificate yourself on Apple’s website instead.', [(error as Error).message]);
    }
  }

  #send<T>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
    return this.devtools.send<T>(method, params, this.session, timeoutMs);
  }

  /** Events of this tab. */
  on(listener: (event: PageEvent) => void): () => void {
    return this.devtools.on((message) => { if (message.sessionId === this.session && message.method) listener({ method: message.method, params: message.params ?? {} }); });
  }

  /** Opens `url` and waits for it (and its redirects) to load. Resolves with where it ended. */
  async goto(url: string, timeoutMs = 60_000): Promise<URL> {
    let stop = () => undefined as void;
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new UserError('Apple’s website took too long to open.', 'Check the internet connection, then try again.')); }, timeoutMs);
      const off = this.on((event) => { if (event.method === 'Page.loadEventFired') { stop(); resolve(); } });
      stop = () => { clearTimeout(timer); off(); };
    });
    loaded.catch(() => undefined);
    const result = await this.#send<{ errorText?: string }>('Page.navigate', { url }).catch((error) => { stop(); throw error; });
    if (result.errorText) { stop(); throw new UserError('Apple’s website didn’t open in the browser.', 'Check the internet connection, then try again.', [result.errorText]); }
    await loaded;
    return this.url();
  }

  /** Runs `expression` in the page (promises awaited) and returns its JSON value. */
  async evaluate<T>(expression: string, timeoutMs = 30_000): Promise<T> {
    const reply = await this.#send<{ result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeoutMs);
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'The page script failed.');
    return reply.result.value as T;
  }

  async url(): Promise<URL> {
    return new URL(await this.evaluate<string>('location.href'));
  }

  /** Asks `expression` again until it answers something truthy, or the time is up (undefined). */
  async waitFor<T>(expression: string, timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      throwIfAborted(signal);
      // While the page navigates, its scripts can't run: ask again.
      const value = await this.evaluate<T>(expression, 15_000).catch((error: unknown) => { if (error instanceof BrowserClosed) throw error; return undefined; });
      if (value) return value;
      if (Date.now() > until) return undefined;
      await sleep(300, signal);
    }
  }

  /** The browser's cookies for apple.com. */
  async cookies(): Promise<WebCookie[]> {
    const { cookies } = await this.devtools.send<{ cookies: WebCookie[] }>('Storage.getCookies');
    return cookies.filter((cookie) => isApple(cookie.domain));
  }

  /** Puts back the saved cookies the profile doesn't have, such as the sign-in's session cookies. */
  async restore(saved: WebCookie[]): Promise<void> {
    if (!saved.length) return;
    const have = new Set((await this.cookies()).map(cookieKey));
    const missing = saved.filter((cookie) => !have.has(cookieKey(cookie)));
    if (!missing.length) return;
    await this.devtools.send('Storage.setCookies', { cookies: missing.map((cookie) => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
      ...cookie.sameSite ? { sameSite: cookie.sameSite } : {}, ...cookie.priority ? { priority: cookie.priority } : {},
      ...!cookie.session && cookie.expires > 0 ? { expires: cookie.expires } : {},
    })) });
  }

  /** Clicks where a person would: real mouse events at a point of the page. */
  async click(point: { x: number; y: number }): Promise<void> {
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  /** Gives the page's file field a file, as choosing it in the file dialog would. */
  async chooseFile(selector: string, file: string): Promise<boolean> {
    const { result } = await this.#send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
    if (!result.objectId) return false;
    await this.#send('DOM.enable');
    await this.#send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId });
    return true;
  }

  async enableNetwork(): Promise<void> {
    await this.#send('Network.enable');
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.#send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, 15_000);
    return Buffer.from(data, 'base64');
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await this.devtools.send('Browser.close', {}, undefined, 5_000).catch(() => undefined);
    if (await Promise.race([this.exited.then(() => true), sleep(5_000).then(() => false)])) return;
    this.child.kill();
    await Promise.race([this.exited, sleep(3_000)]);
  }
}

// ---------------------------------------------------------------------------
// The saved sign-in: the browser's apple.com cookies, protected for this Windows
// user (the profile alone would lose the sign-in's session cookies on restart).

export interface AppleWebOptions {
  /** Where CapMac keeps the sign-in and its browser profiles (tests). */
  root?: string;
  browser?: WebBrowser;
  /** Apple's developer site; tests point it at a stand-in. */
  site?: string;
}

const webRoot = (root?: string) => root ?? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'CapMac', 'AppleWeb');
const profileOf = (root: string, browser: WebBrowser) => path.join(root, 'Profiles', browser.key);

/** Whether CapMac keeps a sign-in to Apple's website. */
export function hasAppleWebSignIn(options: AppleWebOptions = {}): boolean {
  return existsSync(path.join(webRoot(options.root), SAVED));
}

/** Forgets the sign-in to Apple's website: the saved cookies and CapMac's browser profiles. */
export async function forgetAppleWebSignIn(options: AppleWebOptions = {}): Promise<void> {
  const root = webRoot(options.root);
  await fs.rm(path.join(root, SAVED), { force: true });
  await fs.rm(path.join(root, 'Profiles'), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

async function loadSignIn(root: string): Promise<WebCookie[]> {
  try {
    const sealed = Buffer.from((await fs.readFile(path.join(root, SAVED), 'utf8')).trim(), 'base64');
    const saved = JSON.parse((await dpapi('Unprotect', sealed)).toString('utf8')) as { cookies?: unknown[] };
    return (saved.cookies ?? []).filter(validCookie);
  } catch {
    // Missing or unreadable (another Windows user's): as good as none.
    return [];
  }
}

async function saveSignIn(root: string, cookies: WebCookie[]): Promise<void> {
  if (!cookies.length) return;
  const file = path.join(root, SAVED);
  const temporary = `${file}.${process.pid}.new`;
  const sealed = await dpapi('Protect', Buffer.from(JSON.stringify({ savedAt: new Date().toISOString(), cookies }), 'utf8'));
  await fs.writeFile(temporary, sealed.toString('base64'));
  await fs.rename(temporary, file);
}

// ---------------------------------------------------------------------------
// Signing in: hidden with the saved sign-in when it still works, else in a
// window the developer sees, with a question CapMac takes back once they are in.

/** The developer stopped: nothing more to try or ask. */
export class AppleWebStopped extends UserError {}

/** One go at Apple's website: where things are, who for, and what happened (for the notes). */
interface Run {
  root: string;
  browser: WebBrowser;
  site: { account: string; add: string; host: string };
  /** Not known yet when this is the setup's sign-in. */
  team?: { id: string; name: string };
  ctx: EngineContext;
  signal?: AbortSignal;
  notes: string[];
  /** What setup says when the developer stops at the sign-in window. */
  stopped: { message: string; hint: string };
}

const CERTIFICATE_STOPPED = { message: 'Signing is waiting for your certificate from Apple’s website.', hint: 'Run setup again when you are ready. CapMac keeps its request, so the certificate still fits.' };
const SIGN_IN_STOPPED = { message: 'Signing in to Apple was stopped.', hint: 'Run setup again when you are ready.' };

const siteOf = (base: string): Run['site'] => ({ account: `${base}/account/resources/certificates/list`, add: `${base}/account/resources/certificates/add`, host: new URL(base).hostname });

type SignInState = { ok: true } | { ok: false; why: 'signed-out' } | { ok: false; why: 'refused'; details: string[] };

/** Asks Apple's API the way the website itself does: a POST standing in for a GET, with the team named. */
const PROBE = (teamId: string) => `(async () => {
  const response = await fetch('/services-account/v1/certificates', { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/vnd.api+json', 'X-Requested-With': 'XMLHttpRequest', 'X-HTTP-Method-Override': 'GET', Accept: 'application/vnd.api+json, application/json, text/plain, */*' },
    body: JSON.stringify({ urlEncodedQueryParams: 'limit=1', teamId: ${JSON.stringify(teamId)} }) });
  return { status: response.status, csrf: response.headers.get('csrf'), csrfTs: response.headers.get('csrf_ts'), body: (await response.text()).slice(0, 4000) };
})()`;
interface Answer { status: number; body: string; csrf?: string | null; csrfTs?: string | null }

/** What Apple said, from its JSON:API errors (never cookies or tokens). */
function appleSaid(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { errors?: { code?: string; title?: string; detail?: string }[]; userString?: string; resultString?: string };
    const lines = (parsed.errors ?? []).slice(0, 3).map((error) => [error.code, error.title, error.detail].filter(Boolean).join(' · '));
    for (const text of [parsed.userString, parsed.resultString]) if (text) lines.push(text);
    return lines.map((line) => line.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 300)).filter(Boolean);
  } catch {
    const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? [text.slice(0, 200)] : [];
  }
}

async function signInState(page: WebPage, run: Run): Promise<SignInState> {
  const at = await page.goto(run.site.account);
  run.notes.push(`opened ${at.hostname}${at.pathname}`);
  if (at.hostname !== run.site.host || !at.pathname.startsWith('/account')) return { ok: false, why: 'signed-out' };
  // At the setup's sign-in no team is chosen yet: being let in is enough.
  if (!run.team) return { ok: true };
  const probe = await page.evaluate<Answer>(PROBE(run.team.id), 60_000);
  run.notes.push(`team check: HTTP ${probe.status}`);
  if (probe.status === 401) return { ok: false, why: 'signed-out' };
  if (probe.status !== 200) return { ok: false, why: 'refused', details: [`Apple answered HTTP ${probe.status}`, ...appleSaid(probe.body)] };
  return { ok: true };
}

const progress = (ctx: EngineContext, text: string) => ctx.emit({ type: 'tool-output', text, stream: 'stdout' });

/** Shows the browser until the developer has signed in; their cookies are then saved. */
async function signInWithWindow(run: Run): Promise<'signed-in' | 'restart'> {
  const { browser, ctx, signal } = run;
  const page = await WebPage.launch(browser, profileOf(run.root, browser), true);
  const asking = new AbortController();
  try {
    // Apple remembers a browser it trusts, so a sign-in saved earlier can spare the code.
    await page.restore(await loadSignIn(run.root));
    page.goto(run.site.account, 120_000).catch(() => undefined);
    progress(ctx, `Opened Apple’s website in ${browser.name}. Waiting for you to sign in…`);
    const outcome = await new Promise<'signed-in' | 'restart' | 'stop' | 'closed'>((resolve, reject) => {
      ctx.prompter.confirm({
        message: `Sign in to Apple in ${browser.name}`,
        detail: [
          `CapMac opened Apple’s website in a ${browser.name} window. Sign in there with ${run.team ? `the Apple Account of the team “${run.team.name}”` : 'your Apple developer account'}`,
          `Once you are in, CapMac closes the window and ${run.team ? 'makes the certificate' : 'carries on'}. You sign in only once: CapMac remembers it for this Windows account`,
          'Something wrong? Restart opens a fresh window with nothing saved',
        ].join('\n'),
        waiting: 'Waiting for you to sign in…',
        confirmLabel: 'Restart',
        cancelLabel: 'Cancel',
        defaultYes: false,
        signal: asking.signal,
      }).then((restart) => { if (!asking.signal.aborted) resolve(restart ? 'restart' : 'stop'); }, (error: unknown) => { if (!asking.signal.aborted) reject(error); });
      void page.closed.then(() => resolve('closed'));
      void page.waitFor<boolean>(`location.hostname === ${JSON.stringify(run.site.host)} && location.pathname.startsWith('/account')`, 30 * 60_000, signal)
        .then((inside) => resolve(inside ? 'signed-in' : 'stop'), (error: unknown) => (error instanceof BrowserClosed ? resolve('closed') : reject(error)));
    }).finally(() => asking.abort());
    run.notes.push(`sign-in window: ${outcome}`);
    if (outcome === 'restart') return 'restart';
    // Closing the window is the developer's way of saying "not now", like Cancel.
    if (outcome === 'stop' || outcome === 'closed') throw new AppleWebStopped(run.stopped.message, run.stopped.hint);
    // The account page sets the rest of the session's cookies as it loads.
    await page.waitFor<boolean>(`document.readyState === 'complete'`, 15_000, signal);
    await sleep(1500, signal);
    await saveSignIn(run.root, await page.cookies());
    log(ctx, 'info', 'Signed in to Apple’s website. CapMac remembers it for this Windows account.');
    return 'signed-in';
  } finally {
    asking.abort();
    await page.close();
  }
}

/** A hidden browser signed in to Apple's website for the team, after a sign-in in a window when needed. */
async function signedInPage(run: Run): Promise<WebPage> {
  const profile = profileOf(run.root, run.browser);
  let signedInNow = false;
  for (;;) {
    throwIfAborted(run.signal);
    const saved = await loadSignIn(run.root);
    // Nothing kept from an earlier sign-in: straight to the window.
    if (saved.length || existsSync(profile) || signedInNow) {
      progress(run.ctx, 'Opening Apple’s website in the background…');
      const page = await WebPage.launch(run.browser, profile, false);
      let state: SignInState;
      try {
        await page.restore(saved);
        state = await signInState(page, run);
      } catch (error) { await page.close(); throw error; }
      if (state.ok) return page;
      await page.close();
      if (state.why === 'refused') {
        throw new UserError(`Apple’s website turned down CapMac’s request for the team “${run.team?.name}”.`, 'If you signed in there with another Apple Account, try again with a fresh sign-in. Accept any new agreement Apple shows at developer.apple.com.', state.details);
      }
      if (signedInNow) throw new UserError('CapMac couldn’t use the sign-in from the browser window.', 'Try again with a fresh sign-in.');
    }
    const outcome = await signInWithWindow(run);
    if (outcome === 'restart') { await forgetAppleWebSignIn({ root: run.root }); signedInNow = false; continue; }
    signedInNow = true;
  }
}

// ---------------------------------------------------------------------------
// The certificate: first the way the website asks Apple's API, with the team
// named; when Apple refuses that too, through the website's own pages, as a
// person would click.

export interface AppleWebCertificateRequest {
  /** The certificate request (PEM), and the file that holds it. */
  csr: string;
  csrFile: string;
  team: { id: string; name: string };
  /** True for a certificate (DER) made from this request. */
  ours(certificate: Buffer): boolean;
  /** Forget the saved sign-in first. */
  fresh?: boolean;
}

/** A JSON:API create, as the website's pages send it: its CSRF token, the team in the body. */
const CREATE = (type: string, body: unknown, probe: Answer) => `(async () => {
  const response = await fetch(${JSON.stringify(`/services-account/v1/${type}`)}, { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/vnd.api+json', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/vnd.api+json, application/json, text/plain, */*'${probe.csrf ? `, csrf: ${JSON.stringify(probe.csrf)}, csrf_ts: ${JSON.stringify(probe.csrfTs ?? '')}` : ''} },
    body: ${JSON.stringify(JSON.stringify(body))} });
  return { status: response.status, body: (await response.text()).slice(0, 2000000) };
})()`;

const LIST = (teamId: string) => `(async () => {
  const response = await fetch('/services-account/v1/certificates', { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/vnd.api+json', 'X-Requested-With': 'XMLHttpRequest', 'X-HTTP-Method-Override': 'GET', Accept: 'application/vnd.api+json, application/json, text/plain, */*' },
    body: JSON.stringify({ urlEncodedQueryParams: new URLSearchParams({ 'filter[certificateType]': 'DEVELOPMENT', limit: '200' }).toString(), teamId: ${JSON.stringify(teamId)} }) });
  return { status: response.status, body: (await response.text()).slice(0, 2000000) };
})()`;

type Made = { certificate: Buffer; id: string };

/** The certificate in Apple's answer (one resource, or a list), when it is ours. */
function ourCertificate(body: string, ours: (certificate: Buffer) => boolean): Made | undefined {
  let parsed: { data?: unknown };
  try { parsed = JSON.parse(body) as { data?: unknown }; } catch { return undefined; }
  const items = (Array.isArray(parsed.data) ? parsed.data : [parsed.data]) as { id?: unknown; attributes?: { certificateContent?: unknown } }[];
  for (const item of items) {
    const content = item?.attributes?.certificateContent;
    if (typeof item?.id !== 'string' || typeof content !== 'string') continue;
    const certificate = Buffer.from(content, 'base64');
    if (ours(certificate)) return { certificate, id: item.id };
  }
  return undefined;
}

const limitReached = (lines: string[]) => lines.some((line) => /maximum|already have|limit/i.test(line));

async function createWithApi(page: WebPage, request: AppleWebCertificateRequest, run: Run): Promise<Made | string[]> {
  const probe = await page.evaluate<Answer>(PROBE(request.team.id), 60_000);
  const body = { data: { type: 'certificates', attributes: { certificateType: 'DEVELOPMENT', csrContent: request.csr, teamId: request.team.id } } };
  const made = await page.evaluate<Answer>(CREATE('certificates', body, probe), 120_000);
  const said = appleSaid(made.body);
  run.notes.push(`create (api): HTTP ${made.status}${said.length ? ` · ${said.join(' · ')}` : ''}`);
  if (made.status === 200 || made.status === 201) {
    // Apple made it: from its answer, or else from its list.
    const found = ourCertificate(made.body, request.ours) ?? await listed(page, request, run);
    if (found) return found;
    throw new UserError('Apple made a certificate that doesn’t fit CapMac’s request.', 'Try again. If it happens again, make the certificate yourself on Apple’s website.');
  }
  if (limitReached(said)) throw new UserError('Apple says you have all the development certificates you may have.', LIMIT_HINT, said);
  return [`Apple answered HTTP ${made.status} to v1/certificates`, ...said];
}

/** Finds an element by what it says and where to click it; scripts run in the page. */
const FIND = (kind: 'choice' | 'button', text: string) => `(() => {
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const shown = (element) => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const point = (element) => { element.scrollIntoView({ block: 'center' }); const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };
  const want = ${JSON.stringify(text)};
  if (${JSON.stringify(kind)} === 'choice') {
    // A radio button, or a control drawn as one (role=radio).
    for (const radio of document.querySelectorAll('input[type=radio], [role=radio]')) {
      const label = radio.matches('[role=radio]') ? radio : (radio.labels && radio.labels[0]) || radio.closest('label') || radio.parentElement;
      const words = norm(label && (label.textContent || label.getAttribute('aria-label')));
      if (words !== want && !words.startsWith(want + ' ')) continue;
      if (!shown(radio) && !shown(label)) continue;
      if (radio.checked || radio.getAttribute('aria-checked') === 'true') return { done: true };
      return point(shown(radio) ? radio : label);
    }
    return null;
  }
  const candidates = [...document.querySelectorAll('button, [role=button], a, input[type=submit]')].filter((element) => shown(element) && norm(element.textContent || element.value) === want);
  const ready = candidates.find((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true');
  return ready ? point(ready) : null;
})()`;

/** What the page shows: for the notes when a step can't find its way. */
const LOOK = `(() => {
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const labels = [...document.querySelectorAll('input[type=radio], [role=radio]')].map((radio) => norm(radio.matches('[role=radio]') ? radio.textContent : ((radio.labels && radio.labels[0]) || radio.closest('label') || radio.parentElement || {}).textContent));
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit]')].map((element) => norm(element.textContent || element.value)).filter(Boolean);
  const heading = norm((document.querySelector('h1, h2') || {}).textContent);
  return { path: location.pathname + location.search, heading, choices: labels.slice(0, 20), buttons: buttons.slice(0, 20), files: document.querySelectorAll('input[type=file]').length };
})()`;

async function createThroughPages(page: WebPage, request: AppleWebCertificateRequest, run: Run): Promise<Made> {
  const { ctx, signal, notes } = run;
  // The website's own requests name the team it works in: it has to be this one.
  const teams = new Set<string>();
  const stopWatching = page.on((event) => {
    if (event.method !== 'Network.requestWillBeSent') return;
    const sent = event.params.request as { url?: string; method?: string; postData?: string } | undefined;
    if (!sent?.url?.includes('/services-account/')) return;
    // Where the page's own requests go, for the notes: addresses only, never what they carry.
    if (notes.length < 80) notes.push(`page asked: ${sent.method ?? ''} ${new URL(sent.url).pathname}`);
    if (!sent.postData) return;
    try {
      const body = JSON.parse(sent.postData) as { teamId?: unknown; data?: { attributes?: { teamId?: unknown } } };
      for (const id of [body.teamId, body.data?.attributes?.teamId]) if (typeof id === 'string') teams.add(id);
    } catch { /* not JSON */ }
  });
  const look = async (what: string) => { notes.push(`${what}: ${JSON.stringify(await page.evaluate(LOOK).catch(() => null))}`); };
  const step = async (kind: 'choice' | 'button', text: string, what: string) => {
    const point = await page.waitFor<{ x: number; y: number; done?: boolean }>(FIND(kind, text), 30_000, signal);
    if (!point) { await look(`no ${kind} “${text}”`); throw new UserError(`CapMac couldn’t find “${text}” on Apple’s website (${what}).`, 'Apple may have changed its website. Make the certificate yourself on Apple’s website this time.'); }
    if (!point.done) await page.click(point);
    notes.push(`clicked “${text}”`);
  };
  try {
    await page.enableNetwork();
    progress(ctx, 'Opening the certificate page on Apple’s website…');
    await page.goto(run.site.add);
    // Once the choices show, the page has asked Apple for what it needs.
    await page.waitFor(FIND('choice', 'Apple Development'), 30_000, signal);
    notes.push(`teams seen: ${[...teams].join(', ') || 'none'}`);
    if (!teams.size) {
      await look('team');
      throw new UserError('CapMac couldn’t check which team Apple’s website is working in.', 'Make the certificate yourself on Apple’s website this time.');
    }
    if (![...teams].includes(request.team.id)) {
      await look('team');
      throw new UserError(`Apple’s website is working in another team, not “${request.team.name}”.`, `Try again with a fresh sign-in, and choose the team “${request.team.name}” on Apple’s website if it asks.`);
    }
    await step('choice', 'Apple Development', 'the certificate type');
    await step('button', 'Continue', 'after the certificate type');
    // The upload comes next, usually on a page of its own.
    await page.waitFor<boolean>(`!${FIND('choice', 'Apple Development')}`, 15_000, signal);
    const file = await page.waitFor<boolean>(`document.querySelectorAll('input[type=file]').length > 0`, 30_000, signal);
    if (!file || !await page.chooseFile('input[type=file]', request.csrFile)) { await look('upload'); throw new UserError('CapMac couldn’t find where to upload its request on Apple’s website.', 'Apple may have changed its website. Make the certificate yourself on Apple’s website this time.'); }
    notes.push('chose the request file');
    progress(ctx, 'Uploading CapMac’s certificate request…');
    await step('button', 'Continue', 'after the upload');
    // Apple shows the new certificate with a Download button.
    const shown = await page.waitFor<boolean>(`[...document.querySelectorAll('button, a, [role=button]')].some((element) => (element.textContent || '').trim() === 'Download')`, 60_000, signal);
    if (!shown) await look('after the upload');
    const found = await listed(page, request, run);
    if (found) return found;
    throw new UserError('Apple’s website didn’t make the certificate.', 'Make the certificate yourself on Apple’s website this time.');
  } finally { stopWatching(); }
}

/** Our certificate in Apple's list; it can take Apple a moment to list a new one. */
async function listed(page: WebPage, request: AppleWebCertificateRequest, run: Run): Promise<Made | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(2000, run.signal);
    const answer = await page.evaluate<Answer>(LIST(request.team.id), 60_000);
    run.notes.push(`list: HTTP ${answer.status}`);
    const found = answer.status === 200 ? ourCertificate(answer.body, request.ours) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** Notes and a picture of the page for when something goes wrong, kept on this PC only. */
async function keepNotes(run: Run, page: WebPage | undefined, error: unknown): Promise<string | undefined> {
  try {
    const folder = path.join(run.root, 'last-attempt');
    await fs.rm(folder, { recursive: true, force: true });
    await fs.mkdir(folder, { recursive: true });
    const said = error instanceof UserError ? [error.message, ...(error.details ?? [])] : [String((error as Error)?.message ?? error)];
    await fs.writeFile(path.join(folder, 'notes.txt'), [`${new Date().toISOString()}`, ...run.notes, '', ...said].join('\n') + '\n');
    // Only Apple's developer pages, never its sign-in page.
    if (page && (await page.url().catch(() => undefined))?.hostname === run.site.host) await fs.writeFile(path.join(folder, 'page.png'), await page.screenshot());
    return folder;
  } catch { return undefined; }
}

/** The error setup shows for a go at Apple's website that failed, pointing at its notes. Stops pass through. */
async function explained(run: Run, page: WebPage | undefined, error: unknown): Promise<unknown> {
  if (error instanceof CancelledError || run.signal?.aborted || error instanceof AppleWebStopped) return run.signal?.aborted ? new CancelledError() : error;
  const folder = await keepNotes(run, page, error);
  const where = folder ? [`What CapMac saw is in ${folder}`] : [];
  if (error instanceof UserError) return new UserError(error.message, error.hint, [...(error.details ?? []), ...where]);
  if (error instanceof BrowserClosed) return new UserError(`${run.browser.name} closed while CapMac was working on Apple’s website.`, 'Try again.', where);
  return new UserError('Something went wrong on Apple’s website.', 'Try again, or do it yourself on Apple’s website.', [String((error as Error)?.message ?? error).slice(0, 300), ...where]);
}

/**
 * Apple's developer website for one team, signed in and hidden. It makes what
 * Apple's API refuses CapMac's own client (certificates, profiles, devices and
 * new App IDs answer 421 there) the way the website's pages ask for them.
 */
export class AppleWebsite {
  private constructor(private readonly page: WebPage, private readonly run: Run & { team: { id: string; name: string } }) {}

  static async open(team: { id: string; name: string }, ctx: EngineContext, signal?: AbortSignal, options: AppleWebOptions & { fresh?: boolean } = {}): Promise<AppleWebsite> {
    const browser = options.browser ?? await findWebBrowser();
    if (!browser) throw new UserError('CapMac needs Microsoft Edge, Google Chrome or Brave to do this.', 'Run setup again and choose “Do it myself”.');
    const root = await prepareAppleSigningDirectory(webRoot(options.root));
    if (options.fresh) await forgetAppleWebSignIn({ root });
    const run = { root, browser, site: siteOf(options.site ?? APPLE_SITE), team, ctx, signal, notes: [`browser: ${browser.name}`], stopped: CERTIFICATE_STOPPED };
    try { return new AppleWebsite(await signedInPage(run), run); }
    catch (error) { throw await explained(run, undefined, error); }
  }

  /** A failure comes back with what CapMac saw on the page. */
  async #doing<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { throw await explained(this.run, this.page, error); }
  }

  /** An Apple Development certificate for `request` (DER), with Apple's id for it. */
  certificate(request: AppleWebCertificateRequest): Promise<Made> {
    return this.#doing(async () => {
      progress(this.run.ctx, 'Making the certificate on Apple’s website…');
      const viaApi = await createWithApi(this.page, request, this.run);
      const made = Array.isArray(viaApi) ? await createThroughPages(this.page, request, this.run) : viaApi;
      log(this.run.ctx, 'success', 'Apple made the certificate on its website.');
      return made;
    });
  }

  /** Adds an App ID (explicit, iOS) to the team; Apple's id for it. */
  bundleId(app: { name: string; identifier: string }): Promise<string> {
    return this.#doing(async () => (await this.#create('bundleIds', { name: app.name, identifier: app.identifier, platform: 'IOS' })).id);
  }

  /** Registers an iPhone with the team; Apple's id for it. */
  device(device: { name: string; udid: string }): Promise<string> {
    return this.#doing(async () => (await this.#create('devices', { name: device.name, udid: device.udid, platform: 'IOS' })).id);
  }

  /** A development profile for an App ID, the certificate and the iPhones; its content is base64. */
  profile(profile: { name: string; bundleId: string; certificateId: string; deviceIds: string[] }): Promise<{ id: string; content: string }> {
    return this.#doing(async () => {
      const made = await this.#create('profiles', { name: profile.name, profileType: 'IOS_APP_DEVELOPMENT' }, {
        bundleId: { data: { type: 'bundleIds', id: profile.bundleId } },
        certificates: { data: [{ type: 'certificates', id: profile.certificateId }] },
        devices: { data: profile.deviceIds.map((id) => ({ type: 'devices', id })) },
      });
      const content = made.attributes.profileContent;
      if (typeof content !== 'string') throw new UserError('Apple made the profile but didn’t send it.', 'Run setup again.');
      return { id: made.id, content };
    });
  }

  async #create(type: string, attributes: Record<string, unknown>, relationships?: Record<string, unknown>): Promise<{ id: string; attributes: Record<string, unknown> }> {
    const team = this.run.team.id;
    const probe = await this.page.evaluate<Answer>(PROBE(team), 60_000);
    const body = { data: { type, attributes: { ...attributes, teamId: team }, ...relationships ? { relationships } : {} } };
    const made = await this.page.evaluate<Answer>(CREATE(type, body, probe), 120_000);
    const said = appleSaid(made.body);
    this.run.notes.push(`create ${type}: HTTP ${made.status}${said.length ? ` · ${said.join(' · ')}` : ''}`);
    if (made.status !== 200 && made.status !== 201) throw new UserError('Apple’s website turned the request down.', undefined, [`Apple answered HTTP ${made.status} to v1/${type}`, ...said]);
    const data = (JSON.parse(made.body) as { data?: { id?: unknown; attributes?: Record<string, unknown> } }).data;
    if (typeof data?.id !== 'string') throw new UserError('Apple’s website answered without what it made.');
    return { id: data.id, attributes: data.attributes ?? {} };
  }

  /** Keeps the sign-in fresh for next time and closes the hidden browser. */
  async close(): Promise<void> {
    await saveSignIn(this.run.root, await this.page.cookies()).catch(() => undefined);
    await this.page.close();
  }
}

/**
 * Makes an Apple Development certificate for `request` on Apple's website and
 * returns it (DER) with Apple's id for it.
 */
export async function makeCertificateOnAppleWeb(request: AppleWebCertificateRequest, ctx: EngineContext, signal?: AbortSignal, options: AppleWebOptions = {}): Promise<Made> {
  const website = await AppleWebsite.open(request.team, ctx, signal, { ...options, fresh: request.fresh });
  try { return await website.certificate(request); }
  finally { await website.close(); }
}

/** App Store Connect, where apple-utils checks a session, sets cookies of its own when visited. */
const APP_STORE_CONNECT_SESSION = 'https://appstoreconnect.apple.com/olympus/v1/session';

/**
 * Setup's Apple sign-in on Apple's website: the developer signs in once in their
 * browser (later, not at all while the saved sign-in works), and CapMac's Apple
 * session is made from that browser's cookies. The password never reaches CapMac.
 */
export async function signInOnAppleWebsite(ctx: EngineContext, options: AppleWebOptions & { signal?: AbortSignal; fresh?: boolean } = {}): Promise<AppleAccountSession> {
  const browser = options.browser ?? await findWebBrowser();
  if (!browser) throw new UserError('CapMac needs Microsoft Edge, Google Chrome or Brave to sign in on Apple’s website.', 'Run setup again and choose “Do it myself” to sign in here in CapMac.');
  const root = await prepareAppleSigningDirectory(webRoot(options.root));
  if (options.fresh) await forgetAppleWebSignIn({ root });
  const base = options.site ?? APPLE_SITE;
  const run: Run = { root, browser, site: siteOf(base), ctx, signal: options.signal, notes: [`browser: ${browser.name}`, 'for: the sign-in'], stopped: SIGN_IN_STOPPED };
  let cookies: WebCookie[];
  let page: WebPage | undefined;
  try {
    page = await signedInPage(run);
    if (base === APPLE_SITE) await page.goto(APP_STORE_CONNECT_SESSION).catch(() => undefined);
    cookies = await page.cookies();
    await saveSignIn(root, cookies);
  } catch (error) {
    throw await explained(run, page, error);
  } finally {
    await page?.close();
  }
  progress(ctx, 'Signed in on Apple’s website. Reading your developer teams…');
  const session = await loginAppleAccountWithCookies(ctx, cookies, { signal: options.signal });
  if (session) return session;
  throw new UserError('Apple didn’t accept the sign-in from its website here.', 'Run setup again and choose “Let CapMac do it with a fresh sign-in”, or “Do it myself” to sign in here in CapMac.');
}

export type AppleSignInChoice = { way: 'password' } | { way: 'website'; fresh: boolean };

/**
 * Setup asks first how to sign in to Apple: on Apple's website, after which CapMac
 * does everything (the certificate Apple's API won't make too), or here in CapMac
 * with a password, making that certificate by hand on the website when needed.
 * Without a browser CapMac can drive there's nothing to ask.
 */
export async function chooseAppleSignIn(ctx: EngineContext, options: AppleWebOptions = {}): Promise<AppleSignInChoice> {
  const browser = options.browser ?? await findWebBrowser().catch(() => undefined);
  if (!browser) return { way: 'password' };
  const saved = hasAppleWebSignIn(options);
  const way = await ctx.prompter.choose<'web' | 'web-fresh' | 'password'>({
    message: 'Sign in to Apple',
    detail: 'CapMac needs your Apple developer account to sign your app. Who should do the Apple part?',
    items: [
      { label: 'Let CapMac do it (recommended)', value: 'web', hint: saved ? 'Uses your saved sign-in to Apple’s website. Nothing to type' : `Sign in once on Apple’s website in ${browser.name}. CapMac remembers it and does the rest, the certificate too` },
      ...saved ? [{ label: 'Let CapMac do it with a fresh sign-in', value: 'web-fresh' as const, hint: 'Forgets the saved sign-in, then you sign in to Apple again' }] : [],
      { label: 'Do it myself', value: 'password', hint: 'Sign in here in CapMac. You may need to make the certificate yourself on Apple’s website' },
    ],
  });
  return way === 'password' ? { way } : { way: 'website', fresh: way === 'web-fresh' };
}

/** What signing setup uses; tests pass their own. */
export const appleWeb = {
  findBrowser: findWebBrowser,
  hasSignIn: hasAppleWebSignIn,
  makeCertificate: makeCertificateOnAppleWeb,
  open: (team: { id: string; name: string }, ctx: EngineContext, signal?: AbortSignal): Promise<Pick<AppleWebsite, 'bundleId' | 'device' | 'profile' | 'close'>> => AppleWebsite.open(team, ctx, signal),
};
export type AppleWeb = typeof appleWeb;
