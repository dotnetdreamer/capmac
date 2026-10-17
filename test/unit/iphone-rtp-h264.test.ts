import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { avccRecord, H264Depacketizer, H264Messages, parseRtp, spsSize } from '../../packages/core/src/engine/iphone/rtp-h264.js';
import { parseStreamHeader, parseVideoConfig, STREAM_CONFIG, STREAM_FRAME, streamPayload } from '../../packages/core/src/shared/stream.js';

// 4 frames of ffmpeg's test picture at 270×586 (High profile, 2 slices a frame, access unit delimiters):
// the size needs cropping, like an iPhone's.
const fixture = readFileSync(path.join(__dirname, '../fixtures/h264/screen-270x586.h264'));

/** Annex-B → NAL units (without start codes). */
function nalUnits(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 <= stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts.map((start, n) => {
    let end = n + 1 < starts.length ? starts[n + 1]! - 3 : stream.length;
    while (end > start && stream[end - 1] === 0) end -= 1; // the next 4-byte start code's leading zero
    return stream.subarray(start, end);
  });
}

/** Access units, each beginning with its delimiter (type 9). */
function accessUnits(stream: Uint8Array): Uint8Array[][] {
  const units: Uint8Array[][] = [];
  for (const nal of nalUnits(stream)) {
    if ((nal[0]! & 0x1f) === 9 || !units.length) units.push([]);
    units[units.length - 1]!.push(nal);
  }
  return units;
}

function rtp(seq: number, timestamp: number, marker: boolean, payload: Uint8Array, ssrc = 0x1234abcd): Uint8Array {
  const packet = new Uint8Array(12 + payload.length);
  const view = new DataView(packet.buffer);
  packet[0] = 0x80;
  packet[1] = (marker ? 0x80 : 0) | 96;
  view.setUint16(2, seq & 0xffff);
  view.setUint32(4, timestamp);
  view.setUint32(8, ssrc);
  packet.set(payload, 12);
  return packet;
}

/** Packetizes like rtph264pay: parameter sets in one STAP-A, small NALs whole, big ones as FU-A of `mtu` bytes. */
function packetize(units: Uint8Array[][], mtu = 120, firstSeq = 65530, ssrc = 0x1234abcd): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let seq = firstSeq;
  units.forEach((unit, n) => {
    const timestamp = 1000 + n * 3000;
    const payloads: Uint8Array[] = [];
    const params = unit.filter((nal) => [7, 8].includes(nal[0]! & 0x1f));
    if (params.length) {
      const size = 1 + params.reduce((total, nal) => total + 2 + nal.length, 0);
      const stap = new Uint8Array(size);
      stap[0] = 24 | (params[0]![0]! & 0x60);
      let p = 1;
      for (const nal of params) {
        stap[p] = nal.length >> 8;
        stap[p + 1] = nal.length & 0xff;
        stap.set(nal, p + 2);
        p += 2 + nal.length;
      }
      payloads.push(stap);
    }
    for (const nal of unit.filter((nal) => ![7, 8].includes(nal[0]! & 0x1f))) {
      if (nal.length <= mtu) {
        payloads.push(nal);
        continue;
      }
      const body = nal.subarray(1);
      for (let p = 0; p < body.length; p += mtu - 2) {
        const part = body.subarray(p, p + mtu - 2);
        const fu = new Uint8Array(2 + part.length);
        fu[0] = (nal[0]! & 0xe0) | 28;
        fu[1] = (p === 0 ? 0x80 : 0) | (p + mtu - 2 >= body.length ? 0x40 : 0) | (nal[0]! & 0x1f);
        fu.set(part, 2);
        payloads.push(fu);
      }
    }
    payloads.forEach((payload, i) => packets.push(rtp(seq++, timestamp, i === payloads.length - 1, payload, ssrc)));
  });
  return packets;
}

describe('H.264 over RTP from the screen-mirroring receiver', () => {
  const units = accessUnits(fixture);

  it('reads the picture size from the SPS, cropping included', () => {
    const sps = units[0]!.find((nal) => (nal[0]! & 0x1f) === 7)!;
    expect(spsSize(sps)).toEqual({ width: 270, height: 586 });
  });

  it('puts single NALs, STAP-A and FU-A back into the same access units', () => {
    expect(units).toHaveLength(4);
    const depacketizer = new H264Depacketizer();
    const out = packetize(units).flatMap((packet) => depacketizer.push(packet));
    expect(out).toHaveLength(4);
    out.forEach((unit, n) => {
      const sorted = (nals: Uint8Array[]) => nals.map((nal) => Buffer.from(nal).toString('hex')).sort();
      expect(sorted(unit.nals)).toEqual(sorted(units[n]!));
      expect(unit.key).toBe(n === 0);
    });
    expect(depacketizer.lost).toBe(0);
  });

  it('turns them into a config message and AVCC frames the pane decodes', () => {
    const depacketizer = new H264Depacketizer();
    const messages = new H264Messages();
    const out = packetize(units).flatMap((packet) => depacketizer.push(packet)).flatMap((unit, n) => messages.push(unit, 1_000_000 + n));
    expect(out.map((message) => parseStreamHeader(message)!.type)).toEqual([STREAM_CONFIG, STREAM_FRAME, STREAM_FRAME, STREAM_FRAME, STREAM_FRAME]);
    const config = parseVideoConfig(out[0]!)!;
    expect(config).toMatchObject({ width: 270, height: 586 });
    expect(config.codec).toMatch(/^avc1\.64/);
    expect(messages.lastConfig).toBe(out[0]);
    const frames = out.slice(1);
    expect(frames.map((message) => parseStreamHeader(message)!.key)).toEqual([true, false, false, false]);
    // Each frame: two slices, length-prefixed, no parameter sets or delimiters.
    for (const message of frames) {
      const payload = streamPayload(message);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const types: number[] = [];
      for (let p = 0; p < payload.length; p += 4 + view.getUint32(p)) types.push(payload[p + 4]! & 0x1f);
      expect(types.filter((type) => [7, 8, 9].includes(type))).toEqual([]);
      expect(types.filter((type) => type === 1 || type === 5)).toHaveLength(2);
    }
  });

  it('drops pictures after a lost packet until the next keyframe', () => {
    const depacketizer = new H264Depacketizer();
    const packets = packetize([...units, ...units]); // keyframe again at the fifth picture
    const lost = packets.findIndex((packet) => parseRtp(packet)!.timestamp === 1000 + 3000); // picture 2
    const out = packets.filter((_, i) => i !== lost + 1).flatMap((packet) => depacketizer.push(packet));
    expect(depacketizer.lost).toBe(1);
    expect(out.map((unit) => unit.timestamp)).toEqual([1000, 13000, 16000, 19000, 22000]);
    expect(out[1]!.key).toBe(true);
  });

  it('starts over cleanly when the receiver begins a new stream', () => {
    const depacketizer = new H264Depacketizer();
    const first = packetize(units, 120, 100, 0xaaaa0001);
    const second = packetize(units, 120, 40_000, 0xbbbb0002); // new SSRC, sequence far away
    const out = [...first.slice(0, -1), ...second].flatMap((packet) => depacketizer.push(packet)); // first stream cut short
    expect(out.map((unit) => unit.key)).toEqual([true, false, false, true, false, false, false]);
    expect(depacketizer.lost).toBe(0);
  });

  it('skips CSRCs, header extensions and padding', () => {
    const payload = Uint8Array.of(0x65, 1, 2, 3);
    const packet = new Uint8Array(12 + 4 + 8 + payload.length + 3);
    packet[0] = 0x80 | 0x20 | 0x10 | 1; // padding, extension, one CSRC
    packet[1] = 0x80 | 96;
    new DataView(packet.buffer).setUint16(18, 1); // extension: one 32-bit word
    packet.set(payload, 24);
    packet[packet.length - 1] = 3;
    expect(Buffer.from(parseRtp(packet)!.payload)).toEqual(Buffer.from(payload));
    expect(parseRtp(Uint8Array.of(0x40, 0, 0, 0))).toBeNull();
  });

  it('builds an avcC with 4-byte lengths', () => {
    const sps = Uint8Array.of(0x67, 0x64, 0x00, 0x1f, 0xac);
    const pps = Uint8Array.of(0x68, 0xee, 0x3c, 0x80);
    expect(Buffer.from(avccRecord(sps, pps)).toString('hex')).toBe('0164001fffe100056764001fac010004' + '68ee3c80');
  });
});
