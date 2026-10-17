/** Native resource compilation and Xcode-compatible script phases on the WSL host. */
import path from 'node:path';
import { CancelledError, UserError } from '../errors.js';
import type { WslExecutor, WslRunOptions, WslToolchainTools } from './toolchain.js';
import { COPY_RESOURCE, INSTALL_RESOURCE_TOOLS, MERGE_RESOURCE_PLIST, RUN_SCRIPT_PHASE, TOOL_ROUTER } from './resource-tools/runtime.js';

export interface WslResource { source: string; destination?: string }
export interface WslScriptPhase {
  name: string;
  script: string;
  shellPath?: string;
  inputPaths?: string[];
  outputPaths?: string[];
  inputFileListPaths?: string[];
  outputFileListPaths?: string[];
}
/** Paths in this context and resource sources are already resolved WSL paths. */
export interface WslResourceContext {
  projectRoot: string;
  buildDirectory: string;
  productDirectory: string;
  targetName: string;
  settings: Record<string, string>;
  sdkPath: string;
  infoPlistPath?: string;
}
export interface WslResourceTools {
  actoolPath?: string;
  ibtoolPath?: string;
  momcPath?: string;
  xcstringsPath?: string;
  clangPath?: string;
  archivePath?: string;
  lipoPath?: string;
  stripPath?: string;
}
type ResourceTools = WslToolchainTools & WslResourceTools;
type ResourceHooks = Pick<WslRunOptions, 'signal' | 'onOutput'>;

function compilerDiagnostics(output: string): string[] {
  const lines = output.trim().split(/\r?\n/);
  if (lines.length <= 20) return lines;
  const actionable = lines.findIndex((line) => /\b(?:error|fatal error|failed|missing|not found|unsupported)\b/i.test(line));
  return actionable >= 0 ? lines.slice(Math.max(0, actionable - 2), actionable + 18) : [...lines.slice(0, 12), '…', ...lines.slice(-7)];
}

/** This revision's resource helpers are MIT licensed and do not require xtool. */
export const WSL_RESOURCE_TOOLS_REVISION = '66a11a37dfc0bfb755d04bde1ecbeedc17753b3b';
export const WSL_RESOURCE_TOOLS_SOURCE = 'https://github.com/joshuaswarren/omarchy-apple-dev';

function checkContext(context: WslResourceContext): void {
  for (const value of [context.projectRoot, context.buildDirectory, context.productDirectory, context.sdkPath, ...(context.infoPlistPath ? [context.infoPlistPath] : [])]) {
    if (!value.startsWith('/') || /[\0\r\n]/.test(value)) throw new UserError('Native resource paths must be absolute WSL paths without control characters.');
  }
  if (!context.targetName.trim() || ['.', '..'].includes(context.targetName) || /[\\/\0\r\n]/.test(context.targetName)) throw new UserError('The native resource target name is invalid.');
}

/** Preserve localization folders, and replace source formats with their runtime names. */
export function wslResourceDestination(resource: WslResource): string {
  if (!resource.source.startsWith('/') || /[\0\r\n]/.test(resource.source)) throw new UserError('Native resource sources must be absolute WSL paths without control characters.');
  const parts = resource.source.split('/');
  const localized = parts.findLastIndex((part) => part.endsWith('.lproj'));
  let destination = resource.destination ?? (localized >= 0 ? parts.slice(localized).join('/') : path.posix.basename(resource.source));
  if (!destination || destination.startsWith('/') || /[\\:\0\r\n]/.test(destination) || destination.split('/').some((part) => !part || part === '.' || part === '..')) throw new UserError(`Unsafe native resource destination: ${destination}`);
  if (['info.plist', '_codesignature', 'embedded.mobileprovision', 'frameworks'].includes(destination.split('/')[0]!.toLowerCase())) throw new UserError(`Native resource destination is reserved: ${destination}`);
  destination = destination.replace(/\.storyboard$/i, '.storyboardc').replace(/\.xib$/i, '.nib')
    .replace(/\.xcdatamodeld$/i, '.momd').replace(/\.xcdatamodel$/i, '.mom');
  return destination;
}

async function requireResourceTool(executor: WslExecutor, executable: string | undefined, name: string, hooks: ResourceHooks): Promise<string> {
  executable ??= name;
  if (/[\0\r\n]/.test(executable)) throw new UserError(`The configured ${name} executable contains control characters.`);
  const probe = await executor.run(['python3', '-c', 'import os,shutil,sys; p=shutil.which(sys.argv[1]); print(p or ""); sys.exit(0 if p and os.access(p,os.X_OK) else 1)', executable], { signal: hooks.signal, allowFailure: true });
  if (probe.code !== 0) throw new UserError(`The ${name} resource compiler is not executable: ${executable}`, 'Run capmac wsl setup --install-resources to install the standalone Linux resource tools.');
  return probe.stdout.trim() || executable;
}

/** Check actual executable availability; compilation itself validates each input's features. */
export async function inspectWslResourceTools(executor: WslExecutor, tools: WslResourceTools & Partial<WslToolchainTools>, hooks: ResourceHooks = {}): Promise<{ ready: boolean; checks: { name: string; ok: boolean; message: string }[] }> {
  const checks: { name: string; ok: boolean; message: string }[] = [];
  for (const [key, name] of [['actoolPath', 'actool'], ['ibtoolPath', 'ibtool'], ['momcPath', 'momc'], ['xcstringsPath', 'xcstringstool']] as const) {
    if (hooks.signal?.aborted) throw new CancelledError();
    try {
      const executable = await requireResourceTool(executor, tools[key], name, hooks);
      checks.push({ name: `${name} resource compiler`, ok: true, message: executable });
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      checks.push({ name: `${name} resource compiler`, ok: false, message: `${error instanceof Error ? error.message : String(error)} Run capmac wsl setup --install-resources.` });
    }
  }
  return { ready: checks.every((check) => check.ok), checks };
}

const CORE_DATA_CODEGEN = String.raw`import pathlib,plistlib,sys,xml.etree.ElementTree as ET
source=pathlib.Path(sys.argv[1])
if source.suffix=='.xcdatamodeld':
 current=source/'.xccurrentversion'
 if current.is_file():
  with current.open('rb') as f: name=plistlib.load(f).get('_XCCurrentVersionName')
  if not name or pathlib.Path(name).name!=name: raise SystemExit('Invalid Core Data current model version')
  model=source/name
 else:
  models=sorted(source.glob('*.xcdatamodel'))
  if len(models)!=1: raise SystemExit('Versioned Core Data model needs .xccurrentversion selecting its current version')
  model=models[0]
 if not model.resolve().is_relative_to(source.resolve()): raise SystemExit('Core Data current version escapes the model bundle')
else: model=source
document=ET.parse(model/'contents').getroot()
generated=[entity for entity in document.findall('entity') if entity.get('codeGenerationType') in ['class','category']]
if generated and document.get('sourceLanguage','Swift').lower()!='swift': raise SystemExit('Objective-C Core Data class generation is not supported by the portable momc; use manual classes or a compatible code generator')
print('generate' if generated else 'manual')
`;

/** Core Data's automatic classes are compiler inputs, so generate them before Compile Sources. */
export async function generateWslResourceSources(executor: WslExecutor, resources: readonly WslResource[], context: WslResourceContext, tools: ResourceTools, hooks: ResourceHooks = {}): Promise<string[]> {
  if (hooks.signal?.aborted) throw new CancelledError();
  checkContext(context);
  const models = resources.filter((resource) => /\.xcdatamodeld?$/i.test(resource.source));
  if (!models.length) return [];
  models.forEach(wslResourceDestination);
  const momc = await requireResourceTool(executor, tools.momcPath, 'momc', hooks);
  const generated: string[] = [];
  for (const [index, resource] of models.entries()) {
    const mode = await executor.run(['python3', '-c', CORE_DATA_CODEGEN, resource.source], { ...hooks, allowFailure: true });
    if (mode.code !== 0) throw new UserError('Core Data source generation could not read the selected model.', 'Check its current version and code generation language.', mode.stderr.trim().split(/\r?\n/).slice(-12));
    if (mode.stdout.trim() === 'manual') continue;
    if (mode.stdout.trim() !== 'generate') throw new UserError('Core Data source generation returned an invalid model mode.');
    const output = `${context.buildDirectory}/resources/${context.targetName}/CoreDataGenerated/${index}`;
    const argv = [momc, '--action', 'generate', '--swift-version', context.settings.SWIFT_VERSION || '5',
      '--module', context.settings.PRODUCT_MODULE_NAME ?? context.targetName.replace(/[^A-Za-z0-9_]/g, '_'),
      '--sdkroot', context.sdkPath, '--iphoneos-deployment-target', context.settings.IPHONEOS_DEPLOYMENT_TARGET ?? '15.0', resource.source, output];
    const planned = await executor.run([momc, '--dry-run', ...argv.slice(1)], { ...hooks, timeoutMs: 600_000, allowFailure: true });
    if (planned.code !== 0) throw new UserError('Core Data source generation failed.', 'Check the model compiler diagnostics.', (planned.stderr || planned.stdout).trim().split(/\r?\n/).slice(-20));
    const files = planned.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (files.some((file) => !file.startsWith(output + '/') || path.posix.normalize(file) !== file || !file.endsWith('.swift'))) throw new UserError('Core Data compiler returned an unsafe generated source path.');
    await executor.run(['mkdir', '-p', '--', output], hooks);
    await runResourceTool(executor, argv, hooks);
    await executor.run(['python3', '-c', 'import pathlib,sys; missing=[p for p in sys.argv[1:] if not pathlib.Path(p).is_file()]; sys.exit("Core Data compiler did not write: "+", ".join(missing) if missing else 0)', ...files], hooks);
    generated.push(...files);
  }
  return generated;
}

/**
 * Asset catalogs as Xcode reads them: an app icon set may list sizes with no
 * image (React Native's and Xcode's templates do until icons are added), which
 * Xcode skips and the Linux actool refuses. Such catalogs compile from a copy
 * without those entries; an icon set left empty goes, and with it the app icon
 * (the app gets none, as from Xcode). Prints {"sources": [...], "appIcon": bool}.
 */
const CLEAN_CATALOGS = String.raw`import json,os,shutil,sys
build,icon=sys.argv[1],sys.argv[2]; sources=[]; keep_icon=True
def icon_sets(top): return [root for root,dirs,files in os.walk(top) if root.endswith('.appiconset') and 'Contents.json' in files]
def read(root):
 with open(os.path.join(root,'Contents.json')) as handle: return json.load(handle)
for index,src in enumerate(sys.argv[3:]):
 if not any('filename' not in image for root in icon_sets(src) for image in read(root).get('images',[])):
  sources.append(src); continue
 out=os.path.join(build,'catalogs',str(index),os.path.basename(src)); shutil.rmtree(out,ignore_errors=True); shutil.copytree(src,out,symlinks=True)
 for root in icon_sets(out):
  data=read(root); data['images']=[image for image in data.get('images',[]) if 'filename' in image]
  if data['images']:
   with open(os.path.join(root,'Contents.json'),'w') as handle: json.dump(data,handle,indent=2)
  else:
   shutil.rmtree(root)
   if os.path.basename(root)[:-len('.appiconset')]==icon: keep_icon=False
 sources.append(out)
print(json.dumps({'sources':sources,'appIcon':keep_icon}))
`;

/**
 * Two label attributes in React Native's (and older Xcode's) launch screens
 * that the Linux ibtool doesn't read: minimumFontSize only applies while the
 * label shrinks its text, which that compiler always writes as off, and
 * clipsSubviews only shows when a label draws outside its frame. Such files
 * compile from a copy without them. Prints the file to compile, then the
 * attributes left out (if any).
 */
const CLEAN_INTERFACE = String.raw`import os,re,sys
src,dst=sys.argv[1],sys.argv[2]
with open(src,encoding='utf-8') as handle: text=handle.read()
dropped=set()
def label(match):
 tag=match.group(0)
 for name in ('clipsSubviews','minimumFontSize'):
  tag,count=re.subn(r'\s'+name+r'="[^"]*"','',tag)
  if count: dropped.add(name)
 return tag
cleaned=re.sub(r'<label\b(?:[^>"]|"[^"]*")*>',label,text)
if not dropped: print(src); sys.exit(0)
os.makedirs(os.path.dirname(dst),exist_ok=True)
with open(dst,'w',encoding='utf-8',newline='') as handle: handle.write(cleaned)
print(dst); print(' '.join(sorted(dropped)))
`;

/**
 * The launch screen, when the Linux ibtool can't build its storyboard (React
 * Native's template uses a bold system font it doesn't encode yet): without a
 * launch screen iOS runs the app letterboxed, so the app's Info.plist gets a
 * plain one instead (UILaunchScreen, iOS 14+) in place of the storyboard.
 * Exits 3 when the storyboard isn't the app's launch screen.
 */
const PLAIN_LAUNCH_SCREEN = String.raw`import plistlib,sys
path,name=sys.argv[1],sys.argv[2]
with open(path,'rb') as handle: raw=handle.read()
info=plistlib.loads(raw)
if info.get('UILaunchStoryboardName')!=name: sys.exit(3)
del info['UILaunchStoryboardName']
info.setdefault('UILaunchScreen',{})
with open(path,'wb') as handle: handle.write(plistlib.dumps(info,fmt=plistlib.FMT_BINARY if raw.startswith(b'bplist') else plistlib.FMT_XML))
`;

/** CLEAN_CATALOGS' answer; without one, the catalogs compile as they are. */
function cleanedCatalogs(stdout: string, sources: string[]): { sources: string[]; appIcon: boolean } {
  try {
    const parsed = JSON.parse(stdout) as { sources?: unknown; appIcon?: unknown };
    if (Array.isArray(parsed.sources) && parsed.sources.length === sources.length && parsed.sources.every((item) => typeof item === 'string' && item.startsWith('/')) && typeof parsed.appIcon === 'boolean') {
      return { sources: parsed.sources as string[], appIcon: parsed.appIcon };
    }
  } catch { /* compiled as they are */ }
  return { sources, appIcon: true };
}

async function runResourceTool(executor: WslExecutor, argv: string[], hooks: ResourceHooks): Promise<void> {
  const result = await executor.run(argv, { ...hooks, timeoutMs: 600_000, allowFailure: true });
  // The upstream asset compiler reports unsupported asset types as warnings.
  // A native build must not silently ship a catalog with missing resources.
  const diagnostics = result.stdout + '\n' + result.stderr;
  if (result.code !== 0 || /warning:\s*skipped by the Linux actool:/i.test(diagnostics)) {
    throw new UserError(`Native resource compilation failed: ${path.posix.basename(argv[0]!)}`, 'Resolve the reported unsupported resource or supply a compatible Linux compiler; source resources cannot be copied as compiled output.', compilerDiagnostics(diagnostics));
  }
}

/** Copy runtime resources; compile catalogs, IB documents, Core Data, and string catalogs. */
export async function compileWslResources(executor: WslExecutor, resources: readonly WslResource[], context: WslResourceContext, tools: ResourceTools, hooks: ResourceHooks = {}): Promise<void> {
  if (hooks.signal?.aborted) throw new CancelledError();
  checkContext(context);
  const entries = resources.map((resource) => ({ ...resource, destination: wslResourceDestination(resource) }));
  const destinations = new Set<string>();
  const catalogs = new Map<string, string[]>();
  for (const entry of entries) {
    const suffix = path.posix.extname(entry.source).toLowerCase();
    if (suffix === '.xcassets') {
      const parent = path.posix.dirname(entry.destination);
      catalogs.set(parent, [...(catalogs.get(parent) ?? []), entry.source]);
    } else if (suffix !== '.xcstrings') {
      const key = entry.destination.toLowerCase();
      if (destinations.has(key) && !key.endsWith('/privacyinfo.xcprivacy') && key !== 'privacyinfo.xcprivacy') throw new UserError(`Native resources collide at ${entry.destination}.`);
      destinations.add(key);
    }
  }
  // Probe every required compiler before copying resources or starting compilation.
  const suffixes = new Set(entries.map((entry) => path.posix.extname(entry.source).toLowerCase()));
  const actool = suffixes.has('.xcassets') ? await requireResourceTool(executor, tools.actoolPath, 'actool', hooks) : undefined;
  const ibtool = suffixes.has('.storyboard') || suffixes.has('.xib') ? await requireResourceTool(executor, tools.ibtoolPath, 'ibtool', hooks) : undefined;
  const momc = suffixes.has('.xcdatamodel') || suffixes.has('.xcdatamodeld') ? await requireResourceTool(executor, tools.momcPath, 'momc', hooks) : undefined;
  const xcstrings = suffixes.has('.xcstrings') ? await requireResourceTool(executor, tools.xcstringsPath, 'xcstringstool', hooks) : undefined;
  for (const suffix of ['.metal', '.xcmappingmodel', '.mlmodel', '.mlpackage']) {
    if (suffixes.has(suffix)) throw new UserError(`The project requires a ${suffix} compiler that has not been configured for WSL.`, 'Supply compiled runtime resources or add a real Linux compiler for this resource type.');
  }
  const run = (argv: string[], extra: WslRunOptions = {}) => executor.run(argv, { ...hooks, timeoutMs: 600_000, ...extra });
  const minimum = context.settings.IPHONEOS_DEPLOYMENT_TARGET ?? '15.0';
  const moduleName = context.settings.PRODUCT_MODULE_NAME ?? context.targetName.replace(/[^A-Za-z0-9_]/g, '_');
  const resourceBuild = `${context.buildDirectory}/resources/${context.targetName}`;
  await run(['mkdir', '-p', '--', context.productDirectory, resourceBuild]);
  for (const [parent, sources] of catalogs) {
    const output = parent === '.' ? context.productDirectory : `${context.productDirectory}/${parent}`;
    const partial = `${resourceBuild}/assets-${Buffer.from(parent).toString('hex')}.plist`;
    await run(['mkdir', '-p', '--', output]);
    const argv = [actool!, '--compile', output, '--platform', 'iphoneos', '--minimum-deployment-target', minimum,
      '--output-partial-info-plist', partial, '--bundle-identifier', context.settings.PRODUCT_BUNDLE_IDENTIFIER ?? '',
      '--target-device', 'iphone', ...(context.settings.TARGETED_DEVICE_FAMILY?.includes('2') ? ['--target-device', 'ipad'] : [])];
    const cleaned = cleanedCatalogs((await run(['python3', '-c', CLEAN_CATALOGS, resourceBuild, context.settings.ASSETCATALOG_COMPILER_APPICON_NAME ?? '', ...sources])).stdout, sources);
    if (context.settings.ASSETCATALOG_COMPILER_APPICON_NAME && cleaned.appIcon) argv.push('--app-icon', context.settings.ASSETCATALOG_COMPILER_APPICON_NAME);
    if (context.settings.ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME) argv.push('--accent-color', context.settings.ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME);
    await runResourceTool(executor, [...argv, ...cleaned.sources], hooks);
    await run(['python3', '-c', MERGE_RESOURCE_PLIST, context.infoPlistPath ?? `${context.productDirectory}/Info.plist`, partial]);
  }
  // A storyboard or xib to compile: the file itself, or a copy without what CLEAN_INTERFACE leaves out (said in the output).
  const interfaceSource = async (source: string, index: number): Promise<string> => {
    const lines = (await run(['python3', '-c', CLEAN_INTERFACE, source, `${resourceBuild}/interface-sources/${index}/${path.posix.basename(source)}`])).stdout.trim().split('\n');
    const chosen = lines[0]?.trim();
    if (!chosen?.startsWith('/')) return source;
    if (lines[1]?.trim()) hooks.onOutput?.(`capmac note: ${path.posix.basename(source)}: compiled without its labels' ${lines[1].trim().split(' ').join(' and ')}, which the Linux storyboard compiler doesn't read (no change for labels that fit their frames)\n`, 'stdout');
    return chosen;
  };
  for (const [index, entry] of entries.entries()) {
    const suffix = path.posix.extname(entry.source).toLowerCase();
    if (suffix === '.xcassets') continue;
    const destination = `${context.productDirectory}/${entry.destination}`;
    await run(['mkdir', '-p', '--', path.posix.dirname(destination)]);
    if (suffix === '.storyboard') {
      const output = `${resourceBuild}/${entry.destination}`;
      await run(['mkdir', '-p', '--', path.posix.dirname(output)]);
      try {
        await runResourceTool(executor, [ibtool!, '--module', moduleName, '--minimum-deployment-target', minimum, await interfaceSource(entry.source, index), '--compilation-directory', path.posix.dirname(output)], hooks);
      } catch (error) {
        const name = path.posix.basename(entry.source, path.posix.extname(entry.source));
        if (!(error instanceof UserError) || !context.infoPlistPath) throw error;
        const plain = await executor.run(['python3', '-c', PLAIN_LAUNCH_SCREEN, context.infoPlistPath, name], { ...hooks, allowFailure: true });
        if (plain.code !== 0) throw error;
        const why = error.details?.find((line) => /error:/.test(line))?.replace(/^.*?error:\s*(ibtool:\s*)?/, '').replace(/\s*\([^()]*\)\s*$/, '');
        hooks.onOutput?.(`capmac note: ${path.posix.basename(entry.source)} needs what the Linux storyboard compiler can’t build yet${why ? ` (${why})` : ''}: the app gets a plain launch screen instead\n`, 'stdout');
        continue;
      }
      const compiled = `${path.posix.dirname(output)}/${path.posix.basename(entry.source, path.posix.extname(entry.source))}.storyboardc`;
      await run(['python3', '-c', COPY_RESOURCE, compiled, context.productDirectory, entry.destination]);
    } else if (suffix === '.xib') {
      await runResourceTool(executor, [ibtool!, '--module', moduleName, '--minimum-deployment-target', minimum, '--compile', destination, await interfaceSource(entry.source, index)], hooks);
    } else if (suffix === '.xcdatamodel' || suffix === '.xcdatamodeld') {
      await runResourceTool(executor, [momc!, '--sdkroot', context.sdkPath, '--iphoneos-deployment-target', minimum, '--module', moduleName, entry.source, resourceBuild], hooks);
      const compiled = `${resourceBuild}/${path.posix.basename(entry.source).replace(/\.xcdatamodeld$/i, '.momd').replace(/\.xcdatamodel$/i, '.mom')}`;
      await run(['python3', '-c', COPY_RESOURCE, compiled, context.productDirectory, entry.destination]);
    } else if (suffix === '.xcstrings') {
      await runResourceTool(executor, [xcstrings!, 'compile', '--output-directory', path.posix.dirname(destination), entry.source], hooks);
    } else {
      await run(['python3', '-c', COPY_RESOURCE, entry.source, context.productDirectory, entry.destination]);
    }
  }
}

/** Execute project phases in order, with their real scripts and per-phase input/output env. */
export async function runWslScriptPhases(executor: WslExecutor, phases: readonly WslScriptPhase[], context: WslResourceContext, tools: ResourceTools, hooks: ResourceHooks = {}): Promise<void> {
  if (hooks.signal?.aborted) throw new CancelledError();
  checkContext(context);
  for (const phase of phases) {
    if (phase.script.includes('\0')) throw new UserError(`Script phase ${phase.name} contains a NUL character.`);
    const result = await executor.run(['python3', '-c', RUN_SCRIPT_PHASE], {
      ...hooks, timeoutMs: 600_000, allowFailure: true,
      stdin: JSON.stringify({ phase, context, tools, router: TOOL_ROUTER }),
    });
    if (result.code !== 0) throw new UserError(`Native build script failed: ${phase.name}`, 'Check the script output. macOS executables need real Linux replacements; CapMac does not skip failed build phases.', (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-20));
  }
}

/** Explicit setup action; installs only standalone resource tools, never Apple SDKs or xtool. */
export async function installWslResourceTools(executor: WslExecutor, options: ResourceHooks & { swiftPath?: string } = {}): Promise<Required<Pick<WslResourceTools, 'actoolPath' | 'ibtoolPath' | 'momcPath' | 'xcstringsPath'>>> {
  const result = await executor.run(['python3', '-c', INSTALL_RESOURCE_TOOLS, WSL_RESOURCE_TOOLS_REVISION, options.swiftPath ?? 'swift'], {
    signal: options.signal, onOutput: options.onOutput, timeoutMs: 1_800_000,
  });
  let installed: unknown;
  try { installed = JSON.parse(result.stdout.trim()); } catch { throw new UserError('Resource tool setup did not return its installed paths.', 'Review the setup output and retry capmac wsl setup --install-resources.'); }
  const keys = ['actoolPath', 'ibtoolPath', 'momcPath', 'xcstringsPath'] as const;
  if (!installed || typeof installed !== 'object' || keys.some((key) => typeof (installed as Record<string, unknown>)[key] !== 'string' || !(installed as Record<string, string>)[key]!.startsWith('/') || /[\0\r\n]/.test((installed as Record<string, string>)[key]!))) throw new UserError('Resource tool setup returned invalid WSL executable paths.');
  return installed as Required<Pick<WslResourceTools, 'actoolPath' | 'ibtoolPath' | 'momcPath' | 'xcstringsPath'>>;
}
