/** Where setting up builds on this PC stands (see engine/wsl/setup.ts): shared with CapMac Studio's renderer. */
import type { WslSetupPhase } from '../engine/events.js';

/** Where the last setup got to, as `.capmac/wsl/setup-status.json` records it (no account data is in it). */
export interface WslSetupStatus {
  phase: WslSetupPhase | 'complete';
  state: 'running' | 'failed' | 'complete';
  updatedAt: string;
  message?: string;
}

/** What setup has put in place for a project, from its saved settings and files. */
export interface WslSetupState {
  status: WslSetupStatus | null;
  /** The WSL build environment and its compilers. */
  tools: boolean;
  /** The iPhone SDK, from the Xcode release paired with CapMac's Swift. */
  sdk: boolean;
  /** Signing files for the app and its extensions. */
  signing: boolean;
  /** A Capacitor app is here (signing is set up per app). */
  inApp: boolean;
  /** An Xcode download that stopped: the next setup continues from here. */
  partialDownload: { bytes: number } | null;
}
