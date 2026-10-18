/**
 * The screen-mirroring receiver (UxPlay, GPL-3.0) for iPhones at this PC: the Windows .vsix ships it
 * in dist/mirror-receiver, as CapMac Studio's installer does. It runs from CapMac's own folder
 * (%LOCALAPPDATA%\CapMac\mirror-receiver\<version>, where the engine looks when no installer told it
 * where one is), copied there once: Windows Firewall asks about each new path of uxplay.exe, and
 * the extension's own folder changes with every update.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** RECEIVER_VERSION in core's receiver.ts, read when the extension is built (scripts/build.mjs). */
declare const __CAPMAC_RECEIVER_VERSION__: string | undefined;
export const RECEIVER_VERSION = typeof __CAPMAC_RECEIVER_VERSION__ === 'string' ? __CAPMAC_RECEIVER_VERSION__ : null;

/** A receiver folder the engine can start (core's receiverInstalled). */
export function receiverInstalled(dir: string): boolean {
  return existsSync(path.join(dir, 'bin', 'uxplay.exe')) && existsSync(path.join(dir, 'lib', 'gstreamer-1.0', 'libgstrtp.dll'));
}

/** Where the engine looks for this version when no installer said (core's receiverHome). */
export function localReceiverDir(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'CapMac', 'mirror-receiver', version);
}

/**
 * Copies the shipped receiver to CapMac's own folder, unless one is there already (copied before,
 * or set up by hand). Another VS Code window may be copying it at the same time: each copies to a
 * folder of its own, and the first to finish wins.
 */
export async function placeReceiver(shipped: string, version: string | null = RECEIVER_VERSION, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!version || !receiverInstalled(shipped)) return;
  const dest = localReceiverDir(version, env);
  if (receiverInstalled(dest)) return;
  const staging = `${dest}.copy-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.cp(shipped, staging, { recursive: true });
    // A folder left half-copied by a VS Code that was closed meanwhile.
    if (existsSync(dest) && !receiverInstalled(dest)) await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(staging, dest).catch((error: unknown) => {
      if (!receiverInstalled(dest)) throw error;
    });
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The receiver folder the engine is told about (HostInit.mirrorReceiverDir): none while CapMac's own
 * copy is there (the engine finds it), else the shipped one, so mirroring works even when it could
 * not be copied.
 */
export function receiverForEngine(shipped: string, version: string | null = RECEIVER_VERSION, env: NodeJS.ProcessEnv = process.env): string | null {
  if (version && receiverInstalled(localReceiverDir(version, env))) return null;
  return receiverInstalled(shipped) ? shipped : null;
}
