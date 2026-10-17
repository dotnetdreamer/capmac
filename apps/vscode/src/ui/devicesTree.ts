/**
 * The Devices view: each paired Mac with its simulators, iPhones and iPads,
 * its desktop (for Mac apps) and its health; and this PC, with its desktop
 * (a Flutter app's Windows app) and the iPhones plugged into it (no Mac).
 */
import * as vscode from 'vscode';
import type { Check, MacSummary, Target } from '../../../desktop/src/shared/contract.js';
import { s, studio, tidy } from '../i18n.js';
import { keyOf, pcReady, type Model, type WorkspaceApp } from '../state/model.js';
import { macIcon, macState, targetState } from './format.js';

export type DeviceNode =
  | { kind: 'mac'; mac: MacSummary }
  | { kind: 'group'; mac: MacSummary; group: 'simulators' | 'devices' | 'health' }
  | { kind: 'target'; mac: MacSummary; target: Target }
  | { kind: 'runtime'; mac: MacSummary; os: string; targets: Target[] }
  | { kind: 'macDesktop'; mac: MacSummary }
  | { kind: 'check'; mac: MacSummary | null; check: Check }
  | { kind: 'message'; text: string; icon?: string; tooltip?: string; command?: vscode.Command }
  | { kind: 'pc' }
  | { kind: 'pcWindows' }
  | { kind: 'pcPhones'; app: WorkspaceApp }
  | { kind: 'pcPhone'; app: WorkspaceApp; target: Target };

const color = (id: string) => new vscode.ThemeColor(id);
const LEVEL_ICONS: Record<string, vscode.ThemeIcon> = {
  ok: new vscode.ThemeIcon('pass', color('testing.iconPassed')),
  warn: new vscode.ThemeIcon('warning', color('editorWarning.foreground')),
  fail: new vscode.ThemeIcon('error', color('errorForeground')),
  info: new vscode.ThemeIcon('info'),
};

export class DevicesTree implements vscode.TreeDataProvider<DeviceNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<DeviceNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposable: vscode.Disposable;
  /** Macs whose lists were asked for once (a Mac CapMac doesn't watch). */
  private readonly asked = new Set<string>();

  constructor(private readonly model: Model) {
    this.disposable = model.onDidChange((change) => {
      if (change !== 'apps' || this.hasPlatform('windows')) this.changed.fire(undefined);
    });
  }

  refresh(): void {
    this.asked.clear();
    this.changed.fire(undefined);
  }

  private hasPlatform(id: string): boolean {
    return this.model.runnableApps().some((a) => a.app.id === id);
  }

  getChildren(node?: DeviceNode): DeviceNode[] {
    if (!node) {
      const nodes: DeviceNode[] = this.model.macs.map((mac) => ({ kind: 'mac', mac }));
      if (process.platform === 'win32' && (this.hasPlatform('windows') || this.model.runnableApps().some((a) => a.app.id === 'ios'))) nodes.push({ kind: 'pc' });
      return nodes;
    }
    switch (node.kind) {
      case 'mac':
        return this.macChildren(node.mac);
      case 'group':
        return this.groupChildren(node.mac, node.group);
      case 'runtime':
        return node.targets.map((target) => ({ kind: 'target', mac: node.mac, target }));
      case 'pc': {
        const nodes: DeviceNode[] = [];
        if (this.hasPlatform('windows')) nodes.push({ kind: 'pcWindows' });
        const ios = this.iosApp();
        if (ios) nodes.push({ kind: 'pcPhones', app: ios });
        return nodes;
      }
      case 'pcPhones':
        return this.pcPhoneChildren(node.app);
      default:
        return [];
    }
  }

  /** The app the iPhones on this PC are for: the current one if it is an iOS app, else the workspace's first. */
  private iosApp(): WorkspaceApp | null {
    const current = this.model.current();
    if (current?.app.id === 'ios') return current;
    return this.model.runnableApps().find((a) => a.app.id === 'ios') ?? null;
  }

  private macChildren(mac: MacSummary): DeviceNode[] {
    const targets = this.model.targets.get(mac.name);
    const error = this.model.targetErrors.get(mac.name);
    const nodes: DeviceNode[] = [];
    if (!targets && !this.asked.has(mac.name)) {
      this.asked.add(mac.name);
      void this.model.refreshTargets(mac.name);
    }
    if (targets) {
      nodes.push({ kind: 'group', mac, group: 'simulators' });
      if (targets.deviceSupport || targets.devices.length) nodes.push({ kind: 'group', mac, group: 'devices' });
    } else if (error) {
      nodes.push({ kind: 'message', text: studio.devices.listFailed(mac.label), icon: 'warning', tooltip: error, command: { command: 'capmac.connectMac', title: s.cmd.connectMac, arguments: [{ kind: 'mac', mac }] } });
    } else {
      nodes.push({ kind: 'message', text: studio.targets.looking, icon: 'loading~spin' });
    }
    if (this.hasPlatform('electron') || this.hasPlatform('macos')) nodes.push({ kind: 'macDesktop', mac });
    nodes.push({ kind: 'group', mac, group: 'health' });
    return nodes;
  }

  private groupChildren(mac: MacSummary, group: 'simulators' | 'devices' | 'health'): DeviceNode[] {
    if (group === 'health') {
      const health = this.model.health.get(mac.name);
      if (!health) {
        void this.model.checkMac(mac.name);
        return [{ kind: 'message', text: s.devices.checking, icon: 'loading~spin' }];
      }
      if (health.error) return [{ kind: 'message', text: health.error, icon: 'error' }];
      const checks = health.checks.filter((c) => c.group === 'mac' || c.level !== 'ok').sort((a, b) => rank(a) - rank(b));
      if (health.running && !checks.length) return [{ kind: 'message', text: s.devices.checking, icon: 'loading~spin' }];
      return checks.map((check) => ({ kind: 'check', mac, check }));
    }
    const targets = this.model.targets.get(mac.name);
    if (!targets) return [];
    if (group === 'devices') {
      if (!targets.devices.length) return [{ kind: 'message', text: targets.deviceSupport ? studio.devices.noDevice : studio.devices.oldXcode, icon: 'info', tooltip: targets.deviceSupport ? studio.devices.noDeviceBody : studio.devices.oldXcodeBody }];
      return targets.devices.map((target) => ({ kind: 'target', mac, target }));
    }
    if (!targets.simulators.length) return [{ kind: 'message', text: studio.devices.noSimulators, icon: 'info', tooltip: studio.devices.noSimulatorsBody }];
    // Running ones first, then the newest iOS's, iPhones before iPads; older iOS versions fold away.
    const byName = (a: Target, b: Target) => Number(/iPhone/.test(b.name)) - Number(/iPhone/.test(a.name)) || a.name.localeCompare(b.name, undefined, { numeric: true });
    const sims = targets.simulators.filter((t) => t.available);
    const booted = sims.filter((t) => t.state === 'Booted').sort(byName);
    const runtimes = new Map<string, Target[]>();
    for (const t of sims.filter((t) => t.state !== 'Booted').sort((a, b) => b.osVersion.localeCompare(a.osVersion, undefined, { numeric: true }))) {
      const list = runtimes.get(t.os) ?? [];
      list.push(t);
      runtimes.set(t.os, list);
    }
    const [newest, ...older] = [...runtimes.entries()];
    const nodes: DeviceNode[] = [...booted, ...(newest?.[1].sort(byName) ?? [])].map((target) => ({ kind: 'target', mac, target }));
    for (const [os, list] of older) nodes.push({ kind: 'runtime', mac, os, targets: list.sort(byName) });
    return nodes;
  }

  private pcPhoneChildren(app: WorkspaceApp): DeviceNode[] {
    const pc = this.model.pc.get(keyOf(app.project.dir));
    if (!pc?.status) {
      void this.model.refreshPc(app.project.dir);
      return [{ kind: 'message', text: s.devices.pcLooking, icon: 'loading~spin' }];
    }
    if (!pcReady(pc.status)) {
      return [{ kind: 'message', text: pc.setupId ? s.devices.pcSettingUp(studio.pc.settingUp) : s.devices.pcNeedsSetup, icon: pc.setupId ? 'loading~spin' : 'desktop-download', command: { command: 'capmac.setupPc', title: s.devices.pcNeedsSetup } }];
    }
    const devices = pc.devices;
    if (!devices) {
      void this.model.refreshPc(app.project.dir);
      return [{ kind: 'message', text: studio.pc.looking, icon: 'loading~spin' }];
    }
    if (devices.server === 'missing') return [{ kind: 'message', text: studio.pc.noAppleDevices, icon: 'warning', command: { command: 'capmac.setupPc', title: s.devices.pcNeedsSetup } }];
    if (devices.error) return [{ kind: 'message', text: tidy(devices.error.message), icon: 'warning', tooltip: tidy(devices.error.hint) }];
    if (!devices.devices.length) return [{ kind: 'message', text: studio.pc.none, icon: 'info', tooltip: studio.pc.noPhone }];
    return devices.devices.map((target) => ({ kind: 'pcPhone', app, target }));
  }

  getTreeItem(node: DeviceNode): vscode.TreeItem {
    const current = this.model.current();
    switch (node.kind) {
      case 'mac': {
        const { mac } = node;
        const item = new vscode.TreeItem(mac.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `mac:${mac.name}`;
        item.description = [macState(mac), mac.isDefault ? s.devices.defaultMac : null, mac.remote.enabled ? '🌐' : null].filter(Boolean).join(' · ');
        item.iconPath = macIcon(mac);
        const facts = s.devices.lastSeen(mac.xcode, mac.macos);
        item.tooltip = new vscode.MarkdownString(`**${mac.label}** (${mac.username}@${mac.host})\n\n${macState(mac)}${facts ? `\n\n${facts}` : ''}${mac.error ? `\n\n$(warning) ${tidy(mac.error)}` : ''}${mac.remote.enabled ? `\n\n$(globe) ${s.devices.remoteOn}` : ''}`, true);
        const online = mac.state === 'connected' || mac.state === 'restored';
        item.contextValue = `mac.${mac.isDefault ? 'default' : 'other'}.${online ? 'online' : 'offline'}.${mac.remote.enabled ? 'remoteon' : 'remoteoff'}`;
        return item;
      }
      case 'group': {
        const label = node.group === 'simulators' ? s.devices.simulators : node.group === 'devices' ? s.devices.devices : s.devices.health;
        const health = node.group === 'health' ? this.model.health.get(node.mac.name) : undefined;
        const collapsed = node.group === 'health' && !(health && health.checks.some((c) => c.level === 'fail'));
        const item = new vscode.TreeItem(label, collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${node.mac.name}:${node.group}`;
        if (node.group === 'health') {
          const problems = health?.checks.filter((c) => c.level === 'fail' || c.level === 'warn') ?? [];
          item.iconPath = health?.running ? new vscode.ThemeIcon('loading~spin') : problems.some((c) => c.level === 'fail') ? LEVEL_ICONS.fail : problems.length ? LEVEL_ICONS.warn : health ? LEVEL_ICONS.ok : new vscode.ThemeIcon('pulse');
          item.description = health?.running ? s.devices.checking : health ? (problems.length ? `${problems.length}` : studio.common.done) : s.devices.checkHint;
          item.contextValue = 'health';
        } else {
          const targets = this.model.targets.get(node.mac.name);
          const count = node.group === 'simulators' ? targets?.simulators.filter((t) => t.state === 'Booted').length : targets?.devices.filter((t) => t.state === 'connected').length;
          item.iconPath = new vscode.ThemeIcon(node.group === 'simulators' ? 'device-mobile' : 'plug');
          if (count) item.description = node.group === 'simulators' ? `${count} ${s.devices.booted.toLowerCase()}` : `${count}`;
        }
        return item;
      }
      case 'target': {
        const { target, mac } = node;
        const item = new vscode.TreeItem(target.name);
        item.id = `target:${mac.name}:${target.udid}`;
        const isCurrent = Boolean(current && this.model.destinationOf(current).target === target.udid);
        item.description = [target.os, targetState(target), isCurrent ? s.devices.current : null].filter(Boolean).join(' · ');
        const on = target.kind === 'simulator' ? target.state === 'Booted' : target.state === 'connected' || target.state === 'available';
        item.iconPath = new vscode.ThemeIcon(isCurrent ? 'target' : 'device-mobile', on ? color('testing.iconPassed') : undefined);
        item.tooltip = `${target.name} (${target.os})\n${targetState(target)}\n${target.udid}`;
        const runnable = Boolean(current && current.app.id === 'ios');
        item.contextValue = `target.${target.kind}.${target.kind === 'simulator' ? (on ? 'on' : 'off') : 'device'}${runnable ? '.runnable' : ''}${on ? '.screen' : ''}`;
        item.command = runnable ? { command: 'capmac.useTarget', title: s.cmd.useTarget, arguments: [node] } : undefined;
        return item;
      }
      case 'runtime': {
        const item = new vscode.TreeItem(studio.targets.simulatorsFor(node.os), vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `runtime:${node.mac.name}:${node.os}`;
        item.description = String(node.targets.length);
        item.iconPath = new vscode.ThemeIcon('versions');
        return item;
      }
      case 'macDesktop': {
        const item = new vscode.TreeItem(s.devices.macDesktop);
        item.id = `desktop:${node.mac.name}`;
        item.iconPath = new vscode.ThemeIcon('vm');
        item.tooltip = s.devices.macDesktopTip;
        const forApp = current && (current.app.id === 'electron' || current.app.id === 'macos');
        item.description = forApp ? current.app.name : undefined;
        item.contextValue = `target.macdesktop${forApp ? '.runnable.screen' : ''}`;
        return item;
      }
      case 'check': {
        const { check } = node;
        const item = new vscode.TreeItem(check.label);
        item.description = check.detail ? tidy(check.detail) : undefined;
        item.iconPath = LEVEL_ICONS[check.level] ?? LEVEL_ICONS.info;
        const md = new vscode.MarkdownString(`**${check.label}**${check.detail ? ` · ${tidy(check.detail)}` : ''}`);
        if (check.fix && !check.action) md.appendMarkdown(`\n\n→ ${tidy(check.fix)}`);
        if (check.action) md.appendMarkdown(`\n\n$(wrench) ${check.action.label}`);
        md.supportThemeIcons = true;
        item.tooltip = md;
        item.contextValue = check.action ? 'check.fixable' : 'check';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip;
        item.command = node.command;
        return item;
      }
      case 'pc': {
        const item = new vscode.TreeItem(s.devices.thisPc, vscode.TreeItemCollapsibleState.Expanded);
        item.id = 'pc';
        item.iconPath = new vscode.ThemeIcon('device-desktop');
        item.description = 'Windows';
        return item;
      }
      case 'pcWindows': {
        const item = new vscode.TreeItem(s.devices.windowsDesktop);
        item.id = 'pc:windows';
        item.iconPath = new vscode.ThemeIcon('window');
        item.tooltip = s.devices.windowsDesktopTip;
        const forApp = current?.app.id === 'windows';
        item.description = forApp ? current.app.name : undefined;
        item.contextValue = `target.windows${forApp ? '.runnable' : ''}`;
        return item;
      }
      case 'pcPhones': {
        const pc = this.model.pc.get(keyOf(node.app.project.dir));
        const item = new vscode.TreeItem(s.devices.pcIphones, vscode.TreeItemCollapsibleState.Expanded);
        item.id = 'pc:iphones';
        item.iconPath = new vscode.ThemeIcon('device-mobile');
        item.tooltip = s.devices.pcIphonesTip;
        const ready = pcReady(pc?.status);
        item.description = pc?.setupId ? studio.pc.settingUp : pc?.status ? (ready ? studio.pc.ready : studio.pc.needsSetup) : undefined;
        item.contextValue = pc?.setupId ? 'pc.settingUp' : ready ? 'pc.ready' : 'pc.needsSetup';
        return item;
      }
      case 'pcPhone': {
        const { target, app } = node;
        const item = new vscode.TreeItem(target.name);
        item.id = `pc:${target.udid}`;
        const isCurrent = this.model.destinationOf(app).target === target.udid && this.model.backendOf(app) === 'wsl';
        item.description = [target.os, target.connection === 'network' ? studio.targets.state.wifi : studio.targets.state.usb, isCurrent ? s.devices.current : null].filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon(isCurrent ? 'target' : 'device-mobile', color('testing.iconPassed'));
        item.contextValue = 'target.pciphone.runnable';
        item.command = { command: 'capmac.useTarget', title: s.cmd.useTarget, arguments: [node] };
        return item;
      }
    }
  }

  dispose(): void {
    this.disposable.dispose();
    this.changed.dispose();
  }
}

function rank(check: Check): number {
  return { fail: 0, warn: 1, info: 2, ok: 3 }[check.level] ?? 4;
}
