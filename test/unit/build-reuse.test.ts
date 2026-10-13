/**
 * A build is only reused when it carries the project's own Capacitor config:
 * one left over from live reload points at the dev server and shows a blank
 * page once the dev server is gone.
 */
import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bundledConfigMatches } from '../../packages/core/src/agent/ops/build.js';

const work = mkdtempSync(path.join(os.tmpdir(), 'capmac-build-reuse-'));
afterAll(() => fs.rm(work, { recursive: true, force: true }));

async function write(dir: string, config: object): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'capacitor.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

describe('reusing a build', () => {
  const base = { appId: 'dev.capmac.hello', appName: 'Hello', webDir: 'dist' };

  it('reuses it when its config is the project’s', async () => {
    const app = await write(path.join(work, 'a', 'App.app'), base);
    const source = await write(path.join(work, 'a', 'src'), base);
    expect(await bundledConfigMatches(app, source)).toBe(true);
  });

  it('does not when the build still points at the live-reload dev server', async () => {
    const app = await write(path.join(work, 'b', 'App.app'), { ...base, server: { url: 'http://localhost:5173/', cleartext: true } });
    const source = await write(path.join(work, 'b', 'src'), base);
    expect(await bundledConfigMatches(app, source)).toBe(false);
  });

  it('does not when the build has no config at all', async () => {
    const source = await write(path.join(work, 'c', 'src'), base);
    expect(await bundledConfigMatches(path.join(work, 'c', 'missing.app'), source)).toBe(false);
  });
});
