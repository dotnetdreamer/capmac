import type { ProbeResult } from '../../shared/protocol.js';
import { loadGlobalConfig, resolveHost } from '../config.js';
import { UserError } from '../errors.js';
import { loadProject, usesSceneLifecycle, type ProjectInfo } from '../project.js';
import { discoverRuntime, parseNodeVersion, RECOMMENDED_NODE_MAJOR } from '../remote-env.js';
import { MacSession } from '../session.js';
import { ask, canPrompt, confirm, log, password, pc, withStep } from '../ui.js';
import { ensureNode } from './pair.js';

type Level = 'ok' | 'warn' | 'fail' | 'info';

interface Check {
  level: Level;
  label: string;
  detail?: string;
  fix?: string;
}

function mark(level: Level): string {
  return level === 'ok' ? pc.green('✔') : level === 'warn' ? pc.yellow('▲') : level === 'fail' ? pc.red('✖') : pc.cyan('●');
}

function printChecks(title: string, checks: Check[]): void {
  log.line(pc.bold(title));
  for (const c of checks) {
    log.line(`  ${mark(c.level)} ${c.label}${c.detail ? pc.dim(`  ${c.detail}`) : ''}`);
    if (c.fix && c.level !== 'ok') log.line(`      ${pc.dim('→')} ${c.fix}`);
  }
}

export function macChecks(probe: ProbeResult, project?: ProjectInfo | null): Check[] {
  const checks: Check[] = [];
  checks.push({ level: 'info', label: `${probe.computerName ?? probe.hostname}`, detail: `macOS ${probe.macos ?? '?'} · ${probe.arch === 'arm64' ? 'Apple silicon' : 'Intel'} · user ${probe.user}` });
  if (!probe.xcode) {
    checks.push({ level: 'fail', label: 'Xcode', detail: 'not found', fix: 'Install Xcode from the Mac App Store, open it once, then run `capmac doctor` again.' });
  } else if (!probe.xcode.ready) {
    checks.push({ level: 'fail', label: `Xcode ${probe.xcode.version}`.trim(), detail: 'not ready', fix: probe.xcode.problem });
  } else {
    const major = Number(probe.xcode.version.split('.')[0]);
    checks.push({ level: major >= 16 ? 'ok' : 'warn', label: `Xcode ${probe.xcode.version}`, detail: probe.xcode.build, fix: major >= 16 ? undefined : 'Capacitor 7+ needs Xcode 16 or newer.' });
  }
  const runtimes = probe.simulators.runtimes;
  checks.push(runtimes.length
    ? { level: 'ok', label: `iOS simulators`, detail: `${probe.simulators.devices} devices · ${runtimes.join(', ')}` }
    : { level: 'fail', label: 'iOS simulators', detail: 'no iOS runtime installed', fix: 'Run `capmac doctor --fix` (downloads the iOS platform) or Xcode › Settings › Components.' });
  const nodeMajor = parseNodeVersion(probe.node.version)?.[0] ?? 0;
  checks.push({ level: nodeMajor >= RECOMMENDED_NODE_MAJOR ? 'ok' : 'warn', label: `Node.js ${probe.node.version}`, detail: probe.node.path, fix: nodeMajor >= RECOMMENDED_NODE_MAJOR ? undefined : 'Run `capmac doctor --fix` to install a current Node.js LTS for capmac.' });
  checks.push(probe.npm ? { level: 'ok', label: `npm ${probe.npm}` } : { level: 'fail', label: 'npm', detail: 'not found next to Node.js', fix: 'Reinstall Node.js on the Mac, or run `capmac doctor --fix`.' });
  const needsPods = project?.iosPackageManager === 'CocoaPods';
  const pod = probe.tools.pod;
  if (pod) checks.push({ level: 'ok', label: `CocoaPods ${pod.version}` });
  else checks.push({ level: needsPods ? 'fail' : 'info', label: 'CocoaPods', detail: needsPods ? 'needed by this project' : 'not installed (only needed for CocoaPods projects)', fix: needsPods ? 'Run `capmac doctor --fix` (brew install cocoapods), or migrate to SPM with `npx cap spm-migration-assistant`.' : undefined });
  checks.push(probe.tools.axe
    ? { level: 'ok', label: 'AXe', detail: 'touch input for `capmac screen`' }
    : { level: 'info', label: 'AXe', detail: 'not installed: `capmac screen` will be view-only', fix: 'Run `capmac doctor --fix` to install it with Homebrew.' });
  if (probe.freeDiskGb !== null) {
    checks.push({ level: probe.freeDiskGb >= 15 ? 'ok' : probe.freeDiskGb >= 5 ? 'warn' : 'fail', label: 'Free disk space', detail: `${probe.freeDiskGb} GB`, fix: probe.freeDiskGb >= 15 ? undefined : 'Xcode builds need room; clear ~/Library/Developer/Xcode/DerivedData or old simulators (`xcrun simctl delete unavailable`).' });
  }
  const devIds = [...new Set(probe.signingIdentities.filter((i) => /Apple Development|iPhone Developer|Apple Distribution|iPhone Distribution/.test(i)))];
  checks.push(devIds.length
    ? { level: 'ok', label: 'Signing identities', detail: devIds.slice(0, 2).join(', ') + (devIds.length > 2 ? ` (+${devIds.length - 2})` : '') }
    : { level: 'info', label: 'Signing identities', detail: 'none (fine for simulators)', fix: 'For real devices: sign in to Xcode › Settings › Accounts on the Mac once.' });
  if (probe.keychainLocked) {
    checks.push({ level: 'info', label: 'Login keychain locked over SSH', detail: 'capmac will ask for your Mac password when a device build needs signing' });
  }
  if (probe.consoleUser && probe.consoleUser !== probe.user) {
    checks.push({
      level: 'warn',
      label: 'Desktop session',
      detail: probe.consoleUser === 'root' ? 'nobody is logged in at the Mac' : `"${probe.consoleUser}" is using the Mac's screen`,
      fix: `Simulators need ${probe.user} logged in to the Mac desktop (turn on automatic login if the Mac is headless).`,
    });
  }
  if (project && probe.xcode && Number(probe.xcode.version.split('.')[0]) >= 27 && usesSceneLifecycle(project) === false) {
    checks.push({ level: 'warn', label: 'UIScene lifecycle', detail: 'required by the iOS 27 SDK, missing in this app', fix: 'Run `npx cap migrate` (Capacitor 8.5+) to add SceneDelegate, otherwise the app will not launch.' });
  }
  return checks;
}

export function printProbe(probe: ProbeResult): void {
  printChecks('Mac', macChecks(probe));
}

export interface DoctorOptions {
  mac?: string;
  fix?: boolean;
  yes?: boolean;
}

async function sudo(session: MacSession, pw: string, command: string): Promise<{ code: number | null; output: string }> {
  const channel = await session.conn.exec(`sudo -S -p '' ${command}`);
  return new Promise((resolve) => {
    let output = '';
    channel.on('data', (d: Buffer) => (output += d.toString()));
    channel.stderr.on('data', (d: Buffer) => (output += d.toString()));
    channel.on('close', (code: number | null) => resolve({ code, output }));
    channel.end(`${pw}\n`);
  });
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  const local: Check[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  local.push({ level: nodeMajor >= 20 ? 'ok' : 'warn', label: `Node.js ${process.version} on this PC`, fix: nodeMajor >= 20 ? undefined : 'Update Node.js to 20 or newer.' });
  let project: ProjectInfo | null = null;
  try {
    project = await loadProject(process.cwd());
    local.push({ level: 'ok', label: `Capacitor app "${project.appName}"`, detail: `${project.appId} · web: ${project.webDir}` });
    local.push(project.hasIos
      ? { level: 'ok', label: `iOS platform (${project.iosPackageManager === 'unknown' ? 'detected' : project.iosPackageManager})`, detail: `${project.iosDir}/App` }
      : { level: 'fail', label: 'iOS platform', detail: 'missing', fix: 'Run `npx cap add ios` (add `--packagemanager SPM` for Swift Package Manager).' });
    if (project.syncRoot !== project.capDir) local.push({ level: 'info', label: 'Monorepo', detail: `syncing from ${project.syncRoot}` });
  } catch {
    local.push({ level: 'info', label: 'Not inside a Capacitor app', detail: 'project checks skipped' });
  }
  const config = await loadGlobalConfig();
  const host = resolveHost(config, options.mac ?? project?.config.host);
  local.push(host ? { level: 'ok', label: `Paired Mac "${host.name}"`, detail: `${host.username}@${host.host}` } : { level: 'fail', label: 'Paired Mac', detail: 'none', fix: 'Run `capmac pair`.' });
  printChecks('This PC', local);
  if (!host) return;

  log.line();
  const started = Date.now();
  let session: MacSession;
  try {
    session = await MacSession.open({ host: host.name });
  } catch (err: any) {
    printChecks('Mac', [{ level: 'fail', label: `Connect to ${host.host}`, detail: err?.message, fix: err?.hint ?? 'Check the Mac is awake and Remote Login is on.' }]);
    if (!(options.fix && err instanceof UserError && /Node\.js/.test(err.message))) return;
    // Missing Node.js: connect without the agent and install it.
    const { MacConnection } = await import('../ssh.js');
    const { ensureClientKey } = await import('../config.js');
    const conn = await MacConnection.connect({ host: host.host, port: host.port, username: host.username, privateKey: (await ensureClientKey()).privateKey, verifyHostKey: (fp) => fp === host.hostKey });
    try {
      const runtime = await discoverRuntime(conn);
      const nodePath = await ensureNode(conn, runtime, { yes: options.yes });
      if (nodePath) {
        const { updateHost } = await import('../config.js');
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
    const probe = await withStep(`Checking ${session.label}`, () => session.call<ProbeResult>('probe'), () => `connected in ${latency}ms`);
    const checks = macChecks(probe, project);
    printChecks('Mac', checks);
    const failing = checks.filter((c) => c.level === 'fail' || c.level === 'warn');
    if (!options.fix) {
      log.line();
      if (failing.length) log.line(`Run ${pc.cyan('capmac doctor --fix')} to let capmac fix what it can.`);
      else log.success('Everything looks good.');
      return;
    }
    await applyFixes(session, probe, project, options);
  } finally {
    session.close();
  }
}

async function applyFixes(session: MacSession, probe: ProbeResult, project: ProjectInfo | null, options: DoctorOptions): Promise<void> {
  log.line();
  const yes = (q: string) => (options.yes ? Promise.resolve(true) : canPrompt() ? confirm(q) : Promise.resolve(false));
  let sudoPassword: string | null = null;
  const getSudo = async () => {
    sudoPassword ??= await password(`Mac password for ${session.host.username} (for sudo on the Mac):`);
    return sudoPassword;
  };

  const nodeMajor = parseNodeVersion(probe.node.version)?.[0] ?? 0;
  if (nodeMajor < RECOMMENDED_NODE_MAJOR) {
    const runtime = await discoverRuntime(session.conn);
    const nodePath = await ensureNode(session.conn, runtime, { yes: options.yes });
    if (nodePath) {
      const { updateHost } = await import('../config.js');
      await updateHost(session.host.name, { nodePath });
    }
  }

  if (probe.xcode && !probe.xcode.ready && probe.xcode.problem) {
    if (/license/i.test(probe.xcode.problem) && (await yes('Accept the Xcode license on the Mac (sudo xcodebuild -license accept)?'))) {
      const r = await withStep('Accepting the Xcode license', async () => sudo(session, await getSudo(), 'xcodebuild -license accept'));
      if (r.code !== 0) log.error(r.output.trim());
    }
    if (await yes('Run Xcode\'s first-launch setup (sudo xcodebuild -runFirstLaunch)?')) {
      const r = await withStep('Running Xcode first-launch setup', async () => sudo(session, await getSudo(), 'xcodebuild -runFirstLaunch'));
      if (r.code !== 0) log.error(r.output.trim());
    }
  }

  if (probe.xcode && probe.simulators.runtimes.length === 0 && (await yes('Download the iOS simulator platform now (several GB, can take a while)?'))) {
    await withStep('Downloading the iOS platform (xcodebuild -downloadPlatform iOS)', async (s) => {
      const r = await session.call<{ code: number | null }>('exec', { projectId: '_doctor', projectRel: '', command: 'xcodebuild -downloadPlatform iOS', cwd: 'home' }, {
        onEvent: (e) => {
          if (e.t === 'out') s.update(e.text.trim().slice(0, 100));
        },
      }).catch((e) => ({ code: 1, error: e }));
      if ((r as any).code !== 0) throw new UserError('Downloading the iOS platform failed. Try Xcode › Settings › Components on the Mac.');
    });
  }

  const brewWanted: string[] = [];
  if (!probe.tools.axe) brewWanted.push('axe');
  if (!probe.tools.pod && project?.iosPackageManager === 'CocoaPods') brewWanted.push('cocoapods');
  if (brewWanted.length) {
    if (!probe.tools.brew) {
      log.warn(`Homebrew is not installed, so capmac cannot install ${brewWanted.join(', ')}. Get it from https://brew.sh.`);
    } else if (await yes(`Install ${brewWanted.join(' and ')} with Homebrew on the Mac?`)) {
      const { EventRenderer } = await import('../render.js');
      const renderer = new EventRenderer();
      await session.call('install-tools', { tools: brewWanted }, { onEvent: renderer.handle }).catch((err) => {
        renderer.failOpenSteps();
        log.error(err?.message ?? String(err));
      });
    }
  }
  void ask;
  log.line();
  log.success('Done. Run `capmac doctor` to check again.');
}
