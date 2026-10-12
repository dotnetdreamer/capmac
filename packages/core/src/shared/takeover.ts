// Names shared by the takeover preload and the engine. Dependency-free: the
// preload bundles this into a file that runs inside every Node.js process.

/** Written next to capmac's config while takeover is on: which capmac to run. */
export const STATE_FILE = 'takeover.json';
/** The preload, copied next to capmac's config so it outlives capmac upgrades. */
export const PRELOAD_FILE = 'takeover.cjs';

export interface TakeoverState {
  /** capmac's CLI entry, run with the Node.js that runs Capacitor. */
  cli: string;
  version?: string;
}

export interface TakeoverStatus {
  /** Set up: capmac is there to run, and (on Windows) new terminals load the preload. */
  on: boolean;
  /** What the user chose last; undefined means the default, which is on. */
  choice?: 'on' | 'off';
  /** The capmac that runs taken-over commands. */
  cli?: string;
  cliMissing: boolean;
  /** The Windows user's NODE_OPTIONS loads the preload; null where capmac cannot set it (not Windows). */
  userEnv: boolean | null;
  /** This process was started with the preload (so this terminal is taken over). */
  thisProcess: boolean;
}
