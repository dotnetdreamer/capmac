import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import plist from 'plist';
import { log, throwIfAborted, withStep, type EngineContext } from '../context.js';
import { UserError } from '../errors.js';
import { nodeExecutable, type ProjectInfo } from '../project.js';
import type { WslBuildPlan } from './compiler.js';
import { WslExecutor } from './toolchain.js';

export interface CapacitorPlugin {
  packageName: string;
  module: string;
  sources: string[];
  classes: string[];
}

function packageRoot(project: ProjectInfo, name: string): string {
  for (let dir = project.capDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  throw new UserError(`${name} is not installed.`, `Run ${project.packageManager} install in the project first.`);
}

async function filesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : entry.isFile() ? [path.join(dir, entry.name)] : []));
  return groups.flat().sort();
}

/** Intentionally narrow: ordinary single-target Swift plugins with Capacitor dependencies only. */
export async function discoverCapacitorPlugins(project: ProjectInfo): Promise<CapacitorPlugin[]> {
  const pkg = JSON.parse(await fs.readFile(path.join(project.capDir, 'package.json'), 'utf8'));
  const plugins: CapacitorPlugin[] = [];
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
    if (['@capacitor/core', '@capacitor/ios', '@capacitor/android', '@capacitor/cli'].includes(name)) continue;
    const root = packageRoot(project, name);
    const meta = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    if (!meta.capacitor?.ios && !meta.cordova) continue;
    const unsupported = () => new UserError(`${name} needs a native build step this WSL adapter does not support yet.`, 'The first version supports single-target Swift Capacitor plugins without external native dependencies, custom build settings, or resource bundles.');
    if (meta.cordova || !existsSync(path.join(root, 'Package.swift'))) throw unsupported();
    const manifest = (await fs.readFile(path.join(root, 'Package.swift'), 'utf8')).replace(/^\s*\/\/[^\n]*/gm, '');
    // A Package.swift is executable Swift. Accept a documented subset rather than guessing a build graph.
    if ((manifest.match(/\.target\s*\(/g)?.length ?? 0) !== 1 || /\.(binaryTarget|executableTarget|macro|plugin)\s*\(|\b(resources|swiftSettings|cSettings|cxxSettings|linkerSettings|plugins|exclude|sources)\s*:/.test(manifest)) throw unsupported();
    const urls = [...manifest.matchAll(/\.package\s*\(\s*url:\s*"([^"]+)"/g)].map((m) => m[1]!);
    if (urls.some((url) => !/^https:\/\/github\.com\/ionic-team\/capacitor-swift-pm(?:\.git)?$/.test(url)) || /\.package\s*\(\s*(?:name:|path:)/.test(manifest)) throw unsupported();
    const module = manifest.match(/\.target\s*\(\s*name:\s*"([A-Za-z_][A-Za-z0-9_]*)"/)?.[1];
    if (!module) throw unsupported();
    const target = manifest.slice(manifest.search(/\.target\s*\(/)).split('.testTarget')[0]!;
    const rel = target.match(/\bpath:\s*"([^"]+)"/)?.[1] ?? `Sources/${module}`;
    const sourceRoot = path.resolve(root, rel);
    if (!sourceRoot.startsWith(`${root}${path.sep}`)) throw unsupported();
    const files = await filesIn(sourceRoot);
    if (!files.length || files.some((file) => !file.endsWith('.swift'))) throw unsupported();
    const texts = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
    if (texts.some((text) => /\bBundle\.module\b/.test(text))) throw unsupported();
    const classes = texts.flatMap((text) => [...text.matchAll(/\bpublic\s+(?:final\s+)?class\s+(\w+)\s*:\s*CAPPlugin\b/g)].map((m) => m[1]!));
    if (!classes.length) throw unsupported();
    if (plugins.some((plugin) => plugin.module === module || plugin.classes.some((cls) => classes.includes(cls)))) throw new UserError('Two native plugins use the same Swift module or class name.', 'Use plugins with unique native names with this adapter.');
    plugins.push({ packageName: name, module, sources: files, classes });
  }
  return plugins;
}

export function capacitorHostSource(plugins: CapacitorPlugin[]): string {
  return `import UIKit
import Capacitor
${plugins.map((plugin) => `import ${plugin.module}`).join('\n')}

final class CapMacViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
${plugins.flatMap((plugin) => plugin.classes.map((cls) => `        bridge?.registerPluginInstance(${cls}())`)).join('\n')}
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool { true }
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }
    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = CapMacViewController()
        self.window = window
        window.makeKeyAndVisible()
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: contexts)
    }
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
`;
}

/** Preserve behavior by accepting only the standard, behavior-free Capacitor delegate templates. */
function validateStandardDelegate(source: string, scene: boolean): void {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  let remainder = text;
  for (const match of [...text.matchAll(/\bfunc\s+(\w+)\s*\(/g)].reverse()) {
    const start = match.index!;
    const open = text.indexOf('{', start);
    if (open < 0) throw new UserError('The native application has a custom delegate declaration.');
    let end = open + 1;
    let depth = 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === '{') depth++;
      if (text[end] === '}') depth--;
    }
    const signature = text.slice(start, open);
    const body = text.slice(open + 1, end - 1).replace(/\s+/g, '');
    let standard = body === '';
    if (!scene && match[1] === 'application') {
      if (signature.includes('didFinishLaunchingWithOptions')) standard = body === 'returntrue' || body === 'true';
      else if (signature.includes('configurationForConnecting')) standard = /^let(\w+)=UISceneConfiguration\(name:"DefaultConfiguration",sessionRole:\w+\.role\)\1\.delegateClass=SceneDelegate\.selfreturn\1$/.test(body);
      else standard = /^(?:return)?ApplicationDelegateProxy\.shared\.application\((?:app|application),(?:open:url,options:options|continue:userActivity,restorationHandler:restorationHandler)\)$/.test(body);
    }
    if (scene && match[1] === 'scene') {
      if (signature.includes('willConnectTo')) standard = /^guardletwindowScene=sceneas\?UIWindowSceneelse\{return\}window=UIWindow\(windowScene:windowScene\)window\?\.rootViewController=CAPBridgeViewController\(\)window\?\.makeKeyAndVisible\(\)SceneDelegateProxy\.shared\.scene\(scene,willConnectTo:session,options:connectionOptions\)$/.test(body);
      else standard = /^SceneDelegateProxy\.shared\.scene\(scene,(?:openURLContexts:(?:URLContexts|contexts)|continue:userActivity)\)$/.test(body);
    }
    if (!standard) throw new UserError('The native application has custom delegate behavior.', 'The WSL adapter currently supports standard Capacitor AppDelegate and SceneDelegate templates.');
    remainder = remainder.slice(0, start) + remainder.slice(end);
  }
  const name = scene ? 'SceneDelegate' : 'AppDelegate';
  const protocol = scene ? 'UIWindowSceneDelegate' : 'UIApplicationDelegate';
  const remaining = remainder.replace(/\s+/g, '').replace(/import(?:UIKit|Capacitor)/g, '').replace(/@(?:UIApplicationMain|main)/g, '')
    .replace(new RegExp(`(?:final)?class${name}:UIResponder,${protocol}\\{`), '').replace(/varwindow:UIWindow\?/g, '').replace(/\}/g, '');
  if (remaining) throw new UserError('The native application has custom delegate declarations.', 'The WSL adapter does not replace custom native initialization or extensions.');
}

type PlistDictionary = Record<string, plist.PlistValue>;
export function developmentInfoPlist(source: string, project: Pick<ProjectInfo, 'appId' | 'appName'>, live: boolean, release = false): string {
  const parsed = plist.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UserError('The application Info.plist must be an XML dictionary.');
  const info = parsed as PlistDictionary;
  delete info.UIMainStoryboardFile;
  delete info.UILaunchStoryboardName;
  delete info.CFBundleIcons;
  delete info['CFBundleIcons~ipad'];
  Object.assign(info, {
    CFBundleExecutable: 'App', CFBundleIdentifier: project.appId, CFBundleDisplayName: project.appName,
    CFBundleName: project.appName, CFBundlePackageType: 'APPL', CFBundleInfoDictionaryVersion: '6.0',
    CFBundleShortVersionString: /^\d+(?:\.\d+){0,2}$/.test(String(info.CFBundleShortVersionString)) ? info.CFBundleShortVersionString : '1.0',
    CFBundleVersion: /^\d+(?:\.\d+){0,2}$/.test(String(info.CFBundleVersion)) ? info.CFBundleVersion : '1',
    CFBundleSupportedPlatforms: ['iPhoneOS'], LSRequiresIPhoneOS: true, MinimumOSVersion: '15.0',
    CAPACITOR_DEBUG: live || !release ? 'true' : 'false',
    UIDeviceFamily: [1, 2], UIRequiredDeviceCapabilities: ['arm64'], UILaunchScreen: {},
    UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: false, UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [{ UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'CapMacApplication.SceneDelegate' }],
    } },
  });
  // Resolve remaining standard Xcode placeholders, but reject unknown ones instead of shipping broken configuration.
  if (live) {
    info.NSLocalNetworkUsageDescription ??= 'Connect to your development server for live reload.';
    info.NSAppTransportSecurity = { ...(info.NSAppTransportSecurity as PlistDictionary ?? {}), NSAllowsLocalNetworking: true, NSAllowsArbitraryLoadsInWebContent: true };
  }
  const xml = plist.build(info);
  const result = xml.replace(/\$\(PRODUCT_MODULE_NAME\)/g, 'CapMacApplication');
  if (/\$\([^)]+\)/.test(result)) throw new UserError('Info.plist contains an unsupported Xcode build variable.', 'Replace custom variables with literal development values before using this adapter.');
  return result;
}

export async function readFullCapacitorConfig(project: ProjectInfo, signal: AbortSignal): Promise<Record<string, any>> {
  if (project.configFile.endsWith('.json')) return JSON.parse(await fs.readFile(project.configFile, 'utf8'));
  const cliRoot = packageRoot(project, '@capacitor/cli');
  return new Promise((resolve, reject) => {
    execFile(nodeExecutable(), [path.join(cliRoot, 'bin', 'capacitor'), 'config', '--json'], {
      cwd: project.capDir, signal, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    }, (err, stdout) => {
      if (err) return reject(new UserError('Could not evaluate the Capacitor configuration.', 'Check that the project dependencies are installed and `npx cap config --json` succeeds.'));
      try {
        let json;
        try { json = JSON.parse(stdout); }
        catch { json = JSON.parse(stdout.split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{') && line.trim().endsWith('}')) ?? ''); }
        if (!json.app?.extConfig) throw new Error('No evaluated config');
        resolve(json.app.extConfig);
      } catch { reject(new UserError('The Capacitor CLI did not return an evaluated configuration.')); }
    });
  });
}

const EXTRACT_ZIP = `import pathlib,sys,zipfile,stat
root=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as z:
 for item in z.infolist():
  target=(root/item.filename).resolve()
  if not target.is_relative_to(root) or stat.S_ISLNK(item.external_attr >> 16): raise ValueError("Unsafe framework archive")
 z.extractall(root)
`;

/** Official version-pinned artifacts, checked against the upstream SwiftPM manifest. */
export async function capacitorFrameworks(version: string, cache: string, executor: WslExecutor, ctx: EngineContext, signal: AbortSignal): Promise<Array<{ path: string }>> {
  if (!/^8\.\d+\.\d+$/.test(version)) throw new UserError(`Capacitor ${version} is not supported by the first WSL adapter.`, 'This adapter currently supports Capacitor 8 binary frameworks.');
  const manifestResponse = await fetch(`https://raw.githubusercontent.com/ionic-team/capacitor-swift-pm/${version}/Package.swift`, { signal });
  if (!manifestResponse.ok) throw new UserError(`The Capacitor ${version} binary release is unavailable.`, 'Use a published Capacitor 8 release with matching @capacitor/core and @capacitor/ios versions.');
  const manifest = await manifestResponse.text();
  const frameworks: Array<{ path: string }> = [];
  for (const name of ['Capacitor', 'Cordova']) {
    throwIfAborted(signal);
    const record = [...manifest.matchAll(/\.binaryTarget\s*\(\s*name:\s*"([^"]+)"\s*,\s*url:\s*"([^"]+)"\s*,\s*checksum:\s*"([a-f0-9]{64})"/g)].find((m) => m[1] === name);
    const expectedUrl = `https://github.com/ionic-team/capacitor-swift-pm/releases/download/${version}/${name}.xcframework.zip`;
    if (!record || record[2] !== expectedUrl) throw new UserError(`Cannot verify the ${name} framework release manifest.`);
    const dir = path.join(cache, version, name);
    const archive = `${dir}.zip`;
    await fs.mkdir(path.dirname(archive), { recursive: true });
    let bytes: Buffer | undefined;
    try { bytes = await fs.readFile(archive); } catch { /* Download missing artifacts. */ }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== record[3]) {
      await withStep(ctx, `Downloading ${name} ${version}`, 'download', async () => {
        const response = await fetch(expectedUrl, { signal });
        if (!response.ok) throw new UserError(`Downloading ${name} failed (HTTP ${response.status}).`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== record[3]) throw new UserError(`The ${name} framework checksum does not match its release.`, 'The downloaded artifact was not used. Retry when the release is available.');
        await fs.writeFile(archive, bytes);
      });
    }
    const framework = path.join(dir, `${name}.xcframework`, 'ios-arm64', `${name}.framework`);
    if (!existsSync(path.join(framework, name))) {
      await fs.mkdir(dir, { recursive: true });
      await executor.run(['python3', '-c', EXTRACT_ZIP, await executor.path(archive, signal), await executor.path(dir, signal)], { signal });
    }
    if (!existsSync(path.join(framework, name))) throw new UserError(`${name} has no arm64 iPhone framework in this release.`);
    frameworks.push({ path: framework });
  }
  return frameworks;
}

export async function prepareCapacitorPlan(project: ProjectInfo, options: {
  directory: string; outputDirectory: string; liveUrl?: string; frameworks: Array<{ path: string }>;
  signing: WslBuildPlan['signing']; release?: boolean;
}, ctx: EngineContext, signal: AbortSignal): Promise<WslBuildPlan> {
  throwIfAborted(signal);
  if (project.kind !== 'capacitor') throw new UserError('The WSL adapter currently supports Capacitor iOS projects.');
  if (project.iosPackageManager !== 'SPM') throw new UserError('This project uses CocoaPods or has no SPM iOS project.', 'Create an SPM iOS project with `npx cap add ios --packagemanager SPM`, or use the Mac backend.');
  const appDir = path.join(project.capDir, project.iosDir, 'App', 'App');
  const appFiles = await filesIn(appDir);
  const customSources = appFiles.filter((file) => /\.(swift|m|mm|c|cpp)$/.test(file) && !['AppDelegate.swift', 'SceneDelegate.swift'].includes(path.basename(file)));
  if (customSources.length || appFiles.some((file) => file.endsWith('.entitlements'))) throw new UserError('This project has custom native application code or entitlements.', 'The first WSL adapter supports the standard Capacitor host. Keep using the Mac backend for customized native hosts.');
  const delegate = await fs.readFile(path.join(appDir, 'AppDelegate.swift'), 'utf8');
  const finish = delegate.match(/didFinishLaunchingWithOptions[^\{]*\{([\s\S]*?)\}/)?.[1]?.replace(/\/\/[^\n]*/g, '').trim();
  if (finish && finish !== 'return true' && finish !== 'true') throw new UserError('AppDelegate contains custom startup code.', 'The WSL adapter generates a standard host and cannot preserve custom startup behavior yet.');
  validateStandardDelegate(delegate, false);
  const scenePath = path.join(appDir, 'SceneDelegate.swift');
  if (existsSync(scenePath)) validateStandardDelegate(await fs.readFile(scenePath, 'utf8'), true);
  const additionalResources = appFiles.filter((file) => {
    const rel = path.relative(appDir, file).replace(/\\/g, '/');
    return !/^(?:AppDelegate\.swift|SceneDelegate\.swift|Info\.plist|PrivacyInfo\.xcprivacy|capacitor\.config\.json|config\.xml)$/.test(rel)
      && !/^(?:public\/|Assets\.xcassets\/|Base\.lproj\/(?:Main|LaunchScreen)\.storyboard$)/.test(rel);
  });
  if (additionalResources.length) throw new UserError('This project has custom native application resources.', 'The first adapter supports web assets and the application privacy manifest; other native resources need an adapter.', additionalResources.map((file) => path.relative(appDir, file)));
  const config = await readFullCapacitorConfig(project, signal);
  if (config.ios?.appendUserAgent || config.ios?.limitsNavigationsToAppBoundDomains) log(ctx, 'info', 'Using the evaluated Capacitor iOS configuration.');
  // Never accidentally export a development server in a standalone build.
  if (!options.liveUrl && config.server?.url) throw new UserError('The Capacitor configuration points to a development server.', 'Remove server.url for a standalone build, or use `capmac wsl dev` for live reload.');
  const plugins = await discoverCapacitorPlugins(project);
  await fs.mkdir(options.directory, { recursive: true });
  const host = path.join(options.directory, 'App.swift');
  const info = path.join(options.directory, 'Info.plist');
  const configPath = path.join(options.directory, 'capacitor.config.json');
  const configXml = path.join(options.directory, 'config.xml');
  const publicDir = path.join(project.capDir, project.webDir);
  if (!existsSync(path.join(publicDir, 'index.html'))) throw new UserError(`No index.html in ${project.webDir}.`, 'Build the web app first, or remove --no-web-build.');
  if (options.liveUrl) config.server = { ...config.server, url: options.liveUrl, cleartext: new URL(options.liveUrl).protocol === 'http:' };
  config.packageClassList = [];
  await Promise.all([
    fs.writeFile(host, capacitorHostSource(plugins)),
    fs.writeFile(info, developmentInfoPlist(await fs.readFile(path.join(appDir, 'Info.plist'), 'utf8'), project, !!options.liveUrl, options.release)),
    fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`),
    fs.writeFile(configXml, '<?xml version="1.0" encoding="UTF-8"?><widget xmlns="http://www.w3.org/ns/widgets"/>\n'),
  ]);
  const privacy = appFiles.filter((file) => path.basename(file) === 'PrivacyInfo.xcprivacy');
  const resources = [{ source: publicDir, destination: 'public' }, { source: configPath, destination: 'capacitor.config.json' }, { source: configXml, destination: 'config.xml' }, ...privacy.map((file) => ({ source: file, destination: 'PrivacyInfo.xcprivacy' }))];
  log(ctx, 'info', `${plugins.length} Swift plugin${plugins.length === 1 ? '' : 's'} · generated native Capacitor host · development build`);
  return {
    projectRoot: project.capDir, outputDirectory: options.outputDirectory, bundleName: 'App', executableName: 'App',
    bundleIdentifier: project.appId, minimumIosVersion: '15.0', infoPlistPath: info, sourceFiles: [host],
    frameworks: options.frameworks, swiftModules: plugins.map((plugin) => ({ name: plugin.module, sourceFiles: plugin.sources })),
    resources, signing: options.signing, configuration: options.release ? 'Release' : 'Debug',
  };
}

export function capacitorIosVersion(project: ProjectInfo): string {
  const ios = JSON.parse(readFileSync(path.join(packageRoot(project, '@capacitor/ios'), 'package.json'), 'utf8')).version as string;
  const core = JSON.parse(readFileSync(path.join(packageRoot(project, '@capacitor/core'), 'package.json'), 'utf8')).version as string;
  if (ios !== core) throw new UserError('Installed @capacitor/core and @capacitor/ios versions do not match.', `Install matching versions before building (core ${core}, ios ${ios}).`);
  if (!/^8\.(?:[6-9]|[1-9]\d)\.\d+$|^8\.5\.(?:[3-9]|[1-9]\d)$/.test(ios)) throw new UserError(`Capacitor ${ios} is outside this adapter's supported range.`, 'The first adapter requires Capacitor 8.5.3 or newer within major version 8.');
  return ios;
}
