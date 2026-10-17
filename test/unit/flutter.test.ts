import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appsOf } from '../../packages/core/src/engine/apps.js';
import type { EngineContext, EngineEvent } from '../../packages/core/src/engine/index.js';
import { classifyFlutterChange, matters, needsRebuild } from '../../packages/core/src/engine/flutter/changes.js';
import { describeFlutterProject, flutterDisplayName } from '../../packages/core/src/engine/flutter/project.js';
import { isFlutterApp, parseYaml, readPubspec } from '../../packages/core/src/engine/flutter/pubspec.js';
import { flutterLogEntry, flutterPhase, FlutterRunner, type DaemonTransport } from '../../packages/core/src/engine/flutter/runner.js';
import { appFor, loadProject, runsOnMac, runsOnPc } from '../../packages/core/src/engine/project.js';
import { addFlutterFrameworks, withoutFlutterScripts } from '../../packages/core/src/engine/wsl/flutter.js';
import type { WslNativeGraph, WslNativeTarget } from '../../packages/core/src/engine/wsl/native-compiler.js';
import { buildArgs, parseDaemonLine, type FlutterDaemonMessage, type FlutterRunResult } from '../../packages/core/src/shared/flutter.js';

let dir: string;
let configDir: string;
const savedConfigDir = process.env.CAPMAC_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-flutter-'));
  mkdirSync(path.join(dir, '.git'));
  configDir = mkdtempSync(path.join(os.tmpdir(), 'capmac-flutter-config-'));
  process.env.CAPMAC_CONFIG_DIR = configDir;
});
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CAPMAC_CONFIG_DIR;
  else process.env.CAPMAC_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const write = (rel: string, content = '') => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const PUBSPEC = `name: hello_flutter
description: "A sample: CapMac's Flutter app."
publish_to: 'none' # private
version: 1.2.0+7

environment:
  sdk: ^3.13.5
  flutter: ">=3.47.0"

dependencies:
  flutter:
    sdk: flutter
  shared_preferences: ^2.5.3
  local_thing:
    path: ../local_thing

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^6.0.0

flutter:
  uses-material-design: true
  assets:
    - assets/
`;

/** A Flutter app with its iOS, Mac and Windows apps, as `flutter create` makes them. */
function flutterApp({ ios = true, macos = true, windows = true } = {}) {
  write('pubspec.yaml', PUBSPEC);
  write('lib/main.dart', 'void main() {}\n');
  if (ios) {
    write('ios/Runner.xcodeproj/project.pbxproj', [
      'PRODUCT_BUNDLE_IDENTIFIER = dev.capmac.hello.flutter.RunnerTests;',
      'PRODUCT_BUNDLE_IDENTIFIER = dev.capmac.hello.flutter;',
      '/* FlutterGeneratedPluginSwiftPackage */',
    ].join('\n'));
    write('ios/Runner/Info.plist', '<plist><dict><key>CFBundleDisplayName</key><string>Hello Flutter</string></dict></plist>');
  }
  if (macos) {
    write('macos/Runner.xcodeproj/project.pbxproj', 'PRODUCT_BUNDLE_IDENTIFIER = dev.capmac.hello.flutter;');
    write('macos/Runner/Configs/AppInfo.xcconfig', 'PRODUCT_NAME = Hello Flutter Mac\nPRODUCT_BUNDLE_IDENTIFIER = dev.capmac.hello.mac\n');
    write('macos/Podfile', "platform :osx, '10.15'\n");
  }
  if (windows) write('windows/CMakeLists.txt', 'project(hello_flutter LANGUAGES CXX)\nset(BINARY_NAME "hello_flutter")\n');
}

describe('pubspec.yaml', () => {
  it('reads block maps, lists, quoted strings, comments and flow values', () => {
    const value = parseYaml('a: 1\nb: "two # not a comment"\nc: [x, y]\nd: {}\ne:\n  - one\n  - two: 2\nf: true # comment\n') as Record<string, unknown>;
    expect(value).toEqual({ a: 1, b: 'two # not a comment', c: ['x', 'y'], d: {}, e: ['one', { two: 2 }], f: true });
  });

  it('reads a Flutter app’s pubspec', () => {
    const pubspec = readPubspec(PUBSPEC);
    expect(pubspec.name).toBe('hello_flutter');
    expect(pubspec.version).toBe('1.2.0+7');
    expect(pubspec.environment.flutter).toBe('>=3.47.0');
    expect(pubspec.dependencies.flutter?.sdk).toBe('flutter');
    expect(pubspec.dependencies.local_thing?.path).toBe('../local_thing');
    expect(Object.keys(pubspec.devDependencies)).toEqual(['flutter_test', 'flutter_lints']);
    expect(pubspec.hasFlutterSection).toBe(true);
    expect(isFlutterApp(pubspec)).toBe(true);
  });

  it('tells a plugin and a Dart package from an app', () => {
    expect(isFlutterApp(readPubspec('name: a_plugin\ndependencies:\n  flutter:\n    sdk: flutter\nflutter:\n  plugin:\n    platforms:\n      ios:\n        pluginClass: APlugin\n'))).toBe(false);
    expect(isFlutterApp(readPubspec('name: a_package\ndependencies:\n  meta: ^1.0.0\n'))).toBe(false);
  });
});

describe('a Flutter project', () => {
  it('has its platform apps, ids, names and plugin manager', () => {
    flutterApp();
    const project = describeFlutterProject(dir)!;
    expect(project.platforms).toEqual({ ios: true, macos: true, windows: true });
    expect(project.ios).toMatchObject({ bundleId: 'dev.capmac.hello.flutter', displayName: 'Hello Flutter', plugins: 'SPM' });
    expect(project.macos).toMatchObject({ bundleId: 'dev.capmac.hello.mac', displayName: 'Hello Flutter Mac', plugins: 'CocoaPods' });
    expect(project.windowsBinary).toBe('hello_flutter');
    expect(project.wantsFlutter).toEqual({ exact: null, constraint: '>=3.47.0' });
    expect(flutterDisplayName(project)).toBe('Hello Flutter');
  });

  it('takes the Flutter version from FVM and options from capmac.json', () => {
    flutterApp();
    write('.fvmrc', JSON.stringify({ flutter: '3.47.7' }));
    write('capmac.json', JSON.stringify({ flutter: { target: 'lib\\main_dev.dart', flavor: 'dev', dartDefines: { API: 'https://x', N: 3 } } }));
    const project = describeFlutterProject(dir)!;
    expect(project.wantsFlutter.exact).toBe('3.47.7');
    expect(project.target).toBe('lib/main_dev.dart');
    expect(project.options.flavor).toBe('dev');
    expect(project.options.dartDefines).toEqual({ API: 'https://x', N: '3' });
  });

  it('loads as a Flutter project with its three apps', async () => {
    flutterApp();
    const project = await loadProject(dir);
    expect(project.kind).toBe('flutter');
    expect(project.appId).toBe('dev.capmac.hello.flutter');
    expect(project.appName).toBe('Hello Flutter');
    expect(project.iosDir).toBe('ios');
    expect(project.scheme).toBe('Runner');
    const apps = await appsOf(project);
    expect(apps.map((app) => [app.id, app.platform, app.framework])).toEqual([['ios', 'ios', 'flutter'], ['macos', 'mac', 'flutter'], ['windows', 'windows', 'flutter']]);
  });

  it('picks the app a command is for, with the names people use', async () => {
    flutterApp();
    const project = await loadProject(dir);
    expect(appFor(project, {})).toBe('ios');
    expect(appFor(project, { app: 'mac' })).toBe('macos');
    expect(appFor(project, { app: 'pc' })).toBe('windows');
    expect(appFor(project, { app: 'win' })).toBe('windows');
    expect(appFor(project, { app: 'iphone' })).toBe('ios');
    expect(appFor(project, { target: 'mac' })).toBe('macos');
    expect(appFor(project, { target: 'pc' })).toBe('windows');
    expect(() => appFor(project, { app: 'electron' })).toThrow(/no app called "electron"/);
    expect(runsOnMac(project, { app: 'macos' })).toBe(true);
    expect(runsOnMac(project, { app: 'ios' })).toBe(false);
    expect(runsOnPc(project, { app: 'windows' })).toBe(true);
  });

  it('runs the app it has when it has one', async () => {
    flutterApp({ ios: false, macos: false });
    const project = await loadProject(dir);
    expect(appFor(project, {})).toBe('windows');
  });
});

describe('what a save changes in a Flutter app', () => {
  it('sorts files into Dart code, assets, dependencies and native code', () => {
    expect(classifyFlutterChange('lib/main.dart', '')).toBe('dart');
    expect(classifyFlutterChange('app/lib/widgets/card.dart', 'app')).toBe('dart');
    expect(classifyFlutterChange('assets/logo.png', '')).toBe('asset');
    expect(classifyFlutterChange('pubspec.yaml', '')).toBe('deps');
    expect(classifyFlutterChange('pubspec.lock', '')).toBe('deps');
    expect(classifyFlutterChange('ios/Runner/AppDelegate.swift', '')).toBe('ios');
    expect(classifyFlutterChange('macos/Runner/MainFlutterWindow.swift', '')).toBe('macos');
    expect(classifyFlutterChange('windows/runner/main.cpp', '')).toBe('windows');
    expect(classifyFlutterChange('android/app/build.gradle', '')).toBe('ignore');
    expect(classifyFlutterChange('README.md', '')).toBe('ignore');
    expect(classifyFlutterChange('.dart_tool/package_config.json', '')).toBe('ignore');
    expect(classifyFlutterChange('build/ios/x.o', '')).toBe('ignore');
  });

  it('hot-reloads Dart code and assets, rebuilds for dependencies and the app’s own native code', () => {
    expect(needsRebuild(['dart', 'asset'], 'ios')).toBe(false);
    expect(needsRebuild(['deps'], 'macos')).toBe(true);
    expect(needsRebuild(['ios'], 'ios')).toBe(true);
    expect(needsRebuild(['ios'], 'windows')).toBe(false);
    expect(needsRebuild(['darwin'], 'macos')).toBe(true);
    expect(matters('windows', 'ios')).toBe(false);
    expect(matters('dart', 'windows')).toBe(true);
  });
});

describe('Flutter’s output', () => {
  it('parses daemon lines', () => {
    expect(parseDaemonLine('[{"event":"app.started","params":{"appId":"a"}}]')).toEqual([{ event: 'app.started', params: { appId: 'a' } }]);
    expect(parseDaemonLine('Launching lib/main.dart on iPhone 17 in debug mode...')).toBeNull();
  });

  it('turns a Dart print into a console line and the engine’s notes into native ones', () => {
    expect(flutterLogEntry('flutter: Hello CapMac!')).toMatchObject({ kind: 'console', level: 'log', text: 'Hello CapMac!' });
    expect(flutterLogEntry('[IMPORTANT:flutter/shell/x.mm(53)] Using the Impeller rendering backend')).toMatchObject({ kind: 'native', level: 'info' });
    expect(flutterLogEntry('flutter: Exception: boom')).toMatchObject({ level: 'error' });
    expect(flutterLogEntry('flutter: The Dart VM service is listening on http://127.0.0.1:1234/abc=/')).toBeNull();
    expect(flutterLogEntry('   ')).toBeNull();
  });

  it('puts Flutter’s progress in the timeline’s phases', () => {
    expect(flutterPhase('Running pod install...')).toBe('deps');
    expect(flutterPhase('Running Xcode build...')).toBe('build');
    expect(flutterPhase('Installing and launching...')).toBe('launch');
    expect(flutterPhase('Installing build/app.apk...')).toBe('install');
    expect(flutterPhase('Syncing files to device iPhone...', null)).toBe('launch');
    expect(flutterPhase('Performing hot reload...', 'hot.reload')).toBe('other');
  });

  it('passes the build options as Flutter’s flags', () => {
    expect(buildArgs({ mode: 'release', target: 'lib/main_dev.dart', flavor: 'dev', dartDefines: { A: '1' }, dartDefineFile: 'env.json', args: ['--no-tree-shake-icons'] })).toEqual([
      '--release', '--target', 'lib/main_dev.dart', '--flavor', 'dev', '--dart-define', 'A=1', '--dart-define-from-file', 'env.json', '--no-tree-shake-icons',
    ]);
  });
});

/** A runner fed by hand, with what it sends back recorded. */
function fakeRunner(options: { attached?: boolean; desktop?: boolean } = {}) {
  const events: EngineEvent[] = [];
  const sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  let finish!: (result: FlutterRunResult) => void;
  const transport: DaemonTransport = {
    send: (id, method, params) => sent.push({ id, method, params }),
    done: new Promise<FlutterRunResult>((resolve) => (finish = resolve)),
    stop: () => finish({ reason: 'cancelled', exitCode: null }),
  };
  const ctx: EngineContext = { emit: (event) => events.push(event), prompter: { interactive: false } as EngineContext['prompter'], verbose: false };
  const runner = new FlutterRunner(transport, ctx, { appName: 'Hello Flutter', where: 'iPhone 17', bundleId: 'dev.capmac.hello.flutter', ...options });
  const feed = (...messages: FlutterDaemonMessage[]) => messages.forEach((message) => runner.handle(message));
  return { runner, events, sent, feed, finish };
}

describe('a Flutter run', () => {
  it('shows Flutter’s steps, then the running app', async () => {
    const { runner, events, feed } = fakeRunner();
    feed(
      { event: 'app.start', params: { appId: 'a1', supportsRestart: true } },
      { event: 'app.progress', params: { id: '1', message: 'Running Xcode build...' } },
      { event: 'daemon.logMessage', params: { level: 'status', message: 'flutter: Hello CapMac!' } },
      { event: 'app.progress', params: { id: '1', finished: true } },
      { event: 'app.started', params: { appId: 'a1' } },
    );
    await runner.started;
    expect(events.filter((event) => event.type === 'step').map((event) => (event as { title: string }).title)).toEqual(['Running Xcode build', 'Launching Hello Flutter']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'app-log', entry: expect.objectContaining({ kind: 'console', text: 'Hello CapMac!' }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'app', state: 'running', name: 'Hello Flutter', target: 'iPhone 17' }));
    expect(runner.supportsRestart).toBe(true);
  });

  it('hot-reloads, and says when a change needs a hot restart', async () => {
    const { runner, sent, feed } = fakeRunner();
    feed({ event: 'app.start', params: { appId: 'a1' } }, { event: 'app.started', params: { appId: 'a1' } });
    const reload = runner.reload(false);
    await Promise.resolve();
    expect(sent.at(-1)).toMatchObject({ method: 'app.restart', params: { appId: 'a1', fullRestart: false } });
    feed({ id: sent.at(-1)!.id, result: { code: 1, message: 'Hot reload was rejected: Const class cannot become non-const' } } as FlutterDaemonMessage);
    await expect(reload).resolves.toMatchObject({ ok: false, needsRestart: true });
  });

  it('adds no steps or app states of its own when attached to an app CapMac launched', async () => {
    const { runner, events, feed } = fakeRunner({ attached: true });
    feed({ event: 'app.start', params: { appId: 'a1' } }, { event: 'app.progress', params: { id: '2', progressId: 'devFS.update', message: 'Syncing files...' } }, { event: 'app.started', params: { appId: 'a1' } });
    await runner.started;
    expect(events.filter((event) => event.type === 'step' || event.type === 'app')).toEqual([]);
  });

  it('shows a Windows app’s Dart lines, which come outside the protocol without "flutter: "', async () => {
    // What `flutter run --machine -d windows` printed for the sample (Flutter 3.47.7).
    const { runner, events, feed } = fakeRunner({ desktop: true });
    feed({ event: 'app.start', params: { appId: 'a1', supportsRestart: true } });
    runner.output('Launching lib\\main.dart on Windows in debug mode...', 'stdout');
    feed({ event: 'app.progress', params: { appId: 'a1', id: '0', progressId: null, message: 'Building Windows application...', finished: false } });
    feed({ event: 'app.progress', params: { appId: 'a1', id: '0', progressId: null, finished: true } });
    runner.output('√ Built build\\windows\\x64\\runner\\Debug\\hello_flutter.exe', 'stdout');
    runner.output('[IMPORTANT:flutter/shell/platform/embedder/embedder_surface_gl_impeller.cc(126)] Using the Impeller rendering backend (OpenGLESSDF).', 'stdout');
    feed({ event: 'app.progress', params: { appId: 'a1', id: '1', progressId: 'devFS.update', message: 'Syncing files to device Windows...', finished: false } });
    runner.output('Hello CapMac! Running on windows', 'stdout');
    feed({ event: 'app.progress', params: { appId: 'a1', id: '1', progressId: 'devFS.update', finished: true } }, { event: 'app.started', params: { appId: 'a1' } });
    await runner.started;
    runner.output('Counter: 1', 'stdout');
    runner.output('Application finished.', 'stdout');
    const logs = events.filter((event) => event.type === 'app-log').map((event) => (event as { entry: { kind: string; text: string } }).entry);
    expect(logs).toEqual([
      expect.objectContaining({ kind: 'native', text: expect.stringContaining('Impeller') }),
      expect.objectContaining({ kind: 'console', text: 'Hello CapMac! Running on windows' }),
      expect.objectContaining({ kind: 'console', text: 'Counter: 1' }),
    ]);
    // Flutter's own lines stay Flutter's.
    const tool = events.filter((event) => event.type === 'tool-output').map((event) => (event as { text: string }).text);
    expect(tool).toEqual([expect.stringContaining('Launching'), expect.stringContaining('Built build'), 'Application finished.']);
  });

  it('keeps an iPhone run’s unprefixed lines as Flutter’s', () => {
    const { runner, events } = fakeRunner();
    runner.output('[IMPORTANT:flutter/shell/platform/darwin/graphics/FlutterDarwinContextMetalImpeller.mm(45)] Using the Impeller rendering backend (Metal).', 'stdout');
    runner.output('Some tool line', 'stdout');
    expect(events.filter((event) => event.type === 'tool-output').map((event) => (event as { text: string }).text)).toEqual(['Some tool line']);
  });

  it('says Flutter’s own error when it stops before the app starts', async () => {
    const { runner, finish } = fakeRunner();
    finish({ reason: 'exited', exitCode: 1, error: 'Error: Unable to find suitable Visual Studio toolchain. Please run `flutter doctor` for more details.', tail: ['Launching lib\\main.dart on Windows in debug mode...'] });
    await expect(runner.started).rejects.toThrow('Flutter stopped before the app started: Unable to find suitable Visual Studio toolchain.');
  });
});

function target(id: string, extra: Partial<WslNativeTarget> = {}): WslNativeTarget {
  return { id, name: id, productType: 'staticLibrary', productName: `lib${id}.a`, moduleName: id, dependencies: [], sourceFiles: [], publicHeaders: [], resources: [], settings: {}, frameworks: [], scripts: [], ...extra };
}

describe('a Flutter app built on this PC', () => {
  it('leaves out Flutter’s Xcode scripts (CapMac made what they make)', () => {
    const runner = target('Runner', {
      productType: 'application',
      scripts: [
        { name: 'Run Script', script: '/bin/sh "$FLUTTER_ROOT/packages/flutter_tools/bin/xcode_backend.sh" build', shellPath: '/bin/sh' },
        { name: 'Thin Binary', script: '/bin/sh "$FLUTTER_ROOT/packages/flutter_tools/bin/xcode_backend.sh" embed_and_thin', shellPath: '/bin/sh' },
        { name: 'Mine', script: 'echo hi', shellPath: '/bin/sh' },
      ] as WslNativeTarget['scripts'],
    });
    withoutFlutterScripts([runner]);
    expect(runner.scripts.map((phase) => phase.name)).toEqual(['Mine']);
  });

  it('links and embeds Flutter.framework, embeds App.framework, and lets every target find Flutter', () => {
    const graph: WslNativeGraph = {
      version: 1, projectRoot: '/w/src', rootTargetId: 'Runner', configuration: 'Release', sdk: 'iphoneos',
      targets: [
        target('Runner', { productType: 'application', settings: { FRAMEWORK_SEARCH_PATHS: '$(inherited) "$(PROJECT_DIR)/Flutter"' }, frameworks: [{ path: '/old/Flutter.framework' }, { name: 'UIKit' }] }),
        target('shared_preferences_foundation', { settings: { FRAMEWORK_SEARCH_PATHS: ['$(inherited)'] } }),
        target('FlutterGeneratedPluginSwiftPackage'),
      ],
    };
    addFlutterFrameworks(graph, '/w/flutter-ios');
    const runner = graph.targets[0]!;
    expect(runner.frameworks).toEqual([{ name: 'UIKit' }, { path: '/w/flutter-ios/Flutter.framework', embed: true }, { path: '/w/flutter-ios/App.framework', embed: true, link: false }]);
    expect(runner.settings.FRAMEWORK_SEARCH_PATHS).toEqual(['$(inherited) "$(PROJECT_DIR)/Flutter"', '/w/flutter-ios']);
    expect(graph.targets[1]!.settings.FRAMEWORK_SEARCH_PATHS).toEqual(['$(inherited)', '/w/flutter-ios']);
    expect(graph.targets[2]!.settings.FRAMEWORK_SEARCH_PATHS).toEqual(['$(inherited)', '/w/flutter-ios']);
  });
});
