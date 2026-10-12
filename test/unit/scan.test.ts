import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanProject } from '../../src/cli/scan.js';

let root: string;

async function write(rel: string, content = 'x'): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'capmac-scan-'));
  await write('.gitignore', 'node_modules\ndist\n/ios/App/App/GoogleService-Info.plist\n*.secret\n!keep.secret\n');
  await write('package.json', '{}');
  await write('package-lock.json', '{}');
  await write('capacitor.config.ts', 'export default {}');
  await write('src/main.ts', 'console.log(1)');
  await write('dist/index.html', '<html>');
  await write('dist/assets/app.js', 'js');
  await write('node_modules/lodash/index.js', 'x');
  await write('android/app/build.gradle', 'x');
  await write('ios/.gitignore', 'App/Pods\nApp/App/public\n');
  await write('ios/App/Podfile', "platform :ios, '14.0'");
  await write('ios/App/App/AppDelegate.swift', 'import UIKit');
  await write('ios/App/App/GoogleService-Info.plist', '<plist/>');
  await write('ios/App/App/public/index.html', 'stale');
  await write('ios/App/App/capacitor.config.json', '{}');
  await write('ios/App/Pods/Manifest.lock', 'x');
  await write('ios/App/App.xcodeproj/xcuserdata/me.xcuserdatad/x.plist', 'x');
  await write('ios/App/scripts/build.sh', '#!/bin/sh\r\necho hi\r\n');
  await write('a.secret', 's');
  await write('keep.secret', 's');
  await write('.vscode/settings.json', '{}');
  await write('debug.log', 'x');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('scanProject', () => {
  it('applies defaults, .gitignore and the iOS rules', async () => {
    const result = await scanProject({ root, projectRel: '', webDir: 'dist', iosDir: 'ios', includeWebDir: true });
    const rels = result.files.map((f) => f.rel);
    expect(rels).toEqual([
      '.gitignore',
      'capacitor.config.ts',
      'dist/assets/app.js',
      'dist/index.html',
      'ios/.gitignore',
      'ios/App/App/AppDelegate.swift',
      'ios/App/App/GoogleService-Info.plist',
      'ios/App/Podfile',
      'ios/App/scripts/build.sh',
      'keep.secret',
      'package-lock.json',
      'package.json',
      'src/main.ts',
    ]);
    const script = result.files.find((f) => f.rel === 'ios/App/scripts/build.sh')!;
    expect(script.mode).toBe(0o755);
    expect(script.toLf).toBe(true);
  });

  it('leaves out web assets in live-reload mode', async () => {
    const result = await scanProject({ root, projectRel: '', webDir: 'dist', iosDir: 'ios', includeWebDir: false });
    expect(result.files.some((f) => f.rel.startsWith('dist/'))).toBe(false);
  });

  it('honours capmac.json include/exclude and .capmacignore', async () => {
    await write('.capmacignore', 'src/\n');
    const result = await scanProject({
      root, projectRel: '', webDir: 'dist', iosDir: 'ios', includeWebDir: true,
      include: ['a.secret'], exclude: ['keep.secret'],
    });
    const rels = result.files.map((f) => f.rel);
    expect(rels).toContain('a.secret');
    expect(rels).not.toContain('keep.secret');
    expect(rels).not.toContain('src/main.ts');
  });

  it('reuses cached hashes when files are unchanged', async () => {
    const cacheFile = path.join(root, '..', `${path.basename(root)}-cache.json`);
    try {
      const first = await scanProject({ root, projectRel: '', webDir: 'dist', iosDir: 'ios', includeWebDir: true, cacheFile });
      expect(first.hashed).toBe(first.files.length);
      const second = await scanProject({ root, projectRel: '', webDir: 'dist', iosDir: 'ios', includeWebDir: true, cacheFile });
      expect(second.hashed).toBe(0);
      expect(second.files.map((f) => f.hash)).toEqual(first.files.map((f) => f.hash));
      await new Promise((r) => setTimeout(r, 20));
      await write('src/main.ts', 'console.log(2)');
      const third = await scanProject({ root, projectRel: '', webDir: 'dist', iosDir: 'ios', includeWebDir: true, cacheFile });
      expect(third.hashed).toBe(1);
    } finally {
      await fs.rm(cacheFile, { force: true });
    }
  });

  it('walks into a gitignored ios folder and a nested web dir', async () => {
    await write('.gitignore', 'ios/\nbuild/\nnode_modules\n');
    await write('build/app/browser/index.html', '<html>');
    await write('build/stats.json', '{}');
    const result = await scanProject({ root, projectRel: '', webDir: 'build/app/browser', iosDir: 'ios', includeWebDir: true });
    const rels = result.files.map((f) => f.rel);
    expect(rels).toContain('ios/App/App/AppDelegate.swift');
    expect(rels).toContain('build/app/browser/index.html');
    expect(rels).not.toContain('build/stats.json');
  });

  it('supports a Capacitor app inside a monorepo', async () => {
    await write('apps/mobile/capacitor.config.ts', 'x');
    await write('apps/mobile/www/index.html', 'x');
    await write('apps/mobile/ios/App/App/AppDelegate.swift', 'x');
    await write('apps/mobile/ios/App/App/public/index.html', 'x');
    await write('apps/mobile/android/build.gradle', 'x');
    const result = await scanProject({ root, projectRel: 'apps/mobile', webDir: 'www', iosDir: 'ios', includeWebDir: true });
    const rels = result.files.map((f) => f.rel);
    expect(rels).toContain('apps/mobile/www/index.html');
    expect(rels).toContain('apps/mobile/ios/App/App/AppDelegate.swift');
    expect(rels).not.toContain('apps/mobile/ios/App/App/public/index.html');
    expect(rels).not.toContain('apps/mobile/android/build.gradle');
  });
});
