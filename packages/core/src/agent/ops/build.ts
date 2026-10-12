import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildParams, BuildResult } from '../../shared/protocol.js';
import { hintForBuildOutput, XcodeOutputParser } from '../../shared/xcode-output.js';
import { toolEnv, xcodeEnv } from '../env.js';
import { locateIosProject } from '../ios-project.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, capture, exists, run } from '../proc.js';
import { loadState, projectPaths, saveState, withProjectLock, type BuildRecord } from '../state.js';

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

async function findBuiltApp(productsDir: string, scheme: string): Promise<string> {
  const entries = await fs.readdir(productsDir).catch(() => [] as string[]);
  const apps = entries.filter((name) => name.endsWith('.app'));
  const preferred = apps.find((name) => name === `${scheme}.app`) ?? apps[0];
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

/** xcodebuild bookkeeping lines that never help explain a failure. */
const BUILD_NOISE = /^\s*(cd |export |builtin-|\/Applications\/Xcode|ExecuteExternalTool|Build description (signature|path)|ClangStatCache|CpResource|SwiftDriver|SwiftEmitModule|EmitSwiftModule|SwiftCompile|CompileC|ProcessInfoPlistFile|CopySwiftLibs|RegisterExecutionPolicyException|Validate|Touch|CodeSign|ProcessProductPackaging|GenerateDSYMFile|Ld |WriteAuxiliaryFile|CreateBuildDirectory|MkDir|SymLink|PhaseScriptExecution|Command line invocation|note: |Prepare packages|ComputeTargetDependencyGraph|ComputePackagePrebuildTargetDependencyGraph|CreateBuildDescription|Resolve Package Graph|Resolved source packages|  [\w-]+: (https?:|\/))/;

function buildKey(params: BuildParams, scheme: string): string {
  const platform = params.target.kind === 'simulator' ? 'iphonesimulator' : 'iphoneos';
  const device = params.target.kind === 'device' ? params.target.udid : '';
  return [platform, params.configuration, scheme, device, params.team ?? '', params.auth?.keyId ?? ''].join('|');
}

async function pruneLogs(dir: string, keep: number): Promise<void> {
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith('build-')).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

export async function opBuild(params: BuildParams, io: AgentIO): Promise<BuildResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  return withProjectLock(paths, io, async () => {
    const state = await loadState(paths);
    const ios = await locateIosProject(paths.project, params.iosDir ?? 'ios');
    const scheme = params.scheme || 'App';
    const key = buildKey(params, scheme);
    const previous = state.builds[key];

    // Nothing native changed since the last good build: reuse it.
    if (!params.force && !params.clean && previous && previous.nativeGen === state.nativeGen && (await exists(previous.appPath))) {
      if (previous.webGen === state.webGen) {
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
    const destination = isSim ? `platform=iOS Simulator,id=${params.target.udid}` : `platform=iOS,id=${params.target.udid}`;
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
          hint?.hint ?? `Full build log on the Mac: ${logPath}${params.verbose ? '' : ' (or re-run with --verbose)'}`,
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
    const appPath = await findBuiltApp(productsDir, scheme);
    const info = await readAppInfo(appPath);
    const record: BuildRecord = { appPath, ...info, nativeGen: state.nativeGen, webGen: state.webGen, at: Date.now() };
    state.builds[key] = record;
    await saveState(paths, state);
    return { skipped: false, ...record, warnings: parser.warnings, logPath };
  });
}
