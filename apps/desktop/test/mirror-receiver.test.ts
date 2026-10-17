import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RECEIVER_VERSION } from '@capmac/core/engine/iphone/receiver';
// @ts-expect-error: a build script without type declarations
import { findMirrorReceiver, RECEIVER_FILES, receiverProblem, receiverVersion, stageMirrorReceiver } from '../scripts/mirror-receiver.mjs';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** A receiver folder as build.sh makes it (empty files, the real layout). */
function receiver(at: string, version = RECEIVER_VERSION): string {
  for (const file of RECEIVER_FILES as string[]) {
    mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
    writeFileSync(path.join(at, file), '');
  }
  writeFileSync(path.join(at, 'SOURCES.txt'), `CapMac screen-mirroring receiver ${version}\n\nuxplay.exe is UxPlay (GPL-3.0)\n`);
  return at;
}

describe('the screen receiver in Studio’s installer', () => {
  it('is the version the engine runs', () => {
    expect(receiverVersion()).toBe(RECEIVER_VERSION);
  });

  it('comes from CAPMAC_MIRROR_RECEIVER, else from the copy set up on this PC', () => {
    expect(findMirrorReceiver({ CAPMAC_MIRROR_RECEIVER: 'C:\\ci\\receiver', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, '1.74-4e95a9e-1')).toBe(path.resolve('C:\\ci\\receiver'));
    expect(findMirrorReceiver({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, '1.74-4e95a9e-1')).toBe(path.join('C:\\Users\\me\\AppData\\Local', 'CapMac', 'mirror-receiver', '1.74-4e95a9e-1'));
  });

  it('is only a complete build.sh folder of that version', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-receiver-'));
    expect(receiverProblem(path.join(dir, 'none'), RECEIVER_VERSION)).toMatch(/no screen receiver/);
    const good = receiver(path.join(dir, 'good'));
    expect(receiverProblem(good, RECEIVER_VERSION)).toBeNull();
    const old = receiver(path.join(dir, 'old'), '1.74-4e95a9e-0');
    expect(receiverProblem(old, RECEIVER_VERSION)).toMatch(/not build\.sh's/);
    rmSync(path.join(good, 'licenses', 'uxplay', 'LICENSE'));
    expect(receiverProblem(good, RECEIVER_VERSION)).toMatch(/missing licenses\/uxplay\/LICENSE/);
  });

  it('is copied into out/ with its licenses, or the build stops and says how to make one', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-receiver-'));
    const built = receiver(path.join(dir, 'receiver'));
    const dest = path.join(dir, 'out', 'mirror-receiver');
    const staged = await stageMirrorReceiver(dest, { CAPMAC_MIRROR_RECEIVER: built });
    expect(staged).toEqual({ dir: built, version: RECEIVER_VERSION });
    expect(existsSync(path.join(dest, 'bin', 'uxplay.exe'))).toBe(true);
    expect(readFileSync(path.join(dest, 'SOURCES.txt'), 'utf8')).toMatch(/UxPlay \(GPL-3\.0\)/);
    await expect(stageMirrorReceiver(dest, { CAPMAC_MIRROR_RECEIVER: path.join(dir, 'none') })).rejects.toThrow(/build\.sh in an MSYS2 UCRT64 shell/);
  });
});
