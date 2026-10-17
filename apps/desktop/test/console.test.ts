import { beforeAll, describe, expect, it } from 'vitest';
import { ConsoleBuffer, ConsoleView, DEFAULT_FILTER, END, jsonPayload, lineText, lowerBound, rowText, textBetween, type ConsoleFilter, type ConsoleLine } from '../src/renderer/state/console';

beforeAll(() => {
  // The buffer notifies subscribers once per animation frame.
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;
});

const all: ConsoleFilter = {
  sources: { js: true, cap: true, native: true, bridge: true, web: true, capmac: true, main: true, electron: true },
  levels: { error: true, warn: true, info: true, log: true, debug: true },
};
const texts = (buffer: ConsoleBuffer, view: ConsoleView) => view.ids.map((id) => buffer.byId(id)!.text);

describe('ConsoleBuffer', () => {
  it('strips ANSI colours from tool output', () => {
    const buffer = new ConsoleBuffer(100);
    buffer.pushText('web', '\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m: http://localhost:5173/');
    expect(buffer.lines[0]!.text).toBe('➜  Local: http://localhost:5173/');
  });

  it('merges multi-line console messages into one line', () => {
    const buffer = new ConsoleBuffer(100);
    buffer.pushApp({ ts: 1, kind: 'console', level: 'error', text: 'TypeError: x is undefined', stream: 'stdout' } as never);
    buffer.pushApp({ ts: 2, kind: 'console', level: 'error', text: '    at main.js:3:5', stream: 'stdout', continuation: true } as never);
    expect(buffer.lines).toHaveLength(1);
    expect(buffer.lines[0]!.text).toBe('TypeError: x is undefined\n    at main.js:3:5');
    expect(buffer.errors).toBe(1);
  });

  it('keeps at most `limit` lines, dropping old ones in chunks, and counts errors', () => {
    const buffer = new ConsoleBuffer(1000);
    for (let i = 0; i < 2500; i++) buffer.pushText('capmac', `line ${i}`, i % 10 === 0 ? 'error' : 'log');
    expect(buffer.lines.length).toBeLessThanOrEqual(1000);
    expect(buffer.lines.at(-1)!.text).toBe('line 2499');
    expect(buffer.errors).toBe(buffer.lines.filter((l) => l.level === 'error').length);
    expect(buffer.byId(buffer.lines[0]!.id)).toBe(buffer.lines[0]);
    buffer.clear();
    expect(buffer.lines).toHaveLength(0);
    expect(buffer.errors).toBe(0);
  });
});

describe('ConsoleView', () => {
  it('filters by source and level and follows new lines incrementally', () => {
    const buffer = new ConsoleBuffer(100);
    buffer.pushText('js', 'hello');
    buffer.pushText('bridge', 'native call');
    buffer.pushText('web', 'vite ready', 'info');
    const view = new ConsoleView();
    view.update(buffer, DEFAULT_FILTER, '');
    // The bridge is hidden by default.
    expect(texts(buffer, view)).toEqual(['hello', 'vite ready']);

    buffer.pushText('js', 'debug details', 'debug');
    view.update(buffer, { ...DEFAULT_FILTER, levels: { ...DEFAULT_FILTER.levels, debug: false } }, '');
    expect(texts(buffer, view)).toEqual(['hello', 'vite ready']);
    view.update(buffer, DEFAULT_FILTER, '');
    expect(texts(buffer, view)).toEqual(['hello', 'vite ready', 'debug details']);
  });

  it('finds matches among the visible lines, case-insensitively', () => {
    const buffer = new ConsoleBuffer(100);
    for (const text of ['Loading app', 'WebView loaded', 'error: failed', 'Loaded plugin Device']) buffer.pushText('cap', text);
    const view = new ConsoleView();
    view.update(buffer, all, 'LOAD');
    expect(view.matches.map((i) => texts(buffer, view)[i])).toEqual(['Loading app', 'WebView loaded', 'Loaded plugin Device']);
    // New lines are searched as they arrive.
    buffer.pushText('cap', 'reload');
    view.update(buffer, all, 'LOAD');
    expect(view.matches).toHaveLength(4);
    view.update(buffer, all, '');
    expect(view.matches).toHaveLength(0);
  });

  it('re-checks the newest line when a multi-line message grows', () => {
    const buffer = new ConsoleBuffer(100);
    buffer.pushApp({ ts: 1, kind: 'console', level: 'log', text: 'Object {', stream: 'stdout' } as never);
    const view = new ConsoleView();
    view.update(buffer, all, 'needle');
    expect(view.matches).toHaveLength(0);
    buffer.pushApp({ ts: 2, kind: 'console', level: 'log', text: '  needle: 1 }', stream: 'stdout', continuation: true } as never);
    view.update(buffer, all, 'needle');
    expect(view.matches).toEqual([0]);
  });

  it('rebuilds after old lines are dropped', () => {
    const buffer = new ConsoleBuffer(1000);
    const view = new ConsoleView();
    for (let i = 0; i < 1500; i++) buffer.pushText('js', `n${i}`);
    view.update(buffer, all, '');
    expect(view.ids).toHaveLength(buffer.lines.length);
    expect(view.ids.every((id) => buffer.byId(id) !== undefined)).toBe(true);
  });
});

describe('ConsoleView search', () => {
  const matched = (buffer: ConsoleBuffer, view: ConsoleView, query: string) => {
    view.update(buffer, all, query);
    return view.matches.map((i) => texts(buffer, view)[i]);
  };

  it('narrows as the query grows, and widens again', () => {
    const buffer = new ConsoleBuffer(100);
    for (const text of ['error: failed to load', 'Error in plugin', 'all good', 'errand', 'ERROR: retry']) buffer.pushText('js', text);
    const view = new ConsoleView();
    expect(matched(buffer, view, 'err')).toEqual(['error: failed to load', 'Error in plugin', 'errand', 'ERROR: retry']);
    expect(matched(buffer, view, 'erro')).toEqual(['error: failed to load', 'Error in plugin', 'ERROR: retry']);
    expect(matched(buffer, view, 'error:')).toEqual(['error: failed to load', 'ERROR: retry']);
    // Lines arriving while searching are checked too.
    buffer.pushText('js', 'another error: here');
    expect(matched(buffer, view, 'error:')).toEqual(['error: failed to load', 'ERROR: retry', 'another error: here']);
    expect(matched(buffer, view, 'err')).toEqual(['error: failed to load', 'Error in plugin', 'errand', 'ERROR: retry', 'another error: here']);
    expect(matched(buffer, view, 'good')).toEqual(['all good']);
  });

  it('finds regular-expression characters as plain text', () => {
    const buffer = new ConsoleBuffer(100);
    for (const text of ['[vite] connected.', 'vite ready', 'fetch(/api) failed', 'a.b']) buffer.pushText('web', text);
    const view = new ConsoleView();
    expect(matched(buffer, view, '[vite]')).toEqual(['[vite] connected.']);
    expect(matched(buffer, view, '(/api)')).toEqual(['fetch(/api) failed']);
    expect(matched(buffer, view, '.')).toEqual(['[vite] connected.', 'a.b']);
  });

  it('cuts dropped lines off the front at the line limit, keeping search results in place', () => {
    const buffer = new ConsoleBuffer(1000);
    const view = new ConsoleView();
    const filter = { ...all, sources: { ...all.sources, web: false } };
    for (let i = 0; i < 1000; i++) buffer.pushText(i % 2 ? 'js' : 'web', `n${i}${i % 10 === 1 ? ' hit' : ''}`);
    view.update(buffer, filter, 'hit');
    const before = view.generation;
    expect(view.ids).toHaveLength(500);
    expect(view.matches).toHaveLength(100);
    // 101 more lines: the oldest 10 % go.
    for (let i = 1000; i < 1101; i++) buffer.pushText(i % 2 ? 'js' : 'web', `n${i}${i % 10 === 1 ? ' hit' : ''}`);
    view.update(buffer, filter, 'hit');
    expect(view.generation).toBe(before + 1);
    expect(view.trimmed).toBe(100);
    // The same as filtering from scratch.
    const fresh = new ConsoleView();
    fresh.update(buffer, filter, 'hit');
    expect(view.ids).toEqual(fresh.ids);
    expect(view.matches).toEqual(fresh.matches);
    expect(view.matches.map((i) => buffer.byId(view.ids[i]!)!.text.endsWith('hit')).every(Boolean)).toBe(true);
    // A new filter rebuilds.
    view.update(buffer, all, 'hit');
    expect(view.trimmed).toBe(-1);
  });

  it('starts over after Clear, then follows new lines', () => {
    const buffer = new ConsoleBuffer(100);
    const view = new ConsoleView();
    buffer.pushText('js', 'old one');
    view.update(buffer, all, '');
    buffer.clear();
    buffer.pushText('js', 'new one');
    view.update(buffer, all, '');
    expect(texts(buffer, view)).toEqual(['new one']);
    buffer.clear();
    view.update(buffer, all, '');
    expect(view.ids).toEqual([]);
  });

  it('counts rebuilds (filters, dropped lines) but not lines arriving', () => {
    const buffer = new ConsoleBuffer(1000);
    const view = new ConsoleView();
    buffer.pushText('js', 'one');
    view.update(buffer, all, '');
    const first = view.generation;
    buffer.pushText('js', 'two');
    view.update(buffer, all, '');
    expect(view.generation).toBe(first);
    view.update(buffer, { ...all, sources: { ...all.sources, js: false } }, '');
    expect(view.generation).toBe(first + 1);
    for (let i = 0; i < 1200; i++) buffer.pushText('js', `n${i}`);
    view.update(buffer, all, '');
    expect(view.generation).toBe(first + 2);
  });
});

describe('copying lines', () => {
  const line = (id: number, text: string, extra: Partial<ConsoleLine> = {}): ConsoleLine => ({ id, ts: new Date(2026, 9, 16, 9, 5, 7, 42).getTime(), source: 'js', level: 'log', text, ...extra });
  const lines = [line(1, 'first line'), line(2, 'second {"a":1}', { level: 'error' }), line(3, 'third', { source: 'native' }), line(4, 'fourth')];
  const byId = (id: number) => lines.find((l) => l.id === id);
  const ids = lines.map((l) => l.id);

  it('lays a line out as time, tag, level and message', () => {
    const row = rowText(lines[1]!, true);
    expect(row.text).toBe('09:05:07.042 JS  ERROR second {"a":1}');
    expect(row.text.slice(row.tagStart, row.tagEnd)).toBe('JS');
    expect(row.text.slice(row.levelStart, row.textStart)).toBe('ERROR ');
    expect(row.text.slice(row.textStart)).toBe('second {"a":1}');
    expect(rowText(lines[0]!, false).text).toBe('JS  first line');
    expect(lineText(lines[2]!)).toBe('09:05:07.042 iOS third');
  });

  it('copies from a point in one line to a point in another, in either order', () => {
    const start = rowText(lines[0]!, false).textStart;
    const a = { id: 1, offset: start + 6 };
    const b = { id: 3, offset: rowText(lines[2]!, false).textStart + 3 };
    const expected = 'line\nJS  ERROR second {"a":1}\niOS thi';
    expect(textBetween(a, b, ids, ids.length, byId, false)).toBe(expected);
    expect(textBetween(b, a, ids, ids.length, byId, false)).toBe(expected);
    // Within one line.
    expect(textBetween({ id: 4, offset: start }, { id: 4, offset: start + 3 }, ids, ids.length, byId, false)).toBe('fou');
  });

  it('copies everything for Select all, up to the lines shown', () => {
    const all = textBetween({ id: 1, offset: 0 }, { id: 4, offset: END }, ids, ids.length, byId, true);
    expect(all.split('\n')).toEqual(lines.map((l) => lineText(l)));
    // Paused after the second line: only what's shown.
    expect(textBetween({ id: 1, offset: 0 }, { id: 4, offset: END }, ids, 2, byId, true).split('\n')).toHaveLength(2);
  });

  it('takes the whole message for a point inside a JSON tree', () => {
    const row = rowText(lines[1]!, false);
    expect(textBetween({ id: 1, offset: END }, { id: 2, offset: row.textStart, json: true }, ids, ids.length, byId, false)).toBe(`\n${row.text}`);
    expect(textBetween({ id: 2, offset: row.textStart, json: true }, { id: 3, offset: 0 }, ids, ids.length, byId, false)).toBe('second {"a":1}\n');
  });

  it('skips lines that are gone (filtered out or dropped)', () => {
    const shown = [1, 3, 4];
    const start = rowText(lines[0]!, false).textStart;
    // From a dropped line's middle: the next line's start.
    expect(textBetween({ id: 2, offset: 9 }, { id: 3, offset: END }, shown, shown.length, byId, false)).toBe('iOS third');
    // To a filtered-out line: up to the end of the line before it.
    expect(textBetween({ id: 1, offset: start }, { id: 2, offset: 3 }, shown, shown.length, byId, false)).toBe('first line');
  });

  it('finds positions in sorted ids', () => {
    expect(lowerBound([2, 4, 6, 8], 5)).toBe(2);
    expect(lowerBound([2, 4, 6, 8], 6)).toBe(2);
    expect(lowerBound([2, 4, 6, 8], 9)).toBe(4);
    expect(lowerBound([2, 4, 6, 8], 9, 2)).toBe(2);
    expect(lowerBound([], 1)).toBe(0);
  });
});

describe('jsonPayload', () => {
  const line = (text: string): ConsoleLine => ({ id: 1, ts: 0, source: 'js', level: 'log', text });

  it('finds the JSON a console.log printed after a label', () => {
    const payload = jsonPayload(line('Device info {"osVersion":"26.5","isVirtual":true}'));
    expect(payload?.prefix.trim()).toBe('Device info');
    expect(payload?.value).toEqual({ osVersion: '26.5', isVirtual: true });
  });

  it('ignores plain text', () => {
    expect(jsonPayload(line('Hello CapMac! Running on ios'))).toBeNull();
    expect(jsonPayload(line('[vite] connected.'))).toBeNull();
  });
});
