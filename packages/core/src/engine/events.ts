/**
 * What the engine reports. Front ends (the CLI's terminal renderer, capmac
 * Studio's UI) turn these into output; the engine itself never prints.
 */
import type { AppLogKind, AppLogLevel } from '../shared/app-log.js';
import type { ChangeKind } from '../shared/classify.js';
import type { AppDialog, AppDialogClosed } from '../shared/electron.js';
import type { Diagnostic, Target, TargetsResult } from '../shared/protocol.js';
import type { Route } from '../shared/remote.js';
import type { ErrorInfo } from './errors.js';

/** Where a step belongs in the build timeline. */
export type Phase =
  | 'web'
  | 'devserver'
  | 'sync'
  | 'deps'
  /** Electron for the Mac, downloaded once per version. */
  | 'electron'
  | 'cap'
  | 'build'
  | 'boot'
  | 'install'
  | 'launch'
  | 'archive'
  | 'export'
  | 'download'
  | 'other';

export type StepStatus = 'ok' | 'failed' | 'skipped' | 'cancelled';

export type LogLevel = 'debug' | 'note' | 'info' | 'success' | 'warn' | 'error';

/** One line of output from the running app, already classified. */
export interface AppLogEntry {
  kind: AppLogKind;
  level: AppLogLevel;
  text: string;
  stream: 'stdout' | 'stderr';
  /** When the line reached this PC (ms since epoch). */
  ts: number;
  /** Continues the previous console message (multi-line console output). */
  continuation?: boolean;
  /** Where a page's console call came from: a PC path (or a URL), with `:line`. */
  source?: string;
}

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export type FixId = 'install-node' | 'xcode-license' | 'xcode-first-launch' | 'download-ios' | 'install-axe' | 'install-cocoapods' | 'unlock-keychain' | 'build-stream-helper' | 'remote-repair';

/** A one-click fix for a health check. */
export interface FixAction {
  id: FixId;
  label: string;
  /** Shown before running (installs software, needs the Mac password, …). */
  confirm?: string;
}

/** One line of the `doctor` health checklist. */
export interface Check {
  id: string;
  group: 'pc' | 'mac';
  level: CheckLevel;
  label: string;
  detail?: string;
  /** How to fix it, in words. */
  fix?: string;
  /** How to fix it, in one click. */
  action?: FixAction;
}

export type ConnectionState = 'connecting' | 'connected' | 'lost' | 'reconnecting' | 'restored' | 'offline' | 'closed';

export type SessionMode = 'run' | 'live' | 'build' | 'ipa';

export type SessionState = 'starting' | 'building' | 'running' | 'idle' | 'stopping' | 'stopped' | 'failed';

export type EngineEvent =
  /** A step started (sync, `npm install`, xcodebuild, …). */
  | { type: 'step'; id: string; title: string; phase: Phase }
  | { type: 'step-progress'; id: string; text: string; done?: number }
  | { type: 'step-end'; id: string; status: StepStatus; ms: number; detail?: string }
  /** A timeline phase that did not need to run this time. */
  | { type: 'phase-skipped'; phase: Phase; reason: string }
  /** A compiler diagnostic; `file` is the Windows path when it belongs to the project. */
  | { type: 'diagnostic'; diagnostic: Diagnostic }
  | { type: 'app-log'; entry: AppLogEntry }
  | { type: 'log'; level: LogLevel; message: string; hint?: string }
  /** A failure the session recovers from (e.g. a live-reload rebuild that failed). */
  | { type: 'error'; error: ErrorInfo }
  /** Raw tool output (xcodebuild, npm, the web build); front ends show it in verbose mode or a build log. */
  | { type: 'tool-output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'devserver-output'; text: string }
  | { type: 'target'; target: Target }
  | { type: 'devserver'; url: string; external: boolean; command?: string }
  | { type: 'tunnel'; state: 'up' | 'down'; liveUrl?: string; localUrl?: string }
  | { type: 'hmr'; state: 'connected' | 'disconnected' | 'update'; at: number; detail?: string }
  | { type: 'app'; state: 'launching' | 'running' | 'exited' | 'stopped'; name?: string; bundleId?: string; target?: string; exitCode?: number | null }
  /**
   * An Electron app's dialogs waiting for an answer in CapMac (it is in the
   * background on the Mac, so they stay off the Mac's screen). `closed`: one
   * that went, and why.
   */
  | { type: 'app-dialogs'; projectId: string; dialogs: AppDialog[]; closed?: { id: number; how: AppDialogClosed } }
  | { type: 'build-reused'; reason: 'native-unchanged' | 'web-patched' }
  | { type: 'build-log'; path: string }
  | { type: 'native-change'; paths: string[]; kinds: ChangeKind[] }
  /** `route`: how the connection goes (the local network, peer to peer, or the relay), once connected. */
  | { type: 'connection'; mac: string; label: string; state: ConnectionState; attempt?: number; error?: string; latencyMs?: number; route?: Route; rttMs?: number }
  | { type: 'session'; mode: SessionMode; state: SessionState; error?: ErrorInfo; ms?: number }
  | { type: 'check'; check: Check }
  | { type: 'targets'; targets: TargetsResult };

export type EventOf<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;
