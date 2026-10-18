/** How apps, Macs and targets look in the views, the pickers and the status bar. */
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import type { MacSummary, Target } from '../../../desktop/src/shared/contract.js';
import { s, studio } from '../i18n.js';
import type { ResolvedDestination, WorkspaceApp } from '../state/model.js';

const color = (id: string) => new vscode.ThemeColor(id);

export function frameworkName(app: WorkspaceApp): string {
  return studio.apps.framework[app.app.framework] ?? app.app.framework;
}

/** "iOS app", "Mac app", "Windows app", "Electron app". */
export function appKind(app: WorkspaceApp): string {
  if (studio.apps.kind[app.app.id]) return studio.apps.kind[app.app.id]!;
  const platform = app.app.platform === 'ios' ? studio.apps.platforms.ios : app.app.platform === 'mac' ? studio.apps.platforms.mac : studio.apps.platforms.windows;
  return studio.apps.notYetApp(frameworkName(app), platform);
}

const FRAMEWORK_ICONS: Record<string, string> = {
  capacitor: 'device-mobile',
  electron: 'window',
  flutter: 'symbol-color',
  'react-native': 'device-mobile',
  expo: 'device-mobile',
  tauri: 'window',
  maui: 'device-mobile',
  cordova: 'device-mobile',
  nativescript: 'device-mobile',
  xcode: 'tools',
};

/** The app's own icon when it has one, else one for its kind. */
export function appIcon(app: WorkspaceApp): vscode.IconPath {
  if (app.app.icon && existsSync(app.app.icon)) return vscode.Uri.file(app.app.icon);
  if (app.app.id === 'windows') return new vscode.ThemeIcon('window');
  if (app.app.id === 'macos' || app.app.id === 'electron') return new vscode.ThemeIcon('window');
  return new vscode.ThemeIcon(FRAMEWORK_ICONS[app.app.framework] ?? 'package');
}

export function targetIcon(kind: ResolvedDestination['kind'], target: Target | null): vscode.ThemeIcon {
  switch (kind) {
    case 'mac-desktop':
      return new vscode.ThemeIcon('vm');
    case 'pc-desktop':
      return new vscode.ThemeIcon('window');
    case 'pc-iphone':
      return new vscode.ThemeIcon('device-mobile', target ? undefined : color('disabledForeground'));
    case 'device':
      return new vscode.ThemeIcon('device-mobile');
    case 'none':
      return new vscode.ThemeIcon('plug');
    default:
      return new vscode.ThemeIcon(target && /iPad/i.test(target.name) ? 'device-mobile' : 'device-mobile', target?.state === 'Booted' ? color('testing.iconPassed') : undefined);
  }
}

/** "Booted", "Off", "Connected · USB", as Studio says it. */
export function targetState(target: Target): string {
  if (target.kind === 'simulator') {
    if (target.state === 'Booted') return studio.targets.state.running;
    if (/booting/i.test(target.state)) return studio.targets.state.starting;
    if (/shutting/i.test(target.state)) return studio.targets.state.stopping;
    return studio.targets.state.off;
  }
  if (target.kind === 'device') {
    if (target.developerMode === 'disabled') return studio.targets.state.devModeOff;
    if (target.paired === false) return studio.targets.state.notTrusted;
    if (target.state === 'connected' || target.state === 'available') return target.connection === 'network' ? studio.targets.state.wifi : studio.targets.state.usb;
    return target.paired ? studio.targets.state.pairedNotConnected : studio.targets.state.notConnected;
  }
  return '';
}

/**
 * What to do on an iPhone before it can open your app, when something is in the way (Studio's
 * Devices rows and target picker). `pc`: it's plugged into this PC, not the Mac.
 */
export function targetHint(target: Target, pc = false): string | null {
  if (target.kind !== 'device') return null;
  if (target.developerMode === 'disabled') return studio.devices.devModeHint;
  if (target.paired === false) return pc ? studio.pc.trustHint : studio.devices.trustHint;
  if (!pc && target.state !== 'connected' && target.state !== 'available') return studio.devices.connectHint;
  return null;
}

/** A Mac's connection in words: "Connected · 12 ms", "Offline". */
export function macState(mac: MacSummary): string {
  switch (mac.state) {
    case 'connected':
    case 'restored':
      if (mac.route && mac.route !== 'lan') return studio.macState.connectedRoute(mac.route);
      return mac.latencyMs !== null ? studio.macState.connectedWith(s.devices.latency(mac.latencyMs)) : studio.macState.connected;
    case 'connecting':
      return studio.macState.connecting;
    case 'reconnecting':
    case 'lost':
      return studio.macState.reconnecting;
    case 'offline':
      return studio.macState.offline;
    default:
      return studio.macState.paired;
  }
}

export function macIcon(mac: MacSummary): vscode.ThemeIcon {
  if (mac.state === 'connected' || mac.state === 'restored') return new vscode.ThemeIcon('vm-active', color('testing.iconPassed'));
  if (mac.state === 'offline') return new vscode.ThemeIcon('vm-outline', color('errorForeground'));
  if (mac.state === 'connecting' || mac.state === 'reconnecting' || mac.state === 'lost') return new vscode.ThemeIcon('loading~spin');
  return new vscode.ThemeIcon('vm');
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 days ago", as CapMac Studio says it (renderer/lib/format.ts timeAgo). */
export function timeAgo(ts: number, now = Date.now()): string {
  const seconds = Math.round((ts - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return studio.time.justNow;
  if (abs < 45 * 60) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 22 * 3600) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 6 * 86400) return relative.format(Math.round(seconds / 86400), 'day');
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "12.3 MB", as CapMac Studio writes sizes (renderer/lib/format.ts formatBytes). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
