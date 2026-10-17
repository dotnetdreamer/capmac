/**
 * A React Native app's iOS app, built on this PC with no Mac (in CapMac's WSL
 * distro). CocoaPods resolves the app's native libraries there, with React
 * Native's prebuilt core (React.xcframework and its dependencies, from React
 * Native's own release on Maven, as RCT_USE_PREBUILT_RNCORE asks), so only
 * the app and its native modules compile; CapMac's builder compiles them like
 * any app. A debug build loads its JavaScript from Metro on this PC over
 * Wi-Fi (Fast Refresh on the iPhone); a release build carries the bundle that
 * Metro and Hermes make on this PC.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, throwIfAborted, withStep, type EngineContext } from '../context.js';
import { CancelledError, UserError } from '../errors.js';
import { stripAnsi } from '../format.js';
import { LOCKFILES, nodeExecutable, requireReactNative, type ProjectInfo } from '../project.js';
import type { ReactNativeAppleApp } from '../react-native/project.js';
import type { WslBuildPlan } from './compiler.js';
import { inspectCocoaPods, mirrorWslWorkspace, RESOLVE_PODS } from './cocoapods.js';
import type { WslNativeBuildPlan, WslNativeGraph, WslNativeTarget } from './native-compiler.js';
import rubyExporter from './pods-export.rb';
import type { WslExecutor, WslToolchainTools } from './toolchain.js';

/**
 * Where a React Native app's builds on this PC keep their files: outside the
 * project, because Metro watches the project's folder while the app runs,
 * and the files WSL writes (Linux symlinks in frameworks) can't be read from
 * Windows, which stops Metro's watcher.
 */
export function reactNativeWorkDir(project: Pick<ProjectInfo, 'projectId'>): string {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.local', 'share');
  return path.join(base, process.platform === 'win32' ? 'CapMac' : 'capmac', 'wsl-builds', project.projectId);
}

/** The Node.js CapMac puts in its WSL distro: CocoaPods and React Native's build scripts run it there. */
export const WSL_NODE_VERSION = '24.11.1';

/**
 * macOS's ditto, as CocoaPods' script for a Swift static library's headers
 * (and other build scripts) copy with it: `ditto SRC... DST` makes DST's
 * folders and merges a folder's contents into DST (keeping the links inside),
 * and a link named as SRC is followed (CocoaPods' public headers are links).
 * Archives (-c, -x) aren't copies: it stops on those, and on any option it
 * doesn't know.
 */
const DITTO = String.raw`#!/usr/bin/env python3
import os,shutil,sys
quiet={'-V','-v','--rsrc','--norsrc','--extattr','--noextattr','--qtn','--noqtn','--acl','--noacl','--nocache','--hfsCompression','--nohfsCompression','--preserveHFSCompression','--nopreserveHFSCompression'}
args=[]
for arg in sys.argv[1:]:
 if arg in quiet: continue
 if arg.startswith('-'): sys.exit('ditto (CapMac): only copies files and folders here; '+arg+' is not supported')
 args.append(arg)
if len(args)<2: sys.exit('usage: ditto src ... dst')
*sources,dst=args
for src in sources:
 if os.path.isdir(src):
  shutil.copytree(src,dst,symlinks=True,dirs_exist_ok=True); continue
 target=os.path.join(dst,os.path.basename(src)) if len(sources)>1 or os.path.isdir(dst) else dst
 os.makedirs(os.path.dirname(os.path.abspath(target)),exist_ok=True)
 if os.path.islink(target) or os.path.isfile(target): os.remove(target)
 shutil.copy2(src,target)
`;

/**
 * Installs Node.js in the distro once (~/.local/share/capmac/node/<version>),
 * from nodejs.org, checked against its published SHA-256, and the small
 * programs macOS has that React Native's Podfile and CocoaPods' scripts run
 * (`command`: macOS ships POSIX's built-in utilities as programs too, Ubuntu
 * only in its shells; `ditto`, $2: see DITTO).
 * Prints `node=<its bin folder>` and `shims=<the programs' folder>`.
 */
const INSTALL_NODE = String.raw`set -eu
version="$1"; arch="$(uname -m)"
case "$arch" in x86_64) node_arch=x64 ;; aarch64|arm64) node_arch=arm64 ;; *) echo "capmac: unsupported CPU $arch" >&2; exit 3 ;; esac
shims="$HOME/.local/share/capmac/macos-shims"; mkdir -p "$shims"
printf '#!/bin/sh\ncommand "$@"\n' > "$shims/command.tmp" && chmod 755 "$shims/command.tmp" && mv "$shims/command.tmp" "$shims/command"
printf '%s' "$2" > "$shims/ditto.tmp" && chmod 755 "$shims/ditto.tmp" && mv "$shims/ditto.tmp" "$shims/ditto"
root="$HOME/.local/share/capmac/node"; dir="$root/$version"
if [ -x "$dir/bin/node" ] && "$dir/bin/node" --version >/dev/null 2>&1; then printf 'node=%s\nshims=%s\n' "$dir/bin" "$shims"; exit 0; fi
name="node-v$version-linux-$node_arch"
work="$(mktemp -d "$root.XXXXXX" 2>/dev/null || { mkdir -p "$root"; mktemp -d "$root/.dl.XXXXXX"; })"
trap 'rm -rf "$work"' EXIT
echo "capmac: Downloading Node.js $version" >&2
curl -fsSL "https://nodejs.org/dist/v$version/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
curl -fsSL "https://nodejs.org/dist/v$version/$name.tar.xz" -o "$work/$name.tar.xz"
(cd "$work" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c - >&2)
mkdir -p "$root"; tar -xJf "$work/$name.tar.xz" -C "$work" --no-same-owner
rm -rf "$dir"; mv "$work/$name" "$dir"
"$dir/bin/node" --version >&2
printf 'node=%s\nshims=%s\n' "$dir/bin" "$shims"
`;

/** Node.js and the macOS-like programs in the distro (see INSTALL_NODE). */
export interface WslNode {
  /** Node.js's bin folder. */
  bin: string;
  /** The folders React Native's scripts need first on PATH. */
  path: string;
}

/** The PATH React Native's scripts and CocoaPods run with in the distro. */
export const wslNodePath = (node: WslNode) => `${node.path}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

export async function ensureWslNode(executor: WslExecutor, ctx: EngineContext, signal: AbortSignal): Promise<WslNode> {
  const result = await withStep(ctx, `Preparing Node.js ${WSL_NODE_VERSION} in WSL`, 'deps', (step) => executor.run(['bash', '-c', INSTALL_NODE, 'capmac-node', WSL_NODE_VERSION, DITTO], {
    signal, timeoutMs: 15 * 60_000, allowFailure: true,
    onOutput: (text, stream) => {
      for (const line of text.split('\n')) {
        const own = /^capmac: (.+)$/.exec(line.trim());
        if (own) step.update(own[1]!);
      }
      ctx.emit({ type: 'tool-output', text, stream });
    },
  }));
  const bin = /^node=(\/.+)$/m.exec(result.stdout)?.[1]?.trim();
  const shims = /^shims=(\/.+)$/m.exec(result.stdout)?.[1]?.trim();
  if (result.code !== 0 || !bin || !shims) throw new UserError('Node.js could not be installed in CapMac’s WSL distro.', 'Check this PC’s internet connection, then try again.', result.stderr.trim().split(/\r?\n/).slice(-10));
  return { bin, path: `${bin}:${shims}` };
}

export interface WslReactNativeOptions {
  executor: WslExecutor;
  tools: WslToolchainTools;
  /** Where CapMac keeps this build's files on Windows (the CocoaPods workspace, the graph, the bundle). */
  directory: string;
  outputDirectory: string;
  signing: WslBuildPlan['signing'];
  configuration: string;
  rubyPath?: string;
  podPath?: string;
  xcodeVersion?: string;
}

const isDebug = (configuration: string) => /debug/i.test(configuration);

function resolveFrom(dir: string, request: string): string | null {
  for (let probe = dir; ; probe = path.dirname(probe)) {
    const candidate = path.join(probe, 'node_modules', ...request.split('/'));
    if (existsSync(candidate)) return candidate;
    if (path.dirname(probe) === probe) return null;
  }
}

/** Runs a Node.js tool on this PC, its lines as the step's output. */
function runNode(args: string[], cwd: string, ctx: EngineContext, signal: AbortSignal, onLine?: (line: string) => void): Promise<{ code: number | null; tail: string[] }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(args[0] === 'node' ? nodeExecutable() : args[0]!, args.slice(1), { cwd, env, windowsHide: true });
    const tail: string[] = [];
    const onData = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const line = stripAnsi(raw).trimEnd();
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 60) tail.shift();
        ctx.emit({ type: 'tool-output', stream: 'stdout', text: line });
        onLine?.(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new CancelledError());
      else resolve({ code, tail });
    });
  });
}

/**
 * A release build's JavaScript, made on this PC as React Native's Xcode
 * script makes it on a Mac: Metro bundles it (with the app's images), then
 * Hermes compiles it to bytecode. Returns the folder holding main.jsbundle
 * and assets/.
 */
export async function bundleReactNativeOnPc(project: ProjectInfo, directory: string, ctx: EngineContext, signal: AbortSignal): Promise<string> {
  const cli = resolveFrom(project.capDir, 'react-native/cli.js');
  if (!cli) throw new UserError('React Native is not installed in this project on this PC.', `Run \`${project.packageManager} install\`, then try again.`);
  const out = path.join(directory, 'bundle');
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  const entry = ['index.ios.js', 'index.js', 'index.ts', 'index.tsx'].find((name) => existsSync(path.join(project.capDir, name))) ?? 'index.js';
  const source = path.join(directory, 'main.jsbundle.js');
  await withStep(ctx, 'Bundling the JavaScript on this PC (react-native bundle)', 'build', async (step) => {
    const result = await runNode(['node', cli, 'bundle', '--entry-file', entry, '--platform', 'ios', '--dev', 'false', '--reset-cache', '--bundle-output', source, '--assets-dest', out, '--minify', 'false'], project.capDir, ctx, signal, (line) => step.update(line.slice(0, 140)));
    if (result.code !== 0) throw new UserError('Metro could not bundle the app’s JavaScript.', 'Fix the errors above, then build again.', result.tail.slice(-20));
  });
  const hermesc = [resolveFrom(project.capDir, 'hermes-compiler/hermesc/win64-bin/hermesc.exe'), resolveFrom(project.capDir, 'react-native/sdks/hermesc/win64-bin/hermesc.exe')].find(Boolean);
  if (!hermesc) {
    // React Native without Hermes (or an older one): the app runs the plain bundle.
    log(ctx, 'note', 'No Hermes compiler in node_modules: the app carries plain JavaScript.');
    await fs.copyFile(source, path.join(out, 'main.jsbundle'));
    return out;
  }
  await withStep(ctx, 'Compiling the JavaScript for Hermes', 'build', async () => {
    const result = await runNode([hermesc, '-emit-binary', '-max-diagnostic-width=80', '-O', '-out', path.join(out, 'main.jsbundle'), source], project.capDir, ctx, signal);
    if (result.code !== 0) throw new UserError('Hermes could not compile the JavaScript bundle.', undefined, result.tail.slice(-20));
  });
  return out;
}

/** The app target React Native's template makes: the one whose build phase bundles the JavaScript. */
function appTarget(graph: WslNativeGraph): WslNativeTarget {
  const root = graph.targets.find((target) => target.id === graph.rootTargetId);
  if (!root) throw new UserError('The native project has no app target.');
  return root;
}

/**
 * Settles the build for this PC: every script runs with the distro's Node.js
 * (React Native's scripts and CocoaPods' read $NODE_BINARY or find `node`),
 * and the app's own bundling phase stands down: Metro serves a debug build,
 * and a release build gets the bundle made on this PC as resources.
 * React Native leaves RCT_METRO_PORT undefined unless you set it, which Xcode
 * reads as empty (and React Native as 8081); this builder needs it defined.
 * React Native's prebuilt folly (RCT_USE_RN_DEP) is built without C++
 * coroutines and has no folly/coro headers, so every C++ file has to agree:
 * some native modules' own folly flags (async-storage 2's) leave that out.
 */
export function adaptReactNativeGraph(graph: WslNativeGraph, node: WslNode, bundleDir: string | null): WslNativeGraph {
  for (const target of graph.targets) {
    const cpp = target.settings.OTHER_CPLUSPLUSFLAGS;
    target.settings = {
      RCT_METRO_PORT: '', ...target.settings, PATH: wslNodePath(node), NODE_BINARY: `${node.bin}/node`,
      OTHER_CPLUSPLUSFLAGS: [...(Array.isArray(cpp) ? cpp : [cpp ?? '$(inherited)']), '-DFOLLY_CFG_NO_COROUTINES=1'],
    };
  }
  const app = appTarget(graph);
  app.settings = { ...app.settings, SKIP_BUNDLING: '1', SKIP_BUNDLING_METRO_IP: '1' };
  if (bundleDir) {
    app.resources = [...app.resources, { source: path.join(bundleDir, 'main.jsbundle'), destination: 'main.jsbundle' }];
    if (existsSync(path.join(bundleDir, 'assets'))) app.resources.push({ source: path.join(bundleDir, 'assets'), destination: 'assets' });
  }
  return graph;
}

/**
 * React Native's Pods hold a gigabyte of prebuilt frameworks and thousands of
 * headers: written to and read from the Windows disk through WSL they take
 * minutes, on WSL's own disk seconds. A folder there (one per project, kept
 * between builds) is mounted on the workspace's ios/Pods. Not a link:
 * CocoaPods writes paths relative to where Pods really is, and `..` from a
 * link climbs from somewhere else; from a mount it climbs back to ios/.
 * Files can't be renamed into a mount from elsewhere, so pod install's
 * temporary files go in it too (PODS_TMP).
 */
const PODS_TMP = '.capmac-tmp';
const MOUNT_PODS = String.raw`import os,subprocess,sys
pods=os.path.join(sys.argv[1],'Pods'); target=os.path.join(os.path.expanduser('~'),'.cache','capmac','rn-pods',sys.argv[2])
os.makedirs(os.path.join(target,'${PODS_TMP}'),exist_ok=True)
if os.path.ismount(pods):
 a=os.stat(pods); b=os.stat(target)
 if (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino): sys.exit(0)
 subprocess.run(['umount','-l',pods],check=True)
if os.path.islink(pods): os.unlink(pods)
os.makedirs(pods,exist_ok=True)
subprocess.run(['mount','--bind',target,pods],check=True)
`;

/** Unmounts the Pods folders mounted under `inputs` and deletes the project's Pods from WSL's disk. */
const DROP_PODS = String.raw`import os,re,shutil,subprocess,sys
inputs=sys.argv[1].rstrip('/')+'/'
for line in reversed(open('/proc/self/mountinfo').read().splitlines()):
 point=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),line.split(' ')[4])
 if point.startswith(inputs): subprocess.run(['umount','-l',point])
shutil.rmtree(os.path.join(os.path.expanduser('~'),'.cache','capmac','rn-pods',sys.argv[2]),ignore_errors=True)
`;

async function podsOnLinuxDisk(iosDir: string, projectId: string, executor: WslExecutor, signal: AbortSignal): Promise<void> {
  // What an earlier build left in a Pods folder on the Windows disk goes first, from Windows (far quicker than through WSL).
  // Windows doesn't see the mount: a mounted Pods looks empty from here.
  const pods = path.join(iosDir, 'Pods');
  const st = await fs.lstat(pods).catch(() => null);
  if (st?.isDirectory() && !st.isSymbolicLink()) {
    for (const name of await fs.readdir(pods)) await fs.rm(path.join(pods, name), { recursive: true, force: true });
  }
  await executor.run(['python3', '-c', MOUNT_PODS, await executor.path(iosDir, signal), projectId], { signal, timeoutMs: 60_000 });
}

/**
 * pod install takes minutes here (React Native's codegen, a Pods project of
 * some 80 targets), and what it makes changes only with what it reads: the
 * Podfile and its lock, the app's Xcode project, the packages (their lockfile
 * and patches), local packages' podspecs and native files, and CapMac's own
 * scripts. While none of those change, the Pods it made stay on WSL's disk,
 * and the files it wrote next to the Podfile (the app's Xcode project, the
 * workspace, Podfile.lock, React Native's generated code), kept in
 * PODS_STATE, go back into the workspace instead of running it again.
 */
const PODS_STATE = 'pods-state';
const NATIVE_FILE = /\.(podspec|h|hh|hpp|m|mm|c|cc|cpp|swift|modulemap|xcframework|framework|a|xcprivacy)$/i;

interface PodsState { inputs: string; written: string[]; removed: string[] }

/** The packages a workspace links into node_modules (its own, not installed ones). */
async function linkedPackages(dirs: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of dirs) {
    const modules = path.join(dir, 'node_modules');
    for (const name of await fs.readdir(modules).catch(() => [] as string[])) {
      const names = name.startsWith('@') ? (await fs.readdir(path.join(modules, name)).catch(() => [] as string[])).map((child) => `${name}/${child}`) : [name];
      for (const pkg of names) {
        const full = path.join(modules, pkg);
        if ((await fs.lstat(full).catch(() => null))?.isSymbolicLink()) found.add(await fs.realpath(full).catch(() => full));
      }
    }
  }
  return [...found].sort();
}

/** A local package's native files (their names: CocoaPods finds them when it installs), apart from other platforms' and built ones. */
async function nativeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (['node_modules', '.git', 'android', 'windows', 'build', 'Pods'].includes(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (NATIVE_FILE.test(entry.name)) out.push(child);
      else if (entry.isDirectory()) await walk(path.join(dir, entry.name), child);
    }
  };
  await walk(root, '');
  return out.sort();
}

async function podsInputs(project: ProjectInfo, ios: ReactNativeAppleApp, env: string[]): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify([RESOLVE_PODS, rubyExporter, MOUNT_PODS, env]));
  const add = async (file: string): Promise<void> => {
    hash.update(`\0${file}\0`);
    hash.update(await fs.readFile(file).catch(() => '\0missing'));
  };
  const iosDir = path.join(project.capDir, ios.dir);
  for (const name of ['Podfile', 'Podfile.lock', 'Podfile.properties.json', '.xcode.env']) await add(path.join(iosDir, name));
  if (ios.xcodeproj) await add(path.join(iosDir, ios.xcodeproj, 'project.pbxproj'));
  const roots = [...new Set([project.capDir, project.syncRoot])];
  for (const dir of roots) {
    for (const name of ['package.json', 'app.json', 'react-native.config.js', ...LOCKFILES]) await add(path.join(dir, name));
    // patch-package's patches change installed packages without changing the lockfile.
    for (const name of (await fs.readdir(path.join(dir, 'patches')).catch(() => [] as string[])).sort()) await add(path.join(dir, 'patches', name));
  }
  for (const pkg of await linkedPackages(roots)) {
    hash.update(`\0${pkg}\0`);
    for (const file of await nativeFiles(pkg)) {
      hash.update(`${file}\n`);
      if (file.endsWith('.podspec')) await add(path.join(pkg, file));
    }
  }
  return hash.digest('hex');
}

/** The files under the app's folder in the workspace (not Pods), with their sizes and times. */
export async function listWorkspaceFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (child === 'Pods') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, child);
      else {
        const st = await fs.stat(full);
        out.set(child, `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  await walk(root, '');
  return out;
}

const fromRel = (root: string, rel: string): string => {
  if (rel.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe path in the saved pod install: ${rel}`);
  return path.join(root, ...rel.split('/'));
};

/** After pod install: keeps what it wrote next to the Podfile (compared with `before`), for the next builds. */
export async function savePodsState(stateDir: string, iosWorkspace: string, inputs: string, before: Map<string, string>): Promise<void> {
  const after = await listWorkspaceFiles(iosWorkspace);
  const written = [...after].filter(([rel, signature]) => before.get(rel) !== signature).map(([rel]) => rel);
  const removed = [...before.keys()].filter((rel) => !after.has(rel));
  await fs.rm(stateDir, { recursive: true, force: true });
  for (const rel of written) {
    const destination = fromRel(path.join(stateDir, 'files'), rel);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(fromRel(iosWorkspace, rel), destination);
  }
  // Written last: a state.json means the files beside it are complete.
  await fs.writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ inputs, written, removed } satisfies PodsState));
}

/** Puts the last pod install's files back into the workspace, if what it read is unchanged; false if pod install has to run. */
export async function restorePodsState(stateDir: string, iosWorkspace: string, inputs: string): Promise<boolean> {
  const state = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8').catch(() => 'null')) as PodsState | null;
  if (!state || state.inputs !== inputs) return false;
  for (const rel of state.written) {
    const destination = fromRel(iosWorkspace, rel);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(fromRel(path.join(stateDir, 'files'), rel), destination);
  }
  for (const rel of state.removed) await fs.rm(fromRel(iosWorkspace, rel), { recursive: true, force: true });
  return true;
}

/** A clean build: the Pods on WSL's disk go too (unmounted first, so Windows can delete the workspace). */
export async function dropReactNativePods(inputs: string, projectId: string, executor: WslExecutor, signal: AbortSignal): Promise<void> {
  await executor.run(['python3', '-c', DROP_PODS, await executor.path(inputs, signal), projectId], { signal, allowFailure: true, timeoutMs: 5 * 60_000 });
}

/**
 * The iOS app's native project for this PC's builder: the CocoaPods workspace
 * in WSL (isolated from the project), with React Native's prebuilt core.
 */
export async function prepareReactNativeIos(project: ProjectInfo, options: WslReactNativeOptions, ctx: EngineContext, signal: AbortSignal): Promise<WslNativeBuildPlan> {
  throwIfAborted(signal);
  const rn = requireReactNative(project, 'ios');
  const ios = rn.ios!;
  const { executor } = options;
  const debug = isDebug(options.configuration);
  const node = await ensureWslNode(executor, ctx, signal);
  const bundleDir = debug ? null : await bundleReactNativeOnPc(project, options.directory, ctx, signal);
  const podDirectory = path.join(project.capDir, ios.dir);
  const relative = path.relative(project.syncRoot, podDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new UserError('The Podfile is outside the project’s folder.');
  if (!existsSync(path.join(podDirectory, 'Podfile'))) throw new UserError('The iOS app has no Podfile.', 'React Native’s iOS apps get their native libraries with CocoaPods: keep ios/Podfile from its template.');
  await fs.mkdir(options.directory, { recursive: true });
  const exporter = path.join(options.directory, 'pods-export.rb');
  const output = path.join(options.directory, 'native-graph.json');
  await fs.writeFile(exporter, rubyExporter);
  const fingerprint = createHash('sha256').update(path.resolve(project.syncRoot)).digest('hex').slice(0, 12);
  const workspace = path.join(options.directory, `workspace-${fingerprint}`);
  const [podWsl, rootWsl, workspaceWsl, exporterWsl, outputWsl, sdkPath] = await Promise.all([
    executor.path(podDirectory, signal), executor.path(project.syncRoot, signal), executor.path(workspace, signal),
    executor.path(exporter, signal), executor.path(output, signal), executor.path(options.tools.sdkPath, signal),
  ]);
  const report = await inspectCocoaPods(executor, { rubyPath: options.rubyPath, podPath: options.podPath, signal, directory: podWsl, rootDirectory: rootWsl });
  if (!report.ready) throw new UserError('The WSL CocoaPods toolchain is not ready.', 'Run `capmac wsl setup` to install it.', report.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.message}`));
  await withStep(ctx, 'Copying the app to its CocoaPods workspace in WSL', 'deps', () => mirrorWslWorkspace(project, options.directory, executor, signal, ['android', 'windows', 'macos']));
  const iosWorkspace = path.join(workspace, relative);
  await podsOnLinuxDisk(iosWorkspace, project.projectId, executor, signal);
  const request = {
    phase: 'resolve', source: rootWsl, workspace: workspaceWsl, podRelative: relative.split(path.sep).join('/'),
    exporter: exporterWsl, output: outputWsl, sdkPath, configuration: options.configuration, scheme: ios.scheme,
    xcodeVersion: options.xcodeVersion, webRelative: '.', explicitPodPath: options.podPath !== undefined,
    rubyPath: options.rubyPath ?? 'ruby', podPath: options.podPath ?? 'pod',
  };
  // React Native's Podfile runs Node.js (it finds React Native, and generates code); its core comes prebuilt.
  const env = [
    `PATH=${wslNodePath(node)}`, `TMPDIR=${path.posix.join(workspaceWsl, request.podRelative, 'Pods', PODS_TMP)}`,
    'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'COCOAPODS_DISABLE_STATS=true',
    'RCT_USE_PREBUILT_RNCORE=1', 'RCT_USE_RN_DEP=1',
    ...Object.entries(rn.options.podEnv ?? {}).filter(([key]) => /^[A-Z_][A-Z0-9_]*$/i.test(key)).map(([key, value]) => `${key}=${value}`),
  ];
  const stateDir = path.join(options.directory, PODS_STATE);
  const inputs = await podsInputs(project, ios, env);
  // The workspace as the copy left it, before anything is restored: what pod install writes is what differs from it.
  const before = await listWorkspaceFiles(iosWorkspace).catch(() => null);
  let reused = await restorePodsState(stateDir, iosWorkspace, inputs).catch(() => false);
  if (reused) {
    // Exit 75: CocoaPods' sandbox doesn't match the restored files (Pods deleted in WSL): pod install runs after all.
    const result = await withStep(ctx, 'Reading the iOS app’s native project (pod install not needed: nothing it reads changed)', 'deps', () => executor.run(['env', ...env, 'python3', '-c', RESOLVE_PODS], {
      signal, timeoutMs: 10 * 60_000, stdin: JSON.stringify({ ...request, skipInstall: true }), allowFailure: true,
      onOutput: (text, stream) => ctx.emit({ type: 'tool-output', text, stream }),
    }));
    if (result.code !== 0 && result.code !== 75) throw new UserError('CapMac could not read the iOS app’s native project.', 'Run again with --clean, or with --verbose to see why.', result.stderr.trim().split('\n').slice(-15));
    reused = result.code === 0;
  }
  if (!reused) {
    log(ctx, 'info', 'Resolving the iOS app’s native libraries with CocoaPods in WSL, with React Native’s prebuilt core.');
    await withStep(ctx, 'Installing the iOS app’s native libraries (pod install, in WSL)', 'deps', (step) => executor.run(['env', ...env, 'python3', '-c', RESOLVE_PODS], {
      signal, timeoutMs: 45 * 60_000, stdin: JSON.stringify(request),
      onOutput: (text, stream) => {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (/^(Analyzing|Downloading|Installing|Generating|Integrating|Pod installation complete|\[Codegen\]|\[ReactNativeCore\]|\[ReactNativeDependencies\]|Fetching)/i.test(trimmed)) step.update(trimmed.slice(0, 140));
        }
        ctx.emit({ type: 'tool-output', text, stream });
      },
    }));
    // Without the list from before (a file Windows couldn't read), the next build runs pod install again.
    if (before) await savePodsState(stateDir, iosWorkspace, inputs, before).catch((error: Error) => log(ctx, 'debug', `Not keeping this pod install for the next builds: ${error.message}`));
    else await fs.rm(stateDir, { recursive: true, force: true });
  }
  throwIfAborted(signal);
  let graph: WslNativeGraph;
  try {
    graph = JSON.parse(await fs.readFile(output, 'utf8')) as WslNativeGraph;
    if (graph.version !== 1 || !graph.targets.some((target) => target.id === graph.rootTargetId)) throw new Error('Missing application target.');
  } catch (error) {
    throw new UserError('CocoaPods did not produce a valid native project graph.', 'Check the CocoaPods output above.', [(error as Error).message]);
  }
  return { graph: adaptReactNativeGraph(graph, node, bundleDir), outputDirectory: options.outputDirectory, signing: options.signing };
}
