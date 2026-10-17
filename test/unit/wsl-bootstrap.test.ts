import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapWslDependencies, devicePythonCurrent, ensureHostDeviceTools, ensureManagedWslDistro, INSTALL_HOST_DEVICE_TOOLS, INSTALL_WSL_DEPENDENCIES, MANAGED_SWIFT_VERSION, MANAGED_WSL_DISTRO, PRIVATE_PYTHON, privatePythonPath } from '../../packages/core/src/engine/wsl/bootstrap.js';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), signer: vi.fn(), resources: vi.fn(), replies: [] as Array<{ stdout?: string; stderr?: string; code?: number; error?: Error }> }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: boundary.spawn }));
vi.mock('../../packages/core/src/engine/wsl/signer-tools.js', () => ({ ensureWslSigner: boundary.signer }));
vi.mock('../../packages/core/src/engine/wsl/resources.js', () => ({ installWslResourceTools: boundary.resources }));
const linux = { swift: '/opt/swift/usr/bin/swiftc', clang: '/usr/bin/clang', linker: '/usr/bin/ld64.lld-18', archive: '/usr/bin/llvm-ar', lipo: '/usr/bin/llvm-lipo-18', strip: '/usr/bin/llvm-strip', ruby: '/usr/bin/ruby', pod: '/usr/local/bin/pod' };

let toolsHome: string;
beforeEach(async () => {
  // Never the developer's own iPhone tools or the internet: a wrong path check would replace CapMac's Python.
  toolsHome = await mkdtemp(path.join(os.tmpdir(), 'capmac-tools-home-'));
  vi.stubEnv('LOCALAPPDATA', toolsHome);
  vi.stubEnv('XDG_DATA_HOME', toolsHome);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('tests stay offline'); }));
  boundary.replies = [];
  boundary.spawn.mockReset();
  boundary.signer.mockReset().mockResolvedValue('/home/test/capmac-zsign');
  boundary.resources.mockReset().mockResolvedValue({ actoolPath: '/tools/actool', ibtoolPath: '/tools/ibtool', momcPath: '/tools/momc', xcstringsPath: '/tools/xcstrings' });
  boundary.spawn.mockImplementation(() => {
    const reply = boundary.replies.shift() ?? {};
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => {
      if (reply.error) { child.emit('error', reply.error); return; }
      if (reply.stdout) child.stdout.write(reply.stdout);
      if (reply.stderr) child.stderr.write(reply.stderr);
      child.emit('close', reply.code ?? 0);
    });
    return child;
  });
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(toolsHome, { recursive: true, force: true }); });

describe('managed dependency setup', () => {
  it.runIf(process.platform === 'win32')('reuses CapMac-Ubuntu without changing the default distribution', async () => {
    boundary.replies.push({ stdout: 'docker-desktop\r\nCapMac-Ubuntu\r\n' });
    await expect(ensureManagedWslDistro()).resolves.toBe(MANAGED_WSL_DISTRO);
    expect(boundary.spawn).toHaveBeenCalledTimes(1);
    expect(boundary.spawn.mock.calls[0]).toEqual(['wsl.exe', ['--list', '--quiet'], expect.objectContaining({ windowsHide: true, shell: false })]);
  });

  it.runIf(process.platform === 'win32')('reports missing WSL and refuses Docker as a build distro', async () => {
    boundary.replies.push({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
    await expect(ensureManagedWslDistro()).rejects.toMatchObject({ message: 'WSL 2 is not installed or cannot start.' });
    boundary.replies.push({ stdout: 'docker-desktop\r\n' });
    await expect(ensureManagedWslDistro({ distro: 'docker-desktop' })).rejects.toThrow(/not available/);
    expect(boundary.spawn.mock.calls.every((call) => !(call[1] as string[]).includes('--install'))).toBe(true);
  });

  it('reuses a supported host device environment without pip changes', async () => {
    const executable = process.platform === 'win32' ? 'C:\\Python\\python.exe' : '/usr/bin/python3';
    boundary.replies.push({ stdout: JSON.stringify({ executable, version: [3, 13], venv: true, device: '11.32.0' }) });
    await expect(ensureHostDeviceTools({ python: executable })).resolves.toBe(executable);
    expect(boundary.spawn).toHaveBeenCalledTimes(1);
  });

  it('installs into a private venv while preserving the base Python packages', async () => {
    const base = process.platform === 'win32' ? 'C:\\Users\\Test\\AppData\\Local' : '/home/test/.local/share';
    if (process.platform === 'win32') vi.stubEnv('LOCALAPPDATA', base); else vi.stubEnv('XDG_DATA_HOME', base);
    const executable = process.platform === 'win32' ? 'C:\\Base Python\\python.exe' : '/usr/bin/python3';
    const managed = path.join(base, 'CapMac', 'device-tools', '11.32.0', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
    boundary.replies.push({ stdout: JSON.stringify({ executable, version: [3, 13], venv: true, device: null }) }, { stdout: JSON.stringify({ python: managed }) });
    await expect(ensureHostDeviceTools({ python: executable })).resolves.toBe(managed);
    expect(boundary.spawn.mock.calls[1]?.[1]).toEqual(['-c', INSTALL_HOST_DEVICE_TOOLS, path.dirname(path.dirname(managed)), '11.32.0']);
    expect(INSTALL_HOST_DEVICE_TOOLS).toContain('venv.EnvBuilder(with_pip=True)');
  });

  it.runIf(process.platform === 'win32')('uses CapMac’s own Python, also in place of one an earlier CapMac set up', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'capmac-tools-'));
    vi.stubEnv('LOCALAPPDATA', base);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const own = privatePythonPath()!;
    expect(own).toBe(path.join(base, 'CapMac', 'device-tools', `11.32.0-python-${PRIVATE_PYTHON.version}`, 'python.exe'));
    boundary.replies.push({ stdout: '11.32.0\n' });
    await expect(ensureHostDeviceTools({ python: path.join(base, 'CapMac', 'device-tools', '11.32.0', 'Scripts', 'python.exe') })).resolves.toBe(own);
    expect(boundary.spawn.mock.calls[0]).toEqual([own, ['-I', '-c', expect.stringContaining('pymobiledevice3')], expect.anything()]);
    expect(fetch).not.toHaveBeenCalled();
    // Which Python setup keeps: its own and someone's chosen one, not one an earlier CapMac set up.
    expect(devicePythonCurrent(own)).toBe(true);
    expect(devicePythonCurrent('C:\\Python313\\python.exe')).toBe(true);
    // One on another drive is outside CapMac's folder too (path.relative gives an absolute path there).
    expect(devicePythonCurrent(`${base[0]!.toUpperCase() === 'Z' ? 'Y' : 'Z'}:\\Python313\\python.exe`)).toBe(true);
    expect(devicePythonCurrent(path.join(base, 'CapMac', 'device-tools', '11.32.0', 'Scripts', 'python.exe'))).toBe(false);
    expect(devicePythonCurrent(undefined)).toBe(true);
    await rm(base, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'win32')('refuses a damaged Python download and leaves nothing behind', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'capmac-tools-'));
    vi.stubEnv('LOCALAPPDATA', base);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not python')));
    boundary.replies.push({ code: 1 });
    await expect(ensureHostDeviceTools()).rejects.toMatchObject({ message: 'The Python download for the iPhone tools was damaged.' });
    expect(await readdir(path.join(base, 'CapMac', 'device-tools'))).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    boundary.replies.push({ code: 1 });
    await expect(ensureHostDeviceTools()).rejects.toMatchObject({ message: 'Could not download Python for the iPhone tools.' });
    await rm(base, { recursive: true, force: true });
  });

  it('returns a complete options patch using the existing signer/resource installers', async () => {
    const run = vi.fn(async (..._args: unknown[]) => ({ code: 0, stdout: JSON.stringify(linux), stderr: '' }));
    const executor = { distro: 'CapMac-Ubuntu', run, path: vi.fn(async (value: string) => value) };
    boundary.replies.push({ stdout: JSON.stringify({ executable: 'C:\\Python\\python.exe', version: [3, 13], venv: true, device: '11.32.0' }) });
    const patch = await bootstrapWslDependencies(executor, { swift: linux.swift, python: 'python' });
    expect(patch).toMatchObject({ ...linux, distro: executor.distro, signer: '/home/test/capmac-zsign', actool: '/tools/actool', python: 'C:\\Python\\python.exe' });
    expect(run.mock.calls[0]?.[0]).toEqual(['python3', '-c', INSTALL_WSL_DEPENDENCIES, linux.swift, MANAGED_SWIFT_VERSION]);
    expect(boundary.resources).toHaveBeenCalledWith(executor, expect.objectContaining({ swiftPath: '/opt/swift/usr/bin/swift' }));
  });

  it('replaces a Swift that CapMac installed for an older Xcode pairing, but keeps a developer’s own Swift', async () => {
    const run = vi.fn(async (..._args: unknown[]) => ({ code: 0, stdout: JSON.stringify(linux), stderr: '' }));
    const executor = { distro: 'CapMac-Ubuntu', run, path: vi.fn(async (value: string) => value) };
    boundary.replies.push({ stdout: JSON.stringify({ executable: 'C:\Python\python.exe', version: [3, 13], venv: true, device: '11.32.0' }) });
    await bootstrapWslDependencies(executor, { swift: '/root/.local/share/capmac/toolchains/swift-6.2.3-RELEASE-ubuntu24.04/usr/bin/swiftc', python: 'python' });
    expect(run.mock.calls[0]?.[0]).toEqual(['python3', '-c', INSTALL_WSL_DEPENDENCIES, '', MANAGED_SWIFT_VERSION]);
  });

  it('rejects malformed installer paths and preserves cancellation', async () => {
    const executor = { distro: 'Ubuntu', run: vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ ...linux, linker: 'relative/ld' }), stderr: '' })), path: vi.fn(async (value: string) => value) };
    await expect(bootstrapWslDependencies(executor)).rejects.toThrow(/invalid executable paths/);
    expect(boundary.signer).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(bootstrapWslDependencies(executor, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(ensureManagedWslDistro({ signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('keeps the transported installers valid Python and pins genuine release verification', () => {
    for (const script of [INSTALL_WSL_DEPENDENCIES, INSTALL_HOST_DEVICE_TOOLS]) {
      const result = spawnSync('python', ['-c', 'import sys; compile(sys.stdin.read(),"capmac-bootstrap","exec")'], { input: script, encoding: 'utf8', windowsHide: true });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(INSTALL_WSL_DEPENDENCIES).toContain('52BB7E3DE28A71BE22EC05FFEF80A866B47A981F');
    expect(INSTALL_WSL_DEPENDENCIES).toContain("bundle.extract(member,path=stage,filter='data')");
  });
});
