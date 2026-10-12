import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectInfo } from '../../packages/core/src/engine/project.js';
import { watchNativeChanges } from '../../packages/core/src/engine/watch.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(25);
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): { root: string; info: ProjectInfo; swift: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capmac-watch-'));
  dirs.push(root);
  const swift = path.join(root, 'ios', 'App', 'App', 'AppDelegate.swift');
  mkdirSync(path.dirname(swift), { recursive: true });
  writeFileSync(swift, 'class AppDelegate {}\n');
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'dist', 'index.html'), '<h1>hi</h1>');
  // Written long ago, like most files in a real project.
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(swift, old, old);
  const info = { syncRoot: root, capDir: root, projectRel: '', webDir: 'dist', iosDir: 'ios' } as ProjectInfo;
  return { root, info, swift };
}

describe('watchNativeChanges', () => {
  it('reports a Swift file that was written', async () => {
    const { info, swift } = project();
    const changes: string[][] = [];
    const watcher = watchNativeChanges(info, (_kinds, paths) => changes.push(paths), 50);
    try {
      await sleep(300);
      writeFileSync(swift, 'class AppDelegate { var launches = 1 }\n');
      await until(() => changes.length > 0);
      expect(changes.flat()).toContain('ios/App/App/AppDelegate.swift');
    } finally {
      watcher.close();
    }
  });

  it('ignores files that were only read (Windows reports last-access updates as changes)', async () => {
    const { info, swift } = project();
    const changes: string[][] = [];
    const watcher = watchNativeChanges(info, (_kinds, paths) => changes.push(paths), 50);
    try {
      await sleep(300);
      readFileSync(swift);
      const { mtime } = statSync(swift);
      // Only the access time moves: what an editor, indexer or virus scanner causes.
      utimesSync(swift, new Date(), mtime);
      utimesSync(swift, new Date(), mtime);
      await sleep(500);
      expect(changes).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it('ignores web changes (HMR handles them)', async () => {
    const { root, info } = project();
    const changes: string[][] = [];
    const watcher = watchNativeChanges(info, (_kinds, paths) => changes.push(paths), 50);
    try {
      await sleep(300);
      writeFileSync(path.join(root, 'dist', 'index.html'), '<h1>changed</h1>');
      await sleep(400);
      expect(changes).toEqual([]);
    } finally {
      watcher.close();
    }
  });
});
