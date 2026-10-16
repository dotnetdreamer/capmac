import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentContext } from '../../packages/core/src/engine/context.js';
import type { ProjectInfo } from '../../packages/core/src/engine/project.js';
import { findCocoaPodsDirectory, inspectCocoaPods, mirrorWslWorkspace, prepareCocoaPodsProject } from '../../packages/core/src/engine/wsl/cocoapods.js';
import type { WslExecutor } from '../../packages/core/src/engine/wsl/toolchain.js';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile: mocks.execFile }));
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capmac-pods-'));
  directories.push(root);
  const project = { kind: 'capacitor', capDir: root, syncRoot: root, projectRel: '', iosDir: 'ios', webDir: 'dist', scheme: 'App',
    appId: 'com.example.pods', appName: 'Pods Fixture', config: {}, configFile: path.join(root, 'capacitor.config.json'),
    iosPackageManager: 'CocoaPods', packageManager: 'npm', hasIos: true, projectId: 'fixture', scripts: {}, electron: null } as ProjectInfo;
  await mkdir(path.join(root, 'ios', 'App'), { recursive: true });
  await writeFile(path.join(root, 'ios', 'App', 'Podfile'), "target 'App' do\nend\n");
  await writeFile(path.join(root, 'ios', 'App', 'Podfile.lock'), 'PODS: []\n');
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist', 'index.html'), '<html>fixture</html>');
  await mkdir(path.join(root, 'node_modules', '@capacitor', 'cli'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', '@capacitor', 'cli', 'package.json'), '{}');
  const directory = path.join(root, '.capmac', 'pods-inputs');
  const run = vi.fn(async (_argv: readonly string[], options: { stdin?: string } = {}) => {
    if (_argv[0] === 'python3' && !options.stdin) return { code: 0, stdout: '', stderr: '' };
    if (options.stdin) {
      const request = JSON.parse(options.stdin);
      if (request.phase === 'mirror') {
        await mkdir(path.join(request.workspace, 'node_modules', '@capacitor', 'cli'), { recursive: true });
        await writeFile(path.join(request.workspace, 'node_modules', '@capacitor', 'cli', 'package.json'), '{}');
      } else {
        await writeFile(path.join(directory, 'native-graph.json'), JSON.stringify({ version: 1, sdk: 'iphoneos',
          projectRoot: request.workspace, configuration: request.configuration, rootTargetId: 'App',
          targets: [{ id: 'App', name: 'App', productType: 'application', sourceFiles: [{ path: '/mirror/AppDelegate.swift' }] }] }));
      }
    }
    return { code: 0, stdout: '1.17.0\n', stderr: '' };
  });
  const executor = { distro: 'Ubuntu', run, path: vi.fn(async (value: string) => value) } as unknown as WslExecutor;
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(null, '', ''));
    return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  });
  const options = { directory, executor, tools: { sdkPath: '/SDK/iPhoneOS.sdk', swiftcPath: 'swiftc', signerPath: 'zsign', linkerPath: 'ld64.lld' },
    configuration: 'Debug', outputDirectory: path.join(root, 'output'), signing: { certificatePath: '/cert.p12', provisioningProfilePath: '/app.mobileprovision', password: 'secret' } };
  return { root, project, options, run };
}

describe('CocoaPods native project preparation', () => {
  it('probes actual Ruby, CocoaPods and the installed xcodeproj parser', async () => {
    const { options, run } = await fixture();
    expect(await inspectCocoaPods(options.executor)).toMatchObject({ ready: true });
    expect(run.mock.calls.map(([argv]) => argv)).toEqual([
      ['ruby', '--version'], ['git', '--version'], ['pod', '--version', '--allow-root'], ['ruby', '-rxcodeproj', '-e', 'puts Xcodeproj::VERSION'],
      ['ruby', '-rethon', '-e', 'puts "libcurl #{Ethon::Curl.version}"'],
    ]);
  });

  it('reports missing gems before running source or plugin hooks', async () => {
    const { options, project, run } = await fixture();
    run.mockResolvedValue({ code: 1, stdout: '', stderr: 'cannot load such file -- xcodeproj' });
    await expect(prepareCocoaPodsProject(project, options, silentContext(), new AbortController().signal)).rejects.toThrow('CocoaPods toolchain is not ready');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('probes a project Gemfile through Bundler without requiring a global pod or xcodeproj installation', async () => {
    const { options, run } = await fixture();
    run.mockImplementation(async (argv, request = {}) => {
      if (argv[0] === 'python3' && !request.stdin) return { code: 0, stdout: '/workspace/Gemfile\n', stderr: '' };
      return { code: 0, stdout: 'available through bundle\n', stderr: '' };
    });
    expect(await inspectCocoaPods(options.executor, { directory: '/workspace/ios/App', rootDirectory: '/workspace' })).toMatchObject({ ready: true });
    const probes = run.mock.calls.filter(([, request]) => request?.stdin).map(([, request]) => JSON.parse(request!.stdin!));
    expect(probes).toHaveLength(3);
    expect(probes[0]).toMatchObject({ gemfile: '/workspace/Gemfile', directory: '/workspace/ios/App', argv: ['ruby', '-S', 'bundle', 'exec', 'pod', '--version', '--allow-root'] });
    expect(probes[1].argv).toEqual(['ruby', '-S', 'bundle', 'exec', 'ruby', '-rxcodeproj', '-e', 'puts Xcodeproj::VERSION']);
    expect(run.mock.calls.some(([argv]) => argv[0] === 'pod')).toBe(false);
  });

  it('syncs an isolated mirror, exports the real graph, and leaves the original Podfile and lock untouched', async () => {
    const { root, options, project, run } = await fixture();
    const before = await readFile(path.join(root, 'ios', 'App', 'Podfile.lock'), 'utf8');
    const result = await prepareCocoaPodsProject(project, { ...options, configuration: 'Staging', liveUrl: 'http://192.168.1.8:5173', rubyPath: '/opt/ruby/bin/ruby', podPath: '/opt/ruby/bin/pod' }, silentContext(), new AbortController().signal);
    expect(result.graph.configuration).toBe('Staging');
    expect(result.signing).toEqual(options.signing);
    const requests = run.mock.calls.filter(([, value]) => value?.stdin).map(([, value]) => JSON.parse(value!.stdin!));
    expect(requests.map((request) => request.phase)).toEqual(process.platform === 'win32' ? ['resolve'] : ['mirror', 'resolve']);
    const resolved = requests.at(-1);
    expect(resolved).toMatchObject({ source: root, podRelative: 'ios/App', configuration: 'Staging', liveUrl: 'http://192.168.1.8:5173', explicitPodPath: true });
    expect(resolved.workspace).toContain(options.directory);
    expect(resolved).not.toHaveProperty('signing');
    expect(mocks.execFile).toHaveBeenCalledOnce();
    expect(mocks.execFile.mock.calls[0]![2].cwd).toBe(resolved.workspace);
    expect(await readFile(path.join(root, 'ios', 'App', 'Podfile.lock'), 'utf8')).toBe(before);
    expect(await readFile(path.join(root, 'ios', 'App', 'Podfile'), 'utf8')).toBe("target 'App' do\nend\n");
  });

  it.skipIf(process.platform !== 'win32')('copies writable dependency links and incrementally removes deleted inputs without mutating the source', async () => {
    const { root, options, project } = await fixture();
    const plugin = path.join(root, 'plugins', 'fixture');
    await mkdir(plugin, { recursive: true }); await writeFile(path.join(plugin, 'source.swift'), '// original');
    await symlink(plugin, path.join(root, 'node_modules', 'fixture-plugin'), 'junction');
    await writeFile(path.join(root, 'removed.swift'), '// removed later');
    const first = await mirrorWslWorkspace(project, options.directory, options.executor, new AbortController().signal);
    const copied = path.join(first.workspace, 'node_modules', 'fixture-plugin', 'source.swift');
    await writeFile(copied, '// prepare_command mutated isolated copy');
    expect(await readFile(path.join(plugin, 'source.swift'), 'utf8')).toBe('// original');
    await rm(path.join(root, 'removed.swift'));
    await mirrorWslWorkspace(project, options.directory, options.executor, new AbortController().signal);
    expect(await readFile(copied, 'utf8')).toBe('// original');
    await expect(readFile(path.join(first.workspace, 'removed.swift'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(first.workspace, '.capmac-pods-workspace'), 'other source');
    await expect(mirrorWslWorkspace(project, options.directory, options.executor, new AbortController().signal)).rejects.toThrow('belongs to another');
  });

  it('finds custom platform layouts and rejects ambiguous Podfiles', async () => {
    const { root, project } = await fixture();
    expect(await findCocoaPodsDirectory(project)).toBe(path.join(root, 'ios', 'App'));
    await mkdir(path.join(root, 'ios', 'SecondApp'));
    await writeFile(path.join(root, 'ios', 'SecondApp', 'Podfile'), '');
    await expect(findCocoaPodsDirectory(project)).rejects.toThrow('multiple Podfiles');
  });

  it('does not evaluate a Podfile outside the mirrored workspace', async () => {
    const { project, options, run } = await fixture();
    project.syncRoot = path.join(project.capDir, 'unrelated');
    await expect(prepareCocoaPodsProject(project, options, silentContext(), new AbortController().signal)).rejects.toThrow('outside the project sync root');
    expect(run).not.toHaveBeenCalled();
  });
});

// Opt-in Linux evidence: no SDK, Swift, Mac, or network pod source is needed.
// Install gems in a disposable Ruby container, then set its name here.
const container = process.env.CAPMAC_PODS_TEST_CONTAINER;
describe.skipIf(!container)('actual CocoaPods on Linux', () => {
  it('resolves transitive C++/Objective-C/Swift pods, resources, hooks and xcconfigs through real CocoaPods', async () => {
    const exporter = await readFile(new URL('../../packages/core/src/engine/wsl/pods-export.rb', import.meta.url), 'utf8');
    const script = String.raw`
require 'fileutils'; require 'tmpdir'; require 'json'; require 'xcodeproj'; require 'cocoapods'
Dir.mktmpdir('capmac-pods-evidence') do |root|
  app = File.join(root,'ios','App'); FileUtils.mkdir_p(File.join(app,'App','public'))
  File.write(File.join(app,'App','AppDelegate.swift'), 'import UIKit')
  File.write(File.join(app,'App','CustomNative.swift'), 'let preserved = true')
  File.write(File.join(app,'App','capacitor.config.json'), JSON.generate('appId'=>'com.example.test','packageClassList'=>['CustomPlugin']))
  File.write(File.join(app,'App','public','index.html'), '<html>app</html>')
  Xcodeproj::Plist.write_to_path({'CFBundleIdentifier'=>'$(PRODUCT_BUNDLE_IDENTIFIER)','NSCameraUsageDescription'=>'Preserve me'},File.join(app,'App','Info.plist'))
  project = Xcodeproj::Project.new(File.join(app,'App.xcodeproj'))
  target = project.new_target(:application,'App',:ios,'15.0')
  target.source_build_phase.add_file_reference(project.main_group.new_file('App/AppDelegate.swift'))
  target.source_build_phase.add_file_reference(project.main_group.new_file('App/CustomNative.swift'))
  ['App/public','App/capacitor.config.json'].each { |file| target.resources_build_phase.add_file_reference(project.main_group.new_file(file)) }
  target.build_configurations.each { |c| c.build_settings['INFOPLIST_FILE']='App/Info.plist'; c.build_settings['PRODUCT_BUNDLE_IDENTIFIER']='com.example.test' }
  project.save
  scheme = Xcodeproj::XCScheme.new; scheme.add_build_target(target); scheme.save_as(project.path,'Development',true)
  ['MixedKit','TransitiveC'].each do |name|
    dir=File.join(root,'node_modules',name); FileUtils.mkdir_p(dir)
    File.write(File.join(dir,'License'), 'MIT')
    File.write(File.join(dir,name+'.h'),'void native_function(void);')
    File.write(File.join(dir,name+'.m'),'void native_function(void) {}')
    File.write(File.join(dir,name+'.swift'),'public struct SwiftPlugin {}') if name=='MixedKit'
    File.write(File.join(dir,'Engine.cpp'),'int engine() { return 42; }') if name=='TransitiveC'
    File.write(File.join(dir,'PrivacyInfo.xcprivacy'),'<?xml version="1.0"?><plist version="1.0"><dict/></plist>')
    spec = Pod::Spec.new do |s|
      s.name=name; s.version='1.2.3'; s.summary='Linux graph export evidence'; s.homepage='https://example.test'; s.license={:type=>'MIT',:file=>'License'}
      s.author={'Test'=>'test@example.test'}; s.source={:git=>'https://example.test/unused.git'}; s.ios.deployment_target='15.0'
      s.source_files='*.{h,m,swift,cpp}'; s.public_header_files='*.h'; s.resource_bundles={name+'Resources'=>['PrivacyInfo.xcprivacy']}
      s.swift_version='5.0'; s.pod_target_xcconfig={'GCC_PREPROCESSOR_DEFINITIONS'=>'$(inherited) POD_SETTING=1','CLANG_CXX_LANGUAGE_STANDARD'=>'c++17'}
      s.dependency 'TransitiveC', '= 1.2.3' if name=='MixedKit'
    end
    File.write(File.join(dir,name+'.podspec.json'),spec.to_pretty_json)
  end
  File.write(File.join(app,'Podfile'), "platform :ios, '15.0'\nuse_frameworks!\ntarget 'App' do\n pod 'MixedKit', :path => '../../node_modules/MixedKit'\n pod 'TransitiveC', :path => '../../node_modules/TransitiveC'\nend\npost_install do |installer|\n installer.pods_project.targets.each do |t|\n t.build_configurations.each { |c| c.build_settings['CAPMAC_POST_INSTALL'] = 'preserved' }\n end\nend\n")
  Dir.chdir(app) do
    Pod::Config.instance.installation_root=Pathname.new(app)
    Pod::Command.run(['install','--allow-root'])
    before=File.read('Podfile.lock'); Pod::Command.run(['install','--deployment','--allow-root']); raise 'Lockfile changed' unless File.read('Podfile.lock')==before
  end
  eval(EXPORTER,TOPLEVEL_BINDING,'pods-export.rb')
  graph=CapMacPods.export('projectRoot'=>root,'podDirectory'=>app,'configuration'=>'Debug','sdkPath'=>'/sdk/iPhoneOS.sdk','scheme'=>'Development','liveUrl'=>'http://192.168.1.8:5173','xcodeVersion'=>'16.1.2')
  begin
    CapMacPods.export('projectRoot'=>root,'podDirectory'=>app,'configuration'=>'Debug','sdkPath'=>'/sdk/iPhoneOS.sdk','scheme'=>'DoesNotExist')
    raise 'An unknown explicit scheme was silently accepted'
  rescue RuntimeError => error
    raise unless error.message.include?('Unknown or ambiguous application scheme')
  end
  puts 'CAPMAC_GRAPH='+JSON.generate(graph)
  puts 'CAPMAC_CONFIG='+JSON.generate(JSON.parse(File.read(File.join(app,'App','capacitor.config.json'))))
  puts 'CAPMAC_PLIST='+JSON.generate(Xcodeproj::Plist.read_from_path(File.join(app,'App','Info.plist')))
end
`.replace('EXPORTER', `${JSON.stringify(Buffer.from(exporter).toString('base64'))}.unpack1('m0')`);
    const output = execFileSync('docker', ['exec', '-i', container!, 'ruby', '-'], { input: script, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const graph = JSON.parse(output.split('\n').find((line) => line.startsWith('CAPMAC_GRAPH='))!.slice('CAPMAC_GRAPH='.length));
    const app = graph.targets.find((target: { name: string }) => target.name === 'App');
    const mixed = graph.targets.find((target: { name: string }) => target.name === 'MixedKit');
    const transitive = graph.targets.find((target: { name: string }) => target.name === 'TransitiveC');
    expect(app.sourceFiles.some((source: { path: string }) => source.path.endsWith('CustomNative.swift'))).toBe(true);
    expect(mixed.settings.CAPMAC_POST_INSTALL).toBe('preserved');
    expect(mixed.sourceFiles.map((source: { path: string }) => path.extname(source.path))).toEqual(expect.arrayContaining(['.swift', '.m']));
    expect(transitive.sourceFiles.some((source: { path: string }) => source.path.endsWith('Engine.cpp'))).toBe(true);
    expect(transitive.settings.GCC_PREPROCESSOR_DEFINITIONS).toContain('POD_SETTING=1');
    expect(mixed.dependencies).toContain(transitive.id);
    expect(mixed.resources.some((resource: { source: string }) => resource.source.includes('/MixedKit/MixedKitResources.bundle'))).toBe(true);
    expect(mixed.settings.PODS_DEVELOPMENT_LANGUAGE).toBe('en');
    expect(app.dependencies.length).toBeGreaterThan(0);
    expect(app.settings).toMatchObject({ XCODE_VERSION_ACTUAL: '1612', XCODE_VERSION_MAJOR: '1600', XCODE_VERSION_MINOR: '1610' });
    const systemFrameworks = graph.targets.flatMap((target: { frameworks: { path?: string }[] }) => target.frameworks).map((framework: { path?: string }) => framework.path);
    expect(systemFrameworks).toContain('/sdk/iPhoneOS.sdk/System/Library/Frameworks/Foundation.framework');
    expect(systemFrameworks.some((location: string | undefined) => location?.includes('DEVELOPER_DIR'))).toBe(false);
    expect(graph.targets.some((target: { productType: string }) => target.productType === 'bundle')).toBe(true);
    expect(app.scripts.some((phase: { name: string }) => phase.name === '[CP] Check Pods Manifest.lock')).toBe(true);
    const config = JSON.parse(output.split('\n').find((line) => line.startsWith('CAPMAC_CONFIG='))!.slice('CAPMAC_CONFIG='.length));
    expect(config.packageClassList).toEqual(['CustomPlugin']);
    expect(config.server.url).toBe('http://192.168.1.8:5173');
    const info = JSON.parse(output.split('\n').find((line) => line.startsWith('CAPMAC_PLIST='))!.slice('CAPMAC_PLIST='.length));
    expect(info.NSCameraUsageDescription).toBe('Preserve me');
    expect(info.NSAppTransportSecurity.NSAllowsLocalNetworking).toBe(true);
  }, 120_000);
});
