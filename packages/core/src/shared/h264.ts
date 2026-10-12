/**
 * Makes an H.264 stream decode with no delay. VideoToolbox writes no
 * "bitstream restriction" into its SPS, so a decoder has to assume frames may
 * come out of order and holds up to a DPB's worth of them (on Windows, about
 * a quarter of a second at 60 fps) even though capmac's helper never reorders.
 * Declaring max_num_reorder_frames = 0 in the SPS's VUI lets decoders output
 * every frame as soon as it is decoded.
 *
 * No Node.js APIs here: the screen worker uses it.
 */

/** Removes emulation-prevention bytes (00 00 03 → 00 00). */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i]!;
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

/** Adds emulation-prevention bytes where the payload would otherwise look like a start code. */
export function escapeRbsp(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

export class BitReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get bitsLeft(): number {
    return this.bytes.length * 8 - this.pos;
  }

  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.bytes.length * 8) throw new Error('SPS ended early');
      v = v * 2 + ((this.bytes[this.pos >> 3]! >> (7 - (this.pos & 7))) & 1);
      this.pos += 1;
    }
    return v;
  }

  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros += 1;
      if (zeros > 31) throw new Error('Corrupt SPS (exp-Golomb)');
    }
    return zeros ? 2 ** zeros - 1 + this.u(zeros) : 0;
  }

  se(): number {
    const k = this.ue();
    return k % 2 ? (k + 1) / 2 : -(k / 2);
  }
}

export class BitWriter {
  private readonly bits: number[] = [];

  u(n: number, value: number): void {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
  }

  ue(value: number): void {
    const v = value + 1;
    const length = Math.floor(Math.log2(v));
    this.u(length, 0);
    this.u(length + 1, v);
  }

  se(value: number): void {
    this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }

  /** rbsp_trailing_bits: a 1, then zeros to the byte boundary. */
  trailing(): void {
    this.bits.push(1);
    while (this.bits.length % 8) this.bits.push(0);
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) out[i >> 3]! |= 0x80 >> (i & 7);
    });
    return out;
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** Reads and copies `reader` → `writer` field by field. */
class Copier {
  constructor(readonly r: BitReader, readonly w: BitWriter) {}
  u(n: number): number {
    const v = this.r.u(n);
    this.w.u(n, v);
    return v;
  }
  ue(): number {
    const v = this.r.ue();
    this.w.ue(v);
    return v;
  }
  se(): number {
    const v = this.r.se();
    this.w.se(v);
    return v;
  }
}

function copyScalingList(c: Copier, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      const delta = c.se();
      next = (last + delta + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

function copyHrd(c: Copier): void {
  const count = c.ue() + 1;
  c.u(4);
  c.u(4);
  for (let i = 0; i < count; i++) {
    c.ue();
    c.ue();
    c.u(1);
  }
  c.u(5);
  c.u(5);
  c.u(5);
  c.u(5);
}

function writeRestriction(w: BitWriter, maxDecFrameBuffering: number): void {
  w.u(1, 1); // motion_vectors_over_pic_boundaries_flag
  w.ue(2); // max_bytes_per_pic_denom (the default)
  w.ue(1); // max_bits_per_mb_denom (the default)
  w.ue(16); // log2_max_mv_length_horizontal (no limit)
  w.ue(16); // log2_max_mv_length_vertical
  w.ue(0); // max_num_reorder_frames: frames come out in decode order
  w.ue(maxDecFrameBuffering);
}

/**
 * The SPS NAL unit (with its header byte) rewritten to declare no frame
 * reordering, or null when it cannot be parsed (then keep the original).
 */
export function lowLatencySps(nal: Uint8Array): Uint8Array | null {
  if (nal.length < 4 || (nal[0]! & 0x1f) !== 7) return null;
  try {
    const r = new BitReader(unescapeRbsp(nal.subarray(1)));
    const w = new BitWriter();
    const c = new Copier(r, w);
    const profile = c.u(8);
    c.u(8); // constraint flags
    c.u(8); // level
    c.ue(); // seq_parameter_set_id
    if (HIGH_PROFILES.has(profile)) {
      const chroma = c.ue();
      if (chroma === 3) c.u(1);
      c.ue(); // bit depth luma
      c.ue(); // bit depth chroma
      c.u(1); // qpprime_y_zero_transform_bypass_flag
      if (c.u(1)) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (c.u(1)) copyScalingList(c, i < 6 ? 16 : 64);
      }
    }
    c.ue(); // log2_max_frame_num_minus4
    const pocType = c.ue();
    if (pocType === 0) {
      c.ue();
    } else if (pocType === 1) {
      c.u(1);
      c.se();
      c.se();
      const cycle = c.ue();
      for (let i = 0; i < cycle; i++) c.se();
    }
    const refFrames = c.ue();
    c.u(1); // gaps_in_frame_num_value_allowed_flag
    c.ue(); // width in MBs - 1
    c.ue(); // height in map units - 1
    if (!c.u(1)) c.u(1); // frame_mbs_only_flag, mb_adaptive_frame_field_flag
    c.u(1); // direct_8x8_inference_flag
    if (c.u(1)) {
      c.ue();
      c.ue();
      c.ue();
      c.ue();
    }
    const buffering = Math.max(1, refFrames);
    const vui = r.u(1);
    w.u(1, 1);
    if (!vui) {
      // A VUI with nothing but the restriction.
      w.u(1, 0); // aspect_ratio_info_present_flag
      w.u(1, 0); // overscan_info_present_flag
      w.u(1, 0); // video_signal_type_present_flag
      w.u(1, 0); // chroma_loc_info_present_flag
      w.u(1, 0); // timing_info_present_flag
      w.u(1, 0); // nal_hrd_parameters_present_flag
      w.u(1, 0); // vcl_hrd_parameters_present_flag
      w.u(1, 0); // pic_struct_present_flag
      w.u(1, 1); // bitstream_restriction_flag
      writeRestriction(w, buffering);
    } else {
      if (c.u(1) && c.u(8) === 255) {
        c.u(16);
        c.u(16);
      }
      if (c.u(1)) c.u(1);
      if (c.u(1)) {
        c.u(3);
        c.u(1);
        if (c.u(1)) {
          c.u(8);
          c.u(8);
          c.u(8);
        }
      }
      if (c.u(1)) {
        c.ue();
        c.ue();
      }
      if (c.u(1)) {
        c.u(32);
        c.u(32);
        c.u(1);
      }
      const nalHrd = c.u(1);
      if (nalHrd) copyHrd(c);
      const vclHrd = c.u(1);
      if (vclHrd) copyHrd(c);
      if (nalHrd || vclHrd) c.u(1);
      c.u(1); // pic_struct_present_flag
      const restricted = r.u(1);
      w.u(1, 1);
      if (restricted) {
        // Keep the encoder's own limits; only the reordering changes.
        for (let i = 0; i < 4; i++) {
          if (i === 0) c.u(1);
          c.ue();
        }
        r.ue(); // max_num_reorder_frames
        w.ue(0);
        const dpb = r.ue();
        w.ue(Math.max(1, dpb));
      } else {
        writeRestriction(w, buffering);
      }
    }
    w.trailing();
    const body = escapeRbsp(w.bytes());
    const out = new Uint8Array(1 + body.length);
    out[0] = nal[0]!;
    out.set(body, 1);
    return out;
  } catch {
    return null;
  }
}

/** An avcC record with each SPS rewritten by lowLatencySps (the original when one cannot be). */
export function lowLatencyAvcc(avcc: Uint8Array): Uint8Array {
  if (avcc.length < 7 || avcc[0] !== 1) return avcc;
  try {
    const parts: number[] = [...avcc.subarray(0, 5)];
    let p = 5;
    const spsCount = avcc[p]! & 0x1f;
    parts.push(avcc[p]!);
    p += 1;
    for (let i = 0; i < spsCount; i++) {
      const length = (avcc[p]! << 8) | avcc[p + 1]!;
      const sps = avcc.subarray(p + 2, p + 2 + length);
      if (sps.length !== length) return avcc;
      const patched = lowLatencySps(sps) ?? sps;
      parts.push(patched.length >> 8, patched.length & 0xff, ...patched);
      p += 2 + length;
    }
    // PPS and anything after them unchanged.
    parts.push(...avcc.subarray(p));
    return Uint8Array.from(parts);
  } catch {
    return avcc;
  }
}
