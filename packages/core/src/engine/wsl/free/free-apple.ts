/**
 * Drives the free Apple Account backend (apple-free.py) from TypeScript: one long
 * running CapMac-Python process that signs in with the developer's free Apple ID
 * and makes a development certificate and 7-day profiles. The protocol is one
 * JSON object per line (see apple-free.py); this class turns it into `login` and
 * `provision` calls and relays the two-factor prompt through CapMac's prompter.
 *
 * The helper is written to a temporary file and run by path: it is far larger
 * than a Windows command line can carry, so it can't go through `python -c`.
 * Nothing here implements Apple's sign-in itself; that lives in the Python backend.
 */
import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { throwIfAborted } from '../../context.js';
import { CancelledError, UserError } from '../../errors.js';
import { deviceHelperCommand } from '../device.js';
import runnerScript from './apple-free.py';

export interface FreeTeam {
  id: string;
  name: string;
  /** False once the team is in the paid Apple Developer Program. */
  free: boolean;
  status?: string;
}
export interface FreeLoginResult {
  teams: FreeTeam[];
  /** When the Xcode sign-in token expires (ms since the epoch); after this, sign in again. */
  expiry: number;
}
export interface FreeProvisionTarget {
  bundleIdentifier: string;
  /** App ID capability types a free account supports, already filtered by the caller. */
  capabilities: string[];
  /** App group identifiers the app and its extensions share (free accounts allow these). */
  appGroups?: string[];
}
export interface FreeProvisionResult {
  certificate: { serial: string; notAfter: string };
  /** The signing identity as base64 PKCS#12, with its password. CapMac protects both for this user. */
  p12: string;
  password: string;
  /** base64 .mobileprovision per bundle identifier. */
  profiles: Record<string, string>;
  /** Things that didn't fully work but didn't stop signing, in plain words. */
  notes: string[];
}

type PythonCommand = { executable: string; prefix: string[]; env?: NodeJS.ProcessEnv };
export interface FreeAppleOptions {
  /** Where the anisette machine and the certificate/key live (the team's Signing folder). */
  stateDir: string;
  python?: PythonCommand;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  /** Test seam: a stand-in for child_process.spawn. */
  spawn?: typeof nodeSpawn;
}

interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void }
const MAX_BUFFER = 4 * 1024 * 1024;

/** A running apple-free.py process. Call `login`, then `provision`, then `close`. */
export class FreeApple {
  #child: ChildProcessWithoutNullStreams | undefined;
  #generation = 0;
  #scriptFile: string | undefined;
  #buffer = '';
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #onNeedCode: ((mode: string, again: boolean) => Promise<string>) | undefined;
  #stderr: string[] = [];
  // Children that have exited, so a reused handle is never written to again.
  #dead = new WeakSet<object>();
  readonly #options: FreeAppleOptions;

  constructor(options: FreeAppleOptions) {
    this.#options = options;
  }

  async #start(): Promise<void> {
    if (this.#child) return;
    // Claim a generation synchronously, so a close() during the awaits below invalidates this start.
    const generation = ++this.#generation;
    const stale = () => this.#generation !== generation;
    throwIfAborted(this.#options.signal);
    const python = this.#options.python ?? (await deviceHelperCommand({ signal: this.#options.signal }));
    if (stale() || this.#options.signal?.aborted) throw new CancelledError();
    const spawn = this.#options.spawn ?? nodeSpawn;
    // The helper is too large for a Windows command line; write it out and run its path.
    const scriptFile = path.join(os.tmpdir(), `capmac-apple-free-${process.pid}-${randomBytes(6).toString('hex')}.py`);
    // Written synchronously so the child's listeners attach before any caller can act on the process.
    writeFileSync(scriptFile, runnerScript, { mode: 0o600 });
    const discard = () => { void fs.rm(scriptFile, { force: true }).catch(() => {}); };
    if (stale() || this.#options.signal?.aborted) { discard(); throw new CancelledError(); }
    const child = spawn(python.executable, [...python.prefix, scriptFile, this.#options.stateDir], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: python.env,
    }) as ChildProcessWithoutNullStreams;
    if (this.#dead.has(child)) { discard(); throw new UserError('The Apple sign-in helper is not running.', 'Sign in again.'); }
    this.#child = child;
    this.#scriptFile = scriptFile;
    const live = () => this.#generation === generation && this.#child === child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (live()) this.#onData(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.#stderr.push(line);
        if (this.#stderr.length > 50) this.#stderr.shift();
        this.#options.onLog?.(line);
      }
    });
    child.on('error', (error) => { this.#dead.add(child); if (live()) { this.#child = undefined; this.#failAll(error); } });
    child.on('close', (code) => {
      this.#dead.add(child);
      if (!live()) return;
      this.#child = undefined;
      this.#failAll(new UserError('The Apple sign-in helper stopped unexpectedly.',
        code ? `It exited with code ${code}.` : undefined, this.#stderr.slice(-8)));
    });
    if (this.#options.signal) {
      if (this.#options.signal.aborted) { this.close(); throw new CancelledError(); }
      this.#options.signal.addEventListener('abort', () => this.close(), { once: true });
    }
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_BUFFER) {
      this.#buffer = '';
      this.#failAll(new UserError('The Apple sign-in helper sent too much data.'));
      this.close();
      return;
    }
    let index: number;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      void this.#dispatch(message as Record<string, unknown>).catch((error) => this.#failAll(error));
    }
  }

  async #dispatch(message: Record<string, unknown>): Promise<void> {
    if (message.event === 'need-code') {
      const mode = typeof message.mode === 'string' ? message.mode : 'unknown';
      const code = this.#onNeedCode ? await this.#onNeedCode(mode, message.again === true) : '';
      this.#send({ op: 'code', code });
      return;
    }
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (message.ok) pending.resolve((message.result ?? {}) as Record<string, unknown>);
    else pending.reject(new UserError(typeof message.error === 'string' ? message.error : 'Apple sign-in failed.',
      freeHint(message), this.#stderr.slice(-6)));
  }

  #send(object: Record<string, unknown>): void {
    try { this.#child?.stdin.write(JSON.stringify(object) + '\n'); } catch { /* the helper is gone; a pending reject follows */ }
  }

  #failAll(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async #request(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.#start();
    throwIfAborted(this.#options.signal);
    if (!this.#child) throw new UserError('The Apple sign-in helper is not running.');
    const id = this.#nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ id, op, ...payload });
    });
  }

  /**
   * Signs in. `onNeedCode` is called when Apple wants a two-factor code: `mode` says where the code
   * is (see freeCodeMessage), and `again` that the last code was wrong.
   */
  async login(username: string, password: string, onNeedCode: (mode: string, again: boolean) => Promise<string>): Promise<FreeLoginResult> {
    this.#onNeedCode = onNeedCode;
    try {
      const result = await this.#request('login', { username, password });
      return { teams: (result.teams as FreeTeam[]) ?? [], expiry: Number(result.expiry ?? 0) };
    } finally {
      this.#onNeedCode = undefined;
    }
  }

  async provision(teamId: string, targets: FreeProvisionTarget[], device: { udid: string; name: string } | undefined, directory: string): Promise<FreeProvisionResult> {
    const result = await this.#request('provision', { teamId, targets, device, dir: directory });
    return {
      certificate: (result.certificate as FreeProvisionResult['certificate']) ?? { serial: '', notAfter: '' },
      p12: String(result.p12 ?? ''), password: String(result.password ?? ''),
      profiles: (result.profiles as Record<string, string>) ?? {},
      notes: Array.isArray(result.notes) ? (result.notes as string[]) : [],
    };
  }

  /**
   * Apple's ADCDownloadAuth cookie for one Xcode archive, on this sign-in (apple-free.py asks
   * developerservices2 the way Xcode does). The engine's own downloader then fetches the file.
   */
  async downloadGrant(remotePath: string): Promise<string[]> {
    const result = await this.#request('download-grant', { path: remotePath });
    const cookies = Array.isArray(result.cookies)
      ? result.cookies.filter((cookie): cookie is string => typeof cookie === 'string' && /^ADCDownloadAuth=[^;\s]+$/.test(cookie))
      : [];
    if (!cookies.length) throw new UserError('Apple did not allow the Xcode download.');
    return cookies;
  }

  close(): void {
    this.#generation++;
    const child = this.#child;
    this.#child = undefined;
    this.#failAll(new CancelledError());
    const scriptFile = this.#scriptFile;
    this.#scriptFile = undefined;
    const cleanup = () => { if (scriptFile) void fs.rm(scriptFile, { force: true }).catch(() => {}); };
    if (!child) { cleanup(); return; }
    try { child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n'); } catch { /* already gone */ }
    try { child.stdin.end(); } catch { /* already gone */ }
    child.once('close', cleanup);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } cleanup(); }, 2000);
    timer.unref?.();
  }
}

/**
 * Makes sure CapMac's Python has the extra packages the free sign-in needs
 * (anisette and its emulator, plus truststore so HTTPS certificates are checked
 * by Windows itself). Installs them the first time only, into CapMac's own
 * Python, next to the iPhone tools. pymobiledevice3 already brings the rest.
 */
export async function ensureFreeSigningSupport(python: PythonCommand, options: { onOutput?: (text: string, stream: 'stdout' | 'stderr') => void; signal?: AbortSignal; spawn?: typeof nodeSpawn } = {}): Promise<void> {
  const run = (args: string[], timeoutMs: number): Promise<number> => {
    throwIfAborted(options.signal);
    return new Promise((resolve, reject) => {
      const child = (options.spawn ?? nodeSpawn)(python.executable, [...python.prefix, ...args], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: python.env,
      });
      const onAbort = () => { try { child.kill(); } catch { /* gone */ } };
      const timer = setTimeout(() => { onAbort(); reject(new UserError('Preparing the free sign-in tools timed out.')); }, timeoutMs);
      timer.unref?.();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (c: Buffer) => options.onOutput?.(c.toString(), 'stdout'));
      child.stderr?.on('data', (c: Buffer) => options.onOutput?.(c.toString(), 'stderr'));
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (options.signal?.aborted) reject(new CancelledError());
        else resolve(code ?? 1);
      });
    });
  };
  throwIfAborted(options.signal);
  // Checks every package, so a Python set up before truststore was added still gets it.
  const present = await run(['-I', '-c', "import importlib.util,sys; sys.exit(0 if all(importlib.util.find_spec(m) for m in ('anisette', 'truststore')) else 3)"], 30_000);
  if (present === 0) return;
  throwIfAborted(options.signal);
  options.onOutput?.('Preparing the free Apple sign-in tools.\n', 'stderr');
  const installed = await run(['-I', '-m', 'pip', 'install', '--disable-pip-version-check', 'anisette', 'unicorn', 'pyelftools', 'truststore'], 300_000);
  if (installed !== 0) throw new UserError('Could not prepare the free Apple sign-in tools.', 'Check the internet connection, then run setup again.');
}

/** apple-free.py's own code for an account Apple wanted to text a code to, and wouldn't. */
const NOT_ON_IPHONE = -90001;

/** Turns a few known Apple error codes into a next step the developer can act on. */
function freeHint(message: Record<string, unknown>): string | undefined {
  const code = typeof message.code === 'number' ? message.code : undefined;
  const text = typeof message.error === 'string' ? message.error : '';
  // First: its message mentions the verification code too.
  if (code === NOT_ON_IPHONE) return 'Sign in to it on your iPhone, then try again. To keep your iPhone’s own Apple Account, add this one in Mail: open Settings, tap Apps, then Mail, then Mail Accounts, then Add Account, then iCloud. On iOS 17 or older, tap Mail, then Accounts';
  if (code === -21669 || /verification code/i.test(text)) return 'Check the code and sign in again.';
  // Apple also answers -22406 to a right password when sign-ins repeat within minutes (isideload #27).
  if (code === -22406) return 'Check the email and password. If they’re right, Apple is refusing repeated sign-ins for a while: wait 15 minutes, then try again.';
  if (code === 503) return 'Apple’s sign-in service is busy. Wait a few minutes, then try again.';
  if (code === -20209 || /locked/i.test(text)) return 'Apple locked this account for security. Open account.apple.com to unlock it, or use a different Apple ID made for development.';
  if (code === -80045) return 'Apple changed its sign-in and this client was turned away. Update CapMac, which keeps the sign-in in step.';
  if (/banned/i.test(text)) return 'Apple turned down this free profile. Use a different Apple ID, made just for development.';
  return undefined;
}
