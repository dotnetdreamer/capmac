import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter, escapeRbsp, lowLatencyAvcc, lowLatencySps, unescapeRbsp } from '../../packages/core/src/shared/h264.js';
import { avcCodecString, parseStreamHeader, parseVideoConfig, STREAM_CONFIG, STREAM_FRAME, StreamSplitter } from '../../packages/core/src/shared/stream.js';

/** A helper message as simstream writes it (with its u32 length prefix). */
function message(type: number, flags: number, captureUs: bigint, seq: number, payload: Uint8Array): Buffer {
  const head = Buffer.alloc(20);
  head.writeUInt32BE(16 + payload.length, 0);
  head.writeUInt8(type, 4);
  head.writeUInt8(flags, 5);
  head.writeBigUInt64BE(captureUs, 8);
  head.writeUInt32BE(seq, 16);
  return Buffer.concat([head, payload]);
}

// The config simstream sent for iPhone 17 at 642×1398 (Xcode 26.6): avcC with one SPS and one PPS.
const REAL_AVCC = Buffer.from('01640028ffe1000c27640028ac5680a40b1e226401000428ee3cb0', 'hex');
const REAL_AVCC_HD = Buffer.from('0164002affe1000c2764002aac5680cc0dde79d001000428ee3cb0', 'hex');

/** An independent SPS reader for the tests: the fields the patch must keep, and the VUI restriction. */
function readSps(nal: Uint8Array) {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const profile = r.u(8);
  r.u(8);
  const level = r.u(8);
  r.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = r.ue();
    if (chroma === 3) r.u(1);
    r.ue();
    r.ue();
    r.u(1);
    expect(r.u(1)).toBe(0); // no scaling matrices in these tests
  }
  r.ue();
  const poc = r.ue();
  if (poc === 0) r.ue();
  const refFrames = r.ue();
  r.u(1);
  const widthMbs = r.ue() + 1;
  const heightUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  const crop = r.u(1) ? [r.ue(), r.ue(), r.ue(), r.ue()] : null;
  const vui: Record<string, unknown> = {};
  if (r.u(1)) {
    if (r.u(1)) vui.aspect = r.u(8);
    if (r.u(1)) r.u(1);
    if (r.u(1)) {
      vui.videoFormat = r.u(3);
      vui.fullRange = r.u(1);
      if (r.u(1)) vui.colour = [r.u(8), r.u(8), r.u(8)];
    }
    if (r.u(1)) {
      r.ue();
      r.ue();
    }
    if (r.u(1)) vui.timing = [r.u(32), r.u(32), r.u(1)];
    const hrd = () => {
      const n = r.ue() + 1;
      r.u(4);
      r.u(4);
      for (let i = 0; i < n; i++) {
        r.ue();
        r.ue();
        r.u(1);
      }
      r.u(20);
    };
    const nal = r.u(1);
    if (nal) hrd();
    const vcl = r.u(1);
    if (vcl) hrd();
    if (nal || vcl) vui.lowDelay = r.u(1);
    vui.picStruct = r.u(1);
    if (r.u(1)) {
      r.u(1);
      r.ue();
      r.ue();
      r.ue();
      r.ue();
      vui.reorder = r.ue();
      vui.dpb = r.ue();
    }
  }
  expect(r.u(1)).toBe(1); // rbsp_stop_one_bit
  return { profile, level, refFrames, widthMbs, heightUnits, frameMbsOnly, crop, vui };
}

function sps(build: (w: BitWriter) => void): Uint8Array {
  const w = new BitWriter();
  build(w);
  w.trailing();
  return Uint8Array.from([0x67, ...escapeRbsp(w.bytes())]);
}

/** The fields before the VUI, for a High profile 1280×720 stream. */
function spsHead(w: BitWriter, refFrames = 1): void {
  w.u(8, 100);
  w.u(8, 0);
  w.u(8, 31);
  w.ue(0);
  w.ue(1); // 4:2:0
  w.ue(0);
  w.ue(0);
  w.u(1, 0);
  w.u(1, 0); // no scaling matrix
  w.ue(0);
  w.ue(2); // POC type 2
  w.ue(refFrames);
  w.u(1, 0);
  w.ue(79); // 80 MBs wide
  w.ue(44); // 45 tall
  w.u(1, 1);
  w.u(1, 1);
  w.u(1, 0); // no cropping
}

describe('stream messages', () => {
  it('reads the header: type, keyframe flag, capture time, sequence', () => {
    const m = message(STREAM_FRAME, 1, 1_760_000_123_456_789n, 42, Uint8Array.from([9, 9])).subarray(4);
    expect(parseStreamHeader(m)).toEqual({ type: STREAM_FRAME, key: true, captureUs: 1_760_000_123_456_789, seq: 42 });
    expect(parseStreamHeader(m.subarray(0, 10))).toBeNull();
  });

  it('splits the helper output at every byte boundary', () => {
    const stream = Buffer.concat([
      message(STREAM_CONFIG, 0, 1n, 1, Uint8Array.from([0, 2, 0, 4, ...REAL_AVCC])),
      message(STREAM_FRAME, 1, 2n, 2, new Uint8Array(3000).fill(7)),
      message(STREAM_FRAME, 0, 3n, 3, Uint8Array.from([1])),
    ]);
    for (let cut = 1; cut < stream.length; cut += 7) {
      const splitter = new StreamSplitter();
      const out = [...splitter.push(stream.subarray(0, cut)), ...splitter.push(stream.subarray(cut))];
      expect(out.map((m) => parseStreamHeader(m)!.seq)).toEqual([1, 2, 3]);
      expect(out[1]!.length).toBe(16 + 3000);
    }
  });

  it('rejects a corrupt length instead of buffering forever', () => {
    expect(() => new StreamSplitter().push(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 1]))).toThrow(/Corrupt/);
  });

  it('derives the WebCodecs codec string from the avcC record', () => {
    expect(avcCodecString(REAL_AVCC)).toBe('avc1.640028');
    expect(avcCodecString(REAL_AVCC_HD)).toBe('avc1.64002a');
    expect(avcCodecString(Uint8Array.from([0, 1, 2]))).toBeNull();
  });

  it('reads a config message: size, codec, and a description that decodes without delay', () => {
    const m = message(STREAM_CONFIG, 0, 1n, 1, Uint8Array.from([0x02, 0x82, 0x05, 0x76, ...REAL_AVCC])).subarray(4);
    const config = parseVideoConfig(m)!;
    expect(config).toMatchObject({ width: 642, height: 1398, codec: 'avc1.640028' });
    const spsLength = (config.description[6]! << 8) | config.description[7]!;
    expect(readSps(config.description.subarray(8, 8 + spsLength)).vui).toMatchObject({ reorder: 0 });
  });
});

describe('H.264 SPS for low latency', () => {
  it('declares no reordering in the SPS VideoToolbox writes, keeping everything else', () => {
    for (const avcc of [REAL_AVCC, REAL_AVCC_HD]) {
      const before = avcc.subarray(8, 8 + avcc.readUInt16BE(6));
      const after = lowLatencySps(before)!;
      expect(after).not.toBeNull();
      const a = readSps(before);
      const b = readSps(after);
      expect(b.vui.reorder).toBe(0);
      expect(b.vui.dpb).toBeGreaterThanOrEqual(1);
      expect({ ...b, vui: undefined }).toEqual({ ...a, vui: undefined });
      // The VUI fields VideoToolbox set (colour, timing, …) are still there.
      for (const [k, v] of Object.entries(a.vui)) if (k !== 'reorder' && k !== 'dpb') expect(b.vui[k]).toEqual(v);
    }
    // 642×1398: 41×88 macroblocks (the encoder crops the padding).
    const real = readSps(lowLatencySps(REAL_AVCC.subarray(8, 20))!);
    expect([real.widthMbs, real.heightUnits]).toEqual([41, 88]);
  });

  it('adds a VUI when there is none', () => {
    const out = readSps(lowLatencySps(sps((w) => {
      spsHead(w, 2);
      w.u(1, 0);
    }))!);
    expect(out).toMatchObject({ profile: 100, refFrames: 2, widthMbs: 80, heightUnits: 45, vui: { reorder: 0, dpb: 2 } });
  });

  it('keeps timing and HRD parameters when it rewrites the VUI', () => {
    const out = readSps(lowLatencySps(sps((w) => {
      spsHead(w);
      w.u(1, 1); // VUI
      w.u(1, 1);
      w.u(8, 1); // aspect 1:1
      w.u(1, 0);
      w.u(1, 1);
      w.u(3, 5);
      w.u(1, 0);
      w.u(1, 1);
      w.u(8, 1);
      w.u(8, 1);
      w.u(8, 1); // BT.709
      w.u(1, 0);
      w.u(1, 1);
      w.u(32, 1);
      w.u(32, 120);
      w.u(1, 0); // timing
      w.u(1, 1); // NAL HRD
      w.ue(0);
      w.u(4, 0);
      w.u(4, 0);
      w.ue(1000);
      w.ue(2000);
      w.u(1, 0);
      w.u(5, 23);
      w.u(5, 23);
      w.u(5, 23);
      w.u(5, 24);
      w.u(1, 0); // VCL HRD
      w.u(1, 1); // low delay
      w.u(1, 0); // pic struct
      w.u(1, 0); // no restriction
    }))!);
    expect(out.vui).toEqual({ aspect: 1, videoFormat: 5, fullRange: 0, colour: [1, 1, 1], timing: [1, 120, 0], lowDelay: 1, picStruct: 0, reorder: 0, dpb: 1 });
  });

  it('replaces an existing reorder depth', () => {
    const out = readSps(lowLatencySps(sps((w) => {
      spsHead(w, 4);
      w.u(1, 1);
      for (let i = 0; i < 8; i++) w.u(1, 0);
      w.u(1, 1); // restriction present
      w.u(1, 1);
      w.ue(2);
      w.ue(1);
      w.ue(15);
      w.ue(15);
      w.ue(3); // reorder 3
      w.ue(4);
    }))!);
    expect(out.vui).toMatchObject({ reorder: 0, dpb: 4 });
  });

  it('leaves anything it cannot parse alone', () => {
    expect(lowLatencySps(Uint8Array.from([0x68, 1, 2, 3]))).toBeNull(); // a PPS
    expect(lowLatencySps(Uint8Array.from([0x67, 0x64, 0, 0x28]))).toBeNull(); // truncated
    expect(lowLatencyAvcc(Uint8Array.from([1, 2, 3]))).toEqual(Uint8Array.from([1, 2, 3]));
    // The PPS of the real record passes through untouched.
    const out = lowLatencyAvcc(REAL_AVCC);
    expect(Buffer.from(out.subarray(out.length - 7)).toString('hex')).toBe('01000428ee3cb0');
  });

  it('round-trips emulation prevention', () => {
    const raw = Uint8Array.from([0, 0, 1, 0, 0, 0, 0, 0, 3, 7, 0, 0]);
    expect(unescapeRbsp(escapeRbsp(raw))).toEqual(raw);
    expect([...escapeRbsp(Uint8Array.from([0, 0, 1]))]).toEqual([0, 0, 3, 1]);
  });
});
