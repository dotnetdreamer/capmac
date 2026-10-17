import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absorbChanges, hookEntitlements, keepPodEdits, podEnv } from '../../packages/core/src/agent/ops/react-native.js';
import { emptyState } from '../../packages/core/src/agent/state.js';
import { appsOf, findApps } from '../../packages/core/src/engine/apps.js';
import { backendIn } from '../../packages/core/src/engine/backend.js';
import { remember } from '../../packages/core/src/engine/memory.js';
import { appFor, findProjectDir, loadProject, runsOnMac, runsOnPc } from '../../packages/core/src/engine/project.js';
import { ReactNativeLogClassifier, rctLogEntry } from '../../packages/core/src/engine/react-native/logs.js';
import { configurationOf, isDebugConfiguration, reactNativeMacApp } from '../../packages/core/src/engine/react-native/mac.js';
import { consoleLevel, METRO_BANNER, METRO_NOISE, METRO_REPORTER_SOURCE, metroErrorMessage, parseMetroLine } from '../../packages/core/src/engine/react-native/metro.js';
import { runWindowsPhase } from '../../packages/core/src/engine/react-native/pc.js';
import { appTargets, describeReactNativeProject, isReactNativeProjectDir } from '../../packages/core/src/engine/react-native/project.js';
import { scanProject } from '../../packages/core/src/engine/scan.js';
import { scanOptionsFor } from '../../packages/core/src/engine/sync-client.js';
import type { WslNativeGraph } from '../../packages/core/src/engine/wsl/native-compiler.js';
import { adaptReactNativeGraph, listWorkspaceFiles, reactNativeWorkDir, restorePodsState, savePodsState, wslNodePath } from '../../packages/core/src/engine/wsl/react-native.js';
import { classifyReactNativeChange, metroLaunchArgs, needsNativeRebuild, needsPodInstall, POD_INSTALL_NOTICE } from '../../packages/core/src/shared/react-native.js';

let dir: string;
let configDir: string;
const savedConfigDir = process.env.CAPMAC_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-rn-'));
  mkdirSync(path.join(dir, '.git'));
  configDir = mkdtempSync(path.join(os.tmpdir(), 'capmac-rn-config-'));
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

/** The Xcode project React Native's template makes (the parts CapMac reads): an app target, then a test target. */
const IOS_PBXPROJ = `// !$*UTF8*$!
{
	objects = {
		13B07F861A680F5B00A75B9A /* HelloReactNative */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 13B07F931A680F5B00A75B9A;
			buildPhases = (
			);
			dependencies = (
			);
			name = HelloReactNative;
			productName = HelloReactNative;
			productReference = 13B07F961A680F5B00A75B9A /* HelloReactNative.app */;
			productType = "com.apple.product-type.application";
		};
		00E356ED1AD99517003FC87E /* HelloReactNativeTests */ = {
			isa = PBXNativeTarget;
			name = HelloReactNativeTests;
			productType = "com.apple.product-type.bundle.unit-test";
		};
		13B07F941A680F5B00A75B9A /* Debug */ = {
			buildSettings = {
				INFOPLIST_FILE = HelloReactNative/Info.plist;
				PRODUCT_BUNDLE_IDENTIFIER = "dev.capmac.hello.reactnative";
				PRODUCT_NAME = HelloReactNative;
			};
		};
		00E356F61AD99517003FC87E /* Debug */ = {
			buildSettings = {
				INFOPLIST_FILE = HelloReactNativeTests/Info.plist;
				PRODUCT_BUNDLE_IDENTIFIER = "org.reactjs.native.example.$(PRODUCT_NAME:rfc1034identifier)";
			};
		};
	};
}
`;

const MAC_PBXPROJ = `// !$*UTF8*$!
{
	objects = {
		514201482437B4B30078DB4F /* HelloReactNative-macOS */ = {
			isa = PBXNativeTarget;
			name = "HelloReactNative-macOS";
			productType = "com.apple.product-type.application";
		};
		5142014D2437B4B30078DB4F /* Debug */ = {
			buildSettings = {
				INFOPLIST_FILE = "HelloReactNative-macOS/Info.plist";
				PRODUCT_BUNDLE_IDENTIFIER = dev.capmac.hello.reactnative;
				PRODUCT_NAME = HelloReactNative;
			};
		};
	};
}
`;

const plist = (entries: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
${Object.entries(entries).map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>`).join('\n')}
</dict>
</plist>
`;

/** The sample's shape: an iOS app, a Mac app (react-native-macos) and a Windows app (react-native-windows). */
function writeSample(): void {
  write('package.json', JSON.stringify({ name: 'hello-react-native', dependencies: { react: '19.2.0', 'react-native': '0.83.10', 'react-native-macos': '0.83.0', 'react-native-windows': '0.83.0' }, 'react-native-windows': { 'init-windows': { name: 'HelloReactNative' } } }));
  write('package-lock.json', '{}');
  write('app.json', JSON.stringify({ name: 'HelloReactNative', displayName: 'Hello React Native' }));
  write('index.js', "import { AppRegistry } from 'react-native';");
  write('App.tsx', 'export default function App() { return null; }');
  write('ios/Podfile', "platform :ios, '15.1'");
  write('ios/HelloReactNative.xcodeproj/project.pbxproj', IOS_PBXPROJ);
  write('ios/HelloReactNative.xcodeproj/xcshareddata/xcschemes/HelloReactNative.xcscheme', '<Scheme/>');
  write('ios/HelloReactNative/Info.plist', plist({ CFBundleDisplayName: 'Hello React Native', CFBundleName: '$(PRODUCT_NAME)' }));
  write('ios/HelloReactNative/Images.xcassets/Contents.json', '{}');
  write('macos/Podfile', "platform :macos, '14.0'");
  write('macos/HelloReactNative.xcodeproj/project.pbxproj', MAC_PBXPROJ);
  write('macos/HelloReactNative.xcodeproj/xcshareddata/xcschemes/HelloReactNative-macOS.xcscheme', '<Scheme/>');
  write('macos/HelloReactNative-macOS/Info.plist', plist({ CFBundleDisplayName: 'Hello React Native', CFBundleName: '$(PRODUCT_NAME)' }));
  write('windows/HelloReactNative.sln', '');
  write('windows/HelloReactNative/HelloReactNative.cpp', '');
}

describe('React Native projects', () => {
  it('reads the sample: its three apps, their names, ids and schemes', () => {
    writeSample();
    const rn = describeReactNativeProject(dir)!;
    expect(rn).not.toBeNull();
    expect(rn.name).toBe('HelloReactNative');
    expect(rn.displayName).toBe('Hello React Native');
    expect(rn.expo).toBe(false);
    expect(rn.platforms).toEqual({ ios: true, macos: true, windows: true });
    expect(rn.ios).toMatchObject({ dir: 'ios', xcodeproj: 'HelloReactNative.xcodeproj', workspace: 'HelloReactNative.xcworkspace', scheme: 'HelloReactNative', bundleId: 'dev.capmac.hello.reactnative', pods: true });
    expect(rn.macos).toMatchObject({ dir: 'macos', scheme: 'HelloReactNative-macOS', bundleId: 'dev.capmac.hello.reactnative' });
    expect(rn.windows).toEqual({ solution: 'HelloReactNative.sln', name: 'HelloReactNative' });
    expect(rn.versions).toEqual({ reactNative: '0.83.10', macos: '0.83.0', windows: '0.83.0', expo: null });
  });

  it('names an app target by its own name, not the test target before it', () => {
    const reordered = IOS_PBXPROJ.replace('13B07F861A680F5B00A75B9A /* HelloReactNative */ = {', 'AAAA /* first */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tname = Tests;\n\t\t\tproductType = "com.apple.product-type.bundle.unit-test";\n\t\t};\n\t\t13B07F861A680F5B00A75B9A /* HelloReactNative */ = {');
    expect(appTargets(reordered)).toEqual(['HelloReactNative']);
  });

  it('is an app only with a platform folder, app.json or Expo (not a library that tests against React Native)', () => {
    write('package.json', JSON.stringify({ name: 'react-native-thing', devDependencies: { 'react-native': '0.83.10' } }));
    expect(isReactNativeProjectDir(dir)).toBe(false);
    write('app.json', '{}');
    expect(isReactNativeProjectDir(dir)).toBe(true);
  });

  it('takes an Expo app without an ios folder as one expo prebuild makes', () => {
    write('package.json', JSON.stringify({ name: 'expo-app', dependencies: { expo: '~58.0.0', 'react-native': '0.88.0' } }));
    write('app.json', JSON.stringify({ expo: { name: 'Expo App', ios: { bundleIdentifier: 'com.example.expo' } } }));
    const rn = describeReactNativeProject(dir)!;
    expect(rn.expo).toBe(true);
    expect(rn.prebuild).toBe(true);
    expect(rn.platforms.ios).toBe(true);
    expect(rn.ios).toMatchObject({ xcodeproj: null, bundleId: 'com.example.expo' });
  });

  it('loads as a React Native project, before Electron', async () => {
    writeSample();
    expect(findProjectDir(path.join(dir, 'ios', 'HelloReactNative'))).toEqual({ dir, kind: 'react-native' });
    const project = await loadProject(dir);
    expect(project.kind).toBe('react-native');
    expect(project.appName).toBe('Hello React Native');
    expect(project.appId).toBe('dev.capmac.hello.reactnative');
    expect(project.scheme).toBe('HelloReactNative');
    expect(project.webDir).toBe('');
    expect(project.iosPackageManager).toBe('CocoaPods');
  });

  it('picks its apps like a Flutter app’s: ios, macos (mac) and windows (pc)', async () => {
    writeSample();
    const project = await loadProject(dir);
    expect(appFor(project)).toBe('ios');
    expect(appFor(project, { app: 'mac' })).toBe('macos');
    expect(appFor(project, { target: 'mac' })).toBe('macos');
    expect(appFor(project, { target: 'pc' })).toBe('windows');
    expect(appFor(project, { app: 'win' })).toBe('windows');
    expect(runsOnMac(project, { app: 'macos' })).toBe(true);
    expect(runsOnPc(project, { app: 'windows' })).toBe(true);
    expect(() => appFor(project, { electron: true })).toThrow(/React Native app: it has no Electron app/);
    expect(reactNativeMacApp(project, { app: 'macos' })).toBe('macos');
    expect(() => reactNativeMacApp(project, { app: 'windows' })).toThrow(/runs on this PC/);
  });

  it('lists its three apps as ones CapMac runs', async () => {
    writeSample();
    const apps = await appsOf(await loadProject(dir));
    expect(apps.map((a) => [a.id, a.platform, a.framework, a.status])).toEqual([
      ['ios', 'ios', 'react-native', 'ready'],
      ['macos', 'mac', 'react-native', 'ready'],
      ['windows', 'windows', 'react-native', 'ready'],
    ]);
    const search = await findApps(dir);
    expect(search.projects[0]).toMatchObject({ framework: 'react-native', name: 'Hello React Native' });
    expect(search.projects[0]!.apps.every((a) => a.status === 'ready')).toBe(true);
  });

  it('builds the iOS app on this PC only when that is picked for it', async () => {
    writeSample();
    const project = await loadProject(dir);
    expect(await backendIn(dir)).toBe('mac');
    await remember(project.projectId, { backend: 'wsl' });
    expect(await backendIn(dir)).toBe('wsl');
    await remember(project.projectId, { app: 'windows' });
    expect(await backendIn(dir)).toBe('mac');
  });

  it('syncs its iOS and Mac apps to the Mac, less CocoaPods’ and Xcode’s files, and nothing of Windows or Android', async () => {
    writeSample();
    write('ios/Pods/Manifest.lock', 'x');
    write('ios/Podfile.lock', 'x');
    write('ios/.xcode.env.local', 'export NODE_BINARY=/pc');
    write('ios/build/generated/ios/x.h', 'x');
    write('android/app/build.gradle', 'x');
    write('windows/x64/Debug/HelloReactNative.exe', 'x');
    write('node_modules/react-native/package.json', '{}');
    write('.capmac/wsl.json', '{}');
    const project = await loadProject(dir);
    const scan = await scanProject({ ...scanOptionsFor(project, false), cacheFile: undefined });
    const files = scan.files.map((f) => f.rel).sort();
    expect(files).toContain('App.tsx');
    expect(files).toContain('ios/Podfile');
    expect(files).toContain('ios/HelloReactNative.xcodeproj/project.pbxproj');
    expect(files).toContain('macos/HelloReactNative-macOS/Info.plist');
    for (const left of ['ios/Pods/Manifest.lock', 'ios/Podfile.lock', 'ios/.xcode.env.local', 'ios/build/generated/ios/x.h', 'android/app/build.gradle', 'windows/HelloReactNative.sln', 'node_modules/react-native/package.json', '.capmac/wsl.json']) {
      expect(files).not.toContain(left);
    }
  });
});

describe('what a saved file means for a React Native app', () => {
  const kind = (rel: string, projectRel = '') => classifyReactNativeChange(rel, projectRel);

  it('lets Metro bring JavaScript, TypeScript, JSON and images over', () => {
    expect(kind('App.tsx')).toBe('js');
    expect(kind('src/screens/Home.js')).toBe('js');
    expect(kind('app.json')).toBe('js');
    expect(kind('assets/logo.png')).toBe('js');
  });

  it('restarts Metro for its settings and Babel’s', () => {
    expect(kind('metro.config.js')).toBe('metro');
    expect(kind('babel.config.js')).toBe('metro');
  });

  it('reinstalls for the packages, runs CocoaPods for a Podfile or a project file from the PC, rebuilds for native folders', () => {
    expect(kind('package.json')).toBe('deps');
    expect(kind('package-lock.json')).toBe('deps');
    expect(kind('ios/Podfile')).toBe('pods-ios');
    expect(kind('macos/Podfile.lock')).toBe('pods-macos');
    expect(kind('ios/HelloReactNative.xcodeproj/project.pbxproj')).toBe('pods-ios');
    expect(kind('ios/HelloReactNative/AppDelegate.swift')).toBe('ios');
    expect(kind('macos/HelloReactNative-macOS/AppDelegate.swift')).toBe('macos');
    expect(kind('windows/HelloReactNative/HelloReactNative.cpp')).toBe('windows');
    expect(kind('modules/my-module/ios/MyModule.mm')).toBe('native');
  });

  it('ignores what tools write: node_modules, Pods, build output, MSBuild’s folders, CapMac’s own', () => {
    for (const rel of ['node_modules/react-native/index.js', 'ios/Pods/Manifest.lock', 'ios/build/x.o', 'ios/.xcode.env.local', 'windows/x64/Debug/HelloReactNative.exe', 'windows/HelloReactNative/Generated Files/x.h', 'windows/packages/x.nupkg', '.capmac/wsl.json', 'android/app/src/main/java/A.java', '__tests__/App.test.tsx', 'README.md', '.metro-health-check12345']) {
      expect(kind(rel), rel).toBe('ignore');
    }
  });

  it('reads paths inside a monorepo from the app’s folder', () => {
    expect(kind('apps/mobile/ios/Podfile', 'apps/mobile')).toBe('pods-ios');
    expect(kind('apps/mobile/App.tsx', 'apps/mobile')).toBe('js');
    expect(kind('packages/ui/Button.tsx', 'apps/mobile')).toBe('js');
  });

  it('rebuilds only the app a change is for', () => {
    expect(needsNativeRebuild('js', 'ios')).toBe(false);
    expect(needsNativeRebuild('ios', 'ios')).toBe(true);
    expect(needsNativeRebuild('ios', 'macos')).toBe(false);
    expect(needsNativeRebuild('windows', 'windows')).toBe(true);
    expect(needsNativeRebuild('deps', 'windows')).toBe(true);
    expect(needsNativeRebuild('native', 'macos')).toBe(true);
    expect(needsPodInstall(['pods-macos'], 'ios')).toBe(false);
    expect(needsPodInstall(['pods-ios'], 'ios')).toBe(true);
    expect(needsPodInstall(['deps'], 'macos')).toBe(true);
  });
});

describe('the Mac side', () => {
  it('turns synced changes into what each Apple app has to do', () => {
    const state = emptyState();
    state.pendingFull = false;
    state.pendingChanges = ['App.tsx'];
    absorbChanges(state, '');
    expect(state.rn).toMatchObject({ nativeGen: { ios: 1, macos: 1 }, jsGen: 2 });
    state.pendingChanges = ['ios/Podfile', 'macos/HelloReactNative-macOS/AppDelegate.swift'];
    absorbChanges(state, '');
    expect(state.rn).toMatchObject({ nativeGen: { ios: 2, macos: 2 }, podsStale: { ios: true } });
    expect(state.pendingChanges).toEqual([]);
  });

  it('keeps CocoaPods’ edits from being put back by the next sync', async () => {
    const state = emptyState();
    state.manifest['ios/HelloReactNative.xcodeproj/project.pbxproj'] = { h: 'pc', m: 0, s: 10 };
    state.manifest['App.tsx'] = { h: 'pc', m: 0, s: 3 };
    write('ios/HelloReactNative.xcodeproj/project.pbxproj', 'x'.repeat(42));
    write('App.tsx', 'abcdef');
    await keepPodEdits(state, dir, 'ios');
    expect(state.manifest['ios/HelloReactNative.xcodeproj/project.pbxproj']!.s).toBe(42);
    expect(state.manifest['App.tsx']!.s).toBe(3);
  });

  it('runs CocoaPods with a UTF-8 locale', () => {
    expect(podEnv({ PATH: '/x' }, { RCT_NEW_ARCH_ENABLED: '1' })).toMatchObject({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', RCT_NEW_ARCH_ENABLED: '1', PATH: '/x' });
  });

  it('leaves entitlements alone unless the app is sandboxed without the network server permission', async () => {
    expect(await hookEntitlements(null, dir, {})).toBeNull();
    expect(await hookEntitlements(path.join(dir, 'missing.entitlements'), dir, {})).toBeNull();
  });

  it('points a debug build at Metro with launch arguments', () => {
    expect(metroLaunchArgs('localhost:8081')).toEqual(['-RCT_jsLocation', 'localhost:8081']);
    expect(isDebugConfiguration('Debug')).toBe(true);
    expect(isDebugConfiguration('Release')).toBe(false);
  });

  it('builds Debug unless asked for Release (or another configuration)', async () => {
    writeSample();
    const project = await loadProject(dir);
    expect(configurationOf(project, {})).toBe('Debug');
    expect(configurationOf(project, { release: true })).toBe('Release');
    expect(configurationOf(project, { configuration: 'Staging' })).toBe('Staging');
  });
});

describe('Metro', () => {
  it('ships a reporter that hands its events over as data', () => {
    expect(METRO_REPORTER_SOURCE).toContain('module.exports = CapMacMetroReporter');
    expect(METRO_REPORTER_SOURCE).toContain("case 'client_log'");
  });

  it('reads the reporter’s events and leaves Metro’s own text alone', () => {
    expect(parseMetroLine('\u001ecapmac-metro {"e":"ready","port":8081}')).toEqual({ e: 'ready', port: 8081 });
    expect(parseMetroLine(' BUNDLE  ./index.js ░░░ 0% (0/1)\u001ecapmac-metro {"e":"bundle-done","id":"1"}')).toEqual({ e: 'bundle-done', id: '1' });
    expect(parseMetroLine(' LOG  Hello')).toBeNull();
    expect(parseMetroLine('\u001ecapmac-metro {broken')).toBeNull();
  });

  it('keeps its banner, progress bars and tips out of the console', () => {
    for (const line of ['                        ▒▒▓▓▓▓▒▒', '                Welcome to Metro v0.83.8', 'Starting dev server on http://127.0.0.1:8081', ' BUNDLE  ./index.js', ' INFO  💡 JavaScript logs have moved! They can now be viewed in React Native DevTools.', 'transform[stderr]: (node:49232) Warning: x']) {
      expect(METRO_NOISE.test(line), line).toBe(true);
    }
    expect(METRO_NOISE.test(' WARN  Failed to download the latest version of React Native DevTools.')).toBe(false);
    expect(METRO_NOISE.test('error: Error: Unable to resolve module ./Missing from App.tsx')).toBe(false);
  });

  it('leaves its logo, welcome lines, progress bars and log tip out even of the full output', () => {
    for (const line of ['                        ▒▒▓▓▓▓▒▒', '                Welcome to Metro v0.83.8', 'Welcome to React Native v0.83', '      Fast - Scalable - Integrated', ' BUNDLE  ./index.js ▓▓░░░░░░░░░░░░░░ 16% (75/191)', ' INFO  💡 JavaScript logs have moved! They can now be viewed in React Native DevTools.']) {
      expect(METRO_BANNER.test(line), line).toBe(true);
    }
    expect(METRO_BANNER.test('Starting dev server on http://127.0.0.1:8081')).toBe(false);
    expect(METRO_BANNER.test(' WARN  Failed to download the latest version of React Native DevTools.')).toBe(false);
  });

  it('leaves React Native’s notice against running pod install directly out of the Mac’s output', () => {
    for (const line of ['==================== DEPRECATION NOTICE =====================', 'Calling `pod install` directly is deprecated in React Native', 'because we are moving away from Cocoapods toward alternative', 'solutions to build the project.', '* If you are using Expo, please run:', '`npx expo run:ios`', '* If you are using the Community CLI, please run:', '`yarn ios`', '=============================================================']) {
      expect(POD_INSTALL_NOTICE.test(line), line).toBe(true);
    }
    expect(POD_INSTALL_NOTICE.test('Pod installation complete! There are 81 dependencies from the Podfile and 80 total pods installed.')).toBe(false);
    expect(POD_INSTALL_NOTICE.test('[Codegen] Generating Package.swift')).toBe(false);
  });

  it('reads console levels and syntax errors the way people do', () => {
    expect(consoleLevel('warn')).toBe('warn');
    expect(consoleLevel('trace')).toBe('debug');
    expect(consoleLevel('group')).toBe('log');
    expect(metroErrorMessage({ message: 'SyntaxError: C:\\app\\App.tsx: Unexpected token (12:5)\n> 12 | x', file: 'C:\\app\\App.tsx' })).toBe('SyntaxError: Unexpected token');
    // Metro often reports the file relative to the project, while its message has the whole path (here with spaces).
    expect(metroErrorMessage({ message: 'SyntaxError: C:\\Users\\me\\capmac Studio\\Hello React Native\\App.tsx: Unexpected token (159:34)', file: 'App.tsx' })).toBe('SyntaxError: Unexpected token');
  });
});

describe('the app’s own lines', () => {
  it('leaves out React Native’s copies of console lines while Metro hands them over', () => {
    const line = '2026-10-16 23:06:22.697 [info][tid:com.facebook.react.JavaScript] Hello CapMac!';
    expect(rctLogEntry(line, 'stdout', true)).toBeNull();
    expect(rctLogEntry(line, 'stdout', false)).toMatchObject({ kind: 'console', level: 'log', text: 'Hello CapMac!' });
    expect(rctLogEntry('2026-10-16 23:06:22.697 [warn][tid:main] Something native', 'stderr', true)).toMatchObject({ kind: 'native', level: 'warn', text: 'Something native' });
    expect(rctLogEntry('plain line', 'stdout', true)).toBeUndefined();
  });

  it('keeps glog’s and UIKit’s routine notes dim', () => {
    const classifier = new ReactNativeLogClassifier(true);
    expect(classifier.classify('WARNING: Logging before InitGoogleLogging() is written to STDERR')).toBeNull();
    expect(classifier.classify('W1016 23:06:22.697645 1842884608 ReactInstance.cpp:256] ReactInstance: evaluateJavaScript() with JS bundle')).toMatchObject({ level: 'debug', text: 'ReactInstance: evaluateJavaScript() with JS bundle' });
    expect(classifier.classify('E1016 23:06:22.697645 1842884608 Foo.cpp:1] broken')).toMatchObject({ level: 'error' });
    expect(classifier.classify('2026-10-16 23:15:45.801 HelloReactNative[71287:38927512] Unbalanced calls to begin/end appearance transitions for <UIViewController: 0x1>.')).toMatchObject({ level: 'debug' });
    // A reload takes the old instance apart.
    expect(classifier.classify('Scheduler::~Scheduler() was called (address: 0x1029cdc00).')).toMatchObject({ level: 'debug' });
    expect(classifier.classify('UIManagerBinding::~UIManagerBinding() was called (address: 0x102875978).')).toMatchObject({ level: 'debug' });
  });
});

describe('the Windows app', () => {
  it('turns run-windows’ output into timeline steps', () => {
    expect(runWindowsPhase('Autolinking...')?.phase).toBe('deps');
    expect(runWindowsPhase('Building Solution: C:\\app\\windows\\HelloReactNative.sln')?.phase).toBe('build');
    expect(runWindowsPhase('Deploying C:\\app\\windows\\...')?.phase).toBe('install');
    expect(runWindowsPhase('Starting the app')?.phase).toBe('launch');
    expect(runWindowsPhase('Restore complete')?.phase).toBe('deps');
    expect(runWindowsPhase('just a line')).toBeNull();
  });
});

describe('building on this PC (WSL)', () => {
  const graph = (): WslNativeGraph => ({
    version: 1,
    projectRoot: '/w',
    rootTargetId: 'app',
    configuration: 'Debug',
    sdk: 'iphoneos',
    targets: [
      { id: 'pod', name: 'RNCAsyncStorage', productType: 'staticLibrary', productName: 'libRNCAsyncStorage.a', moduleName: 'RNCAsyncStorage', dependencies: [], sourceFiles: [], publicHeaders: [], resources: [], settings: {}, frameworks: [], scripts: [] },
      { id: 'app', name: 'HelloReactNative', productType: 'application', productName: 'HelloReactNative.app', moduleName: 'HelloReactNative', dependencies: ['pod'], sourceFiles: [], publicHeaders: [], resources: [], settings: {}, frameworks: [], scripts: [] },
    ],
  });
  const node = { bin: '/root/.local/share/capmac/node/24.11.1/bin', path: '/root/.local/share/capmac/node/24.11.1/bin:/root/.local/share/capmac/macos-shims' };

  it('runs every script with the distro’s Node.js and keeps the app’s bundling phase out of a debug build', () => {
    const adapted = adaptReactNativeGraph(graph(), node, null);
    for (const target of adapted.targets) {
      expect(target.settings.NODE_BINARY).toBe(`${node.bin}/node`);
      expect(String(target.settings.PATH)).toMatch(/^\/root\/\.local\/share\/capmac\/node\/24\.11\.1\/bin:\/root\/\.local\/share\/capmac\/macos-shims:/);
    }
    const app = adapted.targets.find((t) => t.id === 'app')!;
    expect(app.settings).toMatchObject({ SKIP_BUNDLING: '1', SKIP_BUNDLING_METRO_IP: '1' });
    expect(app.resources).toEqual([]);
  });

  it('gives a release build the bundle made on this PC', () => {
    write('bundle/main.jsbundle', 'x');
    write('bundle/assets/node_modules/x.png', 'x');
    const app = adaptReactNativeGraph(graph(), node, path.join(dir, 'bundle')).targets.find((t) => t.id === 'app')!;
    expect(app.resources).toEqual([
      { source: path.join(dir, 'bundle', 'main.jsbundle'), destination: 'main.jsbundle' },
      { source: path.join(dir, 'bundle', 'assets'), destination: 'assets' },
    ]);
  });

  it('keeps its build files outside the project (Metro watches the project’s folder)', () => {
    const work = reactNativeWorkDir({ projectId: 'helloreactnative-1234abcd' });
    expect(work.endsWith(path.join('wsl-builds', 'helloreactnative-1234abcd'))).toBe(true);
    expect(wslNodePath(node)).toMatch(/:\/usr\/bin:\/sbin:\/bin$/);
  });

  it('defines RCT_METRO_PORT as Xcode reads it when it is unset (empty: React Native picks 8081)', () => {
    const custom = graph();
    custom.targets[1]!.settings = { RCT_METRO_PORT: '9090' };
    const [pod, app] = adaptReactNativeGraph(custom, node, null).targets;
    expect(pod!.settings.RCT_METRO_PORT).toBe('');
    expect(app!.settings.RCT_METRO_PORT).toBe('9090');
  });

  it('builds every C++ file without folly’s coroutines, as React Native’s prebuilt folly is', () => {
    const custom = graph();
    custom.targets[0]!.settings = { OTHER_CPLUSPLUSFLAGS: ' -DRCT_NEW_ARCH_ENABLED=1' };
    const [pod, app] = adaptReactNativeGraph(custom, node, null).targets;
    expect(pod!.settings.OTHER_CPLUSPLUSFLAGS).toEqual([' -DRCT_NEW_ARCH_ENABLED=1', '-DFOLLY_CFG_NO_COROUTINES=1']);
    expect(app!.settings.OTHER_CPLUSPLUSFLAGS).toEqual(['$(inherited)', '-DFOLLY_CFG_NO_COROUTINES=1']);
  });

  it('puts back what the last pod install wrote while nothing it reads changed', async () => {
    const ios = path.join(dir, 'ios');
    write('ios/Podfile', 'pod');
    write('ios/App.xcodeproj/project.pbxproj', 'from the PC');
    write('ios/old.txt', 'x');
    write('ios/Pods/Manifest.lock', 'lock');
    const before = await listWorkspaceFiles(ios);
    expect([...before.keys()].sort()).toEqual(['App.xcodeproj/project.pbxproj', 'Podfile', 'old.txt']);
    // What pod install does next to the Podfile.
    write('ios/App.xcodeproj/project.pbxproj', 'with the Pods built in');
    write('ios/Podfile.lock', 'lock');
    write('ios/build/generated/ios/Spec.h', '// codegen');
    rmSync(path.join(ios, 'old.txt'));
    const state = path.join(dir, 'pods-state');
    await savePodsState(state, ios, 'inputs-1', before);
    // The next copy from the PC puts its files back.
    write('ios/App.xcodeproj/project.pbxproj', 'from the PC');
    rmSync(path.join(ios, 'Podfile.lock'));
    rmSync(path.join(ios, 'build'), { recursive: true });
    write('ios/old.txt', 'x');
    expect(await restorePodsState(state, ios, 'inputs-2')).toBe(false);
    expect(readFileSync(path.join(ios, 'App.xcodeproj', 'project.pbxproj'), 'utf8')).toBe('from the PC');
    expect(await restorePodsState(state, ios, 'inputs-1')).toBe(true);
    expect(readFileSync(path.join(ios, 'App.xcodeproj', 'project.pbxproj'), 'utf8')).toBe('with the Pods built in');
    expect(readFileSync(path.join(ios, 'Podfile.lock'), 'utf8')).toBe('lock');
    expect(readFileSync(path.join(ios, 'build', 'generated', 'ios', 'Spec.h'), 'utf8')).toBe('// codegen');
    expect(existsSync(path.join(ios, 'old.txt'))).toBe(false);
  });
});
