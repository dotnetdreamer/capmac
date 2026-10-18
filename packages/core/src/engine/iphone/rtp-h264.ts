/**
 * H.264 out of RTP (RFC 6184), the way the screen-mirroring receiver (UxPlay's `-vrtp`) forwards an
 * iPhone's screen: single NAL units, STAP-A aggregates and FU-A fragments are put back together into
 * access units (one per picture: ended by the marker bit or a new timestamp), then turned into
 * CapMac's stream messages, the same ones the Mac's helpers write: the avcC config (from the SPS and
 * PPS) and AVCC frames. A lost packet drops pictures until the next keyframe, so the decoder never
 * sees a broken one.
 *
 * Pure (no sockets), so it is unit-tested with made-up packets.
 */
import { BitReader, unescapeRbsp } from '../../shared/h264.js';
import { STREAM_CONFIG, STREAM_FRAME, STREAM_HEADER_BYTES } from '../../shared/stream.js';

const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;
const STAP_A = 24;
const FU_A = 28;

export interface RtpPacket {
  marker: boolean;
  seq: number;
  timestamp: number;
  /** The stream's source id: a new one means a new stream (the receiver started its video again). */
  ssrc: number;
  payload: Uint8Array;
}

/** The RTP header (RFC 3550) read off one packet, or null when it is not RTP version 2. */
export function parseRtp(packet: Uint8Array): RtpPacket | null {
  if (packet.length < 12 || packet[0]! >> 6 !== 2) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const padding = (packet[0]! & 0x20) !== 0;
  const extension = (packet[0]! & 0x10) !== 0;
  let start = 12 + (packet[0]! & 0x0f) * 4;
  if (extension) {
    if (packet.length < start + 4) return null;
    start += 4 + view.getUint16(start + 2) * 4;
  }
  let end = packet.length;
  if (padding) end -= packet[end - 1]!;
  if (start > end) return null;
  return {
    marker: (packet[1]! & 0x80) !== 0,
    seq: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    payload: packet.subarray(start, end),
  };
}

export interface AccessUnit {
  /** The picture's NAL units, each without a start code or length. */
  nals: Uint8Array[];
  /** RTP timestamp (90 kHz). */
  timestamp: number;
  /** It holds an IDR slice: decoding can start here. */
  key: boolean;
}

/** Collects RTP packets into whole access units. */
export class H264Depacketizer {
  private nals: Uint8Array[] = [];
  private timestamp: number | null = null;
  private fragment: Uint8Array[] | null = null;
  private lastSeq: number | null = null;
  private ssrc: number | null = null;
  /** The picture being collected lost a packet. */
  private damaged = false;
  /** A packet went missing: drop pictures until a keyframe. */
  private waitingForKey = false;
  /** Packets lost so far (for diagnostics). */
  lost = 0;

  push(packet: Uint8Array): AccessUnit[] {
    const rtp = parseRtp(packet);
    if (!rtp || rtp.payload.length === 0) return [];
    const done: AccessUnit[] = [];
    if (rtp.ssrc !== this.ssrc) {
      // A new stream (the receiver started its video again): what was half collected is gone,
      // and the new stream opens with a keyframe.
      this.ssrc = rtp.ssrc;
      this.reset();
    } else if (this.lastSeq !== null) {
      // Loopback neither reorders nor repeats packets, so any jump in the sequence is loss.
      const gap = (rtp.seq - this.lastSeq - 1 + 0x10000) & 0xffff;
      if (gap > 0) {
        this.lost += gap < 0x8000 ? gap : 1;
        this.damaged = true;
        this.waitingForKey = true;
        this.fragment = null;
      }
    }
    this.lastSeq = rtp.seq;
    if (this.timestamp !== null && rtp.timestamp !== this.timestamp) this.finish(done);
    this.timestamp = rtp.timestamp;
    this.take(rtp.payload);
    if (rtp.marker) this.finish(done);
    return done;
  }

  private take(payload: Uint8Array): void {
    const type = payload[0]! & 0x1f;
    if (type >= 1 && type <= 23) {
      this.nals.push(payload.slice());
    } else if (type === STAP_A) {
      let p = 1;
      while (p + 2 <= payload.length) {
        const size = (payload[p]! << 8) | payload[p + 1]!;
        p += 2;
        if (size === 0 || p + size > payload.length) {
          this.damaged = true;
          return;
        }
        this.nals.push(payload.slice(p, p + size));
        p += size;
      }
    } else if (type === FU_A) {
      if (payload.length < 3) return;
      const header = payload[1]!;
      const start = (header & 0x80) !== 0;
      const end = (header & 0x40) !== 0;
      if (start) {
        this.fragment = [Uint8Array.of((payload[0]! & 0xe0) | (header & 0x1f)), payload.slice(2)];
      } else if (this.fragment) {
        this.fragment.push(payload.slice(2));
      } else {
        this.damaged = true; // a middle or end without its start
        return;
      }
      if (end && this.fragment) {
        this.nals.push(concat(this.fragment));
        this.fragment = null;
      }
    }
    // STAP-B, MTAP and FU-B belong to the interleaved mode, which the receiver never sends.
  }

  /** Forgets the stream so far (a new stream, or a new client): only a keyframe starts pictures again. */
  reset(): void {
    this.nals = [];
    this.timestamp = null;
    this.fragment = null;
    this.lastSeq = null;
    this.damaged = false;
    this.waitingForKey = true;
  }

  private finish(done: AccessUnit[]): void {
    const nals = this.nals;
    const damaged = this.damaged || this.fragment !== null;
    this.nals = [];
    this.fragment = null;
    this.damaged = false;
    if (!nals.length || this.timestamp === null) return;
    const key = nals.some((nal) => (nal[0]! & 0x1f) === NAL_IDR);
    if (damaged) return;
    if (this.waitingForKey) {
      if (!key) return;
      this.waitingForKey = false;
    }
    done.push({ nals, timestamp: this.timestamp, key });
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** The picture size an SPS (with its NAL header byte) declares, cropping included; null when it cannot be read. */
export function spsSize(sps: Uint8Array): { width: number; height: number } | null {
  if (sps.length < 4 || (sps[0]! & 0x1f) !== NAL_SPS) return null;
  try {
    const r = new BitReader(unescapeRbsp(sps.subarray(1)));
    const profile = r.u(8);
    r.u(16); // constraint flags, level
    r.ue(); // seq_parameter_set_id
    let chroma = 1;
    if (HIGH_PROFILES.has(profile)) {
      chroma = r.ue();
      if (chroma === 3) r.u(1);
      r.ue(); // bit depth luma
      r.ue(); // bit depth chroma
      r.u(1);
      if (r.u(1)) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (!r.u(1)) continue;
          let last = 8;
          let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue();
    } else if (pocType === 1) {
      r.u(1);
      r.se();
      r.se();
      const cycle = r.ue();
      for (let i = 0; i < cycle; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.u(1); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = r.ue() + 1;
    const heightUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);
    r.u(1); // direct_8x8_inference_flag
    let width = widthMbs * 16;
    let height = (2 - frameMbsOnly) * heightUnits * 16;
    if (r.u(1)) {
      const left = r.ue();
      const right = r.ue();
      const top = r.ue();
      const bottom = r.ue();
      const cropX = chroma === 1 || chroma === 2 ? 2 : 1;
      const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
      width -= cropX * (left + right);
      height -= cropY * (top + bottom);
    }
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

/** The AVCDecoderConfigurationRecord (avcC) for one SPS and one PPS, with 4-byte NAL lengths. */
export function avccRecord(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1, sps.length >> 8, sps.length & 0xff], 0);
  out.set(sps, 8);
  let p = 8 + sps.length;
  out.set([1, pps.length >> 8, pps.length & 0xff], p);
  p += 3;
  out.set(pps, p);
  return out;
}

/** One stream message: the 16-byte header (type, flags, capture time in µs, sequence), then the payload. */
export function streamMessage(type: number, key: boolean, captureUs: number, seq: number, payload: Uint8Array): Buffer {
  const message = Buffer.alloc(STREAM_HEADER_BYTES + payload.length);
  message.writeUInt8(type, 0);
  message.writeUInt8(key ? 1 : 0, 1);
  message.writeBigUInt64BE(BigInt(Math.max(0, Math.round(captureUs))), 4);
  message.writeUInt32BE(seq >>> 0, 12);
  message.set(payload, STREAM_HEADER_BYTES);
  return message;
}

/**
 * Access units → CapMac's stream messages: a config whenever the SPS or PPS change (the picture
 * size comes from the SPS), then each picture as an AVCC frame (4-byte lengths, without the
 * parameter sets and delimiters, which the config already carries).
 */
export class H264Messages {
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private config: Buffer | null = null;
  private seq = 0;

  /** The current config message, for a viewer that joins late. */
  get lastConfig(): Buffer | null {
    return this.config;
  }

  push(unit: AccessUnit, captureUs: number): Buffer[] {
    const out: Buffer[] = [];
    let changed = false;
    const slices: Uint8Array[] = [];
    for (const nal of unit.nals) {
      const type = nal[0]! & 0x1f;
      if (type === NAL_SPS) {
        if (!this.sps || !equal(this.sps, nal)) changed = true;
        this.sps = nal;
      } else if (type === NAL_PPS) {
        if (!this.pps || !equal(this.pps, nal)) changed = true;
        this.pps = nal;
      } else if (type !== NAL_AUD) {
        slices.push(nal);
      }
    }
    if (changed && this.sps && this.pps) {
      const size = spsSize(this.sps);
      if (size) {
        const avcc = avccRecord(this.sps, this.pps);
        const payload = new Uint8Array(4 + avcc.length);
        new DataView(payload.buffer).setUint16(0, size.width);
        new DataView(payload.buffer).setUint16(2, size.height);
        payload.set(avcc, 4);
        this.config = streamMessage(STREAM_CONFIG, true, captureUs, this.nextSeq(), payload);
        out.push(this.config);
      }
    }
    // Nothing to show until the decoder has a config.
    if (!this.config || !slices.length) return out;
    const frame = new Uint8Array(slices.reduce((total, nal) => total + 4 + nal.length, 0));
    const view = new DataView(frame.buffer);
    let p = 0;
    for (const nal of slices) {
      view.setUint32(p, nal.length);
      frame.set(nal, p + 4);
      p += 4 + nal.length;
    }
    out.push(streamMessage(STREAM_FRAME, unit.key, captureUs, this.nextSeq(), frame));
    return out;
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) >>> 0;
    return this.seq;
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
