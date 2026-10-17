/** Windows/WSL transport and evidence-based checks for the experimental iOS toolchain. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CancelledError, UserError } from '../errors.js';

export interface WslToolchainConfig {
  distro?: string;
  /** CocoaPods targets require the native C-family compiler and archive tools. */
  native?: boolean;
  /** An extracted iPhoneOS SDK, as a WSL path (or a Windows absolute path). */
  sdkPath?: string;
  swiftcPath?: string;
  signerPath?: string;
  linkerPath?: string;
  /** Matching Darwin Swift runtime/compiler resources when separate from the Linux compiler. */
  swiftResourcePath?: string;
  clangPath?: string;
  archivePath?: string;
  lipoPath?: string;
  stripPath?: string;
  actoolPath?: string;
  ibtoolPath?: string;
  momcPath?: string;
  xcstringsPath?: string;
}

export interface WslRunOptions {
  signal?: AbortSignal;
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void;
  stdin?: string | Buffer;
  allowFailure?: boolean;
  timeoutMs?: number;
  /** Linux working folder. Otherwise WSL starts in the Windows folder CapMac runs from. */
  cwd?: string;
}

export interface WslCommandResult { stdout: string; stderr: string; code: number }
export interface WslToolchainTools {
  sdkPath: string;
  swiftcPath: string;
  signerPath: string;
  linkerPath: string;
  swiftResourcePath?: string;
  clangPath?: string;
  archivePath?: string;
  lipoPath?: string;
  stripPath?: string;
  actoolPath?: string;
  ibtoolPath?: string;
  momcPath?: string;
  xcstringsPath?: string;
  /** Xcode's libclang_rt.ios.a, for the `#available` runtime check. */
  compilerRuntimePath?: string;
}
export interface WslToolchainReport {
  ready: boolean;
  distro?: string;
  checks: { name: string; ok: boolean; message: string }[];
  tools?: WslToolchainTools;
}

// Commands are argv, never shell text. Closing the Windows pipe or cancelling
// kills the complete Linux process group, including Swift's compiler/linker.
// Command input is framed separately so a certificate password stays on stdin.
const SUPERVISOR = `import base64,json,os,signal,subprocess,sys,threading
frame=b''
while b'\\n' not in frame:
 chunk=os.read(0,65536)
 if not chunk: sys.exit(130)
 frame+=chunk
payload,remainder=frame.split(b'\\n',1)
request=json.loads(payload)
child=subprocess.Popen(request['argv'],stdin=subprocess.PIPE,start_new_session=True,cwd=request.get('cwd'))
def stop():
 try: os.killpg(child.pid,signal.SIGKILL)
 except ProcessLookupError: pass
def watch():
 try:
  if not remainder: os.read(0,1)
 finally:
  if child.poll() is None: stop()
threading.Thread(target=watch,daemon=True).start()
def feed():
 try:
  child.stdin.write(base64.b64decode(request['stdin']))
  child.stdin.close()
 except BrokenPipeError: pass
threading.Thread(target=feed,daemon=True).start()
try: sys.exit(child.wait())
except KeyboardInterrupt:
 stop()
 sys.exit(130)
`;

function assertArg(value: string): void {
  if (value.includes('\0')) throw new UserError('A WSL argument contains a NUL character.');
}

/** Decode wsl.exe's UTF-16 distribution list as well as ordinary UTF-8 output. */
export function decodeWslOutput(buffer: Buffer): string {
  return (buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')).replace(/^\uFEFF/, '');
}

export function parseWslDistributions(output: string): string[] {
  return output.replace(/\0/g, '').split(/\r?\n/).map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter((name) => name && !/^docker-desktop(?:-data)?$/i.test(name));
}

function nativeWsl(args: string[], options: WslRunOptions = {}, supervised?: readonly string[]): Promise<WslCommandResult> {
  if (options.signal?.aborted) return Promise.reject(new CancelledError());
  args.forEach(assertArg);
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let cancelled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (supervised) child.stdin.end('\n');
      else child.kill();
      killTimer = setTimeout(() => child.kill(), 2000);
      killTimer.unref();
    };
    const onAbort = () => { cancelled = true; stop(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 120_000);
    timer.unref();
    const collect = (stream: 'stdout' | 'stderr', chunks: Buffer[], chunk: Buffer) => {
      chunks.push(chunk);
      // Keep diagnostics bounded even for long compiler failures.
      if (chunks.reduce((n, b) => n + b.length, 0) > 2_000_000) chunks.shift();
      options.onOutput?.(chunk.toString('utf8'), stream);
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', stderr, chunk));
    // The supervisor or WSL may exit before input is consumed; report the exit.
    child.stdin.on('error', () => {});
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => { cleanup(); reject(new UserError('Could not start WSL.', 'Install WSL 2 and an Ubuntu distribution, then run the WSL doctor again.', [error.message])); });
    child.on('close', (exitCode) => {
      cleanup();
      if (cancelled) { reject(new CancelledError()); return; }
      if (timedOut) { reject(new UserError('The WSL command timed out.', 'Check WSL and rerun the command.')); return; }
      const result = { code: exitCode ?? 1, stdout: decodeWslOutput(Buffer.concat(stdout)), stderr: decodeWslOutput(Buffer.concat(stderr)) };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new UserError(`WSL tool ${supervised?.[0] ?? args[0]} failed (exit ${result.code}).`, 'Check the tool output and run the WSL doctor.', result.stderr.trim().split(/\r?\n/).slice(-20)));
      } else resolve(result);
    });
    if (supervised) {
      child.stdin.write(JSON.stringify({ argv: supervised, stdin: Buffer.from(options.stdin ?? '').toString('base64'), ...(options.cwd ? { cwd: options.cwd } : {}) }) + '\n');
    } else child.stdin.end(options.stdin);
    // Covers cancellation between the initial check and listener registration.
    if (options.signal?.aborted) onAbort();
  });
}

export class WslExecutor {
  constructor(readonly distro: string) {
    if (!distro.trim() || distro.startsWith('-') || /[\r\n\0]/.test(distro)) throw new UserError('Invalid WSL distribution name.');
  }

  run(argv: readonly string[], options: WslRunOptions = {}): Promise<WslCommandResult> {
    if (!argv.length || !argv[0]) return Promise.reject(new UserError('A WSL command is required.'));
    argv.forEach(assertArg);
    return nativeWsl(['--distribution', this.distro, '--exec', 'python3', '-c', SUPERVISOR], options, argv);
  }

  async path(hostPath: string, signal?: AbortSignal): Promise<string> {
    if (hostPath.startsWith('/')) return hostPath;
    if (!path.win32.isAbsolute(hostPath)) throw new UserError(`Expected an absolute Windows or WSL path: ${hostPath}`);
    const result = await this.run(['wslpath', '-a', '-u', hostPath], { signal });
    return result.stdout.trim();
  }
}

/** Common explicit Darwin search paths; no host Linux standard library is linked. */
export function iosCompilerArguments(tools: WslToolchainTools, minimumIosVersion: string): string[] {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(minimumIosVersion)) throw new UserError('The minimum iOS version must look like 15.0.');
  return ['-target', `arm64-apple-ios${minimumIosVersion}`, '-sdk', tools.sdkPath,
    // The lld flavor makes Clang pass -platform_version/-arch; given only a path, it
    // assumes an unknown ld64 and passes flags that ld64.lld rejects.
    '-use-ld=lld', '-ld-path=' + tools.linkerPath, '-I', `${tools.sdkPath}/usr/lib/swift`, '-L', `${tools.sdkPath}/usr/lib/swift`,
    ...(tools.swiftResourcePath ? ['-resource-dir', tools.swiftResourcePath] : [])];
}

/** Extra inputs for the final link; Xcode's clang adds its runtime itself, Linux clang cannot. */
export function iosLinkerArguments(tools: WslToolchainTools): string[] {
  return tools.compilerRuntimePath ? ['-Xlinker', tools.compilerRuntimePath] : [];
}

// Share the large, read-only Apple resources through absolute symlinks. Only
// the Clang headers are overlaid from the actual Linux compiler. This avoids
// modifying the supplied SDK or copying gigabytes for each doctor/build.
const PREPARE_RESOURCES = `import hashlib,json,os,pathlib,shutil,sys,tempfile
apple=pathlib.Path(sys.argv[1]).resolve(strict=True)
host=pathlib.Path(sys.argv[2]).resolve(strict=True)/'clang'/'include'
if not apple.is_dir() or not (apple/'iphoneos').is_dir(): raise SystemExit('Apple Swift resources must include iphoneos (Xcode toolchain usr/lib/swift)')
if not host.is_dir(): raise SystemExit('The Linux Swift compiler is missing its matching Clang builtin headers')
fingerprint=json.dumps([(str(p),p.stat().st_mtime_ns) for p in [apple,host]],sort_keys=True)
cache=pathlib.Path.home()/'.cache'/'capmac'/'swift-resources'
cache.mkdir(parents=True,exist_ok=True)
destination=cache/hashlib.sha256(fingerprint.encode()).hexdigest()[:24]
if not (destination/'.capmac-resources').is_file():
 temporary=pathlib.Path(tempfile.mkdtemp(prefix='prepare-',dir=cache))
 try:
  for child in apple.iterdir():
   if child.name!='clang': (temporary/child.name).symlink_to(child,target_is_directory=child.is_dir())
  clang=temporary/'clang'; clang.mkdir()
  original=apple/'clang'
  if original.is_dir():
   for child in original.iterdir():
    if child.name!='include': (clang/child.name).symlink_to(child.resolve(),target_is_directory=child.is_dir())
  (clang/'include').symlink_to(host,target_is_directory=True)
  (temporary/'.capmac-resources').write_text(fingerprint)
  try: temporary.rename(destination)
  except FileExistsError:
   if not (destination/'.capmac-resources').is_file(): raise
 finally:
  if temporary.exists(): shutil.rmtree(temporary)
print(destination)
`;

/** Infer Xcode's resources for a standard extracted iPhoneOS SDK layout. */
export function inferSwiftResourcePath(sdkPath: string): string | undefined {
  const match = /^(.*)\/Platforms\/iPhoneOS\.platform\/Developer\/SDKs\/[^/]+\/?$/.exec(sdkPath);
  return match ? `${match[1]}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift` : undefined;
}

export async function inspectWslToolchain(config: WslToolchainConfig = {}, options: Pick<WslRunOptions, 'signal' | 'onOutput'> & { reuseProbe?: boolean } = {}): Promise<WslToolchainReport> {
  const report: WslToolchainReport = { ready: false, checks: [] };
  const check = (name: string, ok: boolean, message: string) => report.checks.push({ name, ok, message });
  try {
    const list = await nativeWsl(['--list', '--quiet'], { signal: options.signal, timeoutMs: 15_000, allowFailure: true });
    const distributions = parseWslDistributions(list.stdout);
    const distro = config.distro ?? distributions[0];
    if (list.code !== 0 || !distro || !distributions.includes(distro)) {
      check('WSL distribution', false, config.distro ? `Distribution "${config.distro}" is unavailable. Install/select an Ubuntu WSL 2 distribution.` : 'Install an Ubuntu WSL 2 distribution with wsl --install -d Ubuntu. Docker distributions cannot build this app.');
      return report;
    }
    report.distro = distro;
    check('WSL distribution', true, distro);
    const python = await nativeWsl(['--distribution', distro, '--exec', 'python3', '--version'], { signal: options.signal, timeoutMs: 15_000, allowFailure: true });
    check('Python 3', python.code === 0, python.code === 0 ? python.stdout.trim() || python.stderr.trim() : 'Install Python 3 in the selected WSL distribution.');
    if (python.code !== 0) return report;
    const executor = new WslExecutor(distro);
    const tools: WslToolchainTools = {
      sdkPath: '', swiftcPath: config.swiftcPath ?? 'swiftc', signerPath: config.signerPath ?? 'zsign', linkerPath: config.linkerPath ?? 'ld64.lld',
      clangPath: config.clangPath, archivePath: config.archivePath,
      lipoPath: config.lipoPath, stripPath: config.stripPath,
      actoolPath: config.actoolPath, ibtoolPath: config.ibtoolPath, momcPath: config.momcPath, xcstringsPath: config.xcstringsPath,
      ...(config.swiftResourcePath ? { swiftResourcePath: await executor.path(config.swiftResourcePath, options.signal) } : {}),
    };
    const sdk = config.sdkPath ?? process.env.CAPMAC_IOS_SDK;
    if (!sdk) check('iPhoneOS SDK', false, 'Not set up yet. `capmac wsl setup` downloads Xcode from Apple with your Apple Account and takes the iPhone SDK from it; or set --sdk / CAPMAC_IOS_SDK to an SDK you already have.');
    else {
      tools.sdkPath = (await executor.path(sdk, options.signal)).replace(/\/$/, '');
      const sdkCheck = await executor.run(['test', '-f', `${tools.sdkPath}/System/Library/Frameworks/UIKit.framework/Headers/UIKit.h`], { signal: options.signal, allowFailure: true });
      check('iPhoneOS SDK', sdkCheck.code === 0, sdkCheck.code === 0 ? tools.sdkPath : `No UIKit headers at ${tools.sdkPath}. Select an extracted iPhoneOS device SDK.`);
    }
    for (const [name, executable, args] of [
      ['Swift compiler', tools.swiftcPath, ['--version']], ['Mach-O linker', tools.linkerPath, ['--version']],
      ['OpenSSL', 'openssl', ['version']], ['zsign', tools.signerPath, ['--help']],
    ] as const) {
      const result = await executor.run([executable, ...args], { signal: options.signal, allowFailure: true, timeoutMs: 15_000 });
      const ok = name === 'zsign' ? /Usage:.*zsign|--pkey/s.test(result.stdout + result.stderr) : result.code === 0;
      check(name, ok, ok ? (result.stdout + result.stderr).trim().split(/\r?\n/)[0] ?? executable : `Install ${name} in ${distro}, or configure its WSL executable path.`);
    }
    if (config.native) {
      const selected = await executor.run(['python3', '-c', `import json,os,pathlib,re,shutil,sys
r=json.loads(sys.argv[1]); swift=shutil.which(r['swift']); sibling=pathlib.Path(swift).parent if swift else None
def resolve(explicit,name):
 if explicit: return shutil.which(explicit) or explicit
 if sibling and (sibling/name).is_file(): return str(sibling/name)
 found=shutil.which(name)
 if found: return found
 versions=[]
 for directory in os.environ.get('PATH','').split(os.pathsep):
  try:
   for candidate in pathlib.Path(directory).iterdir():
    match=re.fullmatch(re.escape(name)+r'-(\\d+)',candidate.name)
    if match and candidate.is_file() and os.access(candidate,os.X_OK): versions.append((int(match[1]),str(candidate)))
  except OSError: pass
 return max(versions)[1] if versions else name
print(json.dumps({'clangPath':resolve(r.get('clang'),'clang'),'archivePath':resolve(r.get('archive'),'llvm-ar')}))`, JSON.stringify({ swift: tools.swiftcPath, clang: tools.clangPath, archive: tools.archivePath })], { signal: options.signal });
      const resolved = JSON.parse(selected.stdout) as { clangPath: string; archivePath: string };
      tools.clangPath = resolved.clangPath;
      tools.archivePath = resolved.archivePath;
      for (const [name, executable, args] of [
        ['Clang native compiler', tools.clangPath, ['--version']], ['LLVM archive tool', tools.archivePath, ['--version']],
        ['CocoaPods resource copy utility', 'rsync', ['--version']],
      ] as const) {
        const result = await executor.run([executable, ...args], { signal: options.signal, allowFailure: true, timeoutMs: 15_000 });
        check(name, result.code === 0, result.code === 0 ? (result.stdout + result.stderr).trim().split(/\r?\n/)[0] ?? executable : `Install ${executable} in ${distro}.`);
      }
    }
    if (report.checks.some((item) => !item.ok)) return report;
    // -ld-path needs a concrete path; a bare ld64.lld name is resolved here.
    const linker = await executor.run(['python3', '-c', 'import os,shutil,sys; p=shutil.which(sys.argv[1]); print(os.path.abspath(p) if p else ""); sys.exit(0 if p else 1)', tools.linkerPath], { signal: options.signal });
    tools.linkerPath = linker.stdout.trim();
    if (!tools.linkerPath.startsWith('/')) throw new UserError('Could not resolve the Mach-O linker to an absolute WSL path.');
    const appleResources = tools.swiftResourcePath ?? inferSwiftResourcePath(tools.sdkPath);
    if (!appleResources) {
      check('Darwin Swift resources', false, 'Configure swiftResourcePath to the matching extracted Xcode toolchain usr/lib/swift directory. An iPhoneOS SDK alone does not include the complete compiler resources.');
      return report;
    }
    const targetInfo = await executor.run([tools.swiftcPath, '-print-target-info'], { signal: options.signal });
    let runtimeResourcePath: string | undefined;
    try { runtimeResourcePath = (JSON.parse(targetInfo.stdout) as { paths?: { runtimeResourcePath?: string } }).paths?.runtimeResourcePath; } catch { /* Report an actionable check below. */ }
    if (!runtimeResourcePath || !runtimeResourcePath.startsWith('/')) {
      check('Darwin Swift resources', false, 'The Linux Swift compiler did not report its runtimeResourcePath. Install a complete Swift toolchain.');
      return report;
    }
    const prepared = await executor.run(['python3', '-c', PREPARE_RESOURCES, appleResources, runtimeResourcePath], { signal: options.signal, allowFailure: true });
    check('Darwin Swift resources', prepared.code === 0, prepared.code === 0 ? 'Read-only Apple resources with matching Linux Clang headers.' : prepared.stderr.trim() || prepared.stdout.trim());
    if (prepared.code !== 0) return report;
    tools.swiftResourcePath = prepared.stdout.trim();
    if (!tools.swiftResourcePath.startsWith('/')) throw new UserError('The compiler resources cache returned an invalid path.');
    // `#available` checks call __isPlatformVersionAtLeast from Apple's compiler runtime,
    // which sits beside the Swift resources in Xcode's toolchain.
    const runtime = await executor.run(['python3', '-c', 'import glob,os,sys; found=sorted(glob.glob(os.path.join(os.path.dirname(os.path.realpath(sys.argv[1])),"clang","*","lib","darwin","libclang_rt.ios.a"))); print(found[-1] if found else "")', appleResources], { signal: options.signal });
    tools.compilerRuntimePath = runtime.stdout.trim() || undefined;
    check('Apple compiler runtime', !!tools.compilerRuntimePath, tools.compilerRuntimePath ?? 'libclang_rt.ios.a is missing beside the Swift resources. Run `capmac wsl setup` again to import the iPhone SDK from Xcode.');
    if (!tools.compilerRuntimePath) return report;
    // A Linux Swift version string alone proves nothing about iOS support.
    // Import + link UIKit with the actual SDK, overlays and Mach-O linker.
    // The probe takes about a minute: builds reuse a pass for the same tools, the doctor always reruns it.
    const probeKey = createHash('sha256').update(JSON.stringify([1, tools.swiftcPath, tools.sdkPath, tools.swiftResourcePath, tools.linkerPath, tools.compilerRuntimePath])).digest('hex').slice(0, 24);
    const marker = 'import os,sys; p=os.path.expanduser("~/.cache/capmac/probes/"+sys.argv[2]); os.makedirs(os.path.dirname(p),exist_ok=True) if sys.argv[1]=="save" else None; open(p,"w").close() if sys.argv[1]=="save" else sys.exit(0 if os.path.isfile(p) else 1)';
    if (options.reuseProbe && (await executor.run(['python3', '-c', marker, 'check', probeKey], { signal: options.signal, allowFailure: true })).code === 0) {
      check('iOS compile and link', true, 'Passed earlier with these tools and this SDK.');
      report.tools = tools;
      report.ready = report.checks.every((item) => item.ok);
      return report;
    }
    const temporary = (await executor.run(['mktemp', '-d', '-t', 'capmac-doctor.XXXXXXXX'], { signal: options.signal })).stdout.trim();
    if (!/^\/tmp\/capmac-doctor\.[A-Za-z0-9]+$/.test(temporary)) throw new UserError('WSL returned an unexpected temporary directory.');
    try {
      await executor.run(['python3', '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.stdin.read())', `${temporary}/Probe.swift`], {
        signal: options.signal, stdin: 'import UIKit\nimport WebKit\n@main struct CapMacProbe { static func main() { _ = UIApplication.shared; _ = WKWebView(frame: .zero); if #available(iOS 17, *) { _ = UIScreen.main } } }\n',
      });
      const probe = await executor.run([tools.swiftcPath, ...iosCompilerArguments(tools, '15.0'), ...iosLinkerArguments(tools), '-parse-as-library', '-module-cache-path', `${temporary}/cache`, `${temporary}/Probe.swift`, '-o', `${temporary}/Probe`], { signal: options.signal, allowFailure: true, timeoutMs: 120_000, onOutput: options.onOutput });
      if (probe.code === 0) await executor.run(['python3', '-c', marker, 'save', probeKey], { signal: options.signal, allowFailure: true });
      check('iOS compile and link', probe.code === 0, probe.code === 0 ? 'UIKit and WebKit arm64 executable compiled and linked.' : 'iOS compile/link failed. Install matching Darwin Swift resources and a compatible SDK/compiler; ordinary Linux Swift alone may be insufficient.\n' + probe.stderr.trim().split(/\r?\n/).slice(-8).join('\n'));
    } finally {
      await executor.run(['rm', '-rf', '--', temporary], { allowFailure: true });
    }
    report.tools = tools;
    report.ready = report.checks.every((item) => item.ok);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    check('WSL toolchain', false, error instanceof Error ? error.message : String(error));
  }
  return report;
}
