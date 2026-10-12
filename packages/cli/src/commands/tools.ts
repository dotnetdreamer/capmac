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
import { ScreenViewer } from '../viewer/server.js';

function targetRow(t: Target, nameWidth: number): string {
  const state = t.kind === 'simulator'
    ? t.state === 'Booted' ? pc.green('booted   ') : pc.dim('shut down')
    : t.state === 'connected' ? pc.green(t.connection === 'network' ? 'connected (Wi-Fi)' : 'connected (USB)') : t.available ? pc.yellow('paired') : pc.red('not connected');
  return `  ${t.name.padEnd(nameWidth)}  ${t.os.padEnd(11)}  ${state}  ${pc.dim(t.udid)}`;
}

export async function targetsCommand(options: MacOption & { json?: boolean }): Promise<void> {
  const { ctx } = terminalContext();
  const config = await loadProject(process.cwd()).catch(() => null);
  const session = await MacSession.open({ host: options.mac ?? config?.config.host });
  try {
    const all = await withStep(ctx, `Listing simulators and devices on ${session.label}`, 'other', () => session.call<TargetsResult>('targets'));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
      return;
    }
    const width = Math.min(40, Math.max(12, ...[...all.devices, ...all.simulators].map((t) => t.name.length)));
    log.line(pc.bold('Devices'));
    if (all.devices.length) for (const d of all.devices) log.line(targetRow(d, width));
    else log.line(pc.dim(all.deviceSupport ? '  none connected (plug one into the Mac, or pair it over Wi-Fi in Xcode)' : '  needs Xcode 15+ on the Mac'));
    log.line(pc.bold('Simulators'));
    if (all.simulators.length) for (const s of all.simulators) log.line(targetRow(s, width));
    else log.line(pc.dim('  none installed'));
    log.line();
    log.dim(`Pick one with ${pc.cyan('capmac run --target "iPhone 16"')} or ${pc.cyan('capmac run --device')}.`);
  } finally {
    session.close();
  }
}

/** Shows what capmac detected about the project and which files it would sync. */
export async function infoCommand(options: { files?: boolean; live?: boolean }): Promise<void> {
  const project = await loadProject(process.cwd());
  const rows: Array<[string, string]> = [
    ['App', `${project.appName} (${project.appId})`],
    ['Capacitor project', project.capDir],
    ['Synced folder', project.syncRoot + (project.projectRel ? pc.dim(`  (app in ${project.projectRel}/)`) : '')],
    ['Web assets', project.webDir],
    ['iOS platform', project.hasIos ? `${project.iosDir}/App · ${project.iosPackageManager}` : pc.red('missing (npx cap add ios)')],
    ['Scheme', project.config.ios?.scheme ?? project.scheme],
    ['Team ID', project.config.ios?.team ?? project.teamId ?? pc.dim('not set (only needed for devices)')],
    ['Package manager', project.packageManager],
    ['Mac', project.config.host ?? pc.dim('default')],
    ['Project id on the Mac', project.projectId],
  ];
  for (const [k, v] of rows) log.line(`${pc.dim(k.padEnd(22))} ${v}`);
  const scan = await scanProject({
    root: project.syncRoot,
    projectRel: project.projectRel,
    webDir: project.webDir,
    iosDir: project.iosDir,
    includeWebDir: !options.live,
    include: project.config.sync?.include,
    exclude: project.config.sync?.exclude,
    cacheFile: path.join(capmacDir(), 'cache', `${project.projectId}.json`),
  });
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

export async function screenCommand(options: MacOption & { target?: string; port?: string; open?: boolean }): Promise<void> {
  const { ctx } = terminalContext();
  const project = await loadProject(process.cwd());
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: true });
  let viewer: ScreenViewer | null = null;
  try {
    const session = await link.session();
    const pipeline = new Pipeline(session, project, ctx);
    const target = await pipeline.chooseTarget({ target: options.target, simulator: true });
    if (target.kind !== 'simulator') throw new UserError('The remote screen works with simulators only.');
    if (target.state !== 'Booted') await pipeline.call('boot', { target }).catch((err) => reportError(err));
    viewer = await ScreenViewer.start(link, target, { title: `${project.appName} · ${target.name}`, port: options.port ? Number(options.port) : undefined });
    if (options.open !== false) viewer.open();
    log.dim('Press Ctrl+C to stop sharing the screen.');
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  } finally {
    await viewer?.close().catch(() => undefined);
    link.close();
  }
}
