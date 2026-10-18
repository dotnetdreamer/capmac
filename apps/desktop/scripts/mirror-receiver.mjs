// The screen-mirroring receiver (UxPlay, GPL-3.0) that Studio's installer ships in
// resources/mirror-receiver, with its licenses/ and SOURCES.txt. dist.mjs copies it into
// out/mirror-receiver before electron-builder runs. It is the folder packages/core/receiver/build.sh
// makes: CAPMAC_MIRROR_RECEIVER when set (CI builds it), else the copy set up on this PC
// (%LOCALAPPDATA%\CapMac\mirror-receiver\<version>, where the engine looks in development).
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoDir } from './config.mjs';

/** The files every receiver folder has: the exe, the four plugins its forwarding path loads, UxPlay's license and patch. */
export const RECEIVER_FILES = [
  'bin/uxplay.exe',
  'lib/gstreamer-1.0/libgstcoreelements.dll',
  'lib/gstreamer-1.0/libgstapp.dll',
  'lib/gstreamer-1.0/libgstrtp.dll',
  'lib/gstreamer-1.0/libgstudp.dll',
  'licenses/uxplay/LICENSE',
  'licenses/uxplay/capmac-uxplay.patch',
  'SOURCES.txt',
];

/** RECEIVER_VERSION in core's receiver.ts: the engine and the folder have to agree. */
export function receiverVersion() {
  const source = readFileSync(path.join(repoDir, 'packages', 'core', 'src', 'engine', 'iphone', 'receiver.ts'), 'utf8');
  const version = /export const RECEIVER_VERSION = '([^']+)'/.exec(source)?.[1];
  if (!version) throw new Error('RECEIVER_VERSION is missing from packages/core/src/engine/iphone/receiver.ts.');
  return version;
}

/** Where the receiver to ship is. */
export function findMirrorReceiver(env, version) {
  if (env.CAPMAC_MIRROR_RECEIVER) return path.resolve(env.CAPMAC_MIRROR_RECEIVER);
  const base = env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'CapMac', 'mirror-receiver', version);
}

/** Why this folder can't be shipped, or null. build.sh writes the version on SOURCES.txt's first line. */
export function receiverProblem(dir, version) {
  if (!existsSync(dir)) return `There is no screen receiver at ${dir}.`;
  const missing = RECEIVER_FILES.filter((file) => !existsSync(path.join(dir, file)));
  if (missing.length) return `The screen receiver at ${dir} is missing ${missing.join(', ')}.`;
  const built = readFileSync(path.join(dir, 'SOURCES.txt'), 'utf8').split(/\r?\n/)[0]?.trim();
  if (built !== `CapMac screen-mirroring receiver ${version}`) return `The screen receiver at ${dir} is not build.sh's ${version} (its SOURCES.txt starts with "${built}").`;
  return null;
}

/** Copies the receiver to `dest`, or throws with what to do. */
export async function stageMirrorReceiver(dest, env = process.env) {
  const version = receiverVersion();
  const dir = findMirrorReceiver(env, version);
  const problem = receiverProblem(dir, version);
  if (problem) {
    throw new Error(`${problem} Build it with packages/core/receiver/build.sh in an MSYS2 UCRT64 shell, then set CAPMAC_MIRROR_RECEIVER to the receiver folder it makes.`);
  }
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(dir, dest, { recursive: true });
  return { dir, version };
}
