import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';
import { afterEach, describe, expect, it } from 'vitest';
import { silentContext } from '../../packages/core/src/engine/context.js';
import type { ProjectInfo } from '../../packages/core/src/engine/project.js';
import { capacitorHostSource, capacitorIosVersion, developmentInfoPlist, discoverCapacitorPlugins, prepareCapacitorPlan } from '../../packages/core/src/engine/wsl/capacitor.js';

const directories: string[] = [];
const manifest = `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: "CapacitorDevice", platforms: [.iOS(.v15)],
  products: [.library(name: "CapacitorDevice", targets: ["DevicePlugin"])],
  dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")],
  targets: [
    .target(name: "DevicePlugin", dependencies: [
      .product(name: "Capacitor", package: "capacitor-swift-pm"),
      .product(name: "Cordova", package: "capacitor-swift-pm")
    ], path: "ios/Sources/DevicePlugin"),
    .testTarget(name: "DevicePluginTests", dependencies: ["DevicePlugin"], path: "ios/Tests/DevicePluginTests")
  ]
)
`;
const nativePlugin = `import Capacitor
@objc(DevicePlugin)
public class DevicePlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "DevicePlugin"
  public let jsName = "Device"
  public let pluginMethods: [CAPPluginMethod] = []
}
`;
const info = {
  CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)', CFBundleExecutable: '$(EXECUTABLE_NAME)',
  CFBundleName: '$(PRODUCT_NAME)', CFBundleShortVersionString: '$(MARKETING_VERSION)',
  CFBundleVersion: '$(CURRENT_PROJECT_VERSION)', CAPACITOR_DEBUG: '$(CAPACITOR_DEBUG)',
  UIMainStoryboardFile: 'Main', UILaunchStoryboardName: 'LaunchScreen',
  NSCameraUsageDescription: 'Scan a development QR code.', NSLocationWhenInUseUsageDescription: 'Show the nearby location.',
  UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'],
  'UISupportedInterfaceOrientations~ipad': ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  CFBundleURLTypes: [{ CFBundleURLSchemes: ['capmac-test'] }],
  UIApplicationSceneManifest: { UISceneConfigurations: { UIWindowSceneSessionRoleApplication: [{ UISceneStoryboardFile: 'Main' }] } },
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createProject(): Promise<ProjectInfo> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capmac-capacitor-'));
  directories.push(root);
  const project: ProjectInfo = {
    kind: 'capacitor', capDir: root, configFile: path.join(root, 'capacitor.config.json'), syncRoot: root,
    projectRel: '', appId: 'com.example.capmac', appName: 'Fixture app', webDir: 'dist', iosDir: 'ios',
    scheme: 'App', iosPackageManager: 'SPM', hasIos: true, packageManager: 'npm', projectId: 'fixture',
    config: {}, scripts: {}, electron: null,
  };
  await mkdir(path.join(root, 'ios', 'App', 'App'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: {} })),
    writeFile(project.configFile, JSON.stringify({ appId: project.appId, appName: project.appName, webDir: project.webDir })),
    writeFile(path.join(root, 'dist', 'index.html'), '<html><body>Hello</body></html>'),
    writeFile(path.join(root, 'ios', 'App', 'App', 'Info.plist'), plist.build(info)),
    writeFile(path.join(root, 'ios', 'App', 'App', 'AppDelegate.swift'), 'import UIKit\nimport Capacitor\n@main class AppDelegate: UIResponder, UIApplicationDelegate {\n func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool { return true }\n}\n'),
  ]);
  return project;
}

async function addPlugin(project: ProjectInfo, options: { manifest?: string; source?: string; metadata?: Record<string, unknown>; extra?: string } = {}): Promise<string> {
  const pluginRoot = path.join(project.capDir, 'node_modules', '@capacitor', 'device');
  const sourceRoot = path.join(pluginRoot, 'ios', 'Sources', 'DevicePlugin');
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(project.capDir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { '@capacitor/device': '^8.0.0' } })),
    writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: '@capacitor/device', version: '8.0.3', capacitor: { ios: { src: 'ios' } }, ...options.metadata })),
    writeFile(path.join(pluginRoot, 'Package.swift'), options.manifest ?? manifest),
    writeFile(path.join(sourceRoot, 'DevicePlugin.swift'), options.source ?? nativePlugin),
  ]);
  if (options.extra) await writeFile(path.join(sourceRoot, options.extra), 'fixture resource');
  return pluginRoot;
}

const planOptions = (project: ProjectInfo) => ({
  directory: path.join(project.capDir, '.capmac', 'generated'), outputDirectory: path.join(project.capDir, '.capmac', 'build'),
  frameworks: [], signing: { certificatePath: path.join(project.capDir, 'developer.p12'), password: 'password', provisioningProfilePath: path.join(project.capDir, 'profile.mobileprovision') },
});
const prepare = (project: ProjectInfo, overrides = {}) => prepareCapacitorPlan(project, { ...planOptions(project), ...overrides }, silentContext(), new AbortController().signal);

describe('generated Capacitor application host', () => {
  it('imports the actual plugin module and explicitly registers every discovered native class', () => {
    const source = capacitorHostSource([{ packageName: '@capacitor/device', module: 'DevicePlugin', sources: [], classes: ['DevicePlugin', 'SecondPlugin'] }]);
    expect(source).toContain('import DevicePlugin');
    expect(source).toContain('bridge?.registerPluginInstance(DevicePlugin())');
    expect(source).toContain('bridge?.registerPluginInstance(SecondPlugin())');
    expect(source).not.toContain('DevicePlugin.DevicePlugin()');
    expect(source).toContain('window.rootViewController = CapMacViewController()');
    expect(source).toContain('SceneDelegateProxy.shared.scene');
  });

  it('preserves privacy text, orientations, and URL schemes while replacing storyboard startup', () => {
    const xml = developmentInfoPlist(plist.build(info), { appId: 'com.example.real', appName: 'Real application' }, false);
    const parsed = plist.parse(xml) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      CFBundleIdentifier: 'com.example.real', CFBundleDisplayName: 'Real application', CFBundleExecutable: 'App',
      NSCameraUsageDescription: info.NSCameraUsageDescription, NSLocationWhenInUseUsageDescription: info.NSLocationWhenInUseUsageDescription,
      UISupportedInterfaceOrientations: info.UISupportedInterfaceOrientations,
      'UISupportedInterfaceOrientations~ipad': info['UISupportedInterfaceOrientations~ipad'],
      CFBundleURLTypes: info.CFBundleURLTypes, UIRequiredDeviceCapabilities: ['arm64'], UILaunchScreen: {},
    });
    expect(parsed).not.toHaveProperty('UIMainStoryboardFile');
    expect(parsed).not.toHaveProperty('UILaunchStoryboardName');
    expect(xml).not.toContain('UISceneStoryboardFile');
    expect(xml).not.toContain('$(');
  });

  it('adds local networking only for live development and preserves existing ATS exceptions', () => {
    const source = plist.build({ ...info, NSAppTransportSecurity: { NSExceptionDomains: { 'dev.example.test': { NSIncludesSubdomains: true } } } });
    const standalone = plist.parse(developmentInfoPlist(source, { appId: 'com.example.app', appName: 'App' }, false)) as Record<string, unknown>;
    expect(standalone).not.toHaveProperty('NSLocalNetworkUsageDescription');
    const live = plist.parse(developmentInfoPlist(source, { appId: 'com.example.app', appName: 'App' }, true)) as Record<string, unknown>;
    expect(live).toHaveProperty('NSLocalNetworkUsageDescription');
    expect(live.NSAppTransportSecurity).toMatchObject({ NSAllowsLocalNetworking: true, NSAllowsArbitraryLoadsInWebContent: true, NSExceptionDomains: { 'dev.example.test': { NSIncludesSubdomains: true } } });
  });

  it('rejects unresolved custom Xcode variables instead of shipping broken configuration', () => {
    expect(() => developmentInfoPlist(plist.build({ ...info, NSCameraUsageDescription: '$(CUSTOM_CAMERA_PERMISSION)' }), { appId: 'com.example.app', appName: 'App' }, false)).toThrow('unsupported Xcode build variable');
  });

  it.each([
    ['debug', false, false, 'true'],
    ['live', true, false, 'true'],
    ['Release', false, true, 'false'],
    ['live Release', true, true, 'true'],
  ])('uses the exact Capacitor debug string for %s', (_mode, live, release, expected) => {
    const parsed = plist.parse(developmentInfoPlist(plist.build(info), { appId: 'com.example.app', appName: 'App' }, live, release)) as Record<string, unknown>;
    expect(parsed.CAPACITOR_DEBUG).toBe(expected);
  });
});

describe('supported Swift Capacitor plugin subset', () => {
  it('accepts the official Device-shaped package without compiling its tests', async () => {
    const project = await createProject();
    const root = await addPlugin(project);
    const plugins = await discoverCapacitorPlugins(project);
    expect(plugins).toEqual([{ packageName: '@capacitor/device', module: 'DevicePlugin', classes: ['DevicePlugin'], sources: [path.join(root, 'ios', 'Sources', 'DevicePlugin', 'DevicePlugin.swift')] }]);
  });

  it('accepts ordinary Swift whitespace between target and its opening parenthesis', async () => {
    const project = await createProject();
    await addPlugin(project, { manifest: manifest.replace('.target(', '.target \n(') });
    expect(await discoverCapacitorPlugins(project)).toMatchObject([{ module: 'DevicePlugin', classes: ['DevicePlugin'] }]);
  });

  it('rejects ambiguous native class names imported from two different plugin modules', async () => {
    const project = await createProject();
    await addPlugin(project);
    const otherRoot = path.join(project.capDir, 'node_modules', '@custom', 'other-plugin');
    const otherSources = path.join(otherRoot, 'ios', 'Sources', 'OtherPluginModule');
    await mkdir(otherSources, { recursive: true });
    await Promise.all([
      writeFile(path.join(project.capDir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { '@capacitor/device': '^8.0.0', '@custom/other-plugin': '^1.0.0' } })),
      writeFile(path.join(otherRoot, 'package.json'), JSON.stringify({ name: '@custom/other-plugin', capacitor: { ios: { src: 'ios' } } })),
      writeFile(path.join(otherRoot, 'Package.swift'), manifest.replaceAll('DevicePlugin', 'OtherPluginModule')),
      writeFile(path.join(otherSources, 'OtherPlugin.swift'), nativePlugin),
    ]);
    await expect(discoverCapacitorPlugins(project)).rejects.toMatchObject({ message: expect.stringContaining('same Swift module or class name') });
  });

  it.each([
    ['custom resource file', { extra: 'data.json' }],
    ['resource bundle', { manifest: manifest.replace('path: "ios/Sources/DevicePlugin"', 'path: "ios/Sources/DevicePlugin", resources: [.process("Resources")]') }],
    ['Objective-C source', { extra: 'Native.m' }],
    ['external native dependency', { manifest: manifest.replace('https://github.com/ionic-team/capacitor-swift-pm.git', 'https://github.com/other/native-sdk.git') }],
    ['binary target', { manifest: manifest.replace('.testTarget(', '.binaryTarget(') }],
    ['resource-bundle API', { source: `${nativePlugin}\nlet bundle = Bundle.module\n` }],
    ['Cordova plugin', { metadata: { cordova: { id: 'legacy.plugin' } } }],
    ['path escaping plugin package', { manifest: manifest.replace('path: "ios/Sources/DevicePlugin"', 'path: "../outside-package"') }],
  ])('rejects %s with an actionable compatibility error', async (_name, pluginOptions) => {
    const project = await createProject();
    await addPlugin(project, pluginOptions);
    await expect(discoverCapacitorPlugins(project)).rejects.toMatchObject({ expected: true, hint: expect.stringContaining('single-target Swift') });
  });
});

describe('Capacitor build plan preparation', () => {
  it('packages web assets, generated config, privacy manifest, and native plugin registration', async () => {
    const project = await createProject();
    await addPlugin(project);
    const privacy = path.join(project.capDir, 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy');
    await writeFile(privacy, plist.build({ NSPrivacyTracking: false }));
    const plan = await prepare(project);
    expect(plan.swiftModules).toMatchObject([{ name: 'DevicePlugin' }]);
    expect(plan.resources).toEqual(expect.arrayContaining([
      { source: path.join(project.capDir, 'dist'), destination: 'public' },
      { source: privacy, destination: 'PrivacyInfo.xcprivacy' },
    ]));
    const config = JSON.parse(await readFile(path.join(planOptions(project).directory, 'capacitor.config.json'), 'utf8'));
    expect(config.packageClassList).toEqual([]);
    expect(config.server).toBeUndefined();
    expect(await readFile(plan.sourceFiles[0]!, 'utf8')).toContain('registerPluginInstance(DevicePlugin())');
  });

  it('accepts the standard sample SceneDelegate without dropping custom native behavior', async () => {
    const project = await createProject();
    const standard = await readFile(new URL('../../examples/hello-capacitor/ios/App/App/SceneDelegate.swift', import.meta.url), 'utf8');
    await writeFile(path.join(project.capDir, 'ios', 'App', 'App', 'SceneDelegate.swift'), standard);
    await expect(prepare(project)).resolves.toMatchObject({ bundleIdentifier: project.appId });
  });

  it('rejects additional native configuration resources instead of silently omitting them', async () => {
    const project = await createProject();
    await writeFile(path.join(project.capDir, 'ios', 'App', 'App', 'GoogleService-Info.plist'), plist.build({ CLIENT_ID: 'custom-client' }));
    await expect(prepare(project)).rejects.toMatchObject({ message: 'This project has custom native application resources.', details: ['GoogleService-Info.plist'] });
  });

  it('rejects a standalone build that would still depend on a development server', async () => {
    const project = await createProject();
    await writeFile(project.configFile, JSON.stringify({ appId: project.appId, server: { url: 'http://192.168.1.5:5173' } }));
    await expect(prepare(project)).rejects.toMatchObject({ message: expect.stringContaining('development server'), hint: expect.stringContaining('Remove server.url') });
  });

  it('overrides the server URL in generated live config without modifying project config', async () => {
    const project = await createProject();
    const original = await readFile(project.configFile, 'utf8');
    await prepare(project, { liveUrl: 'http://192.168.1.25:5173' });
    const config = JSON.parse(await readFile(path.join(planOptions(project).directory, 'capacitor.config.json'), 'utf8'));
    expect(config.server).toEqual({ url: 'http://192.168.1.25:5173', cleartext: true });
    expect(await readFile(project.configFile, 'utf8')).toBe(original);
  });

  it.each(['CustomViewController.swift', 'CustomNative.m', 'App.entitlements'])('rejects custom native input %s', async (name) => {
    const project = await createProject();
    await writeFile(path.join(project.capDir, 'ios', 'App', 'App', name), '// custom behavior');
    await expect(prepare(project)).rejects.toThrow('custom native application code or entitlements');
  });

  it('rejects custom AppDelegate startup behavior instead of dropping it', async () => {
    const project = await createProject();
    await writeFile(path.join(project.capDir, 'ios', 'App', 'App', 'AppDelegate.swift'), 'class AppDelegate { func application(didFinishLaunchingWithOptions options: Any) -> Bool { startCustomSDK(); return true } }');
    await expect(prepare(project)).rejects.toThrow('custom startup code');
  });

  it('rejects custom SceneDelegate behavior instead of replacing it silently', async () => {
    const project = await createProject();
    await writeFile(path.join(project.capDir, 'ios', 'App', 'App', 'SceneDelegate.swift'), 'import UIKit\nclass SceneDelegate: UIResponder, UIWindowSceneDelegate { func sceneDidBecomeActive(_ scene: UIScene) { AnalyticsSDK.startSession() } }');
    await expect(prepare(project)).rejects.toThrow(/custom/i);
  });

  it('rejects custom AppDelegate lifecycle behavior even when startup only returns true', async () => {
    const project = await createProject();
    const file = path.join(project.capDir, 'ios', 'App', 'App', 'AppDelegate.swift');
    const standard = await readFile(file, 'utf8');
    await writeFile(file, `${standard}\nextension AppDelegate { func applicationDidBecomeActive(_ application: UIApplication) { AnalyticsSDK.startSession() } }\n`);
    await expect(prepare(project)).rejects.toThrow(/custom/i);
  });
});

describe('matching Capacitor bridge versions', () => {
  async function writeVersions(project: ProjectInfo, core: string, ios: string): Promise<void> {
    for (const [name, version] of [['core', core], ['ios', ios]]) {
      const root = path.join(project.capDir, 'node_modules', '@capacitor', name!);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: `@capacitor/${name}`, version }));
    }
  }

  it('accepts the supported matching native and JavaScript bridge versions', async () => {
    const project = await createProject();
    await writeVersions(project, '8.5.3', '8.5.3');
    expect(capacitorIosVersion(project)).toBe('8.5.3');
  });

  it('rejects a JavaScript/native bridge mismatch before downloading frameworks', async () => {
    const project = await createProject();
    await writeVersions(project, '8.5.3', '8.5.4');
    expect(() => capacitorIosVersion(project)).toThrow('versions do not match');
  });
});
