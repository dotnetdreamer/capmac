/**
 * Building on this PC, per project: where setup stands (from the engine's
 * `wsl-setup` events and the saved setup), its health check, and the iPhones
 * plugged into this PC.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { Check, Envelope, ErrorInfo, WslDevices, WslSetupPhase, WslStatus } from '../../shared/contract';
import { t, tidy } from '../../shared/i18n';
import { toast, useApp } from './app';
import { call, errorInfo } from './engine';
import { projectKey } from './projects';

/** Setup's steps as the setup screen shows them; each covers one or more of the engine's phases. */
export const SETUP_STEPS = [
  { id: 'tools', phases: ['wsl', 'dependencies'] },
  { id: 'devices', phases: ['apple-devices'] },
  { id: 'signIn', phases: ['apple-sign-in'] },
  { id: 'signing', phases: ['signing'] },
  { id: 'download', phases: ['apple-catalog', 'apple-download'] },
  { id: 'sdk', phases: ['sdk-import'] },
] as const satisfies ReadonlyArray<{ id: string; phases: readonly WslSetupPhase[] }>;
export type SetupStepId = (typeof SETUP_STEPS)[number]['id'];
export type StepState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
/** A step as the setup screen shows it; `fraction`: how far it is, while running, when known. */
export interface StepNow { state: StepState; detail?: string; fraction?: number }

export interface PcEntry {
  status: WslStatus | null;
  /** This session's setup, step by step, as the engine reports it (`fraction`: how far a running one is). */
  phases: Partial<Record<WslSetupPhase, { state: Exclude<StepState, 'waiting'>; detail?: string; fraction?: number }>>;
  bytes: { received: number; total?: number; resumedFrom?: number } | null;
  /** The newest lines setup printed, for its Details. */
  lines: string[];
  running: boolean;
  setupId: string | null;
  error: ErrorInfo | null;
  checks: Check[] | null;
  checking: boolean;
  devices: WslDevices | null;
  dialog: boolean;
}

const empty: PcEntry = { status: null, phases: {}, bytes: null, lines: [], running: false, setupId: null, error: null, checks: null, checking: false, devices: null, dialog: false };
const MAX_LINES = 200;

interface PcState {
  byKey: Record<string, PcEntry>;
  refresh(path: string): Promise<WslStatus | null>;
  startSetup(path: string, appleLogin?: boolean): Promise<void>;
  stopSetup(path: string): Promise<void>;
  check(path: string): Promise<void>;
  listDevices(path: string): Promise<void>;
  showSetup(path: string, open: boolean): void;
  apply(batch: Envelope[]): void;
}

export const usePc = create<PcState>((set, get) => {
  const patch = (path: string, change: Partial<PcEntry> | ((entry: PcEntry) => Partial<PcEntry>)) =>
    set((s) => {
      const key = projectKey(path);
      const current = s.byKey[key] ?? empty;
      return { byKey: { ...s.byKey, [key]: { ...current, ...(typeof change === 'function' ? change(current) : change) } } };
    });
  return {
    byKey: {},
    refresh: async (path) => {
      try {
        const status = await call('wsl.status', { projectPath: path });
        // A setup just asked for has no id yet: it still counts as running.
        patch(path, (entry) => ({ status, running: status.setupId !== null || (entry.running && entry.setupId === null), setupId: status.setupId ?? (entry.running ? entry.setupId : null) }));
        return status;
      } catch (err) {
        patch(path, { error: errorInfo(err) });
        return null;
      }
    },
    startSetup: async (path, appleLogin) => {
      patch(path, { phases: {}, bytes: null, lines: [], error: null, running: true });
      try {
        const { setupId } = await call('wsl.setup', { projectPath: path, appleLogin });
        patch(path, { setupId });
      } catch (err) {
        patch(path, { running: false, error: errorInfo(err) });
      }
    },
    stopSetup: async (path) => {
      const id = get().byKey[projectKey(path)]?.setupId;
      if (id) await call('wsl.stopSetup', { setupId: id }).catch(() => undefined);
    },
    check: async (path) => {
      patch(path, { checking: true });
      try {
        const result = await call('wsl.doctor', { projectPath: path });
        patch(path, { checks: result.checks, checking: false });
      } catch (err) {
        const e = errorInfo(err);
        patch(path, { checking: false, checks: [{ id: 'doctor', group: 'pc', level: 'fail', label: tidy(e.message), fix: tidy(e.hint) }] });
      }
    },
    listDevices: async (path) => {
      try {
        const devices = await call('wsl.devices', { projectPath: path });
        patch(path, { devices });
      } catch (err) {
        patch(path, { devices: { server: 'missing', devices: [], error: errorInfo(err) } });
      }
    },
    showSetup: (path, open) => patch(path, { dialog: open }),
    apply: (batch) => {
      for (const { scope, event } of batch) {
        const path = scope.setup;
        if (!path) continue;
        switch (event.type) {
          case 'wsl-setup':
            if (event.phase === 'complete') break;
            patch(path, (entry) => ({
              phases: { ...entry.phases, [event.phase]: { state: event.state, detail: event.detail, ...(event.fraction !== undefined ? { fraction: event.fraction } : {}) } },
              bytes: event.bytes ?? entry.bytes,
            }));
            break;
          case 'tool-output':
          case 'log': {
            const text = event.type === 'log' ? (event.hint ? `${event.message} → ${event.hint}` : event.message) : event.text;
            const added = text.split(/\r?\n|\r/).map((line) => line.trimEnd()).filter(Boolean);
            if (added.length) patch(path, (entry) => ({ lines: [...entry.lines, ...added].slice(-MAX_LINES) }));
            break;
          }
          case 'setup-ended':
            patch(path, { running: false, setupId: null, error: event.ok || event.cancelled ? null : event.error ?? null });
            void get().refresh(path);
            if (event.ok) toast({ tone: 'success', title: t.pc.setupDone, body: t.pc.setupDoneBody });
            else if (!event.cancelled && event.error) toast({ tone: 'critical', title: t.pc.setupFailed, body: tidy(event.error.message) });
            break;
          default:
            break;
        }
      }
    },
  };
});

export function usePcEntry(path: string | null): PcEntry {
  return usePc((s) => (path ? s.byKey[projectKey(path)] ?? empty : empty));
}

/** Everything a build here needs is in place: the tools, the iPhone SDK, and signing (in an app). */
export function pcReady(status: WslStatus | null | undefined): boolean {
  return Boolean(status && status.tools && status.sdk && (status.signing || !status.inApp));
}

/** Where each step stands: this session's setup when one ran, else what the saved setup shows. */
export function stepStates(entry: PcEntry): Record<SetupStepId, StepNow> {
  const out = {} as Record<SetupStepId, StepNow>;
  const live = Object.keys(entry.phases).length > 0;
  const status = entry.status;
  for (const step of SETUP_STEPS) {
    if (live) {
      const states = step.phases.map((phase) => entry.phases[phase]).filter((item) => item !== undefined);
      const failed = states.find((item) => item.state === 'failed');
      const running = states.find((item) => item.state === 'running');
      const finished = states.length === step.phases.length || states.some((item) => item.state === 'done');
      if (failed) out[step.id] = { state: 'failed', detail: failed.detail };
      else if (running) out[step.id] = running.fraction !== undefined ? { state: 'running', fraction: running.fraction } : { state: 'running' };
      else if (finished && states.every((item) => item.state === 'skipped')) out[step.id] = { state: 'skipped', detail: states.at(-1)?.detail };
      else if (finished) out[step.id] = { state: 'done', detail: states.find((item) => item.state === 'done')?.detail };
      else out[step.id] = { state: 'waiting' };
      continue;
    }
    if (!status) {
      out[step.id] = { state: 'waiting' };
      continue;
    }
    const inPlace: Record<SetupStepId, boolean> = {
      tools: status.tools,
      devices: status.server !== 'missing',
      signIn: status.sdk && (status.signing || !status.inApp),
      signing: status.signing,
      download: status.sdk,
      sdk: status.sdk,
    };
    const stopped = status.status && status.status.state !== 'complete' && (step.phases as readonly string[]).includes(status.status.phase);
    if (stopped && !entry.running) out[step.id] = { state: 'failed', detail: status.status!.message };
    else if (step.id === 'signing' && !status.inApp) out[step.id] = { state: 'skipped' };
    else out[step.id] = { state: inPlace[step.id] ? 'done' : 'waiting' };
  }
  return out;
}

/** Keeps a project's PC status, and (while `devices`) its list of plugged-in iPhones, fresh while shown. */
export function usePcWatch(path: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const pc = usePc.getState();
    void pc.refresh(path);
    void pc.listDevices(path);
    const timer = window.setInterval(() => {
      // Nobody is looking: don't ask Windows for iPhones.
      if (document.visibilityState === 'hidden' || useApp.getState().route.name !== 'project') return;
      void usePc.getState().listDevices(path);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [path, enabled]);
}
