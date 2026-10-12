/**
 * Health checks for this PC, the connection and the Mac, and the fixes capmac
 * can apply itself (`capmac doctor --fix`, the app's one-click fixes).
 */
import type { ProbeResult, StreamHelperState } from '../shared/protocol.js';
import type { HostConfig } from './config.js';
import { updateHost } from './config.js';
import { log, withStep, type EngineContext } from './context.js';
import type { Check, FixId } from './events.js';
import { UserError } from './errors.js';
import { ensureNode } from './pair.js';
import { Pipeline, unlockKeychain } from './pipeline.js';
import { usesSceneLifecycle, type ProjectInfo } from './project.js';
import { discoverRuntime, parseNodeVersion, RECOMMENDED_NODE_MAJOR } from './remote-env.js';
import type { MacSession } from './session.js';

/** Checks that need no Mac: Node.js here, the Capacitor project, a paired Mac. */
export function localChecks(project: ProjectInfo | null, host: HostConfig | null, nodeVersion = process.version): Check[] {
  const checks: Check[] = [];
  const nodeMajor = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
  checks.push({ id: 'pc-node', group: 'pc', level: nodeMajor >= 20 ? 'ok' : 'warn', label: `Node.js ${nodeVersion} on this PC`, fix: nodeMajor >= 20 ? undefined : 'Update Node.js to 20 or newer.' });
  if (project) {
    checks.push({ id: 'project', group: 'pc', level: 'ok', label: `Capacitor app "${project.appName}"`, detail: `${project.appId} · web: ${project.webDir}` });
    checks.push(project.hasIos
      ? { id: 'project-ios', group: 'pc', level: 'ok', label: `iOS platform (${project.iosPackageManager === 'unknown' ? 'detected' : project.iosPackageManager})`, detail: `${project.iosDir}/App` }
      : { id: 'project-ios', group: 'pc', level: 'fail', label: 'iOS platform', detail: 'missing', fix: 'Run `npx cap add ios` (add `--packagemanager SPM` for Swift Package Manager).' });
    if (project.syncRoot !== project.capDir) checks.push({ id: 'project-monorepo', group: 'pc', level: 'info', label: 'Monorepo', detail: `syncing from ${project.syncRoot}` });
  } else {
    checks.push({ id: 'project', group: 'pc', level: 'info', label: 'Not inside a Capacitor app', detail: 'project checks skipped' });
  }
  checks.push(host
    ? { id: 'paired', group: 'pc', level: 'ok', label: `Paired Mac "${host.name}"`, detail: `${host.username}@${host.host}` }
    : { id: 'paired', group: 'pc', level: 'fail', label: 'Paired Mac', detail: 'none', fix: 'Run `capmac pair`.' });
  return checks;
}

export function macChecks(probe: ProbeResult, project?: ProjectInfo | null): Check[] {
  const checks: Check[] = [];
  const mac = (check: Omit<Check, 'group'>): Check => ({ ...check, group: 'mac' });
  checks.push(mac({ id: 'mac', level: 'info', label: `${probe.computerName ?? probe.hostname}`, detail: `macOS ${probe.macos ?? '?'} · ${probe.arch === 'arm64' ? 'Apple silicon' : 'Intel'} · user ${probe.user}` }));
  if (!probe.xcode) {
    checks.push(mac({ id: 'xcode', level: 'fail', label: 'Xcode', detail: 'not found', fix: 'Install Xcode from the Mac App Store, open it once, then run `capmac doctor` again.' }));
  } else if (!probe.xcode.ready) {
    const license = /license/i.test(probe.xcode.problem ?? '');
    checks.push(mac({
      id: 'xcode',
      level: 'fail',
      label: `Xcode ${probe.xcode.version}`.trim(),
      detail: 'not ready',
      fix: probe.xcode.problem,
      action: license
        ? { id: 'xcode-license', label: 'Accept license', confirm: 'Accept the Xcode license on the Mac (sudo xcodebuild -license accept)? This needs the Mac password.' }
        : { id: 'xcode-first-launch', label: 'Finish setup', confirm: 'Run Xcode\'s first-launch setup on the Mac (sudo xcodebuild -runFirstLaunch)? This needs the Mac password.' },
    }));
  } else {
    const major = Number(probe.xcode.version.split('.')[0]);
    checks.push(mac({ id: 'xcode', level: major >= 16 ? 'ok' : 'warn', label: `Xcode ${probe.xcode.version}`, detail: probe.xcode.build, fix: major >= 16 ? undefined : 'Capacitor 7+ needs Xcode 16 or newer.' }));
  }
  const runtimes = probe.simulators.runtimes;
  checks.push(runtimes.length
    ? mac({ id: 'simulators', level: 'ok', label: 'iOS simulators', detail: `${probe.simulators.devices} devices · ${runtimes.join(', ')}` })
    : mac({
        id: 'simulators',
        level: 'fail',
        label: 'iOS simulators',
        detail: 'no iOS runtime installed',
        fix: 'Run `capmac doctor --fix` (downloads the iOS platform) or Xcode › Settings › Components.',
        action: probe.xcode ? { id: 'download-ios', label: 'Download iOS', confirm: 'Download the iOS simulator platform on the Mac? It is several GB and can take a while.' } : undefined,
      }));
  const nodeMajor = parseNodeVersion(probe.node.version)?.[0] ?? 0;
  const nodeOk = nodeMajor >= RECOMMENDED_NODE_MAJOR;
  checks.push(mac({
    id: 'node',
    level: nodeOk ? 'ok' : 'warn',
    label: `Node.js ${probe.node.version}`,
    detail: probe.node.path,
    fix: nodeOk ? undefined : 'Run `capmac doctor --fix` to install a current Node.js LTS for CapMac.',
    action: nodeOk ? undefined : { id: 'install-node', label: 'Install Node.js', confirm: 'Install a private copy of the latest Node.js LTS into ~/.capmac/runtime on the Mac? (no sudo, does not touch your system)' },
  }));
  checks.push(probe.npm
    ? mac({ id: 'npm', level: 'ok', label: `npm ${probe.npm}` })
    : mac({ id: 'npm', level: 'fail', label: 'npm', detail: 'not found next to Node.js', fix: 'Reinstall Node.js on the Mac, or run `capmac doctor --fix`.', action: { id: 'install-node', label: 'Install Node.js', confirm: 'Install a private copy of the latest Node.js LTS into ~/.capmac/runtime on the Mac?' } }));
  const needsPods = project?.iosPackageManager === 'CocoaPods';
  const pod = probe.tools.pod;
  if (pod) {
    checks.push(mac({ id: 'cocoapods', level: 'ok', label: `CocoaPods ${pod.version}` }));
  } else {
    checks.push(mac({
      id: 'cocoapods',
      level: needsPods ? 'fail' : 'info',
      label: 'CocoaPods',
      detail: needsPods ? 'needed by this project' : 'not installed (only needed for CocoaPods projects)',
      fix: needsPods ? 'Run `capmac doctor --fix` (brew install cocoapods), or migrate to SPM with `npx cap spm-migration-assistant`.' : undefined,
      action: probe.tools.brew ? { id: 'install-cocoapods', label: 'Install', confirm: 'Install CocoaPods on the Mac with Homebrew (brew install cocoapods)?' } : undefined,
    }));
  }
  const helper = probe.streamHelper;
  if (helper) {
    const xcode = helper.xcode ? ` for Xcode ${helper.xcode}` : '';
    checks.push(
      helper.state === 'ready'
        ? mac({ id: 'stream', level: 'ok', label: 'Smooth simulator stream', detail: `helper built${xcode}` })
        : helper.state === 'not-built'
          ? mac({ id: 'stream', level: 'info', label: 'Smooth simulator stream', detail: `CapMac compiles its helper${xcode} the first time you open a simulator`, action: { id: 'build-stream-helper', label: 'Build now' } })
          : helper.state === 'failed'
            ? mac({
                id: 'stream',
                level: 'warn',
                label: 'Smooth simulator stream',
                detail: `the helper does not compile${xcode}: the simulator shows the compatible stream`,
                fix: helper.detail ? `Compiler output: ${helper.detail.split('\n')[0]}` : 'Update CapMac, then try again.',
                action: { id: 'build-stream-helper', label: 'Try again' },
              })
            : mac({ id: 'stream', level: 'info', label: 'Smooth simulator stream', detail: 'needs Xcode: the simulator shows the compatible stream', fix: helper.detail }),
    );
  }
  // Touch and typing: capmac's helper when the simulators still take its input, else AXe.
  const helperInput = helper ? helper.state !== 'unsupported' && helper.state !== 'failed' && helper.input !== false : false;
  checks.push(probe.tools.axe
    ? mac({ id: 'axe', level: 'ok', label: 'AXe', detail: helperInput ? 'installed (CapMac uses its own helper for touch and typing)' : 'touch input for the simulator screen' })
    : helperInput
      ? mac({ id: 'axe', level: 'info', label: 'AXe', detail: 'not needed: CapMac’s helper handles touch and typing' })
      : mac({
          id: 'axe',
          level: 'info',
          label: 'AXe',
          detail: 'not installed: the simulator screen is view-only',
          fix: probe.tools.brew ? 'Run `capmac doctor --fix` to install it with Homebrew.' : 'Install Homebrew (https://brew.sh), then run `capmac doctor --fix`.',
          action: probe.tools.brew ? { id: 'install-axe', label: 'Install AXe', confirm: 'Install AXe on the Mac with Homebrew (brew install cameroncooke/axe/axe)? It adds touch and keyboard input to the simulator screen.' } : undefined,
        }));
  if (probe.freeDiskGb !== null) {
    checks.push(mac({ id: 'disk', level: probe.freeDiskGb >= 15 ? 'ok' : probe.freeDiskGb >= 5 ? 'warn' : 'fail', label: 'Free disk space', detail: `${probe.freeDiskGb} GB`, fix: probe.freeDiskGb >= 15 ? undefined : 'Xcode builds need room; clear ~/Library/Developer/Xcode/DerivedData or old simulators (`xcrun simctl delete unavailable`).' }));
  }
  const devIds = [...new Set(probe.signingIdentities.filter((i) => /Apple Development|iPhone Developer|Apple Distribution|iPhone Distribution/.test(i)))];
  checks.push(devIds.length
    ? mac({ id: 'signing', level: 'ok', label: 'Signing identities', detail: devIds.slice(0, 2).join(', ') + (devIds.length > 2 ? ` (+${devIds.length - 2})` : '') })
    : mac({ id: 'signing', level: 'info', label: 'Signing identities', detail: 'none (fine for simulators)', fix: 'For real devices: sign in to Xcode › Settings › Accounts on the Mac once.' }));
  if (probe.keychainLocked) {
    checks.push(mac({ id: 'keychain', level: 'info', label: 'Login keychain locked over SSH', detail: 'CapMac will ask for your Mac password when a device build needs signing', action: { id: 'unlock-keychain', label: 'Unlock' } }));
  }
  if (probe.consoleUser && probe.consoleUser !== probe.user) {
    checks.push(mac({
      id: 'desktop-session',
      level: 'warn',
      label: 'Desktop session',
      detail: probe.consoleUser === 'root' ? 'nobody is logged in at the Mac' : `"${probe.consoleUser}" is using the Mac's screen`,
      fix: `Simulators need ${probe.user} logged in to the Mac desktop (turn on automatic login if the Mac is headless).`,
    }));
  }
  if (project && probe.xcode && Number(probe.xcode.version.split('.')[0]) >= 27 && usesSceneLifecycle(project) === false) {
    checks.push(mac({ id: 'uiscene', level: 'warn', label: 'UIScene lifecycle', detail: 'required by the iOS 27 SDK, missing in this app', fix: 'Run `npx cap migrate` (Capacitor 8.5+) to add SceneDelegate, otherwise the app will not launch.' }));
  }
  return checks;
}

/** Runs `sudo <command>` on the Mac with the password on stdin (never on the command line). */
export async function sudo(session: MacSession, password: string, command: string): Promise<{ code: number | null; output: string }> {
  const channel = await session.conn.exec(`sudo -S -p '' ${command}`);
  return new Promise((resolve) => {
    let output = '';
    channel.on('data', (d: Buffer) => (output += d.toString()));
    channel.stderr.on('data', (d: Buffer) => (output += d.toString()));
    channel.on('close', (code: number | null) => resolve({ code, output }));
    channel.end(`${password}\n`);
  });
}

/** Remembers the sudo password for the length of one fix-up round only. */
export class SudoPassword {
  private value: string | null = null;
  constructor(private readonly session: MacSession, private readonly ctx: EngineContext) {}
  async get(): Promise<string> {
    this.value ??= await this.ctx.prompter.password({ purpose: 'sudo', message: `Mac password for ${this.session.host.username} (for sudo on the Mac):`, mac: this.session.label, user: this.session.host.username });
    return this.value;
  }
}

/** Applies one fix on the Mac. Throws a UserError with a hint when it fails. */
export async function applyFix(fix: FixId, session: MacSession, ctx: EngineContext, sudoPassword = new SudoPassword(session, ctx)): Promise<void> {
  switch (fix) {
    case 'install-node': {
      const runtime = await discoverRuntime(session.conn);
      const nodePath = await ensureNode(session.conn, runtime, { yes: true, force: true }, ctx);
      if (nodePath) await updateHost(session.host.name, { nodePath, home: runtime.home });
      return;
    }
    case 'xcode-license':
    case 'xcode-first-launch': {
      const [title, command] = fix === 'xcode-license'
        ? ['Accepting the Xcode license', 'xcodebuild -license accept']
        : ['Running Xcode first-launch setup', 'xcodebuild -runFirstLaunch'];
      const r = await withStep(ctx, title, 'other', async () => sudo(session, await sudoPassword.get(), command));
      if (r.code !== 0) throw new UserError(`${title} failed.`, /incorrect password|Sorry, try again/i.test(r.output) ? 'The Mac password was not accepted.' : undefined, r.output.trim().split('\n').slice(-10));
      return;
    }
    case 'download-ios': {
      await withStep(ctx, 'Downloading the iOS platform (xcodebuild -downloadPlatform iOS)', 'other', async (s) => {
        const r = await session.call<{ code: number | null }>('exec', { projectId: '_doctor', projectRel: '', command: 'xcodebuild -downloadPlatform iOS', cwd: 'home' }, {
          onEvent: (e) => {
            if (e.t === 'out') s.update(e.text.trim().slice(0, 100));
          },
        }).catch(() => ({ code: 1 }));
        if (r.code !== 0) throw new UserError('Downloading the iOS platform failed.', 'Try Xcode › Settings › Components on the Mac.');
      });
      return;
    }
    case 'install-axe':
    case 'install-cocoapods': {
      const pipeline = new Pipeline(session, { projectId: '_doctor', projectRel: '' } as ProjectInfo, ctx);
      await pipeline.call('install-tools', { tools: [fix === 'install-axe' ? 'axe' : 'cocoapods'] }).catch((err) => pipeline.fail(err));
      return;
    }
    case 'unlock-keychain':
      await unlockKeychain(session, ctx, true);
      return;
    case 'build-stream-helper': {
      const state = await withStep(ctx, 'Compiling the smooth stream helper on the Mac', 'other', () => session.call<StreamHelperState>('stream-helper', { build: true, force: true }));
      if (state.state !== 'ready') throw new UserError('The smooth stream helper did not compile on the Mac.', 'The simulator shows the compatible stream instead. Updating CapMac usually fixes this after an Xcode update.', state.detail?.split('\n'));
      return;
    }
  }
}

/** The `capmac doctor --fix` round: offers each available fix in turn. */
export async function applyFixes(session: MacSession, checks: Check[], ctx: EngineContext, options: { yes?: boolean }): Promise<void> {
  const sudoPassword = new SudoPassword(session, ctx);
  const seen = new Set<FixId>();
  const brew: Check[] = [];
  for (const check of checks) {
    const action = check.action;
    if (!action || seen.has(action.id) || action.id === 'unlock-keychain') continue;
    seen.add(action.id);
    if (action.id === 'install-axe' || action.id === 'install-cocoapods') {
      brew.push(check);
      continue;
    }
    const ok = options.yes || (ctx.prompter.interactive && (await ctx.prompter.confirm({ message: action.confirm ?? `${action.label}?` })));
    if (!ok) continue;
    try {
      await applyFix(action.id, session, ctx, sudoPassword);
    } catch (err) {
      log(ctx, 'error', (err as Error).message, (err as UserError).hint);
    }
  }
  if (brew.length) {
    const names = brew.map((c) => (c.action!.id === 'install-axe' ? 'axe' : 'cocoapods'));
    const ok = options.yes || (ctx.prompter.interactive && (await ctx.prompter.confirm({ message: `Install ${names.join(' and ')} with Homebrew on the Mac?` })));
    if (ok) {
      for (const check of brew) {
        try {
          await applyFix(check.action!.id, session, ctx, sudoPassword);
        } catch (err) {
          log(ctx, 'error', (err as Error).message, (err as UserError).hint);
        }
      }
    }
  }
  const brewMissing = checks.some((c) => (c.id === 'axe' || c.id === 'cocoapods') && c.level !== 'ok' && !c.action && c.fix?.includes('Homebrew'));
  if (brewMissing) log(ctx, 'warn', 'Homebrew is not installed, so CapMac cannot install AXe or CocoaPods. Get it from https://brew.sh.');
}
