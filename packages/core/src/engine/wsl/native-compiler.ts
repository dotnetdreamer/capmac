/** Execute the native target graph exported from the application's and CocoaPods' Xcode projects. */
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { CancelledError, UserError } from '../errors.js';
import { packageUnsignedWslApplication, signWslApplication, type WslBuildHooks, type WslBuildPlan } from './compiler.js';
import { compileWslResources, generateWslResourceSources, runWslScriptPhases, type WslResourceContext, type WslScriptPhase } from './resources.js';
import { iosCompilerArguments, iosLinkerArguments, type WslExecutor, type WslToolchainTools, type WslRunOptions } from './toolchain.js';
import { linkWithObjCStubs } from './objc-stubs.js';
import { embedWslSwiftRuntimes } from './swift-runtime.js';

export interface WslNativeSource { path: string; flags?: string[] }
export interface WslNativeFramework { path?: string; name?: string; weak?: boolean; embed?: boolean }
export interface WslNativeTarget {
  id: string;
  name: string;
  productType: 'application' | 'appExtension' | 'framework' | 'staticLibrary' | 'bundle' | 'aggregate';
  /** The complete product filename, for example Capacitor.framework or libCordova.a. */
  productName: string;
  moduleName: string;
  dependencies: string[];
  sourceFiles: WslNativeSource[];
  publicHeaders: string[];
  privateHeaders?: string[];
  resources: { source: string; destination?: string }[];
  settings: Record<string, string | string[]>;
  frameworks: WslNativeFramework[];
  scripts: (WslScriptPhase & { timing?: 'beforeCompile' | 'afterCompile' | 'afterResources' })[];
}
export interface WslNativeGraph {
  version: 1;
  projectRoot: string;
  rootTargetId: string;
  targets: WslNativeTarget[];
  configuration: string;
  sdk: 'iphoneos';
}
export interface WslNativeBuildPlan {
  graph: WslNativeGraph;
  outputDirectory: string;
  signing: WslBuildPlan['signing'];
  /** Produce a reviewable IPA without credentials; it cannot be installed until signed. */
  unsigned?: boolean;
}
export interface WslNativeBuildResult { appPath: string; ipaPath: string; bundleIdentifier: string; executableName: string; signed: boolean }

/** Xcode list values follow shell quoting, but no value is evaluated as a shell command. */
export function splitXcodeArguments(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => splitXcodeArguments(item));
  const output: string[] = [];
  let current = ''; let quote = ''; let escaped = false; let active = false;
  for (const character of value) {
    if (escaped) { current += character; escaped = false; active = true; }
    else if (character === '\\' && quote !== "'") escaped = true;
    else if (quote) { if (character === quote) quote = ''; else current += character; active = true; }
    else if (character === '"' || character === "'") { quote = character; active = true; }
    else if (/\s/.test(character)) { if (active) output.push(current); current = ''; active = false; }
    else { current += character; active = true; }
  }
  if (quote || escaped) throw new UserError('An Xcode build setting contains an unterminated quote or escape.');
  if (active) output.push(current);
  return output.filter((item) => item !== '$(inherited)' && item !== '${inherited}');
}

/** Only the root application's dependency closure is built, in dependency order. */
export function orderNativeTargets(graph: WslNativeGraph): WslNativeTarget[] {
  if (graph.version !== 1 || graph.sdk !== 'iphoneos' || !graph.configuration || /[\\/\0\r\n]/.test(graph.configuration)) throw new UserError('Unsupported native iOS graph version, platform, or configuration.');
  const targets = new Map<string, WslNativeTarget>();
  for (const target of graph.targets) {
    if (!target.id || targets.has(target.id)) throw new UserError(`Duplicate native target identifier: ${target.id}`);
    if (!['application', 'appExtension', 'framework', 'staticLibrary', 'bundle', 'aggregate'].includes(target.productType)) throw new UserError(`Target ${target.name} has an unsupported native product type.`);
    if (!target.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.moduleName)) throw new UserError(`Target ${target.name} has an invalid Swift/Clang module name.`);
    if (target.productType !== 'aggregate' && (!target.productName || /[\\/\0\r\n]/.test(target.productName) || target.productName === '..')) throw new UserError(`Target ${target.name} has an unsafe product filename.`);
    if (target.productType === 'appExtension' && !target.productName.endsWith('.appex')) throw new UserError(`Target ${target.name} must produce an .appex app extension.`);
    targets.set(target.id, target);
  }
  const root = targets.get(graph.rootTargetId);
  if (!root || root.productType !== 'application') throw new UserError('The native build graph must select an application target.');
  const visiting = new Set<string>(); const visited = new Set<string>(); const result: WslNativeTarget[] = [];
  function visit(id: string): void {
    const target = targets.get(id);
    if (!target) throw new UserError(`Native target dependency ${id} is missing from the exported graph.`);
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new UserError(`Native target dependency cycle includes ${target.name}.`);
    visiting.add(id);
    for (const dependency of target.dependencies) visit(dependency);
    visiting.delete(id); visited.add(id); result.push(target);
  }
  visit(root.id);
  return result;
}

export function expandNativeSetting(value: string, settings: Record<string, string>, targetName: string): string {
  let expanded = value;
  for (let count = 0; count < 20; count++) {
    const next = expanded.replace(/\$\(([^)]+)\)|\$\{([^}]+)\}/g, (_match, paren: string | undefined, brace: string | undefined) => {
      const key = paren ?? brace!;
      if (key === 'inherited') return '';
      // Xcode's common identifier modifiers are used for PRODUCT_MODULE_NAME.
      const [name, modifier] = key.split(':');
      const replacement = settings[name!];
      if (replacement === undefined) throw new UserError(`Target ${targetName}: cannot resolve Xcode build setting ${key}.`, 'Define the setting in the selected configuration; CapMac will not silently discard it.');
      if (modifier && !['rfc1034identifier', 'c99extidentifier'].includes(modifier)) throw new UserError(`Target ${targetName}: unsupported build-setting modifier ${modifier}.`);
      return modifier ? replacement.replace(/[^A-Za-z0-9_]/g, '_') : replacement;
    });
    if (next === expanded) {
      if (/\$\(|\$\{/.test(next)) throw new UserError(`Target ${targetName}: recursive Xcode build setting in ${value}.`);
      return next;
    }
    expanded = next;
  }
  throw new UserError(`Target ${targetName}: Xcode build-setting expansion exceeded its recursion limit.`);
}

const WRITE = 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(sys.stdin.read())';
const PROCESS_PLIST = `import json,pathlib,plistlib,re,sys
source,destination,raw=sys.argv[1:]; settings=json.loads(raw)
def expand(value):
 if isinstance(value,str):
  for _ in range(20):
   next=re.sub(r'\\$\\(([^)]+)\\)|\\$\\{([^}]+)\\}',lambda m: settings.get(m[1] or m[2],m[0]),value)
   if next==value: break
   value=next
  if re.search(r'\\$\\(|\\$\\{',value): raise SystemExit('Unresolved build setting in Info.plist: '+value)
  return value
 if isinstance(value,list): return [expand(v) for v in value]
 if isinstance(value,dict): return {k:expand(v) for k,v in value.items()}
 return value
p={}
if source:
 with open(source,'rb') as f: p=expand(plistlib.load(f))
for key,value in settings.items():
 if key.startswith('INFOPLIST_KEY_'): p[key[len('INFOPLIST_KEY_'):]]=expand(value)
p.update(CFBundleIdentifier=settings['PRODUCT_BUNDLE_IDENTIFIER'],CFBundleExecutable=settings['EXECUTABLE_NAME'],CFBundlePackageType=settings['PACKAGE_TYPE'],MinimumOSVersion=settings['IPHONEOS_DEPLOYMENT_TARGET'])
p.setdefault('CFBundleName',settings.get('PRODUCT_NAME',settings['TARGET_NAME']))
p.setdefault('CFBundleInfoDictionaryVersion','6.0')
p.setdefault('CFBundleVersion',settings.get('CURRENT_PROJECT_VERSION','1')); p.setdefault('CFBundleShortVersionString',settings.get('MARKETING_VERSION','1.0'))
if settings['PACKAGE_TYPE'] in ['APPL','XPC!']:
 p.setdefault('CFBundleSupportedPlatforms',['iPhoneOS']); p.setdefault('DTPlatformName','iphoneos')
 p.setdefault('UIDeviceFamily',[int(item) for item in settings.get('TARGETED_DEVICE_FAMILY','1,2').split(',')])
if settings['PACKAGE_TYPE']=='APPL':
 p.setdefault('LSRequiresIPhoneOS',True)
 if 'CAPACITOR_DEBUG' in settings: p['CAPACITOR_DEBUG']=str(p.get('CAPACITOR_DEBUG',settings['CAPACITOR_DEBUG'])).lower() in ['true','yes','1'] and 'true' or 'false'
if settings['PACKAGE_TYPE']=='XPC!' and (not isinstance(p.get('NSExtension'),dict) or not p['NSExtension'].get('NSExtensionPointIdentifier')): raise SystemExit('App extension Info.plist must declare NSExtensionPointIdentifier: '+settings['TARGET_NAME'])
out=pathlib.Path(destination); out.parent.mkdir(parents=True,exist_ok=True)
with out.open('wb') as f: plistlib.dump(p,f)
`;

const FRAMEWORK_KIND = `import pathlib,struct,sys
p=pathlib.Path(sys.argv[1]); data=p.read_bytes()
# Some vendors (GoogleMobileAds) ship each XCFramework slice as a universal file with one arm64 member.
if data[:4] in (b'\\xca\\xfe\\xba\\xbe',b'\\xca\\xfe\\xba\\xbf'):
 wide=data[3]==0xbf; width=32 if wide else 20; found=None
 for index in range(struct.unpack('>I',data[4:8])[0]):
  entry=data[8+index*width:8+(index+1)*width]
  start,length=struct.unpack('>QQ',entry[8:24]) if wide else struct.unpack('>II',entry[8:16])
  if struct.unpack('>I',entry[0:4])[0]==0x100000c and start+length<=len(data): found=data[start:start+length]; break
 if found is None: raise SystemExit('Universal framework has no arm64 member: '+str(p))
 data=found
if data.startswith(b'!<arch>\\n'): print('static')
elif data[:4]==b'\\xcf\\xfa\\xed\\xfe' and len(data)>=32 and struct.unpack('<I',data[4:8])[0]==0x100000c:
 kind=struct.unpack('<I',data[12:16])[0]
 if kind!=6: raise SystemExit('Expected arm64 dynamic framework or static archive: '+str(p))
 offset=32; ios=False
 for _ in range(struct.unpack('<I',data[16:20])[0]):
  if offset+8>len(data): raise SystemExit('Truncated Mach-O: '+str(p))
  command,size=struct.unpack('<II',data[offset:offset+8])
  if size<8 or offset+size>len(data): raise SystemExit('Invalid Mach-O: '+str(p))
  if command==0x32: ios=struct.unpack('<I',data[offset+8:offset+12])[0]==2
  if command==0x25: ios=True
  offset+=size
 if not ios: raise SystemExit('Framework does not target physical iOS: '+str(p))
 print('dynamic')
else: raise SystemExit('Expected thin arm64 iOS framework; select its device XCFramework slice: '+str(p))
`;

const SELECT_XCFRAMEWORK = `import pathlib,plistlib,sys
root=pathlib.Path(sys.argv[1])
with (root/'Info.plist').open('rb') as f: info=plistlib.load(f)
matches=[item for item in info.get('AvailableLibraries',[]) if item.get('SupportedPlatform')=='ios' and not item.get('SupportedPlatformVariant') and 'arm64' in item.get('SupportedArchitectures',[])]
if len(matches)!=1: raise SystemExit('XCFramework must provide exactly one physical iOS arm64 library: '+str(root))
item=matches[0]; library=(root/item['LibraryIdentifier']/item['LibraryPath']).resolve(strict=True)
if not library.is_relative_to(root.resolve()): raise SystemExit('Unsafe XCFramework library path')
print(library)
`;

const INSTALL_MODULE_MAP = `import pathlib,re,shutil,sys
source,destination,headers=map(pathlib.Path,sys.argv[1:]); text=source.read_text()
for match in re.finditer(r'(?:umbrella\\s+)?(?:private\\s+)?(?:textual\\s+)?header\\s+"([^"\\n]+)"',text):
 name=match[1]; candidate=source.parent/name
 if pathlib.Path(name).is_absolute(): continue
 if candidate.is_file():
  target=headers/name
  if not target.resolve().is_relative_to(headers.resolve()): raise SystemExit('Unsafe custom module-map header '+name)
  target.parent.mkdir(parents=True,exist_ok=True)
  if not target.exists(): shutil.copy2(candidate,target)
 elif not (headers/name).is_file(): raise SystemExit('Module-map header could not be resolved: '+name+' in '+str(source))
destination.parent.mkdir(parents=True,exist_ok=True); destination.write_text(text)
`;

const COPY_PRODUCT = `import pathlib,shutil,sys
source=pathlib.Path(sys.argv[1]); destination=pathlib.Path(sys.argv[2]); root=pathlib.Path(sys.argv[3]).resolve()
if destination.is_symlink() or not destination.resolve().is_relative_to(root): raise SystemExit('Native product destination escapes application bundle')
destination.parent.mkdir(parents=True,exist_ok=True)
shutil.copytree(source,destination,symlinks=True,dirs_exist_ok=True)
`;

interface TargetOutput { target: WslNativeTarget; directory: string; product: string; executable: string; generated: string; settings: Record<string, string>; dynamic: boolean }

function rawString(value: string | string[] | undefined): string { return Array.isArray(value) ? value.join(' ') : value ?? ''; }
function safeName(name: string): string { return name.replace(/[^A-Za-z0-9_-]/g, '_'); }

/** SwiftPM's umbrella rule: include/Module/Module.h, then include/Module.h, else the whole include folder (prints nothing). */
const SWIFTPM_UMBRELLA = `import os,sys
include,name=sys.argv[1:3]
for candidate in (os.path.join(include,name,name+'.h'),os.path.join(include,name+'.h')):
 if os.path.isfile(candidate): print(candidate); break
`;

const NATIVE_JOBS = 8;
/** Runs `work` over `items` with at most `limit` at once; results keep the input order. */
async function inParallel<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!, index); }
  });
  await Promise.all(lanes);
  return results;
}

/** Dependencies impose build order; only actual linker references link a product. */
export function nativeLinkedProducts(target: WslNativeTarget): Set<string> {
  const products = new Set(target.frameworks.filter((item) => item.path).map((item) => path.posix.basename(item.path!.replace(/\\/g, '/'))));
  const flags = splitXcodeArguments(target.settings.OTHER_LDFLAGS);
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (['-framework', '-weak_framework', '-reexport_framework'].includes(flag) && flags[index + 1]) products.add(`${flags[++index]}.framework`);
    else if (flag === '-l' && flags[index + 1]) products.add(`lib${flags[++index]}.a`);
    else if (flag.startsWith('-l') && flag.length > 2) products.add(`lib${flag.slice(2)}.a`);
    else if (/\.(a|framework)$/.test(flag)) products.add(path.posix.basename(flag));
  }
  return products;
}

function sourceMatches(source: string, pattern: string): boolean {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const matcher = new RegExp(`^${expression}$`);
  return matcher.test(source.replace(/\\/g, '/')) || matcher.test(path.posix.basename(source.replace(/\\/g, '/')));
}

/** OTHER_LDFLAGS belongs to the Darwin linker, not the Swift driver. */
export function nativeLinkerArguments(flags: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (flag === '-Xlinker') {
      if (!flags[index + 1]) throw new UserError('OTHER_LDFLAGS ends with -Xlinker without a value.');
      result.push('-Xlinker', flags[++index]!);
    } else if (flag.startsWith('-Wl,')) for (const item of flag.slice(4).split(',')) result.push('-Xlinker', item);
    else result.push('-Xlinker', flag);
  }
  return result;
}

/** Compiles the real app host and pod targets; it never replaces native app code. */
export async function buildNativeWithToolchain(plan: WslNativeBuildPlan, executor: WslExecutor, tools: WslToolchainTools, hooks: WslBuildHooks = {}): Promise<WslNativeBuildResult> {
  const ordered = orderNativeTargets(plan.graph);
  if (hooks.signal?.aborted) throw new CancelledError();
  const root = ordered.at(-1)!;
  if (!path.isAbsolute(plan.outputDirectory) && !path.win32.isAbsolute(plan.outputDirectory)) throw new UserError('The native output directory must be an absolute host path.');
  hooks.onPhase?.('prepare');
  mkdirSync(plan.outputDirectory, { recursive: true });
  const hostBuild = mkdtempSync(path.join(plan.outputDirectory, 'native-'));
  const build = await executor.path(hostBuild, hooks.signal);
  const projectRoot = await executor.path(plan.graph.projectRoot, hooks.signal);
  const products = `${build}/products/${plan.graph.configuration}-iphoneos`;
  const options: WslRunOptions = { signal: hooks.signal, onOutput: hooks.onOutput, timeoutMs: 600_000 };
  const run = (argv: string[], extra: WslRunOptions = {}) => executor.run(argv, { ...options, ...extra });
  const convert = (input: string) => executor.path(input, hooks.signal);
  const write = (filename: string, text: string) => run(['python3', '-c', WRITE, filename], { stdin: text });
  const outputs = new Map<string, TargetOutput>();
  // Precompiled SDK modules (UIKit, Foundation, …) are reused across builds on WSL's own disk, like Xcode's ModuleCache.
  const home = (await run(['python3', '-c', 'import os; print(os.path.expanduser("~"))'])).stdout.trim();
  const moduleCache = home.startsWith('/') ? `${home}/.cache/capmac/module-cache` : `${build}/module-cache`;
  const toolchainDirectory = `${build}/toolchain`;
  if (tools.swiftResourcePath) {
    // Xcode-generated xcconfigs use TOOLCHAIN_DIR/usr/lib/swift/iphoneos.
    // The Linux compiler's own directory contains Linux runtimes, so expose
    // the supplied Darwin resources at that conventional path in our output.
    await run(['python3', '-c', 'import pathlib,shutil,sys; root=pathlib.Path(sys.argv[1]); lib=root/"usr/lib"; lib.mkdir(parents=True,exist_ok=True); (lib/"swift").symlink_to(sys.argv[2],target_is_directory=True); bindir=root/"usr/bin"; bindir.mkdir(parents=True,exist_ok=True); [(bindir/name).symlink_to(shutil.which(tool) or tool) for name,tool in zip(["swiftc","clang","ar"],sys.argv[3:])]', toolchainDirectory, tools.swiftResourcePath, tools.swiftcPath, tools.clangPath ?? 'clang', tools.archivePath ?? 'llvm-ar']);
  }

  // All products/header interfaces are prepared first so Clang can resolve
  // public headers while Swift emits the generated Objective-C interface.
  for (const target of ordered) {
    const directory = `${build}/targets/${safeName(target.id)}`;
    const generated = `${directory}/DerivedSources`;
    const executableName = rawString(target.settings.EXECUTABLE_NAME) || (target.productType === 'staticLibrary' ? target.productName : target.productName.replace(/\.(app|appex|framework|bundle)$/, ''));
    const packageType = target.productType === 'application' ? 'APPL' : target.productType === 'appExtension' ? 'XPC!' : target.productType === 'framework' ? 'FMWK' : 'BNDL';
    const settings: Record<string, string> = {
      ...Object.fromEntries(Object.entries(target.settings).map(([key, value]) => [key, rawString(value)])),
      SRCROOT: rawString(target.settings.SRCROOT) || projectRoot, PROJECT_DIR: rawString(target.settings.PROJECT_DIR) || projectRoot,
      TARGET_NAME: target.name, PRODUCT_NAME: rawString(target.settings.PRODUCT_NAME) || target.productName.replace(/\.(app|appex|framework|bundle)$/, ''),
      PRODUCT_MODULE_NAME: target.moduleName, EXECUTABLE_NAME: executableName, FULL_PRODUCT_NAME: target.productName,
      CONFIGURATION: plan.graph.configuration, SDKROOT: tools.sdkPath, SDK_NAME: 'iphoneos', PLATFORM_NAME: 'iphoneos', EFFECTIVE_PLATFORM_NAME: '-iphoneos',
      TOOLCHAIN_DIR: tools.swiftResourcePath ? toolchainDirectory : path.posix.dirname(path.posix.dirname(tools.swiftcPath)),
      LOCAL_LIBRARY_DIR: '/Library', SYSTEM_LIBRARY_DIR: '/System/Library', LOCAL_APPS_DIR: '/Applications',
      DSTROOT: `${build}/install`, INSTALL_ROOT: `${build}/install`, SDK_DIR: tools.sdkPath,
      ARCHS: 'arm64', CURRENT_ARCH: 'arm64', NATIVE_ARCH_ACTUAL: 'arm64', CONFIGURATION_BUILD_DIR: rawString(target.settings.CONFIGURATION_BUILD_DIR) || products, BUILT_PRODUCTS_DIR: products,
      BUILD_DIR: `${build}/products`, BUILD_ROOT: `${build}/products`, TARGET_BUILD_DIR: products,
      PODS_CONFIGURATION_BUILD_DIR: products, PODS_BUILD_DIR: `${build}/products`, PODS_XCFRAMEWORKS_BUILD_DIR: rawString(target.settings.PODS_XCFRAMEWORKS_BUILD_DIR) || `${products}/XCFrameworkIntermediates`,
      TARGET_TEMP_DIR: directory, TEMP_DIR: directory, DERIVED_FILE_DIR: generated, DERIVED_FILES_DIR: generated, DERIVED_SOURCES_DIR: generated,
      OBJECT_FILE_DIR_normal: `${directory}/Objects`, MODULE_CACHE_DIR: `${moduleCache}/swift`,
      FRAMEWORKS_FOLDER_PATH: `${target.productName}/Frameworks`, UNLOCALIZED_RESOURCES_FOLDER_PATH: target.productName,
      CONTENTS_FOLDER_PATH: target.productName, WRAPPER_NAME: target.productName,
      EXECUTABLE_PATH: `${target.productName}/${executableName}`,
      PLUGINS_FOLDER_PATH: `${target.productName}/PlugIns`,
      IPHONEOS_DEPLOYMENT_TARGET: rawString(target.settings.IPHONEOS_DEPLOYMENT_TARGET) || '15.0',
      PRODUCT_BUNDLE_IDENTIFIER: rawString(target.settings.PRODUCT_BUNDLE_IDENTIFIER) || `dev.capmac.${target.moduleName}`,
      CAPACITOR_DEBUG: rawString(target.settings.CAPACITOR_DEBUG) || (plan.graph.configuration === 'Debug' || /\bDEBUG(?:=1)?\b/.test(rawString(target.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS) + ' ' + rawString(target.settings.GCC_PREPROCESSOR_DEFINITIONS)) ? 'true' : 'false'),
      PACKAGE_TYPE: packageType, PRODUCT_BUNDLE_PACKAGE_TYPE: packageType,
      APPLICATION_EXTENSION_API_ONLY: rawString(target.settings.APPLICATION_EXTENSION_API_ONLY) || (target.productType === 'appExtension' ? 'YES' : 'NO'),
      LD_ENTRY_POINT: rawString(target.settings.LD_ENTRY_POINT) || (target.productType === 'appExtension' ? '_NSExtensionMain' : ''),
      ACTION: 'build', CODE_SIGNING_ALLOWED: 'NO', CODE_SIGNING_REQUIRED: 'NO', EXPANDED_CODE_SIGN_IDENTITY: '',
    };
    for (const [key, value] of Object.entries(settings)) settings[key] = expandNativeSetting(value, settings, target.name);
    settings.CONFIGURATION_BUILD_DIR = path.posix.normalize(settings.CONFIGURATION_BUILD_DIR!);
    settings.TARGET_BUILD_DIR = settings.CONFIGURATION_BUILD_DIR!;
    const product = `${settings.CONFIGURATION_BUILD_DIR}/${target.productName || safeName(target.name)}`;
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(settings.IPHONEOS_DEPLOYMENT_TARGET!)) throw new UserError(`Target ${target.name}: invalid iOS deployment target.`);
    if (!(settings.CONFIGURATION_BUILD_DIR === build || settings.CONFIGURATION_BUILD_DIR!.startsWith(build + '/'))) throw new UserError(`Target ${target.name}: CONFIGURATION_BUILD_DIR must stay within CapMac's generated build directory.`);
    const dynamic = target.productType === 'framework' && settings.MACH_O_TYPE !== 'staticlib';
    const output: TargetOutput = { target, directory, product, executable: target.productType === 'staticLibrary' ? product : `${product}/${settings.EXECUTABLE_NAME}`, generated, settings, dynamic };
    outputs.set(target.id, output);
    await run(['mkdir', '-p', '--', directory, generated, products, settings.CONFIGURATION_BUILD_DIR!, `${directory}/Objects`, `${build}/modules`]);
    if (['framework', 'application', 'appExtension', 'bundle'].includes(target.productType)) await run(['mkdir', '-p', '--', product]);
  }

  const resolve = async (value: string, output: TargetOutput): Promise<string> => {
    const expanded = expandNativeSetting(value, output.settings, output.target.name);
    return convert(expanded.startsWith('/') || path.win32.isAbsolute(expanded) ? expanded : `${output.settings.SRCROOT}/${expanded}`);
  };
  const frameworkLocation = async (value: string, output: TargetOutput): Promise<string> => {
    const location = await resolve(value, output);
    if (!location.endsWith('.xcframework')) return location;
    const slice = await run(['python3', '-c', SELECT_XCFRAMEWORK, location]);
    const selected = slice.stdout.trim();
    if (!selected.startsWith(location + '/') || /[\r\n\0]/.test(selected)) throw new UserError(`Target ${output.target.name}: XCFramework selection returned an invalid path.`);
    return selected;
  };
  const list = (output: TargetOutput, key: string) => splitXcodeArguments(expandNativeSetting(rawString(output.target.settings[key]), output.settings, output.target.name));
  const clang = tools.clangPath ?? (tools.swiftcPath.includes('/') ? `${path.posix.dirname(tools.swiftcPath)}/clang` : 'clang');
  const archive = tools.archivePath ?? 'llvm-ar';

  for (const output of outputs.values()) {
    const { target } = output;
    if (!target.publicHeaders.length && !target.privateHeaders?.length) continue;
    // A library whose own module.modulemap already sits on its header search path
    // (SwiftPM's include/ folder) is used in place, as SwiftPM does: a staged copy
    // would define the module a second time ("import of shadowed module").
    if (output.settings.MODULEMAP_FILE && target.productType !== 'framework') {
      const own = await resolve(output.settings.MODULEMAP_FILE, output);
      const searched = await Promise.all(list(output, 'HEADER_SEARCH_PATHS').map((directory) => resolve(directory, output)));
      if (path.posix.basename(own) === 'module.modulemap' && searched.includes(path.posix.dirname(own))) {
        output.settings.CAPMAC_MODULE_MAP = own;
        output.settings.CAPMAC_HEADERS = path.posix.dirname(own);
        continue;
      }
    }
    // Other Swift package C targets get SwiftPM's generated module map over the headers where
    // they are. Copies would break includes such as "GTMSessionFetcher/GTMSessionFetcher.h"
    // and define each declaration twice.
    if (output.settings.CAPMAC_PACKAGE_INCLUDE && !output.settings.MODULEMAP_FILE && target.productType !== 'framework') {
      const include = await resolve(output.settings.CAPMAC_PACKAGE_INCLUDE, output);
      const umbrella = (await run(['python3', '-c', SWIFTPM_UMBRELLA, include, target.moduleName])).stdout.trim();
      const map = `${build}/modules/${target.moduleName}/module.modulemap`;
      await run(['mkdir', '-p', '--', path.posix.dirname(map)]);
      await write(map, `module ${target.moduleName} {\n ${umbrella ? `umbrella header ${JSON.stringify(umbrella)}` : `umbrella ${JSON.stringify(include)}`}\n export *\n}\n`);
      output.settings.CAPMAC_MODULE_MAP = map;
      output.settings.CAPMAC_HEADERS = include;
      continue;
    }
    const headers = target.productType === 'framework' ? `${output.product}/Headers` : `${build}/modules/${target.moduleName}`;
    await run(['mkdir', '-p', '--', headers]);
    const placed = new Map<string, Set<string>>();
    const taken = (folder: string, filename: string) => placed.get(folder)?.has(filename) ?? false;
    // A private header may share its name with a public one, e.g. Firebase's
    // Sources/FirebaseMessaging.h beside Public/FirebaseMessaging/FirebaseMessaging.h.
    // It then gets a folder that only its own target searches.
    const shadowed = `${build}/private-headers/${target.moduleName}`;
    const imports: string[] = [];
    for (const [visibility, items] of [['public', target.publicHeaders], ['private', target.privateHeaders ?? []]] as const) {
      for (const header of items) {
        const source = await resolve(header, output); const filename = path.posix.basename(source);
        let folder = visibility === 'private' && target.productType === 'framework' ? `${output.product}/PrivateHeaders` : headers;
        if (visibility === 'public' && taken(folder, filename)) throw new UserError(`Target ${target.name}: two public headers are named ${filename}.`);
        if (visibility === 'private' && taken(folder, filename)) {
          folder = shadowed;
          // Its original folder stays on the search path, so a later same-named private header is still reachable there.
          if (taken(folder, filename)) continue;
          output.settings.CAPMAC_PRIVATE_HEADERS = shadowed;
        }
        placed.set(folder, (placed.get(folder) ?? new Set()).add(filename));
        await run(['mkdir', '-p', '--', folder]); await run(['cp', '-a', '--', source, `${folder}/${filename}`]);
        if (visibility === 'public') imports.push(`#import "${filename}"`);
      }
    }
    if (!target.publicHeaders.length) continue;
    const umbrella = `${headers}/${target.moduleName}-capmac-umbrella.h`;
    await write(umbrella, imports.join('\n') + '\n');
    const moduleMapDirectory = target.productType === 'framework' ? `${output.product}/Modules` : headers;
    await run(['mkdir', '-p', '--', moduleMapDirectory]);
    if (output.settings.MODULEMAP_FILE) await run(['python3', '-c', INSTALL_MODULE_MAP, await resolve(output.settings.MODULEMAP_FILE, output), `${moduleMapDirectory}/module.modulemap`, headers]);
    else await write(`${moduleMapDirectory}/module.modulemap`, `${target.productType === 'framework' ? 'framework ' : ''}module ${target.moduleName} {\n umbrella header "${path.posix.basename(umbrella)}"\n export *\n module * { export * }\n}\n`);
    output.settings.CAPMAC_MODULE_MAP = `${moduleMapDirectory}/module.modulemap`;
    output.settings.CAPMAC_HEADERS = headers;
    output.settings.CAPMAC_UMBRELLA = umbrella;
  }

  hooks.onPhase?.('compile');
  for (const output of outputs.values()) {
    const { target, settings } = output;
    hooks.onOutput?.(`Building ${target.name} (${target.productType})\n`, 'stdout');
    const context: WslResourceContext = { projectRoot: settings.SRCROOT!, buildDirectory: build, productDirectory: output.product, targetName: target.name, settings, sdkPath: tools.sdkPath, infoPlistPath: `${output.product}/Info.plist` };
    const resources = await Promise.all(target.resources.map(async (resource) => ({ ...resource, source: await resolve(resource.source, output), ...(resource.destination ? { destination: expandNativeSetting(resource.destination, settings, target.name) } : {}) })));
    const before = target.scripts.filter((phase) => (phase.timing ?? (/\[CP\].*(Embed|Copy)/i.test(phase.name) ? 'afterResources' : 'beforeCompile')) === 'beforeCompile');
    await runWslScriptPhases(executor, before, context, tools, hooks);
    if (target.productType === 'aggregate') {
      await runWslScriptPhases(executor, target.scripts.filter((phase) => !before.includes(phase)), context, tools, hooks);
      continue;
    }
    if (['application', 'appExtension', 'framework', 'bundle'].includes(target.productType)) {
      const info = settings.INFOPLIST_FILE ? await resolve(settings.INFOPLIST_FILE, output) : '';
      if (!info && ['application', 'appExtension'].includes(target.productType) && settings.GENERATE_INFOPLIST_FILE !== 'YES') throw new UserError(`Target ${target.name}: no Info.plist or GENERATE_INFOPLIST_FILE setting.`);
      await run(['python3', '-c', PROCESS_PLIST, info, `${output.product}/Info.plist`, JSON.stringify(settings)]);
    }
    const generatedResourceSources = await generateWslResourceSources(executor, resources, context, tools, hooks);

    const dependencies = new Set<string>();
    const includeDependency = (id: string): void => { if (dependencies.has(id)) return; dependencies.add(id); for (const child of outputs.get(id)!.target.dependencies) includeDependency(child); };
    for (const id of target.dependencies) includeDependency(id);
    const dependencyProducts = [...dependencies].map((id) => outputs.get(id)!).filter((item) => ['framework', 'staticLibrary'].includes(item.target.productType));
    const linkReferences = nativeLinkedProducts(target);
    const linked = dependencyProducts.filter((item) => linkReferences.has(item.target.productName));
    const headers = [...outputs.values()].filter((item) => dependencies.has(item.target.id) || item === output).flatMap((item) => item.settings.CAPMAC_HEADERS ? [item.settings.CAPMAC_HEADERS] : []);
    const headerSearch: string[] = [];
    for (const key of ['HEADER_SEARCH_PATHS', 'USER_HEADER_SEARCH_PATHS', 'SYSTEM_HEADER_SEARCH_PATHS']) {
      for (const location of list(output, key)) {
        if (location.endsWith('/**')) {
          const result = await run(['python3', '-c', 'import os,sys,json; print(json.dumps([p for p,ds,fs in os.walk(sys.argv[1])]))', await resolve(location.slice(0, -3), output)]);
          const directories: unknown = JSON.parse(result.stdout);
          if (!Array.isArray(directories) || directories.some((item) => typeof item !== 'string')) throw new UserError(`Target ${target.name}: invalid recursive header paths.`);
          for (const directory of directories as string[]) headerSearch.push(key === 'SYSTEM_HEADER_SEARCH_PATHS' ? '-isystem' : '-I', directory);
        } else headerSearch.push(key === 'SYSTEM_HEADER_SEARCH_PATHS' ? '-isystem' : '-I', await resolve(location, output));
      }
    }
    if (settings.CAPMAC_PRIVATE_HEADERS) headerSearch.push('-I', settings.CAPMAC_PRIVATE_HEADERS);
    for (const header of headers) headerSearch.push('-I', header);
    headerSearch.push('-I', output.generated, '-I', `${build}/modules`);
    const search: string[] = ['-F', products];
    if (target.productType === 'framework') search.push('-F', path.posix.dirname(output.product));
    for (const dependency of dependencyProducts) search.push(dependency.target.productType === 'framework' ? '-F' : '-L', path.posix.dirname(dependency.product));
    for (const directory of list(output, 'FRAMEWORK_SEARCH_PATHS')) search.push('-F', await resolve(directory, output));
    for (const directory of list(output, 'LIBRARY_SEARCH_PATHS')) search.push('-L', await resolve(directory, output));
    const moduleFlags = [...outputs.values()].filter((item) => item.settings.CAPMAC_MODULE_MAP && item.target.productType !== 'framework' && (item === output || dependencies.has(item.target.id))).map((item) => `-fmodule-map-file=${item.settings.CAPMAC_MODULE_MAP}`);
    const nativeDefinitions = [...list(output, 'GCC_PREPROCESSOR_DEFINITIONS'), ...list(output, 'GCC_PREPROCESSOR_DEFINITIONS_NOT_USED_IN_PRECOMPS')].map((value) => `-D${value}`);
    const commonClang = ['-target', `arm64-apple-ios${settings.IPHONEOS_DEPLOYMENT_TARGET}`, '-isysroot', tools.sdkPath, '-fmodules', '-fimplicit-module-maps', `-fmodules-cache-path=${moduleCache}/clang`, ...headerSearch, ...search.filter((_value, index) => search[index - 1] !== '-L' && search[index] !== '-L'), ...moduleFlags, ...nativeDefinitions];
    if (settings.GCC_PREFIX_HEADER) commonClang.push('-include', await resolve(settings.GCC_PREFIX_HEADER, output));
    if (settings.APPLICATION_EXTENSION_API_ONLY === 'YES') commonClang.push('-fapplication-extension');
    if (settings.CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES === 'YES') commonClang.push('-Wno-non-modular-include-in-framework-module');
    // A target's own headers are read as text while building it, not imported as its module
    // (as Xcode and SwiftPM do); otherwise headers outside its umbrella stay invisible.
    commonClang.push(`-fmodule-name=${target.moduleName}`);
    for (const id of dependencies) { const map = outputs.get(id)!.settings.CAPMAC_SWIFT_MODULE_MAP; if (map) commonClang.push(`-fmodule-map-file=${map}`); }
    const swiftCommon = [...iosCompilerArguments(tools, settings.IPHONEOS_DEPLOYMENT_TARGET!), '-module-name', target.moduleName, '-module-cache-path', `${moduleCache}/swift`, '-I', `${build}/modules`, ...search];
    for (const flag of [...headerSearch, ...moduleFlags, ...nativeDefinitions]) swiftCommon.push('-Xcc', flag);
    const optimization = settings.SWIFT_OPTIMIZATION_LEVEL || (plan.graph.configuration === 'Release' ? '-O' : '-Onone');
    swiftCommon.push(optimization, ...list(output, 'OTHER_SWIFT_FLAGS'));
    for (const condition of list(output, 'SWIFT_ACTIVE_COMPILATION_CONDITIONS')) swiftCommon.push('-D', condition);
    if (settings.SWIFT_VERSION) swiftCommon.push('-swift-version', settings.SWIFT_VERSION.split('.').slice(0, settings.SWIFT_VERSION.startsWith('4.2') ? 2 : 1).join('.'));
    if (settings.BUILD_LIBRARY_FOR_DISTRIBUTION === 'YES') swiftCommon.push('-enable-library-evolution');
    if (settings.SWIFT_OBJC_BRIDGING_HEADER) swiftCommon.push('-import-objc-header', await resolve(settings.SWIFT_OBJC_BRIDGING_HEADER, output));
    else if (settings.CAPMAC_MODULE_MAP && target.publicHeaders.length) swiftCommon.push('-import-underlying-module');
    if (settings.APPLICATION_EXTENSION_API_ONLY === 'YES') swiftCommon.push('-application-extension');
    if (settings.SWIFT_STRICT_CONCURRENCY) swiftCommon.push(`-strict-concurrency=${settings.SWIFT_STRICT_CONCURRENCY}`);
    const excluded = list(output, 'EXCLUDED_SOURCE_FILE_NAMES'); const included = list(output, 'INCLUDED_SOURCE_FILE_NAMES');
    const sources: WslNativeSource[] = [...target.sourceFiles, ...generatedResourceSources.map((location): WslNativeSource => ({ path: location }))].filter((source) => !excluded.some((pattern) => sourceMatches(source.path, pattern)) || included.some((pattern) => sourceMatches(source.path, pattern)));
    const swiftSources = sources.filter((source) => /\.swift$/i.test(source.path));
    const nativeSources = sources.filter((source) => !/\.swift$/i.test(source.path));
    for (const source of nativeSources) if (!/\.(m|mm|c|cc|cpp|cxx|s)$/i.test(source.path)) throw new UserError(`Target ${target.name}: unsupported source language ${source.path}.`);
    const objects: string[] = [];
    if (swiftSources.length) {
      const swiftInputs: string[] = [];
      // Swift frontend flags apply to a whole module; differing per-file
      // flags cannot safely be collapsed into one invocation.
      const variants = new Set(swiftSources.map((source) => JSON.stringify(source.flags ?? [])));
      if (variants.size > 1) throw new UserError(`Target ${target.name}: differing per-file Swift flags require separate module compilation.`);
      for (const source of swiftSources) swiftInputs.push(await resolve(source.path, output));
      const object = `${output.directory}/Objects/${target.moduleName}.o`;
      const module = target.productType === 'framework' ? `${output.product}/Modules/${target.moduleName}.swiftmodule/arm64-apple-ios.swiftmodule` : `${build}/modules/${target.moduleName}.swiftmodule`;
      const objcHeader = `${output.generated}/${settings.SWIFT_OBJC_INTERFACE_HEADER_NAME || `${target.moduleName}-Swift.h`}`;
      await run(['mkdir', '-p', '--', path.posix.dirname(module)]);
      const library = target.productType !== 'application' || !swiftSources.some((source) => path.posix.basename(source.path) === 'main.swift');
      await run([tools.swiftcPath, ...swiftCommon, ...(library ? ['-parse-as-library'] : []), ...(swiftSources[0]?.flags ?? []), '-whole-module-optimization', '-emit-object', '-emit-module', '-emit-module-path', module, '-emit-objc-header', '-emit-objc-header-path', objcHeader, ...swiftInputs, '-o', object]);
      objects.push(object);
      if (settings.CAPMAC_UMBRELLA) {
        // Older Swift drivers assume a framework umbrella named Module.h.
        // CocoaPods permits Module-umbrella.h and custom module maps instead.
        // Correct only that conventional generated include, using the exact
        // public umbrella assembled above; no user header is rewritten.
        await run(['python3', '-c', 'import pathlib,re,sys; p=pathlib.Path(sys.argv[1]); text=p.read_text(); pattern=r"(#\\s*(?:import|include)\\s*)<"+re.escape(sys.argv[2])+r"/"+re.escape(sys.argv[2])+r"\\.h>"; p.write_text(re.sub(pattern,lambda m:m[1]+chr(34)+sys.argv[3]+chr(34),text))', objcHeader, target.moduleName, settings.CAPMAC_UMBRELLA]);
      }
      if (target.productType === 'framework') {
        await run(['mkdir', '-p', '--', `${output.product}/Headers`]);
        await run(['cp', '--', objcHeader, `${output.product}/Headers/${path.posix.basename(objcHeader)}`]);
      }
      // Swift compilation saw only the underlying Objective-C module. The
      // generated Swift header becomes visible to Objective-C compilation now.
      if (settings.CAPMAC_MODULE_MAP && target.productType === 'framework') {
        await run(['python3', '-c', 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text(p.read_text()+sys.argv[2])', settings.CAPMAC_MODULE_MAP, `\nmodule ${target.moduleName}.Swift { header "${path.posix.basename(objcHeader)}" requires objc }\n`]);
      } else if (target.productType === 'framework') {
        await write(`${output.product}/Modules/module.modulemap`, `framework module ${target.moduleName} {\n header "${path.posix.basename(objcHeader)}"\n export *\n requires objc\n}\n`);
      } else if (!settings.CAPMAC_MODULE_MAP) {
        // As SwiftPM does, Objective-C code can `@import` a Swift library (GoogleSignIn imports
        // GTMAppAuth) through a module over its generated header. Only C-family dependents load
        // it; Swift dependents read the .swiftmodule. The folder name keeps implicit lookup away.
        const map = `${build}/modules/${target.moduleName}-Swift/module.modulemap`;
        await run(['mkdir', '-p', '--', path.posix.dirname(map)]);
        await write(map, `module ${target.moduleName} {\n header ${JSON.stringify(objcHeader)}\n requires objc\n}\n`);
        settings.CAPMAC_SWIFT_MODULE_MAP = map;
      }
    }
    // A target's C-family files are independent; compile several at once (Clang locks its shared module cache).
    objects.push(...await inParallel(nativeSources, NATIVE_JOBS, async (source, index) => {
      const location = await resolve(source.path, output);
      const object = `${output.directory}/Objects/${index}-${safeName(path.posix.basename(source.path))}.o`;
      const objc = /\.(m|mm)$/i.test(source.path); const cpp = /\.(mm|cc|cpp|cxx)$/i.test(source.path);
      const flags = [...commonClang, '-O' + (settings.GCC_OPTIMIZATION_LEVEL || (plan.graph.configuration === 'Release' ? 's' : '0')), ...list(output, 'OTHER_CFLAGS'), ...(cpp ? list(output, 'OTHER_CPLUSPLUSFLAGS') : [])];
      if (objc) flags.push(settings.CLANG_ENABLE_OBJC_ARC === 'NO' ? '-fno-objc-arc' : '-fobjc-arc', '-fobjc-exceptions');
      if (cpp) flags.push('-stdlib=libc++', `-std=${settings.CLANG_CXX_LANGUAGE_STANDARD || 'gnu++17'}`);
      else if (!objc && settings.GCC_C_LANGUAGE_STANDARD) flags.push(`-std=${settings.GCC_C_LANGUAGE_STANDARD}`);
      if (settings.GCC_ENABLE_CPP_EXCEPTIONS === 'NO' && cpp) flags.push('-fno-exceptions');
      if (settings.GCC_ENABLE_CPP_RTTI === 'NO' && cpp) flags.push('-fno-rtti');
      await run([clang, ...flags, ...(source.flags ?? []).map((flag) => expandNativeSetting(flag, settings, target.name)), '-c', location, '-o', object]);
      return object;
    }));
    await runWslScriptPhases(executor, target.scripts.filter((phase) => phase.timing === 'afterCompile'), context, tools, hooks);
    if (target.productType === 'staticLibrary' || (target.productType === 'framework' && !output.dynamic)) {
      if (!objects.length) throw new UserError(`Target ${target.name}: static library has no compilable sources.`);
      await run([archive, 'rcs', output.executable, ...objects]);
    } else if (target.productType !== 'bundle' || objects.length) {
      if (!objects.length) throw new UserError(`Target ${target.name}: executable target has no compilable sources.`);
      const runpaths = new Set(['@executable_path/Frameworks', '@loader_path/Frameworks', ...list(output, 'LD_RUNPATH_SEARCH_PATHS'), ...(target.productType === 'appExtension' ? ['@executable_path/../../Frameworks'] : [])]);
      const linkFlags: string[] = [...search, '-Xlinker', '-ObjC', ...[...runpaths].flatMap((runpath) => ['-Xlinker', '-rpath', '-Xlinker', runpath])];
      if (settings.LD_ENTRY_POINT) linkFlags.push(...nativeLinkerArguments(['-e', settings.LD_ENTRY_POINT]));
      if (settings.APPLICATION_EXTENSION_API_ONLY === 'YES') linkFlags.push(...nativeLinkerArguments(['-application_extension']));
      for (const framework of target.frameworks) {
        if (framework.path) {
          const location = await frameworkLocation(framework.path, output);
          if (location.endsWith('.framework')) linkFlags.push(...nativeLinkerArguments(['-F', path.posix.dirname(location), framework.weak ? '-weak_framework' : '-framework', path.posix.basename(location, '.framework')]));
          else if (/\.(a|dylib|tbd)$/.test(location)) {
            const built = linked.find((item) => item.target.productName === path.posix.basename(location));
            linkFlags.push(...nativeLinkerArguments([built?.executable ?? location]));
          }
          else throw new UserError(`Target ${target.name}: unsupported linked product ${location}.`);
        } else if (framework.name) linkFlags.push(...nativeLinkerArguments([framework.weak ? '-weak_framework' : '-framework', framework.name.replace(/\.framework$/, '')]));
        else throw new UserError(`Target ${target.name}: linked framework has neither a name nor a path.`);
      }
      linkFlags.push(...nativeLinkerArguments(list(output, 'OTHER_LDFLAGS')));
      if ([output, ...linked].some((item) => item.target.sourceFiles.some((source) => /\.(mm|cc|cpp|cxx)$/i.test(source.path)))) linkFlags.push('-lc++');
      if (output.dynamic) linkFlags.push('-emit-library', '-Xlinker', '-install_name', '-Xlinker', `@rpath/${target.productName}/${settings.EXECUTABLE_NAME}`);
      else if (target.productType === 'bundle') linkFlags.push('-Xlinker', '-bundle');
      await linkWithObjCStubs(run, [tools.swiftcPath, ...iosCompilerArguments(tools, settings.IPHONEOS_DEPLOYMENT_TARGET!), ...objects, ...linkFlags, ...iosLinkerArguments(tools)], output.executable, {
        clang, target: `arm64-apple-ios${settings.IPHONEOS_DEPLOYMENT_TARGET!}`, work: `${output.directory}/Objects`,
      });
      await run(['chmod', '755', output.executable]);
    }
    // A static library's product is the .a file itself, so it has no folder for resources.
    if (resources.length && target.productType === 'staticLibrary') throw new UserError(`Target ${target.name}: a static library cannot hold resources.`, 'Move them into a resource bundle target, as Xcode requires for libraries.');
    if (resources.length) await compileWslResources(executor, resources, context, tools, hooks);
    await runWslScriptPhases(executor, target.scripts.filter((phase) => phase.timing === 'afterResources' || (!phase.timing && /\[CP\].*(Embed|Copy)/i.test(phase.name))), context, tools, hooks);
  }

  const application = outputs.get(root.id)!;
  const extensionPaths = new Map<string, string>();
  // Every dynamic target in the application's dependency closure is a runtime
  // dependency even when it is reached through the Pods aggregate target.
  for (const output of outputs.values()) {
    if (output === application) continue;
    if (output.target.productType === 'appExtension') {
      if (!output.settings.PRODUCT_BUNDLE_IDENTIFIER!.startsWith(application.settings.PRODUCT_BUNDLE_IDENTIFIER! + '.')) throw new UserError(`Target ${output.target.name}: the extension bundle identifier must start with ${application.settings.PRODUCT_BUNDLE_IDENTIFIER}.`);
      const destination = `${application.product}/PlugIns/${output.target.productName}`;
      await run(['python3', '-c', COPY_PRODUCT, output.product, destination, application.product]);
      extensionPaths.set(output.target.id, destination);
    } else if (output.dynamic) {
      await run(['mkdir', '-p', '--', `${application.product}/Frameworks`]);
      await run(['python3', '-c', COPY_PRODUCT, output.product, `${application.product}/Frameworks/${output.target.productName}`, application.product]);
    } else if (output.target.productType === 'bundle') await run(['python3', '-c', COPY_PRODUCT, output.product, `${application.product}/${output.target.productName}`, application.product]);
    else if (output.target.productType === 'framework') {
      // Statically linked framework code executes in the application bundle.
      // Its runtime resources and privacy manifest must accompany the app.
      const result = await run(['python3', '-c', 'import json,pathlib,sys; root=pathlib.Path(sys.argv[1]); excluded={sys.argv[2],"Info.plist","Headers","PrivateHeaders","Modules","_CodeSignature"}; print(json.dumps([str(p) for p in root.iterdir() if p.name not in excluded and not p.name.startswith(".")]))', output.product, output.settings.EXECUTABLE_NAME!]);
      const files: unknown = JSON.parse(result.stdout || '[]');
      if (!Array.isArray(files) || files.some((item) => typeof item !== 'string' || !item.startsWith(output.product + '/'))) throw new UserError(`Target ${output.target.name}: static framework returned invalid resource paths.`);
      await compileWslResources(executor, (files as string[]).map((source) => ({ source })), { projectRoot: application.settings.SRCROOT!, buildDirectory: build, productDirectory: application.product, targetName: root.name, settings: application.settings, sdkPath: tools.sdkPath, infoPlistPath: `${application.product}/Info.plist` }, tools, hooks);
    }
  }
  for (const output of outputs.values()) for (const framework of output.target.frameworks) {
    if (!framework.path || framework.embed === false || !/\.(xcframework|framework)$/.test(framework.path)) continue;
    const location = await frameworkLocation(framework.path, output);
    if (!location.endsWith('.framework')) continue;
    if ([...outputs.values()].some((built) => built.product === location)) continue;
    const name = path.posix.basename(location, '.framework');
    const kind = await run(['python3', '-c', FRAMEWORK_KIND, `${location}/${name}`]);
    if (kind.stdout.trim() === 'dynamic') {
      await run(['mkdir', '-p', '--', `${application.product}/Frameworks`]);
      await run(['python3', '-c', COPY_PRODUCT, location, `${application.product}/Frameworks/${name}.framework`, application.product]);
    }
  }
  // Remove compile-time framework material only from the generated app copy.
  await run(['python3', '-c', 'import pathlib,shutil,sys; root=pathlib.Path(sys.argv[1]); [(shutil.rmtree(p,ignore_errors=True)) for f in root.rglob("*.framework") for name in ["Headers","PrivateHeaders","Modules"] for p in [f/name]]', application.product]);
  await embedWslSwiftRuntimes(executor, tools, application.product, application.settings.EXECUTABLE_NAME!, hooks);
  if (!application.product.startsWith(build + '/')) throw new UserError(`Target ${root.name}: CONFIGURATION_BUILD_DIR must remain inside CapMac's generated build directory.`);
  const appPath = path.join(hostBuild, ...application.product.slice(build.length + 1).split('/'));
  const ipaPath = path.join(hostBuild, `${path.basename(root.productName, '.app')}.ipa`);
  const signing = { ...plan.signing, ...(application.settings.CODE_SIGN_ENTITLEMENTS ? { entitlementsPath: await resolve(application.settings.CODE_SIGN_ENTITLEMENTS, application) } : {}) };
  if (plan.unsigned) await packageUnsignedWslApplication(executor, appPath, ipaPath, hooks);
  else {
    const nestedBundles = await Promise.all([...extensionPaths].map(async ([id, location]) => {
      const output = outputs.get(id)!; const bundleIdentifier = output.settings.PRODUCT_BUNDLE_IDENTIFIER!;
      const provisioningProfilePath = signing.extensionProfiles?.[bundleIdentifier];
      if (!provisioningProfilePath) throw new UserError(`Target ${output.target.name}: no provisioning profile is configured for ${bundleIdentifier}.`, 'Each embedded extension needs its own matching profile; the app profile cannot sign a different bundle identifier.');
      return { bundleIdentifier, appPath: path.join(hostBuild, ...location.slice(build.length + 1).split('/')), provisioningProfilePath,
        ...(output.settings.CODE_SIGN_ENTITLEMENTS ? { entitlementsPath: await resolve(output.settings.CODE_SIGN_ENTITLEMENTS, output) } : {}), buildSettings: output.settings };
    }));
    hooks.onPhase?.('sign');
    await signWslApplication({ bundleIdentifier: application.settings.PRODUCT_BUNDLE_IDENTIFIER!, signing, buildSettings: application.settings, ...(nestedBundles.length ? { nestedBundles } : {}) }, executor, tools, appPath, ipaPath, hooks);
  }
  return { appPath, ipaPath, bundleIdentifier: application.settings.PRODUCT_BUNDLE_IDENTIFIER!, executableName: application.settings.EXECUTABLE_NAME!, signed: !plan.unsigned };
}
