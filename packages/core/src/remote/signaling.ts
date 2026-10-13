/**
 * The client side of the signaling server, for both the PC and the door on
 * the Mac. Uses Node.js's built-in WebSocket (Node 22+).
 */
import {
  helloText,
  pipeHelloText,
  signalSocketUrl,
  type ClientMessage,
  type PublicKey,
  type ServerMessage,
} from '../shared/remote.js';
import { signText, type Identity } from '../shared/remote-keys.js';
import type { Duplex } from 'node:stream';
import { RemoteError } from './errors.js';
import { webSocketDuplex } from './streams.js';

export type WelcomeMessage = Extract<ServerMessage, { t: 'welcome' }>;

/** The client pings this often; a socket quiet for KEEPALIVE_DEAD_MS is treated as dead. */
const KEEPALIVE_MS = 25_000;
const KEEPALIVE_DEAD_MS = 70_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function requireWebSocket(): void {
  if (typeof WebSocket !== 'function') {
    throw new RemoteError(
      `Remote access needs Node.js 22 or later (this is ${process.version}).`,
      'Update Node.js (https://nodejs.org); connections on the local network still work.',
      'NODE_TOO_OLD',
    );
  }
}

/** What a close code from the server means for people. */
function closeProblem(code: number, reason: string, server: string): RemoteError {
  switch (code) {
    case 4403:
      return new RemoteError(`The signaling server (${server}) refused CapMac: ${reason || 'bad identity'}.`, undefined, 'SIGNAL_REFUSED');
    case 4409:
      return new RemoteError('Another copy of the door on this Mac took over the connection.', undefined, 'SIGNAL_REPLACED');
    default:
      return new RemoteError(
        `Cannot reach the signaling server (${server}).`,
        'Check its address (Settings › Remote access, or `capmac remote set --signal-url`), and that the server is running.',
        'SIGNAL_UNREACHABLE',
      );
  }
}

export interface SignalingOptions {
  /** The server's base address ("wss://signal.example.com"). */
  server: string;
  role: 'mac' | 'pc';
  /** The Mac this socket is about (the door's own key, or the Mac a PC wants). */
  mac: PublicKey;
  identity: Identity;
  /** Software and version, for the server's logs. */
  agent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A signaling socket that has said hello. */
export class SignalingClient {
  private readonly listeners = new Set<(message: ServerMessage) => void>();
  private readonly closeListeners = new Set<(error: RemoteError | null) => void>();
  private keepalive: NodeJS.Timeout | null = null;
  private lastHeard = Date.now();
  private ended = false;

  private constructor(private readonly ws: WebSocket, readonly welcome: WelcomeMessage, private readonly server: string) {
    ws.addEventListener('message', (event) => {
      this.lastHeard = Date.now();
      const message = parse(event.data);
      if (!message) return;
      for (const listener of [...this.listeners]) {
        try {
          listener(message);
        } catch {
          // one listener's problem is not the socket's
        }
      }
    });
    ws.addEventListener('close', (event) => this.finish(event.code === 1000 || event.code === 1005 ? null : closeProblem(event.code, event.reason, server)));
    this.keepalive = setInterval(() => {
      if (Date.now() - this.lastHeard > KEEPALIVE_DEAD_MS) {
        this.close();
        this.finish(new RemoteError(`Lost the connection to the signaling server (${server}).`, undefined, 'SIGNAL_LOST'));
        return;
      }
      this.send({ t: 'ping' });
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  /** Connects, answers the challenge and resolves once the server welcomed us. */
  static connect(options: SignalingOptions): Promise<SignalingClient> {
    requireWebSocket();
    const path = options.role === 'mac' ? `/v1/mac/${options.mac}` : `/v1/pc/${options.mac}`;
    const url = signalSocketUrl(options.server, path);
    const server = hostOf(url);
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      const timer = setTimeout(() => fail(new RemoteError(`The signaling server (${server}) did not answer in time.`, 'Check its address and that it is running.', 'SIGNAL_TIMEOUT')), options.timeoutMs ?? 12_000);
      const onAbort = () => fail(new RemoteError('Cancelled', undefined, 'CANCELLED'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      function fail(error: RemoteError) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        try {
          ws.close();
        } catch {
          // not open
        }
        reject(error);
      }
      ws.addEventListener('message', function first(event) {
        if (settled) return;
        const message = parse(event.data);
        if (!message) return fail(new RemoteError(`The signaling server (${server}) sent something CapMac does not understand.`, 'Is the address right, and the server up to date?', 'SIGNAL_PROTOCOL'));
        if (message.t === 'challenge') {
          const hello: ClientMessage = {
            t: 'hello',
            role: options.role,
            key: options.identity.publicKey,
            sig: signText(options.identity, helloText(options.role, message.nonce, options.mac, options.identity.publicKey)),
            agent: options.agent,
          };
          ws.send(JSON.stringify(hello));
          return;
        }
        if (message.t === 'welcome') {
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          ws.removeEventListener('message', first);
          resolve(new SignalingClient(ws, message, server));
          return;
        }
        if (message.t === 'error') fail(new RemoteError(`The signaling server refused: ${message.message}`, undefined, 'SIGNAL_REFUSED'));
      });
      ws.addEventListener('close', (event) => fail(closeProblem(event.code, event.reason, server)));
      ws.addEventListener('error', () => undefined);
    });
  }

  get open(): boolean {
    return !this.ended && this.ws.readyState === WebSocket.OPEN;
  }

  get serverHost(): string {
    return this.server;
  }

  send(message: ClientMessage): void {
    if (this.open) this.ws.send(JSON.stringify(message));
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called once when the socket closes (with the reason, or null when it was closed on purpose). */
  onClose(listener: (error: RemoteError | null) => void): () => void {
    if (this.ended) {
      listener(null);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      // already closed
    }
  }

  private finish(error: RemoteError | null): void {
    if (this.ended) return;
    this.ended = true;
    if (this.keepalive) clearInterval(this.keepalive);
    for (const listener of [...this.closeListeners]) listener(error);
    this.closeListeners.clear();
    this.listeners.clear();
  }
}

/**
 * Joins one end of a relay: answers the challenge for `session`, then
 * resolves with the byte stream once the server says both ends are there.
 * The stream is made the moment "ready" arrives: the other end may start
 * sending right away (sshd greets first), in the same burst as "ready".
 */
export function joinRelay(options: { server: string; session: string; role: 'mac' | 'pc'; identity: Identity; timeoutMs?: number; signal?: AbortSignal }): Promise<Duplex> {
  requireWebSocket();
  const url = signalSocketUrl(options.server, `/v1/pipe/${options.session}`);
  const server = hostOf(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => fail(new RemoteError('The relay did not connect in time.', undefined, 'RELAY_TIMEOUT')), options.timeoutMs ?? 15_000);
    const onAbort = () => fail(new RemoteError('Cancelled', undefined, 'CANCELLED'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    function fail(error: RemoteError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        ws.close();
      } catch {
        // not open
      }
      reject(error);
    }
    const onMessage = (event: MessageEvent) => {
      if (settled) return;
      const message = parse(event.data);
      if (!message) return fail(new RemoteError('The relay sent something unexpected.', undefined, 'RELAY_PROTOCOL'));
      if (message.t === 'challenge') {
        const sig = signText(options.identity, pipeHelloText(options.role, message.nonce, options.session, options.identity.publicKey));
        ws.send(JSON.stringify({ t: 'hello', role: options.role, key: options.identity.publicKey, sig } satisfies ClientMessage));
      } else if (message.t === 'ready') {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', onClose);
        resolve(webSocketDuplex(ws));
      }
    };
    const onClose = (event: { code: number; reason: string }) => fail(new RemoteError(`The relay closed (${event.reason || `code ${event.code}`}).`, `The signaling server is ${server}.`, 'RELAY_CLOSED'));
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', () => undefined);
  });
}

function parse(data: unknown): ServerMessage | null {
  if (typeof data !== 'string' || data.length > 256 * 1024) return null;
  try {
    const message = JSON.parse(data) as ServerMessage;
    return message && typeof message === 'object' && typeof message.t === 'string' ? message : null;
  } catch {
    return null;
  }
}
