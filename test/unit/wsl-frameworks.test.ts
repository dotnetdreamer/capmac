import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentContext } from '../../packages/core/src/engine/context.js';
import { capacitorFrameworks } from '../../packages/core/src/engine/wsl/capacitor.js';
import type { WslExecutor } from '../../packages/core/src/engine/wsl/toolchain.js';

const directories: string[] = [];
const version = '8.5.3';
const bytes = { Capacitor: Buffer.from('verified Capacitor framework archive'), Cordova: Buffer.from('verified Cordova framework archive') };
const url = (name: string) => `https://github.com/ionic-team/capacitor-swift-pm/releases/download/${version}/${name}.xcframework.zip`;
const manifestUrl = `https://raw.githubusercontent.com/ionic-team/capacitor-swift-pm/${version}/Package.swift`;
const checksum = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const manifest = (overrides: { capacitorUrl?: string; capacitorChecksum?: string } = {}) => `
let package = Package(targets: [
 .binaryTarget(name: "Capacitor", url: "${overrides.capacitorUrl ?? url('Capacitor')}", checksum: "${overrides.capacitorChecksum ?? checksum(bytes.Capacitor)}"),
 .binaryTarget(name: "Cordova", url: "${url('Cordova')}", checksum: "${checksum(bytes.Cordova)}")
])`;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-frameworks-'));
  directories.push(directory);
  const cache = path.join(directory, 'framework-cache');
  const run = vi.fn(async (argv: string[]) => {
    // Model the extraction boundary by materializing the expected archive result.
    const target = argv[4]!;
    const name = path.basename(target);
    const framework = path.join(target, `${name}.xcframework`, 'ios-arm64', `${name}.framework`);
    await mkdir(framework, { recursive: true });
    await writeFile(path.join(framework, name), 'framework executable');
    return { stdout: '', stderr: '', code: 0 };
  });
  const executor = { distro: 'Ubuntu', path: vi.fn(async (value: string) => value), run } as unknown as WslExecutor;
  const fetchMock = vi.fn(async (request: string | URL | Request) => {
    if (String(request) === manifestUrl) return new Response(manifest());
    if (String(request) === url('Capacitor')) return new Response(bytes.Capacitor);
    if (String(request) === url('Cordova')) return new Response(bytes.Cordova);
    throw new Error(`Unexpected download ${String(request)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const prepare = (selectedVersion = version) => capacitorFrameworks(selectedVersion, cache, executor, silentContext(), new AbortController().signal);
  return { cache, executor, run, fetchMock, prepare };
}

describe('verified official Capacitor framework artifacts', () => {
  it('verifies official downloads before extraction and reuses cached archives and frameworks', async () => {
    const fixture = await setup();
    const frameworks = await fixture.prepare();
    expect(frameworks).toEqual(['Capacitor', 'Cordova'].map((name) => ({ path: path.join(fixture.cache, version, name, `${name}.xcframework`, 'ios-arm64', `${name}.framework`) })));
    expect(fixture.fetchMock.mock.calls.map(([request]) => String(request))).toEqual([manifestUrl, url('Capacitor'), url('Cordova')]);
    expect(fixture.run).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(fixture.cache, version, 'Capacitor.zip'))).toEqual(bytes.Capacitor);
    await expect(fixture.prepare()).resolves.toEqual(frameworks);
    expect(fixture.fetchMock.mock.calls.map(([request]) => String(request))).toEqual([manifestUrl, url('Capacitor'), url('Cordova'), manifestUrl]);
    expect(fixture.run).toHaveBeenCalledTimes(2);
  });

  it('rejects a checksum mismatch before saving or extracting the untrusted download', async () => {
    const fixture = await setup();
    fixture.fetchMock.mockImplementation(async (request) => String(request) === manifestUrl ? new Response(manifest()) : new Response('tampered archive'));
    await expect(fixture.prepare()).rejects.toThrow('checksum does not match');
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(access(path.join(fixture.cache, version, 'Capacitor.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a manifest pointing outside the exact official versioned release URL', async () => {
    const fixture = await setup();
    fixture.fetchMock.mockResolvedValue(new Response(manifest({ capacitorUrl: 'https://example.test/Capacitor.xcframework.zip' })));
    await expect(fixture.prepare()).rejects.toThrow('Cannot verify the Capacitor framework release manifest');
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(access(fixture.cache)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not trust an archive already in cache without checking its published checksum', async () => {
    const fixture = await setup();
    await mkdir(path.join(fixture.cache, version), { recursive: true });
    await writeFile(path.join(fixture.cache, version, 'Capacitor.zip'), 'corrupted cached download');
    await fixture.prepare();
    expect(fixture.fetchMock.mock.calls.map(([request]) => String(request))).toContain(url('Capacitor'));
    expect(await readFile(path.join(fixture.cache, version, 'Capacitor.zip'))).toEqual(bytes.Capacitor);
    expect(fixture.run).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported versions before network access or filesystem mutation', async () => {
    const fixture = await setup();
    await expect(fixture.prepare('9.0.0')).rejects.toThrow('not supported');
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(access(fixture.cache)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an unavailable published manifest without extracting anything', async () => {
    const fixture = await setup();
    fixture.fetchMock.mockResolvedValue(new Response('Not found', { status: 404 }));
    await expect(fixture.prepare()).rejects.toThrow('binary release is unavailable');
    expect(fixture.run).not.toHaveBeenCalled();
  });
});
