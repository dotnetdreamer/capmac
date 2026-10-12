import { beforeAll, describe, expect, it } from 'vitest';
import { ConsoleBuffer, ConsoleView, DEFAULT_FILTER, jsonPayload, type ConsoleFilter, type ConsoleLine } from '../src/renderer/state/console';

beforeAll(() => {
  // The buffer notifies subscribers once per animation frame.
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame;
});

const all: ConsoleFilter = {
  sources: { js: true, cap: true, native: true, bridge: true, web: true, capmac: true },
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
