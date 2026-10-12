import {
  applyFixes,
  discoverRuntime,
  ensureClientKey,
  ensureNode,
  loadGlobalConfig,
  loadProject,
  localChecks,
  MacConnection,
  macChecks,
  MacSession,
  resolveHost,
  updateHost,
  UserError,
  withStep,
  type Check,
  type CheckLevel,
  type ProjectInfo,
} from '@capmac/core/engine';
import type { ProbeResult } from '@capmac/core/shared/protocol';
import { terminalContext } from '../terminal.js';
import { log, pc } from '../ui.js';

function mark(level: CheckLevel): string {
  return level === 'ok' ? pc.green('✔') : level === 'warn' ? pc.yellow('▲') : level === 'fail' ? pc.red('✖') : pc.cyan('●');
}

export function printChecks(title: string, checks: Check[]): void {
  log.line(pc.bold(title));
  for (const c of checks) {
    log.line(`  ${mark(c.level)} ${c.label}${c.detail ? pc.dim(`  ${c.detail}`) : ''}`);
    if (c.fix && c.level !== 'ok') log.line(`      ${pc.dim('→')} ${c.fix}`);
  }
}

export function printProbe(probe: ProbeResult): void {
  printChecks('Mac', macChecks(probe));
}

export interface DoctorOptions {
  mac?: string;
  fix?: boolean;
  yes?: boolean;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  const { ctx } = terminalContext();
  let project: ProjectInfo | null = null;
  try {
    project = await loadProject(process.cwd());
  } catch {
    // not inside a Capacitor app: project checks are skipped
  }
  const config = await loadGlobalConfig();
  const host = resolveHost(config, options.mac ?? project?.config.host);
  printChecks('This PC', localChecks(project, host));
  if (!host) return;

  log.line();
  const started = Date.now();
  let session: MacSession;
  try {
    session = await MacSession.open({ host: host.name });
  } catch (err: any) {
    printChecks('Mac', [{ id: 'connect', group: 'mac', level: 'fail', label: `Connect to ${host.host}`, detail: err?.message, fix: err?.hint ?? 'Check the Mac is awake and Remote Login is on.' }]);
    if (!(options.fix && err instanceof UserError && /Node\.js/.test(err.message))) return;
    // Missing Node.js: connect without the agent and install it.
    const conn = await MacConnection.connect({ host: host.host, port: host.port, username: host.username, privateKey: (await ensureClientKey()).privateKey, verifyHostKey: (fp) => fp === host.hostKey });
    try {
      const runtime = await discoverRuntime(conn);
      const nodePath = await ensureNode(conn, runtime, { yes: options.yes }, ctx);
      if (nodePath) {
        await updateHost(host.name, { nodePath, home: runtime.home });
        log.success('Node.js installed. Run `capmac doctor` again.');
      }
    } finally {
      conn.close();
    }
    return;
  }
  try {
    const latency = Date.now() - started;
    const probe = await withStep(ctx, `Checking ${session.label}`, 'other', () => session.call<ProbeResult>('probe'), () => `connected in ${latency}ms`);
    const checks = macChecks(probe, project);
    printChecks('Mac', checks);
    const failing = checks.filter((c) => c.level === 'fail' || c.level === 'warn');
    if (!options.fix) {
      log.line();
      if (failing.length) log.line(`Run ${pc.cyan('capmac doctor --fix')} to let CapMac fix what it can.`);
      else log.success('Everything looks good.');
      return;
    }
    log.line();
    await applyFixes(session, checks, ctx, { yes: options.yes });
    log.line();
    log.success('Done. Run `capmac doctor` to check again.');
  } finally {
    session.close();
  }
}
