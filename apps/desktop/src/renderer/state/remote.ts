/**
 * Remote access ("Reach this Mac from anywhere") in CapMac Studio: the
 * signaling server setting, each Mac's status, and the actions, with the same
 * options and defaults as `capmac remote` (both use the engine's remote API).
 */
import { create } from 'zustand';
import type { ErrorInfo, MacSummary, RelayChoice, RemoteStatusReport, RemoteTestResult, Route, RouteChoice, SignalServerSetting } from '../../shared/contract';
import { toast } from './app';
import { call, errorInfo } from './engine';
import { useMacs } from './macs';

export const ROUTE_LABEL: Record<RouteChoice, string> = {
  auto: 'Automatic',
  lan: 'Local network only',
  internet: 'Over the internet',
};

export const ROUTE_HINT: Record<RouteChoice, string> = {
  auto: 'The local network when the Mac answers there, else the internet',
  lan: 'Never over the internet',
  internet: 'Even when the Mac is on this network',
};

export const RELAY_LABEL: Record<RelayChoice, string> = {
  allow: 'When needed',
  never: 'Never',
  always: 'Always (for testing)',
};

export const RELAY_HINT: Record<RelayChoice, string> = {
  allow: 'When peer to peer is not possible',
  never: 'Peer to peer only',
  always: 'Everything through your server',
};

/** "peer to peer over the internet", for a connection's route. */
export function routeText(route: Route): string {
  return route === 'lan' ? 'on the local network' : route === 'direct' ? 'peer to peer over the internet' : 'through the relay';
}

/** "Peer to peer", short, for chips and footers. */
export function routeShort(route: Route): string {
  return route === 'lan' ? 'Local network' : route === 'direct' ? 'Peer to peer' : 'Relay';
}

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

function testText(test: RemoteTestResult | null): string | undefined {
  if (!test) return undefined;
  return test.ok && test.route ? `Tested: ${routeText(test.route)}, ${test.ms} ms.` : `This PC could not reach it over the internet yet: ${test.error}`;
}

/** Turns remote access on. The caller makes sure a signaling server is set. */
export async function turnOn(mac: MacSummary, options: { keepAwake?: boolean } = {}): Promise<boolean> {
  try {
    const result = await call('macs.remote.enable', { name: mac.name, keepAwake: options.keepAwake });
    replaceMac(result.mac);
    toast({ tone: result.test?.ok === false ? 'caution' : 'success', title: `Remote access is on for ${mac.label}`, body: testText(result.test) });
    void useRemote.getState().loadReport(mac.name);
    return true;
  } catch (err) {
    const e = errorInfo(err);
    if (!e.cancelled) toast({ tone: 'critical', title: 'Could not turn remote access on', body: e.hint ? `${e.message} ${e.hint}` : e.message, timeout: 0 });
    return false;
  }
}

/** Turns remote access off; `localOnly` when the Mac cannot be reached. */
export async function turnOff(mac: MacSummary, localOnly = false): Promise<'ok' | 'unreachable' | 'failed'> {
  try {
    const result = await call('macs.remote.disable', { name: mac.name, localOnly });
    replaceMac(result.mac);
    useMacs.getState().refreshCheck(mac.name, result.check);
    toast({ tone: 'info', title: `Remote access is off for ${mac.label}`, body: localOnly ? 'The Mac still lists this PC until you turn it off from its network.' : 'The Mac no longer lets this PC in over the internet.' });
    return 'ok';
  } catch (err) {
    const e = errorInfo(err);
    if (e.cancelled) return 'failed';
    if (!localOnly && /reach|offline|connect/i.test(e.message)) return 'unreachable';
    toast({ tone: 'critical', title: 'Could not turn remote access off', body: e.message });
    return 'failed';
  }
}

export async function setOptions(mac: MacSummary, patch: { route?: RouteChoice; relay?: RelayChoice; keepAwake?: boolean; signalUrl?: string }): Promise<void> {
  try {
    const result = await call('macs.remote.set', { name: mac.name, ...patch });
    replaceMac(result.mac);
    if (patch.route !== undefined || patch.relay !== undefined) {
      toast(result.reconnecting
        ? { tone: 'info', title: 'Reconnecting with the new setting' }
        : { tone: 'info', title: 'Saved', body: 'It applies the next time CapMac connects to the Mac (after the current run).' });
    }
    if (patch.keepAwake !== undefined || patch.signalUrl !== undefined) void useRemote.getState().loadReport(mac.name);
  } catch (err) {
    const e = errorInfo(err);
    if (!e.cancelled) toast({ tone: 'critical', title: 'Could not change remote access', body: e.hint ? `${e.message} ${e.hint}` : e.message });
  }
}

export async function testConnection(mac: MacSummary): Promise<void> {
  try {
    const result = await call('macs.remote.test', { name: mac.name });
    toast(result.ok && result.route
      ? { tone: 'success', title: `Reached ${mac.label} ${routeText(result.route)}`, body: `${result.ms} ms · ${result.detail}` }
      : { tone: 'critical', title: `Could not reach ${mac.label} over the internet`, body: result.error, timeout: 0 });
  } catch (err) {
    toast({ tone: 'critical', title: 'The test failed', body: errorInfo(err).message });
  }
}

export async function revokePc(mac: MacSummary, key: string, name: string): Promise<void> {
  try {
    await call('macs.remote.revoke', { name: mac.name, key });
    toast({ tone: 'info', title: `${name} can no longer reach ${mac.label} over the internet` });
  } catch (err) {
    toast({ tone: 'critical', title: `Could not remove ${name}`, body: errorInfo(err).message });
  }
  void useRemote.getState().loadReport(mac.name);
}
