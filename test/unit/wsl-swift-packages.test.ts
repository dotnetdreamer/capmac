import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import plist from 'plist';
import { SWIFT_PACKAGE_IMPORT } from '../../packages/core/src/engine/wsl/swift-packages.js';
import { WslExecutor } from '../../packages/core/src/engine/wsl/toolchain.js';

const temporary: string[] = [];
const python = process.platform === 'win32' ? 'python' : 'python3';
afterEach(async () => { await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capmac-swift-packages-')); temporary.push(root);
  const put = async (relative: string, text: string) => { const filename = path.join(root, relative); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, text); };
  // This executable supplies evaluated manifest fixtures. A separate opt-in
  // integration test exercises Swift's real Package.swift evaluation.
  await put('package', 'import json,pathlib,sys\nroot=pathlib.Path(sys.argv[sys.argv.index("--package-path")+1]); print((root/"manifest.json").read_text())\n');
  await put('Root/Package.swift', '// manifest fixture');
  await put('Root/Sources/RootLibrary/Root.swift', 'import Foundation\npublic func resource() -> Bundle { .module }');
  await put('Root/Sources/RootLibrary/Assets/value.json', '{"value":42}');
  await put('Clang/Package.swift', '// manifest fixture');
  await put('Clang/Sources/CLogic/include/CLogic.h', 'int answer(void);');
  await put('Clang/Sources/CLogic/answer.c', '#include "CLogic.h"\nint answer(void) { return 42; }');
  const rootManifest: Record<string, any> = { name: 'RootPackage', toolsVersion: { _version: '5.9.0' }, dependencies: [{ fileSystem: [{ identity: 'clang', path: path.join(root, 'Clang') }] }], products: [{ name: 'RootProduct', targets: ['RootLibrary'] }], targets: [
    { name: 'RootLibrary', type: 'regular', dependencies: [{ product: ['CLogic', 'clang', null, null] }, { byName: ['WatchOnly', { platformNames: ['watchos'] }] }], resources: [{ path: 'Assets', rule: { process: {} } }], settings: [{ tool: 'swift', kind: { define: { _0: 'IPHONE_CODE' } }, condition: { platformNames: ['ios'] } }] },
    { name: 'WatchOnly', type: 'regular', path: 'nonexistent-watch-source', dependencies: [] },
  ] };
  const clangManifest = { name: 'ClangPackage', toolsVersion: { _version: '5.9.0' }, dependencies: [], products: [{ name: 'CLogic', targets: ['CLogic'] }], targets: [{ name: 'CLogic', type: 'regular', dependencies: [], publicHeadersPath: 'include', settings: [{ tool: 'c', kind: { define: { _0: 'PACKAGE_FLAG=1' } } }] }] };
  await put('Root/manifest.json', JSON.stringify(rootManifest)); await put('Clang/manifest.json', JSON.stringify(clangManifest));
  const graph = { version: 1, sdk: 'iphoneos', configuration: 'Debug', projectRoot: root, rootTargetId: 'App', swiftPackages: [{ path: path.join(root, 'Root') }], targets: [
    { id: 'App', name: 'App', productType: 'application', productName: 'App.app', moduleName: 'App', dependencies: ['Widget'], sourceFiles: [{ path: '/original/AppDelegate.swift' }], publicHeaders: [], resources: [], frameworks: [], scripts: [], settings: {}, packageProducts: [{ name: 'RootProduct', path: path.join(root, 'Root') }] },
    { id: 'Widget', name: 'HomeCard', productType: 'appExtension', productName: 'HomeCard.appex', moduleName: 'HomeCard', dependencies: [], sourceFiles: [{ path: '/original/HomeCardWidget.swift' }], publicHeaders: [], resources: [], frameworks: [], scripts: [], settings: {} },
  ] };
  const output = path.join(root, 'graph.json');
  const run = (prefix = '') => execFileSync(python, ['-c', prefix + SWIFT_PACKAGE_IMPORT], { cwd: root, input: JSON.stringify({ graph, swiftPath: python, output, generated: path.join(root, 'generated'), sdkPath: '/sdk' }), encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') }, stdio: ['pipe', 'pipe', 'pipe'] });
  return { root, put, graph, rootManifest, output, run };
}

describe('locked Swift package graph import', () => {
  it('preserves native app/widget targets and imports transitive C/Swift sources, conditions, settings and resource accessors', async () => {
    const test = await fixture(); test.run();
    const graph = JSON.parse(await readFile(test.output, 'utf8'));
    const app = graph.targets.find((target: any) => target.id === 'App');
    const swift = graph.targets.find((target: any) => target.name === 'RootLibrary');
    const clang = graph.targets.find((target: any) => target.name === 'CLogic');
    expect(app.sourceFiles).toEqual([{ path: '/original/AppDelegate.swift' }]);
    expect(graph.targets.find((target: any) => target.id === 'Widget').sourceFiles).toEqual([{ path: '/original/HomeCardWidget.swift' }]);
    expect(graph.targets.some((target: any) => target.name === 'WatchOnly')).toBe(false);
    expect(swift.dependencies).toContain(clang.id);
    expect(swift.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toEqual(['SWIFT_PACKAGE', 'DEBUG', 'IPHONE_CODE']);
    expect(clang.settings.GCC_PREPROCESSOR_DEFINITIONS).toContain('PACKAGE_FLAG=1');
    expect(clang.publicHeaders[0]).toMatch(/CLogic\.h$/);
    expect(app.frameworks.map((value: any) => value.path)).toEqual(expect.arrayContaining(['$(BUILT_PRODUCTS_DIR)/libCLogic.a', '$(BUILT_PRODUCTS_DIR)/libRootLibrary.a']));
    const accessor = swift.sourceFiles.find((source: any) => source.path.endsWith('resource_bundle_accessor.swift'));
    expect(await readFile(accessor.path, 'utf8')).toContain('RootPackage_RootLibrary.bundle');
    expect(graph.targets.find((target: any) => target.productName === 'RootPackage_RootLibrary.bundle').resources[0].source).toMatch(/value\.json$/);
  });

  it('rejects an unlocked remote dependency without resolving a new version or changing source manifests', async () => {
    const test = await fixture();
    const manifest = { ...test.rootManifest, dependencies: [{ sourceControl: [{ identity: 'missing', location: { remote: [{ urlString: 'https://example.invalid/missing.git' }] }, requirement: { range: [{ lowerBound: '1.0.0', upperBound: '2.0.0' }] } }] }], targets: [{ ...test.rootManifest.targets[0], dependencies: [{ product: ['MissingProduct', 'missing', null, null] }] }] };
    const source = JSON.stringify(manifest); await test.put('Root/manifest.json', source);
    expect(() => test.run()).toThrow(/no exact revision for missing/);
    expect(await readFile(path.join(test.root, 'Root', 'manifest.json'), 'utf8')).toBe(source);
  });

  it('selects an actual physical-device XCFramework and adds compile/link search paths for binary dependencies', async () => {
    const test = await fixture();
    const framework = 'Root/Framework.xcframework';
    await test.put(`${framework}/Info.plist`, plist.build({ AvailableLibraries: [
      { LibraryIdentifier: 'ios-arm64', LibraryPath: 'Framework.framework', SupportedPlatform: 'ios', SupportedArchitectures: ['arm64'] },
      { LibraryIdentifier: 'ios-arm64-simulator', LibraryPath: 'Framework.framework', SupportedPlatform: 'ios', SupportedPlatformVariant: 'simulator', SupportedArchitectures: ['arm64'] },
    ] }));
    await test.put(`${framework}/ios-arm64/Framework.framework/Framework`, 'device binary');
    test.rootManifest.targets[0]!.dependencies.push({ byName: ['Framework', null] } as any);
    test.rootManifest.targets.push({ name: 'Framework', type: 'binary', path: 'Framework.xcframework', dependencies: [] } as any);
    await test.put('Root/manifest.json', JSON.stringify(test.rootManifest)); test.run();
    const graph = JSON.parse(await readFile(test.output, 'utf8')); const app = graph.targets.find((target: any) => target.id === 'App');
    expect(app.frameworks.some((value: any) => value.path.replace(/\\/g, '/').endsWith('/ios-arm64/Framework.framework'))).toBe(true);
    expect(app.settings.FRAMEWORK_SEARCH_PATHS.some((value: string) => value.replace(/\\/g, '/').endsWith('/ios-arm64'))).toBe(true);
  });

  it('rejects a downloaded binary whose bytes do not match the manifest checksum', async () => {
    const test = await fixture();
    const expected = createHash('sha256').update('expected archive').digest('hex');
    test.rootManifest.targets[0]!.dependencies.push({ byName: ['Framework', null] } as any);
    test.rootManifest.targets.push({ name: 'Framework', type: 'binary', url: 'https://example.invalid/Framework.zip', checksum: expected, dependencies: [] } as any);
    await test.put('Root/manifest.json', JSON.stringify(test.rootManifest));
    expect(() => test.run('import io,urllib.request\nurllib.request.urlopen=lambda *args,**kwargs: io.BytesIO(b"tampered archive")\n')).toThrow(/Binary checksum mismatch/);
  });

  it('reports an unavailable locked binary with its exact checksum and cache path without substituting a release', async () => {
    const test = await fixture();
    const expected = createHash('sha256').update('original archive').digest('hex');
    test.rootManifest.targets[0]!.dependencies.push({ byName: ['Framework', null] } as any);
    test.rootManifest.targets.push({ name: 'Framework', type: 'binary', url: 'https://example.invalid/deleted.zip', checksum: expected, dependencies: [] } as any);
    await test.put('Root/manifest.json', JSON.stringify(test.rootManifest));
    const unavailable = 'import urllib.request,urllib.error\ndef unavailable(url,*args,**kwargs): raise urllib.error.HTTPError(url,404,"Not Found",None,None)\nurllib.request.urlopen=unavailable\n';
    expect(() => test.run(unavailable)).toThrow(new RegExp('Cannot download locked binary Framework.*'+expected+'.*will not be upgraded or substituted'));
    await expect(readFile(test.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!process.env.CAPMAC_SWIFT_TEST_DISTRO)('evaluates actual Swift manifests in WSL and imports their resource/C target graph', async () => {
    const test = await fixture();
    const executor = new WslExecutor(process.env.CAPMAC_SWIFT_TEST_DISTRO!);
    const root = await executor.path(test.root);
    await test.put('Root/Package.swift', `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "RootPackage", platforms: [.iOS(.v15)], products: [.library(name: "RootProduct", targets: ["RootLibrary"])], dependencies: [.package(path: "../Clang")], targets: [.target(name: "RootLibrary", dependencies: [.product(name: "CLogic", package: "Clang")], resources: [.process("Assets")], swiftSettings: [.define("IPHONE_CODE", .when(platforms: [.iOS]))])])
`);
    await test.put('Clang/Package.swift', `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "ClangPackage", products: [.library(name: "CLogic", targets: ["CLogic"])], targets: [.target(name: "CLogic", publicHeadersPath: "include", cSettings: [.define("PACKAGE_FLAG", to: "1")])])
`);
    test.graph.projectRoot = root;
    test.graph.swiftPackages[0]!.path = root + '/Root';
    test.graph.targets[0]!.packageProducts![0]!.path = root + '/Root';
    await executor.run(['python3', '-c', SWIFT_PACKAGE_IMPORT], {
      stdin: JSON.stringify({ graph: test.graph, swiftPath: process.env.CAPMAC_SWIFT_TEST_EXECUTABLE ?? 'swift', output: root + '/graph.json', generated: root + '/generated', sdkPath: '/sdk' }),
      timeoutMs: 120_000,
    });
    const graph = JSON.parse(await readFile(test.output, 'utf8'));
    const swift = graph.targets.find((target: any) => target.name === 'RootLibrary');
    expect(swift.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toContain('IPHONE_CODE');
    expect(swift.sourceFiles.some((file: any) => file.path.endsWith('resource_bundle_accessor.swift'))).toBe(true);
    expect(graph.targets.find((target: any) => target.name === 'CLogic').settings.GCC_PREPROCESSOR_DEFINITIONS).toContain('PACKAGE_FLAG=1');
    expect(graph.targets.find((target: any) => target.name === 'HomeCard').productType).toBe('appExtension');
  }, 120_000);
});
