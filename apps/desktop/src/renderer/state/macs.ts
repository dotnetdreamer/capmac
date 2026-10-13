import { useEffect } from 'react';
import { create } from 'zustand';
import type { Check, ConnectionState, ErrorInfo, MacSummary, ProbeResult, Route, TargetsResult } from '../../shared/contract';
import { call, errorInfo } from './engine';

export interface HealthState {
  status: 'checking' | 'done' | 'error';
  checks: Check[];
  probe: ProbeResult | null;
  latencyMs: number | null;
  error?: ErrorInfo;
  at: number;
}

export interface PairStep {
  id: string;
  title: string;
  status: 'running' | 'ok' | 'failed' | 'skipped' | 'cancelled';
  detail?: string;
}

interface MacsState {
  macs: MacSummary[];
  loaded: boolean;
  health: Record<string, HealthState>;
  pairing: PairStep[];
  refresh(): Promise<void>;
  setConnection(name: string, state: ConnectionState, extra: { attempt?: number; error?: string; latencyMs?: number; label?: string; route?: Route; rttMs?: number }): void;
  runHealth(name: string, projectPath?: string): Promise<void>;
  applyCheck(name: string, check: Check): void;
  /** Puts a fresh check in place of its row in the last health result (remote access, after a change). */
  refreshCheck(name: string, check: Check): void;
}

export const useMacs = create<MacsState>((set, get) => ({
  macs: [],
  loaded: false,
  health: {},
  pairing: [],
  refresh: async () => {
    try {
      const macs = await call('macs.list', {});
      set({ macs, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  setConnection: (name, state, extra) =>
    set((s) => ({
      macs: s.macs.map((m) =>
        m.name === name
          ? {
              ...m,
              state,
              label: extra.label && extra.label !== 'the Mac' ? extra.label : m.label,
              latencyMs: extra.latencyMs ?? m.latencyMs,
              error: state === 'connected' || state === 'restored' ? null : extra.error ?? m.error,
              route: state === 'connected' || state === 'restored' ? extra.route ?? m.route : null,
              rttMs: state === 'connected' || state === 'restored' ? extra.rttMs ?? m.rttMs : null,
            }
          : m,
      ),
    })),
  runHealth: async (name, projectPath) => {
    set((s) => ({ health: { ...s.health, [name]: { status: 'checking', checks: [], probe: null, latencyMs: null, at: Date.now() } } }));
    try {
      const report = await call('macs.health', { name, projectPath });
      set((s) => ({ health: { ...s.health, [name]: { status: 'done', checks: report.checks, probe: report.probe, latencyMs: report.latencyMs, at: Date.now() } } }));
    } catch (err) {
      set((s) => ({ health: { ...s.health, [name]: { ...(s.health[name] ?? { checks: [], probe: null, latencyMs: null }), status: 'error', error: errorInfo(err), at: Date.now() } } }));
    }
    void get().refresh();
  },
  applyCheck: (name, check) =>
    set((s) => {
      const current = s.health[name];
      if (!current || current.status !== 'checking') return s;
      const checks = current.checks.some((c) => c.id === check.id) ? current.checks.map((c) => (c.id === check.id ? check : c)) : [...current.checks, check];
      return { health: { ...s.health, [name]: { ...current, checks } } };
    }),
  refreshCheck: (name, check) =>
    set((s) => {
      const current = s.health[name];
      if (!current || current.status !== 'done' || !current.checks.some((c) => c.id === check.id)) return s;
      return { health: { ...s.health, [name]: { ...current, checks: current.checks.map((c) => (c.id === check.id ? check : c)) } } };
    }),
}));

/** The Mac a project builds on: its pick in the toolbar, capmac.json's host, or the default Mac. */
export function resolveMac(macs: MacSummary[], preferred?: string | null): MacSummary | null {
  return (preferred ? macs.find((m) => m.name === preferred) : undefined) ?? macs.find((m) => m.isDefault) ?? (macs.length === 1 ? macs[0]! : null);
}

// ─── Targets (simulators & devices), kept live while someone looks ───────

interface TargetsState {
  byMac: Record<string, { targets: TargetsResult | null; error?: ErrorInfo; at: number }>;
  set(mac: string, targets: TargetsResult): void;
  fail(mac: string, error: ErrorInfo): void;
}

export const useTargets = create<TargetsState>((set) => ({
  byMac: {},
  set: (mac, targets) => set((s) => ({ byMac: { ...s.byMac, [mac]: { targets, at: Date.now() } } })),
  fail: (mac, error) => set((s) => ({ byMac: { ...s.byMac, [mac]: { targets: s.byMac[mac]?.targets ?? null, error, at: Date.now() } } })),
}));

/** Subscribes to a Mac's simulators and devices for as long as the component is mounted. */
export function useWatchTargets(mac: string | null | undefined): void {
  useEffect(() => {
    if (!mac) return;
    let watchId: string | null = null;
    let cancelled = false;
    call('targets.watch', { mac }).then(
      (r) => {
        if (cancelled) {
          void call('targets.unwatch', { watchId: r.watchId }).catch(() => undefined);
          return;
        }
        watchId = r.watchId;
        if (r.targets) useTargets.getState().set(mac, r.targets);
      },
      (err) => useTargets.getState().fail(mac, errorInfo(err)),
    );
    return () => {
      cancelled = true;
      if (watchId) void call('targets.unwatch', { watchId }).catch(() => undefined);
    };
  }, [mac]);
}
