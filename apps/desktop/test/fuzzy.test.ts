import { describe, expect, it } from 'vitest';
import { fuzzyScore } from '../src/renderer/lib/fuzzy';

const rank = (query: string, titles: string[]) =>
  titles
    .map((title) => ({ title, score: fuzzyScore(query, title) }))
    .filter((x): x is { title: string; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.title);

describe('fuzzyScore', () => {
  it('matches everything with an empty query', () => {
    expect(fuzzyScore('', 'Anything')).toBe(0);
  });

  it('needs every letter, in order', () => {
    expect(fuzzyScore('run', 'Run on iPhone 17')).not.toBeNull();
    expect(fuzzyScore('nur', 'Run')).toBeNull();
    expect(fuzzyScore('xyz', 'Settings')).toBeNull();
  });

  it('is case-insensitive and ignores spaces in the query', () => {
    expect(fuzzyScore('OPEN XC', 'Open in Xcode')).not.toBeNull();
  });

  it('prefers prefixes, word starts and consecutive letters', () => {
    const set = rank('set', ['Reset console', 'Settings', 'Select target']);
    expect(set[0]).toBe('Settings');
    expect(set).toHaveLength(3);
    expect(rank('oix', ['Open in Xcode', 'Toggle wrap', 'Show logs in Explorer'])[0]).toBe('Open in Xcode');
  });
});
