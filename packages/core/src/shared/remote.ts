/**
 * Remote access ("Reach this Mac from anywhere"). CapMac's SSH connection to
 * the Mac travels inside a WebRTC data channel, peer to peer, or through the
 * signaling server's relay when no direct path exists. These are the messages
 * between CapMac on the PC, the signaling server and the door on the Mac, and
 * the texts each side signs.
 *
 * SSH stays the security boundary: the pinned host key and CapMac's key
 * protect everything end to end. The signatures here keep the server out of
 * the middle of a direct connection, and keep everyone but a paired PC away
 * from the Mac's sshd.
 *
 * No Node.js APIs here: CapMac Studio's renderer reads these types too.
 */

export const REMOTE_PROTOCOL = 1;

/** The WebRTC library the door installs on the Mac (the PC uses the copy CapMac ships). */
export const NODE_DATACHANNEL_VERSION = '0.33.4';

/** The door needs Node.js 22 or later on the Mac (for its built-in WebSocket). */
export const DOOR_MIN_NODE_MAJOR = 22;

/** An Ed25519 public key: its raw 32 bytes, base64url (43 characters). */
export type PublicKey = string;

export const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

/** Which way CapMac reaches a Mac. */
export type RouteChoice = 'auto' | 'lan' | 'internet';
/** Whether a connection over the internet may go through the relay. */
export type RelayChoice = 'allow' | 'never' | 'always';
/** How a connection actually goes: the local network, peer to peer over the internet, or through the relay. */
export type Route = 'lan' | 'direct' | 'relay';

export const ROUTE_CHOICES = ['auto', 'lan', 'internet'] as const satisfies readonly RouteChoice[];
export const RELAY_CHOICES = ['allow', 'never', 'always'] as const satisfies readonly RelayChoice[];

/** An ICE server, as WebRTC describes it. */
export interface IceServerSpec {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** A WebRTC session description, signed by the side that made it. */
export interface SignedDescription {
  type: 'offer' | 'answer';
  sdp: string;
  sig: string;
}

/** Why the door, or the server, turned a connection down. */
export type RejectCode = 'not-paired' | 'bad-signature' | 'busy' | 'offline' | 'stale' | 'error';

/** Messages the signaling server sends. */
export type ServerMessage =
  | { t: 'challenge'; nonce: string; protocol: number; server: string }
  /** After a good hello. A PC also learns whether its Mac is online. */
  | { t: 'welcome'; iceServers: IceServerSpec[]; mac?: { online: boolean; lastSeen: number | null } }
  /** To a PC: its Mac came online or went offline. */
  | { t: 'presence'; online: boolean; lastSeen: number | null }
  /** To the door: a PC wants a peer-to-peer connection. */
  | { t: 'incoming'; session: string; pc: PublicKey; offer: SignedDescription; iceServers: IceServerSpec[] }
  /** To the door: a PC wants a connection through the relay. */
  | { t: 'pipe'; session: string; pc: PublicKey; ts: number; sig: string }
  /** To a PC: its relay is set up; join it at /v1/pipe/<session>. */
  | { t: 'pipe-open'; session: string }
  /** To a PC: the door's answer. */
  | { t: 'answer'; session: string; answer: SignedDescription }
  | { t: 'candidate'; session: string; candidate: string; mid: string }
  | { t: 'reject'; session: string; code: RejectCode; message: string }
  | { t: 'bye'; session: string }
  /** On a relay socket: both ends are there; binary frames from now on. */
  | { t: 'ready'; session: string }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string };

/** Messages a PC or a door sends. */
export type ClientMessage =
  | { t: 'hello'; role: 'mac' | 'pc'; key: PublicKey; sig: string; agent?: string }
  | { t: 'connect'; session: string; offer: SignedDescription }
  | { t: 'pipe'; session: string; ts: number; sig: string }
  | { t: 'answer'; session: string; answer: SignedDescription }
  | { t: 'candidate'; session: string; candidate: string; mid: string }
  | { t: 'reject'; session: string; code: RejectCode; message: string }
  | { t: 'bye'; session: string }
  | { t: 'ping' };

// ─── What each side signs ──────────────────────────────────────────────────
// One line per field, with a fixed prefix per purpose, so a signature made for
// one purpose can never be replayed as another.

/** A hello on the signaling socket: proves who is connecting (`mac` is the Mac the socket is about). */
export function helloText(role: 'mac' | 'pc', nonce: string, mac: PublicKey, key: PublicKey): string {
  return ['capmac-signal/1', 'hello', role, nonce, mac, key].join('\n');
}

/** A hello on a relay socket. */
export function pipeHelloText(role: 'mac' | 'pc', nonce: string, session: string, key: PublicKey): string {
  return ['capmac-signal/1', 'pipe-hello', role, nonce, session, key].join('\n');
}

/**
 * An offer or answer: binds the DTLS certificate fingerprints in the SDP to
 * the signer, so the server cannot put itself in the middle.
 */
export function descriptionText(type: 'offer' | 'answer', session: string, mac: PublicKey, pc: PublicKey, sdp: string): string {
  return ['capmac-remote/1', type, session, mac, pc, sdpFingerprints(sdp).join(',')].join('\n');
}

/** A PC's request for a relay connection (`ts`: ms since the epoch, checked loosely against the Mac's clock). */
export function pipeRequestText(session: string, mac: PublicKey, pc: PublicKey, ts: number): string {
  return ['capmac-remote/1', 'pipe', session, mac, pc, String(ts)].join('\n');
}

/** A relay request older (or newer) than this, by the Mac's clock, is refused. */
export const PIPE_REQUEST_MAX_SKEW_MS = 10 * 60_000;

/** The `a=fingerprint` lines of an SDP, normalized ("sha-256 AB:CD:…"), sorted. */
export function sdpFingerprints(sdp: string): string[] {
  const found = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const m = line.match(/^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/);
    if (m) found.add(`${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}`);
  }
  return [...found].sort();
}

export function isPublicKey(value: unknown): value is PublicKey {
  return typeof value === 'string' && PUBLIC_KEY_RE.test(value);
}

export function isSession(value: unknown): value is string {
  return typeof value === 'string' && SESSION_RE.test(value);
}

export function isSignature(value: unknown): value is string {
  return typeof value === 'string' && SIGNATURE_RE.test(value);
}

/** The signaling server's address as a WebSocket URL ("https://x" and "x" become "wss://x"). */
export function signalSocketUrl(base: string, path: string): string {
  let url = base.trim().replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(url)) url = `wss://${url}`;
  url = url.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return `${url}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Checks a signaling server address typed by someone; returns the problem, or null. */
export function signalUrlProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return 'Enter the address of your signaling server.';
  let url: URL;
  try {
    url = new URL(signalSocketUrl(text, '/'));
  } catch {
    return 'That is not a valid address.';
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return 'Use a wss:// (or https://) address.';
  if (url.protocol === 'ws:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return 'Use wss:// (encrypted) for a server that is not on this computer.';
  return null;
}

/** A short, readable form of a key for lists ("x3Fq…9bA"). */
export function shortKey(key: PublicKey): string {
  return key.length > 12 ? `${key.slice(0, 5)}…${key.slice(-4)}` : key;
}
