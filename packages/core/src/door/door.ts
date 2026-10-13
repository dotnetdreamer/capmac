/**
 * The door: CapMac's remote-access service on the Mac (see main.ts for how it
 * runs). It keeps a WebSocket to the signaling server so PCs can find the Mac,
 * lets in only the PCs it was paired with (allowed.json), checks their
 * signatures, and bridges each connection to the Mac's own sshd on 127.0.0.1.
 * Everything else (the agent, builds, the stream) then runs over SSH, exactly
 * as on the local network.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { RemoteError } from '../remote/errors.js';
import { toNdcIceServers } from '../remote/ice.js';
import { acquireNodeDataChannel, setNodeDataChannelDir, type PeerConnection } from '../remote/native.js';
import { joinRelay, SignalingClient } from '../remote/signaling.js';
import { dataChannelDuplex } from '../remote/streams.js';
import { descriptionText, isPublicKey, PIPE_REQUEST_MAX_SKEW_MS, pipeRequestText, shortKey, type PublicKey, type RejectCode, type ServerMessage } from '../shared/remote.js';
import { signText, verifyText, type Identity } from '../shared/remote-keys.js';
import type { DoorConfig, DoorStatusFile, RemotePc } from '../shared/remote-door.js';

const MAX_SESSIONS = 8;
/** A peer-to-peer session must have its data channel open by then. */
const SETUP_MS = 30_000;
const BACKOFF_S = [1, 2, 5, 10, 20, 30];

export type DoorLog = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface DoorOptions {
  version: string;
  log?: DoorLog;
  /** Where sshd listens (127.0.0.1 on the Mac; tests point elsewhere). */
  sshHost?: string;
  /** Start `caffeinate` when the config asks to keep the Mac awake (default true). */
  allowKeepAwake?: boolean;
}

interface DoorSession {
  id: string;
  pc: PublicKey;
  kind: 'p2p' | 'relay';
  peer: PeerConnection | null;
  release: (() => void) | null;
  streams: Set<Duplex>;
  sockets: Set<net.Socket>;
  connected: boolean;
  timer: NodeJS.Timeout | null;
}

/** A log function that writes to `file`, keeping it under ~512 KB (one old copy is kept). */
export function fileLog(file: string): DoorLog {
  return (level, message) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`;
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 512 * 1024) renameSync(file, `${file}.1`);
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      process.stderr.write(line);
    }
  };
}

export class Door {
  readonly macKey: PublicKey;
  private readonly sessions = new Map<string, DoorSession>();
  /** Relay requests already used (a replayed one is refused). */
  private readonly usedRelays = new Map<string, number>();
  private allowedCache: { mtimeMs: number; keys: Map<PublicKey, RemotePc> } | null = null;
  private statusState: DoorStatusFile;
  private stopping = false;
  private current: SignalingClient | null = null;
  private caffeinate: ChildProcess | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private readonly log: DoorLog;
  private loop: Promise<void> | null = null;

  constructor(private readonly config: DoorConfig, private readonly identity: Identity, private readonly options: DoorOptions) {
    this.macKey = identity.publicKey;
    this.log = options.log ?? (() => undefined);
    this.statusState = { state: 'connecting', since: new Date().toISOString(), pid: process.pid, version: options.version, error: null, sessions: 0, server: null, node: process.version };
    setNodeDataChannelDir(config.runtimeDir);
  }

  get status(): DoorStatusFile {
    return this.statusState;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  start(): void {
    this.log('info', `CapMac door ${this.options.version} starting (Node ${process.version}, sshd port ${this.config.sshPort}${this.config.keepAwake ? ', keeping the Mac awake' : ''})`);
    this.setStatus({ state: 'connecting', error: null });
    if (this.options.allowKeepAwake !== false) this.keepAwake();
    // Every few seconds: drop sessions of PCs that were removed from allowed.json.
    this.sweeper = setInterval(() => {
      const keys = this.allowed();
      for (const session of [...this.sessions.values()]) if (!keys.has(session.pc)) this.endSession(session, 'this PC was removed');
    }, 10_000);
    this.sweeper.unref?.();
    this.loop = this.connectLoop();
  }

  async stop(why = 'stopped'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log('info', `${why}: stopping`);
    if (this.sweeper) clearInterval(this.sweeper);
    for (const session of [...this.sessions.values()]) this.endSession(session, 'the door stopped');
    this.current?.close();
    this.wake?.();
    this.caffeinate?.kill();
    this.setStatus({ state: 'stopped' });
    await this.loop?.catch(() => undefined);
  }

  // ─── Files ──────────────────────────────────────────────────────────────

  private setStatus(patch: Partial<DoorStatusFile>): void {
    const stateChanged = patch.state !== undefined && patch.state !== this.statusState.state;
    this.statusState = { ...this.statusState, ...patch, ...(stateChanged ? { since: new Date().toISOString() } : {}), sessions: this.sessions.size };
    try {
      writeFileSync(`${this.config.statusFile}.tmp`, `${JSON.stringify(this.statusState)}\n`, { mode: 0o600 });
      renameSync(`${this.config.statusFile}.tmp`, this.config.statusFile);
    } catch {
      // the status file is only for the health check
    }
  }

  /** The PCs that may come in (re-read whenever allowed.json changes). */
  private allowed(): Map<PublicKey, RemotePc> {
    try {
      const mtimeMs = statSync(this.config.allowedFile).mtimeMs;
      if (this.allowedCache && this.allowedCache.mtimeMs === mtimeMs) return this.allowedCache.keys;
      const list = JSON.parse(readFileSync(this.config.allowedFile, 'utf8')) as RemotePc[];
      const keys = new Map<PublicKey, RemotePc>();
      for (const pc of Array.isArray(list) ? list : []) if (isPublicKey(pc?.key)) keys.set(pc.key, pc);
      this.allowedCache = { mtimeMs, keys };
      return keys;
    } catch {
      return new Map();
    }
  }

  private pcLabel(key: PublicKey): string {
    const pc = this.allowed().get(key);
    return pc ? `${pc.name} (${shortKey(key)})` : shortKey(key);
  }

  // ─── Sessions ───────────────────────────────────────────────────────────

  private endSession(session: DoorSession, why: string): void {
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
    if (session.timer) clearTimeout(session.timer);
    for (const s of session.streams) s.destroy();
    for (const s of session.sockets) s.destroy();
    if (session.peer) {
      try {
        session.peer.close();
      } catch {
        // already closed
      }
    }
    session.release?.();
    this.log('info', `session ${session.id.slice(0, 6)} from ${this.pcLabel(session.pc)} ended: ${why}`);
    this.setStatus({});
  }

  /** One stream from a PC becomes one TCP connection to the Mac's sshd, and nothing else. */
  private bridge(session: DoorSession, stream: Duplex): void {
    const socket = net.connect({ host: this.options.sshHost ?? '127.0.0.1', port: this.config.sshPort });
    socket.setNoDelay(true);
    session.streams.add(stream);
    session.sockets.add(socket);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stream.destroy();
      socket.destroy();
      session.streams.delete(stream);
      session.sockets.delete(socket);
      // A relay carries one stream: when it is done, so is the session.
      if (session.kind === 'relay' && session.streams.size === 0) this.endSession(session, 'closed');
    };
    socket.on('error', (err) => {
      this.log('warn', `the connection to sshd failed: ${err.message}`);
      close();
    });
    socket.on('close', close);
    stream.on('error', close);
    stream.on('close', close);
    stream.pipe(socket).pipe(stream);
  }

  private refuse(signaling: SignalingClient, session: string, code: RejectCode, message: string): void {
    signaling.send({ t: 'reject', session, code, message });
  }

  private admit(signaling: SignalingClient, session: string, pc: PublicKey): boolean {
    if (!this.allowed().has(pc)) {
      this.log('warn', `refused ${shortKey(pc)}: not a paired PC`);
      this.refuse(signaling, session, 'not-paired', 'This PC is not paired with this Mac for remote access.');
      return false;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      this.refuse(signaling, session, 'busy', 'Too many connections at once.');
      return false;
    }
    return !this.sessions.has(session);
  }

  private incoming(signaling: SignalingClient, m: Extract<ServerMessage, { t: 'incoming' }>): void {
    if (!this.admit(signaling, m.session, m.pc)) return;
    if (!verifyText(m.pc, descriptionText('offer', m.session, this.macKey, m.pc, m.offer.sdp), m.offer.sig)) {
      this.log('warn', `refused ${this.pcLabel(m.pc)}: the offer's signature is wrong`);
      this.refuse(signaling, m.session, 'bad-signature', 'The offer was not signed by a paired PC.');
      return;
    }
    let ndc: ReturnType<typeof acquireNodeDataChannel>;
    try {
      ndc = acquireNodeDataChannel();
    } catch (err) {
      this.log('error', (err as Error).message);
      this.refuse(signaling, m.session, 'error', 'WebRTC is not available on this Mac.');
      return;
    }
    const session: DoorSession = { id: m.session, pc: m.pc, kind: 'p2p', peer: null, release: ndc.release, streams: new Set(), sockets: new Set(), connected: false, timer: null };
    this.sessions.set(session.id, session);
    this.setStatus({});
    session.timer = setTimeout(() => {
      if (!session.connected) this.endSession(session, 'never connected');
    }, SETUP_MS);
    let peer: PeerConnection;
    try {
      peer = new ndc.ndc.PeerConnection(`door-${m.session.slice(0, 6)}`, { iceServers: toNdcIceServers(m.iceServers ?? [], 'allow'), iceTransportPolicy: 'all' });
    } catch (err) {
      this.log('error', `WebRTC: ${(err as Error).message}`);
      this.refuse(signaling, m.session, 'error', 'WebRTC failed on this Mac.');
      this.endSession(session, 'WebRTC failed');
      return;
    }
    session.peer = peer;
    peer.onLocalDescription((sdp, type) => {
      if (type !== 'answer') return;
      const sig = signText(this.identity, descriptionText('answer', m.session, this.macKey, m.pc, sdp));
      signaling.send({ t: 'answer', session: m.session, answer: { type: 'answer', sdp, sig } });
    });
    peer.onLocalCandidate((candidate, mid) => signaling.send({ t: 'candidate', session: m.session, candidate, mid }));
    peer.onDataChannel((dc) => {
      // Only SSH channels; one connection may carry a few (the screen can get its own).
      if (!dc.getLabel().startsWith('ssh') || session.streams.size >= 4) {
        dc.close();
        return;
      }
      session.connected = true;
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      this.log('info', `session ${m.session.slice(0, 6)}: ${this.pcLabel(m.pc)} connected peer to peer${routeOf(peer)}`);
      this.bridge(session, dataChannelDuplex(dc));
    });
    peer.onStateChange((state) => {
      if (state === 'failed' || state === 'closed') this.endSession(session, `connection ${state}`);
    });
    try {
      peer.setRemoteDescription(m.offer.sdp, 'offer');
    } catch (err) {
      this.refuse(signaling, m.session, 'error', 'The offer was not usable.');
      this.endSession(session, `bad offer: ${(err as Error).message}`);
    }
  }

  private relayRequest(signaling: SignalingClient, m: Extract<ServerMessage, { t: 'pipe' }>): void {
    if (!this.admit(signaling, m.session, m.pc)) return;
    if (!verifyText(m.pc, pipeRequestText(m.session, this.macKey, m.pc, m.ts), m.sig)) {
      this.log('warn', `refused a relay for ${this.pcLabel(m.pc)}: bad signature`);
      this.refuse(signaling, m.session, 'bad-signature', 'The relay request was not signed by a paired PC.');
      return;
    }
    const now = Date.now();
    if (Math.abs(now - m.ts) > PIPE_REQUEST_MAX_SKEW_MS) {
      this.refuse(signaling, m.session, 'stale', 'The request is too old, or the clocks differ.');
      return;
    }
    for (const [id, at] of this.usedRelays) if (now - at > 2 * PIPE_REQUEST_MAX_SKEW_MS) this.usedRelays.delete(id);
    if (this.usedRelays.has(m.session)) {
      this.refuse(signaling, m.session, 'stale', 'That request was already used.');
      return;
    }
    this.usedRelays.set(m.session, now);
    const session: DoorSession = { id: m.session, pc: m.pc, kind: 'relay', peer: null, release: null, streams: new Set(), sockets: new Set(), connected: false, timer: null };
    this.sessions.set(session.id, session);
    this.setStatus({});
    joinRelay({ server: this.config.signalUrl, session: m.session, role: 'mac', identity: this.identity }).then(
      (stream) => {
        if (!this.sessions.has(session.id)) {
          stream.destroy();
          return;
        }
        session.connected = true;
        this.log('info', `session ${m.session.slice(0, 6)}: ${this.pcLabel(m.pc)} connected through the relay`);
        this.bridge(session, stream);
      },
      (err: Error) => this.endSession(session, `relay failed: ${err.message}`),
    );
  }

  // ─── Keep awake ─────────────────────────────────────────────────────────

  private keepAwake(): void {
    if (!this.config.keepAwake || this.stopping) return;
    // -i: no idle sleep; -s: no sleep on power; -w: ends with the door.
    const child = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    this.caffeinate = child;
    child.on('exit', () => {
      this.caffeinate = null;
      if (!this.stopping) setTimeout(() => this.keepAwake(), 30_000).unref();
    });
    child.on('error', (err) => this.log('warn', `caffeinate: ${err.message}`));
  }

  // ─── The signaling connection ───────────────────────────────────────────

  private async connectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopping) {
      const started = Date.now();
      try {
        const signaling = await SignalingClient.connect({ server: this.config.signalUrl, role: 'mac', mac: this.macKey, identity: this.identity, agent: `capmac-door/${this.options.version}` });
        this.current = signaling;
        if (this.stopping) {
          signaling.close();
          return;
        }
        this.setStatus({ state: 'online', error: null, server: signaling.serverHost });
        this.log('info', `online at ${signaling.serverHost} as ${shortKey(this.macKey)}`);
        signaling.onMessage((m) => this.handle(signaling, m));
        const error = await new Promise<RemoteError | null>((resolve) => signaling.onClose(resolve));
        this.current = null;
        if (this.stopping) return;
        this.log('warn', `the signaling connection closed${error ? `: ${error.message}` : ''}`);
        if (error?.code === 'SIGNAL_REPLACED') {
          // Another door with this key took over (a second copy): leave it to that one for a while.
          this.setStatus({ state: 'error', error: error.message });
          await this.sleep(60_000);
        }
      } catch (err) {
        this.setStatus({ state: 'offline', error: (err as Error).message });
        if (attempt === 0 || attempt % 10 === 0) this.log('warn', (err as Error).message);
      }
      if (Date.now() - started > 60_000) attempt = 0;
      const delay = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)]! * 1000;
      attempt += 1;
      if (!this.stopping && this.statusState.state === 'online') this.setStatus({ state: 'connecting' });
      await this.sleep(delay);
    }
  }

  private handle(signaling: SignalingClient, m: ServerMessage): void {
    try {
      switch (m.t) {
        case 'incoming':
          if (isPublicKey(m.pc)) this.incoming(signaling, m);
          break;
        case 'pipe':
          if (isPublicKey(m.pc)) this.relayRequest(signaling, m);
          break;
        case 'candidate': {
          const session = this.sessions.get(m.session);
          try {
            session?.peer?.addRemoteCandidate(m.candidate, m.mid);
          } catch {
            // a candidate libdatachannel cannot use
          }
          break;
        }
        case 'bye': {
          const session = this.sessions.get(m.session);
          if (session && !session.connected) this.endSession(session, 'cancelled by the PC');
          break;
        }
      }
    } catch (err) {
      this.log('error', `handling "${m.t}": ${(err as Error).message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}

function routeOf(peer: PeerConnection): string {
  try {
    const pair = peer.getSelectedCandidatePair();
    return pair ? ` (${pair.local.type} → ${pair.remote.type})` : '';
  } catch {
    return '';
  }
}
