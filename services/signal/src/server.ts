/**
 * CapMac's signaling server. It introduces a PC to the door on its Mac so the
 * two can connect peer to peer (WebRTC), relays the bytes between them when
 * they can't, and tells each side whether the other is online. It never sees
 * inside a connection: the SSH session inside is encrypted end to end, and the
 * door only lets in PCs that were paired with the Mac.
 *
 * WebSocket endpoints:
 *   /v1/mac/<mac key>    the door on a Mac, connected all the time
 *   /v1/pc/<mac key>     a PC that wants that Mac
 *   /v1/pipe/<session>   one relayed connection: the PC's end and the door's end
 * HTTP: GET /healthz
 *
 * Every socket starts with a challenge; the client signs it with its key
 * (shared/remote.ts says exactly what is signed).
 */
import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { createWebSocketStream, WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  helloText,
  isPublicKey,
  isSession,
  isSignature,
  pipeHelloText,
  REMOTE_PROTOCOL,
  shortKey,
  type ClientMessage,
  type IceServerSpec,
  type PublicKey,
  type RejectCode,
  type ServerMessage,
  type SignedDescription,
} from '@capmac/core/shared/remote';
import { randomId, verifyText } from '@capmac/core/shared/remote-keys';

export interface TurnOptions {
  /** e.g. turn:turn.example.com:3478?transport=udp */
  urls: string[];
  /** coturn's static-auth-secret (TURN REST API credentials). */
  secret: string;
  ttlSeconds: number;
}

export interface Limits {
  /** New WebSockets from one address, per minute. */
  upgradesPerMinute: number;
  /** Open WebSockets from one address. */
  socketsPerAddress: number;
  /** Open WebSockets in all. */
  sockets: number;
  /** Connection requests (peer to peer or relay) from one PC, per minute. */
  connectsPerMinute: number;
  /** Bad hellos from one address before it is shut out for `banMinutes`. */
  badHellos: number;
  banMinutes: number;
  /** A relay whose two ends haven't both arrived by then is dropped. */
  pipeJoinMs: number;
  /** A client that hasn't said hello by then is dropped. */
  helloMs: number;
}

const DEFAULT_LIMITS: Limits = {
  upgradesPerMinute: 60,
  socketsPerAddress: 64,
  sockets: 20_000,
  connectsPerMinute: 30,
  badHellos: 10,
  banMinutes: 10,
  pipeJoinMs: 20_000,
  helloMs: 10_000,
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SignalServerOptions {
  port: number;
  host?: string;
  /** Serve wss:// directly (otherwise run behind a TLS reverse proxy such as Caddy). */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** STUN servers handed to clients for peer-to-peer connections. */
  stunUrls: string[];
  /** TURN, when a coturn server is configured. */
  turn?: TurnOptions;
  /** Take the client's address from X-Forwarded-For (behind a reverse proxy). */
  trustProxy?: boolean;
  limits?: Partial<Limits>;
  version?: string;
  log?: (level: LogLevel, message: string) => void;
}

/** Signaling JSON stays small; relayed binary frames may be up to this size. */
const MAX_JSON = 64 * 1024;
const MAX_FRAME = 256 * 1024;
const MAX_SDP = 32 * 1024;

type Kind = 'mac' | 'pc' | 'pipe';

interface Client {
  ws: WebSocket;
  kind: Kind;
  /** The Mac's key (mac, pc) or the session (pipe), from the URL. */
  target: string;
  address: string;
  nonce: string;
  key: PublicKey | null;
  alive: boolean;
  helloTimer: NodeJS.Timeout | null;
  /** Sessions this PC started. */
  sessions: Set<string>;
}

interface Session {
  id: string;
  mac: PublicKey;
  pc: PublicKey;
  pcClient: Client;
  kind: 'p2p' | 'pipe';
  created: number;
}

interface Pipe {
  session: string;
  mac: PublicKey;
  pc: PublicKey;
  ends: { pc: Client | null; mac: Client | null };
  timer: NodeJS.Timeout | null;
  relaying: boolean;
}

export interface SignalStats {
  macsOnline: number;
  pcs: number;
  pipes: number;
  sockets: number;
  relayedBytes: number;
}

/** A per-key counter over a sliding minute. */
class RateCounter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs = 60_000) {}
  /** Counts a hit; false once there were `max` already in the window. */
  take(key: string, max: number, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  sweep(now = Date.now()): void {
    for (const [key, list] of this.hits) {
      const fresh = list.filter((t) => now - t < this.windowMs);
      if (fresh.length) this.hits.set(key, fresh);
      else this.hits.delete(key);
    }
  }
}

export class SignalServer {
  private readonly limits: Limits;
  private readonly server: http.Server | https.Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly macs = new Map<PublicKey, Client>();
  /** PCs waiting for (or talking to) each Mac. */
  private readonly pcs = new Map<PublicKey, Set<Client>>();
  /** When each Mac was last online (kept for the 10 000 most recent). */
  private readonly lastSeen = new Map<PublicKey, number>();
  private readonly sessions = new Map<string, Session>();
  private readonly pipes = new Map<string, Pipe>();
  private readonly perAddress = new Map<string, number>();
  private readonly upgrades = new RateCounter();
  private readonly connects = new RateCounter();
  private readonly badHellos = new RateCounter();
  private readonly banned = new Map<string, number>();
  private heartbeat: NodeJS.Timeout | null = null;
  private relayedBytes = 0;
  private readonly log: (level: LogLevel, message: string) => void;

  constructor(private readonly options: SignalServerOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.log = options.log ?? (() => undefined);
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => this.http(req, res);
    this.server = options.tls ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, handler) : http.createServer(handler);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
  }

  /** Starts listening; resolves with the port (useful with port 0). */
  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host, () => resolve());
    });
    this.heartbeat = setInterval(() => this.beat(), 30_000);
    this.heartbeat.unref();
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients) client.ws.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  stats(): SignalStats {
    let pcs = 0;
    for (const set of this.pcs.values()) pcs += set.size;
    return { macsOnline: this.macs.size, pcs, pipes: this.pipes.size, sockets: this.clients.size, relayedBytes: this.relayedBytes };
  }

  // ─── HTTP and upgrades ──────────────────────────────────────────────────

  private http(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, protocol: REMOTE_PROTOCOL, version: this.options.version ?? 'dev', ...this.stats() }));
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('CapMac signaling server. CapMac connects here; there is nothing to see in a browser.\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found\n');
  }

  private addressOf(req: http.IncomingMessage): string {
    if (this.options.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const match = (req.url ?? '').split('?')[0]!.match(/^\/v1\/(mac|pc|pipe)\/([A-Za-z0-9_-]{16,64})$/);
    if (!match) return refuse(404, 'Not Found');
    const kind = match[1] as Kind;
    const target = match[2]!;
    if (kind !== 'pipe' && !isPublicKey(target)) return refuse(404, 'Not Found');
    const address = this.addressOf(req);
    const now = Date.now();
    const bannedUntil = this.banned.get(address);
    if (bannedUntil && bannedUntil > now) return refuse(429, 'Too Many Requests');
    if (!this.upgrades.take(address, this.limits.upgradesPerMinute, now)) return refuse(429, 'Too Many Requests');
    if ((this.perAddress.get(address) ?? 0) >= this.limits.socketsPerAddress || this.clients.size >= this.limits.sockets) return refuse(503, 'Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, kind, target, address));
  }

  private accept(ws: WebSocket, kind: Kind, target: string, address: string): void {
    const client: Client = { ws, kind, target, address, nonce: randomId(18), key: null, alive: true, helloTimer: null, sessions: new Set() };
    this.clients.add(client);
    this.perAddress.set(address, (this.perAddress.get(address) ?? 0) + 1);
    client.helloTimer = setTimeout(() => ws.close(4401, 'No hello'), this.limits.helloMs);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data, isBinary) => this.message(client, data, isBinary));
    ws.on('close', () => this.closed(client));
    ws.on('error', () => undefined);
    this.send(client, { t: 'challenge', nonce: client.nonce, protocol: REMOTE_PROTOCOL, server: this.options.version ?? 'dev' });
  }

  private beat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        // closing anyway
      }
    }
    const now = Date.now();
    this.upgrades.sweep(now);
    this.connects.sweep(now);
    this.badHellos.sweep(now);
    for (const [address, until] of this.banned) if (until <= now) this.banned.delete(address);
  }

  private send(client: Client, message: ServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
  }

  // ─── Messages ───────────────────────────────────────────────────────────

  private message(client: Client, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      // Binary frames only flow on a relay once both ends are there (handled by the relay's streams).
      client.ws.close(4400, 'Unexpected binary frame');
      return;
    }
    const text = data.toString();
    if (text.length > MAX_JSON) {
      client.ws.close(4413, 'Message too large');
      return;
    }
    let message: ClientMessage;
    try {
      message = JSON.parse(text) as ClientMessage;
    } catch {
      client.ws.close(4400, 'Bad message');
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') {
      client.ws.close(4400, 'Bad message');
      return;
    }
    if (message.t === 'ping') {
      client.alive = true;
      this.send(client, { t: 'pong' });
      return;
    }
    if (!client.key) {
      if (message.t !== 'hello') {
        client.ws.close(4401, 'Say hello first');
        return;
      }
      this.hello(client, message);
      return;
    }
    if (client.kind === 'pc') this.fromPc(client, message);
    else if (client.kind === 'mac') this.fromMac(client, message);
  }

  private badHello(client: Client, reason: string): void {
    if (!this.badHellos.take(client.address, this.limits.badHellos)) {
      this.banned.set(client.address, Date.now() + this.limits.banMinutes * 60_000);
      this.log('warn', `shutting out ${client.address} for ${this.limits.banMinutes} min after repeated bad hellos`);
    }
    client.ws.close(4403, reason);
  }

  private hello(client: Client, message: Extract<ClientMessage, { t: 'hello' }>): void {
    const { role, key, sig } = message;
    if ((role !== 'mac' && role !== 'pc') || !isPublicKey(key) || !isSignature(sig)) return this.badHello(client, 'Bad hello');
    if (client.kind === 'pipe') return this.pipeHello(client, role, key, sig);
    if (role !== client.kind) return this.badHello(client, 'Wrong role for this address');
    if (role === 'mac' && key !== client.target) return this.badHello(client, 'This key is not this Mac');
    if (!verifyText(key, helloText(role, client.nonce, client.target, key), sig)) return this.badHello(client, 'Bad signature');
    if (client.helloTimer) clearTimeout(client.helloTimer);
    client.helloTimer = null;
    client.key = key;
    if (role === 'mac') {
      const previous = this.macs.get(key);
      this.macs.set(key, client);
      // A door that reconnects replaces its old socket (a dropped network can leave it half open).
      if (previous && previous !== client) previous.ws.close(4409, 'Replaced by a newer connection');
      this.lastSeen.delete(key);
      this.send(client, { t: 'welcome', iceServers: this.iceServers(key) });
      for (const pc of this.pcs.get(key) ?? []) this.send(pc, { t: 'presence', online: true, lastSeen: null });
      this.log('debug', `Mac ${shortKey(key)} online`);
    } else {
      let set = this.pcs.get(client.target);
      if (!set) this.pcs.set(client.target, (set = new Set()));
      set.add(client);
      const online = this.macs.has(client.target);
      this.send(client, { t: 'welcome', iceServers: this.iceServers(key), mac: { online, lastSeen: online ? null : this.lastSeen.get(client.target) ?? null } });
    }
  }

  private fromPc(client: Client, message: ClientMessage): void {
    const pc = client.key!;
    const mac = client.target;
    switch (message.t) {
      case 'connect':
      case 'pipe': {
        const { session } = message;
        if (!isSession(session) || this.sessions.has(session)) return this.send(client, { t: 'error', code: 'bad-session', message: 'That session id is invalid or already in use.' });
        if (!this.connects.take(pc, this.limits.connectsPerMinute)) return this.reject(client, session, 'busy', 'Too many connection attempts; wait a minute.');
        const door = this.macs.get(mac);
        if (!door) return this.reject(client, session, 'offline', 'The Mac is offline.');
        if (message.t === 'connect') {
          if (!validDescription(message.offer, 'offer')) return this.send(client, { t: 'error', code: 'bad-offer', message: 'The offer is invalid.' });
          this.addSession({ id: session, mac, pc, pcClient: client, kind: 'p2p', created: Date.now() });
          this.send(door, { t: 'incoming', session, pc, offer: message.offer, iceServers: this.iceServers(mac) });
        } else {
          if (!Number.isFinite(message.ts) || !isSignature(message.sig)) return this.send(client, { t: 'error', code: 'bad-pipe', message: 'The relay request is invalid.' });
          this.addSession({ id: session, mac, pc, pcClient: client, kind: 'pipe', created: Date.now() });
          const pipe: Pipe = { session, mac, pc, ends: { pc: null, mac: null }, timer: null, relaying: false };
          pipe.timer = setTimeout(() => this.dropPipe(pipe, 'The relay timed out'), this.limits.pipeJoinMs);
          this.pipes.set(session, pipe);
          this.send(door, { t: 'pipe', session, pc, ts: message.ts, sig: message.sig });
          this.send(client, { t: 'pipe-open', session });
        }
        return;
      }
      case 'candidate': {
        const s = this.sessions.get(message.session);
        if (!s || s.pcClient !== client || typeof message.candidate !== 'string' || message.candidate.length > 2048 || typeof message.mid !== 'string') return;
        const door = this.macs.get(s.mac);
        if (door) this.send(door, { t: 'candidate', session: s.id, candidate: message.candidate, mid: message.mid.slice(0, 64) });
        return;
      }
      case 'bye': {
        const s = this.sessions.get(message.session);
        if (!s || s.pcClient !== client) return;
        const door = this.macs.get(s.mac);
        if (door) this.send(door, { t: 'bye', session: s.id });
        this.endSession(s.id);
        return;
      }
      default:
        return;
    }
  }

  private fromMac(client: Client, message: ClientMessage): void {
    const mac = client.key!;
    const s = 'session' in message && typeof message.session === 'string' ? this.sessions.get(message.session) : undefined;
    if (!s || s.mac !== mac) return;
    switch (message.t) {
      case 'answer':
        if (validDescription(message.answer, 'answer')) this.send(s.pcClient, { t: 'answer', session: s.id, answer: message.answer });
        return;
      case 'candidate':
        if (typeof message.candidate === 'string' && message.candidate.length <= 2048 && typeof message.mid === 'string') {
          this.send(s.pcClient, { t: 'candidate', session: s.id, candidate: message.candidate, mid: message.mid.slice(0, 64) });
        }
        return;
      case 'reject':
        this.send(s.pcClient, { t: 'reject', session: s.id, code: rejectCode(message.code), message: String(message.message ?? '').slice(0, 300) });
        this.endSession(s.id);
        return;
      case 'bye':
        this.send(s.pcClient, { t: 'bye', session: s.id });
        this.endSession(s.id);
        return;
      default:
        return;
    }
  }

  private reject(client: Client, session: string, code: RejectCode, message: string): void {
    this.send(client, { t: 'reject', session, code, message });
  }

  private addSession(session: Session): void {
    this.sessions.set(session.id, session);
    session.pcClient.sessions.add(session.id);
  }

  private endSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.pcClient.sessions.delete(id);
    const pipe = this.pipes.get(id);
    if (pipe && !pipe.relaying) this.dropPipe(pipe, 'Cancelled');
  }

  // ─── The relay ──────────────────────────────────────────────────────────

  private pipeHello(client: Client, role: 'mac' | 'pc', key: PublicKey, sig: string): void {
    const pipe = this.pipes.get(client.target);
    if (!pipe || pipe.relaying) return this.badHello(client, 'No such relay');
    const expected = role === 'pc' ? pipe.pc : pipe.mac;
    if (key !== expected || pipe.ends[role]) return this.badHello(client, 'Not an end of this relay');
    if (!verifyText(key, pipeHelloText(role, client.nonce, pipe.session, key), sig)) return this.badHello(client, 'Bad signature');
    if (client.helloTimer) clearTimeout(client.helloTimer);
    client.helloTimer = null;
    client.key = key;
    pipe.ends[role] = client;
    const { pc, mac } = pipe.ends;
    if (!pc || !mac) return;
    // Both ends are here: from now on, every binary frame goes straight to the other end.
    if (pipe.timer) clearTimeout(pipe.timer);
    pipe.timer = null;
    pipe.relaying = true;
    this.send(pc, { t: 'ready', session: pipe.session });
    this.send(mac, { t: 'ready', session: pipe.session });
    pc.ws.removeAllListeners('message');
    mac.ws.removeAllListeners('message');
    const a = createWebSocketStream(pc.ws, { highWaterMark: 1024 * 1024 });
    const b = createWebSocketStream(mac.ws, { highWaterMark: 1024 * 1024 });
    const count = (chunk: Buffer) => (this.relayedBytes += chunk.length);
    a.on('data', count);
    b.on('data', count);
    a.pipe(b);
    b.pipe(a);
    const end = () => {
      a.destroy();
      b.destroy();
      pc.ws.terminate();
      mac.ws.terminate();
    };
    a.on('error', end).on('close', end);
    b.on('error', end).on('close', end);
    this.log('debug', `relay ${pipe.session.slice(0, 6)} up`);
  }

  private dropPipe(pipe: Pipe, reason: string): void {
    if (pipe.timer) clearTimeout(pipe.timer);
    this.pipes.delete(pipe.session);
    for (const end of [pipe.ends.pc, pipe.ends.mac]) end?.ws.close(4408, reason);
    const s = this.sessions.get(pipe.session);
    if (s) {
      this.sessions.delete(s.id);
      s.pcClient.sessions.delete(s.id);
    }
  }

  // ─── Closing ────────────────────────────────────────────────────────────

  private closed(client: Client): void {
    if (client.helloTimer) clearTimeout(client.helloTimer);
    this.clients.delete(client);
    const left = (this.perAddress.get(client.address) ?? 1) - 1;
    if (left > 0) this.perAddress.set(client.address, left);
    else this.perAddress.delete(client.address);
    if (client.kind === 'mac' && client.key && this.macs.get(client.key) === client) {
      this.macs.delete(client.key);
      this.lastSeen.set(client.key, Date.now());
      if (this.lastSeen.size > 10_000) this.lastSeen.delete(this.lastSeen.keys().next().value!);
      const lastSeen = this.lastSeen.get(client.key)!;
      for (const pc of this.pcs.get(client.key) ?? []) this.send(pc, { t: 'presence', online: false, lastSeen });
      // Connections still being set up with this Mac cannot finish now.
      for (const s of [...this.sessions.values()]) {
        if (s.mac !== client.key) continue;
        const pipe = this.pipes.get(s.id);
        if (pipe?.relaying) continue;
        this.reject(s.pcClient, s.id, 'offline', 'The Mac went offline.');
        this.endSession(s.id);
      }
      this.log('debug', `Mac ${shortKey(client.key)} offline`);
    } else if (client.kind === 'pc') {
      const set = this.pcs.get(client.target);
      set?.delete(client);
      if (set && set.size === 0) this.pcs.delete(client.target);
      // A PC closes its signaling socket once connected: the door keeps the connection.
      for (const id of [...client.sessions]) {
        const pipe = this.pipes.get(id);
        if (pipe?.relaying) continue;
        const s = this.sessions.get(id);
        if (s && s.kind === 'pipe') this.endSession(id);
        else {
          this.sessions.delete(id);
        }
      }
      client.sessions.clear();
    } else if (client.kind === 'pipe') {
      const pipe = this.pipes.get(client.target);
      if (pipe && !pipe.relaying && (pipe.ends.pc === client || pipe.ends.mac === client)) this.dropPipe(pipe, 'The other end left');
      else if (pipe?.relaying && (pipe.ends.pc === client || pipe.ends.mac === client)) {
        this.pipes.delete(pipe.session);
        this.sessions.delete(pipe.session);
      }
    }
  }

  // ─── ICE servers ────────────────────────────────────────────────────────

  private iceServers(key: PublicKey): IceServerSpec[] {
    const servers: IceServerSpec[] = [];
    if (this.options.stunUrls.length) servers.push({ urls: this.options.stunUrls });
    const turn = this.options.turn;
    if (turn && turn.urls.length && turn.secret) {
      // TURN REST API credentials (coturn's use-auth-secret): "<expiry>:<user>", HMAC-SHA1.
      const username = `${Math.floor(Date.now() / 1000) + turn.ttlSeconds}:${key.slice(0, 16)}`;
      const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
      servers.push({ urls: turn.urls, username, credential });
    }
    return servers;
  }
}

function validDescription(value: unknown, type: SignedDescription['type']): value is SignedDescription {
  const d = value as SignedDescription | undefined;
  return Boolean(d && d.type === type && typeof d.sdp === 'string' && d.sdp.length > 0 && d.sdp.length <= MAX_SDP && isSignature(d.sig));
}

function rejectCode(value: unknown): RejectCode {
  const codes: RejectCode[] = ['not-paired', 'bad-signature', 'busy', 'offline', 'stale', 'error'];
  return codes.includes(value as RejectCode) ? (value as RejectCode) : 'error';
}
