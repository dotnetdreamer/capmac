import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureWslSigner, INSTALL_WSL_SIGNER, WSL_SCOPED_SIGNER_MARKER, WSL_SIGNER_REVISION } from '../../packages/core/src/engine/wsl/signer-tools.js';
import { WslExecutor } from '../../packages/core/src/engine/wsl/toolchain.js';

describe('WSL scoped signer preparation', () => {
  it('builds the pinned capability and accepts only a valid WSL executable path', async () => {
    const run = vi.fn(async (..._args: unknown[]) => ({ code: 0, stdout: JSON.stringify({ signerPath: '/home/test/.cache/capmac/signers/pinned/capmac-zsign' }), stderr: '' }));
    const executor = { distro: 'Ubuntu', run, path: vi.fn() };
    await expect(ensureWslSigner(executor)).resolves.toMatch(/\/capmac-zsign$/);
    expect(run.mock.calls[0]![0]).toEqual(['python3', '-c', INSTALL_WSL_SIGNER, WSL_SIGNER_REVISION]);
    run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ signerPath: 'relative/zsign' }), stderr: '' });
    await expect(ensureWslSigner(executor)).rejects.toThrow(/invalid executable path/);
  });

  it('preserves cancellation and reports source/build failures', async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'The pinned signer source changed: src/bundle.cpp' }));
    const executor = { distro: 'Ubuntu', run, path: vi.fn() };
    const controller = new AbortController(); controller.abort();
    await expect(ensureWslSigner(executor, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(run).not.toHaveBeenCalled();
    await expect(ensureWslSigner(executor)).rejects.toMatchObject({ details: ['The pinned signer source changed: src/bundle.cpp'] });
  });

  it('keeps the transported installer valid Python and marks its actual capability', () => {
    const result = spawnSync('python', ['-c', 'import sys; compile(sys.stdin.read(),"capmac-signer-setup","exec")'], { input: INSTALL_WSL_SIGNER, encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(INSTALL_WSL_SIGNER).toContain(WSL_SCOPED_SIGNER_MARKER);
  });
});

describe.skipIf(!process.env.CAPMAC_SIGNER_TEST_WSL)('real WSL CMS signing', () => {
  it('signs app and extension with separate XML/DER entitlements, correct profiles, and no framework entitlements', async () => {
    const executor = new WslExecutor(process.env.CAPMAC_SIGNER_TEST_WSL!);
    const signer = await ensureWslSigner(executor);
    const fixture = readFileSync(path.resolve('test/fixtures/wsl-scoped-signing.py'), 'utf8');
    const result = await executor.run(['python3', '-c', fixture, signer], { timeoutMs: 120_000, allowFailure: true });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const proof = JSON.parse(result.stdout) as { main: { xml: Record<string, unknown>; cmsVerified: boolean }; extension: { xml: Record<string, unknown>; cmsVerified: boolean }; framework: { slots: number[]; xml?: Record<string, unknown>; cmsVerified: boolean }; embeddedProfilesMatched: boolean; missingExtensionRejected: boolean };
    expect(proof.main.xml['com.capmac.main-only']).toBe(true);
    expect(proof.extension.xml['com.capmac.extension-only']).toBe(true);
    expect(proof.extension.xml['com.capmac.main-only']).toBeUndefined();
    expect(proof.main.cmsVerified && proof.extension.cmsVerified && proof.framework.cmsVerified).toBe(true);
    expect(proof.framework.xml ?? {}).toEqual({});
    expect(proof.framework.slots).not.toContain(7);
    expect(proof.embeddedProfilesMatched && proof.missingExtensionRejected).toBe(true);
  }, 120_000);
});
