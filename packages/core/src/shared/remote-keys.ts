/**
 * Ed25519 identities for remote access: the PC's, the door's on the Mac, and
 * what the signaling server checks. Node.js only (the engine, the door, the
 * server); the renderer never handles keys.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { isPublicKey, isSignature, type PublicKey } from './remote.js';

export interface Identity {
  privateKey: KeyObject;
  publicKey: PublicKey;
}

/** A new identity, with its private key as PKCS#8 PEM (to store with user-only permissions). */
export function generateIdentity(): { pem: string; identity: Identity } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { pem, identity: { privateKey, publicKey: publicKeyOf(privateKey) } };
}

/** Reads a stored identity. Throws when the PEM is not an Ed25519 private key. */
export function loadIdentity(pem: string): Identity {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Not an Ed25519 private key.');
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

export function publicKeyOf(privateKey: KeyObject): PublicKey {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Could not read the public key.');
  return jwk.x;
}

export function signText(identity: Identity, text: string): string {
  return sign(null, Buffer.from(text, 'utf8'), identity.privateKey).toString('base64url');
}

/** True when `sig` is `key`'s signature over `text`. Never throws. */
export function verifyText(key: PublicKey, text: string, sig: string): boolean {
  if (!isPublicKey(key) || !isSignature(sig)) return false;
  try {
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
    return verify(null, Buffer.from(text, 'utf8'), publicKey, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

/** A random id (sessions, nonces): `bytes` random bytes, base64url. */
export function randomId(bytes = 18): string {
  return randomBytes(bytes).toString('base64url');
}
