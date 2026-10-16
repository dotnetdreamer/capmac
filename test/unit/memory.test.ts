import { spawn } from 'node:child_process';
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptMemory, recallAll, remember } from '../../packages/core/src/engine/memory.js';

let dir = '';
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.CAPMAC_CONFIG_DIR;
  dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-memory-'));
  process.env.CAPMAC_CONFIG_DIR = dir;
  writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ sentinel: { lastTarget: 'KEEP' }, shared: { lastTarget: 'EXISTING' } }));
});
afterEach(() => {
  if (previous === undefined) delete process.env.CAPMAC_CONFIG_DIR;
  else process.env.CAPMAC_CONFIG_DIR = previous;
  if (!path.resolve(dir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}capmac-memory-`)) throw new Error('Unexpected memory test directory');
  rmSync(dir, { recursive: true, force: true });
});

/** What is in the settings folder, but for the bundle the tests that start writers of their own put there, and the file macOS locks. */
const leftInSettings = async () => (await fs.readdir(dir)).filter((name) => name !== 'memory.cjs' && name !== 'projects.json.lock');

async function bundleMemory(): Promise<string> {
  const bundle = path.join(dir, 'memory.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../../packages/core/src/engine/memory.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['ssh2', 'node-datachannel'] });
  return bundle;
}

describe('concurrent project memory', () => {
  it('keeps unrelated projects and existing entries when projects migrate together', async () => {
    await Promise.all(Array.from({ length: 16 }, (_, i) => remember(`project-${i}`, { lastTarget: `TARGET-${i}`, sound: i % 2 ? 'pc' : 'mac' })));

    const saved = await recallAll();
    expect(saved.sentinel).toEqual({ lastTarget: 'KEEP' });
    for (let i = 0; i < 16; i++) expect(saved[`project-${i}`]).toEqual({ lastTarget: `TARGET-${i}`, sound: i % 2 ? 'pc' : 'mac' });
  });

  it('merges partial updates to the same project', async () => {
    await Promise.all([
      remember('shared', { sound: 'pc' }),
      remember('shared', { lastDevice: 'PHONE' }),
      remember('shared', { app: 'electron' }),
    ]);

    expect((await recallAll()).shared).toEqual({ lastTarget: 'EXISTING', sound: 'pc', lastDevice: 'PHONE', app: 'electron' });
  });

  it('lets readers see complete JSON throughout concurrent writes', async () => {
    let writing = true;
    let snapshots = 0;
    const invalid: string[] = [];
    const reader = (async () => {
      while (writing) {
        const text = await fs.readFile(path.join(dir, 'projects.json'), 'utf8');
        snapshots++;
        try {
          JSON.parse(text);
        } catch {
          invalid.push(text);
        }
      }
    })();
    try {
      await Promise.all(Array.from({ length: 16 }, (_, i) => remember(`project-${i}`, { lastTarget: `TARGET-${i}-${'x'.repeat(i * 20)}` })));
    } finally {
      writing = false;
      await reader;
    }

    expect(snapshots).toBeGreaterThan(0);
    expect(invalid).toHaveLength(0);
    expect((await recallAll()).sentinel).toEqual({ lastTarget: 'KEEP' });
  });

  it('keeps independent CLI and Studio process updates', async () => {
    const bundle = await bundleMemory();
    const run = (writer: number) => new Promise<void>((resolve, reject) => {
      const script = "const { remember } = require(process.argv[1]); Promise.all(Array.from({ length: 4 }, (_, i) => remember(`writer-${process.argv[2]}-${i}`, { lastTarget: `TARGET-${i}` }))).catch((err) => { console.error(err); process.exitCode = 1; });";
      const child = spawn(process.execPath, ['-e', script, bundle, String(writer)], { windowsHide: true, env: { ...process.env, CAPMAC_CONFIG_DIR: dir }, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `Memory writer exited ${code}`)));
    });
    await Promise.all([run(0), run(1), run(2)]);

    const saved = await recallAll();
    expect(saved.sentinel).toEqual({ lastTarget: 'KEEP' });
    for (let writer = 0; writer < 3; writer++) for (let i = 0; i < 4; i++) expect(saved[`writer-${writer}-${i}`]).toEqual({ lastTarget: `TARGET-${i}` });
  });

  it('preserves an explicit choice made while migration was pending', async () => {
    const [, adopted] = await Promise.all([
      remember('new-id', { app: 'ios', lastTarget: 'NEW' }),
      adoptMemory('new-id', { app: 'electron', lastTarget: 'OLD', sound: 'mac' }),
    ]);

    expect(adopted).toEqual({ app: 'ios', lastTarget: 'NEW' });
    expect((await recallAll())['new-id']).toEqual(adopted);
  });

  it('never writes over settings it could not read', async () => {
    const before = await fs.readFile(path.join(dir, 'projects.json'), 'utf8');
    const read = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
    try {
      await expect(remember('other', { sound: 'pc' })).rejects.toThrow(/EBUSY/);
    } finally {
      read.mockRestore();
    }
    expect(await fs.readFile(path.join(dir, 'projects.json'), 'utf8')).toBe(before);
    expect(await leftInSettings()).toEqual(['projects.json']);
  });

  it('never takes the lock from a live writer that is slow', async () => {
    const bundle = await bundleMemory();
    const release = path.join(dir, 'release');
    const slow = writer(bundle, 'slow', release);
    try {
      await slow.holding();
      let saved = false;
      const other = remember('other', { lastTarget: 'other' }).then(() => { saved = true; });
      // Longer than any write takes: a lock that expired would have been taken from it by now.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(saved).toBe(false);
      await fs.writeFile(release, '');
      expect(await slow.exited, slow.output()).toBe(0);
      await other;
      expect(await recallAll()).toMatchObject({ sentinel: { lastTarget: 'KEEP' }, slow: { lastTarget: 'slow' }, other: { lastTarget: 'other' } });
    } finally {
      await slow.stop();
    }
  });

  it('lets go at once of a killed writer’s lock, and clears what it left', async () => {
    const bundle = await bundleMemory();
    const killed = writer(bundle, 'killed', '');
    try {
      await killed.holding();
      killed.child.kill();
      await killed.exited;
      const started = Date.now();
      await remember('after-crash', { sound: 'pc' });
      expect(Date.now() - started).toBeLessThan(2_000);
      const saved = await recallAll();
      expect(saved).toMatchObject({ sentinel: { lastTarget: 'KEEP' }, 'after-crash': { sound: 'pc' } });
      expect(saved.killed).toBeUndefined();
      // Its half-done write is gone too.
      expect(await leftInSettings()).toEqual(['projects.json']);
    } finally {
      await killed.stop();
    }
  });

  it('lets writers waiting on a killed one save in turn, losing none', async () => {
    const bundle = await bundleMemory();
    const killed = writer(bundle, 'killed', '');
    const waiting: Array<ReturnType<typeof writer>> = [];
    try {
      await killed.holding();
      for (let i = 0; i < 3; i++) waiting.push(writer(bundle, `waiting-${i}`));
      await new Promise((resolve) => setTimeout(resolve, 500));
      killed.child.kill();
      await killed.exited;
      for (const w of waiting) expect(await w.exited, w.output()).toBe(0);
      expect(await recallAll()).toMatchObject({ sentinel: { lastTarget: 'KEEP' }, 'waiting-0': { lastTarget: 'waiting-0' }, 'waiting-1': { lastTarget: 'waiting-1' }, 'waiting-2': { lastTarget: 'waiting-2' } });
      expect(await leftInSettings()).toEqual(['projects.json']);
    } finally {
      for (const w of [killed, ...waiting]) await w.stop();
    }
  });
});

/**
 * `remember(key)` in a process of its own, like the CLI's or Studio's.
 * `stall`: once it holds the lock and has read the settings, it stops there
 * until that file exists ('' for good), as a paused or killed writer would.
 */
function writer(bundle: string, key: string, stall?: string) {
  const script = `
    const fs = require('node:fs/promises');
    const [bundle, key, stall] = process.argv.slice(1);
    if (stall !== undefined) {
      const rename = fs.rename.bind(fs);
      fs.rename = async (...args) => {
        console.log('HOLDING');
        for (;;) {
          if (stall) { try { await fs.stat(stall); break; } catch {} }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return rename(...args);
      };
    }
    require(bundle).remember(key, { lastTarget: key }).catch((err) => { console.error(err); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ['-e', script, bundle, key, ...(stall === undefined ? [] : [stall])], { windowsHide: true, env: { ...process.env, CAPMAC_CONFIG_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  return {
    child,
    exited,
    output: () => output,
    async holding() {
      const deadline = Date.now() + 10_000;
      while (!output.includes('HOLDING')) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`The writer never held the lock: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}
