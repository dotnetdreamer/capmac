import { describe, expect, it } from 'vitest';
import { screenAppHash, screenAppInfoPlist, SCREEN_APP_ID } from '../../packages/core/src/agent/helper/build.js';
import { HelperReader, type HelperExit } from '../../packages/core/src/agent/helper/process.js';
import { deviceFailure } from '../../packages/core/src/agent/ops/stream.js';
import { STREAM_CONFIG, STREAM_EVENT, STREAM_FRAME, STREAM_STILL, type HelperEvent } from '../../packages/core/src/shared/stream.js';
import { lengthPrefixed, pageConfigMessage } from '../../packages/cli/src/viewer/server.js';

/** One message as the helpers write it: u32 length, the 16-byte header, the payload. */
function message(type: number, flags: number, seq: number, payload: Uint8Array): Buffer {
  const head = Buffer.alloc(20);
  head.writeUInt32BE(16 + payload.length, 0);
  head[4] = type;
  head[5] = flags;
  head.writeBigUInt64BE(1_760_000_000_000_000n, 8);
  head.writeUInt32BE(seq, 16);
  return Buffer.concat([head, payload]);
}

const event = (seq: number, value: object) => message(STREAM_EVENT, 0, seq, Buffer.from(JSON.stringify(value)));
const REAL_AVCC = Buffer.from('01640028ffe1000c27640028ac5680a40b1e226401000428ee3cb0', 'hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000005090000096c08060000', 'hex');

describe('device screen helper output', () => {
  it('routes video, stills, the hello and devstream’s own events', () => {
    const seen: string[] = [];
    let hello: string | null = null;
    const reader = new HelperReader(
      {
        onVideo: (m, h) => seen.push(`video ${h.type} ${h.key ? 'key' : 'delta'} ${m.length}`),
        onStill: (m) => seen.push(`still ${m.length}`),
        onStatus: (s) => seen.push(`status ${s.callbacks}`),
        onEvent: (e: HelperEvent) => seen.push(`event ${e.t}${'for' in e ? ` ${e.for}` : ''}${'pid' in e ? ` ${e.pid}` : ''}`),
      },
      (h) => (hello = h.device),
    );
    const output = Buffer.concat([
      event(1, { t: 'started', pid: 4242 }),
      event(2, { t: 'wait', for: 'device' }),
      event(3, { t: 'wait', for: 'permission' }),
      event(4, { t: 'hello', device: 'IK 14 Pro Max', video: true, api: 'CoreMediaIO', input: false, coreSimulator: '' }),
      message(STREAM_CONFIG, 0, 5, Uint8Array.from([0x02, 0x82, 0x05, 0x76, ...REAL_AVCC])),
      message(STREAM_FRAME, 1, 6, new Uint8Array(500)),
      message(STREAM_FRAME, 0, 7, new Uint8Array(20)),
      event(8, { t: 'status', callbacks: 60, encoded: 60, sent: 60, dropped: 0, seed: 0, footprint: 1, queued: 0, width: 642, height: 1398 }),
      message(STREAM_STILL, 0, 9, PNG),
      // An empty still is no still.
      message(STREAM_STILL, 0, 10, new Uint8Array(0)),
      event(11, { t: 'resume' }),
      event(12, { t: 'still-error', message: 'There is no picture yet.' }),
      event(13, { t: 'fatal', code: 'NO_PERMISSION', message: 'no' }),
    ]);
    // Byte by byte, as a socket may deliver it.
    for (let i = 0; i < output.length; i += 13) expect(reader.push(output.subarray(i, i + 13))).toBe(true);
    expect(hello).toBe('IK 14 Pro Max');
    expect(seen).toEqual([
      'event started 4242',
      'event wait device',
      'event wait permission',
      `video ${STREAM_CONFIG} delta ${16 + 4 + REAL_AVCC.length}`,
      `video ${STREAM_FRAME} key 516`,
      `video ${STREAM_FRAME} delta 36`,
      'status 60',
      `still ${16 + PNG.length}`,
      'event resume',
      'event still-error',
    ]);
    expect(reader.fatal).toEqual({ code: 'NO_PERMISSION', message: 'no' });
  });

  it('says when the output is corrupt', () => {
    const reader = new HelperReader({}, () => undefined);
    expect(reader.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0]))).toBe(false);
  });
});

describe('device screen app', () => {
  it('keeps its build (and with it the camera permission) across Xcode updates', () => {
    const base = screenAppHash('source', 'arm64');
    expect(screenAppHash('source', 'arm64')).toBe(base);
    expect(screenAppHash('source 2', 'arm64')).not.toBe(base);
    expect(screenAppHash('source', 'x64')).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is a background app that explains the camera question', () => {
    const plist = screenAppInfoPlist();
    expect(plist).toContain(`<key>CFBundleIdentifier</key><string>${SCREEN_APP_ID}</string>`);
    expect(plist).toContain('<key>CFBundleExecutable</key><string>devstream</string>');
    expect(plist).toMatch(/<key>LSUIElement<\/key><true\/>/);
    expect(plist).toMatch(/<key>NSCameraUsageDescription<\/key><string>[^<]*iPhone[^<]*<\/string>/);
    expect(plist).toContain('<key>CFBundleName</key><string>CapMac</string>');
  });
});

describe('device screen failures', () => {
  const exit = (fatal?: HelperExit['fatal']): HelperExit => ({ code: null, signal: null, fatal, stderr: ['a log line'] });

  it('tells how to allow CapMac when macOS said no', () => {
    const error = deviceFailure(exit({ code: 'NO_PERMISSION', message: 'not allowed' }), false, 'IK 14 Pro Max');
    expect(error.code).toBe('DEVICE_SCREEN_DENIED');
    expect(error.message).toContain('IK 14 Pro Max');
    expect(error.hint).toMatch(/Privacy & Security › Camera/);
  });

  it('suggests plugging in again when the capture fails', () => {
    const error = deviceFailure(exit({ code: 'CAPTURE_FAILED', message: 'The screen capture failed: busy' }), true, 'IK 14 Pro Max');
    expect(error.code).toBe('HELPER_EXITED');
    expect(error.message).toBe('The screen capture failed: busy');
    expect(error.hint).toMatch(/plug it in again/);
  });

  it('reports other exits as the simulator stream does', () => {
    expect(deviceFailure(exit(), false, 'X').code).toBe('HELPER_START_FAILED');
    expect(deviceFailure(exit(), true, 'X').code).toBe('HELPER_EXITED');
  });
});

describe('the viewer’s smooth stream', () => {
  it('turns a config into JSON the page configures WebCodecs with', () => {
    const config = message(STREAM_CONFIG, 0, 5, Uint8Array.from([0x02, 0x82, 0x05, 0x76, ...REAL_AVCC])).subarray(4);
    const page = pageConfigMessage(config)!;
    expect(page.subarray(0, 16).equals(config.subarray(0, 16))).toBe(true);
    const json = JSON.parse(page.subarray(16).toString('utf8'));
    expect(json).toMatchObject({ codec: 'avc1.640028', width: 642, height: 1398 });
    // The SPS is rewritten for low latency, so the description differs from the helper's record.
    expect(Buffer.from(json.description, 'base64').length).toBeGreaterThanOrEqual(REAL_AVCC.length);
    expect(pageConfigMessage(message(STREAM_FRAME, 1, 6, new Uint8Array(4)).subarray(4))).toBeNull();
  });

  it('frames each message with its length', () => {
    const framed = lengthPrefixed(Buffer.from([1, 2, 3]));
    expect([...framed]).toEqual([0, 0, 0, 3, 1, 2, 3]);
  });
});
