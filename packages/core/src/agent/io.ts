import type { Readable, Writable } from 'node:stream';
import { AGENT_MAGIC, BINARY_CHUNK_BYTES, encodeBinary, encodeJson, FrameDecoder, type Frame } from '../shared/frames.js';
import type { AgentEvent } from '../shared/protocol.js';

/**
 * The agent's side of the SSH channel. stdin carries frames from the client;
 * stdout carries frames back. When stdin ends the client is gone, so
 * `signal` aborts and every running operation should stop.
 */
export class AgentIO {
  private readonly decoder = new FrameDecoder();
  private readonly queue: Frame[] = [];
  private readonly waiters: Array<(frame: Frame | null) => void> = [];
  private messageListener: ((value: any) => void) | null = null;
  private ended = false;
  private readonly controller = new AbortController();
  private broken = false;

  constructor(input: Readable, private readonly output: Writable) {
    input.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = this.decoder.push(chunk);
      } catch {
        this.finish();
        return;
      }
      for (const frame of frames) this.deliver(frame);
    });
    input.on('end', () => this.finish());
    input.on('error', () => this.finish());
    output.on('error', () => {
      this.broken = true;
      this.finish();
    });
    output.write(AGENT_MAGIC);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get closed(): boolean {
    return this.ended;
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    this.controller.abort();
  }

  private deliver(frame: Frame): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    if (frame.kind === 'json' && this.messageListener) {
      this.messageListener(frame.value);
      return;
    }
    this.queue.push(frame);
  }

  /** Next frame from the client, or null once the client disconnected. */
  next(): Promise<Frame | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async nextJson<T = any>(expectType?: string): Promise<T> {
    const frame = await this.next();
    if (!frame) throw new Error('Client disconnected');
    if (frame.kind !== 'json') throw new Error('Expected a JSON message, got binary data');
    if (expectType && frame.value?.t !== expectType) {
      throw new Error(`Expected "${expectType}" message, got "${frame.value?.t}"`);
    }
    return frame.value as T;
  }

  /** Yields binary frames until a JSON message `{ t: endType }` arrives. */
  async *binaryUntil(endType: string): AsyncGenerator<Buffer> {
    for (;;) {
      const frame = await this.next();
      if (!frame) throw new Error('Client disconnected during transfer');
      if (frame.kind === 'binary') {
        yield frame.data;
        continue;
      }
      if (frame.value?.t === endType) return;
      throw new Error(`Unexpected "${frame.value?.t}" message during transfer`);
    }
  }

  /** Routes JSON messages that arrive from now on to `listener` (e.g. input events). */
  onMessage(listener: (value: any) => void): void {
    this.messageListener = listener;
    for (let i = 0; i < this.queue.length; ) {
      const frame = this.queue[i]!;
      if (frame.kind === 'json') {
        this.queue.splice(i, 1);
        listener(frame.value);
      } else {
        i += 1;
      }
    }
  }

  send(event: AgentEvent): void {
    if (this.broken) return;
    this.output.write(encodeJson(event));
  }

  /**
   * Sends binary data, waiting for the pipe to drain so memory stays bounded.
   * Stream data (archives) may be split into chunks; a `whole` message (one
   * JPEG frame) always arrives as a single binary frame.
   */
  async sendBinary(data: Buffer, whole = false): Promise<void> {
    if (whole) {
      if (this.broken) return;
      if (!this.output.write(encodeBinary(data))) await this.drain();
      return;
    }
    for (let offset = 0; offset < data.length || offset === 0; offset += BINARY_CHUNK_BYTES) {
      if (this.broken) return;
      const ok = this.output.write(encodeBinary(data.subarray(offset, offset + BINARY_CHUNK_BYTES)));
      if (!ok) await this.drain();
      if (data.length === 0) break;
    }
  }

  /**
   * Sends one binary frame without waiting for the pipe (live video: the
   * caller watches `backlog` and drops frames instead of falling behind).
   */
  sendLive(data: Buffer): void {
    if (this.broken || this.ended) return;
    this.output.write(encodeBinary(data));
  }

  /** Bytes written but not yet taken by the SSH channel. */
  get backlog(): number {
    return (this.output as Writable & { writableLength?: number }).writableLength ?? 0;
  }

  private drain(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.output.off('drain', done);
        this.output.off('error', done);
        clearInterval(timer);
        resolve();
      };
      // Also resolve if the client went away; nothing will ever drain then.
      const timer = setInterval(() => {
        if (this.broken || this.ended) done();
      }, 250);
      this.output.on('drain', done);
      this.output.on('error', done);
    });
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
    this.send({ t: 'log', level, msg });
  }

  /** Resolves once everything written so far has been handed to the OS. */
  flush(): Promise<void> {
    if (this.broken) return Promise.resolve();
    return new Promise((resolve) => this.output.write('', () => resolve()));
  }
}

/** Runs `fn` as a named step, reporting start/end (with timing) to the client. */
export async function step<T>(io: AgentIO, id: string, title: string, fn: () => Promise<T>, detail?: (value: T) => string | undefined): Promise<T> {
  const started = Date.now();
  io.send({ t: 'step', id, title });
  try {
    const value = await fn();
    io.send({ t: 'step-end', id, ok: true, ms: Date.now() - started, detail: detail?.(value) });
    return value;
  } catch (err) {
    io.send({ t: 'step-end', id, ok: false, ms: Date.now() - started });
    throw err;
  }
}
