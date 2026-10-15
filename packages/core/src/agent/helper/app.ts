/**
 * A helper that runs as a background app on the Mac (devstream inside
 * CapMac.app). LaunchServices starts it in the logged-in user's session, so
 * macOS can ask the person at the Mac for camera access for it (an iOS screen
 * is a camera to macOS, and a program started over SSH could not be asked).
 * It never comes to the front (`open -g -j`, and the app has no Dock icon),
 * and talks to the agent over a Unix socket the agent listens on: when the
 * socket closes, the helper quits, so it never outlives the agent.
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { HelperHello } from '../../shared/stream.js';
import { capmacHome } from '../env.js';
import { AgentError, run, sleep } from '../proc.js';
import { HelperReader, type HelperExit, type HelperHandlers, type StreamHelper } from './process.js';

/** LaunchServices starting the app and the app calling back take a second or two. */
const CONNECT_TIMEOUT_MS = 20_000;

let launches = 0;

/** Unix socket paths are short (104 bytes on macOS): the agent's own folder, else the temporary one. */
async function socketDir(): Promise<string> {
  const preferred = path.join(capmacHome(), 'run');
  const dir = preferred.length < 70 ? preferred : path.join(os.tmpdir(), `capmac-${process.getuid?.() ?? 'run'}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The last lines of the helper's log. */
async function logTail(file: string, lines = 12): Promise<string[]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-lines);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

export class AppHelper implements StreamHelper {
  readonly exited: Promise<HelperExit>;
  readonly hello: Promise<HelperHello | null>;
  private alive = true;
  /** From the helper's first message: to make sure it is gone once the socket closes. */
  private pid = 0;

  private constructor(private readonly socket: net.Socket, handlers: HelperHandlers, logFile: string) {
    let resolveHello!: (hello: HelperHello | null) => void;
    this.hello = new Promise((resolve) => (resolveHello = resolve));
    const reader = new HelperReader(
      {
        ...handlers,
        onEvent: (event) => {
          if (event.t === 'started') this.pid = event.pid;
          else handlers.onEvent?.(event);
        },
      },
      (hello) => resolveHello(hello),
    );
    socket.on('data', (chunk: Buffer) => {
      if (!reader.push(chunk)) socket.destroy();
    });
    socket.on('error', () => undefined);
    this.exited = new Promise((resolve) => {
      socket.once('close', () => {
        this.alive = false;
        resolveHello(null);
        void (async () => {
          await this.reap();
          const stderr = await logTail(logFile, 40);
          // Before saying it is over: the agent may exit right after.
          await fs.rm(logFile, { force: true }).catch(() => undefined);
          resolve({ code: null, signal: null, fatal: reader.fatal, stderr });
        })();
      });
    });
  }

  /**
   * Starts `app` with `args` and waits until it calls back. Throws when the
   * Mac does not open it (nobody logged in at the Mac, for one) or it never
   * calls.
   */
  static async launch(app: string, args: string[], handlers: HelperHandlers, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<AppHelper> {
    const dir = await socketDir();
    const id = `${process.pid}-${++launches}`;
    const socketPath = path.join(dir, `screen-${id}.sock`);
    const logFile = path.join(dir, `screen-${id}.log`);
    await fs.rm(socketPath, { force: true });
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const connected = new Promise<net.Socket | null>((resolve) => {
        server.once('connection', resolve);
        timer = setTimeout(() => resolve(null), CONNECT_TIMEOUT_MS);
        signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      // -g: not to the front; -j: hidden; -n: a new copy even if another stream has one running.
      const opened = await run('open', ['-g', '-j', '-n', '-a', app, '--args', '--socket', socketPath, '--log', logFile, ...args], { env, signal, timeoutMs: 30_000 });
      if (opened.cancelled || signal.aborted) throw new AgentError('Cancelled', 'CANCELLED');
      if (opened.code !== 0) {
        throw new AgentError(
          "The Mac did not open CapMac's screen helper.",
          'HELPER_START_FAILED',
          'Someone has to be logged in at the Mac itself, not only over the network.',
          opened.tail.slice(-6),
        );
      }
      const socket = await connected;
      if (signal.aborted) throw new AgentError('Cancelled', 'CANCELLED');
      if (!socket) throw new AgentError("CapMac's screen helper did not start.", 'HELPER_START_FAILED', undefined, await logTail(logFile));
      return new AppHelper(socket, handlers, logFile);
    } finally {
      clearTimeout(timer);
      // Connected or not, nobody else may call: the helper has its connection.
      server.close();
      await fs.rm(socketPath, { force: true }).catch(() => undefined);
    }
  }

  get running(): boolean {
    return this.alive;
  }

  send(line: string): void {
    if (this.alive && this.socket.writable) this.socket.write(`${line}\n`);
  }

  /** The socket closes as the helper quits; this makes sure it really did. */
  private async reap(): Promise<void> {
    const pid = this.pid;
    if (!pid) return;
    for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(50);
    if (!isAlive(pid)) return;
    signalPid(pid, 'SIGTERM');
    for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(50);
    if (isAlive(pid)) signalPid(pid, 'SIGKILL');
  }

  /** Stops the helper: the socket closes, the helper stops capturing and quits (else it is signalled). */
  async stop(): Promise<HelperExit> {
    if (this.alive) {
      this.socket.end();
      const timer = setTimeout(() => this.socket.destroy(), 3000);
      const result = await this.exited;
      clearTimeout(timer);
      return result;
    }
    return this.exited;
  }
}
