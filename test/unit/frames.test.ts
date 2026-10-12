import { describe, expect, it } from 'vitest';
import { AGENT_MAGIC, encodeBinary, encodeJson, FrameDecoder, MagicScanner } from '../../packages/core/src/shared/frames.js';

describe('frames', () => {
  it('round-trips JSON and binary frames split at every byte boundary', () => {
    const payload = Buffer.concat([
      encodeJson({ t: 'hello', n: 1, s: 'ünïcødé ⚡️' }),
      encodeBinary(Buffer.from([0, 1, 2, 255])),
      encodeJson({ t: 'bye' }),
      encodeBinary(Buffer.alloc(0)),
    ]);
    for (let split = 1; split < payload.length; split++) {
      const decoder = new FrameDecoder();
      const frames = [...decoder.push(payload.subarray(0, split)), ...decoder.push(payload.subarray(split))];
      expect(frames).toHaveLength(4);
      expect(frames[0]).toEqual({ kind: 'json', value: { t: 'hello', n: 1, s: 'ünïcødé ⚡️' } });
      expect(frames[1]!.kind).toBe('binary');
      expect([...(frames[1] as any).data]).toEqual([0, 1, 2, 255]);
      expect(frames[2]).toEqual({ kind: 'json', value: { t: 'bye' } });
      expect((frames[3] as any).data.length).toBe(0);
      expect(decoder.pending).toBe(0);
    }
  });

  it('handles a large frame delivered in many small chunks', () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const encoded = encodeBinary(big);
    const decoder = new FrameDecoder();
    const out = [];
    for (let i = 0; i < encoded.length; i += 32 * 1024) out.push(...decoder.push(encoded.subarray(i, i + 32 * 1024)));
    expect(out).toHaveLength(1);
    expect((out[0] as any).data.equals(big)).toBe(true);
  });

  it('rejects corrupt lengths', () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0]))).toThrow(/Corrupt/);
  });

  it('skips shell noise before the agent marker', () => {
    const scanner = new MagicScanner();
    expect(scanner.push(Buffer.from('Welcome to zsh!\nlast login'))).toBeNull();
    const rest = scanner.push(Buffer.concat([Buffer.from(`${AGENT_MAGIC.slice(0, 5)}`)]));
    expect(rest).toBeNull();
    const after = scanner.push(Buffer.concat([Buffer.from(AGENT_MAGIC.slice(5)), encodeJson({ t: 'x' })]));
    expect(after).not.toBeNull();
    expect(scanner.noise).toContain('Welcome to zsh!');
    const frames = new FrameDecoder().push(after!);
    expect(frames[0]).toEqual({ kind: 'json', value: { t: 'x' } });
  });
});
