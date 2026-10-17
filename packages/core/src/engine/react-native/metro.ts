/**
 * Metro, React Native's JavaScript server, on this PC. Every debug build
 * CapMac runs loads its JavaScript from here: a simulator and the Mac app
 * through the SSH tunnel to the Mac, an iPhone through the Mac (or straight
 * over Wi-Fi when it builds on this PC), the Windows app on this PC. A save
 * reaches the app at once (Fast Refresh) with no sync and no build.
 *
 * CapMac starts the project's own Metro (`react-native start`, or `expo
 * start`) with a small reporter of its own plugged in, which hands over what
 * Metro sees as data: bundling progress, JavaScript errors with their file and
 * line, and the app's console.log.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppLogLevel } from '../../shared/app-log.js';
import { log, startStep, type EngineContext, type StepHandle } from '../context.js';
import { canConnect, killTree } from '../devserver.js';
import { CancelledError, UserError } from '../errors.js';
import { stripAnsi } from '../format.js';
import { installLocalDependencies } from '../local-install.js';
import { hasInstalledDependencies, nodeExecutable, type ProjectInfo } from '../project.js';

/** Metro's own port, which every React Native app tries first. */
export const METRO_DEFAULT_PORT = 8081;

/** Lines CapMac's reporter writes: a marker, then one JSON event. */
const MARK = '\u001ecapmac-metro ';

/**
 * The reporter Metro loads (`--custom-log-reporter-path`). It passes every
 * event on to Metro's own terminal reporter (so Metro's output stays as it
 * is) and writes the ones CapMac needs as data. The app's console lines go
 * only as data: CapMac shows them in its console.
 */
export const METRO_REPORTER_SOURCE = String.raw`'use strict';
const MARK = ${JSON.stringify(MARK)};
let Base = null;
try { Base = require(require.resolve('metro', { paths: [process.cwd()] })).TerminalReporter; } catch (e) { Base = null; }
function send(event) { try { process.stdout.write(MARK + JSON.stringify(event) + '\n'); } catch (e) {} }
function text(value) { return typeof value === 'string' ? value : value == null ? '' : String(value); }
function errorOf(error) {
  if (!error) return {};
  return { message: text(error.message || error), file: error.filename || error.originModulePath || undefined, line: error.lineNumber, column: error.column, type: error.type || error.name };
}
class CapMacMetroReporter {
  constructor(terminal) { this.inner = Base ? new Base(terminal) : null; }
  update(event) {
    try {
      switch (event && event.type) {
        case 'initialize_done': send({ e: 'ready', port: event.port }); break;
        case 'initialize_failed': send({ e: 'failed', error: errorOf(event.error) }); break;
        case 'bundle_build_started': send({ e: 'bundle-start', id: event.buildID, platform: event.bundleDetails && event.bundleDetails.platform, entry: event.bundleDetails && event.bundleDetails.entryFile }); break;
        case 'bundle_transform_progressed': send({ e: 'bundle-progress', id: event.buildID, done: event.transformedFileCount, total: event.totalFileCount }); break;
        case 'bundle_build_done': send({ e: 'bundle-done', id: event.buildID }); break;
        case 'bundle_build_failed': send({ e: 'bundle-failed', id: event.buildID }); break;
        case 'bundling_error': send({ e: 'bundle-error', error: errorOf(event.error) }); break;
        case 'hmr_client_error': send({ e: 'hmr-error', error: errorOf(event.error) }); break;
        case 'client_log': send({ e: 'log', level: event.level, data: (event.data || []).map(text) }); return;
      }
    } catch (e) {}
    if (this.inner) this.inner.update(event);
  }
}
module.exports = CapMacMetroReporter;
`;

/** One event from CapMac's reporter. */
export type MetroEvent =
  | { e: 'ready'; port?: number }
  | { e: 'failed'; error: MetroError }
  | { e: 'bundle-start'; id: string; platform?: string; entry?: string }
  | { e: 'bundle-progress'; id: string; done: number; total: number }
  | { e: 'bundle-done'; id: string }
  | { e: 'bundle-failed'; id: string }
  | { e: 'bundle-error'; error: MetroError }
  | { e: 'hmr-error'; error: MetroError }
  | { e: 'log'; level: string; data: string[] };

export interface MetroError {
  message?: string;
  file?: string;
  line?: number;
  column?: number;
  type?: string;
}

/**
 * Metro's banner, progress bars and tips, and its errors for a reload that met
 * an app's connection as it closed (React Native swaps those as it
 * reconnects): not worth a line of their own in the console.
 */
export const METRO_NOISE = /^[\s▀-▟]+$|Welcome to (Metro|React Native)|Fast - Scalable - Integrated|Starting dev server on|JavaScript logs have moved|^\s*BUNDLE\s|^\s*Dev server ready|transform\[std(out|err)\]: \((node:\d+|Use `node)|Failed to send broadcast to client|WebSocket is not open: readyState/;
/** Of those, its logo, welcome lines and progress bars (CapMac shows its own bundling step): left out even of the full output. */
export const METRO_BANNER = /^[\s▀-▟]+$|Welcome to (Metro|React Native)|Fast - Scalable - Integrated|^\s*(BUNDLE|MAP)\s|JavaScript logs have moved/;

/** The event on one line of Metro's output, or null for Metro's own text. */
export function parseMetroLine(line: string): MetroEvent | null {
  const at = line.indexOf(MARK);
  if (at < 0) return null;
  try {
    const event = JSON.parse(line.slice(at + MARK.length));
    return event && typeof event.e === 'string' ? (event as MetroEvent) : null;
  } catch {
    return null;
  }
}

/** A console level from the app (log, info, warn, error, debug, trace, group…) as CapMac's. */
export function consoleLevel(level: string): AppLogLevel {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  if (level === 'info') return 'info';
  if (level === 'debug' || level === 'trace') return 'debug';
  return 'log';
}

/** Metro prints a syntax error's first line as "SyntaxError: <file>: <message> (12:5)": the message alone. */
export function metroErrorMessage(error: MetroError): string {
  const first = stripAnsi(error.message ?? 'JavaScript error').split('\n')[0]!.trim();
  if (!error.file) return first;
  // The message names the file with its whole path (spaces and all), the report often relative to the project: both go.
  const file = error.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return first.replace(new RegExp(`^((?:\\w+ )*\\w*Error: )?.*?${file}: `), '$1').replace(/\s*\(\d+:\d+\)$/, '');
}

export interface MetroServer {
  port: number;
  /** http://localhost:<port> on this PC. */
  url: string;
  /** Metro was already running for this project: CapMac uses it and leaves it running (false once CapMac had to start its own). */
  readonly external: boolean;
  /**
   * Resolves when Metro exits. For one already running, never while it runs:
   * if it stops, CapMac starts its own and this follows that one (or resolves
   * when it can't).
   */
  readonly exited: Promise<number | null>;
  /** Tells every app connected to Metro to reload its JavaScript (the r key in Metro). */
  reload(): Promise<boolean>;
  /** Opens React Native DevTools for the app (the j key in Metro). */
  openDevTools(): Promise<boolean>;
  stop(): Promise<void>;
}

/** What `/status` says about a port: this project's Metro, another server, or nothing. */
export async function metroStatus(port: number, projectDir: string, timeoutMs = 1500): Promise<'ours' | 'taken' | 'free'> {
  if (!(await canConnect('127.0.0.1', port, timeoutMs))) return 'free';
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    if (!body.includes('packager-status:running')) return 'taken';
    const root = response.headers.get('X-React-Native-Project-Root');
    return root && path.resolve(root).toLowerCase() === path.resolve(projectDir).toLowerCase() ? 'ours' : 'taken';
  } catch {
    return 'taken';
  }
}

/** The port Metro gets: the project's own Metro if it runs already, else the wanted port, else the next free one. */
export async function pickMetroPort(projectDir: string, wanted: number): Promise<{ port: number; running: boolean }> {
  for (let port = wanted; port < wanted + 20; port++) {
    const status = await metroStatus(port, projectDir);
    if (status === 'ours') return { port, running: true };
    if (status === 'free') return { port, running: false };
  }
  throw new UserError(`Ports ${wanted}–${wanted + 19} are all in use on this PC, so Metro can't start.`, 'Stop other Metro servers, or set reactNative.port in capmac.json.');
}

function resolveFrom(dir: string, request: string): string | null {
  try {
    return require.resolve(request, { paths: [dir] });
  } catch {
    // Bundled code has no require.resolve over a project's folders: look for the file.
  }
  for (let probe = dir; ; probe = path.dirname(probe)) {
    const candidate = path.join(probe, 'node_modules', ...request.split('/'));
    if (existsSync(candidate)) return candidate;
    if (path.dirname(probe) === probe) return null;
  }
}

/** Where CapMac keeps its files for React Native on this PC. */
export function reactNativeDataDir(): string {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.local', 'share');
  return path.join(base, process.platform === 'win32' ? 'CapMac' : 'capmac', 'react-native');
}

/** Writes the reporter once (its name carries its contents' hash). */
async function reporterFile(): Promise<string> {
  const hash = createHash('sha1').update(METRO_REPORTER_SOURCE).digest('hex').slice(0, 10);
  const file = path.join(reactNativeDataDir(), `capmac-metro-reporter-${hash}.cjs`);
  if (!existsSync(file)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, METRO_REPORTER_SOURCE);
    await fs.rename(`${file}.tmp`, file).catch(async () => {
      if (!existsSync(file)) throw new UserError('CapMac could not write its Metro reporter.');
    });
  }
  return file;
}

/** The command that starts the project's Metro. */
async function metroCommand(project: ProjectInfo, port: number): Promise<{ argv: string[]; withReporter: boolean; label: string }> {
  const rn = project.reactNative;
  const extra = rn?.options.metroArgs ?? [];
  if (rn?.expo) {
    const cli = resolveFrom(project.capDir, 'expo/bin/cli');
    if (!cli) throw new UserError('Expo is not installed in this project on this PC.', `Run \`${project.packageManager} install\` in the project, then try again.`);
    // Expo starts its own Metro; its output is read as text.
    return { argv: [cli, 'start', '--port', String(port), '--localhost', ...extra], withReporter: false, label: 'expo start' };
  }
  const cli = resolveFrom(project.capDir, 'react-native/cli.js');
  if (!cli) throw new UserError('React Native is not installed in this project on this PC.', `Run \`${project.packageManager} install\` in the project, then try again.`);
  const plugin = resolveFrom(project.capDir, '@react-native/community-cli-plugin/dist/commands/start/index.js');
  const pluginText = plugin ? await fs.readFile(plugin, 'utf8').catch(() => '') : '';
  // React Native 0.77+ keeps the app's console out of Metro unless asked (and says so as it starts).
  const clientLogs = pluginText.includes('--client-logs') ? ['--client-logs'] : [];
  const reporter = await reporterFile();
  return {
    argv: [cli, 'start', '--port', String(port), '--host', '127.0.0.1', '--no-interactive', ...clientLogs, '--custom-log-reporter-path', reporter, ...extra],
    withReporter: true,
    label: 'react-native start',
  };
}

export interface MetroOptions {
  /** The port to try first (default capmac.json reactNative.port, else 8081). */
  port?: number;
  /** Start with an empty cache (`--reset-cache`): after Metro's or Babel's settings change. */
  resetCache?: boolean;
  signal?: AbortSignal;
  /** Called with each bundling update ("Bundling 45%"), for the live session's status. */
  onBundle?: (state: 'start' | 'done' | 'failed', detail?: string) => void;
  /**
   * Taking over from a Metro that stopped while this run used it: only on the
   * same port (the app and the Mac's tunnel point at it), and with no step of
   * its own (the run is past its Metro step).
   */
  takeover?: boolean;
}

/** Metro answers /open-debugger once the browser it opens DevTools in has started: from cold, that takes several seconds. */
const DEVTOOLS_WAIT_MS = 30_000;

/** Fetch with a timeout (short unless asked) that never throws. */
async function post(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/** How often a borrowed Metro is checked, and how many failed checks in a row mean it stopped (one slow answer doesn't). */
const BORROWED_CHECK_MS = 2000;
const BORROWED_MISSES = 2;
/**
 * After CapMac starts its own Metro: how often it asks the app to reload, and
 * for how long. A reload reaches the app over a connection React Native
 * restores every 2 s, and for a few rounds after Metro is back it swaps that
 * connection for a new one: a reload sent in between is lost.
 */
const RELOAD_RETRY_MS = 4000;
const RELOAD_WAIT_MS = 30_000;

/** Metro's message socket, with CapMac as one of its clients. */
export interface MetroMessages {
  readonly state: 'connecting' | 'open' | 'closed';
  /** What Metro's r sends: every other client (the apps) reloads. */
  reload(): void;
  close(): void;
}

/**
 * Metro's message socket, where a reload goes to the apps. As one of its
 * clients, CapMac can ask for one before the app is connected without Metro
 * saying "No apps connected" (it does when nobody is). Null where Node.js has
 * no WebSocket (before 22).
 */
function metroMessages(port: number): MetroMessages | null {
  if (typeof WebSocket !== 'function') return null;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/message`);
  return {
    get state() {
      return socket.readyState === WebSocket.OPEN ? 'open' : socket.readyState === WebSocket.CONNECTING ? 'connecting' : 'closed';
    },
    reload: () => socket.send(JSON.stringify({ version: 2, method: 'reload' })),
    close: () => socket.close(),
  };
}

/**
 * Metro another run started for this app (another CapMac window, the CLI, or
 * `npx react-native start`): this run uses it and leaves it running when it
 * ends. If that Metro stops first, this run starts its own on the same port,
 * so the app keeps its JavaScript; `exited` then follows that one. An app that
 * was open loses Fast Refresh with the old Metro (React Native asks for a
 * reload): CapMac reloads it until it fetches its JavaScript from the new one.
 * `test` stands in for Metro and its timings in tests.
 */
export function borrowMetro(project: ProjectInfo, port: number, options: MetroOptions, ctx: EngineContext, test: { start?: typeof startMetro; messages?: (port: number) => MetroMessages | null; checkMs?: number; retryMs?: number; waitMs?: number } = {}): MetroServer {
  const start = test.start ?? startMetro;
  let own: MetroServer | null = null;
  let ended = false;
  let misses = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveExited!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => (resolveExited = resolve));
  /** An app asked CapMac's own Metro for its JavaScript. */
  let bundled = false;
  let resolveBundled!: () => void;
  const bundleAsked = new Promise<void>((resolve) => (resolveBundled = resolve));
  const end = (code: number | null) => {
    if (ended) return;
    ended = true;
    resolveExited(code);
  };
  const schedule = () => {
    if (ended) return;
    timer = setTimeout(() => void check(), test.checkMs ?? BORROWED_CHECK_MS);
    timer.unref?.();
  };
  const takeOver = async (status: 'taken' | 'free') => {
    if (status === 'taken') {
      ctx.emit({ type: 'error', error: { message: `The Metro this app used on port ${port} stopped, and another server took the port.`, hint: 'The app needs Metro there for its JavaScript: stop that server, then start again.', expected: true } });
      return end(null);
    }
    log(ctx, 'info', `The Metro this app used on port ${port} stopped: CapMac starts its own there`);
    const onBundle: MetroOptions['onBundle'] = (state, detail) => {
      if (state === 'start' && !bundled) {
        bundled = true;
        resolveBundled();
      }
      options.onBundle?.(state, detail);
    };
    let started: MetroServer;
    try {
      started = await start(project, { port, takeover: true, signal: options.signal, onBundle }, ctx);
    } catch (err) {
      if (ended || options.signal?.aborted || err instanceof CancelledError) return;
      ctx.emit({ type: 'error', error: { message: `Metro stopped, and CapMac could not start it again: ${err instanceof Error ? err.message : String(err)}`, hint: 'The app needs it for its JavaScript: stop and start again.', expected: true } });
      return end(null);
    }
    // The run ended while Metro started: nothing needs it any more.
    if (ended) return void started.stop();
    own = started;
    log(ctx, 'info', `Metro runs again on port ${port}`);
    void started.exited.then(end);
    // Expo's output has no bundle reports to tell when the app is back: it is left to reload by hand.
    if (!project.reactNative?.expo) void reloadApp(started);
  };
  /**
   * Asks the app to reload until it fetches its JavaScript from CapMac's
   * Metro. With no app open yet, nothing hears it: the app fetches it as it
   * opens, which ends the asking too.
   */
  const reloadApp = async (metro: MetroServer) => {
    const messages = (test.messages ?? metroMessages)(port);
    try {
      for (const until = Date.now() + (test.waitMs ?? RELOAD_WAIT_MS); !ended && !bundled && Date.now() < until; ) {
        // Through the message socket once it is open; as Metro's r without one.
        if (messages?.state === 'open') messages.reload();
        else if (messages?.state !== 'connecting') await metro.reload();
        await Promise.race([bundleAsked, new Promise((resolve) => setTimeout(resolve, test.retryMs ?? RELOAD_RETRY_MS).unref())]);
      }
    } finally {
      messages?.close();
    }
    if (bundled && !ended) log(ctx, 'info', 'The app loads its JavaScript from the new Metro: saves show in it again');
  };
  const check = async () => {
    timer = null;
    if (ended || options.signal?.aborted) return;
    const status = await metroStatus(port, project.capDir);
    if (ended) return;
    if (status === 'ours') misses = 0;
    else if (++misses >= BORROWED_MISSES) return void takeOver(status);
    schedule();
  };
  schedule();
  return {
    port,
    url: `http://localhost:${port}`,
    get external() {
      return own ? own.external : true;
    },
    exited,
    reload: () => (own ? own.reload() : post(`http://127.0.0.1:${port}/reload`)),
    openDevTools: () => (own ? own.openDevTools() : post(`http://127.0.0.1:${port}/open-debugger`, DEVTOOLS_WAIT_MS)),
    stop: async () => {
      ended = true;
      if (timer) clearTimeout(timer);
      await own?.stop();
    },
  };
}

/**
 * Starts Metro for the project on this PC (or finds the one already running
 * for it), and turns its reports into CapMac's: a bundling step, JavaScript
 * errors as Problems, the app's console lines.
 */
export async function startMetro(project: ProjectInfo, options: MetroOptions, ctx: EngineContext): Promise<MetroServer> {
  if (!project.reactNative) throw new UserError('This is not a React Native app.');
  const wanted = options.port ?? project.reactNative.options.port ?? METRO_DEFAULT_PORT;
  const picked = await pickMetroPort(project.capDir, wanted);
  if (picked.running) {
    log(ctx, 'info', `Using the Metro already running for this app on port ${picked.port}`);
    if (!options.takeover) ctx.emit({ type: 'phase-skipped', phase: 'devserver', reason: `Metro is already running on port ${picked.port}` });
    return borrowMetro(project, picked.port, options, ctx);
  }
  if (options.takeover && picked.port !== wanted) throw new UserError(`Port ${wanted} is in use by another server on this PC.`, 'The app needs Metro there for its JavaScript: stop that server, then start again.');
  if (!hasInstalledDependencies(project)) {
    if (!ctx.prompter.interactive) throw new UserError('The app’s packages are not installed on this PC, so Metro can’t start.', `Run \`${project.packageManager} install\` in the project, then try again.`);
    const yes = await ctx.prompter.confirm({ message: `Install the app’s packages on this PC (${project.packageManager} install)?`, detail: 'Metro, which serves the app’s JavaScript, runs on this PC and needs them.', confirmLabel: 'Install', defaultYes: true, signal: options.signal });
    if (!yes) throw new UserError('Metro needs the app’s packages on this PC.', `Run \`${project.packageManager} install\` in the project, then try again.`);
    await installLocalDependencies(project, ctx, options.signal);
  }
  if (picked.port !== wanted) log(ctx, 'info', `Port ${wanted} is in use on this PC: Metro uses ${picked.port}`);
  const command = await metroCommand(project, picked.port);
  if (options.resetCache) command.argv.push('--reset-cache');
  const step = options.takeover ? null : startStep(ctx, `Starting Metro (${command.label})`, 'devserver');
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', RCT_METRO_PORT: String(picked.port), BROWSER: 'none' };
  delete env.NO_COLOR;
  delete env.ELECTRON_RUN_AS_NODE;
  if (project.reactNative.expo) env.CI = '1';
  // Metro's file map is case-sensitive, on Windows too: it starts in the folder under its name on disk
  // (a path typed or saved as "CapMac Studio" for "capmac Studio" fails with "Failed to get the SHA-1").
  const cwd = await fs.realpath(project.capDir).catch(() => project.capDir);
  const child: ChildProcess = spawn(nodeExecutable(), command.argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail: string[] = [];
  let ready = false;
  let bundleStep: StepHandle | null = null;
  let firstBundle = true;
  const bundles = new Map<string, { done: number; total: number }>();
  const onEvent = (event: MetroEvent) => {
    switch (event.e) {
      case 'ready':
        ready = true;
        break;
      case 'bundle-start':
        bundles.set(event.id, { done: 0, total: 0 });
        options.onBundle?.('start');
        // The first bundle is part of opening the app: a step of its own. Later ones are Fast Refresh, shown quietly.
        if (firstBundle && !bundleStep) bundleStep = startStep(ctx, `Bundling the JavaScript${event.platform ? ` for ${event.platform === 'ios' ? 'iOS' : event.platform === 'macos' ? 'the Mac' : event.platform === 'windows' ? 'Windows' : event.platform}` : ''}`, 'launch');
        break;
      case 'bundle-progress': {
        const progress = bundles.get(event.id);
        if (progress) Object.assign(progress, { done: event.done, total: event.total });
        if (bundleStep && event.total > 0) bundleStep.update(`${Math.round((event.done / event.total) * 100)}% (${event.done}/${event.total} files)`, event.done / event.total);
        break;
      }
      case 'bundle-done':
        bundles.delete(event.id);
        options.onBundle?.('done');
        if (bundleStep) {
          bundleStep.succeed();
          bundleStep = null;
          firstBundle = false;
        }
        break;
      case 'bundle-failed':
        bundles.delete(event.id);
        options.onBundle?.('failed');
        if (bundleStep) {
          bundleStep.fail();
          bundleStep = null;
        }
        break;
      case 'bundle-error':
      case 'hmr-error': {
        const message = metroErrorMessage(event.error);
        const file = event.error.file;
        if (file && event.error.line) {
          ctx.emit({ type: 'diagnostic', diagnostic: { severity: 'error', message, file: path.isAbsolute(file) ? file : path.join(project.capDir, file), line: event.error.line, column: event.error.column, own: !/[\\/]node_modules[\\/]/.test(file) } });
        }
        ctx.emit({ type: 'error', error: { message: `JavaScript error: ${message}`, hint: file ? `In ${path.isAbsolute(file) ? path.relative(project.capDir, file) : file}${event.error.line ? `:${event.error.line}` : ''}. Fix it and save: the app reloads by itself.` : 'Fix it and save: the app reloads by itself.', expected: true } });
        break;
      }
      case 'log': {
        const textOut = event.data.join(' ').replace(/\s+$/, '');
        if (!textOut) break;
        ctx.emit({ type: 'app-log', entry: { kind: 'console', level: consoleLevel(event.level), text: textOut, stream: event.level === 'error' ? 'stderr' : 'stdout', ts: Date.now() } });
        break;
      }
      case 'failed':
        tail.push(metroErrorMessage(event.error));
        break;
    }
  };
  const partial = { stdout: '', stderr: '' };
  const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const lines = (partial[stream] + chunk.toString('utf8')).split('\n');
    partial[stream] = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      const event = parseMetroLine(line);
      if (event) {
        onEvent(event);
        continue;
      }
      const textOut = stripAnsi(line).trimEnd();
      if (!textOut.trim() || METRO_BANNER.test(textOut)) continue;
      tail.push(textOut);
      if (tail.length > 60) tail.shift();
      // Metro's tips stay in the full output.
      if (METRO_NOISE.test(textOut)) ctx.emit({ type: 'tool-output', stream: 'stdout', text: textOut });
      else ctx.emit({ type: 'devserver-output', text: textOut });
      if (!command.withReporter) {
        // Expo's own output: its server is ready when it says where it waits.
        if (/Waiting on http|Metro waiting on|Logs for your project will appear/i.test(textOut)) ready = true;
        const consoleLine = /^\s*(LOG|INFO|WARN|ERROR|DEBUG)\s+(.*)$/.exec(textOut);
        if (consoleLine) ctx.emit({ type: 'app-log', entry: { kind: 'console', level: consoleLevel(consoleLine[1]!.toLowerCase()), text: consoleLine[2]!, stream: 'stdout', ts: Date.now() } });
      }
    }
  };
  child.stdout!.on('data', onData('stdout'));
  child.stderr!.on('data', onData('stderr'));
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });
  let stopping = false;
  const stop = async () => {
    stopping = true;
    await killTree(child);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
  };
  const onAbort = () => void stop();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // Ready when Metro answers on its port as this project's server (or its reporter says so).
    const started = Date.now();
    for (;;) {
      if (options.signal?.aborted) throw new CancelledError();
      const status = await Promise.race([metroStatus(picked.port, project.capDir, 1000), exited.then(() => 'exited' as const)]);
      if (status === 'exited') {
        throw new UserError('Metro stopped as it started.', /EADDRINUSE|already in use/i.test(tail.join('\n')) ? `Port ${picked.port} is in use: stop the other server, or set reactNative.port in capmac.json.` : 'Check the output above, or run `npx react-native start` in the project to see why.', tail.slice(-20));
      }
      if (status === 'ours' || (ready && status !== 'free')) break;
      if (Date.now() - started > 120_000) throw new UserError('Metro did not start within 2 minutes.', 'Check the output above, or run `npx react-native start` in the project.', tail.slice(-20));
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    step?.succeed();
  } catch (err) {
    if (err instanceof CancelledError) step?.cancel();
    else step?.fail();
    await stop();
    throw err;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
  ctx.emit({ type: 'devserver', url: `http://localhost:${picked.port}`, external: false, command: command.label });
  void exited.then((code) => {
    if (!stopping) ctx.emit({ type: 'error', error: { message: `Metro stopped (exit code ${code ?? 'unknown'}).`, hint: 'The app needs it for its JavaScript: stop and start again.', expected: true } });
  });
  return {
    port: picked.port,
    url: `http://localhost:${picked.port}`,
    external: false,
    exited,
    reload: () => post(`http://127.0.0.1:${picked.port}/reload`),
    openDevTools: () => post(`http://127.0.0.1:${picked.port}/open-debugger`, DEVTOOLS_WAIT_MS),
    stop,
  };
}
