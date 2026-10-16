/** A framework-neutral arm64 iOS build plan. Framework adapters prepare inputs here. */
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CancelledError, UserError } from '../errors.js';
import { inspectWslToolchain, iosCompilerArguments, iosLinkerArguments, WslExecutor, type WslRunOptions, type WslToolchainConfig, type WslToolchainTools } from './toolchain.js';
import { linkWithObjCStubs } from './objc-stubs.js';

export interface WslSwiftModule {
  name: string;
  sourceFiles: string[];
  /** Modules are provided in dependency order; dependencies must precede this module. */
  dependencies?: string[];
}

export interface WslSigning {
  certificatePath: string;
  password: string;
  provisioningProfilePath: string;
  entitlementsPath?: string;
  extensionProfiles?: Record<string, string>;
}

export interface WslNestedSigningBundle {
  bundleIdentifier: string;
  appPath: string;
  provisioningProfilePath: string;
  entitlementsPath?: string;
  buildSettings?: Record<string, string>;
}

export interface WslBuildPlan {
  projectRoot: string;
  outputDirectory: string;
  bundleName: string;
  executableName: string;
  bundleIdentifier: string;
  minimumIosVersion: string;
  configuration?: 'Debug' | 'Release';
  infoPlistPath: string;
  sourceFiles: string[];
  frameworks: { path: string }[];
  swiftModules?: WslSwiftModule[];
  resources?: { source: string; destination: string }[];
  signing: WslSigning;
}

export interface WslBuildHooks extends Pick<WslRunOptions, 'signal' | 'onOutput'> {
  onPhase?: (phase: 'prepare' | 'compile' | 'sign') => void;
}

function absolute(input: string): boolean {
  return path.isAbsolute(input) || path.win32.isAbsolute(input);
}

/** Reject unsafe bundle names and resource paths before creating or copying anything. */
export function validateWslBuildPlan(plan: WslBuildPlan): void {
  for (const [label, name] of [['bundle', plan.bundleName], ['executable', plan.executableName]] as const) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new UserError(`The ${label} name must contain only letters, numbers, underscores or hyphens.`);
  }
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(plan.bundleIdentifier)) throw new UserError('The iOS bundle identifier is invalid.');
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(plan.minimumIosVersion)) throw new UserError('The minimum iOS version must look like 15.0.');
  if (plan.configuration && !['Debug', 'Release'].includes(plan.configuration)) throw new UserError('Unsupported iOS build configuration.');
  if (!absolute(plan.projectRoot) || !absolute(plan.outputDirectory)) throw new UserError('Project and output directories must be absolute paths.');
  const inputs = [plan.infoPlistPath, ...plan.sourceFiles, ...plan.frameworks.map((f) => f.path),
    ...(plan.swiftModules ?? []).flatMap((m) => m.sourceFiles), ...(plan.resources ?? []).map((r) => r.source),
    plan.signing.certificatePath, plan.signing.provisioningProfilePath];
  if (inputs.some((input) => !absolute(input) || /[\0\r\n]/.test(input))) throw new UserError('Build input paths must be absolute and contain no control characters.');
  if (!plan.sourceFiles.length || [...plan.sourceFiles, ...(plan.swiftModules ?? []).flatMap((m) => m.sourceFiles)].some((file) => !file.endsWith('.swift'))) {
    throw new UserError('This experimental compiler requires Swift application and plugin sources.', 'Objective-C/C++ source plugins and custom build steps need a supported adapter.');
  }
  const moduleNames = new Set<string>();
  for (const module of plan.swiftModules ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(module.name) || moduleNames.has(module.name) || module.name === 'CapMacApplication' || !module.sourceFiles.length) throw new UserError(`Invalid or duplicate Swift module: ${module.name}`);
    if ((module.dependencies ?? []).some((dependency) => !moduleNames.has(dependency))) throw new UserError(`Swift module ${module.name} has a missing or unordered dependency.`);
    moduleNames.add(module.name);
  }
  const destinations = new Set<string>();
  for (const resource of plan.resources ?? []) {
    const destination = resource.destination.replace(/\\/g, '/');
    if (!destination || destination.startsWith('/') || destination.split('/').some((part) => !part || part === '.' || part === '..') || /[:\0\r\n]/.test(destination)) throw new UserError(`Unsafe application resource destination: ${resource.destination}`);
    const first = destination.split('/')[0]!.toLowerCase();
    if (['info.plist', 'frameworks', '_codesignature', 'embedded.mobileprovision', plan.executableName.toLowerCase()].includes(first) || destinations.has(destination.toLowerCase())) throw new UserError(`Application resource destination is reserved or duplicated: ${destination}`);
    destinations.add(destination.toLowerCase());
  }
  const frameworkNames = new Set<string>();
  for (const framework of plan.frameworks) {
    const filename = framework.path.replace(/\\/g, '/').split('/').at(-1)!;
    if (!/^[A-Za-z_][A-Za-z0-9_]*\.framework$/.test(filename) || frameworkNames.has(filename)) throw new UserError('Framework inputs must be unique .framework directories for iOS arm64.');
    frameworkNames.add(filename);
  }
  if (/[\r\n\0]/.test(plan.signing.password)) throw new UserError('The signing password cannot contain newlines or NUL characters.');
}

const FRAMEWORK_KIND = `import pathlib,struct,sys
p=pathlib.Path(sys.argv[1]); data=p.read_bytes()
if data.startswith(b'!<arch>\\n'): print('static')
elif data[:4]==b'\\xcf\\xfa\\xed\\xfe' and len(data)>=16 and struct.unpack('<I',data[4:8])[0]==0x100000c:
 kind=struct.unpack('<I',data[12:16])[0]
 if kind!=6: raise SystemExit('Framework must be an arm64 dynamic library or a static archive')
 offset=32; ios=False
 for _ in range(struct.unpack('<I',data[16:20])[0]):
  if offset+8>len(data): raise SystemExit('Truncated framework Mach-O load commands')
  command,size=struct.unpack('<II',data[offset:offset+8])
  if size<8 or offset+size>len(data): raise SystemExit('Invalid framework Mach-O load command')
  if command==0x32: ios=struct.unpack('<I',data[offset+8:offset+12])[0]==2
  if command==0x25: ios=True
  offset+=size
 if not ios: raise SystemExit('Framework must target physical iOS devices, not the simulator or macOS')
 print('dynamic')
else: raise SystemExit('Framework must be a thin arm64 iOS slice, not a simulator or universal framework')
`;

const VALIDATE_PROFILE = `import datetime,fnmatch,plistlib,sys
with open(sys.argv[1],'rb') as f: p=plistlib.load(f)
expiry=p.get('ExpirationDate')
if not expiry or expiry.replace(tzinfo=datetime.timezone.utc)<=datetime.datetime.now(datetime.timezone.utc): raise SystemExit('Provisioning profile has expired')
e=p.get('Entitlements',{}); app=e.get('application-identifier','')
bundle=app.partition('.')[2]
if not bundle or not fnmatch.fnmatchcase(sys.argv[2],bundle): raise SystemExit('Provisioning profile does not cover bundle identifier '+sys.argv[2])
if not p.get('ProvisionedDevices') and not p.get('ProvisionsAllDevices'): raise SystemExit('Use a development or ad hoc profile containing the test device; App Store profiles cannot install directly')
`;

/** Resolve Xcode signing variables and check every requested capability against the supplied profile. */
export const PREPARE_ENTITLEMENTS = `import fnmatch,json,plistlib,re,sys
with open(sys.argv[1],'rb') as f: profile=plistlib.load(f)
with open(sys.argv[2],'rb') as f: requested=plistlib.load(f)
grants=profile.get('Entitlements',{})
bundle=sys.argv[3]
prefix=(profile.get('ApplicationIdentifierPrefix') or [grants.get('application-identifier','').split('.')[0]])[0]+'.'
team=(profile.get('TeamIdentifier') or [prefix.rstrip('.')])[0]
variables=json.loads(sys.argv[5]) if len(sys.argv)>5 else {}
variables.setdefault('APS_ENVIRONMENT',grants.get('aps-environment',''))
variables.update({'AppIdentifierPrefix':prefix,'TeamIdentifierPrefix':team+'.','PRODUCT_BUNDLE_IDENTIFIER':bundle,'CFBundleIdentifier':bundle})
def expand(value):
 if isinstance(value,str):
  result=value
  for _ in range(20):
   next=re.sub(r'\\$\\(([^)]+)\\)|\\$\\{([^}]+)\\}',lambda m:variables.get(m[1] or m[2],m[0]),result)
   if next==result: break
   result=next
  if '$(' in result or ('$'+'{') in result: raise ValueError('Unknown entitlement build variable: '+result)
  return result
 if isinstance(value,list): return [expand(v) for v in value]
 if isinstance(value,dict): return {k:expand(v) for k,v in value.items()}
 return value
def allowed(value,grant):
 if isinstance(value,bool): return isinstance(grant,bool) and (not value or grant)
 if isinstance(value,str): return isinstance(grant,str) and fnmatch.fnmatchcase(value,grant)
 # Apple grants some list entitlements as one wildcard string, e.g. associated-domains "*".
 if isinstance(value,list) and isinstance(grant,str): return all(allowed(v,grant) for v in value)
 if isinstance(value,list): return isinstance(grant,list) and all(any(allowed(v,g) for g in grant) for v in value)
 if isinstance(value,dict): return isinstance(grant,dict) and all(k in grant and allowed(v,grant[k]) for k,v in value.items())
 return value==grant
requested=expand(requested)
if not isinstance(requested,dict): raise ValueError('Application entitlements must be a dictionary')
for key,value in requested.items():
 if key not in grants or not allowed(value,grants[key]): raise ValueError('Provisioning profile does not grant entitlement '+key)
result={k:grants[k] for k in ['com.apple.developer.team-identifier','get-task-allow'] if k in grants}
result['application-identifier']=prefix+bundle
if 'keychain-access-groups' in grants: result['keychain-access-groups']=[prefix+bundle]
result.update(requested)
if result['application-identifier']!=prefix+bundle: raise ValueError('Application identifier entitlement does not match the application bundle identifier')
if result.get('com.apple.developer.team-identifier',team)!=team: raise ValueError('Team identifier entitlement does not match the provisioning profile')
for key,value in result.items():
 if key not in grants or not allowed(value,grants[key]): raise ValueError('Provisioning profile does not grant entitlement '+key)
with open(sys.argv[4],'wb') as f: plistlib.dump(result,f)
`;

export const PACKAGE_WSL_APPLICATION = String.raw`import pathlib,sys,zipfile
app=pathlib.Path(sys.argv[1]); destination=pathlib.Path(sys.argv[2])
if not app.is_dir() or app.suffix!='.app': raise SystemExit('IPA packaging requires an existing .app bundle')
destination.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
 for item in sorted(app.rglob('*')):
  if item.is_file(): archive.write(item,pathlib.PurePosixPath('Payload',app.name,*item.relative_to(app).parts))
`;

const STAGE_SIGNING_PAYLOAD = String.raw`import pathlib,shutil,sys
app=pathlib.Path(sys.argv[1]); staging=pathlib.Path(sys.argv[2])
if staging.parent!=app.parent or not staging.name.startswith('.capmac-package-'): raise SystemExit('Unsafe signing staging directory')
staging.mkdir(); (staging/'.owner').write_text(str(app)); (staging/'archive'/'Payload').mkdir(parents=True)
shutil.move(str(app),str(staging/'archive'/'Payload'/app.name))
`;

const RESTORE_SIGNING_PAYLOAD = String.raw`import pathlib,shutil,sys
app=pathlib.Path(sys.argv[1]); staging=pathlib.Path(sys.argv[2])
if not staging.exists(): raise SystemExit(0)
if staging.parent!=app.parent or not staging.name.startswith('.capmac-package-') or not (staging/'.owner').is_file() or (staging/'.owner').read_text()!=str(app): raise SystemExit('Unsafe signing staging directory')
source=staging/'archive'/'Payload'/app.name
if source.exists():
 if app.exists(): raise SystemExit('Cannot restore the signed app over an existing output')
 shutil.move(str(source),str(app))
shutil.rmtree(staging)
`;

/** Package a complete unsigned app for inspection without signing credentials. */
export async function packageUnsignedWslApplication(executor: WslExecutor, appPath: string, ipaPath: string, hooks: WslBuildHooks = {}): Promise<void> {
  await executor.run(['python3', '-c', PACKAGE_WSL_APPLICATION, await executor.path(appPath, hooks.signal), await executor.path(ipaPath, hooks.signal)], { ...hooks, timeoutMs: 600_000 });
}

const VALIDATE_PLIST = `import plistlib,sys
with open(sys.argv[1],'rb') as f: p=plistlib.load(f)
for key,value in [('CFBundleIdentifier',sys.argv[2]),('CFBundleExecutable',sys.argv[3])]:
 if p.get(key)!=value: raise SystemExit('Info.plist '+key+' does not match the build plan')
if p.get('CFBundlePackageType')!='APPL': raise SystemExit('Info.plist must declare CFBundlePackageType APPL')
if p.get('UIMainStoryboardFile') or p.get('UILaunchStoryboardName'): raise SystemExit('Uncompiled storyboards cannot be used by this backend; use a programmatic application and launch screen')
`;

// Static frameworks execute in the application's bundle, so their runtime
// resources belong there too. Privacy manifests merge rather than overwrite.
const COPY_STATIC_RESOURCES = `import pathlib,plistlib,shutil,sys
source=pathlib.Path(sys.argv[1]); app=pathlib.Path(sys.argv[2]); binary=sys.argv[3]
def merge(a,b):
 if isinstance(a,dict) and isinstance(b,dict):
  result=dict(a)
  for key,value in b.items(): result[key]=merge(result[key],value) if key in result else value
  return result
 if isinstance(a,list) and isinstance(b,list):
  result=list(a)
  for value in b:
   identity=next((key for key in ['NSPrivacyAccessedAPIType','NSPrivacyCollectedDataType'] if isinstance(value,dict) and key in value),None)
   match=next((i for i,item in enumerate(result) if identity and isinstance(item,dict) and item.get(identity)==value[identity]),None)
   if match is not None: result[match]=merge(result[match],value)
   elif value not in result: result.append(value)
  return result
 if isinstance(a,bool) and isinstance(b,bool): return a or b
 if a==b: return a
 raise SystemExit('Conflicting static framework privacy manifest values')
for item in source.iterdir():
 if item.name in [binary,'Info.plist','Headers','PrivateHeaders','Modules','_CodeSignature'] or item.name.startswith('.'): continue
 target=app/item.name
 if item.name=='PrivacyInfo.xcprivacy' and target.exists():
  with target.open('rb') as f: previous=plistlib.load(f)
  with item.open('rb') as f: incoming=plistlib.load(f)
  with target.open('wb') as f: plistlib.dump(merge(previous,incoming),f)
 elif target.exists(): raise SystemExit('Static framework resource collides with application resource: '+item.name)
 elif item.is_dir(): shutil.copytree(item,target)
 else: shutil.copy2(item,target)
`;

/** Compile sources and Swift plugin modules, embed dynamic frameworks, and sign an installable IPA. */
export async function compileWslIos(plan: WslBuildPlan, config: WslToolchainConfig = {}, hooks: WslBuildHooks = {}): Promise<{ appPath: string; ipaPath: string }> {
  validateWslBuildPlan(plan);
  if (hooks.signal?.aborted) throw new CancelledError();
  const report = await inspectWslToolchain(config, hooks);
  if (!report.ready || !report.tools || !report.distro) throw new UserError('The WSL iOS toolchain is not ready.', 'Run capmac doctor --backend wsl and resolve its failed checks.', report.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.message}`));
  const executor = new WslExecutor(report.distro);
  return buildWithToolchain(plan, executor, report.tools, hooks);
}

/** Exported for transport-level tests and callers that have just run the same doctor. */
export async function buildWithToolchain(plan: WslBuildPlan, executor: WslExecutor, tools: WslToolchainTools, hooks: WslBuildHooks = {}): Promise<{ appPath: string; ipaPath: string }> {
  validateWslBuildPlan(plan);
  if (hooks.signal?.aborted) throw new CancelledError();
  const options: WslRunOptions = { signal: hooks.signal, onOutput: hooks.onOutput, timeoutMs: 600_000 };
  const run = (argv: string[], extra?: WslRunOptions) => executor.run(argv, { ...options, ...extra });
  hooks.onPhase?.('prepare');
  mkdirSync(plan.outputDirectory, { recursive: true });
  // Only generated children are created; no user-selected directory is deleted.
  const buildDirectory = mkdtempSync(path.join(plan.outputDirectory, 'build-'));
  const appPath = path.join(buildDirectory, `${plan.bundleName}.app`);
  const ipaPath = path.join(buildDirectory, `${plan.bundleName}.ipa`);
  const build = await executor.path(buildDirectory, hooks.signal);
  const app = `${build}/${plan.bundleName}.app`;
  const ipa = `${build}/${plan.bundleName}.ipa`;
  const modules = `${build}/modules`;
  await run(['mkdir', '-p', '--', app, modules]);
  const infoPlist = await executor.path(plan.infoPlistPath, hooks.signal);
  await run(['python3', '-c', VALIDATE_PLIST, infoPlist, plan.bundleIdentifier, plan.executableName]);
  await run(['cp', '--', infoPlist, `${app}/Info.plist`]);
  for (const resource of plan.resources ?? []) {
    const destination = `${app}/${resource.destination.replace(/\\/g, '/')}`;
    await run(['mkdir', '-p', '--', path.posix.dirname(destination)]);
    await run(['cp', '-a', '--', await executor.path(resource.source, hooks.signal), destination]);
  }
  const frameworkFlags: string[] = [];
  for (const framework of plan.frameworks) {
    const location = await executor.path(framework.path, hooks.signal);
    const filename = path.posix.basename(location);
    const name = filename.replace(/\.framework$/, '');
    frameworkFlags.push('-F', path.posix.dirname(location), '-framework', name);
    const kind = await run(['python3', '-c', FRAMEWORK_KIND, `${location}/${name}`]);
    if (kind.stdout.trim() === 'dynamic') {
      await run(['mkdir', '-p', '--', `${app}/Frameworks`]);
      await run(['cp', '-a', '--', location, `${app}/Frameworks/${filename}`]);
      // Distribution frameworks can contain headers and Swift modules; neither
      // is required at runtime and they must not be included in signed apps.
      await run(['rm', '-rf', '--', `${app}/Frameworks/${filename}/Headers`, `${app}/Frameworks/${filename}/PrivateHeaders`, `${app}/Frameworks/${filename}/Modules`]);
    } else {
      await run(['python3', '-c', COPY_STATIC_RESOURCES, location, app, name]);
    }
  }
  hooks.onPhase?.('compile');
  const common = [...iosCompilerArguments(tools, plan.minimumIosVersion), '-I', modules,
    '-module-cache-path', `${build}/module-cache`, ...frameworkFlags,
    ...(plan.configuration === 'Release' ? ['-O'] : ['-Onone', '-D', 'DEBUG'])];
  const objects: string[] = [];
  for (const module of plan.swiftModules ?? []) {
    const object = `${modules}/${module.name}.o`;
    await run([tools.swiftcPath, ...common, '-parse-as-library', '-whole-module-optimization', '-emit-object', '-emit-module',
      '-module-name', module.name, '-emit-module-path', `${modules}/${module.name}.swiftmodule`,
      ...await Promise.all(module.sourceFiles.map((source) => executor.path(source, hooks.signal))), '-o', object]);
    objects.push(object);
  }
  await linkWithObjCStubs(run, [tools.swiftcPath, ...common, '-parse-as-library', '-module-name', 'CapMacApplication',
    ...await Promise.all(plan.sourceFiles.map((source) => executor.path(source, hooks.signal))), ...objects,
    '-Xlinker', '-ObjC', '-Xlinker', '-rpath', '-Xlinker', '@executable_path/Frameworks', ...iosLinkerArguments(tools)], `${app}/${plan.executableName}`, {
    clang: tools.clangPath ?? (tools.swiftcPath.includes('/') ? `${path.posix.dirname(tools.swiftcPath)}/clang` : 'clang'),
    target: `arm64-apple-ios${plan.minimumIosVersion}`, work: build,
  });
  await run(['chmod', '755', `${app}/${plan.executableName}`]);
  hooks.onPhase?.('sign');
  await signWslApplication(plan, executor, tools, appPath, ipaPath, hooks);
  return { appPath, ipaPath };
}

/** Sign an already assembled application. Shared by Swift-package and Xcode/CocoaPods builds. */
export async function signWslApplication(
  plan: Pick<WslBuildPlan, 'bundleIdentifier' | 'signing'> & { buildSettings?: Record<string, string>; nestedBundles?: WslNestedSigningBundle[] },
  executor: WslExecutor,
  tools: WslToolchainTools,
  appPath: string,
  ipaPath: string,
  hooks: WslBuildHooks = {},
): Promise<void> {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(plan.bundleIdentifier)) throw new UserError('The iOS bundle identifier is invalid.');
  if (/[\r\n\0]/.test(plan.signing.password)) throw new UserError('The signing password cannot contain newlines or NUL characters.');
  const options: WslRunOptions = { signal: hooks.signal, onOutput: hooks.onOutput, timeoutMs: 600_000 };
  const run = (argv: string[], extra?: WslRunOptions) => executor.run(argv, { ...options, ...extra });
  const app = await executor.path(appPath, hooks.signal);
  const ipa = await executor.path(ipaPath, hooks.signal);
  const temporary = (await run(['mktemp', '-d', '-t', 'capmac-sign.XXXXXXXX'])).stdout.trim();
  if (!/^\/tmp\/capmac-sign\.[A-Za-z0-9]+$/.test(temporary)) throw new UserError('WSL returned an unexpected signing directory.');
  const staging = `${path.posix.dirname(app)}/.capmac-package-${randomUUID()}`;
  try {
    const profile = await executor.path(plan.signing.provisioningProfilePath, hooks.signal);
    await run(['openssl', 'cms', '-verify', '-noverify', '-inform', 'DER', '-in', profile, '-out', `${temporary}/profile.plist`]);
    await run(['python3', '-c', VALIDATE_PROFILE, `${temporary}/profile.plist`, plan.bundleIdentifier]);
    const entitlementArguments: string[] = [];
    if (plan.signing.entitlementsPath) {
      await run(['python3', '-c', PREPARE_ENTITLEMENTS, `${temporary}/profile.plist`, await executor.path(plan.signing.entitlementsPath, hooks.signal), plan.bundleIdentifier, `${temporary}/entitlements.plist`, JSON.stringify(plan.buildSettings ?? {})]);
      entitlementArguments.push('-e', `${temporary}/entitlements.plist`);
    }
    const profileArguments = ['-m', profile];
    const scopedEntitlements: Record<string, string> = {};
    for (const [index, nested] of (plan.nestedBundles ?? []).entries()) {
      if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(nested.bundleIdentifier)) throw new UserError('The extension bundle identifier is invalid.');
      const nestedPath = await executor.path(nested.appPath, hooks.signal);
      if (!nestedPath.startsWith(`${app}/PlugIns/`) || !nestedPath.endsWith('.appex')) throw new UserError('An extension signing target must be inside the application PlugIns directory.');
      const nestedProfile = await executor.path(nested.provisioningProfilePath, hooks.signal);
      const decoded = `${temporary}/extension-${index}-profile.plist`;
      await run(['openssl', 'cms', '-verify', '-noverify', '-inform', 'DER', '-in', nestedProfile, '-out', decoded]);
      await run(['python3', '-c', VALIDATE_PROFILE, decoded, nested.bundleIdentifier]);
      const requested = nested.entitlementsPath ? await executor.path(nested.entitlementsPath, hooks.signal) : `${temporary}/empty-entitlements.plist`;
      if (!nested.entitlementsPath) await run(['python3', '-c', 'import pathlib,plistlib,sys; pathlib.Path(sys.argv[1]).write_bytes(plistlib.dumps({}))', requested]);
      const effective = `${temporary}/extension-${index}-entitlements.plist`;
      await run(['python3', '-c', PREPARE_ENTITLEMENTS, decoded, requested, nested.bundleIdentifier, effective, JSON.stringify(nested.buildSettings ?? {})]);
      profileArguments.push('-m', nestedProfile);
      scopedEntitlements[nested.bundleIdentifier] = effective;
    }
    if (plan.nestedBundles?.length) {
      if (!plan.signing.entitlementsPath) {
        const requested = `${temporary}/empty-entitlements.plist`;
        await run(['python3', '-c', 'import pathlib,plistlib,sys; pathlib.Path(sys.argv[1]).write_bytes(plistlib.dumps({}))', requested]);
        await run(['python3', '-c', PREPARE_ENTITLEMENTS, `${temporary}/profile.plist`, requested, plan.bundleIdentifier, `${temporary}/entitlements.plist`, JSON.stringify(plan.buildSettings ?? {})]);
      }
      scopedEntitlements[plan.bundleIdentifier] = `${temporary}/entitlements.plist`;
    }
    // Password is input, never a process argument or persisted configuration.
    // mktemp's 0700 directory protects OpenSSL's initial write; key mode is then
    // explicitly restricted before invoking the signer.
    const exportArgs = ['openssl', 'pkcs12', '-in', await executor.path(plan.signing.certificatePath, hooks.signal), '-nodes', '-passin', 'stdin', '-out', `${temporary}/identity.pem`];
    const exportOptions: WslRunOptions = { stdin: plan.signing.password + '\n', onOutput: undefined, allowFailure: true };
    let exported = await run(exportArgs, exportOptions);
    // OpenSSL 3 deliberately excludes RC2 from its default provider. Older
    // PKCS#12 exports need the legacy provider to decrypt their certificates.
    // A wrong password or another failure must not trigger this fallback.
    if (exported.code !== 0 && /\bRC2(?:-\d+)?-CBC\b/i.test(exported.stderr) && /unsupported|unable to fetch|fetch failed/i.test(exported.stderr)) {
      exported = await run([...exportArgs, '-legacy'], exportOptions);
    }
    if (exported.code !== 0) throw new UserError('Could not unlock the signing certificate.', 'Check the .p12 certificate and password. For an RC2-encrypted certificate, install the OpenSSL legacy provider.', exported.stderr.trim().split(/\r?\n/).slice(-8));
    await run(['chmod', '600', `${temporary}/identity.pem`]);
    await run(['python3', '-c', STAGE_SIGNING_PAYLOAD, app, staging]);
    const stagedApp = `${staging}/archive/Payload/${path.posix.basename(app)}`;
    if (plan.nestedBundles?.length) {
      const { ensureWslSigner } = await import('./signer-tools.js');
      const signer = await ensureWslSigner(executor, hooks);
      const mapping = `${temporary}/scoped-entitlements.json`;
      await run(['python3', '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.stdin.read())', mapping], { stdin: JSON.stringify(scopedEntitlements) });
      await run(['python3', '-c', 'import json,os,sys; r=json.load(sys.stdin); env=os.environ.copy(); env["CAPMAC_ZSIGN_ENTITLEMENTS_MAP"]=r["mapping"]; os.execve(r["argv"][0],r["argv"],env)'], { stdin: JSON.stringify({ mapping, argv: [signer, '-f', '-k', `${temporary}/identity.pem`, '-c', `${temporary}/identity.pem`, ...profileArguments, '-o', ipa, stagedApp] }), cwd: temporary });
    } else {
      await run([tools.signerPath, '-f', '-k', `${temporary}/identity.pem`, '-c', `${temporary}/identity.pem`, ...profileArguments, ...entitlementArguments, '-o', ipa, stagedApp], { cwd: temporary });
    }
    // zsign leaves a .zsign_cache folder where it runs; the private signing folder is removed below.
    const signed = statSync(ipaPath, { throwIfNoEntry: false });
    if (!signed?.isFile() || signed.size === 0) throw new UserError('The signer did not create an IPA.');
  } finally {
    // Cleanup is independent of the cancelled build signal.
    try { await executor.run(['python3', '-c', RESTORE_SIGNING_PAYLOAD, app, staging], { timeoutMs: 60_000 }); }
    finally { await executor.run(['rm', '-rf', '--', temporary], { allowFailure: true }); }
  }
}
