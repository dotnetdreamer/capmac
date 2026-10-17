import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMBED_SWIFT_RUNTIMES } from '../../packages/core/src/engine/wsl/swift-runtime.js';

const python = ['python3', 'python'].find((name) => spawnSync(name, ['-c', 'import plistlib'], { timeout: 3000, windowsHide: true }).status === 0);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** A real Mach-O header and dylib load commands, without pretending it is executable code. */
function macho(dependencies: { name: string; weak?: boolean }[] = [], fileType = 6): Buffer {
  const commands = dependencies.map(({ name, weak }) => {
    const text = Buffer.from(name + '\0'); const size = Math.ceil((24 + text.length) / 8) * 8;
    const data = Buffer.alloc(size); data.writeUInt32LE(weak ? 0x80000018 : 0xc); data.writeUInt32LE(size, 4); data.writeUInt32LE(24, 8); text.copy(data, 24); return data;
  });
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(0x100000c, 4); header.writeUInt32LE(fileType, 12); header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(commands.reduce((total, command) => total + command.length, 0), 20);
  return Buffer.concat([header, ...commands]);
}
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'capmac-swift-runtime-')); directories.push(directory);
  const app = path.join(directory, 'App.app'); const resources = path.join(directory, 'swift');
  mkdirSync(app); mkdirSync(path.join(resources, 'iphoneos'), { recursive: true });
  const run = () => spawnSync(python!, ['-c', EMBED_SWIFT_RUNTIMES, app, 'App', resources], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return { directory, app, resources, run };
}

describe.skipIf(!python)('actual Mach-O Swift runtime dependency embedding', () => {
  it('copies the exact required runtime closure and leaves unrelated system and toolchain libraries out', () => {
    const { app, resources, run } = fixture();
    writeFileSync(path.join(app, 'App'), macho([{ name: '@rpath/libswift_Concurrency.dylib' }, { name: '/usr/lib/swift/libswiftCore.dylib' }], 2));
    writeFileSync(path.join(resources, 'iphoneos', 'libswift_Concurrency.dylib'), macho([{ name: '@rpath/libswiftSynchronization.dylib' }]));
    writeFileSync(path.join(resources, 'iphoneos', 'libswiftSynchronization.dylib'), macho());
    writeFileSync(path.join(resources, 'iphoneos', 'libswiftUnrelated.dylib'), macho());
    const result = run(); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(app, 'Frameworks', 'libswift_Concurrency.dylib'))).toBe(true);
    expect(existsSync(path.join(app, 'Frameworks', 'libswiftSynchronization.dylib'))).toBe(true);
    expect(existsSync(path.join(app, 'Frameworks', 'libswiftUnrelated.dylib'))).toBe(false);
    expect(existsSync(path.join(app, 'Frameworks', 'libswiftCore.dylib'))).toBe(false);
  });
  it('fails explicitly when a required runtime is absent, while preserving optional weak dependencies', () => {
    const { app, run } = fixture();
    writeFileSync(path.join(app, 'App'), macho([{ name: '@rpath/libswiftOptional.dylib', weak: true }], 2));
    expect(run().status).toBe(0);
    writeFileSync(path.join(app, 'App'), macho([{ name: '@rpath/libswiftRequired.dylib' }], 2));
    const result = run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Missing required Swift runtime libswiftRequired.dylib');
  });
  it('extracts the regular arm64 slice from a universal runtime before final signing', () => {
    const { app, resources, run } = fixture(); const payload = macho(); const universal = Buffer.alloc(32);
    universal.writeUInt32BE(0xcafebabe); universal.writeUInt32BE(1, 4); universal.writeUInt32BE(0x100000c, 8); universal.writeUInt32BE(0, 12); universal.writeUInt32BE(32, 16); universal.writeUInt32BE(payload.length, 20);
    writeFileSync(path.join(app, 'App'), macho([{ name: '@rpath/libswiftThinMe.dylib' }], 2));
    writeFileSync(path.join(resources, 'iphoneos', 'libswiftThinMe.dylib'), Buffer.concat([universal, payload]));
    const result = run(); expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(app, 'Frameworks', 'libswiftThinMe.dylib'))).toEqual(payload);
  });
  it('also discovers runtime imports from embedded framework executables', () => {
    const { app, resources, run } = fixture(); writeFileSync(path.join(app, 'App'), macho([], 2));
    const framework = path.join(app, 'Frameworks', 'Plugin.framework'); mkdirSync(framework, { recursive: true });
    writeFileSync(path.join(framework, 'Plugin'), macho([{ name: '@rpath/libswiftPluginRuntime.dylib' }]));
    writeFileSync(path.join(resources, 'iphoneos', 'libswiftPluginRuntime.dylib'), macho());
    const result = run(); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(app, 'Frameworks', 'libswiftPluginRuntime.dylib'))).toBe(true);
  });
  it('embeds runtimes needed only by the widget into the app shared Frameworks directory', () => {
    const { app, resources, run } = fixture(); writeFileSync(path.join(app, 'App'), macho([], 2));
    const extension = path.join(app, 'PlugIns', 'HomeCard.appex'); mkdirSync(extension, { recursive: true });
    writeFileSync(path.join(extension, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>HomeCard</string></dict></plist>');
    writeFileSync(path.join(extension, 'HomeCard'), macho([{ name: '@rpath/libswiftWidgetOnly.dylib' }], 2));
    writeFileSync(path.join(resources, 'iphoneos', 'libswiftWidgetOnly.dylib'), macho());
    const result = run(); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(app, 'Frameworks', 'libswiftWidgetOnly.dylib'))).toBe(true);
    expect(existsSync(path.join(extension, 'Frameworks', 'libswiftWidgetOnly.dylib'))).toBe(false);
  });
  it('leaves arbitrary web assets outside native code directories alone', () => {
    const { app, run } = fixture(); writeFileSync(path.join(app, 'App'), macho([], 2));
    const assets = path.join(app, 'public', 'downloads'); mkdirSync(assets, { recursive: true });
    writeFileSync(path.join(assets, 'example.dylib'), 'A web asset, not a Mach-O dependency');
    const result = run(); expect(result.status, result.stderr).toBe(0);
  });
});
