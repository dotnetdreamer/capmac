/** Real CocoaPods resolution and Xcode project export, entirely inside WSL. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { log, throwIfAborted, type EngineContext } from '../context.js';
import { UserError } from '../errors.js';
import { nodeExecutable, type ProjectInfo } from '../project.js';
import type { WslBuildPlan } from './compiler.js';
import type { WslNativeBuildPlan, WslNativeGraph } from './native-compiler.js';
import type { WslExecutor, WslToolchainTools } from './toolchain.js';
import rubyExporter from './pods-export.rb';

export interface CocoaPodsOptions {
  directory: string;
  executor: WslExecutor;
  tools: WslToolchainTools;
  configuration: string;
  outputDirectory: string;
  signing: WslBuildPlan['signing'];
  liveUrl?: string;
  podPath?: string;
  rubyPath?: string;
  scheme?: string;
  /** Real Xcode metadata, for Podfile hooks that explicitly query the version. */
  xcodeVersion?: string;
}

export interface CocoaPodsReport {
  ready: boolean;
  checks: { name: string; ok: boolean; message: string }[];
}

function executable(value: string | undefined, fallback: string): string {
  const selected = value ?? fallback;
  if (!selected.trim() || /[\0\r\n]/.test(selected)) throw new UserError(`Invalid ${fallback} executable path.`);
  return selected;
}

export async function inspectCocoaPods(
  executor: WslExecutor,
  options: { rubyPath?: string; podPath?: string; signal?: AbortSignal; directory?: string; rootDirectory?: string } = {},
): Promise<CocoaPodsReport> {
  const checks: CocoaPodsReport['checks'] = [];
  let gemfile: string | undefined;
  if (options.directory && !options.podPath) {
    const found = await executor.run(['python3', '-c', String.raw`import pathlib,sys
start=pathlib.Path(sys.argv[1]).resolve(); root=pathlib.Path(sys.argv[2]).resolve()
for directory in [start]+list(start.parents):
 if directory!=root and root not in directory.parents: break
 candidate=directory/'Gemfile'
 if candidate.is_file(): print(candidate); break
`, options.directory, options.rootDirectory ?? options.directory], { signal: options.signal });
    gemfile = found.stdout.trim() || undefined;
  }
  const ruby = executable(options.rubyPath, 'ruby');
  const commands: [string, string[]][] = [
    ['Ruby', [ruby, '--version']],
    ['Git for CocoaPods', ['git', '--version']],
    ['CocoaPods', [executable(options.podPath, 'pod'), '--version', '--allow-root']],
    ['Ruby Xcode project parser', [ruby, '-rxcodeproj', '-e', 'puts Xcodeproj::VERSION']],
    ['CocoaPods network libraries', [ruby, '-rethon', '-e', 'puts "libcurl #{Ethon::Curl.version}"']],
  ];
  for (const [name, command] of commands) {
    const bundled = gemfile && !['Ruby', 'Git for CocoaPods'].includes(name);
    const result = bundled ? await executor.run(['python3', '-c',
      'import json,os,subprocess,sys; r=json.load(sys.stdin); env=os.environ.copy(); env["BUNDLE_GEMFILE"]=r["gemfile"]; sys.exit(subprocess.run(r["argv"],cwd=r["directory"],env=env).returncode)',
    ], { signal: options.signal, allowFailure: true, timeoutMs: 30_000, stdin: JSON.stringify({ argv: [ruby, '-S', 'bundle', 'exec', ...command], gemfile, directory: options.directory }) }) :
      await executor.run(command, { signal: options.signal, allowFailure: true, timeoutMs: 30_000 });
    checks.push({ name, ok: result.code === 0, message: result.code === 0 ? result.stdout.trim() : bundled ?
      `Install the project's Ruby gems with bundle install in ${path.posix.dirname(gemfile!)} inside ${executor.distro}. ${result.stderr.trim()}` :
      `Install Ruby, Git, libcurl and CocoaPods in ${executor.distro}: gem install cocoapods --no-document. ${result.stderr.trim()}` });
  }
  return { ready: checks.every((check) => check.ok), checks };
}

// Every file that CocoaPods or a Podfile/prepare_command can edit is copied.
// Development pods and node_modules are never symlinked to the user's tree.
// The mirror retains its Pods sandbox and downloads across repeated builds.
export const RESOLVE_PODS = String.raw`import json,os,pathlib,plistlib,shutil,subprocess,sys
r=json.loads(sys.stdin.read())
source=pathlib.Path(r['source']).resolve(strict=True)
workspace=pathlib.Path(r['workspace']).resolve()
if source==workspace or source in workspace.parents and '.capmac' not in workspace.relative_to(source).parts:
 raise SystemExit('The CocoaPods mirror must be outside the source or inside its .capmac directory')
workspace.mkdir(parents=True,exist_ok=True)
marker=workspace/'.capmac-pods-workspace'
if marker.exists() and marker.read_text()!=str(source): raise SystemExit('The CocoaPods mirror belongs to a different source project')
if not marker.exists() and any(workspace.iterdir()): raise SystemExit('Refusing to reuse an unmarked CocoaPods workspace')
marker.write_text(str(source))
exclude={'.git','.capmac','.cache','DerivedData','.gradle','.kotlin','.cxx','.build','__pycache__',
 '.pilot','.playwright-mcp','.replay-evidence','.ota-out','.webos-out','.tmp'}
def ignored(name,relative):
 parts=relative.split('/')
 return name in exclude or name=='build' and 'android' in parts and 'node_modules' not in parts or 'electron' in parts and 'node_modules' not in parts and name in ['node_modules','app','build','dist','release'] or name=='Pods' and (relative==r['podRelative'] or relative.startswith(r['podRelative']+'/'))
def remove(destination):
 if destination.is_dir() and not destination.is_symlink(): shutil.rmtree(destination)
 else: destination.unlink(missing_ok=True)
def mirror(src,dst,relative='',ancestors=()):
 real=src.resolve(strict=True)
 if real in ancestors: raise SystemExit('A source symlink creates a directory cycle: '+str(src))
 if src.is_dir():
  if dst.exists() and (not dst.is_dir() or dst.is_symlink()): remove(dst)
  dst.mkdir(parents=True,exist_ok=True)
  children={item.name:item for item in src.iterdir() if not ignored(item.name,relative)}
  for child in list(dst.iterdir()):
   if child.name=='.capmac-pods-workspace' or ignored(child.name,relative): continue
   if child.name not in children: remove(child)
  for name,item in children.items(): mirror(item,dst/name,'/'.join(filter(None,[relative,name])),ancestors+(real,))
 elif src.is_file():
  if dst.exists() and (dst.is_dir() or dst.is_symlink()): remove(dst)
  a=src.stat(); b=dst.stat() if dst.exists() else None
  if b is None or a.st_size!=b.st_size or a.st_mtime_ns!=b.st_mtime_ns: shutil.copy2(src,dst)
 else: raise SystemExit('Unsupported file in CocoaPods input: '+str(src))
if r['phase']=='mirror':
 mirror(source,workspace)
 sys.exit(0)
pod_dir=(workspace/r['podRelative']).resolve(strict=True)
if workspace not in pod_dir.parents: raise SystemExit('Podfile path escapes the isolated workspace')
environment=os.environ.copy()
environment['COCOAPODS_DISABLE_STATS']='true'
# Some hooks only ask xcodebuild for SDK/version metadata. Supply genuine
# supplied metadata for those queries, and reject build commands explicitly.
sdk=pathlib.Path(r['sdkPath'])
version=r.get('xcodeVersion')
build=''
for ancestor in sdk.parents:
 if ancestor.name!='Contents' or not ancestor.parent.name.endswith('.app'): continue
 metadata=ancestor/'version.plist'
 if metadata.is_file():
  with metadata.open('rb') as handle: info=plistlib.load(handle)
  version=version or info.get('CFBundleShortVersionString')
  build=info.get('ProductBuildVersion','')
  break
if version:
 metadata_directory=workspace.parent/'metadata-tools'; metadata_directory.mkdir(exist_ok=True)
 settings={}
 for name in ['SDKSettings.plist','SDKSettings.json']:
  metadata=sdk/name
  if metadata.is_file():
   with metadata.open('rb') as handle: settings=json.load(handle) if name.endswith('.json') else plistlib.load(handle)
   break
 sdk_version=settings.get('Version','')
 shim=metadata_directory/'xcodebuild'
 shim.write_text('\n'.join(['#!/usr/bin/env python3','import json,sys',
  'v,b,s=json.loads('+repr(json.dumps([version,build,sdk_version]))+')',
  'if sys.argv[1:]==["-version"]: print("Xcode "+v+"\\nBuild version "+b)',
  'elif sys.argv[1:]==["-showsdks"] and s: print("iOS "+s+" -sdk iphoneos"+s)',
  'else: sys.exit("CapMac only supplies SDK/version metadata; this script requests an Xcode build operation that needs a WSL implementation.")','']))
 shim.chmod(0o755)
 environment['PATH']=str(metadata_directory)+os.pathsep+environment.get('PATH','')
gemfile=None
for candidate in [pod_dir]+list(pod_dir.parents):
 if candidate!=workspace and workspace not in candidate.parents: break
 file=candidate/'Gemfile'
 if file.is_file(): gemfile=file; break
command=[r['podPath'],'install','--allow-root']
export_command=[r['rubyPath'],str(pathlib.Path(r['exporter']))]
if gemfile is not None and not r['explicitPodPath']:
 environment['BUNDLE_GEMFILE']=str(gemfile)
 subprocess.run([r['rubyPath'],'-S','bundle','check'],cwd=pod_dir,env=environment,check=True)
 command=[r['rubyPath'],'-S','bundle','exec']+command
 export_command=[r['rubyPath'],'-S','bundle','exec']+export_command
# skipInstall: the caller restored the last install's files; exit 75 if CocoaPods' sandbox doesn't match them.
if r.get('skipInstall'):
 manifest=pod_dir/'Pods'/'Manifest.lock'; lock=pod_dir/'Podfile.lock'
 if not manifest.is_file() or not lock.is_file() or manifest.read_bytes()!=lock.read_bytes(): sys.exit(75)
else: subprocess.run(command,cwd=pod_dir,env=environment,check=True)
request={'projectRoot':str(workspace),'podDirectory':str(pod_dir),'configuration':r['configuration'],
 'sdkPath':str(sdk),'scheme':r.get('scheme'),'output':r['output'],'liveUrl':r.get('liveUrl'),
 'webDirectory':str(workspace/r['webRelative']),'xcodeVersion':version,'xcodeBuild':build}
subprocess.run(export_command,input=json.dumps(request),text=True,cwd=pod_dir,env=environment,check=True)
`;

// Use the installed Capacitor CLI to generate plugin registration, Cordova
// podspecs/native files, web assets and runtime config. Only its Mac-native
// pod-install/clean calls are deferred to our actual WSL CocoaPods step.
const SYNC_CAPACITOR = String.raw`const path=require('node:path');
const cliRoot=process.argv[1];
const subprocess=require(path.join(cliRoot,'dist/util/subprocess.js'));
const installed=subprocess.isInstalled;
const run=subprocess.runCommand;
subprocess.isInstalled=async function(command,...args) {
 if (command==='pod'||command==='xcodebuild') return false;
 return installed.call(this,command,...args);
};
subprocess.runCommand=async function(command,args,...rest) {
 if ((command==='bundle'&&args[0]==='exec'&&args[1]==='pod'&&args[2]==='install')||
     (command==='xcodebuild'&&args.includes('clean'))) return '';
 return run.call(this,command,args,...rest);
};
(async()=>{
 const config=await require(path.join(cliRoot,'dist/config.js')).loadConfig();
 if ((await config.ios.packageManager==='SPM')!==(process.argv[2]==='SPM')) throw Error('The isolated iOS package manager does not match the selected backend.');
 // Capacitor emits local Swift package paths with path.relative(). Windows
 // separators are invalid Swift string escapes and are not Linux paths.
 if (process.argv[2]==='SPM') {
  const relative=path.relative;
  path.relative=(from,to)=>{ const result=relative(from,to); return from===config.ios.nativeXcodeProjDirAbs?result.split(path.sep).join('/'):result; };
  const join=path.join;
  path.join=(...parts)=>parts[0]==='symlinks'?parts.join('/'):join(...parts);
 }
 await require(path.join(cliRoot,'dist/tasks/sync.js')).syncCommand(config,'ios',false);
})().catch(error=>{ console.error(error.stack||error);process.exitCode=1; });`;

export async function syncMirroredCapacitor(project: ProjectInfo, workspace: string, ctx: EngineContext, signal: AbortSignal, packageManager = 'Cocoapods'): Promise<void> {
  const relative = path.relative(project.syncRoot, project.capDir);
  const cwd = path.join(workspace, relative);
  let cli: string | undefined;
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', '@capacitor', 'cli');
    if (existsSync(path.join(candidate, 'package.json'))) { cli = candidate; break; }
    if (directory === workspace || path.dirname(directory) === directory) break;
  }
  if (!cli) throw new UserError('The isolated workspace has no installed Capacitor CLI.', 'Install project dependencies before building with WSL.');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(nodeExecutable(), ['-e', SYNC_CAPACITOR, cli!, packageManager], {
      cwd, signal, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    }, (error, _stdout, stderr) => {
      if (signal.aborted) { try { throwIfAborted(signal); } catch (cancelled) { reject(cancelled); } }
      else if (error) reject(new UserError('Capacitor could not sync the isolated iOS project.', 'Check the project Capacitor configuration and plugin output.', stderr.trim().split(/\r?\n/).slice(-20)));
      else resolve();
    });
    child.stdout?.on('data', (text: Buffer) => ctx.emit({ type: 'tool-output', text: text.toString(), stream: 'stdout' }));
    child.stderr?.on('data', (text: Buffer) => ctx.emit({ type: 'tool-output', text: text.toString(), stream: 'stderr' }));
  });
}

/**
 * Reuse the isolated, incremental native workspace for either dependency manager.
 * `skipTop`: the project's own folders no iOS build reads (a React Native app's windows/ and android/).
 */
export async function mirrorWslWorkspace(project: ProjectInfo, directory: string, executor: WslExecutor, signal: AbortSignal, skipTop: string[] = []): Promise<{ workspace: string; workspaceWsl: string }> {
  await fs.mkdir(directory, { recursive: true });
  const fingerprint = createHash('sha256').update(path.resolve(project.syncRoot)).digest('hex').slice(0, 12);
  const workspace = path.join(directory, `workspace-${fingerprint}`);
  const [source, workspaceWsl] = await Promise.all([executor.path(project.syncRoot, signal), executor.path(workspace, signal)]);
  const ios = path.relative(project.syncRoot, path.resolve(project.capDir, project.iosDir)).split(path.sep).join('/');
  const skipped = skipTop.map((name) => [project.projectRel, name].filter(Boolean).join('/'));
  if (process.platform === 'win32') await mirrorWindowsWorkspace(project.syncRoot, workspace, source, ios, signal, skipped);
  else await executor.run(['python3', '-c', RESOLVE_PODS], { signal, timeoutMs: 10 * 60_000,
    stdin: JSON.stringify({ phase: 'mirror', source, workspace: workspaceWsl, podRelative: ios }) });
  return { workspace, workspaceWsl };
}

// Windows filesystem access avoids the per-file DrvFS round trip when both
// source and isolated copy live on NTFS. Native hooks still run only in WSL.
async function mirrorWindowsWorkspace(source: string, workspace: string, owner: string, ios: string, signal: AbortSignal, skipped: string[] = []): Promise<void> {
  source = await fs.realpath(source); workspace = path.resolve(workspace);
  const relative = path.relative(source, workspace);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative) && !relative.split(path.sep).includes('.capmac'))) throw new UserError('The isolated workspace must be outside the source or inside its .capmac directory.');
  await fs.mkdir(workspace, { recursive: true });
  const marker = path.join(workspace, '.capmac-pods-workspace');
  if (existsSync(marker)) {
    if (await fs.readFile(marker, 'utf8') !== owner) throw new UserError('The isolated workspace belongs to another source project.');
  } else {
    if ((await fs.readdir(workspace)).length) throw new UserError('Refusing to reuse an unmarked native workspace.');
    await fs.writeFile(marker, owner);
  }
  const excluded = new Set(['.git', '.capmac', '.cache', 'DerivedData', '.gradle', '.kotlin', '.cxx', '.build', '__pycache__', '.pilot', '.playwright-mcp', '.replay-evidence', '.ota-out', '.webos-out', '.tmp']);
  const ignored = (name: string, parent: string): boolean => {
    const parts = parent.split('/');
    return excluded.has(name) || skipped.includes([parent, name].filter(Boolean).join('/')) || name === 'build' && parts.includes('android') && !parts.includes('node_modules') ||
      parts.includes('electron') && !parts.includes('node_modules') && ['node_modules', 'app', 'build', 'dist', 'release'].includes(name) ||
      parts.includes('node_modules') && ['.vite', '.remotion'].includes(name) ||
      name === 'Pods' && (parent === ios || parent.startsWith(ios + '/'));
  };
  let active = 0; const waiting: (() => void)[] = [];
  const limited = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= 32) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try { throwIfAborted(signal); return await operation(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
  const remove = async (destination: string): Promise<void> => {
    const child = path.relative(workspace, destination);
    if (!child || child.startsWith('..') || path.isAbsolute(child)) throw new UserError('Refusing to remove a path outside the isolated workspace.');
    await limited(() => fs.rm(destination, { recursive: true, force: true }));
  };
  const mirror = async (src: string, dst: string, parent: string, ancestors: readonly string[]): Promise<void> => {
    const real = await limited(() => fs.realpath(src));
    if (ancestors.includes(real)) throw new UserError(`A source symlink creates a directory cycle: ${src}`);
    const [input, previous] = await Promise.all([limited(() => fs.stat(src)), limited(() => fs.lstat(dst).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; }))]);
    if (input.isDirectory()) {
      if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) await remove(dst);
      await limited(() => fs.mkdir(dst, { recursive: true }));
      const children = (await limited(() => fs.readdir(src))).filter((name) => !ignored(name, parent));
      const names = new Set(children);
      for (const child of await limited(() => fs.readdir(dst))) {
        if (child !== '.capmac-pods-workspace' && !ignored(child, parent) && !names.has(child)) await remove(path.join(dst, child));
      }
      await Promise.all(children.map((name) => mirror(path.join(src, name), path.join(dst, name), [parent, name].filter(Boolean).join('/'), [...ancestors, real])));
    } else if (input.isFile()) {
      if (previous && (previous.isDirectory() || previous.isSymbolicLink())) await remove(dst);
      if (!previous || previous.isDirectory() || previous.isSymbolicLink() || previous.size !== input.size || Math.abs(previous.mtimeMs - input.mtimeMs) >= 0.001) {
        await limited(async () => { await fs.copyFile(src, dst); await fs.utimes(dst, input.atimeMs / 1000, input.mtimeMs / 1000); });
      }
    } else throw new UserError(`Unsupported file in the isolated native input: ${src}`);
  };
  await mirror(source, workspace, '', []);
}

/** Locate the actual Podfile instead of assuming the default ios/App layout. */
export async function findCocoaPodsDirectory(project: ProjectInfo): Promise<string> {
  const ios = path.resolve(project.capDir, project.iosDir);
  const pending = [ios];
  const found: string[] = [];
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index]!;
    if (existsSync(path.join(directory, 'Podfile'))) { found.push(directory); continue; }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !['Pods', 'build', '.git'].includes(entry.name) && !entry.name.endsWith('.xcodeproj')) pending.push(path.join(directory, entry.name));
    }
  }
  if (found.length !== 1) throw new UserError(found.length ? 'The iOS platform contains multiple Podfiles.' : 'The iOS platform has no Podfile.',
    found.length ? 'Select a platform with one application Podfile.' : 'Generate or sync the CocoaPods iOS platform with the Capacitor CLI first.');
  return found[0]!;
}

export async function prepareCocoaPodsProject(
  project: ProjectInfo,
  options: CocoaPodsOptions,
  ctx: EngineContext,
  signal: AbortSignal,
): Promise<WslNativeBuildPlan> {
  throwIfAborted(signal);
  const podDirectory = await findCocoaPodsDirectory(project);
  const relative = path.relative(project.syncRoot, podDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new UserError('The Podfile is outside the project sync root.', 'Use a common workspace root containing the application and its local dependencies.');
  const webRelative = path.relative(project.syncRoot, path.resolve(project.capDir, project.webDir));
  if (webRelative.startsWith('..') || path.isAbsolute(webRelative)) throw new UserError('The web assets are outside the project sync root.');
  const [podWsl, rootWsl] = await Promise.all([options.executor.path(podDirectory, signal), options.executor.path(project.syncRoot, signal)]);
  const report = await inspectCocoaPods(options.executor, { rubyPath: options.rubyPath, podPath: options.podPath, signal, directory: podWsl, rootDirectory: rootWsl });
  if (!report.ready) throw new UserError('The WSL CocoaPods toolchain is not ready.', 'Install Ruby and CocoaPods inside WSL, then run capmac wsl doctor.', report.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.message}`));
  await fs.mkdir(options.directory, { recursive: true });
  const exporter = path.join(options.directory, 'pods-export.rb');
  const output = path.join(options.directory, 'native-graph.json');
  await fs.writeFile(exporter, rubyExporter);
  const fingerprint = createHash('sha256').update(path.resolve(project.syncRoot)).digest('hex').slice(0, 12);
  const workspace = path.join(options.directory, `workspace-${fingerprint}`);
  const [sourceWsl, workspaceWsl, exporterWsl, outputWsl, sdkPath] = await Promise.all([
    options.executor.path(project.syncRoot, signal), options.executor.path(workspace, signal),
    options.executor.path(exporter, signal), options.executor.path(output, signal), options.executor.path(options.tools.sdkPath, signal),
  ]);
  log(ctx, 'info', 'Resolving CocoaPods in an isolated workspace, preserving the Podfile, lockfile, native app, and install hooks.');
  const request = { source: sourceWsl, workspace: workspaceWsl, podRelative: relative.split(path.sep).join('/'),
    exporter: exporterWsl, output: outputWsl, sdkPath, configuration: options.configuration,
    scheme: options.scheme ?? project.scheme, liveUrl: options.liveUrl, xcodeVersion: options.xcodeVersion,
    webRelative: webRelative.split(path.sep).join('/'), explicitPodPath: options.podPath !== undefined,
    rubyPath: executable(options.rubyPath, 'ruby'), podPath: executable(options.podPath, 'pod') };
  await mirrorWslWorkspace(project, options.directory, options.executor, signal);
  await syncMirroredCapacitor(project, workspace, ctx, signal);
  await options.executor.run(['python3', '-c', RESOLVE_PODS], {
    signal, timeoutMs: 30 * 60_000,
    onOutput: (text, stream) => ctx.emit({ type: 'tool-output', text, stream }),
    stdin: JSON.stringify({ ...request, phase: 'resolve' }),
  });
  throwIfAborted(signal);
  let graph: WslNativeGraph;
  try {
    graph = JSON.parse(await fs.readFile(output, 'utf8')) as WslNativeGraph;
    if (graph.version !== 1 || !graph.rootTargetId || !Array.isArray(graph.targets) || !graph.targets.some((target) => target.id === graph.rootTargetId)) throw new Error('Missing application target.');
  } catch (error) { throw new UserError('CocoaPods did not produce a valid native project graph.', 'Check the CocoaPods and Ruby exporter output.', [(error as Error).message]); }
  return { graph, outputDirectory: options.outputDirectory, signing: options.signing };
}
