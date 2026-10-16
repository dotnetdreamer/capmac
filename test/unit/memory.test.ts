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

  it('recovers a lock left by a killed writer', async () => {
    const lockFile = path.join(dir, 'projects.json.lock');
    const script = "require('node:fs').writeFileSync(process.argv[1], `${process.pid} dead-writer`); console.log('locked'); setInterval(() => {}, 1000);";
    const child = spawn(process.execPath, ['-e', script, lockFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve, reject) => { child.on('exit', () => resolve()); child.on('error', reject); });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
      child.kill();
      await exited;
      await remember('after-crash', { sound: 'pc' });

      expect((await recallAll())['after-crash']).toEqual({ sound: 'pc' });
      expect((await recallAll()).sentinel).toEqual({ lastTarget: 'KEEP' });
      expect(await fs.readdir(dir)).toEqual(['projects.json']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });

  it('recovers a lock whose writer’s process id now belongs to another program', async () => {
    // Windows reuses process ids soon: a lock left long ago can name a live process.
    const lockFile = path.join(dir, 'projects.json.lock');
    await fs.writeFile(lockFile, `${process.pid} long-gone-writer`);
    const longAgo = new Date(Date.now() - 60_000);
    await fs.utimes(lockFile, longAgo, longAgo);
    const started = Date.now();
    await remember('after-reuse', { sound: 'pc' });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await recallAll()).toMatchObject({ sentinel: { lastTarget: 'KEEP' }, 'after-reuse': { sound: 'pc' } });
    expect(await fs.readdir(dir)).toEqual(['projects.json']);
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
    expect(await fs.readdir(dir)).toEqual(['projects.json']);
  });

  it('serializes concurrent recovery without deleting the next writer’s live lock', async () => {
    const bundle = await bundleMemory();
    const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    await new Promise<void>((resolve, reject) => { dead.on('exit', () => resolve()); dead.on('error', reject); });
    await fs.writeFile(path.join(dir, 'projects.json.lock'), `${dead.pid} dead-writer`);
    // Pause B after its stale-owner check. A either waits for B's recovery
    // guard, or (the regression) takes a lock B is about to delete.
    const script = `
      const fs = require('node:fs/promises'), path = require('node:path');
      const root = process.argv[2], role = process.argv[3];
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async file => { for (;;) { try { await fs.stat(path.join(root, file)); return; } catch {} await wait(2); } };
      let paused = false;
      if (role === 'B') {
        const unlink = fs.unlink.bind(fs);
        fs.unlink = async file => {
          if (file === path.join(root, 'projects.json.lock') && !paused) { paused = true; console.log('B_READY'); await until('release-b'); }
          return unlink(file);
        };
      } else {
        const rename = fs.rename.bind(fs), link = fs.link.bind(fs);
        fs.rename = async (...args) => { console.log('A_HOLDING'); await until('release-a'); return rename(...args); };
        fs.link = async (...args) => {
          try { return await link(...args); } catch (err) {
            if (args[1] === path.join(root, 'projects.json.recovery.lock') && err.code === 'EEXIST') console.log('A_WAITING');
            throw err;
          }
        };
      }
      const { remember } = require(process.argv[1]);
      remember(role, { lastTarget: role }).catch(err => { console.error(err); process.exitCode = 1; });
    `;
    const start = (role: string) => {
      const child = spawn(process.execPath, ['-e', script, bundle, dir, role], { windowsHide: true, env: { ...process.env, CAPMAC_CONFIG_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      const exited = new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
      return { child, exited, output: () => output };
    };
    const waitFor = async (writer: ReturnType<typeof start>, pattern: RegExp) => {
      const deadline = Date.now() + 5000;
      while (!pattern.test(writer.output())) {
        if (Date.now() > deadline) throw new Error(`Writer did not reach ${pattern}: ${writer.output()}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const b = start('B');
    let a: ReturnType<typeof start> | undefined;
    try {
      await waitFor(b, /B_READY/);
      a = start('A');
      await waitFor(a, /A_HOLDING|A_WAITING/);
      const stolen = a.output().includes('A_HOLDING');
      await fs.writeFile(path.join(dir, 'release-b'), '');
      if (stolen) await b.exited;
      await waitFor(a, /A_HOLDING/);
      await fs.writeFile(path.join(dir, 'release-a'), '');
      expect(await a.exited, a.output()).toBe(0);
      expect(await b.exited, b.output()).toBe(0);
      expect(await recallAll()).toMatchObject({ sentinel: { lastTarget: 'KEEP' }, A: { lastTarget: 'A' }, B: { lastTarget: 'B' } });
    } finally {
      for (const writer of [a, b]) {
        if (!writer) continue;
        if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill();
        await writer.exited;
      }
    }
  });

  it('does not publish an ownerless lock when a writer is killed before acquisition', async () => {
    const bundle = await bundleMemory();
    const script = `
      const fs = require('node:fs/promises');
      fs.link = async () => { console.log('BEFORE_PUBLISH'); await new Promise(() => {}); };
      require(process.argv[1]).remember('killed', { sound: 'mac' });
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script, bundle], { windowsHide: true, env: { ...process.env, CAPMAC_CONFIG_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve, reject) => { child.on('exit', () => resolve()); child.on('error', reject); });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
      child.kill();
      await exited;
      await remember('after-crash', { sound: 'pc' });
      expect(await recallAll()).toMatchObject({ sentinel: { lastTarget: 'KEEP' }, 'after-crash': { sound: 'pc' } });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });
});
