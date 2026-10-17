/**
 * React Native on the Mac: the app's JavaScript packages (the native build
 * reads them), CocoaPods for its iOS or Mac app, and xcodebuild. A debug
 * build loads its JavaScript from Metro on the PC, so it is built without
 * bundling any (SKIP_BUNDLING) and rebuilt only when something native
 * changes; a release build bundles the JavaScript into the app as React
 * Native's own build phase does.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { classifyReactNativeChange, needsNativeRebuild, needsPodInstall, POD_INSTALL_NOTICE, REACT_NATIVE_ERROR_CODES, type ReactNativeBuildParams, type ReactNativePrepareParams, type ReactNativePrepareResult } from '../../shared/react-native.js';
import type { BuildResult } from '../../shared/protocol.js';
import { hintForBuildOutput, XcodeOutputParser } from '../../shared/xcode-output.js';
import { toolEnv, xcodeEnv } from '../env.js';
import type { IosProject } from '../ios-project.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, capture, exists, run, which } from '../proc.js';
import { loadState, projectPaths, saveState, withProjectLock, type ProjectState, type ReactNativeState } from '../state.js';
import { BUILD_NOISE, destinationFor, findBuiltApp, projectSettingsFor, pruneLogs, readAppInfo, schemeApp, signingTeam } from './build.js';
import { depsHash, detectPackageManager, installCommand, installEnv } from './prepare.js';

function rnState(state: ProjectState): ReactNativeState {
  state.rn ??= { nativeGen: { ios: 1, macos: 1 }, jsGen: 1, podsStale: { ios: true, macos: true } };
  return state.rn;
}

/**
 * What changed since the last prepare, for both Apple apps at once: the other
 * app's prepare (and build) reads the flags later, after these changes are
 * gone from the list.
 */
export function absorbChanges(state: ProjectState, projectRel: string): void {
  const rn = rnState(state);
  const full = state.pendingFull;
  const changes = new Set(state.pendingChanges.map((rel) => classifyReactNativeChange(rel, projectRel)));
  for (const platform of ['ios', 'macos'] as const) {
    if (full || [...changes].some((change) => needsNativeRebuild(change, platform))) rn.nativeGen[platform] += 1;
    if (full || needsPodInstall(changes, platform)) rn.podsStale[platform] = true;
  }
  if (full || changes.has('js') || changes.has('metro') || changes.has('deps')) rn.jsGen += 1;
  state.pendingChanges = [];
  state.pendingFull = false;
}

/** The environment CocoaPods needs: a UTF-8 locale (it refuses anything else), no stats, and the project's own settings. */
export function podEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', COCOAPODS_DISABLE_STATS: 'true', ...extra };
}

/** `bundle exec pod` when the project brings a Gemfile whose gems are installed, else the Mac's own `pod`. */
async function podCommand(projectDir: string, env: NodeJS.ProcessEnv): Promise<{ cmd: string; args: string[]; label: string }> {
  if (await exists(path.join(projectDir, 'Gemfile'))) {
    const bundle = await which('bundle', env);
    if (bundle) {
      const check = await run(bundle, ['check'], { cwd: projectDir, env, timeoutMs: 60_000 }).catch(() => null);
      if (check?.code === 0) return { cmd: bundle, args: ['exec', 'pod', 'install'], label: 'bundle exec pod install' };
    }
  }
  const pod = await which('pod', env);
  if (!pod) {
    throw new AgentError('CocoaPods is not installed on the Mac.', 'TOOL_MISSING', 'React Native’s Apple apps get their native libraries with CocoaPods. Install it on the Mac: `brew install cocoapods` (or `sudo gem install cocoapods`).');
  }
  return { cmd: pod, args: ['install'], label: 'pod install' };
}

/** Whether `pod install` left the app's Pods in step with its Podfile.lock (CocoaPods' own check, as the build phase does). */
async function podsInStep(platformDir: string): Promise<boolean> {
  const [lock, manifest] = await Promise.all([
    fs.readFile(path.join(platformDir, 'Podfile.lock'), 'utf8').catch(() => null),
    fs.readFile(path.join(platformDir, 'Pods', 'Manifest.lock'), 'utf8').catch(() => null),
  ]);
  return lock !== null && manifest !== null && lock === manifest;
}

/**
 * CocoaPods edits files the PC sent (the Xcode project, its schemes). A sync
 * puts back any synced file whose size changed on the Mac, which would undo
 * them: the manifest takes their new sizes, so only a change on the PC (a new
 * hash) uploads the file again, and that change runs `pod install` again.
 */
export async function keepPodEdits(state: ProjectState, root: string, appRel: string): Promise<void> {
  for (const [rel, record] of Object.entries(state.manifest)) {
    if (!rel.startsWith(`${appRel}/`) || rel.includes('/Pods/')) continue;
    const st = await fs.stat(path.join(root, ...rel.split('/'))).catch(() => null);
    if (st?.isFile()) record.s = st.size;
  }
}

export async function opReactNativePrepare(params: ReactNativePrepareParams, io: AgentIO): Promise<ReactNativePrepareResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  if (!/^[A-Za-z0-9_.-]+$/.test(params.dir)) throw new AgentError(`Invalid app folder ${JSON.stringify(params.dir)}`, 'BAD_REQUEST');
  return withProjectLock(paths, io, async () => {
    const state = await loadState(paths);
    const rn = rnState(state);
    const genBefore = rn.nativeGen[params.platform];
    absorbChanges(state, params.projectRel);
    await saveState(paths, state);
    const env = await toolEnv();

    // 1. The JavaScript packages: CocoaPods reads React Native (and every native module) from node_modules.
    const { pm, version, lockfile } = await detectPackageManager(paths.src);
    const wantDeps = depsHash(state);
    const hasModules = (await exists(path.join(paths.src, 'node_modules'))) || (await exists(path.join(paths.project, 'node_modules')));
    let installed = false;
    if (params.full || wantDeps !== rn.depsHash || !hasModules) {
      const command = await installCommand(paths.src, pm, version, lockfile, env);
      await step(io, 'install', `Installing the app’s packages (${command.label})`, async () => {
        const result = await run(command.cmd, command.args, {
          cwd: paths.src,
          env: installEnv(env),
          signal: io.signal,
          onLine: (line) => line.trim() && io.send({ t: 'progress', text: line.trim().slice(0, 160) }),
        });
        if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
        if (result.code !== 0) throw new AgentError(`${command.label} failed (exit ${result.code})`, 'INSTALL_FAILED', 'If the project uses a private registry, make sure its token is configured on the Mac (for example in ~/.npmrc).', result.tail.slice(-30));
      });
      installed = true;
      rn.depsHash = wantDeps;
      rn.podsStale.ios = true;
      rn.podsStale.macos = true;
      rn.nativeGen.ios += 1;
      rn.nativeGen.macos += 1;
      await saveState(paths, state);
    }

    // 2. CocoaPods for this app, when something it reads changed (or its Pods are not there).
    const platformDir = path.join(paths.project, params.dir);
    if (!(await exists(platformDir))) throw new AgentError(`The app has no ${params.dir}/ folder.`, 'NO_IOS_PLATFORM');
    let pods = false;
    if (params.podfileLock !== undefined) {
      // The PC's lock, when it changed there: CocoaPods installs what it pins.
      const hash = createHash('sha1').update(params.podfileLock).digest('hex');
      if (rn.podLock?.[params.platform] !== hash) {
        await fs.writeFile(path.join(platformDir, 'Podfile.lock'), params.podfileLock);
        rn.podLock = { ...rn.podLock, [params.platform]: hash };
        rn.podsStale[params.platform] = true;
        await saveState(paths, state);
      }
    }
    if (await exists(path.join(platformDir, 'Podfile'))) {
      const stale = Boolean(params.full) || rn.podsStale[params.platform] || !(await podsInStep(platformDir));
      if (stale) {
        const penv = podEnv(env, params.podEnv);
        const command = await podCommand(paths.project, penv);
        const what = params.platform === 'ios' ? 'the iOS app' : 'the Mac app';
        await step(io, 'pods', `Installing ${what}’s native libraries (${command.label})`, async () => {
          const result = await run(command.cmd, command.args, {
            cwd: platformDir,
            env: penv,
            signal: io.signal,
            timeoutMs: 30 * 60_000,
            tailLines: 60,
            onLine: (line) => {
              const text = line.trim();
              if (!text || POD_INSTALL_NOTICE.test(text)) return;
              io.send({ t: 'out', stream: 'stdout', text });
              if (/^(Analyzing|Downloading|Installing|Generating|Integrating|Pod installation complete|\[Codegen\]|Fetching|Configuring|Using )/i.test(text)) io.send({ t: 'progress', text: text.slice(0, 160) });
            },
          });
          if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
          if (result.code !== 0) {
            const text = result.tail.join('\n');
            const hint = /Unicode Normalization|ASCII-8BIT/i.test(text)
              ? 'CocoaPods needs a UTF-8 terminal locale on the Mac.'
              : /CDN: trunk|Couldn't determine repo|Failed to connect|Could not resolve host/i.test(text)
                ? 'CocoaPods could not reach its servers: check the Mac’s internet connection, then try again.'
                : /node: command not found|No such file or directory - node|Pod::Executable.*node/i.test(text)
                  ? 'The Podfile runs Node.js: install Node.js on the Mac (https://nodejs.org), then try again.'
                  : /required a higher minimum deployment target|is not compatible with/i.test(text)
                    ? 'A native module needs a newer platform version than the Podfile asks for: raise it in the Podfile.'
                    : 'Fix what CocoaPods says above, then run again.';
            throw new AgentError(`${command.label} failed for ${what} (exit ${result.code})`, REACT_NATIVE_ERROR_CODES.podsFailed, hint, result.tail.filter((l) => l.trim()).slice(-30));
          }
        });
        pods = true;
        rn.podsStale[params.platform] = false;
        rn.nativeGen[params.platform] += 1;
        await keepPodEdits(state, paths.src, [params.projectRel, params.dir].filter(Boolean).join('/'));
        await saveState(paths, state);
      }
    }
    return { installed, pods, packageManager: pm, nativeDirty: rn.nativeGen[params.platform] !== genBefore };
  });
}

/** The app's folder as an Xcode project and the workspace CocoaPods made next to it. */
export async function locateAppleApp(projectDir: string, dir: string, scheme: string): Promise<IosProject> {
  const platformDir = path.join(projectDir, ...dir.split('/'));
  const entries = await fs.readdir(platformDir).catch(() => [] as string[]);
  const projects = entries.filter((name) => name.endsWith('.xcodeproj')).sort();
  const workspaces = entries.filter((name) => name.endsWith('.xcworkspace')).sort();
  const base = scheme.replace(/-(macOS|iOS)$/, '');
  const xcodeproj = projects.find((name) => name === `${base}.xcodeproj`) ?? projects[0];
  if (!xcodeproj) throw new AgentError(`No Xcode project in ${dir}/.`, 'NO_IOS_PLATFORM');
  const workspace = workspaces.find((name) => name === xcodeproj.replace(/\.xcodeproj$/, '.xcworkspace')) ?? workspaces[0] ?? null;
  return {
    platformDir,
    nativeProjectDir: platformDir,
    appDir: path.join(platformDir, base),
    xcodeproj: path.join(platformDir, xcodeproj),
    workspace: workspace ? path.join(platformDir, workspace) : null,
    packageManager: (await exists(path.join(platformDir, 'Podfile'))) ? 'CocoaPods' : 'unknown',
  };
}

/**
 * A sandboxed Mac app may not listen on a port, and CapMac's module in it
 * listens on one on 127.0.0.1 (its window comes to the PC that way). Debug
 * builds made by CapMac add the network-server permission to a copy of the
 * app's entitlements, kept with CapMac's build files; the project's own file
 * is not touched. Returns the copy, or null when the app needs none.
 */
export async function hookEntitlements(entitlementsFile: string | null, outDir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!entitlementsFile || !(await exists(entitlementsFile))) return null;
  const json = await capture('plutil', ['-convert', 'json', '-o', '-', entitlementsFile], { env }).catch(() => null);
  if (!json) return null;
  const entitlements = JSON.parse(json) as Record<string, unknown>;
  if (entitlements['com.apple.security.app-sandbox'] !== true || entitlements['com.apple.security.network.server'] === true) return null;
  await fs.mkdir(outDir, { recursive: true });
  const copy = path.join(outDir, `capmac-${path.basename(entitlementsFile)}`);
  await fs.copyFile(entitlementsFile, copy);
  await capture('plutil', ['-replace', 'com.apple.security.network.server', '-bool', 'YES', copy], { env });
  return copy;
}

function buildKey(params: ReactNativeBuildParams, team: string | undefined): string {
  const where = params.target.kind === 'device' ? params.target.udid : params.target.kind;
  return ['rn', params.platform, params.configuration, params.scheme, where, team ?? '', ...(params.extraArgs?.length ? [JSON.stringify(params.extraArgs)] : [])].join('|');
}

/** Debug builds get their JavaScript from Metro on the PC: React Native's build phase bundles none. */
export const isDebugConfiguration = (configuration: string) => /debug/i.test(configuration);

export async function opReactNativeBuild(params: ReactNativeBuildParams, io: AgentIO): Promise<BuildResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  if (!/^[A-Za-z0-9_.-]+$/.test(params.dir)) throw new AgentError(`Invalid app folder ${JSON.stringify(params.dir)}`, 'BAD_REQUEST');
  return withProjectLock(paths, io, async () => {
    const state = await loadState(paths);
    const rn = rnState(state);
    const mac = params.platform === 'macos';
    const ios = await locateAppleApp(paths.project, params.dir, params.scheme);
    if (!ios.workspace && ios.packageManager === 'CocoaPods') throw new AgentError(`${params.dir}/ has no workspace yet: CocoaPods makes it.`, REACT_NATIVE_ERROR_CODES.noWorkspace, 'Run again: CapMac runs `pod install` first.');
    const scheme = params.scheme;
    const app = await schemeApp(ios, scheme);
    if (!app) throw new AgentError(`Scheme ${scheme} does not name an app to run.`, 'BUILD_FAILED', 'Pick a scheme with an app selected in its Run action.');
    const derivedData = mac ? path.join(paths.base, 'DerivedData-macos') : paths.derivedData;
    const isSim = params.target.kind === 'simulator';
    const debug = isDebugConfiguration(params.configuration);
    // A device build that names no team asks the project first, to pick one (see signingTeam).
    let settings = !mac && !isSim && !params.team ? await projectSettingsFor(ios, scheme, app, params, derivedData, io.signal) : undefined;
    const team = mac ? params.team : await signingTeam(params, app, settings ?? null, io);
    const key = buildKey(params, team);
    const previous = state.builds[key];
    const productsDir = path.join(derivedData, 'Build', 'Products', mac ? params.configuration : `${params.configuration}-${isSim ? 'iphonesimulator' : 'iphoneos'}`);
    const gen = rn.nativeGen[params.platform];
    // Nothing native changed (and for a release build, no JavaScript either): reuse the last build.
    if (!params.force && !params.clean && previous && previous.nativeGen === gen && (debug || previous.webGen === rn.jsGen) && (await exists(previous.appPath))) {
      return { skipped: true, ...previous, warnings: 0, logPath: null };
    }

    const extra: string[] = [];
    if (debug) extra.push('SKIP_BUNDLING=1');
    if (mac && debug) {
      // CapMac's module needs to listen on a local port in the sandboxed app (see hookEntitlements).
      settings ??= await projectSettingsFor(ios, scheme, app, params, derivedData, io.signal);
      const file = settings?.CODE_SIGN_ENTITLEMENTS ? path.resolve(ios.nativeProjectDir, settings.CODE_SIGN_ENTITLEMENTS) : null;
      const copy = await hookEntitlements(file, path.join(paths.base, 'entitlements'), await toolEnv()).catch(() => null);
      if (copy) extra.push(`CODE_SIGN_ENTITLEMENTS=${copy}`);
    }
    const args = [
      ...(ios.workspace ? ['-workspace', ios.workspace] : ['-project', ios.xcodeproj]),
      '-scheme', scheme,
      '-configuration', params.configuration,
      '-destination', destinationFor(params.target),
      '-derivedDataPath', derivedData,
      '-IDEBuildLocationStyle=Unique',
      '-skipPackagePluginValidation',
      '-skipMacroValidation',
      ...(!mac && !isSim ? ['-allowProvisioningUpdates'] : []),
      'COMPILER_INDEX_STORE_ENABLE=NO',
      ...(team ? [`DEVELOPMENT_TEAM=${team}`] : []),
      ...extra,
      ...(params.extraArgs ?? []),
      ...(params.clean ? ['clean'] : []),
      'build',
    ];
    await fs.mkdir(paths.logs, { recursive: true });
    await pruneLogs(paths.logs, 8);
    const logPath = path.join(paths.logs, `build-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const logFile = createWriteStream(logPath);
    logFile.write(`$ xcodebuild ${args.join(' ')}\n\n`);
    const parser = new XcodeOutputParser({ ownRoot: paths.src });
    let lastProgress = 0;
    const where = mac ? 'the Mac' : params.target.name;
    await step(io, 'build', `Building ${scheme} (${params.configuration}) for ${where}`, async () => {
      const result = await run('xcodebuild', args, {
        cwd: ios.nativeProjectDir,
        env: await xcodeEnv(),
        signal: io.signal,
        capture: false,
        tailLines: 80,
        onLine: (line) => {
          logFile.write(`${line}\n`);
          if (params.verbose) io.send({ t: 'out', stream: 'stdout', text: line });
          for (const ev of parser.push(line)) {
            if (ev.kind === 'diag') io.send({ t: 'diag', ...ev.diag });
            else if (Date.now() - lastProgress > 120) {
              lastProgress = Date.now();
              io.send({ t: 'progress', text: ev.text, done: ev.done });
            }
          }
        },
      });
      for (const ev of parser.end()) if (ev.kind === 'diag') io.send({ t: 'diag', ...ev.diag });
      if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
      if (result.code !== 0) {
        const text = result.tail.join('\n');
        const hint = hintForBuildOutput(text) ?? hintForBuildOutput(parser.failedCommands.join('\n'));
        const tail = parser.errors > 0 ? [] : result.tail.filter((l) => l.trim() && !BUILD_NOISE.test(l)).slice(-25);
        throw new AgentError(parser.errors > 0 ? `Build failed with ${parser.errors} error${parser.errors === 1 ? '' : 's'}` : 'Build failed', hint?.code ?? REACT_NATIVE_ERROR_CODES.buildFailed, hint?.hint ?? `Full build log on the Mac: ${logPath}`, tail, logPath);
      }
    }).finally(() => new Promise<void>((resolve) => logFile.end(resolve)));

    settings ||= await projectSettingsFor(ios, scheme, app, params, derivedData, io.signal);
    if (!settings && !io.signal.aborted) settings = await projectSettingsFor(ios, scheme, app, params, derivedData, io.signal);
    if (io.signal.aborted) throw new AgentError('Cancelled', 'CANCELLED');
    const appPath = await findBuiltApp(productsDir, settings ?? null);
    // A Mac app keeps its Info.plist in Contents/.
    const info = await readAppInfo(mac ? path.join(appPath, 'Contents') : appPath);
    const record = { appPath, ...info, nativeGen: gen, webGen: rn.jsGen, at: Date.now(), resolved: true };
    state.builds[key] = record;
    await saveState(paths, state);
    return { skipped: false, ...record, warnings: parser.warnings, logPath };
  });
}
