import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canConnect, loadProject, MacSession, requireIos, UserError, type ProjectInfo } from '@capmac/core/engine';
import type { Target, TargetsResult } from '@capmac/core/shared/protocol';
import { isTakeoverCommand, parseCapArgs, stringOption, type CapInvocation } from '../takeover/cap-args.js';
import { log, pc } from '../ui.js';
import { buildCommand } from './build.js';
import { devCommand } from './dev.js';
import { runCommand } from './run.js';
import { refreshThisTakeover } from './takeover.js';
import { openXcodeCommand } from './tools.js';

/** Capacitor's --xcode-export-method values, as capmac export kinds. */
const EXPORT_KINDS: Record<string, string> = {
  'app-store-connect': 'app-store',
  'release-testing': 'ad-hoc',
  enterprise: 'enterprise',
  debugging: 'development',
};

/**
 * `capmac cap <capacitor arguments>`: runs `cap run ios`, `cap open ios` and
 * `cap build ios` on the Mac, reading Capacitor's own options. The takeover
 * preload sends `npx cap …` and `ionic cap …` here.
 */
export async function capCommand(args: string[]): Promise<void> {
  const inv = parseCapArgs(args);
  if (!isTakeoverCommand(inv)) {
    throw new UserError(
      'CapMac runs `cap run ios`, `cap open ios` and `cap build ios` on the Mac.',
      `Everything else works on this PC as it is: npx cap ${args.join(' ')}`,
    );
  }
  const viaCapacitor = process.env.CAPMAC_VIA === 'capacitor';
  if (viaCapacitor) await refreshThisTakeover().catch(() => undefined);
  // Ionic reads this JSON from stdout to pick a target, so nothing else may go there.
  if (inv.command === 'run' && inv.options.list) return listTargets(inv.options.json === true);

  if (viaCapacitor) log.dim(`capmac: running ${pc.bold(`cap ${inv.command} ios`)} on your Mac ${pc.dim('(CAPMAC_TAKEOVER=0 runs Capacitor here instead)')}`);
  const scheme = stringOption(inv, 'scheme');
  const configuration = stringOption(inv, 'configuration');

  if (inv.command === 'open') return openXcodeCommand({});

  const project = await loadProject(process.cwd());
  requireIos(project);

  if (inv.command === 'build') {
    const method = stringOption(inv, 'xcode-export-method') ?? 'app-store-connect';
    const exportKind = EXPORT_KINDS[method];
    if (!exportKind) {
      throw new UserError(`CapMac cannot export with --xcode-export-method ${method}.`, `Use one of: ${Object.keys(EXPORT_KINDS).join(', ')}.`);
    }
    if (inv.options['xcode-signing-style'] === 'manual') {
      log.warn('CapMac signs automatically, with your team or App Store Connect API key; --xcode-signing-style manual and its certificate and profile are ignored.');
    }
    return buildCommand({
      ipa: true,
      export: exportKind,
      team: stringOption(inv, 'xcode-team-id'),
      scheme,
      configuration: configuration ?? 'Release',
      webBuild: false,
      // Where `cap build ios` puts it.
      out: path.join(project.capDir, project.iosDir, 'App', 'output'),
    });
  }

  const targetName = stringOption(inv, 'target-name');
  const sdk = stringOption(inv, 'target-name-sdk-version');
  const target = stringOption(inv, 'target') ?? (targetName && sdk ? `${targetName} ${sdk}` : targetName);
  const live = await liveReload(inv, project);
  if (live) return devCommand({ target, scheme, configuration, url: live.url });
  // Like `cap run`, no web build (that is `npm run build`'s job, or Ionic's). In a
  // terminal capmac stays attached to show the app's console; scripts get control back.
  return runCommand({ target, scheme, configuration, webBuild: false, logs: Boolean(process.stdout.isTTY) });
}

/**
 * Whether this run is live reload, and the dev server to use (undefined: capmac
 * starts it). Null for a normal run.
 */
export async function liveReload(inv: CapInvocation, project: Pick<ProjectInfo, 'capDir' | 'iosDir'>): Promise<{ url?: string } | null> {
  // npx cap run ios -l [--host <host>] [--port <port>] [--https]
  if (inv.options['live-reload'] === true) {
    const host = stringOption(inv, 'host');
    const port = stringOption(inv, 'port');
    if (!host && !port) return {};
    return { url: `${inv.options.https === true ? 'https' : 'http'}://${host ?? 'localhost'}${port ? `:${port}` : ''}` };
  }
  // ionic cap run ios -l: Ionic starts the dev server, writes its URL into the iOS
  // app's generated capacitor.config.json and then runs `cap run ios --no-sync`.
  if (inv.options.sync !== false) return null;
  const url = await generatedServerUrl(project);
  if (!url || !isThisPc(url.hostname)) return null;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  // A URL left behind by an interrupted session is not live reload.
  return (await canConnect(url.hostname, port)) ? { url: url.href } : null;
}

async function generatedServerUrl(project: Pick<ProjectInfo, 'capDir' | 'iosDir'>): Promise<URL | null> {
  try {
    const file = path.join(project.capDir, project.iosDir, 'App', 'App', 'capacitor.config.json');
    const config = JSON.parse(await fs.readFile(file, 'utf8')) as { server?: { url?: unknown } };
    return typeof config.server?.url === 'string' ? new URL(config.server.url) : null;
  } catch {
    return null;
  }
}

export function isThisPc(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.') || host === os.hostname().toLowerCase()) return true;
  return Object.values(os.networkInterfaces()).some((list) => list?.some((i) => i.address.toLowerCase() === host));
}

/** A Mac target the way `cap run --list` shows one. */
export function capTarget(t: Target): { name: string; api: string; id: string } {
  return { name: t.kind === 'simulator' ? `${t.name} (simulator)` : t.name, api: `iOS ${t.osVersion}`, id: t.udid };
}

async function listTargets(json: boolean): Promise<void> {
  const project = await loadProject(process.cwd()).catch(() => null);
  const session = await MacSession.open({ host: project?.config.host });
  try {
    const all = await session.call<TargetsResult>('targets');
    const rows = [...all.devices, ...all.simulators].filter((t) => t.available).map(capTarget);
    if (json) {
      process.stdout.write(`${JSON.stringify(rows)}\n`);
      return;
    }
    const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
    const apiWidth = Math.max(3, ...rows.map((r) => r.api.length));
    log.line(pc.bold(`${'Name'.padEnd(nameWidth)} ${'API'.padEnd(apiWidth)} Target ID`));
    for (const r of rows) log.line(`${r.name.padEnd(nameWidth)} ${r.api.padEnd(apiWidth)} ${r.id}`);
  } finally {
    session.close();
  }
}
