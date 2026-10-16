/**
 * The agent's side of an Electron app's socket (served by CapMac's module in
 * the app, see src/electron-hook): JSON requests out, JSON messages back, and
 * the binary frame that follows a `frame`, `video` or `screenshot` message
 * delivered with it.
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { encodeJson, FrameDecoder } from '../shared/frames.js';
import type { HookMessage, HookRequest } from '../shared/electron.js';

/** Where a native Mac app's module listens: a file next to the socket the Electron module would use. */
export function tcpEndpointFile(socketPath: string): string {
  return `${socketPath.replace(/\.sock$/, '')}.tcp`;
}

/** The port and token of a native Mac app's module, while one runs for the project. */
export async function readTcpEndpoint(socketPath: string): Promise<{ port: number; token: string } | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(tcpEndpointFile(socketPath), 'utf8'));
    return Number.isInteger(parsed.port) && typeof parsed.token === 'string' ? { port: parsed.port, token: parsed.token } : null;
  } catch {
    return null;
  }
}

export class HookConnection {
  private readonly decoder = new FrameDecoder();
  /** A frame or screenshot message whose binary payload comes next. */
  private header: HookMessage | null = null;
  private readonly waiters = new Map<number, (message: HookMessage, binary?: Buffer) => void>();
  private closed = false;
  readonly done: Promise<void>;
  onMessage: (message: HookMessage, binary?: Buffer) => void = () => undefined;

  private constructor(private readonly socket: net.Socket) {
    this.done = new Promise((resolve) => {
      socket.on('close', () => {
        this.closed = true;
        resolve();
      });
    });
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = this.decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.kind === 'binary') {
          const header = this.header;
          this.header = null;
          if (header) this.deliver(header, frame.data);
          continue;
        }
        const message = frame.value as HookMessage;
        if (message?.t === 'frame' || message?.t === 'video' || message?.t === 'screenshot') this.header = message;
        else this.deliver(message);
      }
    });
  }

  /**
   * Connects to the app's socket; rejects when nothing listens there (the app
   * is not running). A native Mac app's module listens on a local TCP port
   * instead (a sandboxed app may not make a socket file): the endpoint file
   * next to the socket says which, and the first message is its token.
   */
  static async connect(socketPath: string, timeoutMs = 3000): Promise<HookConnection> {
    const tcp = await readTcpEndpoint(socketPath);
    const conn = await HookConnection.open(tcp ? { port: tcp.port, host: '127.0.0.1' } : { path: socketPath }, timeoutMs);
    if (tcp) conn.socket.write(encodeJson({ t: 'auth', token: tcp.token }));
    return conn;
  }

  private static open(target: net.NetConnectOpts, timeoutMs: number): Promise<HookConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(target);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timeout'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new HookConnection(socket));
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private deliver(message: HookMessage, binary?: Buffer): void {
    const id = (message as { id?: unknown }).id;
    if ((message.t === 'result' || message.t === 'screenshot' || message.t === 'pong') && typeof id === 'number') {
      const waiter = this.waiters.get(id);
      if (waiter) {
        this.waiters.delete(id);
        waiter(message, binary);
        return;
      }
    }
    this.onMessage(message, binary);
  }

  send(request: HookRequest): void {
    if (!this.closed) this.socket.write(encodeJson(request));
  }

  /** Sends a request with an id and waits for its answer. */
  request(request: HookRequest & { id: number }, timeoutMs = 10_000): Promise<{ message: HookMessage; binary?: Buffer }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(request.id);
        reject(new Error('The app did not answer.'));
      }, timeoutMs);
      this.waiters.set(request.id, (message, binary) => {
        clearTimeout(timer);
        resolve({ message, binary });
      });
      void this.done.then(() => {
        if (this.waiters.delete(request.id)) {
          clearTimeout(timer);
          reject(new Error('The app closed the connection.'));
        }
      });
      this.send(request);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}
