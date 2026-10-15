/**
 * A running helper (simstream): its stdout split into messages, its events
 * parsed, commands written to its stdin. Stopping it closes stdin first (it
 * lifts any finger still down and exits), then signals; it never outlives the
 * agent.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { parseHelperEvent, parseStreamHeader, STREAM_CONFIG, STREAM_EVENT, STREAM_FRAME, STREAM_HEADER_BYTES, STREAM_STILL, StreamSplitter, type HelperEvent, type HelperHello, type HelperStatus, type StreamHeader } from '../../shared/stream.js';
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
  /** A still: the whole message, header and PNG (devstream). */
  onStill?(message: Buffer): void;
  /** Any other event: devstream's wait, resume and still-error. */
  onEvent?(event: HelperEvent): void;
}

/** What the stream ops need from a helper, whichever way it runs. */
export interface StreamHelper {
  readonly exited: Promise<HelperExit>;
  /** Resolves with the helper's hello, or with null when it exits first. */
  readonly hello: Promise<HelperHello | null>;
  readonly running: boolean;
  /** Writes one command line (see simstream.m). */
  send(line: string): void;
  stop(): Promise<HelperExit>;
}

/** Reads a helper's output, chunk by chunk, and hands each message to its handler. */
export class HelperReader {
  /** The helper's last word (`fatal` event), if it said one. */
  fatal: HelperExit['fatal'];
  private readonly splitter = new StreamSplitter();

  constructor(private readonly handlers: HelperHandlers, private readonly onHello: (hello: HelperHello) => void) {}

  /** False when the output is corrupt: the helper should be stopped. */
  push(chunk: Buffer): boolean {
    let messages: Uint8Array[];
    try {
      messages = this.splitter.push(chunk);
    } catch {
      return false;
    }
    for (const m of messages) {
      const header = parseStreamHeader(m);
      if (!header) continue;
      if (header.type === STREAM_FRAME || header.type === STREAM_CONFIG) {
        this.handlers.onVideo?.(Buffer.from(m.buffer, m.byteOffset, m.byteLength), header);
      } else if (header.type === STREAM_STILL) {
        if (m.byteLength > STREAM_HEADER_BYTES) this.handlers.onStill?.(Buffer.from(m.buffer, m.byteOffset, m.byteLength));
      } else if (header.type === STREAM_EVENT) {
        const event = parseHelperEvent(m);
        if (event?.t === 'hello') this.onHello(event);
        else if (event?.t === 'status') this.handlers.onStatus?.(event);
        else if (event?.t === 'input-error') this.handlers.onInputError?.(event.message);
        else if (event?.t === 'fatal') this.fatal = { code: event.code, message: event.message };
        else if (event) this.handlers.onEvent?.(event);
      }
    }
    return true;
  }
}

/** Keeps the last few dozen lines of a log. */
export class LogTail {
  readonly lines: string[] = [];
  private partial = '';

  push(text: string): void {
    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) this.lines.push(line.trimEnd());
    if (this.lines.length > 40) this.lines.splice(0, this.lines.length - 40);
  }
}

export class HelperProcess implements StreamHelper {
  readonly exited: Promise<HelperExit>;
  readonly hello: Promise<HelperHello | null>;
  private readonly child: ChildProcess;
  private alive = true;
  private readonly stderr = new LogTail();

  constructor(binary: string, args: string[], handlers: HelperHandlers, env: NodeJS.ProcessEnv) {
    this.child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    trackChild(this.child);
    let resolveHello!: (hello: HelperHello | null) => void;
    this.hello = new Promise((resolve) => (resolveHello = resolve));
    const reader = new HelperReader(handlers, (hello) => resolveHello(hello));
    this.child.stdout!.on('data', (chunk: Buffer) => {
      if (!reader.push(chunk)) this.kill();
    });
    this.child.stderr!.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')));
    this.child.stdin!.on('error', () => undefined);
    this.exited = new Promise((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        this.alive = false;
        resolveHello(null);
        resolve({ code, signal, fatal: reader.fatal, stderr: [...this.stderr.lines] });
      };
      this.child.once('exit', done);
      this.child.once('error', (err) => {
        this.stderr.lines.push(err.message);
        done(null, null);
      });
    });
  }

  get running(): boolean {
    return this.alive;
  }

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
