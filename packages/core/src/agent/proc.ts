import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

export class AgentError extends Error {
  constructor(message: string, readonly code?: string, readonly hint?: string, readonly tail?: string[], readonly logPath?: string) {
    super(message);
  }
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  input?: string | Buffer;
  /** Called for every complete output line (trailing \r stripped). */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  timeoutMs?: number;
  /** Keep full stdout/stderr text in the result (default true, capped). */
  capture?: boolean;
  /** Lines of output kept for error reports. */
  tailLines?: number;
  /** Keep the child's stdin open instead of closing it right away (for `script`-wrapped tools). */
  keepStdinOpen?: boolean;
  /** Called with the child once it started (to write to its stdin later). */
  onSpawn?: (child: ChildProcess) => void;
  /**
   * Stopping asks the child alone to quit (SIGTERM), so it can shut down what
   * it started itself (an app's helper processes); the whole group is killed
   * only if it is still there after a few seconds.
   */
  quitChildFirst?: boolean;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  tail: string[];
  cancelled: boolean;
  timedOut: boolean;
}

const live = new Set<ChildProcess>();
const MAX_CAPTURE = 8 * 1024 * 1024;

function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(sig);
    else process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

/** Kills every child still running (called when the agent exits). */
export function killAll(): void {
  for (const child of live) killTree(child, 'SIGKILL');
}

/** A child spawned elsewhere that must not outlive the agent either. */
export function trackChild(child: ChildProcess): void {
  live.add(child);
  child.once('exit', () => live.delete(child));
}

process.on('exit', killAll);

/**
 * Spawns a process in its own process group (so cancelling kills the whole
 * tree: xcodebuild, pod, npm and friends spawn plenty of children).
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', tail: [], cancelled: true, timedOut: false });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    live.add(child);
    options.onSpawn?.(child);
    const capture = options.capture ?? true;
    const tailMax = options.tailLines ?? 60;
    const tail: string[] = [];
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    let timedOut = false;
    const partial = { stdout: '', stderr: '' };

    const pushLine = (line: string, stream: 'stdout' | 'stderr') => {
      tail.push(line);
      if (tail.length > tailMax) tail.shift();
      options.onLine?.(line, stream);
    };

    const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (capture) {
        if (stream === 'stdout' && stdout.length < MAX_CAPTURE) stdout += text;
        if (stream === 'stderr' && stderr.length < MAX_CAPTURE) stderr += text;
      }
      const combined = partial[stream] + text;
      const lines = combined.split('\n');
      partial[stream] = lines.pop() ?? '';
      for (const line of lines) pushLine(line.replace(/\r$/, ''), stream);
    };

    child.stdout!.on('data', onData('stdout'));
    child.stderr!.on('data', onData('stderr'));
    child.stdin!.on('error', () => undefined);
    if (options.input !== undefined) child.stdin!.end(options.input);
    else if (!options.keepStdinOpen) child.stdin!.end();

    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (options.quitChildFirst && child.pid && process.platform !== 'win32') {
        try {
          child.kill('SIGTERM');
        } catch {
          // gone already
        }
        // Whatever is left of the group (the child may be gone, its helpers not): until 'close' clears this.
        const group = child.pid;
        killTimer = setTimeout(() => {
          try {
            process.kill(-group, 'SIGKILL');
          } catch {
            // nothing left
          }
        }, 5000);
        killTimer.unref();
        return;
      }
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 4000);
      killTimer.unref();
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeoutMs)
      : undefined;

    child.on('error', (err) => {
      live.delete(child);
      options.signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code, signal) => {
      live.delete(child);
      options.signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      for (const stream of ['stdout', 'stderr'] as const) {
        if (partial[stream]) pushLine(partial[stream].replace(/\r$/, ''), stream);
      }
      resolve({ code, signal, stdout, stderr, tail, cancelled, timedOut });
    });
  });
}

/** Runs a command and returns trimmed stdout; throws AgentError on failure. */
export async function capture(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(command, args, { timeoutMs: 120_000, ...options });
  if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n');
    throw new AgentError(`${path.basename(command)} ${args.join(' ')} failed (exit ${result.code ?? result.signal})${detail ? `:\n${detail}` : ''}`, undefined, undefined, result.tail);
  }
  return result.stdout.trim();
}

/** Like capture() but returns null instead of throwing. */
export async function tryCapture(command: string, args: string[], options: RunOptions = {}): Promise<string | null> {
  try {
    return await capture(command, args, { timeoutMs: 30_000, ...options });
  } catch {
    return null;
  }
}

export async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.X_OK);
    const st = await fs.stat(file);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Resolves a command name against PATH from `env`. */
export async function which(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (name.includes('/')) return (await isExecutable(name)) ? name : null;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Parses JSON that may be preceded or followed by tool chatter (simctl does this sometimes). */
export function parseJsonLoose<T = any>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
