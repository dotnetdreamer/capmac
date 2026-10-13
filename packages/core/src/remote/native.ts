/**
 * node-datachannel (libdatachannel): WebRTC for Node.js, loaded only when
 * remote access is used. It is a native module, so it is never bundled:
 * - the CLI gets it from npm (an optional dependency);
 * - CapMac Studio ships it next to the app (resources/remote) and says where;
 * - the door on the Mac loads it from ~/.capmac/remote/runtime.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteError } from './errors.js';

export type NodeDataChannel = typeof import('node-datachannel');
export type PeerConnection = InstanceType<NodeDataChannel['PeerConnection']>;
export type DataChannel = ReturnType<PeerConnection['createDataChannel']>;

let preferredDir: string | null = null;
let loaded: NodeDataChannel | null = null;

/** A folder whose node_modules holds node-datachannel (CapMac Studio's resources/remote). */
export function setNodeDataChannelDir(dir: string | null): void {
  preferredDir = dir;
  loaded = null;
}

function thisFile(): string | null {
  if (typeof __filename === 'string') return __filename;
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
}

let users = 0;
let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * node-datachannel for one peer connection. Call `release` when that
 * connection is closed: once none are left, its threads stop, so a CLI
 * command can exit (they start again with the next connection).
 */
export function acquireNodeDataChannel(): { ndc: NodeDataChannel; release: () => void } {
  const ndc = loadNodeDataChannel();
  users += 1;
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = null;
  let released = false;
  return {
    ndc,
    release: () => {
      if (released) return;
      released = true;
      users -= 1;
      if (users > 0) return;
      cleanupTimer = setTimeout(() => {
        cleanupTimer = null;
        if (users === 0) {
          try {
            ndc.cleanup();
          } catch {
            // nothing to clean up
          }
        }
      }, 1000);
      cleanupTimer.unref?.();
    },
  };
}

/** Loads node-datachannel, or throws a RemoteError that says how to get it. */
export function loadNodeDataChannel(): NodeDataChannel {
  if (loaded) return loaded;
  const file = thisFile();
  const bases = [
    preferredDir,
    process.env.CAPMAC_NDC_DIR,
    // CapMac Studio's copy of the CLI (resources/cli) finds the module in resources/remote.
    file ? path.join(path.dirname(file), '..', 'remote') : null,
    file ? path.dirname(file) : null,
    process.cwd(),
  ].filter((b): b is string => Boolean(b));
  const problems: string[] = [];
  for (const base of bases) {
    try {
      loaded = createRequire(path.join(base, 'noop.js'))('node-datachannel') as NodeDataChannel;
      return loaded;
    } catch (err) {
      const message = (err as Error).message.split('\n')[0] ?? String(err);
      if (!problems.includes(message)) problems.push(message);
    }
  }
  throw new RemoteError(
    'CapMac’s WebRTC module (node-datachannel) is missing, so it cannot reach the Mac over the internet.',
    'Reinstall CapMac (`npm install -g capmac` installs it with the CLI). Connections on the local network still work.',
    'NO_WEBRTC',
    problems.slice(0, 3),
  );
}
