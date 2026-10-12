/**
 * The H.264 simulator stream (v2): messages from capmac's helper on the Mac
 * (`simstream`), relayed unchanged by the agent's `stream` op to the engine
 * and on to the screen worker, which decodes them with WebCodecs.
 *
 * Each message: u8 type, u8 flags (bit 0: keyframe), u16 reserved,
 * u64 capture time (Unix epoch µs, the Mac's clock), u32 sequence number,
 * then the payload. On the helper's stdout each message is preceded by its
 * u32 big-endian length; agent frames carry one message each.
 *
 * No Node.js APIs here: the renderer's worker uses this module too.
 */
import { lowLatencyAvcc } from './h264.js';

export const STREAM_CONFIG = 1;
export const STREAM_FRAME = 2;
export const STREAM_PONG = 3;
export const STREAM_EVENT = 4;

export const STREAM_HEADER_BYTES = 16;

export interface StreamHeader {
  type: number;
  key: boolean;
  /** When the screen changed, Unix epoch µs on the Mac's clock. */
  captureUs: number;
  seq: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Reads a message's header, or null when it is too short to be one. */
export function parseStreamHeader(message: Uint8Array): StreamHeader | null {
  if (message.byteLength < STREAM_HEADER_BYTES) return null;
  const v = view(message);
  return {
    type: v.getUint8(0),
    key: (v.getUint8(1) & 1) === 1,
    captureUs: Number(v.getBigUint64(4)),
    seq: v.getUint32(12),
  };
}

export function streamPayload(message: Uint8Array): Uint8Array {
  return message.subarray(STREAM_HEADER_BYTES);
}

export interface VideoConfig {
  width: number;
  height: number;
  /** WebCodecs codec string, e.g. "avc1.640028". */
  codec: string;
  /** The AVCDecoderConfigurationRecord: WebCodecs' `description`. */
  description: Uint8Array;
}

/**
 * The RFC 6381 codec string for an avcC record: profile, constraint flags
 * and level, as WebCodecs wants it ("avc1.640028" for High 4.0).
 */
export function avcCodecString(avcc: Uint8Array): string | null {
  if (avcc.byteLength < 7 || avcc[0] !== 1) return null;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcc[1]!)}${hex(avcc[2]!)}${hex(avcc[3]!)}`;
}

/**
 * Reads a config message: the video size and the decoder configuration, with
 * the SPS declaring that frames never need reordering (see h264.ts), so the
 * decoder shows each frame as soon as it is decoded.
 */
export function parseVideoConfig(message: Uint8Array): VideoConfig | null {
  const header = parseStreamHeader(message);
  if (!header || header.type !== STREAM_CONFIG) return null;
  const payload = streamPayload(message);
  if (payload.byteLength < 4 + 7) return null;
  const v = view(payload);
  const description = lowLatencyAvcc(payload.slice(4));
  const codec = avcCodecString(description);
  if (!codec) return null;
  return { width: v.getUint16(0), height: v.getUint16(2), codec, description };
}

/**
 * Splits the helper's stdout into messages (each without its length prefix).
 * Keeps chunks in a list and copies only once a whole message is there.
 */
export class StreamSplitter {
  private chunks: Uint8Array[] = [];
  private buffered = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength) {
      this.chunks.push(chunk);
      this.buffered += chunk.byteLength;
    }
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.buffered < 4) break;
      const head = this.peek(4);
      const length = view(head).getUint32(0);
      if (length < STREAM_HEADER_BYTES || length > 64 * 1024 * 1024) throw new Error(`Corrupt stream (message length ${length})`);
      if (this.buffered < 4 + length) break;
      out.push(this.take(4 + length).subarray(4));
    }
    return out;
  }

  private peek(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength >= n) return first.subarray(0, n);
    return this.copy(n, false);
  }

  private take(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength === n) {
      this.chunks.shift();
      this.buffered -= n;
      return first;
    }
    if (first.byteLength > n) {
      this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    return this.copy(n, true);
  }

  private copy(n: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(n);
    let offset = 0;
    let i = 0;
    while (offset < n) {
      const chunk = this.chunks[i]!;
      const part = Math.min(chunk.byteLength, n - offset);
      out.set(chunk.subarray(0, part), offset);
      offset += part;
      if (consume) {
        if (part === chunk.byteLength) this.chunks.shift();
        else this.chunks[0] = chunk.subarray(part);
      } else {
        i += 1;
      }
    }
    if (consume) this.buffered -= n;
    return out;
  }
}

/** What the helper says about itself when it starts (an event message). */
export interface HelperHello {
  t: 'hello';
  device: string;
  video: boolean;
  api: 'SimScreen' | 'SimDisplayRenderable' | 'none';
  input: boolean;
  inputReason?: string;
  coreSimulator: string;
  scale?: number;
  pixels?: { width: number; height: number };
  points?: { width: number; height: number };
}

/** Once a second: what happened on the Mac since the last status. */
export interface HelperStatus {
  t: 'status';
  /** Screen updates CoreSimulator reported. */
  callbacks: number;
  encoded: number;
  sent: number;
  dropped: number;
  /** The framebuffer IOSurface's seed (changes when it is drawn to). */
  seed: number;
  /** The helper's memory footprint in bytes. */
  footprint: number;
  /** Bytes waiting on the helper's stdout. */
  queued: number;
  width: number;
  height: number;
}

export type HelperEvent =
  | HelperHello
  | HelperStatus
  | { t: 'input-error'; message: string }
  | { t: 'fatal'; code: string; message: string };

export function parseHelperEvent(message: Uint8Array): HelperEvent | null {
  const header = parseStreamHeader(message);
  if (!header || header.type !== STREAM_EVENT) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(streamPayload(message)));
    return value && typeof value.t === 'string' ? (value as HelperEvent) : null;
  } catch {
    return null;
  }
}
