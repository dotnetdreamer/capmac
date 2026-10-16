import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureHostDeviceTools, privatePythonPath } from '../../packages/core/src/engine/wsl/bootstrap.js';

afterEach(() => { vi.unstubAllEnvs(); });

// Downloads python.org's Python (about 15 MB) and the iPhone tools (about 100 MB) into a temporary folder.
describe.skipIf(process.platform !== 'win32' || !process.env.CAPMAC_PRIVATE_PYTHON_TEST)('CapMac’s own Python, for real', () => {
  it('downloads and checks python.org’s Python, installs the iPhone tools in it, and reuses it', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'capmac-python-'));
    vi.stubEnv('LOCALAPPDATA', base);
    try {
      const python = await ensureHostDeviceTools();
      expect(python).toBe(privatePythonPath());
      // Isolated from the PC's own Python settings, as CapMac runs it.
      const version = spawnSync(python, ['-I', '-c', 'import importlib.metadata as m; print(m.version("pymobiledevice3"))'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONHOME: 'C:\\nowhere' } });
      expect(version.stdout.trim()).toBe('11.32.0');
      const started = Date.now();
      await expect(ensureHostDeviceTools()).resolves.toBe(python);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(await readdir(path.join(base, 'CapMac', 'device-tools'))).toEqual([path.basename(path.dirname(python))]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 900_000);
});
