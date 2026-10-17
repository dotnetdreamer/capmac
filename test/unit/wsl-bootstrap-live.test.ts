import { describe, expect, it } from 'vitest';
import { bootstrapWslDependencies, INSTALL_WSL_DEPENDENCIES } from '../../packages/core/src/engine/wsl/bootstrap.js';
import { inspectWslDeviceTools } from '../../packages/core/src/engine/wsl/device.js';
import { WslExecutor } from '../../packages/core/src/engine/wsl/toolchain.js';

describe.skipIf(!process.env.CAPMAC_BOOTSTRAP_TEST_WSL)('managed Linux dependency installation', () => {
  it('reuses the actual Swift installation and completes a second setup without package changes', async () => {
    const executor = new WslExecutor(process.env.CAPMAC_BOOTSTRAP_TEST_WSL!);
    const first = await executor.run(['python3', '-c', INSTALL_WSL_DEPENDENCIES, ''], { timeoutMs: 1_800_000, allowFailure: true });
    expect(first.code, first.stderr || first.stdout).toBe(0);
    const patch = JSON.parse(first.stdout) as Record<string, string>;
    for (const value of Object.values(patch)) expect(value).toMatch(/^\//);
    expect(patch.swift).toContain('swift-6.2.3-RELEASE');
    const second = await executor.run(['python3', '-c', INSTALL_WSL_DEPENDENCIES, ''], { timeoutMs: 120_000, allowFailure: true });
    expect(second.code, second.stderr || second.stdout).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual(patch);
    expect(second.stderr).not.toMatch(/Downloading|apt-get|Preparing gem/);
  }, 1_800_000);
});

describe.skipIf(!process.env.CAPMAC_BOOTSTRAP_FULL_TEST_WSL)('managed complete tool installation', () => {
  it('prepares the actual resource compilers, scoped signer, and private host iPhone environment', async () => {
    const executor = new WslExecutor(process.env.CAPMAC_BOOTSTRAP_FULL_TEST_WSL!);
    const patch = await bootstrapWslDependencies(executor);
    const checked = await executor.run(['python3', '-c', 'import os,sys; assert all(os.path.isfile(x) and os.access(x,os.X_OK) for x in sys.argv[1:])', patch.signer, patch.actool, patch.ibtool, patch.momc, patch.xcstrings]);
    expect(checked.code).toBe(0);
    expect((await inspectWslDeviceTools({ python: patch.python })).ready).toBe(true);
    expect(await bootstrapWslDependencies(executor)).toEqual(patch);
  }, 1_800_000);
});
