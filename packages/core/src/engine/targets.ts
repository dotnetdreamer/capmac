import type { Target, TargetsResult } from '../shared/protocol.js';
import { UserError } from './errors.js';

export interface TargetQuery {
  /** Name, UDID or partial name; undefined = automatic. */
  wanted?: string;
  /** Prefer a physical device. */
  device?: boolean;
  /** Prefer a simulator (default). */
  simulator?: boolean;
  /** UDID used last time for this project. */
  last?: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Chooses where to run: an explicit name/UDID, else the last target used,
 * else a connected device (when --device), else a booted simulator, else the
 * newest iPhone simulator.
 */
export function chooseTarget(all: TargetsResult, query: TargetQuery): Target {
  const sims = all.simulators.filter((t) => t.available);
  const devices = all.devices.filter((t) => t.available);
  const pool = query.device ? devices : query.simulator ? sims : [...sims, ...devices];

  if (query.wanted) {
    const w = normalize(query.wanted);
    const byUdid = [...all.simulators, ...all.devices].find((t) => t.udid.toLowerCase() === w);
    if (byUdid) return byUdid;
    // "iPhone 16 Pro" or "iPhone 16 Pro (18.2)" / "iPhone 16 Pro 18.2"
    const versioned = w.match(/^(.*?)[\s(]+(\d+(?:\.\d+)*)\)?$/);
    const candidates = pool.length ? pool : [...sims, ...devices];
    const exact = candidates.filter((t) => normalize(t.name) === w);
    if (exact.length) return exact[0]!;
    if (versioned) {
      const named = candidates.filter((t) => normalize(t.name) === versioned[1] && t.osVersion.startsWith(versioned[2]!));
      if (named.length) return named[0]!;
    }
    const partial = candidates.filter((t) => normalize(t.name).includes(w));
    if (partial.length) return partial[0]!;
    throw new UserError(`No simulator or device matches "${query.wanted}".`, 'Run `capmac targets` to see what is available.');
  }

  if (query.last) {
    const last = pool.find((t) => t.udid === query.last);
    if (last) return last;
  }
  if (query.device) {
    const connected = devices.find((t) => t.state === 'connected') ?? devices[0];
    if (connected) return connected;
    if (!all.deviceSupport) throw new UserError('This Xcode cannot install on devices from the command line.', 'Update Xcode on the Mac to 15 or newer.');
    throw new UserError('No iPhone or iPad is available.', 'Connect it to the Mac with a cable (or pair it over Wi-Fi in Xcode › Window › Devices), unlock it, and enable Developer Mode.');
  }
  const booted = sims.find((t) => t.state === 'Booted' && /iPhone/.test(t.name));
  if (booted) return booted;
  const iphone = sims.find((t) => /^iPhone \d+$/.test(t.name)) ?? sims.find((t) => /iPhone/.test(t.name)) ?? sims[0];
  if (iphone) return iphone;
  throw new UserError('No iOS simulators are installed on the Mac.', 'Install one on the Mac: `xcodebuild -downloadPlatform iOS` (or Xcode › Settings › Components).');
}

export function describeTarget(t: Target): string {
  if (t.kind === 'mac') return `${t.name} (${t.os})`;
  const where = t.kind === 'simulator' ? 'Simulator' : t.connection === 'network' ? 'Wi-Fi' : 'USB';
  return `${t.name} (${t.os}, ${where})`;
}
