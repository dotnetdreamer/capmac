import { describe, expect, it } from 'vitest';
import { HeightIndex } from '../src/renderer/lib/heights';

/** The same answers, the slow way. */
class Naive {
  sizes: number[] = [];
  offsetOf(index: number): number {
    let sum = 0;
    for (let i = 0; i < Math.min(index, this.sizes.length); i++) sum += this.sizes[i]!;
    return sum;
  }
  indexAt(offset: number): number {
    if (this.sizes.length === 0 || offset <= 0) return 0;
    let top = 0;
    for (let i = 0; i < this.sizes.length; i++) {
      if (offset < top + this.sizes[i]!) return i;
      top += this.sizes[i]!;
    }
    return this.sizes.length - 1;
  }
}

function seeded(seed: number): () => number {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

describe('HeightIndex', () => {
  it('gives offsets and the row at an offset', () => {
    const heights = new HeightIndex();
    heights.reset(5, (i) => [20, 38, 20, 56, 20][i]!);
    expect(heights.total).toBe(154);
    expect([0, 1, 2, 3, 4, 5].map((i) => heights.offsetOf(i))).toEqual([0, 20, 58, 78, 134, 154]);
    expect(heights.indexAt(0)).toBe(0);
    expect(heights.indexAt(19.9)).toBe(0);
    expect(heights.indexAt(20)).toBe(1);
    expect(heights.indexAt(57)).toBe(1);
    expect(heights.indexAt(133)).toBe(3);
    expect(heights.indexAt(10_000)).toBe(4);
    expect(heights.indexAt(-5)).toBe(0);
  });

  it('stays exact through appends, size changes and shrinking (random)', () => {
    const random = seeded(7);
    const heights = new HeightIndex();
    const naive = new Naive();
    const size = () => 20 + Math.floor(random() * 4) * 18;
    heights.reset(0, size);
    for (let round = 0; round < 400; round++) {
      const roll = random();
      if (roll < 0.5) {
        // Lines arriving, past the capacity now and then.
        const n = heights.count + 1 + Math.floor(random() * 90);
        const added: number[] = [];
        heights.grow(n, () => {
          const s = size();
          added.push(s);
          return s;
        });
        naive.sizes.push(...added);
      } else if (roll < 0.85 && heights.count > 0) {
        const i = Math.floor(random() * heights.count);
        const s = size();
        heights.set(i, s);
        naive.sizes[i] = s;
      } else if (heights.count > 0) {
        const n = Math.floor(random() * heights.count);
        heights.shrink(n);
        naive.sizes.length = n;
      }
      expect(heights.count).toBe(naive.sizes.length);
      expect(heights.total).toBe(naive.offsetOf(naive.sizes.length));
      for (let probe = 0; probe < 8; probe++) {
        const i = Math.floor(random() * (heights.count + 1));
        expect(heights.offsetOf(i)).toBe(naive.offsetOf(i));
        const offset = random() * (heights.total + 40);
        expect(heights.indexAt(offset)).toBe(naive.indexAt(offset));
      }
    }
  });

  it('drops rows from the front, keeping the others’ sizes', () => {
    const heights = new HeightIndex();
    heights.reset(6, (i) => [20, 38, 20, 56, 20, 74][i]!);
    heights.dropFront(2);
    expect(heights.count).toBe(4);
    expect([0, 1, 2, 3, 4].map((i) => heights.offsetOf(i))).toEqual([0, 20, 76, 96, 170]);
    heights.grow(5, () => 20);
    expect(heights.total).toBe(190);
    heights.dropFront(10);
    expect(heights.count).toBe(0);
    expect(heights.total).toBe(0);
  });

  it('handles a million rows quickly', () => {
    const heights = new HeightIndex();
    const started = performance.now();
    heights.reset(1_000_000, () => 20);
    for (let i = 0; i < 10_000; i++) heights.grow(heights.count + 1, () => 20);
    for (let i = 0; i < 10_000; i++) heights.indexAt(i * 2000);
    const ms = performance.now() - started;
    expect(heights.total).toBe(20 * 1_010_000);
    expect(heights.indexAt(20 * 500_000 + 5)).toBe(500_000);
    expect(ms).toBeLessThan(1000);
  });
});
