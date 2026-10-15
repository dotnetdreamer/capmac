/**
 * Electron apps on the Mac: prepare (dependencies, Electron itself, Capacitor's
 * web assets, the build), launch (with CapMac's module preloaded, the app's
 * output and the pages' console streamed back), the app's windows as a screen
 * (H.264 video or JPEG frames, and input, through that module), and
 * screenshots.
 */
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHROMIUM_LOG,
  dialogSocket,
  ENV_LIVE_SCHEME,
  ENV_LIVE_URL,
  ENV_PROJECT,
  ENV_SOCKET,
  ENV_SOUND,
  frontFile,
  isSoundMode,
  parseAppLine,
  type AppCodec,
  type AppDialog,
  type AppDialogAnswer,
  type AppDialogClosed,
  type AppInputEvent,
  type AppWindowInfo,
  type ElectronControl,
  type ElectronLaunchParams,
  type ElectronLaunchResult,
  type ElectronPlan,
  type ElectronPrepareParams,
  type ElectronPrepareResult,
  type ElectronScreenParams,
  type HookEvent,
  type HookMessage,
  type HookRequest,
} from '../../shared/electron.js';
import { JsDiagnosticParser } from '../../shared/js-diagnostics.js';
import type { ScreenInfo } from '../../shared/protocol.js';
import { parseStreamHeader, STREAM_FRAME } from '../../shared/stream.js';
import { ELECTRON_HOOK_SOURCE } from '../electron-hook-source.js';
import { HookConnection } from '../electron-socket.js';
import { capmacHome, toolEnv } from '../env.js';
import { VideoPacer } from '../helper/relay.js';
import { findCapacitorCli } from '../ios-project.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, exists, run, sleep, tryCapture } from '../proc.js';
import { loadState, projectPaths, saveState, withProjectLock, type ProjectPaths } from '../state.js';
import { depsHash, detectPackageManager, installCommand, installEnv } from './prepare.js';

const PROJECT_ID = /^[A-Za-z0-9._-]{1,120}$/;
/** The client pings every couple of seconds; this long without a word means it is gone. */
const CLIENT_TIMEOUT_MS = 15_000;

const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

function under(rel: string, prefix: string): boolean {
  return prefix === '' || rel === prefix || rel.startsWith(`${prefix}/`);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

// ─── Where things live on the Mac ─────────────────────────────────────────

/** The socket an app's CapMac module listens on: one per project (Unix socket paths are short). */
export function socketPath(projectId: string): string {
  if (!PROJECT_ID.test(projectId)) throw new AgentError(`Invalid project id ${JSON.stringify(projectId)}`, 'BAD_REQUEST');
  const preferred = path.join(capmacHome(), 'run', `${projectId}.sock`);
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  return path.join(os.tmpdir(), 'capmac-run', `${createHash('sha1').update(projectId).digest('hex').slice(0, 16)}.sock`);
}

/** The folder of the project's sockets and its running app's record (private to this user). */
async function runDir(projectId: string): Promise<string> {
  const dir = path.dirname(socketPath(projectId));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

/** CapMac's module for Electron apps, written once per version and kept while in use. */
async function ensureHook(): Promise<string> {
  if (!ELECTRON_HOOK_SOURCE) throw new AgentError('This CapMac agent was built without Electron support.', 'BAD_REQUEST', 'Update CapMac.');
  const hash = createHash('sha256').update(ELECTRON_HOOK_SOURCE).digest('hex').slice(0, 16);
  const dir = path.join(capmacHome(), 'electron');
  const file = path.join(dir, `hook-${hash}.cjs`);
  if (await exists(file)) {
    const now = new Date();
    await fs.utimes(file, now, now).catch(() => undefined);
    return file;
  }
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, ELECTRON_HOOK_SOURCE);
  await fs.rename(tmp, file);
  // Old versions are tiny, but a dev command may still load one: keep those used in the last two weeks.
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith('hook-') || name === path.basename(file)) continue;
    const stat = await fs.stat(path.join(dir, name)).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
  return file;
}

function appDirOf(paths: ProjectPaths, plan: ElectronPlan): string {
  const rel = plan.appRel.replace(/^\/+|\/+$/g, '');
  if (rel.split('/').some((part) => part === '..')) throw new AgentError('Invalid app folder', 'BAD_REQUEST');
  return rel ? path.join(paths.project, ...rel.split('/')) : paths.project;
}

// ─── Electron itself ──────────────────────────────────────────────────────

interface ElectronPackage {
  dir: string;
  version: string;
  /** The Electron executable, when it is installed for this Mac. */
  binary: string | null;
}

/** The project's `electron` package (next to the app, or hoisted to the root), and its executable when installed. */
async function findElectron(appDir: string, root: string): Promise<ElectronPackage | null> {
  let dir = appDir;
  for (;;) {
    const pkg = path.join(dir, 'node_modules', 'electron', 'package.json');
    if (await exists(pkg)) {
      const electronDir = path.dirname(pkg);
      const version = String(JSON.parse(await fs.readFile(pkg, 'utf8')).version ?? '');
      const pathTxt = (await fs.readFile(path.join(electronDir, 'path.txt'), 'utf8').catch(() => '')).trim();
      const installed = (await fs.readFile(path.join(electronDir, 'dist', 'version'), 'utf8').catch(() => '')).trim().replace(/^v/, '');
      const binary = pathTxt ? path.join(electronDir, 'dist', pathTxt) : null;
      const ok = binary !== null && installed === version && /Electron\.app/.test(pathTxt) && (await exists(binary));
      return { dir: electronDir, version, binary: ok ? binary : null };
    }
    const parent = path.dirname(dir);
    if (dir === root || parent === dir || !dir.startsWith(root)) return null;
    dir = parent;
  }
}

/** Downloads Electron for this Mac when the project has none yet (Electron 44 and later download on first use). */
async function ensureElectronBinary(appDir: string, root: string, env: NodeJS.ProcessEnv, io: AgentIO): Promise<ElectronPackage & { downloaded: boolean }> {
  const found = await findElectron(appDir, root);
  if (!found) {
    throw new AgentError('Electron is not installed in this project.', 'ELECTRON_LAUNCH_FAILED', 'Add it on Windows with `npm install --save-dev electron`, then run again.');
  }
  if (found.binary) return { ...found, downloaded: false };
  await step(io, 'electron', `Downloading Electron ${found.version} for this Mac`, async () => {
    const r = await run(process.execPath, [path.join(found.dir, 'install.js')], {
      cwd: found.dir,
      // Electron picks the Mac's architecture itself (arm64 even under a Rosetta Node.js).
      env: installEnv(env, { electron: true }),
      signal: io.signal,
      timeoutMs: 15 * 60_000,
      onLine: (line) => line.trim() && io.send({ t: 'progress', text: line.trim().slice(0, 160) }),
    });
    if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
    if (r.code !== 0) throw new AgentError(`Downloading Electron ${found.version} failed`, 'ELECTRON_LAUNCH_FAILED', 'Check the Mac’s internet connection, then run again.', r.tail.slice(-12));
  });
  const after = await findElectron(appDir, root);
  if (!after?.binary) throw new AgentError(`Electron ${found.version} did not install on the Mac.`, 'ELECTRON_LAUNCH_FAILED', 'Run again with --full to reinstall the dependencies.');
  return { ...after, downloaded: true };
}

// ─── Prepare ──────────────────────────────────────────────────────────────

/**
 * Gets the app ready to launch: dependencies (the project's, and Capacitor's
 * Electron platform's own), Electron for this Mac, Capacitor's web assets in
 * the app, and the app's build. Each part runs only when its inputs changed.
 */
export async function opElectronPrepare(params: ElectronPrepareParams, io: AgentIO): Promise<ElectronPrepareResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  return withProjectLock(paths, io, async () => {
    const state = await loadState(paths);
    const env = await toolEnv();
    const { plan } = params;
    const appDir = appDirOf(paths, plan);
    if (!(await exists(path.join(appDir, 'package.json')))) {
      throw new AgentError('The Electron app is missing on the Mac.', 'ELECTRON_LAUNCH_FAILED', 'Run again: CapMac syncs it first.');
    }
    const toRel = (abs: string) => path.relative(paths.src, abs).split(path.sep).join('/');
    const appRel = toRel(appDir);
    const pending = params.full || state.electronPendingFull ? null : state.electronPending;
    const changedUnder = (prefix: string) => pending === null || pending.some((rel) => under(rel, prefix));

    // 1. Dependencies. Capacitor's Electron platform is a project of its own inside the app.
    const installs = plan.flavor === 'capacitor' && appRel
      ? [
          { dir: paths.src, rel: '', label: 'Installing dependencies', include: (rel: string) => !under(rel, appRel) },
          { dir: appDir, rel: appRel, label: 'Installing the Electron app’s dependencies', include: (rel: string) => under(rel, appRel) },
        ]
      : [{ dir: paths.src, rel: '', label: 'Installing dependencies', include: () => true }];
    const installed: string[] = [];
    for (const [index, target] of installs.entries()) {
      const want = depsHash(state, target.include);
      const hasModules = await exists(path.join(target.dir, 'node_modules'));
      // iOS's prepare installs the same root folder; either install counts.
      const done = state.electronDeps[target.rel] === want || (target.rel === '' && plan.flavor === 'capacitor' && state.depsHash === want);
      if (!params.full && done && hasModules) continue;
      const { pm, version, lockfile } = await detectPackageManager(target.dir);
      const command = await installCommand(target.dir, pm, version, lockfile, env);
      await step(io, index === 0 ? 'install' : 'install-app', `${target.label} (${command.label})`, async () => {
        const r = await run(command.cmd, command.args, {
          cwd: target.dir,
          env: installEnv(env, { electron: true }),
          signal: io.signal,
          onLine: (line) => line.trim() && io.send({ t: 'progress', text: line.trim().slice(0, 160) }),
        });
        if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
        if (r.code !== 0) {
          throw new AgentError(`${command.label} failed (exit ${r.code})`, 'INSTALL_FAILED', 'If the project uses a private registry, make sure its token is configured on the Mac (for example in ~/.npmrc).', r.tail.slice(-30));
        }
      });
      state.electronDeps[target.rel] = want;
      if (target.rel === '' && plan.flavor === 'capacitor') {
        state.depsHash = want;
        state.needsCapSync = true;
      }
      state.electronBuilt = false;
      installed.push(target.rel);
      await saveState(paths, state);
    }

    // 2. Electron itself, for this Mac.
    const electron = await ensureElectronBinary(appDir, paths.src, env, io);

    // 3. Capacitor: the web build goes into the app (`npx cap copy`). Live reload loads the dev server instead.
    let capCopied = false;
    if (plan.flavor === 'capacitor' && !params.live) {
      const webRel = toRel(path.join(paths.project, ...(plan.webDir ?? 'www').split('/')));
      const copiedAssets = await exists(path.join(appDir, 'app', 'index.html'));
      if (!state.electronCopied || !copiedAssets || changedUnder(webRel)) {
        const cli = await findCapacitorCli(paths.project, paths.src);
        if (!cli) throw new AgentError('@capacitor/cli is not installed in this project.', 'CAP_FAILED', 'Add it with `npm install -D @capacitor/cli` on Windows, then run again.');
        await step(io, 'cap', 'npx cap copy @capacitor-community/electron', async () => {
          const r = await run(process.execPath, [cli, 'copy', '@capacitor-community/electron'], {
            cwd: paths.project,
            env: { ...env, CI: '1' },
            signal: io.signal,
            onLine: (line) => {
              const text = line.trim();
              if (text) io.send({ t: 'progress', text: text.replace(/^[✔√]\s*/, '').slice(0, 160) });
            },
          });
          if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
          if (r.code !== 0 || !(await exists(path.join(appDir, 'app')))) {
            const hint = /not installed|Unable to find|Cannot find module/i.test(r.tail.join('\n')) ? 'Add the platform on Windows: `npm install @capacitor-community/electron` and `npx cap add @capacitor-community/electron`.' : undefined;
            throw new AgentError('npx cap copy @capacitor-community/electron failed', 'CAP_FAILED', hint, r.tail.slice(-20));
          }
        });
        state.electronCopied = true;
        capCopied = true;
      }
    }

    // 4. The build (a dev command builds by itself in live reload).
    let built = false;
    const build = params.live && plan.dev ? null : plan.build;
    if (build && (params.full || !state.electronBuilt || changedUnder(appRel))) {
      const parser = new JsDiagnosticParser(appDir, paths.project);
      let errors = 0;
      await step(io, 'build', `Building the app (${build})`, async () => {
        const r = await run('/bin/sh', ['-c', build], {
          cwd: appDir,
          env,
          signal: io.signal,
          tailLines: 80,
          onLine: (line, stream) => {
            io.send({ t: 'out', stream, text: line });
            const diag = parser.push(line);
            if (diag) {
              if (diag.severity === 'error') errors += 1;
              io.send({ t: 'diag', ...diag });
            }
            const text = line.trim();
            if (text) io.send({ t: 'progress', text: text.slice(0, 160) });
          },
        });
        if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
        if (r.code !== 0) {
          throw new AgentError(
            errors ? `The build failed with ${errors} error${errors === 1 ? '' : 's'} (${build}).` : `The build failed (${build}).`,
            'ELECTRON_BUILD_FAILED',
            errors ? 'Fix the errors in Problems, then run again.' : 'Its output is below.',
            r.tail.slice(-40),
          );
        }
      });
      state.electronBuilt = true;
      built = true;
    }

    state.electronPending = [];
    state.electronPendingFull = false;
    await saveState(paths, state);
    const macos = await tryCapture('/usr/bin/sw_vers', ['-productVersion'], { env });
    return { installed, electron: electron.version, downloaded: electron.downloaded, capCopied, built, macos };
  });
}

// ─── Launch ───────────────────────────────────────────────────────────────

interface RunningRecord {
  pid: number;
  /** When the process started (`ps -o lstart`): a recycled pid is not ours. */
  started: string;
}

async function processStarted(pid: number): Promise<string | null> {
  const r = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5000 }).catch(() => null);
  const text = r?.code === 0 ? r.stdout.trim() : '';
  return text || null;
}

/** Stops an app an earlier launch left running (the connection dropped): two copies would fight over the socket and single-instance locks. */
async function stopLeftover(recordFile: string): Promise<void> {
  const record = await fs.readFile(recordFile, 'utf8').then((text) => JSON.parse(text) as RunningRecord).catch(() => null);
  if (!record?.pid) return;
  const started = await processStarted(record.pid);
  if (started && started === record.started) {
    try {
      process.kill(-record.pid, 'SIGTERM');
    } catch {
      // gone already
    }
    for (let i = 0; i < 20 && (await processStarted(record.pid)) === started; i++) await sleep(200);
    try {
      process.kill(-record.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  await fs.rm(recordFile, { force: true }).catch(() => undefined);
}

/** NODE_OPTIONS that preload CapMac's module (kept with whatever the environment already had). */
function withHook(existing: string | undefined, hook: string): string {
  const require = `--require ${JSON.stringify(hook)}`;
  return existing?.trim() ? `${existing.trim()} ${require}` : require;
}

type DialogRequest = Extract<HookRequest, { t: 'dialog-answer' | 'dialog-list' | 'dialog-mkdir' }>;
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/**
 * The app's dialog socket (see the hook's dialogs.ts): the dialogs waiting
 * for an answer go to `onDialogs`, and requests (answers, folders) go back.
 * `connect` again after every hello: a restarted app has a new socket.
 */
class DialogWatch {
  private conn: HookConnection | null = null;
  private generation = 0;
  private nextId = 1;
  private closed = false;

  constructor(private readonly path: string, private readonly onDialogs: (dialogs: AppDialog[], closed?: { id: number; how: AppDialogClosed }) => void) {}

  async connect(): Promise<void> {
    const generation = ++this.generation;
    this.conn?.close();
    this.conn = null;
    // The worker serving it starts with the app: give it a few seconds.
    for (let attempt = 0; attempt < 20 && !this.closed && generation === this.generation; attempt++) {
      const conn = await HookConnection.connect(this.path, 1500).catch(() => null);
      if (conn) {
        if (this.closed || generation !== this.generation) {
          conn.close();
          return;
        }
        this.conn = conn;
        conn.onMessage = (message) => {
          if (message.t === 'dialogs') this.onDialogs(message.dialogs, message.closed);
        };
        conn.send({ t: 'hello', role: 'control' });
        void conn.done.then(() => {
          if (this.conn !== conn) return;
          this.conn = null;
          // The app quit or restarted: its dialogs are gone with it.
          this.onDialogs([]);
        });
        return;
      }
      await sleep(500);
    }
  }

  async request(request: WithoutId<DialogRequest>): Promise<unknown> {
    const conn = this.conn;
    if (!conn) throw new Error('The app is not running.');
    const { message } = await conn.request({ ...request, id: this.nextId++ } as DialogRequest, 15_000);
    if (message.t !== 'result') throw new Error('Unexpected answer from the app.');
    if (!message.ok) throw new Error(message.error ?? 'The app could not do that.');
    return message.data;
  }

  close(): void {
    this.closed = true;
    this.conn?.close();
    this.conn = null;
  }
}

async function controlRequest(socket: string, control: ElectronControl): Promise<unknown> {
  const conn = await HookConnection.connect(socket).catch(() => {
    throw new Error('The app is not running.');
  });
  try {
    conn.send({ t: 'hello', role: 'control' });
    const request: HookRequest = control.action === 'sound' ? { t: 'sound', id: 1, mode: control.mode } : { t: control.action === 'reload' ? 'reload' : 'modules', id: 1 };
    const { message } = await conn.request(request as HookRequest & { id: number });
    if (message.t !== 'result') throw new Error('Unexpected answer from the app.');
    if (!message.ok) throw new Error(message.error ?? 'The app could not do that.');
    return message.data;
  } finally {
    conn.close();
  }
}

/**
 * Launches the app (or, in live reload, the app's dev command) with CapMac's
 * module preloaded, and streams what it prints until it exits or the client
 * goes away (which quits it, like Stop in Xcode).
 */
export async function opElectronLaunch(params: ElectronLaunchParams, io: AgentIO): Promise<ElectronLaunchResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  const { plan } = params;
  const appDir = appDirOf(paths, plan);
  const env = await toolEnv();
  const hook = await ensureHook();
  await runDir(params.projectId);
  const socket = socketPath(params.projectId);
  const recordFile = socket.replace(/\.sock$/, '.json');
  await stopLeftover(recordFile);
  await fs.rm(socket, { force: true }).catch(() => undefined);
  // A new launch opens behind whatever the Mac shows; a live-reload restart of an app someone was using there comes back in front.
  if (!params.restart) await fs.rm(frontFile(socket), { force: true }).catch(() => undefined);

  const dev = params.mode === 'live' ? plan.dev : null;
  let command: string;
  let args: string[];
  let direct = false;
  if (dev) {
    command = '/bin/sh';
    args = ['-c', dev.command];
  } else if ('electron' in plan.launch) {
    const electron = await findElectron(appDir, paths.src);
    if (!electron?.binary) throw new AgentError('Electron is not installed for this Mac yet.', 'ELECTRON_LAUNCH_FAILED', 'Run again: CapMac installs it first.');
    command = electron.binary;
    args = plan.launch.electron;
    direct = true;
  } else {
    command = '/bin/sh';
    args = ['-c', plan.launch.command];
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_OPTIONS: withHook(env.NODE_OPTIONS, hook),
    [ENV_SOCKET]: socket,
    [ENV_PROJECT]: paths.project,
    [ENV_SOUND]: isSoundMode(params.sound) ? params.sound : 'off',
    ...(params.liveUrl ? { [ENV_LIVE_URL]: params.liveUrl, [ENV_LIVE_SCHEME]: 'capacitor-electron' } : {}),
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  let child: ChildProcess | null = null;
  let ready = false;
  let hello = false;
  // The app's dialogs, for the console and the terminal (answered with `electron-dialog`).
  const dialogWatch = new DialogWatch(dialogSocket(socket), (dialogs, closed) => io.send({ t: 'electron', event: { e: 'dialogs', dialogs, closed } }));
  const announce = (data: unknown) => {
    if (ready) return;
    ready = true;
    io.send({ t: 'ready', data });
  };
  const onHook = (event: HookEvent) => {
    if (event.e === 'hello') {
      hello = true;
      if (event.dialogs) void dialogWatch.connect();
      // An app with no window (a tray app) is running all the same.
      setTimeout(() => announce({ windows: 0 }), 8000).unref();
    }
    if (event.e === 'window') announce({ window: event.window.id });
    io.send({ t: 'electron', event });
  };
  // Dev commands build first; a plain launch shows its window within seconds.
  const fallback = setTimeout(() => {
    if (!hello) io.log('warn', 'CapMac’s module did not load in the app, so its windows and its pages’ console are not available. A packaged app, or a launcher that drops NODE_OPTIONS, keeps it out.');
    announce({ hook: hello });
  }, dev || !direct ? 90_000 : 25_000);

  io.onMessage((message) => {
    const control = message as ElectronControl;
    if (control?.t !== 'control' || typeof control.id !== 'number') return;
    if (control.action === 'sound' && !isSoundMode(control.mode)) {
      io.send({ t: 'control-result', id: control.id, ok: false, error: 'Not a sound setting' });
      return;
    }
    if (control.action === 'input') {
      const ok = Boolean(child?.stdin?.writable && child.stdin.write(String(control.text ?? '')));
      io.send({ t: 'control-result', id: control.id, ok });
      return;
    }
    controlRequest(socket, control).then(
      (data) => io.send({ t: 'control-result', id: control.id, ok: true, data }),
      (err) => io.send({ t: 'control-result', id: control.id, ok: false, error: String((err as Error)?.message ?? err) }),
    );
  });

  try {
    const result = await run(command, args, {
      cwd: appDir,
      env: childEnv,
      signal: io.signal,
      capture: false,
      keepStdinOpen: true,
      // Electron shuts its own helper processes down (killing the group first makes them report crashes).
      quitChildFirst: direct,
      tailLines: 30,
      onSpawn: (spawned) => {
        child = spawned;
        const pid = spawned.pid;
        if (pid) {
          void processStarted(pid).then((started) => {
            if (started) return fs.writeFile(recordFile, JSON.stringify({ pid, started } satisfies RunningRecord));
          }).catch(() => undefined);
        }
      },
      onLine: (line, stream) => {
        const parsed = parseAppLine(line);
        if (parsed.kind === 'hook') {
          onHook(parsed.event);
          return;
        }
        if (!parsed.text.trim() && parsed.kind === 'other') return;
        const source = parsed.kind === 'main' ? 'main' : CHROMIUM_LOG.test(parsed.text) ? 'chromium' : direct ? 'main' : 'tool';
        io.send({ t: 'app', stream, text: parsed.text, source });
      },
    });
    if (result.cancelled) return { reason: 'cancelled', exitCode: null };
    if (!ready && result.code !== 0) {
      const tail = result.tail.map(parseAppLine).flatMap((line) => (line.kind === 'hook' ? [] : [line.text])).slice(-15);
      throw new AgentError(`The app stopped before it opened a window (exit ${result.code ?? result.signal}).`, 'ELECTRON_LAUNCH_FAILED', 'Its output is in the console.', tail);
    }
    return { reason: 'exited', exitCode: result.code };
  } finally {
    clearTimeout(fallback);
    dialogWatch.close();
    await fs.rm(recordFile, { force: true }).catch(() => undefined);
    await fs.rm(socket, { force: true }).catch(() => undefined);
  }
}

// ─── The app's windows as a screen ────────────────────────────────────────

/** What the screen shows of a window, in the shape the simulator's screen uses. */
function screenInfoFor(window: AppWindowInfo | undefined, codec: AppCodec): ScreenInfo {
  return {
    t: 'screen',
    source: 'app',
    codec,
    points: window ? { width: window.width, height: window.height } : null,
    scale: window?.scale,
    input: Boolean(window),
    inputMode: 'mouse',
  };
}

/**
 * Relays the app's windows and input. The smooth stream (codec 'h264') is
 * video the app encodes, paced like a simulator's (VideoPacer: frames dropped
 * on a slow network, keyframes, adaptive bitrate); the compatible one is JPEG
 * frames from the app's compositor, at most two in flight. The app says which
 * one comes (it falls back to JPEG by itself). Waits for the app when it is
 * not running, and follows it across restarts.
 */
export async function opElectronScreen(params: ElectronScreenParams, io: AgentIO): Promise<{ frames: number }> {
  const socket = socketPath(params.projectId);
  const options = {
    maxSize: clampInt(params.maxSize, 320, 4096, 1400),
    fps: clampInt(params.fps, 1, 60, 30),
    quality: clampInt(params.quality, 30, 95, 72),
    audio: Boolean(params.audio),
    codec: (params.codec === 'h264' ? 'h264' : 'jpeg') as AppCodec,
  };
  const pacer = new VideoPacer(params);
  /** What the app sends now (its `codec` message), and whether it can send video at all (its hello). */
  let codec: AppCodec = 'jpeg';
  let canVideo = false;
  let videoSeq = 0;
  let pinned: number | null = typeof params.window === 'number' ? params.window : null;
  let conn: HookConnection | null = null;
  let frames = 0;
  let lastHeard = Date.now();
  let waiting: boolean | null = null;
  let lastInfo = '';
  let lastWindow: AppWindowInfo | undefined;
  // Input that arrives while CapMac (re)attaches to the app goes out once it is attached, if still recent.
  let attached = false;
  let early: Array<{ event: AppInputEvent; at: number }> = [];
  const setWaiting = (value: boolean) => {
    if (waiting === value) return;
    waiting = value;
    io.send({ t: 'app-waiting', waiting: value });
  };
  const watch = () => conn?.send({ t: 'watch', window: pinned, ...options, bitrate: pacer.bitrate.current });
  const sendInfo = () => {
    const info = screenInfoFor(lastWindow, codec);
    const key = JSON.stringify(info);
    if (key === lastInfo) return;
    lastInfo = key;
    io.send(info);
  };
  // The app's dialogs, shown over its window and answered there.
  const dialogWatch = new DialogWatch(dialogSocket(socket), (dialogs, closed) => io.send({ t: 'app-dialogs', dialogs, closed }));

  io.onMessage((message) => {
    lastHeard = Date.now();
    switch (message?.t) {
      case 'dialog-answer':
      case 'dialog-list':
      case 'dialog-mkdir': {
        const req = Number(message.req) || 0;
        const request: WithoutId<DialogRequest> = message.t === 'dialog-answer'
          ? { t: 'dialog-answer', dialog: Number(message.dialog), answer: message.answer as AppDialogAnswer }
          : message.t === 'dialog-list'
            ? { t: 'dialog-list', path: String(message.path ?? '~'), hidden: Boolean(message.hidden) }
            : { t: 'dialog-mkdir', path: String(message.path ?? '') };
        dialogWatch.request(request).then(
          (data) => io.send({ t: 'app-dialog-reply', req, ok: true, data }),
          (err) => io.send({ t: 'app-dialog-reply', req, ok: false, error: String((err as Error)?.message ?? err) }),
        );
        break;
      }
      case 'ping':
        io.send({ t: 'pong', id: Number(message.id) || 0, pc: Number(message.pc) || 0, mac: nowUs() });
        break;
      case 'input':
        if (!message.event) break;
        if (conn && attached) {
          conn.send({ t: 'input', event: message.event });
        } else {
          early.push({ event: message.event as AppInputEvent, at: Date.now() });
          if (early.length > 200) early.shift();
        }
        break;
      case 'size':
        options.maxSize = clampInt(message.maxSize, 320, 4096, options.maxSize);
        watch();
        break;
      case 'window':
        pinned = typeof message.window === 'number' ? message.window : null;
        watch();
        break;
      case 'window-action':
        if (typeof message.window === 'number' && ['close', 'minimize', 'zoom'].includes(message.action)) conn?.send({ t: 'window-action', window: message.window, action: message.action });
        break;
      case 'sound':
        // The app tells every screen where its sound plays now (app-sound).
        if (isSoundMode(message.mode)) conn?.send({ t: 'sound', id: 0, mode: message.mode });
        break;
      case 'audio':
        options.audio = Boolean(message.on);
        watch();
        break;
      // Video: frames that reached the client, a decoder that needs a keyframe, and trying video again after a fallback.
      case 'ack':
        if (Number.isInteger(message.seq)) pacer.ack(message.seq);
        break;
      case 'keyframe':
        conn?.send({ t: 'keyframe' });
        break;
      case 'retry-smooth':
        options.codec = 'h264';
        conn?.send({ t: 'retry-video' });
        watch();
        break;
    }
  });

  while (!io.signal.aborted && Date.now() - lastHeard < CLIENT_TIMEOUT_MS) {
    conn = await HookConnection.connect(socket, 2000).catch(() => null);
    if (!conn) {
      setWaiting(true);
      await sleep(500, io.signal);
      continue;
    }
    const current = conn;
    // A new app (or the same one restarted): its video starts over from a keyframe.
    pacer.restart();
    current.onMessage = (message: HookMessage, binary?: Buffer) => {
      switch (message.t) {
        case 'hello': {
          setWaiting(false);
          attached = true;
          canVideo = message.app.h264 === true;
          if (message.app.dialogs) void dialogWatch.connect();
          const recent = early.filter((item) => Date.now() - item.at < 5000);
          early = [];
          for (const item of recent) current.send({ t: 'input', event: item.event });
          break;
        }
        case 'windows': {
          lastWindow = message.windows.find((w) => w.id === message.watched);
          io.send({ t: 'app-windows', windows: message.windows, watched: message.watched });
          sendInfo();
          break;
        }
        case 'codec':
          codec = message.codec === 'h264' ? 'h264' : 'jpeg';
          // An app that cannot send video at all (too old, no encoder), or a window that could not be captured this time.
          io.send({ t: 'app-codec', codec, fallback: message.reason ? { code: canVideo ? 'error' : 'unsupported', message: message.reason } : null });
          sendInfo();
          break;
        case 'frame':
          if (!binary) break;
          frames += 1;
          // Taken by the SSH channel: the app may send the next one.
          void io.sendBinary(binary, true).then(() => current.send({ t: 'ack' }));
          break;
        case 'video': {
          const header = binary ? parseStreamHeader(binary) : null;
          if (!binary || !header || codec !== 'h264') break;
          // Numbered for this screen: a restarted app counts from 1 again, and the PC acknowledges by the highest number.
          if (header.type === STREAM_FRAME) videoSeq += 1;
          header.seq = videoSeq;
          binary.writeUInt32BE(videoSeq >>> 0, 12);
          // Sent as it comes, unless the way to the PC is slow (then deltas wait for the next keyframe).
          if (pacer.offer(header, io.backlog)) io.sendLive(binary);
          break;
        }
        case 'cursor':
          io.send({ t: 'app-cursor', cursor: message.cursor });
          break;
        case 'clipboard':
          io.send({ t: 'app-clipboard', text: message.text });
          break;
        case 'sound':
          io.send({ t: 'app-sound', mode: message.mode, toPc: message.toPc });
          break;
        case 'audio':
          io.send({ t: 'app-audio', packets: message.packets });
          break;
      }
    };
    current.send({ t: 'hello', role: 'screen' });
    watch();
    const stop = () => current.close();
    io.signal.addEventListener('abort', stop, { once: true });
    const quiet = setInterval(() => {
      if (Date.now() - lastHeard > CLIENT_TIMEOUT_MS) current.close();
    }, 1000);
    // Video: a keyframe once the way is clear after drops, adaptive bitrate, and how it goes every few seconds.
    const pacing = setInterval(() => {
      if (codec !== 'h264') return;
      const pace = pacer.tick(io.backlog);
      if (pace.keyframe) current.send({ t: 'keyframe' });
      if (pace.bitrate) current.send({ t: 'bitrate', bitrate: pace.bitrate });
      if (pace.status) io.send({ t: 'stream-status', footprint: 0, fps: pace.status.fps, dropped: pace.status.dropped, bitrate: pacer.bitrate.current });
    }, 100);
    await current.done;
    clearInterval(quiet);
    clearInterval(pacing);
    io.signal.removeEventListener('abort', stop);
    conn = null;
    attached = false;
    lastInfo = '';
    // The app quit or restarted (live reload): wait for the next one.
    if (!io.signal.aborted) {
      setWaiting(true);
      io.send({ t: 'app-windows', windows: [], watched: null });
      await sleep(300, io.signal);
    }
  }
  dialogWatch.close();
  return { frames: frames + pacer.frames };
}

/** A PNG of the app's window (the one showing, or `window`), at full resolution. */
export async function opElectronScreenshot(params: { projectId: string; window?: number }, io: AgentIO): Promise<{ bytes: number; width: number; height: number }> {
  const conn = await HookConnection.connect(socketPath(params.projectId)).catch(() => {
    throw new AgentError('The app is not running.', 'APP_NOT_RUNNING', 'Start it with Run or Live first.');
  });
  try {
    conn.send({ t: 'hello', role: 'control' });
    const { message, binary } = await conn.request({ t: 'screenshot', id: 1, window: params.window }, 20_000);
    if (message.t !== 'screenshot' || !binary) {
      throw new AgentError(message.t === 'result' && message.error ? message.error : 'The app did not take the screenshot.', 'APP_NOT_RUNNING');
    }
    await io.sendBinary(binary);
    return { bytes: binary.length, width: message.width, height: message.height };
  } finally {
    conn.close();
  }
}

/**
 * The app's dialogs from the terminal (the screen relays its own): the ones
 * open now, an answer to one, or a folder listed or made for one.
 */
export async function opElectronDialog(
  params: { projectId: string; action: 'dialogs' | 'answer' | 'list' | 'mkdir'; dialog?: number; answer?: AppDialogAnswer; path?: string; hidden?: boolean },
  _io: AgentIO,
): Promise<unknown> {
  const conn = await HookConnection.connect(dialogSocket(socketPath(params.projectId))).catch(() => {
    throw new AgentError('The app is not running.', 'APP_NOT_RUNNING', 'Start it with Run or Live first.');
  });
  try {
    if (params.action === 'dialogs') {
      // The worker answers hello with the dialogs open now.
      return await new Promise<AppDialog[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new AgentError('The app did not answer.', 'APP_NOT_RUNNING')), 5000);
        conn.onMessage = (message) => {
          if (message.t !== 'dialogs') return;
          clearTimeout(timer);
          resolve(message.dialogs);
        };
        conn.send({ t: 'hello', role: 'control' });
      });
    }
    const request: DialogRequest = params.action === 'answer'
      ? { t: 'dialog-answer', id: 1, dialog: Number(params.dialog), answer: params.answer as AppDialogAnswer }
      : params.action === 'list'
        ? { t: 'dialog-list', id: 1, path: String(params.path ?? '~'), hidden: Boolean(params.hidden) }
        : { t: 'dialog-mkdir', id: 1, path: String(params.path ?? '') };
    const { message } = await conn.request(request, 15_000);
    if (message.t !== 'result') throw new AgentError('Unexpected answer from the app.', 'BAD_REQUEST');
    if (!message.ok) throw new AgentError(message.error ?? 'The app could not do that.', 'BAD_REQUEST');
    return message.data ?? null;
  } finally {
    conn.close();
  }
}
