import { describe, expect, it } from 'vitest';
import { parseJsonLoose } from '../../src/agent/proc.js';
import { EventRenderer } from '../../src/cli/render.js';
import { resolveMacAddress } from '../../src/cli/resolve.js';

describe('parseJsonLoose', () => {
  it('parses clean JSON and JSON surrounded by tool chatter', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('Note: something\n{"devices":{"x":[]}}\ntrailing')).toEqual({ devices: { x: [] } });
    expect(parseJsonLoose('no json here')).toBeNull();
    expect(parseJsonLoose(null)).toBeNull();
  });
});

describe('resolveMacAddress', () => {
  it('passes IP literals through', async () => {
    expect(await resolveMacAddress('192.168.2.48')).toEqual({ address: '192.168.2.48', via: 'literal' });
    expect(await resolveMacAddress('[fe80::1]')).toEqual({ address: 'fe80::1', via: 'literal' });
  });

  it('resolves normal names with the system resolver', async () => {
    const r = await resolveMacAddress('localhost');
    expect(r.via).toBe('dns');
    expect(['127.0.0.1', '::1']).toContain(r.address);
  });

  it('falls back to the last known address when a name cannot be resolved', async () => {
    const r = await resolveMacAddress('capmac-does-not-exist.invalid', '10.0.0.7');
    expect(r).toEqual({ address: '10.0.0.7', via: 'cache' });
  }, 15_000);

  it('reports unresolved names without a fallback', async () => {
    const r = await resolveMacAddress('capmac-does-not-exist.invalid');
    expect(r.via).toBe('unresolved');
  }, 15_000);
});

describe('EventRenderer app lines', () => {
  it('keeps multi-line console messages together', () => {
    const lines: string[] = [];
    const renderer = new EventRenderer({});
    renderer.onAppLine = null;
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      renderer.appLine('⚡️  [error] - TypeError: boom');
      renderer.appLine('    at main.js:10:5');
      renderer.appLine('2026-10-12 14:34:31.216 App[1:2] native NSLog line');
    } finally {
      (process.stdout as any).write = original;
    }
    const text = lines.join('');
    expect(text).toMatch(/js ✖.*TypeError: boom/);
    expect(text).toMatch(/js ✖.*at main\.js:10:5/);
    expect(text).toMatch(/ios .*native NSLog line/);
  });
});
