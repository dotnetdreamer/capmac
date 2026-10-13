import { createHash } from 'node:crypto';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { CancelledError } from './errors.js';

export interface ConnectOptions {
  host: string;
  /** Friendly name for messages when `host` is a resolved IP address. */
  label?: string;
  port: number;
  username: string;
  privateKey?: string | Buffer;
  password?: string;
  agent?: string;
  /** Receives the server's "SHA256:..." fingerprint; return true to trust it. */
  verifyHostKey: (fingerprint: string) => boolean | Promise<boolean>;
  readyTimeoutMs?: number;
  /** An open byte stream to the Mac's sshd (remote access), used instead of host and port. */
  sock?: Duplex;
  /** Gives up the attempt (another route got there first). */
  signal?: AbortSignal;
}

/** Watches connections through a reverse tunnel (used to detect the HMR WebSocket). */
export interface ForwardObserver {
  /** The first bytes the Mac side sent on connection `id` (the HTTP request head). */
  onRequest?(id: number, head: string): void;
  onClose?(id: number): void;
}

export class SshError extends Error {
  readonly expected = true;
  constructor(message: string, readonly hint?: string, readonly code?: string) {
    super(message);
  }
}

export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function friendlyError(err: any, opts: ConnectOptions): SshError {
  const name = opts.label && opts.label !== opts.host ? `${opts.label} (${opts.host})` : opts.host;
  const where = `${opts.username}@${name}:${opts.port}`;
  const code = err?.code ?? err?.level;
  switch (code) {
    case 'ECONNREFUSED':
      return new SshError(`The Mac refused the SSH connection (${where}).`, 'Turn on Remote Login on the Mac: System Settings › General › Sharing › Remote Login.', code);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new SshError(`Cannot find a Mac called "${opts.label ?? opts.host}".`, 'Check the name, or use its IP address (System Settings › Wi-Fi › Details on the Mac).', code);
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new SshError(`Cannot reach ${name}.`, 'Make sure the Mac is awake and on the same network (or VPN) as this PC.', code);
    case 'ECONNRESET':
      return new SshError(`The connection to ${name} was reset.`, undefined, code);
    case 'client-authentication':
      return new SshError(`The Mac rejected the login for "${opts.username}".`, 'Run `capmac pair` again to re-install CapMac\'s key, or check the user name and password.', 'AUTH');
    case 'client-timeout':
      return new SshError(`Timed out connecting to ${name}.`, 'Make sure the Mac is awake and reachable.', 'TIMEOUT');
    default:
      return new SshError(err?.message ?? String(err), undefined, code);
  }
}

export class HostKeyMismatchError extends SshError {
  constructor(readonly fingerprint: string) {
    super(
      `The Mac's SSH host key changed (now ${fingerprint}).`,
      'If you reinstalled macOS or replaced the Mac, run `capmac pair` again. Otherwise someone may be intercepting the connection.',
      'HOST_KEY',
    );
  }
}

/** One SSH connection to the Mac; every capmac channel is multiplexed over it. */
export class MacConnection {
  private readonly forwards = new Map<number, (stream: ClientChannel, info: { srcIP: string; srcPort: number }) => void>();
  private closed = false;
  readonly closedPromise: Promise<void>;

  private constructor(readonly client: Client, readonly options: ConnectOptions) {
    this.closedPromise = new Promise((resolve) => {
      client.on('close', () => {
        this.closed = true;
        resolve();
      });
    });
    client.on('tcp connection', (details, accept, reject) => {
      const handler = this.forwards.get(details.destPort);
      if (!handler) {
        reject();
        return;
      }
      handler(accept(), { srcIP: details.srcIP, srcPort: details.srcPort });
    });
  }

  static connect(options: ConnectOptions): Promise<MacConnection> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let rejectedKey: string | null = null;
      let settled = false;
      const onAbort = () => {
        fail(new CancelledError());
        client.destroy();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        client.end();
        reject(err);
      };
      if (options.signal?.aborted) {
        reject(new CancelledError());
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      client.on('ready', () => {
        if (settled) {
          client.end();
          return;
        }
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        resolve(new MacConnection(client, options));
      });
      client.on('error', (err: any) => fail(rejectedKey ? new HostKeyMismatchError(rejectedKey) : friendlyError(err, options)));
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => options.password ?? ''));
      });
      const config: ConnectConfig = {
        host: options.host,
        port: options.port,
        username: options.username,
        readyTimeout: options.readyTimeoutMs ?? 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        tryKeyboard: Boolean(options.password),
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          const fp = fingerprintOf(key);
          Promise.resolve()
            .then(() => options.verifyHostKey(fp))
            .then((ok) => {
              if (!ok) rejectedKey = fp;
              verify(Boolean(ok));
            }, () => {
              rejectedKey = fp;
              verify(false);
            });
        },
      };
      if (options.sock) config.sock = options.sock as unknown as ConnectConfig['sock'];
      if (options.privateKey) config.privateKey = options.privateKey;
      if (options.password) config.password = options.password;
      if (options.agent) config.agent = options.agent;
      try {
        client.connect(config);
      } catch (err) {
        fail(friendlyError(err, options));
      }
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  exec(command: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new SshError('The connection to the Mac was closed.'));
        return;
      }
      this.client.exec(command, (err, channel) => (err ? reject(err) : resolve(channel)));
    });
  }

  /** Runs a POSIX sh script (sent on stdin, so no quoting through the login shell). */
  async runScript(script: string, options: { timeoutMs?: number; input?: never } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const channel = await this.exec('/bin/sh -s');
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = options.timeoutMs
        ? setTimeout(() => {
            channel.close();
            reject(new SshError('A command on the Mac took too long to respond.', 'If your shell startup files (.zprofile) do slow work, that can delay CapMac.'));
          }, options.timeoutMs)
        : null;
      channel.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      channel.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      channel.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? null, stdout, stderr });
      });
      channel.on('error', reject);
      channel.end(script);
    });
  }

  /** Runs `command` with `data` piped to its stdin (used to upload the agent). */
  async pipeTo(command: string, data: Buffer): Promise<{ code: number | null; stderr: string }> {
    const channel = await this.exec(command);
    return new Promise((resolve, reject) => {
      let stderr = '';
      channel.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      channel.on('data', () => undefined);
      channel.on('close', (code: number | null) => resolve({ code: code ?? null, stderr }));
      channel.on('error', reject);
      channel.end(data);
    });
  }

  /**
   * Reverse tunnel: connections to localhost:remotePort on the Mac (IPv4 and
   * IPv6 loopback) are forwarded to `localHost:localPort` on this PC.
   * Returns the bound port.
   */
  async reverseForward(remotePort: number, localPort: number, localHost = 'localhost', observer?: ForwardObserver): Promise<{ port: number; close: () => Promise<void> }> {
    const port = await new Promise<number>((resolve, reject) => {
      this.client.forwardIn('localhost', remotePort, (err, bound) => (err ? reject(err) : resolve(bound || remotePort)));
    });
    const sockets = new Set<net.Socket | ClientChannel>();
    let nextId = 1;
    this.forwards.set(port, (stream) => {
      const id = nextId++;
      const socket = net.connect({ host: localHost, port: localPort, autoSelectFamily: true });
      sockets.add(socket).add(stream);
      let closed = false;
      const cleanup = () => {
        socket.destroy();
        stream.destroy();
        sockets.delete(socket);
        sockets.delete(stream);
        if (!closed) {
          closed = true;
          observer?.onClose?.(id);
        }
      };
      socket.on('error', cleanup).on('close', cleanup);
      stream.on('error', cleanup).on('close', cleanup);
      socket.pipe(stream).pipe(socket);
      if (observer?.onRequest) {
        // Peek at the request head (e.g. a WebSocket upgrade for HMR) without disturbing the pipe.
        stream.once('data', (chunk: Buffer) => observer.onRequest?.(id, chunk.subarray(0, 2048).toString('latin1')));
      }
    });
    return {
      port,
      close: async () => {
        this.forwards.delete(port);
        for (const s of sockets) s.destroy();
        if (this.closed) return;
        await new Promise<void>((resolve) => this.client.unforwardIn('localhost', port, () => resolve()));
      },
    };
  }

  close(): void {
    if (!this.closed) this.client.end();
  }
}

/** Quotes a string for POSIX sh / zsh / bash / fish single-quoted context. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
