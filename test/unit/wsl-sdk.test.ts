import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IMPORT_XCODE_SDK, setupSDKFromXcode } from '../../packages/core/src/engine/wsl/sdk.js';
import { WslExecutor } from '../../packages/core/src/engine/wsl/toolchain.js';

describe('Xcode SDK setup', () => {
  it('translates the user archive and returns validated cached resource paths', async () => {
    const imported = { sdkPath: '/home/test/.local/share/capmac/apple-sdk/abc/Xcode.app/iPhoneOS.sdk', swiftResourcePath: '/home/test/.local/share/capmac/apple-sdk/abc/swift', xcodeVersion: '26.2' };
    const run = vi.fn(async (..._args: unknown[]) => ({ code: 0, stdout: JSON.stringify(imported), stderr: '' }));
    const executor = { distro: 'Ubuntu', run, path: vi.fn(async () => '/mnt/c/Users/Test/Downloads/Xcode_26.2.xip') };
    await expect(setupSDKFromXcode(executor, 'C:\\Users\\Test\\Downloads\\Xcode_26.2.xip')).resolves.toEqual(imported);
    expect(run.mock.calls[0]![0]).toEqual(['python3', '-c', IMPORT_XCODE_SDK, '/mnt/c/Users/Test/Downloads/Xcode_26.2.xip']);
    run.mockResolvedValueOnce({ code: 0, stdout: 'null', stderr: '' });
    await expect(setupSDKFromXcode(executor, '/tmp/Xcode.xip')).rejects.toThrow(/invalid output/);
    run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ...imported, sdkPath: 'relative/sdk' }), stderr: '' });
    await expect(setupSDKFromXcode(executor, '/tmp/Xcode.xip')).rejects.toThrow(/invalid resource paths/);
  });

  it('reports how much of the archive is read, and keeps those lines out of the output', async () => {
    const imported = { sdkPath: '/sdk/iPhoneOS.sdk', swiftResourcePath: '/sdk/swift', xcodeVersion: '26.6' };
    const run = vi.fn(async (_command: string[], options?: { onOutput?: (text: string, stream: 'stdout' | 'stderr') => void }) => {
      options?.onOutput?.('Importing only the iPhoneOS SDK and Darwin Swift resources; this can take several minutes.\n', 'stderr');
      // Lines can arrive together, and with Windows line ends.
      options?.onOutput?.('Reading Xcode archive: 0%\nReading Xcode archive: 12%\n', 'stderr');
      options?.onOutput?.('Reading Xcode archive: 100%\r\nLeaving out a link to Xcode files CapMac does not import: x\n', 'stderr');
      return { code: 0, stdout: JSON.stringify(imported), stderr: '' };
    });
    const executor = { distro: 'Ubuntu', run, path: vi.fn(async (value: string) => value) };
    const output: string[] = [];
    const progress: number[] = [];
    await expect(setupSDKFromXcode(executor, '/tmp/Xcode.xip', { onOutput: (text) => output.push(text), onProgress: (fraction) => progress.push(fraction) })).resolves.toEqual(imported);
    expect(progress).toEqual([0, 0.12, 1]);
    expect(output.join('')).toBe('Importing only the iPhoneOS SDK and Darwin Swift resources; this can take several minutes.\nLeaving out a link to Xcode files CapMac does not import: x\n');
  });

  it('preserves cancellation and reports actionable archive failures', async () => {
    const executor = { distro: 'Ubuntu', run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'XIP Content checksum mismatch' })), path: vi.fn(async (value: string) => value) };
    const controller = new AbortController(); controller.abort();
    await expect(setupSDKFromXcode(executor, '/tmp/Xcode.xip', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(executor.run).not.toHaveBeenCalled();
    await expect(setupSDKFromXcode(executor, '/tmp/Xcode.xip')).rejects.toMatchObject({ details: ['XIP Content checksum mismatch'] });
  });

  it('transports a valid dependency-free Python extractor', () => {
    const result = spawnSync('python', ['-c', 'import sys; compile(sys.stdin.read(),"capmac-xcode-import","exec")'], { input: IMPORT_XCODE_SDK, encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe.skipIf(!process.env.CAPMAC_SDK_TEST_WSL)('real Linux selective XIP extraction', () => {
  it('imports synthetic odc/newc/CRC archives, preserves links/modes, caches results, and rejects corrupt or unsafe archives', async () => {
    const executor = new WslExecutor(process.env.CAPMAC_SDK_TEST_WSL!);
    const fixture = readFileSync(path.resolve('test/fixtures/wsl-xcode-import.py'), 'utf8');
    const result = await executor.run(['python3', '-c', fixture], { stdin: IMPORT_XCODE_SDK, timeoutMs: 120_000, allowFailure: true });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const proof = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const name of ['odc', 'newc', 'crc', 'rawChunks', 'hardlinks', 'odcPlaceholders', 'clangLink', 'sdkShims','symlinks', 'modes', 'selective', 'idempotent', 'interruptedRetry', 'zeroFinalChunk']) expect(proof[name], name).toBe(true);
    expect(proof.rejected).toEqual(['toc-checksum', 'content-checksum', 'crc', 'xml-entity', 'traversal', 'control', 'symlink-escape', 'symlink-parent', 'duplicate', 'link-missing', 'link-ambiguous', 'placeholder-alone']);
  }, 120_000);
});
