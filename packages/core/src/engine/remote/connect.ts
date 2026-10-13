/**
 * Reaching a Mac over the internet. Through the signaling server, this PC and
 * the door on the Mac connect peer to peer with WebRTC when their networks
 * allow it, and through the server's relay when they don't. Either way the
 * result is a byte stream to the Mac's sshd, which ssh2 runs over.
 */
import type { Duplex } from 'node:stream';
import { descriptionText, pipeRequestText, type PublicKey, type RejectCode, type RelayChoice, type Route } from '../../shared/remote.js';
import { randomId, signText, verifyText, type Identity } from '../../shared/remote-keys.js';
import { RemoteError } from '../../remote/errors.js';
import { toNdcIceServers } from '../../remote/ice.js';
import { acquireNodeDataChannel, type DataChannel, type PeerConnection } from '../../remote/native.js';
import { joinRelay, SignalingClient } from '../../remote/signaling.js';
import { dataChannelDuplex } from '../../remote/streams.js';
import { pcIdentity } from './identity.js';

export interface RemoteTarget {
  /** "IK's M1", for messages. */
  label: string;
  macKey: PublicKey;
  signalUrl: string;
  relay: RelayChoice;
}

/** A connection to the Mac's sshd over the internet. */
export interface RemoteStream {
  sock: Duplex;
  route: Exclude<Route, 'lan'>;
  /** "peer to peer (srflx → host, UDP)" or "through signal.example.com". */
  readonly detail: string;
  /** The round trip, when WebRTC measures it. */
  rttMs(): number | null;
  close(): void;
  /** Resolves when the connection is gone. */
  readonly closed: Promise<void>;
}

export interface OpenRemoteOptions {
  signal?: AbortSignal;
  /** How long to try peer to peer before the relay (default 8 s). */
  p2pTimeoutMs?: number;
  onProgress?(text: string): void;
}

const AGENT = 'capmac-pc/1';

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function offlineError(label: string, lastSeen: number | null): RemoteError {
  return new RemoteError(
    `${label} is offline.`,
    `It is asleep, logged out, or its remote access is off${lastSeen ? ` (last seen ${ago(lastSeen)})` : ''}. Wake it or log in on it, or connect on its network.`,
    'MAC_OFFLINE',
  );
}

function rejection(label: string, code: RejectCode, message: string): RemoteError {
  switch (code) {
    case 'not-paired':
    case 'bad-signature':
      return new RemoteError(
        `${label} no longer lets this PC in over the internet.`,
        'On the Mac’s network, turn remote access on again for it (Macs › Remote access, or `capmac remote on`).',
        'NOT_PAIRED',
      );
    case 'offline':
      return offlineError(label, null);
    case 'busy':
      return new RemoteError(`${label} is busy: ${message}`, 'Try again in a minute.', 'BUSY');
    case 'stale':
      return new RemoteError(`${label} refused the connection: this PC’s clock and the Mac’s differ by more than 10 minutes.`, 'Set both clocks to update automatically.', 'CLOCK_SKEW');
    default:
      return new RemoteError(`${label} refused the connection${message ? `: ${message}` : '.'}`, undefined, 'REFUSED');
  }
}

const cancelled = () => new RemoteError('Cancelled', undefined, 'CANCELLED');
/** Errors after which the relay would fail the same way. */
const FINAL = new Set(['CANCELLED', 'NOT_PAIRED', 'MAC_OFFLINE', 'CLOCK_SKEW', 'BAD_ANSWER', 'NO_WEBRTC_FINAL']);

/** Connects to the Mac's sshd over the internet: peer to peer first, then (if allowed) the relay. */
export async function openRemote(target: RemoteTarget, options: OpenRemoteOptions = {}): Promise<RemoteStream> {
  const identity = await pcIdentity();
  options.onProgress?.('Contacting the signaling server');
  const signaling = await SignalingClient.connect({ server: target.signalUrl, role: 'pc', mac: target.macKey, identity, agent: AGENT, signal: options.signal });
  try {
    const mac = signaling.welcome.mac;
    if (mac && !mac.online) throw offlineError(target.label, mac.lastSeen);
    let p2pError: unknown = null;
    if (target.relay !== 'always') {
      try {
        options.onProgress?.('Connecting peer to peer');
        return await peerToPeer(target, identity, signaling, options);
      } catch (err) {
        if (target.relay === 'never' || FINAL.has((err as RemoteError)?.code ?? '')) throw err;
        p2pError = err;
        options.onProgress?.('Peer to peer is not possible here: using the relay');
      }
    }
    try {
      return await relay(target, identity, signaling, options);
    } catch (err) {
      if (p2pError && (err as RemoteError)?.code !== 'CANCELLED') {
        const e = err as RemoteError;
        throw new RemoteError(e.message, e.hint, e.code, [`Peer to peer: ${(p2pError as Error).message}`]);
      }
      throw err;
    }
  } finally {
    // Connected (or failed): the signaling socket is no longer needed.
    signaling.close();
  }
}

function peerToPeer(target: RemoteTarget, identity: Identity, signaling: SignalingClient, options: OpenRemoteOptions): Promise<RemoteStream> {
  const { ndc, release } = acquireNodeDataChannel();
  const session = randomId(18);
  let pc: PeerConnection;
  try {
    pc = new ndc.PeerConnection(`capmac-${session.slice(0, 6)}`, {
      iceServers: toNdcIceServers(signaling.welcome.iceServers, target.relay),
      iceTransportPolicy: 'all',
    });
  } catch (err) {
    release();
    throw new RemoteError(`Could not start WebRTC: ${(err as Error).message}`, undefined, 'WEBRTC');
  }
  return new Promise<RemoteStream>((resolve, reject) => {
    let settled = false;
    let answered = false;
    const early: Array<[string, string]> = [];
    const timer = setTimeout(() => fail(new RemoteError('No peer-to-peer path to the Mac.', undefined, 'P2P_TIMEOUT')), options.p2pTimeoutMs ?? 8000);
    const addCandidate = (candidate: string, mid: string) => {
      try {
        pc.addRemoteCandidate(candidate, mid);
      } catch {
        // a candidate libdatachannel cannot use
      }
    };
    const offMessage = signaling.onMessage((m) => {
      if (!('session' in m) || m.session !== session) return;
      if (m.t === 'answer') {
        if (answered) return;
        if (!verifyText(target.macKey, descriptionText('answer', session, target.macKey, identity.publicKey, m.answer.sdp), m.answer.sig)) {
          fail(new RemoteError(`The answer did not come from ${target.label}.`, 'Someone may be tampering with the signaling server. Connect on the Mac’s network and turn remote access on again if this keeps happening.', 'BAD_ANSWER'));
          return;
        }
        answered = true;
        try {
          pc.setRemoteDescription(m.answer.sdp, 'answer');
        } catch (err) {
          fail(new RemoteError(`The Mac's answer was not usable: ${(err as Error).message}`, undefined, 'WEBRTC'));
          return;
        }
        for (const [candidate, mid] of early.splice(0)) addCandidate(candidate, mid);
      } else if (m.t === 'candidate') {
        if (answered) addCandidate(m.candidate, m.mid);
        else early.push([m.candidate, m.mid]);
      } else if (m.t === 'reject') {
        fail(rejection(target.label, m.code, m.message));
      } else if (m.t === 'bye') {
        fail(new RemoteError(`${target.label} ended the connection attempt.`, undefined, 'BYE'));
      }
    });
    const offClose = signaling.onClose((error) => fail(error ?? new RemoteError('The signaling server closed the connection.', undefined, 'SIGNAL_LOST')));
    const onAbort = () => fail(cancelled());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    function done() {
      clearTimeout(timer);
      offMessage();
      offClose();
      options.signal?.removeEventListener('abort', onAbort);
    }
    function fail(error: RemoteError) {
      if (settled) return;
      settled = true;
      done();
      signaling.send({ t: 'bye', session });
      try {
        pc.close();
      } catch {
        // already closed
      }
      release();
      reject(error);
    }
    pc.onLocalDescription((sdp, type) => {
      if (type !== 'offer' || settled) return;
      const sig = signText(identity, descriptionText('offer', session, target.macKey, identity.publicKey, sdp));
      signaling.send({ t: 'connect', session, offer: { type: 'offer', sdp, sig } });
    });
    pc.onLocalCandidate((candidate, mid) => {
      if (!settled) signaling.send({ t: 'candidate', session, candidate, mid });
    });
    pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed') fail(new RemoteError('No peer-to-peer path to the Mac.', undefined, 'P2P_FAILED'));
    });
    const dc = pc.createDataChannel('ssh');
    dc.onOpen(() => {
      if (settled) return;
      settled = true;
      done();
      resolve(peerStream(pc, dc, release));
    });
  });
}

function peerStream(pc: PeerConnection, dc: DataChannel, release: () => void): RemoteStream {
  const sock = dataChannelDuplex(dc);
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let finished = false;
  let disconnectTimer: NodeJS.Timeout | null = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (disconnectTimer) clearTimeout(disconnectTimer);
    sock.destroy();
    try {
      pc.close();
    } catch {
      // already closed
    }
    release();
    resolveClosed();
  };
  pc.onStateChange((state) => {
    if (state === 'failed' || state === 'closed') finish();
    else if (state === 'disconnected') {
      // ICE often recovers from a short blip; give it a few seconds before giving up.
      disconnectTimer ??= setTimeout(finish, 6000);
    } else if (state === 'connected' && disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  });
  sock.once('close', finish);
  const pair = pc.getSelectedCandidatePair();
  const relayed = pair?.local.type === 'relay' || pair?.remote.type === 'relay';
  return {
    sock,
    route: relayed ? 'relay' : 'direct',
    detail: pair ? `${relayed ? 'TURN relay' : 'peer to peer'} (${pair.local.type} → ${pair.remote.type}, ${pair.local.transportType})` : 'peer to peer',
    rttMs: () => {
      if (finished) return null;
      try {
        const rtt = pc.rtt();
        return Number.isFinite(rtt) && rtt >= 0 ? rtt : null;
      } catch {
        return null;
      }
    },
    close: finish,
    closed,
  };
}

async function relay(target: RemoteTarget, identity: Identity, signaling: SignalingClient, options: OpenRemoteOptions): Promise<RemoteStream> {
  const session = randomId(18);
  const ts = Date.now();
  const sig = signText(identity, pipeRequestText(session, target.macKey, identity.publicKey, ts));
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  // The door may refuse while the relay is being set up: that says more than a closed socket.
  let refusal: RemoteError | null = null;
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RemoteError('The signaling server did not set up the relay.', undefined, 'RELAY_TIMEOUT')), 10_000);
    const off = signaling.onMessage((m) => {
      if (!('session' in m) || m.session !== session) return;
      if (m.t === 'pipe-open') {
        clearTimeout(timer);
        resolve();
      } else if (m.t === 'reject') {
        clearTimeout(timer);
        off();
        refusal = rejection(target.label, m.code, m.message);
        controller.abort();
        reject(refusal);
      }
    });
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(refusal ?? cancelled());
    }, { once: true });
  });
  try {
    options.onProgress?.('Connecting through the relay');
    signaling.send({ t: 'pipe', session, ts, sig });
    await opened;
    const sock = await joinRelay({ server: target.signalUrl, session, role: 'pc', identity, signal: controller.signal }).catch((err) => {
      throw refusal ?? err;
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
    sock.once('close', () => resolveClosed());
    return {
      sock,
      route: 'relay',
      detail: `through ${signaling.serverHost}`,
      rttMs: () => null,
      close: () => sock.destroy(),
      closed,
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
