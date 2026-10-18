/** The pick lists: which app, where it runs, where it builds, and pairing a Mac. */
import os from 'node:os';
import * as vscode from 'vscode';
import type { DiscoveredMac, MacSummary, Target } from '../../../desktop/src/shared/contract.js';
import { s, studio, tidy } from '../i18n.js';
import { automaticTarget, errorText, keyOf, pcReady, type Model, type WorkspaceApp } from '../state/model.js';
import { parseAddress } from '../state/pure.js';

export { parseAddress };
import { appKind, frameworkName, macState, targetHint, targetState } from './format.js';
import { turnRemoteOn } from './remote.js';

type Item<T> = vscode.QuickPickItem & { value?: T };

const separator = <T>(label: string): Item<T> => ({ label, kind: vscode.QuickPickItemKind.Separator });

/** Asks which app Run and Live use. */
export async function pickApp(model: Model): Promise<WorkspaceApp | undefined> {
  const apps = model.runnableApps();
  const current = model.current();
  const projects = new Set(apps.map((a) => keyOf(a.project.dir)));
  const items: Item<WorkspaceApp>[] = [];
  let lastProject = '';
  for (const app of apps) {
    const key = keyOf(app.project.dir);
    if (projects.size > 1 && key !== lastProject) {
      items.push(separator(s.apps.project(app.project.name, app.project.rel)));
      lastProject = key;
    }
    items.push({
      label: `${app.key === current?.key ? '$(check)' : '$(blank)'} ${app.app.name}`,
      description: `${frameworkName(app)} · ${appKind(app)}`,
      detail: studio.apps.where[app.app.id],
      value: app,
    });
  }
  const picked = await vscode.window.showQuickPick(items, { title: s.apps.pickTitle, placeHolder: s.apps.pickPlaceholder, matchOnDescription: true });
  return picked?.value;
}

type TargetChoice =
  | { kind: 'mac-target'; mac: MacSummary; target: Target }
  | { kind: 'auto'; mac: MacSummary }
  | { kind: 'mac'; mac: MacSummary }
  | { kind: 'pc-phone'; target: Target }
  | { kind: 'pc-setup' }
  | { kind: 'pair' };

/** Asks where `app` runs, and remembers it. Returns false when nothing was picked. */
export async function pickTarget(model: Model, app: WorkspaceApp): Promise<boolean> {
  const id = app.app.id;
  if (id === 'windows') {
    void vscode.window.showInformationMessage(s.session.noScreenWindows);
    return false;
  }
  const pick = vscode.window.createQuickPick<Item<TargetChoice>>();
  pick.title = s.pick.targetTitle(app.app.name);
  pick.placeholder = s.pick.targetPlaceholder;
  pick.matchOnDescription = true;
  const dest = model.destinationOf(app);
  const backend = model.backendOf(app);
  const mac = model.macFor(app);

  const build = (): Item<TargetChoice>[] => {
    const items: Item<TargetChoice>[] = [];
    if (id === 'electron' || id === 'macos') {
      for (const m of model.macs) items.push({ label: `${m.name === mac?.name ? '$(check)' : '$(vm)'} ${m.label}`, description: [s.devices.macDesktop, macState(m), m.isDefault ? s.devices.defaultMac : null].filter(Boolean).join(' · '), value: { kind: 'mac', mac: m } });
      if (!model.macs.length) items.push({ label: `$(add) ${s.pick.pairMac}`, detail: s.pick.pairMacHint, value: { kind: 'pair' } });
      return items;
    }
    for (const m of model.macs) {
      const targets = model.targets.get(m.name);
      const isCurrentMac = backend === 'mac' && m.name === mac?.name;
      if (m.name !== mac?.name && model.macs.length > 1 && !targets) {
        items.push(separator(m.label), { label: `$(vm) ${m.label}`, description: macState(m), value: { kind: 'auto', mac: m } });
        continue;
      }
      items.push(separator(s.pick.simulators(m.label)));
      const auto = automaticTarget(targets);
      items.push({ label: `${isCurrentMac && !dest.target ? '$(check)' : '$(sparkle)'} ${s.pick.auto}`, description: auto ? auto.name : undefined, detail: s.pick.autoHint, value: { kind: 'auto', mac: m } });
      if (!targets) {
        items.push({ label: `$(loading~spin) ${s.pick.loadingTargets}`, alwaysShow: true });
        continue;
      }
      const sims = targets.simulators.filter((t) => t.available).sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted') || Number(/iPhone/.test(b.name)) - Number(/iPhone/.test(a.name)) || b.osVersion.localeCompare(a.osVersion, undefined, { numeric: true }));
      for (const t of sims) items.push({ label: `${isCurrentMac && dest.target === t.udid ? '$(check)' : '$(device-mobile)'} ${t.name}`, description: `${t.os} · ${targetState(t)}`, value: { kind: 'mac-target', mac: m, target: t } });
      if (targets.devices.length) {
        items.push(separator(s.pick.devices(m.label)));
        for (const t of targets.devices) items.push({ label: `${isCurrentMac && dest.target === t.udid ? '$(check)' : '$(device-mobile)'} ${t.name}`, description: `${t.os} · ${targetState(t)}`, detail: targetHint(t) ?? undefined, value: { kind: 'mac-target', mac: m, target: t } });
      }
    }
    if (!model.macs.length) items.push({ label: `$(add) ${s.pick.pairMac}`, detail: s.pick.pairMacHint, value: { kind: 'pair' } });
    // No Mac needed: an iPhone plugged into this PC (Windows only).
    if (process.platform === 'win32' && id === 'ios') {
      items.push(separator(s.pick.pcPhones));
      const pc = model.pc.get(keyOf(app.project.dir));
      if (!pcReady(pc?.status)) items.push({ label: `$(desktop-download) ${s.pick.pcSetUp}`, detail: s.pick.pcSetUpHint, value: { kind: 'pc-setup' } });
      else if (!pc?.devices) items.push({ label: `$(loading~spin) ${studio.pc.looking}`, alwaysShow: true });
      else if (!pc.devices.devices.length) items.push({ label: `$(info) ${studio.pc.none}`, detail: studio.pc.noPhone, alwaysShow: true });
      else for (const t of pc.devices.devices) items.push({ label: `${backend === 'wsl' && dest.target === t.udid ? '$(check)' : '$(device-mobile)'} ${t.name}`, description: `${t.os} · ${targetState(t)}`, detail: targetHint(t, true) ?? undefined, value: { kind: 'pc-phone', target: t } });
    }
    return items;
  };

  pick.items = build();
  // Fresh lists while the pick is open.
  const refresh = model.onDidChange((change) => {
    if (change === 'targets' || change === 'pc' || change === 'macs') {
      const active = pick.activeItems[0]?.value;
      pick.items = build();
      if (active) pick.activeItems = pick.items.filter((i) => i.value && JSON.stringify(i.value) === JSON.stringify(active));
    }
  });
  pick.busy = true;
  const loading = [
    ...model.macs.map((m) => (model.targets.get(m.name) ? Promise.resolve() : model.refreshTargets(m.name))),
    process.platform === 'win32' && id === 'ios' ? model.refreshPc(app.project.dir) : Promise.resolve(),
  ];
  void Promise.allSettled(loading).then(() => (pick.busy = false));
  pick.show();
  const choice = await new Promise<TargetChoice | undefined>((resolve) => {
    pick.onDidAccept(() => {
      const value = pick.selectedItems[0]?.value;
      if (value) resolve(value);
    });
    pick.onDidHide(() => resolve(undefined));
  });
  refresh.dispose();
  pick.dispose();
  if (!choice) return false;
  switch (choice.kind) {
    case 'pair':
      await vscode.commands.executeCommand('capmac.pairMac');
      return false;
    case 'pc-setup':
      await vscode.commands.executeCommand('capmac.setupPc');
      return false;
    case 'pc-phone':
      if (backend !== 'wsl') await model.setBackend(app, 'wsl');
      await model.setDestination(app, { target: choice.target.udid });
      return true;
    case 'mac':
      await model.setDestination(app, { mac: choice.mac.name });
      return true;
    case 'auto':
      if (backend !== 'mac') await model.setBackend(app, 'mac');
      await model.setDestination(app, { mac: choice.mac.name });
      return true;
    case 'mac-target':
      if (backend !== 'mac') await model.setBackend(app, 'mac');
      await model.setDestination(app, { mac: choice.mac.name, target: choice.target.udid });
      return true;
  }
}

/** Asks where the project's iOS app builds: a Mac, or this PC. */
export async function pickBackend(model: Model, app: WorkspaceApp): Promise<boolean> {
  const mac = model.macFor(app);
  const current = model.backendOf(app);
  const items: Item<'mac' | 'wsl'>[] = [
    { label: `${current === 'mac' ? '$(check)' : '$(vm)'} ${mac ? s.pick.backendMac(mac.label) : s.pick.pairMac}`, detail: s.pick.backendMacHint, value: 'mac' },
    { label: `${current === 'wsl' ? '$(check)' : '$(device-desktop)'} ${s.pick.backendPc}`, detail: s.pick.backendPcHint, value: 'wsl' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: s.pick.backendTitle });
  if (!picked?.value || picked.value === current) return false;
  if (picked.value === 'mac' && !mac) {
    await vscode.commands.executeCommand('capmac.pairMac');
    return false;
  }
  await model.setBackend(app, picked.value);
  void vscode.window.showInformationMessage(picked.value === 'wsl' ? studio.pc.switched : studio.pc.switchedMac(mac?.label ?? studio.common.theMac), { detail: studio.pc.switchedBody } as vscode.MessageOptions);
  return true;
}

/** Finds Macs on the network (Bonjour, Tailscale) and pairs the one picked. */
export async function pairMac(model: Model): Promise<MacSummary | undefined> {
  const pick = vscode.window.createQuickPick<Item<DiscoveredMac | 'type'>>();
  pick.title = s.pair.title;
  pick.placeholder = s.pair.pickPlaceholder;
  pick.busy = true;
  pick.ignoreFocusOut = true;
  const typeItem: Item<'type'> = { label: `$(edit) ${s.pair.typeAddress}`, detail: s.pair.typeAddressHint, value: 'type', alwaysShow: true };
  pick.items = [{ label: `$(loading~spin) ${s.pair.looking}`, alwaysShow: true }, typeItem];
  void model.client.call('macs.discover', { timeoutMs: 3500 }).then((result) => {
    pick.busy = false;
    const found = result.ok ? result.value : [];
    const paired = new Set(model.macs.flatMap((m) => [m.host.toLowerCase(), m.label.toLowerCase()]));
    const fresh = found.filter((m) => !paired.has(m.host.toLowerCase()) && !paired.has(m.name.toLowerCase()));
    pick.items = [
      ...fresh.map((m): Item<DiscoveredMac> => ({ label: `$(vm) ${m.name}`, description: `${m.host}${m.port !== 22 ? `:${m.port}` : ''}`, detail: m.via ? s.pair.via[m.via] : undefined, value: m })),
      // Nothing new: say so, and which Macs are paired already.
      ...(fresh.length ? [] : [{ label: `$(info) ${s.pair.noneFound}`, detail: s.pair.noneFoundHint, alwaysShow: true }]),
      typeItem,
      ...(model.macs.length ? [separator<DiscoveredMac | 'type'>(s.pair.alreadyPaired), ...model.macs.map((m) => ({ label: `$(check) ${m.label}`, description: `${m.username}@${m.host}`, alwaysShow: true }))] : []),
    ];
  });
  pick.show();
  const choice = await new Promise<{ host: string; port: number; user?: string; label?: string } | 'type' | undefined>((resolve) => {
    pick.onDidAccept(() => {
      const item = pick.selectedItems[0];
      const value = item?.value;
      if (value === 'type') return resolve('type');
      if (value) return resolve({ host: value.host, port: value.port, label: value.name });
      // Typed straight into the box: user@host[:port].
      const typed = pick.value.trim() ? parseAddress(pick.value) : null;
      if (typed) return resolve(typed);
      if (!item) resolve('type');
      // An information row: nothing to do.
    });
    pick.onDidHide(() => resolve(undefined));
  });
  pick.dispose();
  let target = choice;
  if (target === 'type') {
    const typed = await vscode.window.showInputBox({ title: s.pair.title, prompt: s.pair.addressPrompt, placeHolder: s.pair.addressPlaceholder, ignoreFocusOut: true, validateInput: (v) => (parseAddress(v) ? undefined : s.pair.badAddress) });
    target = typed ? parseAddress(typed) ?? undefined : undefined;
  }
  if (!target) return undefined;
  const username = target.user ?? (await vscode.window.showInputBox({ title: s.pair.title, prompt: s.pair.userPrompt(target.host), placeHolder: s.pair.userPlaceholder, value: os.userInfo().username, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : s.pair.userPlaceholder) }));
  if (!username) return undefined;
  const { host, port, label } = target;
  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: s.pair.pairing(label ?? host) }, () => model.client.invoke('macs.pair', { host, port, username: username.trim(), label }));
    await model.refreshMacs();
    // Remote access can come on now too, as Studio's sign-in step offers (it asks for the server when there is none).
    const anywhere = studio.remote.toggle(result.mac.label);
    void vscode.window.showInformationMessage(`${s.pair.paired(result.mac.label)}. ${s.pair.pairedBody}`, anywhere).then((answer) => {
      if (answer === anywhere) void turnRemoteOn(model, model.macs.find((m) => m.name === result.mac.name) ?? result.mac);
    });
    // Check it right away: what's missing shows in the Devices view, with fixes.
    void model.checkMac(result.mac.name).then((health) => {
      const issues = health.checks.filter((c) => c.level === 'fail' || c.level === 'warn');
      if (issues.length) {
        void vscode.window.showWarningMessage(s.macs.issues(result.mac.label, issues.length), s.macs.showIssues).then((answer) => {
          if (answer) void vscode.commands.executeCommand('capmac.devices.focus');
        });
      }
    });
    return result.mac;
  } catch (err) {
    const { message, hint } = errorText(err);
    if ((err as { cancelled?: boolean }).cancelled) return undefined;
    void vscode.window.showErrorMessage(`${s.pair.failed}: ${message}`, { detail: hint ?? s.pair.remoteLogin } as vscode.MessageOptions);
    return undefined;
  }
}

export async function pickFlutterMode(): Promise<'debug' | 'profile' | 'release' | undefined> {
  const modes = s.pick.flutterModes;
  const picked = await vscode.window.showQuickPick(
    (['debug', 'profile', 'release'] as const).map((value) => ({ label: modes[value].label, detail: modes[value].hint, value })),
    { title: s.pick.flutterModeTitle },
  );
  return picked?.value;
}

/** An IPA built through the Mac: Studio's Build an IPA dialog (its distribution, upload, team and folder). */
export interface IpaChoice {
  exportKind: 'development' | 'ad-hoc' | 'app-store' | 'enterprise';
  upload: boolean;
  team?: string;
  outDir?: string;
}

/** The team and folder an IPA build of a project used last (Studio's dialog asks each time; here they stay). */
const IPA_OPTIONS = 'capmac.ipaOptions';
type IpaOptions = Record<string, { team?: string; outDir?: string }>;

/**
 * Asks what to build: a distribution builds at once, Upload to TestFlight sends it to App Store
 * Connect (not for Flutter, whose engine path can't), and the team and folder can be changed first.
 */
export async function pickIpa(app: WorkspaceApp, state: vscode.Memento): Promise<IpaChoice | undefined> {
  const key = keyOf(app.project.dir);
  const kinds = studio.ipa.kinds;
  for (;;) {
    const options = state.get<IpaOptions>(IPA_OPTIONS, {})[key] ?? {};
    const save = (patch: { team?: string; outDir?: string }) => state.update(IPA_OPTIONS, { ...state.get<IpaOptions>(IPA_OPTIONS, {}), [key]: { ...options, ...patch } });
    type Choice = { exportKind?: IpaChoice['exportKind']; upload?: boolean; set?: 'team' | 'folder' };
    const items: Item<Choice>[] = [
      ...(['development', 'ad-hoc', 'app-store', 'enterprise'] as const).map((value) => ({ label: kinds[value].label, detail: kinds[value].hint, value: { exportKind: value } })),
      ...(app.project.framework === 'flutter' ? [] : [{ label: `$(cloud-upload) ${studio.ipa.upload}`, detail: studio.ipa.uploadDesc, value: { exportKind: 'app-store' as const, upload: true } }]),
      separator<Choice>(s.ipa.options),
      { label: `$(organization) ${studio.ipa.team}`, description: options.team ?? s.ipa.teamFromProject, value: { set: 'team' } },
      { label: `$(folder) ${studio.ipa.saveTo}`, description: options.outDir ?? s.ipa.defaultFolder, value: { set: 'folder' } },
    ];
    const picked = (await vscode.window.showQuickPick(items, { title: s.pick.ipaTitle, placeHolder: studio.ipa.intro }))?.value;
    if (!picked) return undefined;
    if (picked.set === 'team') {
      const team = await vscode.window.showInputBox({
        title: studio.ipa.team, prompt: studio.ipa.teamHint, value: options.team ?? '', placeHolder: 'ABCDE12345',
        validateInput: (value) => (value.trim() && !/^[A-Z0-9]{10}$/.test(value.trim().toUpperCase()) ? studio.ipa.teamError : undefined),
      });
      if (team !== undefined) await save({ team: team.trim().toUpperCase() || undefined });
      continue;
    }
    if (picked.set === 'folder') {
      const folder = await vscode.window.showOpenDialog({ title: studio.ipa.saveTo, canSelectFolders: true, canSelectFiles: false, openLabel: studio.ipa.chooseFolder, defaultUri: vscode.Uri.file(options.outDir ?? app.project.dir) });
      if (folder?.[0]) await save({ outDir: folder[0].fsPath });
      continue;
    }
    return { exportKind: picked.exportKind!, upload: Boolean(picked.upload), team: options.team, outDir: picked.upload ? undefined : options.outDir };
  }
}

/** The samples the engine can copy (read from the contract when the extension is built). */
declare const __CAPMAC_SAMPLE_KINDS__: string[] | undefined;
export type SampleKind = 'ios' | 'electron' | 'flutter' | 'react-native';

export async function pickSample(): Promise<SampleKind | undefined> {
  const samples = s.pick.samples as Record<string, { label: string; hint: string }>;
  const kinds = (typeof __CAPMAC_SAMPLE_KINDS__ !== 'undefined' ? __CAPMAC_SAMPLE_KINDS__ : ['ios', 'electron']).filter((k) => samples[k]);
  // Mobile first, then desktop.
  const order = ['ios', 'flutter', 'react-native', 'electron'];
  kinds.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const picked = await vscode.window.showQuickPick(
    kinds.map((value) => ({ label: samples[value]!.label, detail: samples[value]!.hint, value: value as SampleKind })),
    { title: s.pick.sampleTitle },
  );
  return picked?.value;
}

export function describeError(err: unknown): string {
  const { message, hint } = errorText(err);
  return hint ? `${message}. ${tidy(hint)}` : message;
}
