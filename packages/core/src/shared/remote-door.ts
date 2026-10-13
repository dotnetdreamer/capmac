/**
 * The door on the Mac (remote access): its files under ~/.capmac/remote and
 * the agent operations that install and manage it. No Node.js APIs here.
 */
import type { PublicKey } from './remote.js';

/** The LaunchAgent that runs the door. */
export const DOOR_LABEL = 'dev.capmac.remote';

/** A PC that may reach the Mac over the internet. */
export interface RemotePc {
  key: PublicKey;
  /** The PC's name when it was added ("IK-DESKTOP"). */
  name: string;
  addedAt: string;
}

/** ~/.capmac/remote/config.json: written by the agent, read by the door at start. */
export interface DoorConfig {
  version: 1;
  signalUrl: string;
  sshPort: number;
  keepAwake: boolean;
  keyFile: string;
  allowedFile: string;
  statusFile: string;
  logFile: string;
  /** Where node-datachannel is installed (its node_modules is inside). */
  runtimeDir: string;
}

export type DoorState = 'connecting' | 'online' | 'offline' | 'error' | 'stopped';

/** ~/.capmac/remote/status.json: written by the door as things change. */
export interface DoorStatusFile {
  state: DoorState;
  since: string;
  pid: number;
  version: string;
  error: string | null;
  sessions: number;
  /** The signaling server it is connected to. */
  server: string | null;
  node: string;
}

/** Agent op `remote-install`: installs (or updates) the door and lets a PC in. */
export interface RemoteInstallParams {
  signalUrl: string;
  sshPort: number;
  pc: { key: PublicKey; name: string };
  keepAwake?: boolean;
}

/** Agent op `remote-set`: changes the door's settings (and restarts it). */
export interface RemoteSetParams {
  keepAwake?: boolean;
  signalUrl?: string;
}

/** The door, as the agent op `remote-status` reports it. */
export interface RemoteDoorStatus {
  installed: boolean;
  /** The Mac's identity for remote access. */
  macKey: PublicKey | null;
  /** Hash of the installed door, and whether it is the one this agent ships. */
  doorHash: string | null;
  current: boolean;
  /** The LaunchAgent is loaded, and the pid it runs. */
  loaded: boolean;
  pid: number | null;
  /** What the door last wrote about itself. */
  status: DoorStatusFile | null;
  signalUrl: string | null;
  keepAwake: boolean;
  sshPort: number | null;
  pcs: RemotePc[];
  /** node-datachannel's version in the door's runtime, when installed. */
  runtime: string | null;
  /** The Node.js the door runs with. */
  node: string;
}
