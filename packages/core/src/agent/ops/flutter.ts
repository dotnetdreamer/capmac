/**
 * Flutter on the Mac: finds the Mac's Flutter (or installs one in
 * ~/.capmac/flutter), runs the app with `flutter run --machine` (Flutter's
 * own build, install, launch and hot reload, the way IDEs drive it) and
 * builds it with `flutter build`. The engine on the PC reads the daemon
 * messages this relays and sends requests (hot reload, stop) back.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArgs, daemonRequestLine, FLUTTER_ERROR_CODES, parseDaemonLine, type FlutterBuildParams, type FlutterBuildResult, type FlutterMacLaunchParams, type FlutterRunParams, type FlutterRunResult, type FlutterSdkInfo, type FlutterSdkParams, type FlutterSdkResult } from '../../shared/flutter.js';
import { capmacHome, toolEnv } from '../env.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, exists, isExecutable, run, tryCapture, which } from '../proc.js';
import { projectPaths } from '../state.js';
import { readAppInfo } from './build.js';
import { bootSimulator } from './deploy.js';
import { launchMacAppWithHook } from './mac-app.js';
import { signingTeamsFor } from './teams.js';

const RELEASES_URL = 'https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json';
const FLUTTER_GIT = 'https://github.com/flutter/flutter.git';

/** The environment Flutter runs in: the tool PATH, no analytics prompts, no colours. */
async function flutterEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  return {
    ...(await toolEnv()),
    FLUTTER_SUPPRESS_ANALYTICS: 'true',
    PUB_ENVIRONMENT: 'capmac',
    // Swift print() and the tools' own output stay line by line.
    NSUnbufferedIO: 'YES',
    ...extra,
  };
}

const managedRoot = () => path.join(capmacHome(), 'flutter');

/** Flutter's own record of its version (Flutter 3.22+), else asks the tool. */
async function describeSdk(bin: string, managed: boolean, env: NodeJS.ProcessEnv): Promise<FlutterSdkInfo | null> {
  const root = path.dirname(path.dirname(bin));
  let info: any = null;
  try {
    info = JSON.parse(await fs.readFile(path.join(root, 'bin', 'cache', 'flutter.version.json'), 'utf8'));
  } catch {
    const text = await tryCapture(bin, ['--version', '--machine'], { env, timeoutMs: 180_000 });
    try {
      info = text ? JSON.parse(text.slice(text.indexOf('{'))) : null;
    } catch {
      info = null;
    }
  }
  const version = info?.frameworkVersion ?? info?.flutterVersion;
  if (typeof version !== 'string') return null;
  return {
    bin,
    root,
    version,
    channel: typeof info.channel === 'string' ? info.channel : null,
    dartVersion: typeof info.dartSdkVersion === 'string' ? info.dartSdkVersion : null,
    engineRevision: typeof info.engineRevision === 'string' ? info.engineRevision : null,
    managed,
  };
}

/** Exact versions compare by their numbers; "stable" or nothing takes any Flutter. */
function matches(sdk: FlutterSdkInfo, wanted?: string): boolean {
  if (!wanted || wanted === 'stable' || wanted === 'any') return true;
  return sdk.version === wanted.replace(/^v/, '');
}

/** The Flutter installs on this Mac: CapMac's own first (newest first), then the person's. */
async function candidates(env: NodeJS.ProcessEnv): Promise<Array<{ bin: string; managed: boolean }>> {
  const found: Array<{ bin: string; managed: boolean }> = [];
  const managed = await fs.readdir(managedRoot()).catch(() => [] as string[]);
  for (const name of managed.filter((n) => !n.endsWith('.part')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    found.push({ bin: path.join(managedRoot(), name, 'bin', 'flutter'), managed: true });
  }
  const home = os.homedir();
  const onPath = await which('flutter', env);
  for (const bin of [
    onPath,
    path.join(home, 'flutter', 'bin', 'flutter'),
    path.join(home, 'development', 'flutter', 'bin', 'flutter'),
    path.join(home, 'Developer', 'flutter', 'bin', 'flutter'),
    path.join(home, 'fvm', 'default', 'bin', 'flutter'),
    '/opt/homebrew/bin/flutter',
    '/usr/local/bin/flutter',
  ]) {
    if (bin && !found.some((f) => f.bin === bin)) found.push({ bin, managed: false });
  }
  // FVM's versions folder holds pinned versions too.
  for (const name of await fs.readdir(path.join(home, 'fvm', 'versions')).catch(() => [] as string[])) {
    found.push({ bin: path.join(home, 'fvm', 'versions', name, 'bin', 'flutter'), managed: false });
  }
  return found;
}

/** The Flutter to use: the exact version when one is wanted, else the first that works. */
export async function findFlutter(env: NodeJS.ProcessEnv, wanted?: string): Promise<FlutterSdkInfo | null> {
  let fallback: FlutterSdkInfo | null = null;
  for (const candidate of await candidates(env)) {
    // Homebrew's flutter is a symlink into its cask; follow it to the SDK.
    const real = await fs.realpath(candidate.bin).catch(() => null);
    if (!real || !(await isExecutable(real))) continue;
    const sdk = await describeSdk(real, candidate.managed, env);
    if (!sdk) continue;
    if (matches(sdk, wanted)) return sdk;
    fallback ??= sdk;
  }
  return wanted && wanted !== 'stable' && wanted !== 'any' ? null : fallback;
}

/** The newest stable version, from Flutter's release list. */
async function latestStable(): Promise<string> {
  const response = await fetch(RELEASES_URL);
  if (!response.ok) throw new AgentError(`Could not read Flutter's release list (HTTP ${response.status}).`, FLUTTER_ERROR_CODES.installFailed);
  const releases = (await response.json()) as { current_release?: { stable?: string }; releases?: Array<{ hash: string; version: string }> };
  const hash = releases.current_release?.stable;
  const release = releases.releases?.find((r) => r.hash === hash);
  if (!release) throw new AgentError('Flutter’s release list names no stable version.', FLUTTER_ERROR_CODES.installFailed);
  return release.version;
}

/**
 * Installs Flutter `version` in ~/.capmac/flutter/<version>: a shallow clone
 * of that release (about 1 GB with the iOS and Mac engines, less than half of
 * Flutter's own archive), then the tool and the engines it needs.
 */
async function installFlutter(version: string, platforms: Array<'ios' | 'macos'>, io: AgentIO): Promise<FlutterSdkInfo> {
  const env = await flutterEnv();
  const git = await which('git', env);
  if (!git) throw new AgentError('Installing Flutter needs git, which this Mac does not have.', 'TOOL_MISSING', 'Install Xcode’s command line tools on the Mac: `xcode-select --install`.');
  const dir = path.join(managedRoot(), version);
  const part = `${dir}.part`;
  await fs.mkdir(managedRoot(), { recursive: true });
  if (!(await exists(path.join(dir, 'bin', 'flutter')))) {
    await step(io, 'flutter-clone', `Downloading Flutter ${version}`, async () => {
      await fs.rm(part, { recursive: true, force: true });
      const result = await run(git, ['clone', '--depth', '1', '--branch', version, '--progress', FLUTTER_GIT, part], {
        env,
        signal: io.signal,
        onLine: (line) => {
          const text = line.trim();
          if (text) io.send({ t: 'progress', text: text.slice(0, 120) });
        },
      });
      if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
      if (result.code !== 0) throw new AgentError(`Downloading Flutter ${version} failed.`, FLUTTER_ERROR_CODES.installFailed, /not found in upstream|Remote branch/i.test(result.tail.join('\n')) ? `There is no Flutter release called ${version}.` : 'Check the Mac’s internet connection, then try again.', result.tail.slice(-10));
      await fs.rename(part, dir);
    });
  }
  const bin = path.join(dir, 'bin', 'flutter');
  await step(io, 'flutter-tool', 'Preparing the Flutter tool', async () => {
    // The first run downloads Dart and builds the tool.
    for (const args of [['config', '--no-analytics', '--no-cli-animations'], ['--version']]) {
      const result = await run(bin, args, { env, signal: io.signal, timeoutMs: 20 * 60_000, onLine: (line) => line.trim() && io.send({ t: 'progress', text: line.trim().slice(0, 120) }) });
      if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
      if (result.code !== 0) throw new AgentError('The Flutter tool did not start.', FLUTTER_ERROR_CODES.installFailed, undefined, result.tail.slice(-12));
    }
  });
  if (platforms.length) await precache(bin, platforms, io, env);
  const sdk = await describeSdk(bin, true, env);
  if (!sdk) throw new AgentError('Flutter was installed but does not report its version.', FLUTTER_ERROR_CODES.installFailed);
  return sdk;
}

/** Downloads the iOS and Mac engines now, so the first build does not stop for them. */
async function precache(bin: string, platforms: Array<'ios' | 'macos'>, io: AgentIO, env: NodeJS.ProcessEnv): Promise<void> {
  await step(io, 'flutter-precache', `Downloading Flutter’s ${platforms.map((p) => (p === 'ios' ? 'iOS' : 'Mac')).join(' and ')} engine`, async () => {
    const result = await run(bin, ['precache', ...platforms.map((p) => `--${p}`), '--no-android', '--no-web', '--no-linux', '--no-windows', '--no-fuchsia'], {
      env,
      signal: io.signal,
      timeoutMs: 30 * 60_000,
      onLine: (line) => line.trim() && io.send({ t: 'progress', text: line.trim().slice(0, 120) }),
    });
    if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
    if (result.code !== 0) throw new AgentError('Downloading Flutter’s engine failed.', FLUTTER_ERROR_CODES.installFailed, 'Check the Mac’s internet connection, then try again.', result.tail.slice(-10));
  });
}

/** The Flutter `params.version` asks for; installs it first when `install` is set and the Mac has none that fits. */
export async function opFlutterSdk(params: FlutterSdkParams, io: AgentIO): Promise<FlutterSdkResult> {
  const env = await flutterEnv();
  const wanted = params.version;
  const found = await findFlutter(env, wanted);
  if (found) {
    if (params.platforms?.length && params.install) await precache(found.bin, params.platforms, io, env);
    return { sdk: found };
  }
  if (!params.install) return { sdk: null };
  const version = !wanted || wanted === 'stable' || wanted === 'any' ? await latestStable() : wanted.replace(/^v/, '');
  return { sdk: await installFlutter(version, params.platforms ?? ['ios', 'macos'], io), installed: true };
}

async function requireFlutter(env: NodeJS.ProcessEnv, version?: string): Promise<FlutterSdkInfo> {
  const sdk = await findFlutter(env, version);
  if (sdk) return sdk;
  throw new AgentError(
    version && version !== 'stable' ? `Flutter ${version} is not on this Mac.` : 'Flutter is not on this Mac.',
    FLUTTER_ERROR_CODES.missing,
    'CapMac can install it: run `capmac doctor --fix`, or press Install in CapMac Studio.',
  );
}

/** A device build's team, the way Flutter passes build settings on to Xcode. */
function teamEnv(team?: string): NodeJS.ProcessEnv {
  return team ? { FLUTTER_XCODE_DEVELOPMENT_TEAM: team, FLUTTER_XCODE_CODE_SIGN_STYLE: 'Automatic' } : {};
}

/**
 * Xcode's own build files for an iOS build, in the project's build folder.
 * Flutter puts the products there (BUILD_DIR) but leaves the rest where
 * Xcode's settings say; on a Mac whose Xcode builds to another disk (Settings
 * › Locations), Xcode's build service then cannot write its files over SSH.
 */
function iosBuildEnv(project: string): NodeJS.ProcessEnv {
  return { FLUTTER_XCODE_OBJROOT: path.join(project, 'build', 'ios', 'Intermediates.noindex') };
}

/**
 * The team a device build signs with: the one asked for, else none when the
 * Xcode project names its own, else the only team that can sign for the
 * iPhone (several: the person picks, CapMac does not guess).
 */
async function deviceTeam(project: string, udid: string | null, team: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (team) return team;
  const pbxproj = await fs.readFile(path.join(project, 'ios', 'Runner.xcodeproj', 'project.pbxproj'), 'utf8').catch(() => '');
  if (/\bDEVELOPMENT_TEAM = "?[A-Z0-9]{10}"?;/.test(pbxproj)) return undefined;
  if (!udid) return undefined;
  const teams = await signingTeamsFor(udid, env).catch(() => [] as string[]);
  if (teams.length === 1) return teams[0];
  if (teams.length > 1) {
    throw new AgentError(`Several development teams can sign for this iPhone (${teams.join(', ')}).`, 'SIGNING', 'Pick one: set "ios": { "team": "…" } in capmac.json, or pass --team.');
  }
  return undefined;
}

/**
 * Runs the app with `flutter run --machine` (or attaches to one already
 * running) until it quits or the PC stops the run. Daemon messages go to the
 * PC as they come; requests from the PC (`flutter-request`) go to Flutter.
 * Stopping asks Flutter to stop the app first, like an IDE's Stop button.
 */
export async function opFlutterRun(params: FlutterRunParams, io: AgentIO): Promise<FlutterRunResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  const onDevice = params.device.kind === 'ios' && params.device.target.kind === 'device';
  const team = onDevice && params.device.kind === 'ios' ? await deviceTeam(paths.project, params.device.target.udid, params.team, await toolEnv()) : params.team;
  const env = await flutterEnv({ ...teamEnv(team), ...(params.device.kind === 'ios' ? iosBuildEnv(paths.project) : {}) });
  const sdk = await requireFlutter(env, params.version);
  if (params.device.kind === 'ios' && params.device.target.kind === 'simulator') await bootSimulator(params.device.target, io, env, false);
  const deviceId = params.device.kind === 'macos' ? 'macos' : params.device.target.udid;
  const args = params.attachUrl
    ? ['attach', '--machine', '-d', deviceId, '--debug-url', params.attachUrl, ...(params.options.target ? ['--target', params.options.target] : [])]
    : ['run', '--machine', '-d', deviceId, ...buildArgs(params.options), ...(params.device.kind === 'ios' && params.device.target.kind === 'device' ? ['--device-timeout', '30'] : [])];
  io.send({ t: 'log', level: 'debug', msg: `flutter ${args.join(' ')}` });

  const child = new AbortController();
  let appId: string | null = null;
  let started = false;
  let stdin: NodeJS.WritableStream | null = null;
  /** What Flutter said went wrong, readable (its messages, not the protocol's JSON), for an error before the app started. */
  const problems: string[] = [];
  const note = (text: string) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      problems.push(line.trimEnd());
      if (problems.length > 60) problems.shift();
    }
  };
  let nextId = 1_000_000;
  const send = (method: string, args: Record<string, unknown>, id = nextId++) => stdin?.write(daemonRequestLine(id, method, args));
  io.onMessage((message) => {
    if (message?.t !== 'flutter-request' || typeof message.method !== 'string') return;
    send(message.method, { ...(message.params ?? {}), ...(appId && message.params?.appId === undefined ? { appId } : {}) }, Number(message.id));
  });
  // Stop: Flutter stops the app, then exits; it is ended if it has not after a few seconds.
  const onStop = () => {
    if (appId) send('app.stop', { appId });
    setTimeout(() => child.abort(), appId ? 6000 : 0).unref();
  };
  io.signal.addEventListener('abort', onStop, { once: true });
  try {
    const result = await run(sdk.bin, args, {
      cwd: paths.project,
      env,
      signal: child.signal,
      capture: false,
      keepStdinOpen: true,
      tailLines: 80,
      onSpawn: (spawned) => {
        stdin = spawned.stdin;
      },
      onLine: (line, stream) => {
        const messages = stream === 'stdout' ? parseDaemonLine(line) : null;
        if (!messages) {
          if (!line.trim()) return;
          io.send({ t: 'out', stream, text: line });
          if (stream === 'stderr' || /error|failed|exception/i.test(line)) note(line);
          return;
        }
        for (const msg of messages) {
          if ('event' in msg) {
            if (msg.event === 'app.start' && typeof msg.params?.appId === 'string') appId = msg.params.appId;
            if (msg.event === 'app.started') started = true;
            if (msg.event === 'daemon.logMessage' && (msg.params?.level === 'error' || msg.params?.level === 'warning') && typeof msg.params.message === 'string') note(msg.params.message);
            if (msg.event === 'app.log' && msg.params?.error && typeof msg.params.log === 'string') note(msg.params.log);
            if (msg.event === 'app.stop' && msg.params?.error) note(String(msg.params.error));
          }
          io.send({ t: 'flutter', msg });
        }
      },
    });
    if (io.signal.aborted) return { reason: 'cancelled', exitCode: null };
    if (!started && result.code !== 0) {
      const text = problems.join('\n');
      const hint = /No supported devices|No devices found|not connected|Could not find a device|not paired/i.test(text)
        ? 'Flutter on the Mac could not reach that device. Unlock it, keep it on the Mac’s cable or Wi-Fi, and try again.'
        : /Xcode build|Error \(Xcode\)|Encountered error while building|Command PhaseScriptExecution|Error: /i.test(text)
          ? 'Fix the errors above, then run again.'
          : /signing|provisioning|Development Team|certificate/i.test(text)
            ? 'Signing for a device needs an Apple team: set ios.team in capmac.json (or pass --team), and unlock the Mac’s keychain with `capmac keychain`.'
            : undefined;
      throw new AgentError(params.attachUrl ? 'Flutter could not attach to the app.' : 'Flutter stopped before the app started.', FLUTTER_ERROR_CODES.runFailed, hint, (problems.length ? problems : result.tail).slice(-40));
    }
    return { reason: 'exited', exitCode: result.code };
  } finally {
    io.signal.removeEventListener('abort', onStop);
  }
}

/** Where `flutter build` puts what it made. */
async function builtProduct(project: string, params: FlutterBuildParams): Promise<string | null> {
  if (params.what === 'ipa') {
    const ipaDir = path.join(project, 'build', 'ios', 'ipa');
    const ipa = (await fs.readdir(ipaDir).catch(() => [] as string[])).find((name) => name.endsWith('.ipa'));
    return ipa ? path.join(ipaDir, ipa) : null;
  }
  const dir = params.what === 'macos'
    ? path.join(project, 'build', 'macos', 'Build', 'Products', params.options.mode === 'debug' ? 'Debug' : params.options.mode === 'profile' ? 'Profile' : 'Release')
    : path.join(project, 'build', 'ios', params.what === 'ios-simulator' ? 'iphonesimulator' : 'iphoneos');
  const flavorDir = params.options.flavor ? `${dir}-${params.options.flavor}` : dir;
  for (const candidate of [flavorDir, dir]) {
    const app = (await fs.readdir(candidate).catch(() => [] as string[])).find((name) => name.endsWith('.app'));
    if (app) return path.join(candidate, app);
  }
  return null;
}

/** Builds without running: an app for a simulator, the Mac or a device, or an .ipa. */
export async function opFlutterBuild(params: FlutterBuildParams, io: AgentIO): Promise<FlutterBuildResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  const env = await flutterEnv({ ...teamEnv(params.team), ...(params.what === 'macos' ? {} : iosBuildEnv(paths.project)) });
  const sdk = await requireFlutter(env, params.version);
  const platform =params.what === 'macos' ? 'macos' : params.what === 'ipa' ? 'ipa' : 'ios';
  const args = ['build', platform, ...buildArgs(params.options)];
  if (params.what === 'ios-simulator') args.push('--simulator');
  if (params.what === 'ipa' && params.exportMethod) args.push('--export-method', params.exportMethod);
  const title = params.what === 'ipa' ? 'Building the .ipa (flutter build ipa)' : params.what === 'macos' ? 'Building the Mac app (flutter build macos)' : `Building the iOS app (flutter build ios${params.what === 'ios-simulator' ? ' --simulator' : ''})`;
  await step(io, 'build', title, async () => {
    const result = await run(sdk.bin, args, {
      cwd: paths.project,
      env,
      signal: io.signal,
      tailLines: 80,
      onLine: (line, stream) => {
        if (!line.trim()) return;
        io.send({ t: 'out', stream, text: line });
        if (/^\s*(Running|Building|Compiling|Archiving|Resolving|Got dependencies|Xcode build done|✓ Built)/.test(line)) io.send({ t: 'progress', text: line.trim().slice(0, 160) });
      },
    });
    if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
    if (result.code !== 0) throw new AgentError(`flutter ${args.slice(0, 2).join(' ')} failed`, FLUTTER_ERROR_CODES.buildFailed, undefined, result.tail.slice(-40));
  });
  const product = await builtProduct(paths.project, params);
  if (!product) throw new AgentError('The build finished but CapMac could not find what it made.', FLUTTER_ERROR_CODES.buildFailed, `Look in ${path.join(paths.project, 'build')} on the Mac.`);
  if (params.what === 'ipa') return { appPath: null, ipaPath: product, bundleId: null, displayName: null, executable: null };
  // A Mac app keeps its Info.plist in Contents/.
  const info = await readAppInfo(params.what === 'macos' ? path.join(product, 'Contents') : product).catch(() => null);
  return { appPath: product, ipaPath: null, bundleId: info?.bundleId ?? null, displayName: info?.displayName ?? null, executable: info?.executable ?? null };
}

/** The Dart VM service a debug build prints when it starts (hot reload attaches to it). */
const VM_SERVICE = /The Dart VM service is listening on (https?:\/\/\S+)/;

/**
 * Launches a built Flutter Mac app with CapMac's module in it (see
 * mac-app.ts). A debug build's Dart VM service is reported (`flutter-vm`) so
 * `flutter attach` can hot-reload it.
 */
export async function opFlutterMacLaunch(params: FlutterMacLaunchParams, io: AgentIO): Promise<FlutterRunResult> {
  return launchMacAppWithHook({ projectId: params.projectId, appPath: params.appPath }, io, {
    env: await flutterEnv(),
    failureCode: FLUTTER_ERROR_CODES.runFailed,
    onLine: (line) => {
      const vm = VM_SERVICE.exec(line);
      if (vm && params.debug) io.send({ t: 'flutter-vm', uri: vm[1]! });
    },
  });
}
