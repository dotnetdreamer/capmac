/**
 * Remote access ("Reach this Mac from anywhere") in CapMac Studio: the
 * signaling server setting, each Mac's status, and the actions, with the same
 * options and defaults as `capmac remote` (both use the engine's remote API).
 */
import { create } from 'zustand';
import type { ErrorInfo, MacSummary, RelayChoice, RemoteStatusReport, RemoteTestResult, RouteChoice, SignalServerSetting } from '../../shared/contract';
import { t, tidy } from '../../shared/i18n';
import { toast } from './app';
import { call, errorInfo } from './engine';
import { useMacs } from './macs';

interface RemoteState {
  server: SignalServerSetting | null;
  reports: Record<string, { status: 'loading' | 'done' | 'error'; report?: RemoteStatusReport; error?: ErrorInfo; at: number }>;
  loadServer(): Promise<SignalServerSetting | null>;
  setServer(url: string | null): Promise<SignalServerSetting>;
  loadReport(name: string): Promise<void>;
}

export const useRemote = create<RemoteState>((set, get) => ({
  server: null,
  reports: {},
  loadServer: async () => {
    try {
      const server = await call('remote.server', {});
      set({ server });
      return server;
    } catch {
      return get().server;
    }
  },
  setServer: async (url) => {
    const server = await call('remote.setServer', { url });
    set({ server });
    return server;
  },
  loadReport: async (name) => {
    set((s) => ({ reports: { ...s.reports, [name]: { ...s.reports[name], status: 'loading', at: Date.now() } } }));
    try {
      const report = await call('macs.remote.status', { name });
      set((s) => ({ reports: { ...s.reports, [name]: { status: 'done', report, at: Date.now() } } }));
      useMacs.getState().refreshCheck(name, report.check);
    } catch (err) {
      set((s) => ({ reports: { ...s.reports, [name]: { ...s.reports[name], status: 'error', error: errorInfo(err), at: Date.now() } } }));
    }
  },
}));

function replaceMac(mac: MacSummary): void {
  useMacs.setState((s) => ({ macs: s.macs.map((m) => (m.name === mac.name ? { ...m, ...mac, state: m.state === 'idle' ? mac.state : m.state } : m)) }));
}

/** An error's message and hint, as one line for a toast. */
function joined(e: ErrorInfo): string {
  return e.hint ? `${tidy(e.message)}. ${tidy(e.hint)}` : tidy(e.message);
}

function testText(test: RemoteTestResult | null): string | undefined {
  if (!test) return undefined;
  return test.ok && test.route ? t.remote.toast.testPassed(test.route, test.ms) : t.remote.toast.testNotYet(tidy(test.error) ?? '');
}

/** Turns remote access on. The caller makes sure a signaling server is set. */
export async function turnOn(mac: MacSummary, options: { keepAwake?: boolean } = {}): Promise<boolean> {
  try {
    const result = await call('macs.remote.enable', { name: mac.name, keepAwake: options.keepAwake });
    replaceMac(result.mac);
    toast({ tone: result.test?.ok === false ? 'caution' : 'success', title: t.remote.toast.on(mac.label), body: testText(result.test) });
    void useRemote.getState().loadReport(mac.name);
    return true;
  } catch (err) {
    const e = errorInfo(err);
    if (!e.cancelled) toast({ tone: 'critical', title: t.remote.toast.onFailed, body: joined(e), timeout: 0 });
    return false;
  }
}

/** Turns remote access off; `localOnly` when the Mac cannot be reached. */
export async function turnOff(mac: MacSummary, localOnly = false): Promise<'ok' | 'unreachable' | 'failed'> {
  try {
    const result = await call('macs.remote.disable', { name: mac.name, localOnly });
    replaceMac(result.mac);
    useMacs.getState().refreshCheck(mac.name, result.check);
    toast({ tone: 'info', title: t.remote.toast.off(mac.label), body: localOnly ? t.remote.toast.offHereOnly : t.remote.toast.offBody });
    return 'ok';
  } catch (err) {
    const e = errorInfo(err);
    if (e.cancelled) return 'failed';
    if (!localOnly && /reach|offline|connect/i.test(e.message)) return 'unreachable';
    toast({ tone: 'critical', title: t.remote.toast.offFailed, body: tidy(e.message) });
    return 'failed';
  }
}

export async function setOptions(mac: MacSummary, patch: { route?: RouteChoice; relay?: RelayChoice; keepAwake?: boolean; signalUrl?: string }): Promise<void> {
  try {
    const result = await call('macs.remote.set', { name: mac.name, ...patch });
    replaceMac(result.mac);
    if (patch.route !== undefined || patch.relay !== undefined) {
      toast(result.reconnecting
        ? { tone: 'info', title: t.remote.toast.reconnecting }
        : { tone: 'info', title: t.remote.toast.saved, body: t.remote.toast.savedLater });
    }
    if (patch.keepAwake !== undefined || patch.signalUrl !== undefined) void useRemote.getState().loadReport(mac.name);
  } catch (err) {
    const e = errorInfo(err);
    if (!e.cancelled) toast({ tone: 'critical', title: t.remote.toast.changeFailed, body: joined(e) });
  }
}

export async function testConnection(mac: MacSummary): Promise<void> {
  try {
    const result = await call('macs.remote.test', { name: mac.name });
    toast(result.ok && result.route
      ? { tone: 'success', title: t.remote.toast.reached(mac.label, result.route), body: `${result.ms} ms · ${tidy(result.detail)}` }
      : { tone: 'critical', title: t.remote.toast.unreachable(mac.label), body: tidy(result.error), timeout: 0 });
  } catch (err) {
    toast({ tone: 'critical', title: t.remote.toast.testFailed, body: tidy(errorInfo(err).message) });
  }
}

export async function revokePc(mac: MacSummary, key: string, name: string): Promise<void> {
  try {
    await call('macs.remote.revoke', { name: mac.name, key });
    toast({ tone: 'info', title: t.remote.toast.revoked(name, mac.label) });
  } catch (err) {
    toast({ tone: 'critical', title: t.remote.toast.revokeFailed(name), body: tidy(errorInfo(err).message) });
  }
  void useRemote.getState().loadReport(mac.name);
}
