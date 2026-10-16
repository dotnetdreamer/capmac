import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sign: vi.fn(), packageUnsigned: vi.fn(), resources: vi.fn(), scripts: vi.fn(), generated: vi.fn(async () => [] as string[]) }));
vi.mock('../../packages/core/src/engine/wsl/compiler.js', () => ({ signWslApplication: mocks.sign, packageUnsignedWslApplication: mocks.packageUnsigned }));
vi.mock('../../packages/core/src/engine/wsl/resources.js', () => ({ compileWslResources: mocks.resources, generateWslResourceSources: mocks.generated, runWslScriptPhases: mocks.scripts }));
import { buildNativeWithToolchain, expandNativeSetting, nativeLinkedProducts, nativeLinkerArguments, orderNativeTargets, splitXcodeArguments, type WslNativeBuildPlan, type WslNativeGraph, type WslNativeTarget } from '../../packages/core/src/engine/wsl/native-compiler.js';
import type { WslCommandResult, WslExecutor, WslRunOptions } from '../../packages/core/src/engine/wsl/toolchain.js';

const temporary: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const tools = { sdkPath: '/opt/iPhoneOS.sdk', swiftcPath: '/opt/swift/bin/swiftc', clangPath: '/opt/swift/bin/clang', archivePath: '/opt/swift/bin/llvm-ar', linkerPath: '/usr/bin/ld64.lld', signerPath: 'zsign' };
const python = ['python3', 'python'].find((name) => spawnSync(name, ['-c', 'import plistlib'], { timeout: 3000, windowsHide: true }).status === 0);
function target(id: string, productType: WslNativeTarget['productType'], additions: Partial<WslNativeTarget> = {}): WslNativeTarget {
  const suffix = { application: '.app', appExtension: '.appex', framework: '.framework', bundle: '.bundle', staticLibrary: '.a', aggregate: '' }[productType];
  return { id, name: id, moduleName: id, productName: `${id}${suffix}`, productType, dependencies: [], sourceFiles: [], publicHeaders: [], resources: [], settings: { IPHONEOS_DEPLOYMENT_TARGET: '15.0' }, frameworks: [], scripts: [], ...additions };
}
function plan(): WslNativeBuildPlan {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'capmac-native-test-')); temporary.push(directory);
  return {
    graph: { version: 1, configuration: 'Debug', sdk: 'iphoneos', projectRoot: '/project', rootTargetId: 'App', targets: [
      target('App', 'application', { dependencies: ['Pods_App'], frameworks: [{ path: '$(BUILT_PRODUCTS_DIR)/Capacitor/Capacitor.framework', embed: true }, { path: '$(BUILT_PRODUCTS_DIR)/libLegacyPlugin.a' }], sourceFiles: [{ path: '/project/App/CustomAppDelegate.swift' }, { path: '/project/App/SceneDelegate.swift' }], settings: { IPHONEOS_DEPLOYMENT_TARGET: '15.0', PRODUCT_BUNDLE_IDENTIFIER: 'dev.test.custom', INFOPLIST_FILE: '/project/App/Info.plist', SWIFT_OBJC_BRIDGING_HEADER: '/project/App/App-Bridging-Header.h', CODE_SIGN_ENTITLEMENTS: '/project/App/App.entitlements' }, resources: [{ source: '/project/App/public' }, { source: '/project/App/Main.storyboard', destination: 'Base.lproj/Main.storyboard' }] }),
      target('Pods_App', 'aggregate', { dependencies: ['Capacitor', 'LegacyPlugin'] }),
      target('Capacitor', 'framework', { sourceFiles: [{ path: '/project/Pods/Capacitor/CAPBridge.swift' }, { path: '/project/Pods/Capacitor/CAPPlugin.m', flags: ['-fno-objc-arc'] }], publicHeaders: ['/project/Pods/Capacitor/CAPPlugin.h'], settings: { CONFIGURATION_BUILD_DIR: '$(PODS_CONFIGURATION_BUILD_DIR)/Capacitor', SWIFT_VERSION: '5.0' } }),
      target('LegacyPlugin', 'staticLibrary', { productName: 'libLegacyPlugin.a', dependencies: ['Capacitor'], sourceFiles: [{ path: '/project/Pods/LegacyPlugin/Plugin.mm', flags: ['-DPLUGIN_FILE=1'] }, { path: '/project/Pods/LegacyPlugin/util.c' }, { path: '/project/Pods/LegacyPlugin/codec.cpp' }], publicHeaders: ['/project/Pods/LegacyPlugin/Plugin.h'], settings: { CLANG_CXX_LANGUAGE_STANDARD: 'c++20', GCC_PREPROCESSOR_DEFINITIONS: ['COCOAPODS=1', 'CUSTOM=2'], OTHER_CFLAGS: ['-Wno-unused-variable'], OTHER_CPLUSPLUSFLAGS: '$(OTHER_CFLAGS) -DCXX_NESTED=1' } }),
    ] },
    outputDirectory: path.join(directory, 'out'), signing: { certificatePath: '/signing/developer.p12', provisioningProfilePath: '/signing/profile.mobileprovision', password: 'private-password' },
  };
}
function transport() {
  const calls: { argv: string[]; options: WslRunOptions }[] = [];
  const executor = {
    distro: 'Ubuntu',
    path: vi.fn(async (input: string) => input.replace(/\\/g, '/')),
    run: vi.fn(async (argv: readonly string[], options: WslRunOptions = {}): Promise<WslCommandResult> => { calls.push({ argv: [...argv], options }); return { code: 0, stdout: '', stderr: '' }; }),
  };
  return { executor: executor as unknown as WslExecutor, calls };
}

function addWidget(p: WslNativeBuildPlan): WslNativeTarget {
  const widget = target('HomeCard', 'appExtension', { sourceFiles: [{ path: '/project/plugins/home-card/HomeCardWidget.swift' }, { path: '/project/plugins/home-card/CardView.swift' }, { path: '/project/plugins/home-card/WidgetNative.m' }], settings: {
    INFOPLIST_FILE: '/project/HomeCard/Info.plist', PRODUCT_BUNDLE_IDENTIFIER: 'dev.test.custom.HomeCard', CODE_SIGN_ENTITLEMENTS: '/project/HomeCard/HomeCard.entitlements', IPHONEOS_DEPLOYMENT_TARGET: '15.0', CURRENT_PROJECT_VERSION: '204', MARKETING_VERSION: '1.4.64', LD_RUNPATH_SEARCH_PATHS: ['@executable_path/Frameworks', '@executable_path/../../Frameworks'],
  }, resources: [{ source: '/project/HomeCard/Glyphs.xcassets' }, { source: '/project/HomeCard/Localizable.xcstrings' }] });
  p.graph.targets.push(widget); p.graph.targets[0]!.dependencies.push(widget.id);
  return widget;
}

describe('native graph validation and build settings', () => {
  it('orders the application and aggregate target dependency closure, excluding unrelated tests', () => {
    const p = plan(); p.graph.targets.push(target('Unrelated', 'framework'));
    expect(orderNativeTargets(p.graph).map((item) => item.id)).toEqual(['Capacitor', 'LegacyPlugin', 'Pods_App', 'App']);
  });
  it('fails explicitly on graph cycles or missing native dependencies', () => {
    const p = plan(); p.graph.targets.find((item) => item.id === 'Capacitor')!.dependencies = ['App'];
    expect(() => orderNativeTargets(p.graph)).toThrow(/cycle.*App/);
    p.graph.targets.find((item) => item.id === 'Capacitor')!.dependencies = ['Unknown'];
    expect(() => orderNativeTargets(p.graph)).toThrow(/Unknown.*missing/);
  });
  it('expands nested Xcode paths and identifier modifiers, rejecting unresolved settings', () => {
    expect(expandNativeSetting('$(ROOT)/${NAME:c99extidentifier}', { ROOT: '${BASE}/Pods', BASE: '/project', NAME: 'My Plugin' }, 'Plugin')).toBe('/project/Pods/My_Plugin');
    expect(() => expandNativeSetting('$(MISSING)/file', {}, 'LegacyPlugin')).toThrow(/LegacyPlugin.*MISSING/);
    expect(() => expandNativeSetting('$(A)', { A: '$(A)' }, 'Plugin')).toThrow(/recursive/);
  });
  it('preserves quoted list arguments and passes linker flags through the Swift driver', () => {
    expect(splitXcodeArguments('$(inherited) "path with spaces" -DNAME=\'two words\'')).toEqual(['path with spaces', '-DNAME=two words']);
    expect(nativeLinkerArguments(['-ObjC', '-Wl,-rpath,@loader_path/Frameworks', '-Xlinker', '-dead_strip'])).toEqual(['-Xlinker', '-ObjC', '-Xlinker', '-rpath', '-Xlinker', '@loader_path/Frameworks', '-Xlinker', '-dead_strip']);
  });
  it('distinguishes build dependencies from linker references', () => {
    expect([...nativeLinkedProducts(target('Plugin', 'framework', { dependencies: ['UnlinkedHelper'], frameworks: [{ path: '$(BUILT_PRODUCTS_DIR)/Capacitor.framework' }], settings: { OTHER_LDFLAGS: '-framework "WebKit" -l"Cordova" -l z' } }))]).toEqual(['Capacitor.framework', 'WebKit.framework', 'libCordova.a', 'libz.a']);
  });
});

describe.skipIf(!python)('native build helpers with real Python execution', () => {
  it('writes a real extension Info.plist with XPC package type, NSExtension declaration and original version', async () => {
    const p = plan(); addWidget(p); p.unsigned = true; const { executor, calls } = transport();
    await buildNativeWithToolchain(p, executor, tools);
    const invocation = calls.find((call) => call.argv[0] === 'python3' && call.argv[2]?.includes('CFBundleSupportedPlatforms') && call.argv[3] === '/project/HomeCard/Info.plist')!;
    const source = path.join(p.outputDirectory, 'WidgetInfo.plist'); const output = path.join(p.outputDirectory, 'ProcessedWidget.plist');
    writeFileSync(source, plist.build({ CFBundleExecutable: '$(EXECUTABLE_NAME)', CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)', CFBundlePackageType: '$(PRODUCT_BUNDLE_PACKAGE_TYPE)', CFBundleShortVersionString: '$(MARKETING_VERSION)', CFBundleVersion: '$(CURRENT_PROJECT_VERSION)', HomeCardAppGroup: 'group.dev.test.custom', NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' } }));
    const result = spawnSync(python!, ['-c', invocation.argv[2]!, source, output, invocation.argv[5]!], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    const info = plist.parse(readFileSync(output, 'utf8')) as Record<string, plist.PlistValue>;
    expect(info).toMatchObject({ CFBundleExecutable: 'HomeCard', CFBundleIdentifier: 'dev.test.custom.HomeCard', CFBundlePackageType: 'XPC!', CFBundleShortVersionString: '1.4.64', CFBundleVersion: '204', HomeCardAppGroup: 'group.dev.test.custom', NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' } });
    expect(info).not.toHaveProperty('LSRequiresIPhoneOS');
  });
  it('processes build variables while retaining app UI and adding required device metadata', async () => {
    const p = plan(); const { executor, calls } = transport();
    p.graph.targets[0]!.settings.CAPACITOR_DEBUG = 'YES';
    await buildNativeWithToolchain(p, executor, tools);
    const invocation = calls.find((call) => call.argv[0] === 'python3' && call.argv[2]?.includes('CFBundleSupportedPlatforms') && call.argv[3] === '/project/App/Info.plist')!;
    const source = path.join(p.outputDirectory, 'Original.plist'); const output = path.join(p.outputDirectory, 'Processed.plist');
    writeFileSync(source, plist.build({ CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)', CFBundleName: 'Preserved brand', CFBundleDisplayName: 'Preserved display', UIMainStoryboardFile: 'Main', UILaunchStoryboardName: 'LaunchScreen', NSCameraUsageDescription: 'Preserved camera purpose', CFBundleVersion: '42' }));
    const result = spawnSync(python!, ['-c', invocation.argv[2]!, source, output, invocation.argv[5]!], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(plist.parse(readFileSync(output, 'utf8'))).toMatchObject({ CFBundleIdentifier: 'dev.test.custom', CFBundleName: 'Preserved brand', CFBundleDisplayName: 'Preserved display', UIMainStoryboardFile: 'Main', UILaunchStoryboardName: 'LaunchScreen', NSCameraUsageDescription: 'Preserved camera purpose', CFBundleVersion: '42', UIDeviceFamily: [1, 2], CFBundleSupportedPlatforms: ['iPhoneOS'], CFBundleInfoDictionaryVersion: '6.0', CAPACITOR_DEBUG: 'true' });
  });
  it.each([['Debug', undefined, 'true'], ['Release', undefined, 'false'], ['Staging', 'DEBUG', 'true']])('resolves the standard unset CAPACITOR_DEBUG variable for %s', async (configuration, condition, expected) => {
    const p = plan(); p.graph.configuration = configuration!;
    if (condition) p.graph.targets[0]!.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS = condition;
    const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    const invocation = calls.find((call) => call.argv[0] === 'python3' && call.argv[2]?.includes('CFBundleSupportedPlatforms') && call.argv[3] === '/project/App/Info.plist')!;
    const source = path.join(p.outputDirectory, 'Standard.plist'); const output = path.join(p.outputDirectory, 'Processed.plist');
    writeFileSync(source, plist.build({ CAPACITOR_DEBUG: '$(CAPACITOR_DEBUG)' }));
    const result = spawnSync(python!, ['-c', invocation.argv[2]!, source, output, invocation.argv[5]!], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(plist.parse(readFileSync(output, 'utf8'))).toMatchObject({ CAPACITOR_DEBUG: expected });
  });
  it('merges a framework already embedded by CocoaPods without nesting another framework inside it', async () => {
    const p = plan(); const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    const invocation = calls.find((call) => call.argv[0] === 'python3' && call.argv[2]?.includes('copytree(source,destination'))!;
    const source = path.join(p.outputDirectory, 'Foo.framework'); const app = path.join(p.outputDirectory, 'App.app'); const destination = path.join(app, 'Frameworks', 'Foo.framework');
    mkdirSync(source, { recursive: true }); mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(source, 'Foo'), 'new framework binary'); writeFileSync(path.join(destination, 'Resource.dat'), 'resource already copied by CocoaPods');
    const result = spawnSync(python!, ['-c', invocation.argv[2]!, source, destination, app], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(destination, 'Foo'), 'utf8')).toBe('new framework binary');
    expect(readFileSync(path.join(destination, 'Resource.dat'), 'utf8')).toBe('resource already copied by CocoaPods');
    expect(existsSync(path.join(destination, 'Foo.framework'))).toBe(false);
  });
  it('keeps a private header that shares a public header’s name in a folder only its own target searches', async () => {
    // Firebase's Sources/FirebaseMessaging.h beside Sources/Public/FirebaseMessaging/FirebaseMessaging.h.
    const p = plan(); const legacy = p.graph.targets.find((item) => item.id === 'LegacyPlugin')!;
    legacy.publicHeaders = ['/project/Pods/LegacyPlugin/Public/LegacyPlugin/LegacyPlugin.h'];
    legacy.privateHeaders = ['/project/Pods/LegacyPlugin/LegacyPlugin.h', '/project/Pods/LegacyPlugin/Internal/LegacyPlugin.h', '/project/Pods/LegacyPlugin/Helper.h'];
    const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    const copies = calls.filter((call) => call.argv[0] === 'cp').map((call) => call.argv.slice(-2));
    expect(copies).toContainEqual(['/project/Pods/LegacyPlugin/Public/LegacyPlugin/LegacyPlugin.h', expect.stringMatching(/\/modules\/LegacyPlugin\/LegacyPlugin\.h$/)]);
    expect(copies).toContainEqual(['/project/Pods/LegacyPlugin/LegacyPlugin.h', expect.stringMatching(/\/private-headers\/LegacyPlugin\/LegacyPlugin\.h$/)]);
    expect(copies).toContainEqual(['/project/Pods/LegacyPlugin/Helper.h', expect.stringMatching(/\/modules\/LegacyPlugin\/Helper\.h$/)]);
    expect(copies.filter(([source]) => source!.includes('/Internal/'))).toEqual([]);
    const compile = (file: string) => calls.find((call) => call.argv.includes(file))!.argv;
    expect(compile('/project/Pods/LegacyPlugin/util.c').some((arg) => arg.endsWith('/private-headers/LegacyPlugin'))).toBe(true);
    expect(compile('/project/Pods/Capacitor/CAPPlugin.m').some((arg) => arg.includes('/private-headers/'))).toBe(false);
  });
  it('uses a package’s own include/module.modulemap in place instead of defining the module twice', async () => {
    // google/promises: Sources/FBLPromises/include/module.modulemap beside its public headers.
    const p = plan(); const legacy = p.graph.targets.find((item) => item.id === 'LegacyPlugin')!;
    legacy.publicHeaders = ['/pkg/FBLPromises/include/FBLPromise.h'];
    legacy.settings = { ...legacy.settings, MODULEMAP_FILE: '/pkg/FBLPromises/include/module.modulemap', HEADER_SEARCH_PATHS: ['/pkg/FBLPromises', '/pkg/FBLPromises/include'] };
    const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    expect(calls.some((call) => call.argv[0] === 'cp' && call.argv.includes('/pkg/FBLPromises/include/FBLPromise.h'))).toBe(false);
    expect(calls.some((call) => call.argv[2]?.includes('Unsafe custom module-map header') && call.argv[3] === '/pkg/FBLPromises/include/module.modulemap')).toBe(false);
    const library = calls.find((call) => call.argv.includes('/project/Pods/LegacyPlugin/util.c'))!.argv;
    expect(library).toContain('-fmodule-map-file=/pkg/FBLPromises/include/module.modulemap');
    expect(library.filter((arg) => arg.includes('modules/LegacyPlugin/module.modulemap'))).toEqual([]);
  });
  it('gives a Swift package C target SwiftPM’s module map over its headers where they are', async () => {
    // GTMSessionFetcherCore: publicHeadersPath "Public" holding GTMSessionFetcher/*.h, no module map of its own.
    const p = plan(); const legacy = p.graph.targets.find((item) => item.id === 'LegacyPlugin')!;
    legacy.publicHeaders = ['/pkg/Sources/Core/Public/GTMSessionFetcher/GTMSessionFetcher.h', '/pkg/Sources/Core/Public/GTMSessionFetcher/GTMSessionFetcherLogging.h'];
    legacy.privateHeaders = ['/pkg/Sources/Core/GTMSessionFetcherService+Internal.h'];
    legacy.settings = { ...legacy.settings, CAPMAC_PACKAGE_INCLUDE: '/pkg/Sources/Core/Public', HEADER_SEARCH_PATHS: ['/pkg/Sources/Core', '/pkg/Sources/Core/Public'] };
    const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    expect(calls.some((call) => call.argv[0] === 'cp' && call.argv.some((arg) => arg.startsWith('/pkg/')))).toBe(false);
    const map = calls.find((call) => call.argv.at(-1)?.endsWith('/modules/LegacyPlugin/module.modulemap') && typeof call.options.stdin === 'string')!;
    expect(map.options.stdin).toBe('module LegacyPlugin {\n umbrella "/pkg/Sources/Core/Public"\n export *\n}\n');
    const library = calls.find((call) => call.argv.includes('/project/Pods/LegacyPlugin/util.c'))!.argv;
    expect(library).toEqual(expect.arrayContaining([expect.stringMatching(/^-fmodule-map-file=.*\/modules\/LegacyPlugin\/module\.modulemap$/), '/pkg/Sources/Core/Public']));
    // Its own sources read its headers as text, so headers outside the umbrella stay visible.
    expect(library).toContain('-fmodule-name=LegacyPlugin');
  });
  it('lets Objective-C dependents @import a Swift library through its generated header, as SwiftPM does', async () => {
    const p = plan(); const capacitor = p.graph.targets.find((item) => item.id === 'Capacitor')!;
    const swiftLibrary = target('GTMAppAuth', 'staticLibrary', { productName: 'libGTMAppAuth.a', sourceFiles: [{ path: '/pkg/GTMAppAuth/AuthSession.swift' }] });
    p.graph.targets.push(swiftLibrary); p.graph.targets.find((item) => item.id === 'LegacyPlugin')!.dependencies.push('GTMAppAuth');
    const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    const map = calls.find((call) => call.argv.at(-1)?.endsWith('/modules/GTMAppAuth-Swift/module.modulemap') && typeof call.options.stdin === 'string')!;
    expect(map.options.stdin).toMatch(/^module GTMAppAuth \{\n header ".*\/GTMAppAuth-Swift\.h"\n requires objc\n\}\n$/);
    const objc = calls.find((call) => call.argv.includes('/project/Pods/LegacyPlugin/util.c'))!.argv;
    expect(objc).toContain(`-fmodule-map-file=${map.argv.at(-1)}`);
    const swift = calls.find((call) => call.argv.includes('/project/Pods/Capacitor/CAPBridge.swift'))!.argv;
    expect(swift.join(' ')).not.toContain('GTMAppAuth-Swift');
    expect(capacitor.dependencies).not.toContain('GTMAppAuth');
  });
  it('still refuses two public headers with the same name', async () => {
    const p = plan(); p.graph.targets.find((item) => item.id === 'LegacyPlugin')!.publicHeaders = ['/project/Pods/LegacyPlugin/A/Plugin.h', '/project/Pods/LegacyPlugin/B/Plugin.h'];
    const { executor } = transport();
    await expect(buildNativeWithToolchain(p, executor, tools)).rejects.toThrow('Target LegacyPlugin: two public headers are named Plugin.h.');
  });
  it.skipIf(!python)('reads a device framework slice shipped as a universal file with one arm64 member', async () => {
    // GoogleMobileAds' ios-arm64 slice is a fat file wrapping a static archive.
    const p = plan(); p.graph.targets[0]!.frameworks.push({ path: '/vendor/Ads.framework', embed: true });
    const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    const script = calls.find((call) => call.argv[0] === 'python3' && call.argv[2]?.includes('Universal framework has no arm64 member'))!.argv[2]!;
    const directory = mkdtempSync(path.join(os.tmpdir(), 'capmac-fat-')); temporary.push(directory);
    const universal = (cpu: number) => {
      const member = Buffer.from('!<arch>\nmember'); const header = Buffer.alloc(28);
      header.writeUInt32BE(0xcafebabe, 0); header.writeUInt32BE(1, 4); header.writeUInt32BE(cpu, 8); header.writeUInt32BE(28, 16); header.writeUInt32BE(member.length, 20);
      return Buffer.concat([header, member]);
    };
    const classify = (cpu: number) => { const file = path.join(directory, `Fat${cpu}`); writeFileSync(file, universal(cpu)); return spawnSync(python!, ['-c', script, file], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); };
    expect(classify(0x0100000c).stdout.trim()).toBe('static');
    expect(classify(0x01000007)).toMatchObject({ status: 1, stderr: expect.stringContaining('no arm64 member') });
  });
  it('sends Python programs that actually parse, including compiler-generated-header patching', async () => {
    const p = plan(); const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    const programs = new Set(calls.filter((call) => call.argv[0] === 'python3' && call.argv[1] === '-c').map((call) => call.argv[2]!));
    for (const script of programs) {
      const result = spawnSync(python!, ['-c', 'import sys; compile(sys.stdin.read(),"native-compiler-helper","exec")'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
    }
  });
});

describe('mixed-language CocoaPods graph compilation (transport orchestration, not a hardware build)', () => {
  it.skipIf(!process.env.CAPMAC_TEST_NATIVE_GRAPH)('accepts a real exported CocoaPods graph through final signing orchestration (opt-in)', async () => {
    const p = plan(); p.graph = JSON.parse(readFileSync(process.env.CAPMAC_TEST_NATIVE_GRAPH!, 'utf8')) as WslNativeGraph;
    const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    expect(mocks.sign).toHaveBeenCalledOnce();
    const app = p.graph.targets.find((target) => target.id === p.graph.rootTargetId)!;
    for (const source of app.sourceFiles) expect(calls.some((call) => call.argv.includes(source.path))).toBe(true);
  });
  it('compiles original app, Swift, Objective-C, C and C++, creates static archives, links and signs last', async () => {
    const p = plan(); const { executor, calls } = transport();
    const result = await buildNativeWithToolchain(p, executor, tools);
    const swift = calls.filter((call) => call.argv[0] === tools.swiftcPath);
    const capacitor = swift.find((call) => call.argv.includes('/project/Pods/Capacitor/CAPBridge.swift'))!;
    expect(capacitor.argv).toContain('-import-underlying-module');
    expect(capacitor.argv).toContain('-emit-objc-header-path');
    const native = calls.filter((call) => call.argv[0] === tools.clangPath);
    expect(native).toHaveLength(4);
    const objc = native.find((call) => call.argv.includes('/project/Pods/Capacitor/CAPPlugin.m'))!;
    expect(objc.argv.at(-5)).toBe('-fno-objc-arc');
    expect(calls.indexOf(objc)).toBeGreaterThan(calls.indexOf(capacitor));
    const cpp = native.find((call) => call.argv.includes('/project/Pods/LegacyPlugin/Plugin.mm'))!;
    expect(cpp.argv).toEqual(expect.arrayContaining(['-std=c++20', '-DCOCOAPODS=1', '-DCUSTOM=2', '-DPLUGIN_FILE=1', '-Wno-unused-variable', '-DCXX_NESTED=1']));
    expect(calls.some((call) => call.argv[0] === tools.archivePath && call.argv[1] === 'rcs' && call.argv.some((arg) => arg.endsWith('/libLegacyPlugin.a')))).toBe(true);
    const app = swift.find((call) => call.argv.includes('/project/App/CustomAppDelegate.swift'))!;
    expect(app.argv).toContain('/project/App/SceneDelegate.swift');
    expect(app.argv).toContain('-import-objc-header');
    const appLink = swift.find((call) => call.argv.some((arg) => arg.endsWith('/App.app/App')))!;
    expect(appLink.argv).toContain('-lc++');
    expect(appLink.argv).toContain('Capacitor');
    expect(appLink.argv.some((arg) => arg.endsWith('/libLegacyPlugin.a'))).toBe(true);
    expect(calls.some((call) => call.argv[0] === 'python3' && call.argv.at(-2)?.endsWith('/App.app/Frameworks/Capacitor.framework'))).toBe(true);
    expect(mocks.resources).toHaveBeenCalledWith(executor, p.graph.targets[0]!.resources, expect.objectContaining({ targetName: 'App' }), tools, {});
    expect(mocks.sign).toHaveBeenCalledWith(expect.objectContaining({ bundleIdentifier: 'dev.test.custom', signing: expect.objectContaining({ entitlementsPath: '/project/App/App.entitlements' }) }), executor, tools, result.appPath, result.ipaPath, {});
    expect(JSON.stringify(calls.map((call) => call.argv))).not.toContain(p.signing.password);
    expect(result).toMatchObject({ bundleIdentifier: 'dev.test.custom', executableName: 'App' });
  });
  it('retains per-target scripts before compilation and after resources instead of dropping Pod build phases', async () => {
    const p = plan(); p.graph.targets[0]!.scripts = [{ name: '[CP] Check Pods Manifest.lock', script: 'diff lockfiles', timing: 'beforeCompile' }, { name: 'Custom codegen', script: 'generate', timing: 'beforeCompile' }, { name: 'Custom post compile', script: 'process', timing: 'afterCompile' }, { name: '[CP] Embed Pods Frameworks', script: 'embed', timing: 'afterResources' }];
    const { executor } = transport(); await buildNativeWithToolchain(p, executor, tools);
    const appCalls = mocks.scripts.mock.calls.filter((call) => call[2].targetName === 'App');
    expect(appCalls.map((call) => call[1].map((phase: { name: string }) => phase.name))).toEqual([['[CP] Check Pods Manifest.lock', 'Custom codegen'], ['Custom post compile'], ['[CP] Embed Pods Frameworks']]);
  });
  it('fails with the target name before signing unsupported source languages or per-file Swift settings', async () => {
    const p = plan(); p.graph.targets[0]!.sourceFiles.push({ path: '/project/App/Unsupported.rs' });
    const { executor } = transport(); await expect(buildNativeWithToolchain(p, executor, tools)).rejects.toThrow(/App.*Unsupported.rs/);
    expect(mocks.sign).not.toHaveBeenCalled();
    p.graph.targets[0]!.sourceFiles.pop(); p.graph.targets[0]!.sourceFiles[0]!.flags = ['-D', 'CUSTOM'];
    await expect(buildNativeWithToolchain(p, executor, tools)).rejects.toThrow(/App.*per-file Swift flags/);
  });
  it('does no filesystem or tool work after cancellation', async () => {
    const p = plan(); const { executor } = transport(); const controller = new AbortController(); controller.abort();
    await expect(buildNativeWithToolchain(p, executor, tools, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(executor.run).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('rejects custom product output outside the generated build tree before native compilation', async () => {
    const p = plan(); p.graph.targets[0]!.settings.CONFIGURATION_BUILD_DIR = '/project/user-selected';
    const { executor, calls } = transport();
    await expect(buildNativeWithToolchain(p, executor, tools)).rejects.toThrow(/App.*generated build directory/);
    expect(calls.some((call) => call.argv[0] === tools.clangPath)).toBe(false);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('honors excluded sources and per-configuration reinclusions', async () => {
    const p = plan(); const app = p.graph.targets[0]!;
    app.settings.EXCLUDED_SOURCE_FILE_NAMES = '*.swift'; app.settings.INCLUDED_SOURCE_FILE_NAMES = 'CustomAppDelegate.swift';
    const { executor, calls } = transport(); await buildNativeWithToolchain(p, executor, tools);
    const appCompile = calls.find((call) => call.argv.includes('/project/App/CustomAppDelegate.swift'))!;
    expect(appCompile.argv).not.toContain('/project/App/SceneDelegate.swift');
  });
  it('compiles generated Core Data sources in the same application module', async () => {
    const p = plan(); const { executor, calls } = transport();
    mocks.generated.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(['/generated/Model+CoreDataProperties.swift']);
    await buildNativeWithToolchain(p, executor, tools);
    const appCompile = calls.find((call) => call.argv.includes('/project/App/CustomAppDelegate.swift'))!;
    expect(appCompile.argv).toContain('/generated/Model+CoreDataProperties.swift');
  });
  it('builds and embeds the widget with extension-only API flags, NSExtensionMain and shared framework runpaths', async () => {
    const p = plan(); const widget = addWidget(p);
    p.signing.extensionProfiles = { 'dev.test.custom.HomeCard': '/signing/widget.mobileprovision' };
    const { executor, calls } = transport(); const result = await buildNativeWithToolchain(p, executor, tools);
    const compilation = calls.find((call) => call.argv[0] === tools.swiftcPath && call.argv.includes('/project/plugins/home-card/HomeCardWidget.swift'))!;
    expect(compilation.argv).toContain('-application-extension'); expect(compilation.argv).toContain('-parse-as-library');
    const native = calls.find((call) => call.argv[0] === tools.clangPath && call.argv.includes('/project/plugins/home-card/WidgetNative.m'))!;
    expect(native.argv).toContain('-fapplication-extension');
    const link = calls.find((call) => call.argv[0] === tools.swiftcPath && call.argv.at(-1)?.endsWith('/HomeCard.appex/HomeCard'))!;
    expect(link.argv).toEqual(expect.arrayContaining(['_NSExtensionMain', '-application_extension', '@executable_path/../../Frameworks']));
    expect(calls.some((call) => call.argv[0] === 'python3' && call.argv.at(-2)?.endsWith('/App.app/PlugIns/HomeCard.appex'))).toBe(true);
    expect(mocks.resources).toHaveBeenCalledWith(executor, widget.resources, expect.objectContaining({ targetName: 'HomeCard', settings: expect.objectContaining({ PACKAGE_TYPE: 'XPC!', PRODUCT_BUNDLE_PACKAGE_TYPE: 'XPC!' }) }), tools, {});
    expect(mocks.sign).toHaveBeenCalledWith(expect.objectContaining({ nestedBundles: [expect.objectContaining({ bundleIdentifier: 'dev.test.custom.HomeCard', appPath: path.join(result.appPath, 'PlugIns', 'HomeCard.appex'), provisioningProfilePath: '/signing/widget.mobileprovision', entitlementsPath: '/project/HomeCard/HomeCard.entitlements', buildSettings: expect.objectContaining({ APPLICATION_EXTENSION_API_ONLY: 'YES' }) })] }), executor, tools, result.appPath, result.ipaPath, {});
    expect(result.signed).toBe(true);
  });
  it('packages an unsigned app including the complete widget without requiring extension profiles', async () => {
    const p = plan(); addWidget(p); p.unsigned = true;
    const { executor } = transport(); const phases: string[] = [];
    const hooks = { onPhase: (phase: string) => phases.push(phase) };
    const result = await buildNativeWithToolchain(p, executor, tools, hooks);
    expect(result.signed).toBe(false); expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.packageUnsigned).toHaveBeenCalledWith(executor, result.appPath, result.ipaPath, hooks);
    expect(phases).not.toContain('sign');
  });
  it('requires the widget own provisioning profile and rejects unrelated extension bundle identifiers', async () => {
    const p = plan(); const widget = addWidget(p); const { executor } = transport();
    await expect(buildNativeWithToolchain(p, executor, tools)).rejects.toThrow(/HomeCard.*no provisioning profile.*dev.test.custom.HomeCard/);
    expect(mocks.sign).not.toHaveBeenCalled();
    widget.settings.PRODUCT_BUNDLE_IDENTIFIER = 'dev.unrelated.widget';
    await expect(buildNativeWithToolchain(p, executor, tools)).rejects.toThrow(/HomeCard.*must start with dev.test.custom/);
  });
  it('retains CocoaPods actual XCFramework intermediate directory consistently for script phases', async () => {
    const p = plan(); p.graph.targets[0]!.settings.PODS_XCFRAMEWORKS_BUILD_DIR = '${BUILD_DIR}/${CONFIGURATION}${EFFECTIVE_PLATFORM_NAME}/XCFrameworkIntermediates';
    const { executor } = transport(); await buildNativeWithToolchain(p, executor, tools);
    const appScriptContext = mocks.scripts.mock.calls.find((call) => call[2].targetName === 'App')![2];
    expect(appScriptContext.settings.PODS_XCFRAMEWORKS_BUILD_DIR).toBe(appScriptContext.settings.BUILD_DIR + '/Debug-iphoneos/XCFrameworkIntermediates');
  });
});
