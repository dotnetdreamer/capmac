import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ClientChannel } from 'ssh2';
import { encodeBinary, encodeJson, FrameDecoder, MagicScanner, BINARY_CHUNK_BYTES } from '../shared/frames.js';
import type { AgentErrorInfo, AgentEvent } from '../shared/protocol.js';
import { shQuote, type MacConnection } from './ssh.js';

export class AgentCallError extends Error {
  /** Reported with its hint and tool output, not as a crash. */
  readonly expected = true;
  readonly code?: string;
  readonly hint?: string;
  readonly tail?: string[];
  readonly logPath?: string;
  constructor(info: AgentErrorInfo) {
    super(info.message);
    this.code = info.code;
    this.hint = info.hint;
    this.tail = info.tail;
    this.logPath = info.logPath;
  }
}

export interface CallHandlers {
  onEvent?: (event: AgentEvent) => void;
  onBinary?: (data: Buffer) => void;
  signal?: AbortSignal;
}

let agentCache: { code: Buffer; hash: string } | null = null;
let agentPathOverride: string | null = null;

/** Tells the engine where agent.mjs lives (capmac Studio ships it in its resources folder). */
export function setAgentBundlePath(file: string): void {
  agentPathOverride = file;
  agentCache = null;
}

/** The bundled agent script (dist/agent.mjs) and its content hash. */
export function agentBundle(): { code: Buffer; hash: string } {
  if (agentCache) return agentCache;
  const override = agentPathOverride ?? process.env.CAPMAC_AGENT_PATH;
  const here = typeof import.meta.url === 'string' ? path.dirname(fileURLToPath(import.meta.url)) : process.cwd();
  const candidates = override ? [override] : [path.join(here, 'agent.mjs'), path.join(here, '..', 'dist', 'agent.mjs'), path.join(here, '..', '..', 'dist', 'agent.mjs')];
  for (const file of candidates) {
    try {
      const code = readFileSync(file);
      agentCache = { code, hash: createHash('sha256').update(code).digest('hex').slice(0, 16) };
      return agentCache;
    } catch {
      // try next
    }
  }
  throw new Error('The CapMac agent bundle is missing. Run `npm run build` in the CapMac folder.');
}

/** A running agent operation. */
export class AgentCall<T> {
  readonly result: Promise<T>;
  private readonly waiters = new Map<string, Array<(event: any) => void>>();
  private readonly early = new Map<string, any[]>();
  private finished = false;

  constructor(private readonly channel: ClientChannel, handlers: CallHandlers, describe: string) {
    const scanner = new MagicScanner();
    const decoder = new FrameDecoder();
    let stderr = '';
    this.result = new Promise<T>((resolve, reject) => {
      const settle = (fn: () => void) => {
        if (this.finished) return;
        this.finished = true;
        fn();
      };
      channel.on('data', (chunk: Buffer) => {
        try {
          const rest = scanner.push(chunk);
          if (rest === null) return;
          for (const frame of decoder.push(rest)) {
            if (frame.kind === 'binary') {
              handlers.onBinary?.(frame.data);
              continue;
            }
            const event = frame.value as AgentEvent;
            if (event.t === 'result') {
              if (event.ok) settle(() => resolve(event.data as T));
              else settle(() => reject(new AgentCallError(event.error)));
              continue;
            }
            this.dispatch(event);
            handlers.onEvent?.(event);
          }
        } catch (err) {
          settle(() => reject(err));
          channel.close();
        }
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-20_000);
      });
      channel.on('close', (code: number | null) => {
        settle(() => {
          const output = (stderr.trim() || scanner.partial.trim()).split('\n').slice(-12);
          const message = handlers.signal?.aborted
            ? 'Cancelled'
            : `The CapMac agent stopped unexpectedly during "${describe}" (exit ${code ?? 'unknown'}).`;
          reject(new AgentCallError({ message, code: handlers.signal?.aborted ? 'CANCELLED' : 'AGENT_CRASHED', tail: output }));
        });
      });
      channel.on('error', (err: Error) => settle(() => reject(err)));
    });
    this.result.catch(() => undefined);
    if (handlers.signal) {
      if (handlers.signal.aborted) this.cancel();
      else handlers.signal.addEventListener('abort', () => this.cancel(), { once: true });
    }
  }

  private dispatch(event: AgentEvent): void {
    const list = this.waiters.get(event.t);
    if (list && list.length > 0) {
      list.shift()!(event);
      return;
    }
    if (event.t === 'need' || event.t === 'ready' || event.t === 'archive-begin' || event.t === 'archive-end' || event.t === 'screen') {
      const queue = this.early.get(event.t) ?? [];
      queue.push(event);
      this.early.set(event.t, queue);
    }
  }

  /** Resolves with the next event of the given type (or rejects if the call ends first). */
  waitFor<E = any>(type: string): Promise<E> {
    const queued = this.early.get(type);
    if (queued && queued.length > 0) return Promise.resolve(queued.shift());
    return new Promise<E>((resolve, reject) => {
      const list = this.waiters.get(type) ?? [];
      list.push(resolve);
      this.waiters.set(type, list);
      this.result.then(
        () => reject(new Error(`Agent finished without sending "${type}"`)),
        (err) => reject(err),
      );
    });
  }

  send(message: object): void {
    if (!this.finished) this.channel.write(encodeJson(message));
  }

  async sendBinary(data: Buffer): Promise<void> {
    for (let offset = 0; offset < data.length; offset += BINARY_CHUNK_BYTES) {
      if (this.finished) return;
      const ok = this.channel.write(encodeBinary(data.subarray(offset, offset + BINARY_CHUNK_BYTES)));
      if (!ok) await new Promise<void>((resolve) => this.channel.once('drain', resolve));
    }
  }

  /** Asks the agent to stop (closing stdin aborts every running tool). */
  cancel(): void {
    if (this.finished) return;
    try {
      this.channel.end();
    } catch {
      // already closed
    }
    setTimeout(() => {
      if (!this.finished) this.channel.close();
    }, 5000).unref();
  }
}

export class AgentClient {
  private installed = false;
  private installing: Promise<void> | null = null;

  constructor(private readonly conn: MacConnection, private readonly nodePath: string, private readonly home: string) {}

  get agentPath(): string {
    return `${this.home}/.capmac/agent/${agentBundle().hash}/agent.mjs`;
  }

  /** Uploads the agent if this exact version is not on the Mac yet (once, however many calls start together). */
  ensureInstalled(): Promise<void> {
    if (this.installed) return Promise.resolve();
    this.installing ??= this.install().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  private async install(): Promise<void> {
    const bundle = agentBundle();
    const dir = `${this.home}/.capmac/agent/${bundle.hash}`;
    // Touching the folder marks this version as in use (see the cleanup below).
    const check = await this.conn.runScript(`[ -f ${shQuote(`${dir}/agent.mjs`)} ] && touch ${shQuote(dir)} && echo present || echo missing\n`, { timeoutMs: 30_000 });
    if (!check.stdout.includes('present')) {
      // A temporary name of its own: the CLI and CapMac Studio may upload the same version at once.
      const part = `${dir}/agent.mjs.${randomBytes(4).toString('hex')}.part`;
      const command = `/bin/sh -c ${shQuote(`mkdir -p ${shQuote(dir)} && cat > ${shQuote(part)} && mv -f ${shQuote(part)} ${shQuote(`${dir}/agent.mjs`)}`)}`;
      const upload = await this.conn.pipeTo(command, bundle.code);
      if (upload.code !== 0) throw new Error(`Could not install the CapMac agent on the Mac: ${upload.stderr.trim()}`);
      // Old agent versions are tiny but would pile up across upgrades. Versions used
      // in the last few days stay: the CLI and capmac Studio may run different ones.
      await this.conn.runScript(`find ${shQuote(`${this.home}/.capmac/agent`)} -mindepth 1 -maxdepth 1 -type d ! -name ${shQuote(bundle.hash)} -mtime +3 -exec rm -rf {} + 2>/dev/null; true\n`, { timeoutMs: 30_000 }).catch(() => undefined);
    }
    this.installed = true;
  }

  /** Starts an operation; returns immediately so callers can stream messages both ways. */
  async start<T>(op: string, params: object = {}, handlers: CallHandlers = {}): Promise<AgentCall<T>> {
    await this.ensureInstalled();
    const channel = await this.conn.exec(`${shQuote(this.nodePath)} ${shQuote(this.agentPath)}`);
    const call = new AgentCall<T>(channel, handlers, op);
    call.send({ t: 'params', op, ...params });
    return call;
  }

  /** Runs an operation to completion. */
  async call<T>(op: string, params: object = {}, handlers: CallHandlers = {}): Promise<T> {
    const call = await this.start<T>(op, params, handlers);
    return call.result;
  }
}
