import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildParams, BuildResult } from '../../shared/protocol.js';
import { hintForBuildOutput, XcodeOutputParser } from '../../shared/xcode-output.js';
import { toolEnv, xcodeEnv } from '../env.js';
import { locateIosProject, type IosProject } from '../ios-project.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, capture, exists, run, tryCapture } from '../proc.js';
import { loadState, projectPaths, saveState, withProjectLock, type BuildRecord } from '../state.js';
import { signingTeamsFor } from './teams.js';

export interface AppInfo {
  bundleId: string;
  executable: string;
  displayName: string;
}

export async function readAppInfo(appPath: string): Promise<AppInfo> {
  const json = await capture('plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Info.plist')], { env: await toolEnv() });
  const info = JSON.parse(json);
  return {
    bundleId: String(info.CFBundleIdentifier ?? ''),
    executable: String(info.CFBundleExecutable ?? path.basename(appPath, '.app')),
    displayName: String(info.CFBundleDisplayName ?? info.CFBundleName ?? path.basename(appPath, '.app')),
  };
}

/** The app a scheme runs: its target, and the product that target builds (`PhoneApp`, `PhoneApp.app`). */
export interface SchemeApp {
  target: string;
  product: string;
}

const xmlText = (value: string) => value.replace(/&(quot|apos|lt|gt|amp);/g, (_, name: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[name]!);

/** The app an .xcscheme's Run action launches; null when it names none. */
export function launchedApp(schemeXml: string): SchemeApp | null {
  const launch = /<LaunchAction\b[\s\S]*?<\/LaunchAction>/.exec(schemeXml)?.[0] ?? '';
  const reference = /<BuildableProductRunnable\b[\s\S]*?<BuildableReference\b([^>]*)>/.exec(launch)?.[1];
  if (!reference) return null;
  const attribute = (name: string) => xmlText(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(reference)?.[1] ?? '');
  const target = attribute('BlueprintName');
  return target ? { target, product: attribute('BuildableName') || `${target}.app` } : null;
}

/**
 * The app `scheme` runs. A scheme can build several apps, so its file says
 * which (shared schemes first, then the Mac user's own). A scheme with no
 * file is one Xcode makes from the target of that name, like Capacitor's App.
 */
async function schemeApp(ios: IosProject, scheme: string): Promise<SchemeApp> {
  for (const container of [ios.workspace, ios.xcodeproj]) {
    if (!container) continue;
    const users = await fs.readdir(path.join(container, 'xcuserdata')).catch(() => [] as string[]);
    const files = [path.join(container, 'xcshareddata', 'xcschemes', `${scheme}.xcscheme`), ...users.map((user) => path.join(container, 'xcuserdata', user, 'xcschemes', `${scheme}.xcscheme`))];
    for (const file of files) {
      const xml = await fs.readFile(file, 'utf8').catch(() => null);
      if (xml !== null) return launchedApp(xml) ?? { target: scheme, product: `${scheme}.app` };
    }
  }
  return { target: scheme, product: `${scheme}.app` };
}

async function findBuiltApp(productsDir: string, app: SchemeApp, scheme: string): Promise<string> {
  const entries = await fs.readdir(productsDir).catch(() => [] as string[]);
  const apps = entries.filter((name) => name.endsWith('.app'));
  const preferred = [app.product, `${scheme}.app`].find((name) => apps.includes(name)) ?? apps[0];
  if (!preferred) throw new AgentError(`Build succeeded but no .app was found in ${productsDir}`, 'BUILD_FAILED');
  return path.join(productsDir, preferred);
}

/**
 * Copies the web assets `cap copy` produced into an already-built simulator
 * app and re-signs it ad hoc. Turns a web-only change into a ~1s update.
 */
export async function refreshWebAssets(appPath: string, iosAppDir: string): Promise<void> {
  const env = await toolEnv();
  const publicSrc = path.join(iosAppDir, 'public');
  const publicDest = path.join(appPath, 'public');
  await fs.rm(publicDest, { recursive: true, force: true });
  if (await exists(publicSrc)) await fs.cp(publicSrc, publicDest, { recursive: true });
  for (const name of ['capacitor.config.json', 'config.xml']) {
    const src = path.join(iosAppDir, name);
    if (await exists(src)) await fs.copyFile(src, path.join(appPath, name));
  }
  await capture('codesign', ['--force', '--sign', '-', '--preserve-metadata=identifier,entitlements,flags', '--timestamp=none', appPath], { env });
}

/** Whether a built app carries the same capacitor.config.json as the project (it may have the live-reload one). */
export async function bundledConfigMatches(appPath: string, iosAppDir: string): Promise<boolean> {
  const [built, source] = await Promise.all([
    fs.readFile(path.join(appPath, 'capacitor.config.json'), 'utf8').catch(() => null),
    fs.readFile(path.join(iosAppDir, 'capacitor.config.json'), 'utf8').catch(() => null),
  ]);
  return built === source;
}

/** xcodebuild bookkeeping lines that never help explain a failure. */
const BUILD_NOISE = /^\s*(cd |export |builtin-|\/Applications\/Xcode|ExecuteExternalTool|Build description (signature|path)|ClangStatCache|CpResource|SwiftDriver|SwiftEmitModule|EmitSwiftModule|SwiftCompile|CompileC|ProcessInfoPlistFile|CopySwiftLibs|RegisterExecutionPolicyException|Validate|Touch|CodeSign|ProcessProductPackaging|GenerateDSYMFile|Ld |WriteAuxiliaryFile|CreateBuildDirectory|MkDir|SymLink|PhaseScriptExecution|Command line invocation|note: |Prepare packages|ComputeTargetDependencyGraph|ComputePackagePrebuildTargetDependencyGraph|CreateBuildDescription|Resolve Package Graph|Resolved source packages|  [\w-]+: (https?:|\/))/;

function buildKey(params: BuildParams, scheme: string): string {
  const platform = params.target.kind === 'simulator' ? 'iphonesimulator' : 'iphoneos';
  const device = params.target.kind === 'device' ? params.target.udid : '';
  return [platform, params.configuration, scheme, device, params.team ?? '', params.auth?.keyId ?? ''].join('|');
}

/** Where xcodebuild builds for a target: a simulator, or a device by its UDID. */
export function destinationFor(target: BuildParams['target']): string {
  if (target.kind === 'simulator') return `platform=iOS Simulator,id=${target.udid}`;
  return `platform=iOS,id=${target.udid}`;
}

async function pruneLogs(dir: string, keep: number): Promise<void> {
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith('build-')).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

/**
 * xcodebuild's arguments for the build settings a device build of `scheme`
 * gets: the build's own project, configuration, derived data and extra
 * arguments (a team given as `DEVELOPMENT_TEAM=…` or in an `-xcconfig` file
 * counts), for any iOS device.
 */
export function settingsArgs(ios: Pick<IosProject, 'workspace' | 'xcodeproj'>, scheme: string, configuration: string, derivedData: string, extraArgs: string[] = []): string[] {
  return [
    ...(ios.workspace ? ['-workspace', ios.workspace] : ['-project', ios.xcodeproj]),
    '-scheme', scheme,
    '-configuration', configuration,
    '-destination', 'generic/platform=iOS',
    '-derivedDataPath', derivedData,
    '-skipPackagePluginValidation',
    '-skipMacroValidation',
    ...extraArgs,
    '-showBuildSettings',
    '-json',
  ];
}

/**
 * The development team `xcodebuild -showBuildSettings -json` gives `app`.
 * The output lists every target the scheme builds, other apps included, so
 * the app is found by its target (or product), else it is the only app
 * there. '' when it names no team; null when the output can't tell.
 */
export function teamOf(output: string, app: SchemeApp): string | null {
  let entries: unknown = null;
  for (const start of output.matchAll(/^\[/gm)) {
    try {
      entries = JSON.parse(output.slice(start.index));
      break;
    } catch {
      // A line of xcodebuild's own output, not the settings.
    }
  }
  if (!Array.isArray(entries)) return null;
  const targets = entries as Array<{ target?: string; buildSettings?: Record<string, string> }>;
  const apps = targets.filter((t) => t.buildSettings?.WRAPPER_EXTENSION === 'app' || t.buildSettings?.PRODUCT_TYPE === 'com.apple.product-type.application');
  const found =
    targets.find((t) => (t.target ?? t.buildSettings?.TARGET_NAME) === app.target) ??
    apps.find((t) => t.buildSettings?.FULL_PRODUCT_NAME === app.product) ??
    (apps.length === 1 ? apps[0] : undefined);
  return found?.buildSettings ? (found.buildSettings.DEVELOPMENT_TEAM ?? '').trim() : null;
}

/**
 * The development team the Xcode project gives the app `scheme` runs: ''
 * when it names none, null when CapMac could not find out. Asking xcodebuild
 * is the only way that also sees a team set in an .xcconfig or through a
 * `$(…)` variable, not only one written in the .pbxproj.
 */
async function projectTeamFor(ios: IosProject, scheme: string, app: SchemeApp, params: BuildParams, derivedData: string, signal: AbortSignal): Promise<string | null> {
  const args = settingsArgs(ios, scheme, params.configuration, derivedData, params.extraArgs);
  // Swift packages are resolved first, into the build's own derived data: the build then reuses them.
  const output = await tryCapture('xcodebuild', args, { cwd: ios.nativeProjectDir, env: await xcodeEnv(), timeoutMs: 120_000, signal });
  return output === null ? null : teamOf(output, app);
}

/**
 * The signing decision from what the project and the Mac offer. Pure, so it is
 * tested directly: an explicit team (or a simulator) wins; else a team the
 * Xcode project names (CapMac does not override it), or might name when
 * CapMac could not read it (null); else the one team whose development
 * profile covers the device; several of those and no choice is an error for
 * the project to settle.
 */
export function decideSigningTeam(input: {
  explicitTeam?: string;
  isSimulator: boolean;
  /** The team the Xcode project gives the app: '' none, null unknown. */
  projectTeam: string | null;
  coveringTeams: string[];
  targetName: string;
}): { team?: string; auto: boolean } | { error: { message: string; hint: string } } {
  if (input.isSimulator || input.explicitTeam) return { team: input.explicitTeam, auto: false };
  if (input.projectTeam !== '') return { team: undefined, auto: false };
  if (input.coveringTeams.length > 1) {
    return { error: { message: `Several development teams can sign for ${input.targetName}: ${input.coveringTeams.join(', ')}.`, hint: 'Pick one: set ios.team in capmac.json, or pass --team <TEAM_ID>.' } };
  }
  return { team: input.coveringTeams[0], auto: input.coveringTeams.length === 1 };
}

/**
 * The team a device build signs with: the project's (capmac.json/--team, else
 * whatever the Xcode project gives the app the scheme runs), else the one team
 * whose development profile on this Mac covers the device. CapMac only picks
 * when it knows the project names none, so it never overrides an explicit
 * choice nor blocks a build a configured project could make.
 */
async function signingTeam(params: BuildParams, ios: IosProject, scheme: string, app: SchemeApp, derivedData: string, io: AgentIO): Promise<string | undefined> {
  const isSimulator = params.target.kind === 'simulator';
  let projectTeam: string | null = '';
  let coveringTeams: string[] = [];
  if (!isSimulator && !params.team) {
    projectTeam = await projectTeamFor(ios, scheme, app, params, derivedData, io.signal);
    if (projectTeam === '') coveringTeams = await signingTeamsFor(params.target.udid, await toolEnv());
    if (projectTeam === null) io.log('debug', `Could not read the signing team of ${app.target} from the Xcode project, so CapMac leaves signing to it.`);
  }
  const decision = decideSigningTeam({ explicitTeam: params.team, isSimulator, projectTeam, coveringTeams, targetName: params.target.name });
  if ('error' in decision) throw new AgentError(decision.error.message, 'BUILD_FAILED', decision.error.hint);
  if (decision.auto && decision.team) io.log('info', `Signing with team ${decision.team}: its development profile covers ${params.target.name}.`);
  return decision.team;
}

export async function opBuild(params: BuildParams, io: AgentIO): Promise<BuildResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  return withProjectLock(paths, io, async () => {
    const state = await loadState(paths);
    const ios = await locateIosProject(paths.project, params.iosDir ?? 'ios');
    const scheme = params.scheme || 'App';
    const app = await schemeApp(ios, scheme);
    params = { ...params, team: await signingTeam(params, ios, scheme, app, paths.derivedData, io) };
    const key = buildKey(params, scheme);
    const previous = state.builds[key];

    // Nothing native changed since the last good build: reuse it.
    if (!params.force && !params.clean && previous && previous.nativeGen === state.nativeGen && (await exists(previous.appPath))) {
      // The build's own Capacitor config must match the project's: a build left over from live
      // reload still points at the dev server, and would show a blank page.
      if (previous.webGen === state.webGen && (await bundledConfigMatches(previous.appPath, ios.appDir))) {
        return { skipped: true, ...previous, warnings: 0, logPath: null };
      }
      if (params.target.kind === 'simulator') {
        await step(io, 'web', 'Updating web assets in the installed build (no native changes)', () => refreshWebAssets(previous.appPath, ios.appDir));
        previous.webGen = state.webGen;
        await saveState(paths, state);
        return { skipped: true, ...previous, warnings: 0, logPath: null };
      }
      // Device builds must be re-signed by Xcode; fall through to an incremental build.
    }

    const isSim = params.target.kind === 'simulator';
    const destination = destinationFor(params.target);
    // With an App Store Connect API key xcodebuild can manage profiles and
    // register the device without an Xcode account session (unreliable over SSH).
    let keyFile: string | null = null;
    const authArgs: string[] = [];
    if (!isSim && params.auth) {
      keyFile = path.join(os.tmpdir(), `capmac-AuthKey_${params.auth.keyId}-${process.pid}.p8`);
      await fs.writeFile(keyFile, params.auth.p8, { mode: 0o600 });
      authArgs.push(
        '-allowProvisioningDeviceRegistration',
        '-authenticationKeyPath', keyFile,
        '-authenticationKeyID', params.auth.keyId,
        '-authenticationKeyIssuerID', params.auth.issuerId,
      );
    }
    const args = [
      ...(ios.workspace ? ['-workspace', ios.workspace] : ['-project', ios.xcodeproj]),
      '-scheme', scheme,
      '-configuration', params.configuration,
      '-destination', destination,
      '-derivedDataPath', paths.derivedData,
      // Products go under -derivedDataPath even when Xcode's settings put builds elsewhere (Locations › Custom).
      '-IDEBuildLocationStyle=Unique',
      '-skipPackagePluginValidation',
      '-skipMacroValidation',
      ...(isSim ? [] : ['-allowProvisioningUpdates', ...authArgs]),
      'COMPILER_INDEX_STORE_ENABLE=NO',
      ...(params.team ? [`DEVELOPMENT_TEAM=${params.team}`] : []),
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
    const title = `Building ${scheme} (${params.configuration}) for ${params.target.name}`;
    const result = await step(io, 'build', title, async () => {
      const r = await run('xcodebuild', args, {
        cwd: ios.nativeProjectDir,
        env: await xcodeEnv(),
        signal: io.signal,
        capture: false,
        tailLines: 80,
        onLine: (line) => {
          logFile.write(`${line}\n`);
          if (params.verbose) io.send({ t: 'out', stream: 'stdout', text: line });
          for (const ev of parser.push(line)) {
            if (ev.kind === 'diag') {
              io.send({ t: 'diag', ...ev.diag });
            } else if (Date.now() - lastProgress > 120) {
              lastProgress = Date.now();
              io.send({ t: 'progress', text: ev.text, done: ev.done });
            }
          }
        },
      });
      for (const ev of parser.end()) if (ev.kind === 'diag') io.send({ t: 'diag', ...ev.diag });
      if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
      if (r.code !== 0) {
        const text = r.tail.join('\n');
        const hint = hintForBuildOutput(text) ?? hintForBuildOutput(parser.failedCommands.join('\n'));
        // The diagnostics were already shown; only fall back to raw output when there were none.
        const tail = parser.errors > 0 ? [] : r.tail.filter((l) => l.trim() && !BUILD_NOISE.test(l)).slice(-25);
        throw new AgentError(
          parser.errors > 0 ? `Build failed with ${parser.errors} error${parser.errors === 1 ? '' : 's'}` : 'Build failed',
          hint?.code ?? 'BUILD_FAILED',
          // Front ends add their own advice (the CLI: --verbose; capmac Studio: its build log button).
          hint?.hint ?? `Full build log on the Mac: ${logPath}`,
          tail,
          logPath,
        );
      }
      return r;
    }).finally(async () => {
      await new Promise<void>((resolve) => logFile.end(resolve));
      if (keyFile) await fs.rm(keyFile, { force: true }).catch(() => undefined);
    });
    void result;

    const productsDir = path.join(paths.derivedData, 'Build', 'Products', `${params.configuration}-${isSim ? 'iphonesimulator' : 'iphoneos'}`);
    const appPath = await findBuiltApp(productsDir, app, scheme);
    // Xcode can leave a resource it thinks unchanged (the live-reload config): bring it in step.
    if (isSim && !(await bundledConfigMatches(appPath, ios.appDir))) await refreshWebAssets(appPath, ios.appDir);
    const info = await readAppInfo(appPath);
    const record: BuildRecord = { appPath, ...info, nativeGen: state.nativeGen, webGen: state.webGen, at: Date.now() };
    state.builds[key] = record;
    await saveState(paths, state);
    return { skipped: false, ...record, warnings: parser.warnings, logPath };
  });
}
