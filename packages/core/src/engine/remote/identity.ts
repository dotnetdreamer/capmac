/**
 * This PC's identity for remote access: an Ed25519 key in
 * %USERPROFILE%\.capmac\remote_ed25519, created on first use. The door on a
 * Mac lets in only the PCs whose public keys it was given at pairing.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentity, loadIdentity, type Identity } from '../../shared/remote-keys.js';
import { capmacDir } from '../config.js';

let cached: Promise<Identity> | null = null;

export function pcIdentityFile(): string {
  return path.join(capmacDir(), 'remote_ed25519');
}

/** This PC's identity (created and stored the first time). */
export function pcIdentity(): Promise<Identity> {
  cached ??= (async () => {
    const file = pcIdentityFile();
    try {
      return loadIdentity(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error(`CapMac's remote-access key (${file}) is unreadable: ${(err as Error).message}. Delete it and turn remote access on again.`);
    }
    const { pem, identity } = generateIdentity();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, pem, { mode: 0o600, flag: 'wx' }).catch(async (err: NodeJS.ErrnoException) => {
      // Another CapMac process created it first: use that one.
      if (err.code !== 'EEXIST') throw err;
    });
    return loadIdentity(await fs.readFile(file, 'utf8'));
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

/** How this PC appears in a Mac's list of PCs that can reach it. */
export function pcName(): string {
  return os.hostname().slice(0, 64) || 'Windows PC';
}

/** Forgets the cached identity (tests). */
export function resetPcIdentityCache(): void {
  cached = null;
}
