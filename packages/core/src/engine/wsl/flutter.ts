/**
 * A Flutter app's iOS app, built on this PC with no Mac (in CapMac's WSL
 * distro). Flutter's own Linux tools compile the Dart code to kernel and make
 * the asset bundle; Dart's iPhone AOT compiler, which Google ships for Macs
 * only, is built from Dart's source once (flutter/dart-ios-compiler.sh: the
 * same compiler, it writes byte for byte the App that Flutter's writes on a
 * Mac); Flutter's iPhone engine comes from Google's download. The Runner
 * Xcode project then builds as any app does here: Flutter's Xcode scripts
 * are left out (flutter/flutter-ios.py has made what they make), and its
 * plugins come as the Swift packages Flutter makes on a Mac.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log, throwIfAborted, withStep, type EngineContext, type StepHandle } from '../context.js';
import { UserError } from '../errors.js';
import { localFlutter } from '../flutter/local.js';
import { latestStable } from '../flutter/pc.js';
import type { ProjectInfo } from '../project.js';
import type { WslBuildPlan } from './compiler.js';
import type { WslNativeBuildPlan, WslNativeGraph, WslNativeTarget } from './native-compiler.js';
import exporter from './pods-export.rb';
import { importSwiftPackages, type WslXcodeGraph } from './swift-packages.js';
import type { WslExecutor, WslToolchainTools } from './toolchain.js';
import appleHeapsort from './flutter/apple_heapsort.c';
import appleQsort from './flutter/apple_qsort.c';
import capmacQsort from './flutter/capmac_apple_qsort.c';
import compilerScript from './flutter/dart-ios-compiler.sh';
import patchScript from './flutter/dart-ios-patch.py';
import flutterIos from './flutter/flutter-ios.py';
import flutterLinux from './flutter/flutter-linux.sh';

/** Release or profile: an iPhone runs Flutter's AOT builds without a debugger (debug builds need Xcode's). */
export type WslFlutterMode = 'release' | 'profile';

/** Flutter's Linux SDK in the distro, and what it was built with. */
export interface WslFlutterSdk {
  root: string;
  version: string;
  engineRevision: string;
  dartRevision: string;
  /** Dart's iPhone AOT compiler for that Dart. */
  compiler: string;
  /** Flutter's iPhone engine for the mode (Flutter.xcframework inside). */
  engine: string;
}

export interface WslFlutterOptions {
  executor: WslExecutor;
  tools: WslToolchainTools;
  /** Where CapMac keeps this build's notes on Windows (the Xcode graph). */
  directory: string;
  outputDirectory: string;
  signing: WslBuildPlan['signing'];
  mode: WslFlutterMode;
  rubyPath?: string;
  xcodeVersion?: string;
}

const homes = new WeakMap<WslExecutor, string>();

async function linuxHome(executor: WslExecutor, signal: AbortSignal): Promise<string> {
  const known = homes.get(executor);
  if (known) return known;
  const home = (await executor.run(['sh', '-c', 'printf %s "$HOME"'], { signal })).stdout.trim();
  if (!home.startsWith('/')) throw new UserError('CapMac’s WSL distro has no home folder.');
  homes.set(executor, home);
  return home;
}

/** Shows a long tool's own `capmac: …` lines as the step's progress, everything else in Output. */
function progress(ctx: EngineContext, step: StepHandle) {
  return (text: string, stream: 'stdout' | 'stderr') => {
    for (const line of text.split('\n')) {
      const own = /^capmac(?:-step)?: (.+)$/.exec(line.trim());
      if (own) step.update(own[1]!);
    }
    ctx.emit({ type: 'tool-output', text, stream });
  };
}

/** The Flutter version for the project: the one it pins, else this PC's, else the latest stable. */
async function wantedVersion(project: ProjectInfo): Promise<string> {
  return project.flutter?.wantsFlutter.exact ?? (await localFlutter())?.version ?? (await latestStable());
}

/**
 * Flutter's Linux SDK, Dart's iPhone compiler and Flutter's iPhone engine in
 * the distro: each installed the first time (a few minutes, then cached).
 */
export async function ensureWslFlutter(project: ProjectInfo, executor: WslExecutor, mode: WslFlutterMode, ctx: EngineContext, signal: AbortSignal): Promise<WslFlutterSdk> {
  throwIfAborted(signal);
  const version = await wantedVersion(project);
  const home = await linuxHome(executor, signal);
  const root = `${home}/.local/share/capmac/flutter/${version}/flutter`;
  const read = async (): Promise<{ engineRevision: string; dartRevision: string } | null> => {
    const result = await executor.run(['sh', '-c', 'grep -q "\\"frameworkVersion\\": *\\"$2\\"" "$1/bin/cache/flutter.version.json" && cat "$1/bin/internal/engine.version" && grep -m1 "\'dart_revision\'" "$1/DEPS"', 'sh', root, version], { signal, allowFailure: true });
    if (result.code !== 0) return null;
    const [engine, deps] = result.stdout.trim().split('\n');
    const dart = /'dart_revision':\s*'([0-9a-f]{40})'/.exec(deps ?? '')?.[1];
    return engine && /^[0-9a-f]{40}$/.test(engine.trim()) && dart ? { engineRevision: engine.trim(), dartRevision: dart } : null;
  };
  let revisions = await read();
  if (!revisions) {
    await withStep(ctx, `Getting Flutter ${version} for building on this PC`, 'deps', (step) => executor.run(['env', `VERSION=${version}`, `DEST=${path.posix.dirname(root)}`, 'bash', '-s'], {
      // From a Linux folder: git, which Flutter runs, refuses a Windows checkout's .git it cannot read.
      stdin: flutterLinux, cwd: home, signal, timeoutMs: 60 * 60_000, onOutput: progress(ctx, step),
    }));
    revisions = await read();
    if (!revisions) throw new UserError(`Flutter ${version} did not install in CapMac’s WSL distro.`, 'See Output for what Flutter said, then try again.');
  }
  const compiler = `${home}/.local/share/capmac/dart-ios-compiler/${revisions.dartRevision}/gen_snapshot_product_ios_arm64`;
  if ((await executor.run(['test', '-x', compiler], { signal, allowFailure: true })).code !== 0) {
    await withStep(ctx, 'Building Dart’s iPhone compiler (once, about 5 minutes)', 'deps', async (step) => {
      const tools = `${home}/.cache/capmac/dart-ios-compiler/tools`;
      const files = { 'dart-ios-compiler.sh': compilerScript, 'dart-ios-patch.py': patchScript, 'apple_qsort.c': appleQsort, 'apple_heapsort.c': appleHeapsort, 'capmac_apple_qsort.c': capmacQsort };
      await executor.run(['python3', '-c', 'import json,pathlib,sys; d=pathlib.Path(sys.argv[1]); d.mkdir(parents=True,exist_ok=True); [ (d/n).write_text(t) for n,t in json.load(sys.stdin).items() ]', tools], { signal, stdin: JSON.stringify(files) });
      await executor.run(['env', `DART_REV=${revisions!.dartRevision}`, `WORK=${home}/.cache/capmac/dart-ios-compiler/${revisions!.dartRevision}`, `OUT=${compiler}`, 'bash', `${tools}/dart-ios-compiler.sh`], {
        cwd: home, signal, timeoutMs: 120 * 60_000, onOutput: progress(ctx, step),
      });
    });
  }
  const engine = `${home}/.local/share/capmac/flutter-ios-engine/${revisions.engineRevision}/ios-${mode}`;
  if ((await executor.run(['test', '-f', `${engine}/Flutter.xcframework/ios-arm64/Flutter.framework/Flutter`], { signal, allowFailure: true })).code !== 0) {
    await withStep(ctx, `Getting Flutter’s iPhone engine (${mode})`, 'deps', (step) => executor.run(['sh', '-c', [
      'set -e', 'rm -rf "$1.part" "$1.zip"', 'mkdir -p "$1.part"',
      'curl -sSfL -o "$1.zip" "https://storage.googleapis.com/flutter_infra_release/flutter/$2/$3/artifacts.zip"',
      'python3 -c \'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])\' "$1.zip" "$1.part"',
      'rm -rf "$1" && mv "$1.part" "$1" && rm -f "$1.zip"',
    ].join('\n'), 'sh', engine, revisions!.engineRevision, `ios-${mode}`], { cwd: home, signal, timeoutMs: 30 * 60_000, onOutput: progress(ctx, step) }));
  }
  return { root, version, ...revisions, compiler, engine };
}

/** What flutter-ios.py made. */
interface FlutterIosResult {
  app: string;
  ios: string;
  /** The folder with App.framework and Flutter.framework. */
  frameworks: string;
  minimum: string;
}

function append(settings: Record<string, string | string[]>, key: string, value: string): void {
  const current = settings[key];
  settings[key] = Array.isArray(current) ? [...current, value] : current ? [current, value] : ['$(inherited)', value];
}

/** Flutter's frameworks in the build: Flutter.framework linked and embedded, App.framework embedded (the engine opens it). */
export function addFlutterFrameworks(graph: WslNativeGraph, frameworks: string): void {
  const root = graph.targets.find((target) => target.id === graph.rootTargetId);
  if (!root) throw new UserError('The Flutter app’s Xcode project has no Runner app target.');
  for (const target of graph.targets) {
    // The plugins' code and the app's import Flutter.
    append(target.settings, 'FRAMEWORK_SEARCH_PATHS', frameworks);
  }
  root.frameworks = [
    ...root.frameworks.filter((framework) => !/(^|\/)(Flutter|App)\.(x?c?framework)$/.test(framework.path ?? '')),
    { path: `${frameworks}/Flutter.framework`, embed: true },
    { path: `${frameworks}/App.framework`, embed: true, link: false },
  ];
}

/** Flutter's Xcode build phases (xcode_backend.sh build / embed_and_thin): their work is done. */
export function withoutFlutterScripts(targets: WslNativeTarget[]): void {
  for (const target of targets) target.scripts = target.scripts.filter((phase) => !/xcode_backend\.(sh|dart)/.test(phase.script));
}

/**
 * Makes everything Flutter's Xcode scripts make (in CapMac's copy of the
 * project in WSL), then imports the Runner project and its Swift packages:
 * the build plan for CapMac's native compiler.
 */
export async function prepareFlutterIos(project: ProjectInfo, options: WslFlutterOptions, ctx: EngineContext, signal: AbortSignal): Promise<WslNativeBuildPlan> {
  const flutter = project.flutter;
  if (!flutter?.platforms.ios) throw new UserError('This Flutter app has no iOS app.', 'Add one with `flutter create --platforms ios .` in its folder.');
  const { executor } = options;
  const sdk = await ensureWslFlutter(project, executor, options.mode, ctx, signal);
  const home = await linuxHome(executor, signal);
  const work = `${home}/.cache/capmac/flutter-builds/${project.projectId}`;
  const job = {
    source: await executor.path(project.syncRoot, signal),
    work,
    appRel: project.projectRel,
    flutter: sdk.root,
    compiler: sdk.compiler,
    engine: sdk.engine,
    mode: options.mode,
    target: flutter.options.target ?? 'lib/main.dart',
    strip: options.tools.stripPath ?? 'llvm-strip',
    ...(flutter.options.flavor ? { flavor: flutter.options.flavor } : {}),
    ...(flutter.options.dartDefines ? { dartDefines: flutter.options.dartDefines } : {}),
  };
  const made = await withStep(ctx, `Compiling the Flutter app (${options.mode})`, 'build', async (step) => {
    const run = await executor.run(['python3', '-c', flutterIos], { cwd: home, signal, timeoutMs: 60 * 60_000, stdin: JSON.stringify(job), allowFailure: true, onOutput: progress(ctx, step) });
    const lines = run.stdout.split('\n').map((line) => line.trim());
    const said = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
    const result = said('capmac-result: ');
    if (run.code !== 0 || !result) {
      const failure = said('capmac-error: ');
      throw new UserError(failure ? `${failure}.` : 'Flutter could not compile the app on this PC.', 'See Output for what Flutter said.', lines.filter((line) => line && !line.startsWith('capmac')).slice(-20));
    }
    return JSON.parse(result) as FlutterIosResult;
  });
  // The Runner project, as Xcode sees it, with its Swift packages.
  return withStep(ctx, 'Importing the Runner project and its plugins', 'deps', async () => {
    await fs.mkdir(options.directory, { recursive: true });
    const rubyFile = path.join(options.directory, 'xcode-export.rb');
    const nativeFile = path.join(options.directory, 'xcode-graph.json');
    const completeFile = path.join(options.directory, 'native-graph.json');
    await fs.writeFile(rubyFile, exporter);
    const [rubyWsl, nativeWsl] = await Promise.all([executor.path(rubyFile, signal), executor.path(nativeFile, signal)]);
    const flavor = flutter.options.flavor;
    const configuration = `${options.mode === 'profile' ? 'Profile' : 'Release'}${flavor ? `-${flavor}` : ''}`;
    await executor.run([options.rubyPath ?? 'ruby', rubyWsl], {
      signal, timeoutMs: 120_000,
      stdin: JSON.stringify({ projectRoot: `${work}/src`, projectDirectory: made.ios, swiftPackages: true, configuration, sdkPath: options.tools.sdkPath, scheme: flavor ?? 'Runner', output: nativeWsl, xcodeVersion: options.xcodeVersion }),
      onOutput: (text, stream) => ctx.emit({ type: 'tool-output', text, stream }),
    });
    const graph = JSON.parse(await fs.readFile(nativeFile, 'utf8')) as WslXcodeGraph;
    withoutFlutterScripts(graph.targets);
    const imported = await importSwiftPackages(graph, executor, { outputPath: completeFile, generatedDirectory: path.join(options.directory, 'swift-generated'), tools: options.tools }, ctx, signal);
    addFlutterFrameworks(imported, made.frameworks);
    log(ctx, 'debug', `Flutter ${sdk.version} (engine ${sdk.engineRevision.slice(0, 10)}, Dart ${sdk.dartRevision.slice(0, 10)}): iOS ${made.minimum}+`);
    return { graph: imported, outputDirectory: options.outputDirectory, signing: options.signing };
  });
}
