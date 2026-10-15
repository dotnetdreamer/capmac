import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  capmacDir,
  cleanOnMac,
  commandLine,
  execOnMac,
  loadProject,
  MacLink,
  MacSession,
  openInXcode,
  Pipeline,
  pullFromMac,
  describeFlavor,
  electronPlan,
  macTarget,
  runsOnMac,
  largestFolders,
  scanOptionsFor,
  scanProject,
  streamAppLogs,
  syncToMac,
  unlockKeychain,
  UserError,
  withStep,
} from '@capmac/core/engine';
import type { Target, TargetsResult } from '@capmac/core/shared/protocol';
import { cancelOnSigint, openForProject, type MacOption } from '../cli-context.js';
import { reportError } from '../report.js';
import { terminalContext } from '../terminal.js';
import { canPrompt, confirm, formatBytes, log, pc, plural } from '../ui.js';
import type { SoundMode } from '@capmac/core/shared/electron';
import { ScreenViewer } from '../viewer/server.js';

function targetRow(t: Target, nameWidth: number): string {
  if (t.kind === 'mac') return `  ${t.name.padEnd(nameWidth)}  ${t.os.padEnd(11)}  ${pc.green('ready    ')}  ${pc.dim(t.udid)}`;
  const state = t.kind === 'simulator'
    ? t.state === 'Booted' ? pc.green('booted   ') : pc.dim('shut down')
    : t.state === 'connected' ? pc.green(t.connection === 'network' ? 'connected (Wi-Fi)' : 'connected (USB)') : t.available ? pc.yellow('paired') : pc.red('not connected');
  return `  ${t.name.padEnd(nameWidth)}  ${t.os.padEnd(11)}  ${state}  ${pc.dim(t.udid)}`;
}

export async function targetsCommand(options: MacOption & { json?: boolean; electron?: boolean }): Promise<void> {
  const { ctx } = terminalContext();
  const config = await loadProject(process.cwd()).catch(() => null);
  const session = await MacSession.open({ host: options.mac ?? config?.config.host });
  try {
    const all = await withStep(ctx, `Listing simulators and devices on ${session.label}`, 'other', () => session.call<TargetsResult>('targets'));
    // The Mac's own desktop, where an Electron app runs.
    const mac = options.electron || config?.electron ? macTarget(session.label, session.host.macos) : null;
    if (options.json) {
      process.stdout.write(`${JSON.stringify(mac ? { ...all, mac } : all, null, 2)}\n`);
      return;
    }
    const width = Math.min(40, Math.max(12, ...[...all.devices, ...all.simulators, ...(mac ? [mac] : [])].map((t) => t.name.length)));
    if (mac) {
      log.line(pc.bold('Mac (Electron)'));
      log.line(targetRow(mac, width));
    }
    log.line(pc.bold('Devices'));
    if (all.devices.length) for (const d of all.devices) log.line(targetRow(d, width));
    else log.line(pc.dim(all.deviceSupport ? '  none connected (plug one into the Mac, or pair it over Wi-Fi in Xcode)' : '  needs Xcode 15+ on the Mac'));
    log.line(pc.bold('Simulators'));
    if (all.simulators.length) for (const s of all.simulators) log.line(targetRow(s, width));
    else log.line(pc.dim('  none installed'));
    log.line();
    const electronHint = mac && config?.kind === 'capacitor' && config.hasIos ? `, or the Electron app with ${pc.cyan('capmac run --electron')}` : '';
    log.dim(`Pick one with ${pc.cyan('capmac run --target "iPhone 16"')} or ${pc.cyan('capmac run --device')}${electronHint}.`);
  } finally {
    session.close();
  }
}

/** Shows what capmac detected about the project and which files it would sync. */
export async function infoCommand(options: { files?: boolean; live?: boolean }): Promise<void> {
  const project = await loadProject(process.cwd());
  const electron = project.electron;
  const plan = electron ? electronPlan(project) : null;
  const launch = plan ? ('electron' in plan.launch ? `electron ${plan.launch.electron.join(' ')}` : plan.launch.command) : '';
  const electronRows: Array<[string, string]> = electron && plan
    ? [
        [project.kind === 'electron' ? 'Electron app' : 'Electron platform', `${electron.rel ? `${electron.rel}/ · ` : ''}${describeFlavor(electron.flavor)}${electron.electronRange ? ` · electron ${electron.electronRange}` : ''}`],
        ['On the Mac: build', plan.build ?? pc.dim('nothing to build')],
        ['On the Mac: launch', launch],
        ['Live reload', plan.dev ? plan.dev.command : electron.flavor === 'capacitor' ? 'your dev server, through a tunnel' : pc.dim('CapMac reloads the windows, or restarts the app')],
      ]
    : [];
  const rows: Array<[string, string]> = project.kind === 'electron'
    ? [
        ['App', `${project.appName} (${project.appId})`],
        ['Project', project.capDir],
        ['Synced folder', project.syncRoot + (project.projectRel ? pc.dim(`  (app in ${project.projectRel}/)`) : '')],
        ...electronRows,
        ['Package manager', project.packageManager],
        ['Mac', project.config.host ?? pc.dim('default')],
        ['Project id on the Mac', project.projectId],
      ]
    : [
        ['App', `${project.appName} (${project.appId})`],
        ['Capacitor project', project.capDir],
        ['Synced folder', project.syncRoot + (project.projectRel ? pc.dim(`  (app in ${project.projectRel}/)`) : '')],
        ['Web assets', project.webDir],
        ['iOS platform', project.hasIos ? `${project.iosDir}/App · ${project.iosPackageManager}` : electron ? pc.dim('not added') : pc.red('missing (npx cap add ios)')],
        ...(project.hasIos
          ? ([
              ['Scheme', project.config.ios?.scheme ?? project.scheme],
              ['Team ID', project.config.ios?.team ?? project.teamId ?? pc.dim('not set (only needed for devices)')],
            ] as Array<[string, string]>)
          : []),
        ...electronRows,
        ['Package manager', project.packageManager],
        ['Mac', project.config.host ?? pc.dim('default')],
        ['Project id on the Mac', project.projectId],
      ];
  for (const [k, v] of rows) log.line(`${pc.dim(k.padEnd(22))} ${v}`);
  const scan = await scanProject(scanOptionsFor(project, !options.live));
  const total = scan.files.reduce((sum, f) => sum + f.size, 0);
  log.line();
  log.line(`${pc.bold('Would sync')} ${plural(scan.files.length, 'file')} (${formatBytes(total)})${options.live ? pc.dim(' — live mode, web assets left out') : ''}`);
  const groups = new Map<string, { count: number; bytes: number }>();
  for (const f of scan.files) {
    const parts = f.rel.split('/');
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : parts[0]!;
    const g = groups.get(key) ?? { count: 0, bytes: 0 };
    g.count += 1;
    g.bytes += f.size;
    groups.set(key, g);
  }
  for (const [key, g] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15)) {
    log.line(`  ${key.padEnd(40)} ${String(g.count).padStart(6)} files  ${formatBytes(g.bytes).padStart(9)}`);
  }
  if (groups.size > 15) log.dim(`  … and ${groups.size - 15} more`);
  if (options.files) for (const f of scan.files) log.line(`  ${f.rel}${f.mode === 0o755 ? pc.dim('  (executable)') : ''}`);
  else log.dim('  (list every file with --files; exclude more with a .capmacignore file)');
  if (scan.leftOnPc.length > 0) {
    const kept = scan.leftOnPc.reduce((sum, f) => sum + f.size, 0);
    log.line();
    log.line(`${pc.bold('Kept on this PC')} ${plural(scan.leftOnPc.length, 'file')} (${formatBytes(kept)}): videos, design and large files nothing on the Mac reads`);
    for (const g of largestFolders(scan.leftOnPc, 5)) log.line(`  ${`${g.folder}/`.padEnd(40)} ${String(g.files).padStart(6)} files  ${formatBytes(g.bytes).padStart(9)}`);
    log.dim('  (send one anyway with a `!path` line in .capmacignore)');
  }
}

export async function syncCommand(options: MacOption & { live?: boolean; full?: boolean; prepare?: boolean }): Promise<void> {
  const { ctx } = terminalContext();
  const { project, session } = await openForProject(options);
  try {
    const pipeline = new Pipeline(session, project, ctx);
    await pipeline.sync(!options.live);
    if (options.prepare !== false && project.hasIos) await pipeline.prepare(null, { full: options.full });
  } finally {
    session.close();
  }
}

export async function execCommand(command: string[], options: MacOption & { cwd?: 'project' | 'root' | 'ios'; sync?: boolean }): Promise<void> {
  if (command.length === 0) throw new UserError('Nothing to run.', 'Example: capmac exec -- pod --version');
  const { ctx } = terminalContext();
  const { project, session } = await openForProject(options);
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  try {
    if (options.sync !== false) await syncToMac(session, project, { includeWebDir: true, signal: controller.signal }, ctx);
    const line = commandLine(command);
    log.dim(`$ ${line}`);
    const code = await execOnMac(session, project, line, {
      cwd: options.cwd ?? 'project',
      signal: controller.signal,
      onOutput: (stream, text) => (stream === 'stderr' ? process.stderr : process.stdout).write(`${text}\n`),
    });
    process.exitCode = code ?? 1;
  } finally {
    restore();
    session.close();
  }
}

export async function pullCommand(paths: string[], options: MacOption & { yes?: boolean }): Promise<void> {
  if (paths.length === 0) throw new UserError('Say what to copy back, e.g. `capmac pull ios`.');
  const { ctx } = terminalContext();
  const { project, session } = await openForProject(options);
  try {
    const existing = [];
    for (const p of paths) {
      try {
        await fs.access(path.join(project.capDir, p));
        existing.push(p);
      } catch {
        // new path
      }
    }
    if (existing.length && !options.yes) {
      if (!canPrompt()) throw new UserError(`${existing.join(', ')} already exist locally.`, 'Pass --yes to overwrite.');
      if (!(await confirm(`Overwrite files in ${existing.join(', ')} with the Mac's copies?`, false))) return;
    }
    await pullFromMac(session, project, paths, ctx);
  } finally {
    session.close();
  }
}

export async function openXcodeCommand(options: MacOption): Promise<void> {
  const { ctx } = terminalContext();
  const { project, session } = await openForProject(options);
  try {
    const opened = await openInXcode(session, project, ctx);
    log.dim(`  ${opened}`);
  } finally {
    session.close();
  }
}

export async function cleanCommand(options: MacOption & { all?: boolean }): Promise<void> {
  const { ctx } = terminalContext();
  const { project, session } = await openForProject(options);
  try {
    const removed = await cleanOnMac(session, project, Boolean(options.all), ctx);
    log.dim(`  ${removed}`);
  } finally {
    session.close();
  }
}

export async function keychainCommand(options: MacOption & { allowCodesign?: boolean }): Promise<void> {
  const { ctx } = terminalContext();
  const config = await loadProject(process.cwd()).catch(() => null);
  const session = await MacSession.open({ host: options.mac ?? config?.config.host });
  try {
    const result = await unlockKeychain(session, ctx, options.allowCodesign !== false);
    if (result.partitionList) log.dim('  codesign may now use your signing keys over SSH without a GUI prompt.');
  } finally {
    session.close();
  }
}

export async function logsCommand(options: MacOption & { target?: string }): Promise<void> {
  const { ctx } = terminalContext();
  const { project, session } = await openForProject(options);
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  try {
    const pipeline = new Pipeline(session, project, ctx);
    const target = await pipeline.chooseTarget({ target: options.target, simulator: true });
    log.info(`Streaming logs of ${project.scheme} on ${target.name} (Ctrl+C to stop)`);
    await streamAppLogs(session, project, target, ctx, controller.signal);
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  } finally {
    restore();
    session.close();
  }
}

export async function screenCommand(options: MacOption & { target?: string; device?: boolean; port?: string; open?: boolean; electron?: boolean; sound?: SoundMode }): Promise<void> {
  const { ctx } = terminalContext();
  const project = await loadProject(process.cwd());
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: true });
  let viewer: ScreenViewer | null = null;
  try {
    const session = await link.session();
    if (runsOnMac(project, options)) {
      // The Electron app's window: it shows once the app runs (`capmac run` or `capmac dev` in another terminal).
      const title = `${project.appName} · ${session.label}`;
      viewer = await ScreenViewer.start(link, { kind: 'app', projectId: project.projectId, label: session.label }, { title, port: options.port ? Number(options.port) : undefined });
      if (options.sound) await viewer.setSound(options.sound);
      if (options.open !== false) viewer.open();
      log.dim(`Shows ${project.appName}'s window while it runs on the Mac. Press Ctrl+C to stop.`);
      await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      return;
    }
    const pipeline = new Pipeline(session, project, ctx);
    // A simulator, or (--device, or --target naming it) an iPhone plugged into the Mac.
    const target = await pipeline.chooseTarget(options.device ? { target: options.target, device: true } : { target: options.target, simulator: !options.target });
    if (target.kind === 'simulator' && target.state !== 'Booted') await pipeline.call('boot', { target }).catch((err) => reportError(err));
    viewer = await ScreenViewer.start(link, target, { title: `${project.appName} · ${target.name}`, port: options.port ? Number(options.port) : undefined });
    if (options.open !== false) viewer.open();
    if (target.kind === 'device') log.dim(`Shows ${target.name}'s screen while it is plugged into the Mac with a cable (view only). Press Ctrl+C to stop.`);
    else log.dim('Press Ctrl+C to stop sharing the screen.');
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  } finally {
    await viewer?.close().catch(() => undefined);
    link.close();
  }
}
