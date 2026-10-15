/**
 * Smooth or compatible: one choice for the CLI and CapMac Studio, kept in
 * CapMac's config next to the paired Macs (which it must never lose).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { streamPreference } from '../../packages/core/src/engine/config.js';

let dir = '';
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.CAPMAC_CONFIG_DIR;
  dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-stream-'));
  process.env.CAPMAC_CONFIG_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.CAPMAC_CONFIG_DIR;
  else process.env.CAPMAC_CONFIG_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const saved = () => JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));

describe('the screen stream choice', () => {
  it('is smooth until someone picks', async () => {
    expect(await streamPreference()).toBe('smooth');
  });

  it('is kept for next time, with the paired Macs untouched', async () => {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, hosts: { mac: { name: 'mac', host: 'mac.local', port: 22, username: 'me', hostKey: 'SHA256:x', pairedAt: 'now' } }, defaultHost: 'mac' }));
    expect(await streamPreference('compatible')).toBe('compatible');
    expect(await streamPreference()).toBe('compatible');
    expect(saved()).toMatchObject({ stream: 'compatible', defaultHost: 'mac', hosts: { mac: { host: 'mac.local' } } });
    expect(await streamPreference('smooth')).toBe('smooth');
    expect(saved().stream).toBe('smooth');
  });

  it('never overwrites a config it could not read', async () => {
    writeFileSync(path.join(dir, 'config.json'), '{ not json');
    expect(await streamPreference('compatible')).toBe('compatible');
    expect(readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe('{ not json');
  });
});
