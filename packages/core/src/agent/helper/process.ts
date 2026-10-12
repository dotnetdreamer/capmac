/**
 * A running helper (simstream): its stdout split into messages, its events
 * parsed, commands written to its stdin. Stopping it closes stdin first (it
 * lifts any finger still down and exits), then signals; it never outlives the
 * agent.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { parseHelperEvent, parseStreamHeader, STREAM_CONFIG, STREAM_EVENT, STREAM_FRAME, StreamSplitter, type HelperHello, type HelperStatus, type StreamHeader } from '../../shared/stream.js';
import { trackChild } from '../proc.js';

export interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** What the helper said before it gave up (`fatal` event). */
  fatal?: { code: string; message: string };
  /** Its last log lines. */
  stderr: string[];
}

export interface HelperHandlers {
  /** A config or frame message, as the helper wrote it (without the length prefix). */
  onVideo?(message: Buffer, header: StreamHeader): void;
  onStatus?(status: HelperStatus): void;
  onInputError?(message: string): void;
}

export class HelperProcess {
  readonly exited: Promise<HelperExit>;
  /** Resolves with the helper's hello, or with null when it exits first. */
  readonly hello: Promise<HelperHello | null>;
  private readonly child: ChildProcess;
  private alive = true;
  private readonly stderr: string[] = [];
  private fatal: HelperExit['fatal'];

  constructor(binary: string, args: string[], handlers: HelperHandlers, env: NodeJS.ProcessEnv) {
    this.child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    trackChild(this.child);
    let resolveHello!: (hello: HelperHello | null) => void;
    this.hello = new Promise((resolve) => (resolveHello = resolve));
    const splitter = new StreamSplitter();
    this.child.stdout!.on('data', (chunk: Buffer) => {
      let messages: Uint8Array[];
      try {
        messages = splitter.push(chunk);
      } catch {
        this.kill();
        return;
      }
      for (const m of messages) {
        const header = parseStreamHeader(m);
        if (!header) continue;
        if (header.type === STREAM_FRAME || header.type === STREAM_CONFIG) {
          handlers.onVideo?.(Buffer.from(m.buffer, m.byteOffset, m.byteLength), header);
        } else if (header.type === STREAM_EVENT) {
          const event = parseHelperEvent(m);
          if (event?.t === 'hello') resolveHello(event);
          else if (event?.t === 'status') handlers.onStatus?.(event);
          else if (event?.t === 'input-error') handlers.onInputError?.(event.message);
          else if (event?.t === 'fatal') this.fatal = { code: event.code, message: event.message };
        }
      }
    });
    let partial = '';
    this.child.stderr!.on('data', (chunk: Buffer) => {
      const lines = (partial + chunk.toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.stderr.push(line.trimEnd());
      if (this.stderr.length > 40) this.stderr.splice(0, this.stderr.length - 40);
    });
    this.child.stdin!.on('error', () => undefined);
    this.exited = new Promise((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        this.alive = false;
        resolveHello(null);
        resolve({ code, signal, fatal: this.fatal, stderr: [...this.stderr] });
      };
      this.child.once('exit', done);
      this.child.once('error', (err) => {
        this.stderr.push(err.message);
        done(null, null);
      });
    });
  }

  get running(): boolean {
    return this.alive;
  }

  /** Writes one command line (see simstream.m). */
  send(line: string): void {
    if (this.alive && this.child.stdin?.writable) this.child.stdin.write(`${line}\n`);
  }

  private kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    try {
      this.child.kill(signal);
    } catch {
      // already gone
    }
  }

  /** Stops the helper: end of stdin, then SIGTERM, then SIGKILL. */
  async stop(): Promise<HelperExit> {
    if (this.alive) {
      try {
        this.child.stdin?.end();
      } catch {
        // already closed
      }
      const term = setTimeout(() => this.kill('SIGTERM'), 1500);
      const kill = setTimeout(() => this.kill('SIGKILL'), 4000);
      const result = await this.exited;
      clearTimeout(term);
      clearTimeout(kill);
      return result;
    }
    return this.exited;
  }
}
