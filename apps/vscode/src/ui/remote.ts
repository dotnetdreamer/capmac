/**
 * Remote access ("Use this Mac from anywhere") from VS Code, as CapMac Studio's Mac card has it
 * (features/macs/RemoteAccess.tsx, state/remote.ts) and with its words: turning it on (with the
 * engine's connection test), the connection route, the relay, keeping the Mac awake, a test, the
 * PCs that can reach the Mac, moving it to the server saved now, turning it off (on this PC only
 * when the Mac can't be reached), and the server itself. Settings are the engine's, shared with
 * `capmac remote` and Studio.
 */
import * as vscode from 'vscode';
import { shortKey, signalUrlProblem } from '@capmac/core/shared/remote';
import type { MacSummary, RelayChoice, RemoteStatusReport, RemoteTestResult, RouteChoice, SignalServerSetting } from '../../../desktop/src/shared/contract.js';
import { timeAgo } from './format.js';
import { EngineError } from '../engine/client.js';
import { s, studio, tidy } from '../i18n.js';
import { errorText, type Model } from '../state/model.js';

const connected = (mac: MacSummary) => mac.state === 'connected' || mac.state === 'restored';

/** The engine's error, unless the person cancelled. */
function failed(title: string, err: unknown): void {
  if (err instanceof EngineError && err.cancelled) return;
  const error = errorText(err);
  void vscode.window.showErrorMessage(title, { detail: [error.message, error.hint].filter(Boolean).join('\n') } as vscode.MessageOptions);
}

function testText(test: RemoteTestResult | null): string | undefined {
  if (!test) return undefined;
  return test.ok && test.route ? studio.remote.toast.testPassed(test.route, test.ms) : studio.remote.toast.testNotYet(tidy(test.error) ?? '');
}

/** Asks for the signaling server (once, before the first Mac goes remote). False: none was given. */
async function askServer(model: Model): Promise<boolean> {
  const url = await vscode.window.showInputBox({
    title: studio.remote.server.title,
    prompt: studio.remote.server.body,
    placeHolder: studio.remote.server.placeholder,
    ignoreFocusOut: true,
    validateInput: (value) => (signalUrlProblem(value) ? tidy(signalUrlProblem(value)) : undefined),
  });
  if (!url) return false;
  await model.client.invoke('remote.setServer', { url: url.trim() });
  return true;
}

/** Turns remote access on for `mac`, asking for the server first when there is none. */
export async function turnRemoteOn(model: Model, mac: MacSummary): Promise<void> {
  try {
    const server = await model.client.invoke('remote.server', {});
    if (!server.url && !(await askServer(model))) return;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: studio.commands.remoteOn(mac.label) }, () =>
      model.client.invoke('macs.remote.enable', { name: mac.name }),
    );
    await model.refreshMacs();
    const message = studio.remote.toast.on(mac.label);
    const detail = testText(result.test);
    if (result.test?.ok === false) void vscode.window.showWarningMessage(message, { detail } as vscode.MessageOptions);
    else void vscode.window.showInformationMessage(detail ? `${message}. ${detail}` : message);
  } catch (err) {
    failed(studio.remote.toast.onFailed, err);
  }
}

/** Turns remote access off; when the Mac can't be reached, offers to turn it off on this PC only. */
export async function turnRemoteOff(model: Model, mac: MacSummary): Promise<void> {
  const answer = await vscode.window.showWarningMessage(studio.remote.offTitle(mac.label), { modal: true, detail: studio.remote.offBody(mac.label, mac.remote.keepAwake) }, studio.remote.turnOff);
  if (answer !== studio.remote.turnOff) return;
  const off = async (localOnly: boolean) => {
    await model.client.invoke('macs.remote.disable', { name: mac.name, localOnly });
    await model.refreshMacs();
    void vscode.window.showInformationMessage(studio.remote.toast.off(mac.label), { detail: localOnly ? studio.remote.toast.offHereOnly : studio.remote.toast.offBody } as vscode.MessageOptions);
  };
  try {
    await off(false);
  } catch (err) {
    if (err instanceof EngineError && err.cancelled) return;
    if (!/reach|offline|connect/i.test(errorText(err).message)) {
      failed(studio.remote.toast.offFailed, err);
      return;
    }
    const here = await vscode.window.showWarningMessage(studio.remote.unreachableTitle(mac.label), { modal: true, detail: studio.remote.unreachableBody }, studio.remote.turnOffHere);
    if (here !== studio.remote.turnOffHere) return;
    await off(true).catch((error: unknown) => failed(studio.remote.toast.offFailed, error));
  }
}

/** Changes one of `mac`'s remote access settings, saying when it applies. */
async function setOption(model: Model, mac: MacSummary, patch: { route?: RouteChoice; relay?: RelayChoice; keepAwake?: boolean; signalUrl?: string }): Promise<void> {
  try {
    const result = await model.client.invoke('macs.remote.set', { name: mac.name, ...patch });
    await model.refreshMacs();
    if (patch.route !== undefined || patch.relay !== undefined) {
      vscode.window.setStatusBarMessage(`$(globe) ${result.reconnecting ? studio.remote.toast.reconnecting : `${studio.remote.toast.saved}. ${studio.remote.toast.savedLater}`}`, 5000);
    } else vscode.window.setStatusBarMessage(`$(globe) ${studio.remote.toast.saved}`, 3000);
  } catch (err) {
    failed(studio.remote.toast.changeFailed, err);
  }
}

async function testConnection(model: Model, mac: MacSummary): Promise<void> {
  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: studio.remote.test }, () => model.client.invoke('macs.remote.test', { name: mac.name }));
    if (result.ok && result.route) void vscode.window.showInformationMessage(studio.remote.toast.reached(mac.label, result.route), { detail: `${result.ms} ms · ${tidy(result.detail)}` } as vscode.MessageOptions);
    else void vscode.window.showErrorMessage(studio.remote.toast.unreachable(mac.label), { detail: tidy(result.error) } as vscode.MessageOptions);
  } catch (err) {
    failed(studio.remote.toast.testFailed, err);
  }
}

/** The PCs that can reach `mac` over the internet; picking another PC removes it. */
async function managePcs(model: Model, mac: MacSummary, report: RemoteStatusReport | null): Promise<void> {
  const pcs = report?.pcs ?? (await model.client.invoke('macs.remote.status', { name: mac.name })).pcs;
  type Item = vscode.QuickPickItem & { pc?: (typeof pcs)[number] };
  const items: Item[] = pcs.map((pc) => ({
    label: `$(${pc.current ? 'device-desktop' : 'vm'}) ${pc.name}`,
    description: [pc.current ? studio.remote.thisPc : null, shortKey(pc.key), studio.remote.added(timeAgo(Date.parse(pc.addedAt)))].filter(Boolean).join(' · '),
    pc,
  }));
  const picked = await vscode.window.showQuickPick(items, { title: studio.remote.pcsTitle(mac.label), placeHolder: studio.remote.pcsBody });
  const pc = picked?.pc;
  if (!pc || pc.current) return;
  const answer = await vscode.window.showWarningMessage(`${studio.common.remove} ${pc.name}?`, { modal: true, detail: studio.remote.pcsBody }, studio.common.remove);
  if (answer !== studio.common.remove) return;
  try {
    await model.client.invoke('macs.remote.revoke', { name: mac.name, key: pc.key });
    void vscode.window.showInformationMessage(studio.remote.toast.revoked(pc.name, mac.label));
  } catch (err) {
    failed(studio.remote.toast.revokeFailed(pc.name), err);
  }
}

/** How remote access is for `mac` now, in Studio's words. */
function statusText(mac: MacSummary, report: RemoteStatusReport | null): string {
  if (!mac.remote.enabled) return studio.remote.statusOff;
  if (!connected(mac) || !mac.route) return studio.remote.statusOn;
  const door = report?.door?.status?.state;
  const reach = door === 'online' ? studio.remote.macOnline : door ? studio.remote.macOffline(tidy(report?.door?.status?.error)) : null;
  const link = studio.remote.statusConnected(mac.route, mac.route !== 'lan' ? mac.rttMs : null);
  return reach ? `${link}. ${reach}` : link;
}

/** `mac`'s remote access settings in a quick pick, until one is picked. */
export async function remoteSettings(model: Model, mac: MacSummary): Promise<void> {
  if (!mac.remote.enabled) {
    await turnRemoteOn(model, mac);
    return;
  }
  // What the Mac's door says (online at the server), and the PCs, when the Mac answers.
  const [report, server] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: studio.common.askingMac }, () =>
    Promise.all([
      connected(mac) ? model.client.invoke('macs.remote.status', { name: mac.name }).catch(() => null) : Promise.resolve(null),
      model.client.invoke('remote.server', {}).catch((): SignalServerSetting | null => null),
    ]),
  );
  const remote = mac.remote;
  const movable = server?.url && remote.signalUrl && server.url !== remote.signalUrl ? server.url : null;
  type Item = vscode.QuickPickItem & { id?: 'route' | 'relay' | 'awake' | 'test' | 'pcs' | 'move' | 'off' };
  const items: Item[] = [
    { id: 'route', label: `$(plug) ${studio.remote.connection}`, description: studio.route.choice[remote.route], detail: studio.route.choiceHint[remote.route] },
    { id: 'relay', label: `$(server) ${studio.remote.relay}`, description: studio.route.relay[remote.relay], detail: studio.route.relayHint[remote.relay] },
    { id: 'awake', label: `$(${remote.keepAwake ? 'eye' : 'eye-closed'}) ${studio.remote.keepAwake}`, description: remote.keepAwake ? studio.common.on : studio.common.off, detail: remote.keepAwake ? studio.remote.awakeNote : studio.remote.loggedInNote },
    { id: 'test', label: `$(debug-disconnect) ${studio.remote.test}` },
    { id: 'pcs', label: `$(key) ${studio.remote.pcs(report?.pcs.length)}`, detail: studio.remote.pcsBody },
    ...(movable ? [{ id: 'move' as const, label: `$(sync) ${studio.remote.moveTo(new URL(movable.replace(/^ws/, 'http')).host)}` }] : []),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { id: 'off', label: `$(circle-slash) ${studio.remote.turnOff}` },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: `${studio.remote.label} · ${mac.label}`, placeHolder: statusText(mac, report) });
  switch (picked?.id) {
    case 'route': {
      const choice = await vscode.window.showQuickPick((['auto', 'lan', 'internet'] as const).map((value) => ({ label: studio.route.choice[value], detail: studio.route.choiceHint[value], picked: value === remote.route, value })), { title: studio.remote.connection });
      if (choice && choice.value !== remote.route) await setOption(model, mac, { route: choice.value });
      return;
    }
    case 'relay': {
      const choice = await vscode.window.showQuickPick((['allow', 'never', 'always'] as const).map((value) => ({ label: studio.route.relay[value], detail: studio.route.relayHint[value], picked: value === remote.relay, value })), { title: studio.remote.relay });
      if (choice && choice.value !== remote.relay) await setOption(model, mac, { relay: choice.value });
      return;
    }
    case 'awake':
      await setOption(model, mac, { keepAwake: !remote.keepAwake });
      return;
    case 'test':
      await testConnection(model, mac);
      return;
    case 'pcs':
      await managePcs(model, mac, report);
      return;
    case 'move':
      if (movable) await setOption(model, mac, { signalUrl: movable });
      return;
    case 'off':
      await turnRemoteOff(model, mac);
      return;
  }
}

/** The remote access server: change it, or clear it (empty). One set by CAPMAC_SIGNAL_URL can't be changed here. */
export async function remoteServer(model: Model): Promise<void> {
  const server = await model.client.invoke('remote.server', {});
  if (server.source === 'environment') {
    void vscode.window.showInformationMessage(studio.settings.server, { detail: `${server.url ?? ''}\n${tidy(studio.settings.serverFromEnv).replace(/`/g, '')}` } as vscode.MessageOptions);
    return;
  }
  const url = await vscode.window.showInputBox({
    title: studio.settings.server,
    prompt: server.source === 'built-in' ? `${studio.settings.serverDesc}. ${s.remote.builtIn}` : `${studio.settings.serverDesc}. ${s.remote.emptyClears}`,
    value: server.url ?? '',
    placeHolder: studio.remote.server.placeholder,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() && signalUrlProblem(value) ? tidy(signalUrlProblem(value)) : undefined),
  });
  if (url === undefined || url.trim() === (server.url ?? '')) return;
  try {
    const saved = await model.client.invoke('remote.setServer', { url: url.trim() || null });
    void vscode.window.showInformationMessage(saved.url ? studio.settings.serverSaved : studio.settings.serverCleared);
  } catch (err) {
    failed(studio.remote.toast.changeFailed, err);
  }
}
