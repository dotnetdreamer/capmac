import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileWslResources, generateWslResourceSources, inspectWslResourceTools, installWslResourceTools, runWslScriptPhases, wslResourceDestination, WSL_RESOURCE_TOOLS_REVISION, type WslResourceContext } from '../../packages/core/src/engine/wsl/resources.js';
import { COPY_RESOURCE, INSTALL_RESOURCE_TOOLS, LLVM_TOOL_RESOLVER, MERGE_RESOURCE_PLIST, PATCH_IBTOOL, RUN_SCRIPT_PHASE, TOOL_ROUTER } from '../../packages/core/src/engine/wsl/resource-tools/runtime.js';
import type { WslCommandResult, WslRunOptions } from '../../packages/core/src/engine/wsl/toolchain.js';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temp(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'capmac-resource-test-'));
  temporary.push(directory);
  return directory;
}
const context: WslResourceContext = {
  projectRoot: '/mnt/c/project/ios/App', buildDirectory: '/mnt/c/project/.capmac/build',
  productDirectory: '/mnt/c/project/.capmac/build/Debug-iphoneos/App.app', targetName: 'My App',
  settings: { PRODUCT_BUNDLE_IDENTIFIER: 'dev.capmac.app', PRODUCT_MODULE_NAME: 'App', IPHONEOS_DEPLOYMENT_TARGET: '16.0', ASSETCATALOG_COMPILER_APPICON_NAME: 'AppIcon', TARGETED_DEVICE_FAMILY: '1,2' },
  sdkPath: '/opt/iPhoneOS.sdk',
};
const tools = { sdkPath: '/opt/iPhoneOS.sdk', swiftcPath: '/opt/swift/bin/swiftc', linkerPath: '/usr/bin/ld64.lld', signerPath: '/usr/bin/zsign', actoolPath: '/opt/capmac/actool', ibtoolPath: '/opt/capmac/ibtool', momcPath: '/opt/capmac/momc', xcstringsPath: '/opt/capmac/xcstringstool' };
function fakeExecutor(fail?: (argv: readonly string[]) => Partial<WslCommandResult> | undefined) {
  const calls: { argv: readonly string[]; options: WslRunOptions }[] = [];
  const run = vi.fn(async (argv: readonly string[], options: WslRunOptions = {}): Promise<WslCommandResult> => {
    calls.push({ argv, options });
    const failure = fail?.(argv);
    return { code: 0, stdout: argv[0] === 'python3' && argv[2]?.includes('shutil.which') ? String(argv[3]) + '\n' : '', stderr: '', ...failure };
  });
  return { executor: { distro: 'Ubuntu', run, path: vi.fn(async (input: string) => input) }, calls };
}
function python(script: string, args: string[] = []) {
  const result = spawnSync('python', ['-c', script, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

describe('WSL native resources', () => {
  it('preserves localization and converts source resource names to compiled names', () => {
    expect(wslResourceDestination({ source: '/project/Base.lproj/Main.storyboard' })).toBe('Base.lproj/Main.storyboardc');
    expect(wslResourceDestination({ source: '/project/en.lproj/Foo.strings' })).toBe('en.lproj/Foo.strings');
    expect(wslResourceDestination({ source: '/project/View.xib' })).toBe('View.nib');
    expect(wslResourceDestination({ source: '/project/Model.xcdatamodeld' })).toBe('Model.momd');
  });

  it.each(['../outside', '/outside', 'Info.plist', '_CodeSignature/CodeResources', 'Frameworks/Foo.framework', 'foo\\bar', 'folder/../file'])('rejects unsafe or reserved resource destination %s', (destination) => {
    expect(() => wslResourceDestination({ source: '/project/Logo.png', destination })).toThrow();
  });

  it('combines catalogs, compiles IB documents, and copies runtime resources without shipping their sources', async () => {
    const { executor, calls } = fakeExecutor();
    await compileWslResources(executor, [
      { source: '/project/Assets.xcassets' }, { source: '/project/More.xcassets' },
      { source: '/project/Base.lproj/Main.storyboard' }, { source: '/project/View.xib' },
      { source: '/project/Model.xcdatamodeld' }, { source: '/project/Localizable.xcstrings' },
      { source: '/project/PrivacyInfo.xcprivacy' }, { source: '/project/web', destination: 'public' },
    ], context, tools);
    const assetCalls = calls.filter((call) => call.argv[0] === tools.actoolPath);
    expect(assetCalls).toHaveLength(1);
    expect(assetCalls[0]!.argv).toEqual(expect.arrayContaining(['/project/Assets.xcassets', '/project/More.xcassets', '--app-icon', 'AppIcon', '--target-device', 'ipad']));
    expect(calls.some((call) => call.argv[0] === 'python3' && call.argv[2] === MERGE_RESOURCE_PLIST)).toBe(true);
    const storyboard = calls.find((call) => call.argv[0] === tools.ibtoolPath && call.argv.includes('/project/Base.lproj/Main.storyboard'))!;
    expect(storyboard.argv).toContain('--compilation-directory');
    expect(storyboard.argv.at(-1)).toContain('/Base.lproj');
    expect(calls.some((call) => call.argv[0] === tools.ibtoolPath && call.argv.includes(`${context.productDirectory}/View.nib`))).toBe(true);
    expect(calls.some((call) => call.argv[0] === tools.momcPath && call.argv.includes('/project/Model.xcdatamodeld'))).toBe(true);
    expect(calls.some((call) => call.argv[0] === tools.xcstringsPath && call.argv.includes('compile'))).toBe(true);
    const copiedSources = calls.filter((call) => call.argv[2] === COPY_RESOURCE).map((call) => call.argv[3]);
    expect(copiedSources).toContain('/project/PrivacyInfo.xcprivacy');
    expect(copiedSources).toContain('/project/web');
    expect(copiedSources).not.toContain('/project/Base.lproj/Main.storyboard');
    expect(copiedSources).not.toContain('/project/Assets.xcassets');
  });

  it('fails before copying anything when a required compiler is missing', async () => {
    const { executor, calls } = fakeExecutor((argv) => argv[3] === tools.ibtoolPath ? { code: 1, stdout: '' } : undefined);
    await expect(compileWslResources(executor, [{ source: '/project/web' }, { source: '/project/Main.storyboard' }], context, tools)).rejects.toThrow(/ibtool/);
    expect(calls.every((call) => call.argv[0] === 'python3' && call.argv[2]?.includes('shutil.which'))).toBe(true);
  });

  it('rejects omitted catalog entries even when the asset compiler returns success', async () => {
    const { executor } = fakeExecutor((argv) => argv[0] === tools.actoolPath ? { stdout: 'Media: warning: skipped by the Linux actool: unsupported AR resource' } : undefined);
    await expect(compileWslResources(executor, [{ source: '/project/Assets.xcassets' }], context, tools)).rejects.toThrow(/resource compilation failed/i);
  });

  it('preserves the actionable rasterizer error ahead of a long Swift crash backtrace', async () => {
    const diagnostic = 'Fatal error: rsvg-convert not found; install librsvg2-bin\n' + Array.from({ length: 80 }, (_, index) => `Swift crash backtrace frame ${index}`).join('\n');
    const { executor } = fakeExecutor((argv) => argv[0] === tools.actoolPath ? { code: 1, stderr: diagnostic } : undefined);
    await expect(compileWslResources(executor, [{ source: '/project/Assets.xcassets' }], context, tools)).rejects.toMatchObject({ details: expect.arrayContaining(['Fatal error: rsvg-convert not found; install librsvg2-bin']) });
  });

  it('does not copy unsupported compilable sources as runtime resources', async () => {
    const { executor } = fakeExecutor();
    await expect(compileWslResources(executor, [{ source: '/project/Shader.metal' }], context, tools)).rejects.toThrow(/compiler/);
    expect(executor.run).not.toHaveBeenCalled();
  });

  it('checks compiler availability and preserves cancellation', async () => {
    const { executor } = fakeExecutor((argv) => argv[3] === tools.momcPath ? { code: 1, stdout: '' } : undefined);
    const report = await inspectWslResourceTools(executor, tools);
    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.name.startsWith('momc'))).toMatchObject({ ok: false });
    const controller = new AbortController(); controller.abort();
    await expect(compileWslResources(executor, [], context, tools, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('generates automatic Core Data classes before source compilation and returns checked source paths', async () => {
    const { executor, calls } = fakeExecutor((argv) => {
      if (argv[0] === 'python3' && argv[2]?.includes('xml.etree')) return { stdout: 'generate\n' };
      if (argv[0] === tools.momcPath && argv.includes('--dry-run')) return { stdout: `${argv.at(-1)}/Entity+CoreDataClass.swift\n${argv.at(-1)}/Entity+CoreDataProperties.swift\n` };
      return undefined;
    });
    const generated = await generateWslResourceSources(executor, [{ source: '/project/Model.xcdatamodeld' }], context, tools);
    expect(generated).toHaveLength(2);
    const generator = calls.find((call) => call.argv[0] === tools.momcPath && !call.argv.includes('--dry-run'))!;
    expect(generator.argv).toEqual(expect.arrayContaining(['--action', 'generate', '--module', 'App', '--swift-version', '5']));
    expect(calls.at(-1)!.argv).toEqual(expect.arrayContaining(generated));
  });

  it('does not generate manual Core Data classes and rejects generator path traversal', async () => {
    const manual = fakeExecutor((argv) => argv[0] === 'python3' && argv[2]?.includes('xml.etree') ? { stdout: 'manual\n' } : undefined);
    await expect(generateWslResourceSources(manual.executor, [{ source: '/project/Model.xcdatamodel' }], context, tools)).resolves.toEqual([]);
    expect(manual.calls.some((call) => call.argv[0] === tools.momcPath)).toBe(false);
    const unsafe = fakeExecutor((argv) => {
      if (argv[0] === 'python3' && argv[2]?.includes('xml.etree')) return { stdout: 'generate\n' };
      if (argv[0] === tools.momcPath) return { stdout: '/tmp/outside.swift\n' };
      return undefined;
    });
    await expect(generateWslResourceSources(unsafe.executor, [{ source: '/project/Model.xcdatamodeld' }], context, tools)).rejects.toThrow(/unsafe generated source/);
  });
});

describe('real resource helper execution', () => {
  it('keeps custom sRGB Double components in the compiled binary UIColor archive', () => {
    const directory = temp();
    cpSync(path.resolve('test/fixtures/wsl-resource-tools'), directory, { recursive: true });
    const patched = python(PATCH_IBTOOL + '\nimport pathlib,sys\npatch_ibtool(pathlib.Path(sys.argv[1]))\n', [path.join(directory, 'ibtool')]);
    expect(patched.status, patched.stderr).toBe(0);
    const fixture = path.join(directory, 'DoubleColors.storyboard');
    const original = readFileSync(path.resolve('examples/hello-capacitor/ios/App/App/Base.lproj/LaunchScreen.storyboard'), 'utf8');
    writeFileSync(fixture, original.replace(/<color key="backgroundColor"[^>]*\/>/, '<color key="backgroundColor" red="0.058823529411764705" green="0.070588235294117646" blue="0.12549019607843137" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>'));
    const output = path.join(directory, 'compiled');
    const compiled = spawnSync('python', [path.join(directory, 'ibtool'), '--module', 'App', fixture, '--compilation-directory', output], { encoding: 'utf8', windowsHide: true });
    expect(compiled.status, compiled.stderr).toBe(0);
    const proof = python(String.raw`import json,pathlib,sys
sys.path.insert(0,sys.argv[1]); import nibarchive as N
colors=[]
for file in pathlib.Path(sys.argv[2]).rglob('*.nib'):
 archive=N.load(str(file))
 for i,obj in enumerate(archive.objects):
  if archive.object_class(i)=='UIColor':
   colors.append({archive.key(v.key_idx):{'type':v.type,'value':v.payload} for v in archive.object_values(obj) if v.type in [N.FLOAT,N.DOUBLE]})
print(json.dumps(colors))
`, [directory, output]);
    expect(proof.status, proof.stderr).toBe(0);
    const colors = JSON.parse(proof.stdout) as Record<string, { type: number; value: number }>[];
    const custom = colors.find((color) => color['UIRed-Double'])!;
    expect(custom['UIRed-Double']).toEqual({ type: 7, value: 0.058823529411764705 });
    expect(custom['UIGreen-Double']).toEqual({ type: 7, value: 0.070588235294117646 });
    expect(custom['UIBlue-Double']).toEqual({ type: 7, value: 0.12549019607843137 });
    expect(custom.UIAlpha).toEqual({ type: 6, value: 1 });
    expect(custom['UIAlpha-Double']).toBeUndefined();
  });

  it('compiles stock Capacitor controller-only Main and image-root LaunchScreen into real binary nibs', () => {
    const directory = temp();
    const upstream = path.resolve('test/fixtures/wsl-resource-tools');
    cpSync(upstream, directory, { recursive: true });
    const patched = python(PATCH_IBTOOL + '\nimport pathlib,sys\npatch_ibtool(pathlib.Path(sys.argv[1]))\n', [path.join(directory, 'ibtool')]);
    expect(patched.status, patched.stderr).toBe(0);
    const output = path.join(directory, 'Base.lproj');
    const source = path.resolve('examples/hello-capacitor/ios/App/App/Base.lproj');
    for (const name of ['Main', 'LaunchScreen']) {
      const compiled = spawnSync('python', [path.join(directory, 'ibtool'), '--module', 'App', '--minimum-deployment-target', '15.0', path.join(source, `${name}.storyboard`), '--compilation-directory', output], { encoding: 'utf8', windowsHide: true });
      expect(compiled.status, compiled.stderr).toBe(0);
    }
    const inspect = String.raw`import json,pathlib,plistlib,sys
sys.path.insert(0,sys.argv[1]); import nibarchive as N
root=pathlib.Path(sys.argv[2]); results={}
for name in ['Main','LaunchScreen']:
 folder=root/(name+'.storyboardc')
 with (folder/'Info.plist').open('rb') as f: info=plistlib.load(f)
 archives={file.name:N.load(str(file)).dump_text() for file in folder.glob('*.nib')}
 results[name]={'info':info,'archives':archives}
print(json.dumps(results))
`;
    const result = python(inspect, [directory, output]);
    expect(result.status, result.stderr).toBe(0);
    const compiled = JSON.parse(result.stdout) as Record<string, { info: Record<string, unknown>; archives: Record<string, string> }>;
    expect(compiled.Main!.info.UIStoryboardDesignatedEntryPointIdentifier).toBe('UIViewController-BYZ-38-t0r');
    expect(Object.keys(compiled.Main!.archives)).toEqual(['UIViewController-BYZ-38-t0r.nib']);
    const main = compiled.Main!.archives['UIViewController-BYZ-38-t0r.nib']!;
    expect(main).toContain('UIClassSwapper');
    expect(main).toContain('_TtC9Capacitor23CAPBridgeViewController');
    expect(main).toContain("string 'sceneViewController'");
    expect(main).not.toContain('UINibName');
    expect(main).not.toMatch(/\[\d+\] (?:UIView|UIImageView)\r?$/m);
    const launch = Object.values(compiled.LaunchScreen!.archives).join('\n');
    expect(launch).toContain('UIImageView');
    expect(launch).toContain("string 'Splash'");
    expect(launch).toContain('UIContentMode = int 2');
    expect(launch).toContain('UIBackgroundColor');
    expect(launch).toContain('NIBArchive version=1');
  });

  it('copies nested bundles and merges privacy reasons without losing either manifest', () => {
    const directory = temp(); const app = path.join(directory, 'App.app'); mkdirSync(app);
    const bundle = path.join(directory, 'Plugin.bundle'); mkdirSync(bundle); writeFileSync(path.join(bundle, 'en.strings'), '"hello" = "Hello";');
    let result = python(COPY_RESOURCE, [bundle, app, 'Plugin.bundle']);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(app, 'Plugin.bundle', 'en.strings'), 'utf8')).toContain('Hello');
    result = python(COPY_RESOURCE, [bundle, app, 'Plugin.bundle']);
    expect(result.status, result.stderr).toBe(0);
    writeFileSync(path.join(bundle, 'en.strings'), '"hello" = "Different";');
    result = python(COPY_RESOURCE, [bundle, app, 'Plugin.bundle']);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('already exists');
    const first = { NSPrivacyTracking: false, NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] }] };
    const incoming = path.join(directory, 'PrivacyInfo.xcprivacy');
    writeFileSync(path.join(app, 'PrivacyInfo.xcprivacy'), plist.build(first));
    writeFileSync(incoming, plist.build({ NSPrivacyTracking: true, NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['1C8F.1'] }] }));
    result = python(COPY_RESOURCE, [incoming, app, 'PrivacyInfo.xcprivacy']);
    expect(result.status, result.stderr).toBe(0);
    const merged = plist.parse(readFileSync(path.join(app, 'PrivacyInfo.xcprivacy'), 'utf8')) as Record<string, unknown>;
    expect(merged.NSPrivacyTracking).toBe(true);
    expect(merged.NSPrivacyAccessedAPITypes).toEqual([{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1', '1C8F.1'] }]);
  });

  it('rejects uncompiled native sources hidden inside copied bundles', () => {
    const directory = temp(); const bundle = path.join(directory, 'Plugin.bundle'); mkdirSync(bundle);
    writeFileSync(path.join(bundle, 'Hidden.xib'), '<document/>');
    const result = python(COPY_RESOURCE, [bundle, path.join(directory, 'App.app'), 'Plugin.bundle']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Uncompiled native resource');
  });

  it('merges compiled icon metadata into the real application Info.plist', () => {
    const directory = temp(); const target = path.join(directory, 'Info.plist'); const partial = path.join(directory, 'partial.plist');
    writeFileSync(target, plist.build({ CFBundleIdentifier: 'dev.capmac.test', CFBundleIcons: { Existing: true } }));
    writeFileSync(partial, plist.build({ CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconName: 'AppIcon' } } }));
    const result = python(MERGE_RESOURCE_PLIST, [target, partial]);
    expect(result.status, result.stderr).toBe(0);
    expect(plist.parse(readFileSync(target, 'utf8'))).toMatchObject({ CFBundleIdentifier: 'dev.capmac.test', CFBundleIcons: { Existing: true, CFBundlePrimaryIcon: { CFBundleIconName: 'AppIcon' } } });
  });

  it('routes xcrun queries and reports missing real tools instead of pretending success', () => {
    const directory = temp(); const router = path.join(directory, 'xcrun'); writeFileSync(router, TOOL_ROUTER);
    writeFileSync(path.join(directory, 'tools.json'), JSON.stringify({ tools: { actool: 'installed-actool' }, sdkPath: '/opt/iPhoneOS.sdk', sdkVersion: '27.0' }));
    let result = spawnSync('python', [router, '--sdk', 'iphoneos', '--show-sdk-path'], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('/opt/iPhoneOS.sdk');
    result = spawnSync('python', [router, '--find', 'codesign'], { encoding: 'utf8', windowsHide: true });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('No Linux replacement for codesign');
  });

  it('answers only verified xcodebuild metadata queries and refuses Xcode build operations', () => {
    const directory = temp(); const router = path.join(directory, 'xcodebuild'); writeFileSync(router, TOOL_ROUTER);
    writeFileSync(path.join(directory, 'tools.json'), JSON.stringify({ tools: {}, sdkPath: '/opt/iPhoneOS.sdk', sdkVersion: '27.0', xcodeVersion: '27.0', xcodeBuild: '18A001' }));
    let result = spawnSync('python', [router, '-version'], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.replace(/\r\n/g, '\n').trim()).toBe('Xcode 27.0\nBuild version 18A001');
    result = spawnSync('python', [router, '-showsdks'], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('-sdk iphoneos27.0');
    result = spawnSync('python', [router, '-workspace', 'App.xcworkspace', 'build'], { encoding: 'utf8', windowsHide: true });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('build operations require a real WSL implementation');
  });

  it('discovers versioned real LLVM command names deterministically and never selects GNU strip', () => {
    const directory = temp(); const older = path.join(directory, 'older'); const newer = path.join(directory, 'newer'); const swiftbin = path.join(directory, 'swiftbin');
    for (const folder of [older, newer, swiftbin]) mkdirSync(folder);
    writeFileSync(path.join(older, 'llvm-lipo-18'), 'test executable', { mode: 0o755 });
    writeFileSync(path.join(newer, 'llvm-lipo-21'), 'test executable', { mode: 0o755 });
    writeFileSync(path.join(newer, 'llvm-lipo-21.1'), 'test executable', { mode: 0o755 });
    writeFileSync(path.join(older, 'strip'), 'test GNU command', { mode: 0o755 });
    const probe = LLVM_TOOL_RESOLVER + String.raw`import json,os,sys
os.environ['PATH']=sys.argv[1]
print(json.dumps({'lipo':resolve_llvm_tool(None,'llvm-lipo',sys.argv[2]),'strip':resolve_llvm_tool(None,'llvm-strip',sys.argv[2])}))
`;
    let result = python(probe, [[older, newer].join(path.delimiter), swiftbin]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ lipo: path.join(newer, 'llvm-lipo-21.1'), strip: null });
    writeFileSync(path.join(swiftbin, 'llvm-lipo'), 'test toolchain executable', { mode: 0o755 });
    result = python(probe, [[older, newer].join(path.delimiter), swiftbin]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).lipo).toBe(path.join(swiftbin, 'llvm-lipo'));
  });

  it('keeps all embedded Python helpers syntactically valid', () => {
    for (const script of [COPY_RESOURCE, MERGE_RESOURCE_PLIST, TOOL_ROUTER, RUN_SCRIPT_PHASE, INSTALL_RESOURCE_TOOLS]) {
      const result = spawnSync('python', ['-c', 'import sys; compile(sys.stdin.read(),"capmac-helper","exec")'], { input: script, encoding: 'utf8', windowsHide: true });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('builds the actual CocoaPods phase environment without replacing product directories', () => {
    const directory = temp(); const project = path.join(directory, 'ios', 'App'); const build = path.join(directory, 'build');
    const sdk = path.join(directory, 'iPhoneOS.sdk'); mkdirSync(project, { recursive: true }); mkdirSync(sdk);
    writeFileSync(path.join(sdk, 'SDKSettings.plist'), plist.build({ Version: '27.0' }));
    const output = path.join(directory, 'captured.json');
    const request = {
      phase: { name: '[CP] Copy Pods Resources', script: '"${PODS_ROOT}/Target Support Files/Pods-App/Pods-App-resources.sh"', inputPaths: ['${PODS_ROOT}/Manifest.lock'], outputFileListPaths: ['${PODS_ROOT}/Target Support Files/out.xcfilelist'] },
      context: { ...context, projectRoot: project, buildDirectory: build, productDirectory: path.join(build, 'products', 'Capacitor', 'Capacitor.framework'), sdkPath: sdk, settings: { BUILT_PRODUCTS_DIR: path.join(build, 'products'), CONFIGURATION_BUILD_DIR: path.join(build, 'products', 'Capacitor'), TARGET_BUILD_DIR: path.join(build, 'products', 'Capacitor'), PODS_ROOT: path.join(project, 'Pods'), DERIVED_FILE_DIR: path.join(build, 'targets', 'Capacitor', 'Generated'), TARGET_TEMP_DIR: path.join(build, 'targets', 'Capacitor'), XCODE_VERSION_ACTUAL: '2710' } },
      tools, router: TOOL_ROUTER,
    };
    // Capture the subprocess boundary instead of starting a Linux shell on the
    // Windows test host. Files, plist parsing, path handling and env are real.
    const capture = String.raw`import json,pathlib,shutil,subprocess,types
pathlib.Path.symlink_to=lambda self,target:self.write_text('test wrapper')
original_which=shutil.which
shutil.which=lambda name:'/bin/bash' if name=='/bin/bash' else original_which(name)
subprocess.run=lambda argv,cwd,env:(pathlib.Path(${JSON.stringify(output)}).write_text(json.dumps({'argv':argv,'cwd':cwd,'env':{k:v for k,v in env.items() if k in ['BUILT_PRODUCTS_DIR','CONFIGURATION_BUILD_DIR','TARGET_BUILD_DIR','SCRIPT_INPUT_FILE_0','SCRIPT_INPUT_FILE_COUNT','SCRIPT_OUTPUT_FILE_LIST_0','SCRIPT_OUTPUT_FILE_LIST_COUNT','CODE_SIGNING_ALLOWED','SDK_VERSION','TARGET_NAME','DERIVED_FILE_DIR','TARGET_TEMP_DIR','XCODE_VERSION_MAJOR']}})) or True) and types.SimpleNamespace(returncode=0)
`;
    const result = spawnSync('python', ['-c', capture + RUN_SCRIPT_PHASE], { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    const captured = JSON.parse(readFileSync(output, 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string> };
    expect(captured.argv[0]).toBe('/bin/bash');
    expect(captured.argv[3]).toBe('/bin/bash "${PODS_ROOT}/Target Support Files/Pods-App/Pods-App-resources.sh"');
    expect(captured.cwd).toBe(project);
    expect(captured.env).toMatchObject({ BUILT_PRODUCTS_DIR: path.join(build, 'products'), CONFIGURATION_BUILD_DIR: path.join(build, 'products', 'Capacitor'), TARGET_BUILD_DIR: path.join(build, 'products', 'Capacitor'), SCRIPT_INPUT_FILE_COUNT: '1', SCRIPT_INPUT_FILE_0: `${path.join(project, 'Pods')}/Manifest.lock`, SCRIPT_OUTPUT_FILE_LIST_COUNT: '1', CODE_SIGNING_ALLOWED: 'NO', SDK_VERSION: '27.0', TARGET_NAME: 'My App', DERIVED_FILE_DIR: path.join(build, 'targets', 'Capacitor', 'Generated'), TARGET_TEMP_DIR: path.join(build, 'targets', 'Capacitor'), XCODE_VERSION_MAJOR: '2700' });
    expect(JSON.parse(readFileSync(path.join(build, 'script-tools', 'tools.json'), 'utf8')).xcodeVersion).toBe('27.1');
  });
});

describe('WSL native script phases and explicit tool setup', () => {
  it('preserves phase order and sends scripts and build context as data with cancellation/logging hooks', async () => {
    const { executor, calls } = fakeExecutor(); const onOutput = vi.fn(); const signal = new AbortController().signal;
    const phases = [{ name: '[CP] Check Pods Manifest.lock', script: 'diff "${PODS_ROOT}/Manifest.lock" "${PODS_PODFILE_DIR_PATH}/Podfile.lock"', inputPaths: ['${PODS_ROOT}/Manifest.lock'] }, { name: '[CP] Copy Pods Resources', script: '"${PODS_ROOT}/Target Support Files/Pods-App/Pods-App-resources.sh"' }];
    await runWslScriptPhases(executor, phases, context, tools, { onOutput, signal });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => JSON.parse(String(call.options.stdin)).phase.name)).toEqual(phases.map((phase) => phase.name));
    expect(calls[1]!.options).toMatchObject({ signal, onOutput, allowFailure: true });
    expect(JSON.parse(String(calls[1]!.options.stdin))).toMatchObject({ context, tools });
    expect(calls[1]!.argv).toEqual(['python3', '-c', RUN_SCRIPT_PHASE]);
    expect(RUN_SCRIPT_PHASE).toContain("'CODE_SIGNING_ALLOWED':'NO'");
    expect(RUN_SCRIPT_PHASE).toContain('SCRIPT_INPUT_FILE_LIST');
  });

  it('stops immediately when a script phase fails and surfaces its diagnostics', async () => {
    const { executor, calls } = fakeExecutor(() => ({ code: 42, stderr: 'error: unavailable macOS build utility' }));
    const operation = runWslScriptPhases(executor, [{ name: 'Generate', script: 'macos-tool' }, { name: 'Copy', script: 'cp x y' }], context, tools);
    await expect(operation).rejects.toMatchObject({ message: 'Native build script failed: Generate', details: ['error: unavailable macOS build utility'] });
    expect(calls).toHaveLength(1);
  });

  it('pins standalone helper installation and accepts only valid absolute WSL executable paths', async () => {
    const installed = { actoolPath: '/home/user/tools/actool', ibtoolPath: '/home/user/tools/ibtool', momcPath: '/home/user/tools/momc', xcstringsPath: '/home/user/tools/xcstringstool' };
    const { executor, calls } = fakeExecutor(() => ({ stdout: JSON.stringify(installed) }));
    await expect(installWslResourceTools(executor)).resolves.toEqual(installed);
    expect(calls[0]!.argv).toEqual(['python3', '-c', INSTALL_RESOURCE_TOOLS, WSL_RESOURCE_TOOLS_REVISION, 'swift']);
    expect(INSTALL_RESOURCE_TOOLS).toContain("--product','actool'");
    expect(INSTALL_RESOURCE_TOOLS).not.toContain('install-toolchain.sh');
    const invalid = fakeExecutor(() => ({ stdout: JSON.stringify({ ...installed, ibtoolPath: 'relative/ibtool' }) }));
    await expect(installWslResourceTools(invalid.executor)).rejects.toThrow(/invalid WSL/);
  });
});
