/** Managed open-source prerequisites. Apple SDK/signing setup remains separate. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CancelledError, UserError } from '../errors.js';
import { WSL_DEVICE_TOOL_VERSION } from './device.js';
import { installWslResourceTools } from './resources.js';
import { ensureWslSigner } from './signer-tools.js';
import type { WslOptions } from './settings.js';
import { decodeWslOutput, parseWslDistributions, WslExecutor, type WslCommandResult, type WslRunOptions } from './toolchain.js';

export const MANAGED_WSL_DISTRO = 'CapMac-Ubuntu';
/** A matched pair: Linux Swift must read the swiftinterfaces that this Xcode's compiler wrote. */
export const MANAGED_XCODE_VERSION = '26.6';
export const MANAGED_SWIFT_VERSION = '6.3.3';
type Hooks = Pick<WslRunOptions, 'signal' | 'onOutput'>;
export type WslBootstrapPatch = Required<Pick<WslOptions, 'distro' | 'swift' | 'linker' | 'clang' | 'archive' | 'lipo' | 'strip' | 'ruby' | 'pod' | 'signer' | 'actool' | 'ibtool' | 'momc' | 'xcstrings' | 'python'>>;

function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new CancelledError(); }

/** argv-only Windows commands; no PowerShell, elevation, or visible windows. */
export function hostRun(executable: string, argv: string[], hooks: Hooks = {}, timeoutMs = 120_000): Promise<WslCommandResult> {
  checkCancelled(hooks.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    let done = false;
    const stop = (error: Error) => {
      if (done) return;
      done = true; cleanup();
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill();
      reject(error);
    };
    const onAbort = () => stop(new CancelledError());
    const timer = setTimeout(() => stop(new UserError('The dependency setup command timed out.', 'Check the download/network connection and rerun capmac wsl setup.')), timeoutMs);
    timer.unref();
    const cleanup = () => { clearTimeout(timer); hooks.signal?.removeEventListener('abort', onAbort); };
    for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => {
      output[stream].push(chunk);
      if (output[stream].reduce((total, value) => total + value.length, 0) > 1_048_576) output[stream].shift();
      hooks.onOutput?.(decodeWslOutput(chunk), stream);
    });
    child.on('error', (error) => { if (!done) { done = true; cleanup(); reject(error); } });
    child.on('close', (code) => { if (!done) { done = true; cleanup(); resolve({ code: code ?? 1, stdout: decodeWslOutput(Buffer.concat(output.stdout)), stderr: decodeWslOutput(Buffer.concat(output.stderr)) }); } });
    hooks.signal?.addEventListener('abort', onAbort, { once: true });
    if (hooks.signal?.aborted) onAbort();
  });
}

/** Reuse a chosen distro; otherwise install a separate named Ubuntu without first launch. */
export async function ensureManagedWslDistro(options: Hooks & { distro?: string } = {}): Promise<string> {
  checkCancelled(options.signal);
  if (process.platform !== 'win32') throw new UserError('Managed WSL setup runs on Windows.', 'Run capmac wsl setup from a Windows terminal.');
  let listed: WslCommandResult;
  try { listed = await hostRun('wsl.exe', ['--list', '--quiet'], { signal: options.signal }, 30_000); }
  catch (error) { if (error instanceof CancelledError) throw error; throw new UserError('WSL 2 is not installed or cannot start.', 'Install WSL using Microsoft’s `wsl --install --no-distribution`, restart Windows if requested, and rerun capmac wsl setup.'); }
  if (listed.code !== 0) throw new UserError('WSL 2 is not ready.', 'Run `wsl --status` in a Windows terminal. Complete any Windows feature/kernel installation it requests, then rerun capmac wsl setup.', (listed.stderr || listed.stdout).trim().split(/\r?\n/).slice(-8));
  const distributions = parseWslDistributions(listed.stdout);
  if (options.distro) {
    if (!distributions.includes(options.distro)) throw new UserError(`The WSL distribution ${options.distro} is not available.`, 'Check `wsl --list --quiet`, or omit --distro to use the managed CapMac-Ubuntu distribution.');
    return options.distro;
  }
  if (distributions.includes(MANAGED_WSL_DISTRO)) return MANAGED_WSL_DISTRO;
  const status = await hostRun('wsl.exe', ['--status'], { signal: options.signal }, 30_000);
  if (status.code !== 0) throw new UserError('The WSL 2 system prerequisite needs attention.', 'Run `wsl --status`, complete its Windows feature/kernel instructions, and retry. CapMac does not reboot Windows or request administrator access.');
  const help = await hostRun('wsl.exe', ['--help'], { signal: options.signal }, 30_000);
  if (!['--name', '--location', '--no-launch', '--web-download'].every((flag) => help.stdout.includes(flag))) throw new UserError('This WSL version cannot create the managed distribution safely.', 'Update the WSL application with `wsl --update`, then rerun capmac wsl setup.');
  const base = process.env.LOCALAPPDATA;
  if (!base || !path.win32.isAbsolute(base)) throw new UserError('Windows LOCALAPPDATA is unavailable.', 'Run setup from your normal Windows user account.');
  const location = path.join(base, 'CapMac', 'WSL', 'Ubuntu-24.04');
  try { await fs.lstat(location); throw new UserError(`An unregistered WSL directory already exists: ${location}`, 'Move that exact directory aside if it is an abandoned CapMac installation, then retry. Setup never overwrites existing distributions.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(location), { recursive: true });
  options.onOutput?.('Installing the separate CapMac-Ubuntu WSL 2 build environment. Your default distribution stays unchanged.\n', 'stderr');
  const installed = await hostRun('wsl.exe', ['--install', '-d', 'Ubuntu-24.04', '--name', MANAGED_WSL_DISTRO, '--location', location, '--no-launch', '--web-download', '--version', '2'], options, 1_800_000);
  if (installed.code !== 0) throw new UserError('Could not install the managed Ubuntu distribution.', 'Review the WSL output. Complete any system prerequisite outside CapMac, then retry; setup does not request administrator access or reboot Windows.', (installed.stderr || installed.stdout).trim().split(/\r?\n/).slice(-12));
  const verified = await hostRun('wsl.exe', ['--list', '--quiet'], { signal: options.signal }, 30_000);
  if (!parseWslDistributions(verified.stdout).includes(MANAGED_WSL_DISTRO)) throw new UserError('WSL did not register CapMac-Ubuntu.', 'Check `wsl --list --verbose` and the installation output, then retry.');
  return MANAGED_WSL_DISTRO;
}

/** Official Swift release sources are signature-checked before extraction. */
export const INSTALL_WSL_DEPENDENCIES = String.raw`import gzip,json,os,pathlib,platform,re,shutil,subprocess,sys,tarfile,tempfile,time,urllib.request
VERSION=sys.argv[2] if len(sys.argv)>2 else ''
if not re.fullmatch(r'[0-9]+\.[0-9]+(?:\.[0-9]+)?',VERSION): raise SystemExit('A managed Swift version is required')
TAG='swift-'+VERSION+'-RELEASE'; FINGERPRINT='52BB7E3DE28A71BE22EC05FFEF80A866B47A981F'
def fail(text): raise ValueError(text)
def run(argv,**kwargs):
 print('Preparing '+argv[0],file=sys.stderr,flush=True)
 return subprocess.run(argv,check=True,stdout=sys.stderr,stderr=sys.stderr,**kwargs)
def executable(name):
 selected=shutil.which(name)
 if not selected: fail('Required Linux executable is missing after setup: '+name)
 return selected
def main():
 release={}
 for line in pathlib.Path('/etc/os-release').read_text().splitlines():
  if '=' in line:
   key,value=line.split('=',1); release[key]=value.strip('"')
 if release.get('ID')!='ubuntu' or release.get('VERSION_ID')!='24.04': fail('Automatic dependencies support Ubuntu 24.04. Use the managed CapMac-Ubuntu distro, or supply your existing tool paths manually.')
 architecture=platform.machine()
 if architecture not in ('x86_64','aarch64'): fail('The managed Swift toolchain supports x86_64 and aarch64 Linux only')
 packages=['build-essential','ca-certificates','clang','llvm','lld','ruby-full','python3','python3-venv','rsync','libcurl4-openssl-dev','libssl-dev','pkg-config','git','curl','gnupg','libedit2','libpython3-dev','libsqlite3-0','libxml2-dev','libncurses-dev','libz3-dev','zlib1g-dev','libgcc-13-dev','libstdc++-13-dev','librsvg2-bin','poppler-utils','libheif-examples']
 missing=[]
 for package in packages:
  query=subprocess.run(['dpkg-query','-W','-f='+r'$'+'{Status}',package],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
  if query.returncode or query.stdout!='install ok installed': missing.append(package)
 if missing:
  prefix=[]
  if os.geteuid()!=0:
   if not shutil.which('sudo') or subprocess.run(['sudo','-n','true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode: fail('Linux package installation needs root or passwordless sudo in this distro. Use the managed CapMac-Ubuntu distro, or install the listed prerequisites manually: '+', '.join(missing))
   prefix=['sudo','-n']
  env=dict(os.environ,DEBIAN_FRONTEND='noninteractive')
  run(prefix+['apt-get','update'],env=env); run(prefix+['apt-get','install','-y','--no-install-recommends']+missing,env=env)
 cache=pathlib.Path(os.environ.get('XDG_DATA_HOME',str(pathlib.Path.home()/'.local/share')))/'capmac/toolchains'; cache.mkdir(parents=True,exist_ok=True)
 suffix='-aarch64' if architecture=='aarch64' else ''; name=TAG+'-ubuntu24.04'+suffix; destination=cache/name
 configured=sys.argv[1] if len(sys.argv)>1 else ''
 candidates=[shutil.which(configured) or configured] if configured else [str(destination/'usr/bin/swiftc'),'/opt/capmac/toolchains/'+name+'/usr/bin/swiftc',shutil.which('swiftc')]
 swift=None
 for candidate in candidates:
  if not candidate or not os.path.isfile(candidate) or not os.access(candidate,os.X_OK): continue
  probe=subprocess.run([candidate,'--version'],capture_output=True,text=True)
  if probe.returncode==0 and re.search(r'Swift version '+re.escape(VERSION)+r'(?:\s|$)',probe.stdout): swift=candidate; break
 if configured and not swift: fail('The configured Swift compiler is not a runnable Linux Swift '+VERSION+' compiler: '+configured)
 if not swift:
  if destination.exists(): fail('An incomplete managed Swift toolchain exists at '+str(destination)+'. Move that exact directory aside and retry.')
  def fetch(url,target,maximum):
   print('Downloading '+url,file=sys.stderr,flush=True)
   temporary=target.with_name(target.name+'.partial'); total=0; reported=0
   with urllib.request.urlopen(url,timeout=90) as response,temporary.open('wb') as output:
    if not response.geturl().startswith(('https://download.swift.org/','https://www.swift.org/','https://swift.org/')): fail('Swift download redirected outside the official Swift domains')
    while True:
     chunk=response.read(1024*1024)
     if not chunk: break
     total+=len(chunk)
     if total>maximum: fail('Swift download exceeds its expected size limit')
     output.write(chunk)
     if time.monotonic()-reported>=10: print('Downloaded '+str(total//(1024*1024))+' MiB',file=sys.stderr,flush=True); reported=time.monotonic()
   temporary.rename(target)
  with tempfile.TemporaryDirectory(prefix='prepare-swift-',dir=cache) as staging:
   stage=pathlib.Path(staging); manifest=stage/'releases.json'; fetch('https://www.swift.org/api/v1/install/releases.json',manifest,8*1024*1024)
   releases=json.loads(manifest.read_text())
   if not any(item.get('tag')==TAG and any(p.get('name')=='Ubuntu 24.04' for p in item.get('platforms',[])) for item in releases): fail('The pinned Swift release is absent from the official Swift manifest')
   archive=stage/(name+'.tar.gz'); signature=stage/'swift.sig'; keys=stage/'swift-keys.asc'
   url='https://download.swift.org/swift-'+VERSION+'-release/ubuntu2404'+suffix+'/'+TAG+'/'+archive.name
   fetch(url,archive,2*1024*1024*1024); fetch(url+'.sig',signature,1024*1024); fetch('https://www.swift.org/keys/all-keys.asc',keys,8*1024*1024)
   raw=keys.read_bytes()
   if raw.startswith(b'\x1f\x8b'): keys.write_bytes(gzip.decompress(raw))
   gpg=stage/'gpg'; gpg.mkdir(mode=0o700)
   run(['gpg','--homedir',str(gpg),'--batch','--import',str(keys)])
   verified=subprocess.run(['gpg','--homedir',str(gpg),'--batch','--status-fd','1','--verify',str(signature),str(archive)],stdout=subprocess.PIPE,stderr=sys.stderr,text=True)
   if verified.returncode or not any(line.startswith('[GNUPG:] VALIDSIG ') and FINGERPRINT in line.split()[2:] for line in verified.stdout.splitlines()): fail('Swift archive signature did not match the pinned official Swift 6.x release key')
   with tarfile.open(archive,'r:gz') as bundle:
    for member in bundle:
     if member.name.split('/')[0]!=name: fail('Unexpected root in the official Swift archive')
     bundle.extract(member,path=stage,filter='data')
   prepared=stage/name; compiler=prepared/'usr/bin/swiftc'
   probe=subprocess.run([str(compiler),'--version'],capture_output=True,text=True)
   if probe.returncode or 'Swift version '+VERSION not in probe.stdout: fail('The downloaded Swift compiler could not run on this Ubuntu installation')
   prepared.rename(destination)
  swift=str(destination/'usr/bin/swiftc')
 ruby_probe="require 'xcodeproj'; require 'cocoapods'; abort 'CocoaPods/xcodeproj upgrade required' unless Gem::Version.new(Pod::VERSION) >= Gem::Version.new('1.17.0') && Gem::Version.new(Xcodeproj::VERSION) >= Gem::Version.new('1.28.0'); puts Pod::VERSION"
 gem=subprocess.run(['ruby','-e',ruby_probe],capture_output=True,text=True)
 if gem.returncode or not shutil.which('pod'):
  prefix=[] if os.geteuid()==0 else ['sudo','-n']
  run(prefix+['gem','install','cocoapods','--version','1.17.0','--no-document'])
  gem=subprocess.run(['ruby','-e',ruby_probe],capture_output=True,text=True)
  if gem.returncode: fail('Ruby cannot load CocoaPods and xcodeproj after installation: '+gem.stderr[-2000:])
 def llvm(name):
  choices=[]
  for entry in os.environ.get('PATH','').split(os.pathsep):
   directory=pathlib.Path(entry)
   if not directory.is_dir(): continue
   for candidate in directory.glob(name+'*'):
    match=re.fullmatch(re.escape(name)+r'(?:-([0-9]+))?',candidate.name)
    if match and os.access(candidate,os.X_OK) and candidate.is_file(): choices.append((int(match.group(1) or 0),str(candidate)))
  if not choices: fail('LLVM tool was not installed: '+name)
  return sorted(choices,reverse=True)[0][1]
 # The Swift release bundles a newer clang than Ubuntu, matched to the Apple headers it reads.
 # Its ld64.lld is built without iOS support, so the linker stays Ubuntu's.
 def bundled(name,fallback):
  candidate=os.path.join(os.path.dirname(swift),name)
  return candidate if os.path.isfile(candidate) and os.access(candidate,os.X_OK) else fallback(name)
 print(json.dumps({'swift':swift,'clang':bundled('clang',executable),'archive':bundled('llvm-ar',llvm),'linker':llvm('ld64.lld'),'lipo':llvm('llvm-lipo'),'strip':llvm('llvm-strip'),'ruby':executable('ruby'),'pod':executable('pod')}))
try: main()
except (ValueError,OSError,subprocess.CalledProcessError,tarfile.TarError) as error:
 print('WSL dependency setup failed: '+str(error),file=sys.stderr,flush=True); sys.exit(1)
`;

export const INSTALL_HOST_DEVICE_TOOLS = String.raw`import importlib.metadata,json,pathlib,subprocess,sys,venv
target=pathlib.Path(sys.argv[1]); version=sys.argv[2]
if not target.is_absolute() or version!='11.32.0': raise SystemExit('Invalid managed device environment request')
venv.EnvBuilder(with_pip=True).create(target)
python=target/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python')
subprocess.run([str(python),'-m','pip','install','--disable-pip-version-check','pymobiledevice3=='+version],check=True,stdout=sys.stderr,stderr=sys.stderr)
probe=subprocess.run([str(python),'-c','import importlib.metadata; print(importlib.metadata.version("pymobiledevice3"))'],check=True,text=True,stdout=subprocess.PIPE)
if probe.stdout.strip()!=version: raise SystemExit('Managed iPhone tool version verification failed')
print(json.dumps({'python':str(python)}))
`;

const HOST_PYTHON_PROBE = 'import importlib.metadata,importlib.util,json,sys; print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:2]),"venv":importlib.util.find_spec("venv") is not None,"device":importlib.metadata.version("pymobiledevice3") if importlib.util.find_spec("pymobiledevice3") else None}))';

/** CapMac's own Python on Windows: python.org's build (its NuGet package), pinned, so nobody installs Python. */
export const PRIVATE_PYTHON = {
  version: '3.13.16',
  url: 'https://api.nuget.org/v3-flatcontainer/python/3.13.16/python.3.13.16.nupkg',
  sha256: '95fad176338f1d6a799e45946488063f4aa61764e6cff2f132ddeffbf7a04c34',
} as const;

/** CapMac's folder for the iPhone tools, or undefined when the per-user folder is unknown. */
function deviceToolsRoot(): string | undefined {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return base && path.isAbsolute(base) ? path.join(base, 'CapMac', 'device-tools') : undefined;
}

// On another drive, path.relative returns an absolute path: that file is outside too.
const inside = (folder: string, file: string) => {
  const rel = path.relative(folder, path.resolve(file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Where CapMac's own Python lives (Windows), with the iPhone tools installed in it. */
export function privatePythonPath(root = deviceToolsRoot()): string | undefined {
  return root && path.join(root, `${WSL_DEVICE_TOOL_VERSION}-python-${PRIVATE_PYTHON.version}`, 'python.exe');
}

/** A Python CapMac set up earlier (another version, or a venv of the PC's own Python) is set up again; one someone chose is kept. */
export function devicePythonCurrent(python: string | undefined): boolean {
  const root = deviceToolsRoot();
  if (!python || process.platform !== 'win32' || !root || !inside(root, python)) return true;
  return path.resolve(python).toLowerCase() === privatePythonPath(root)!.toLowerCase();
}

async function deviceToolVersion(python: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await hostRun(python, ['-I', '-c', 'import importlib.metadata as m; print(m.version("pymobiledevice3"))'], { signal }, 30_000);
    return result.code ? undefined : result.stdout.trim();
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return undefined;
  }
}

/** Downloads python.org's Python into CapMac's folder, checks it, and installs the iPhone tools in it. */
async function ensurePrivatePython(root: string, options: Hooks): Promise<string> {
  const python = privatePythonPath(root)!;
  const home = path.dirname(python);
  if (await deviceToolVersion(python, options.signal) === WSL_DEVICE_TOOL_VERSION) return python;
  await fs.mkdir(root, { recursive: true });
  options.onOutput?.(`Downloading Python ${PRIVATE_PYTHON.version} for the iPhone tools.\n`, 'stderr');
  const staging = await fs.mkdtemp(path.join(root, '.python-'));
  try {
    let bytes: Buffer;
    try {
      const response = await fetch(PRIVATE_PYTHON.url, { signal: options.signal });
      if (!response.ok) throw new UserError(`Could not download Python for the iPhone tools (HTTP ${response.status}).`, 'Check the internet connection, then rerun setup.');
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (options.signal?.aborted) throw new CancelledError();
      throw new UserError('Could not download Python for the iPhone tools.', 'Check the internet connection, then rerun setup.', [String(error)]);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== PRIVATE_PYTHON.sha256) throw new UserError('The Python download for the iPhone tools was damaged.', 'Rerun setup to download it again.');
    const archive = path.join(staging, 'python.nupkg');
    await fs.writeFile(archive, bytes);
    // Windows' own tar unpacks zip files, which a NuGet package is.
    const unpacked = await hostRun(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', staging], { signal: options.signal }, 300_000);
    if (unpacked.code) throw new UserError('Could not unpack Python for the iPhone tools.', 'Rerun setup.', (unpacked.stderr || unpacked.stdout).trim().split(/\r?\n/).slice(-5));
    await fs.rm(home, { recursive: true, force: true });
    await fs.rename(path.join(staging, 'tools'), home);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  options.onOutput?.(`Installing the iPhone tools (pymobiledevice3 ${WSL_DEVICE_TOOL_VERSION}) in CapMac's Python.\n`, 'stderr');
  const installed = await hostRun(python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', `pymobiledevice3==${WSL_DEVICE_TOOL_VERSION}`], options, 1_200_000);
  if (installed.code || await deviceToolVersion(python, options.signal) !== WSL_DEVICE_TOOL_VERSION) {
    await fs.rm(home, { recursive: true, force: true });
    throw new UserError('Could not install the iPhone tools.', 'Check the internet connection, then rerun setup.', (installed.stderr || installed.stdout).trim().split(/\r?\n/).slice(-15));
  }
  // Tools an earlier setup left (another version, or a venv of the PC's own Python) are not used any more.
  for (const entry of await fs.readdir(root)) {
    if (entry !== path.basename(home) && !entry.startsWith('.')) await fs.rm(path.join(root, entry), { recursive: true, force: true }).catch(() => undefined);
  }
  return python;
}

/**
 * The Python that runs the iPhone tools. On Windows CapMac brings its own (python.org's build), so
 * nobody installs Python; a Python someone chose (wsl.python) is used, with the tools in a CapMac venv.
 */
export async function ensureHostDeviceTools(options: Hooks & { python?: string } = {}): Promise<string> {
  checkCancelled(options.signal);
  const root = deviceToolsRoot();
  if (!root) throw new UserError('Cannot locate the per-user device tools directory.');
  // One CapMac set up before is replaced by the current one.
  const chosen = options.python && !inside(root, options.python) ? options.python : undefined;
  if (process.platform === 'win32' && !chosen) return ensurePrivatePython(root, options);
  const target = path.join(root, WSL_DEVICE_TOOL_VERSION);
  const managed = path.join(target, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  const candidates = chosen ? [chosen] : [managed, 'python3', 'python'];
  let selected: { executable: string; prefix: string[] } | undefined;
  for (const candidate of candidates) {
    checkCancelled(options.signal);
    const prefix = /(^|[\\/])py(?:\.exe)?$/i.test(candidate) ? ['-3'] : [];
    let result: WslCommandResult;
    try { result = await hostRun(candidate, [...prefix, '-c', HOST_PYTHON_PROBE], { signal: options.signal }, 30_000); }
    catch (error) { if (error instanceof CancelledError) throw error; continue; }
    if (result.code) continue;
    try {
      const value = JSON.parse(result.stdout) as { executable?: unknown; version?: unknown; venv?: unknown; device?: unknown };
      if (typeof value.executable !== 'string' || !Array.isArray(value.version) || Number(value.version[0]) !== 3 || Number(value.version[1]) < 10 || !value.venv) continue;
      if (value.device === WSL_DEVICE_TOOL_VERSION) return value.executable;
      if (candidate !== managed) { selected = { executable: candidate, prefix }; break; }
    } catch { /* Another Python candidate may be usable. */ }
  }
  if (!selected) {
    throw chosen
      ? new UserError('The Python chosen for the iPhone tools cannot run them.', 'Point wsl.python at Python 3.10 or newer, or remove wsl.python so CapMac uses its own Python.')
      : new UserError('Python 3.10 or newer is required for the iPhone tools.', 'Install python3 with its venv module, then rerun capmac wsl setup.');
  }
  options.onOutput?.(`Installing iPhone tools in the private CapMac Python environment.\n`, 'stderr');
  const result = await hostRun(selected.executable, [...selected.prefix, '-c', INSTALL_HOST_DEVICE_TOOLS, target, WSL_DEVICE_TOOL_VERSION], options, 1_200_000);
  if (result.code) throw new UserError('Could not prepare the Windows iPhone tools.', 'Check the Python/pip output and internet connection, then rerun capmac wsl setup.', (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-15));
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { throw new UserError('Device setup returned invalid installed paths.'); }
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).python !== managed) throw new UserError('Device setup returned an unexpected Python environment.');
  return managed;
}

/** Complete the Linux/host tool prerequisites and return machine-local settings. */
export async function bootstrapWslDependencies(executor: WslExecutor, options: Hooks & { swift?: string; python?: string } = {}): Promise<WslBootstrapPatch> {
  checkCancelled(options.signal);
  // A Swift that CapMac installed for an older Xcode pairing is replaced, not reused.
  const custom = /\/capmac\/toolchains\/swift-[0-9.]+-RELEASE-/.test(options.swift ?? '') ? undefined : options.swift;
  const configured = custom ? (path.win32.isAbsolute(custom) || custom.startsWith('/') ? await executor.path(custom, options.signal) : custom) : '';
  const result = await executor.run(['python3', '-c', INSTALL_WSL_DEPENDENCIES, configured, MANAGED_SWIFT_VERSION], { signal: options.signal, onOutput: options.onOutput, timeoutMs: 3_600_000, allowFailure: true });
  if (result.code) throw new UserError('Could not prepare the WSL build dependencies.', `Review the setup output and rerun capmac wsl setup. The managed environment uses Ubuntu 24.04 and official Swift ${MANAGED_SWIFT_VERSION}.`, (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-20));
  let installed: unknown;
  try { installed = JSON.parse(result.stdout); } catch { throw new UserError('WSL dependency setup returned invalid output.'); }
  const keys = ['swift', 'linker', 'clang', 'archive', 'lipo', 'strip', 'ruby', 'pod'] as const;
  if (!installed || typeof installed !== 'object' || keys.some((key) => typeof (installed as Record<string, unknown>)[key] !== 'string' || !(installed as Record<string, string>)[key]!.startsWith('/') || /[\0\r\n]/.test((installed as Record<string, string>)[key]!))) throw new UserError('WSL dependency setup returned invalid executable paths.');
  const linux = installed as Pick<WslBootstrapPatch, typeof keys[number]>;
  const signer = await ensureWslSigner(executor, options);
  const resources = await installWslResourceTools(executor, { ...options, swiftPath: linux.swift.replace(/\/swiftc$/, '/swift') });
  const python = await ensureHostDeviceTools(options);
  return { ...linux, distro: executor.distro, signer, actool: resources.actoolPath, ibtool: resources.ibtoolPath, momc: resources.momcPath, xcstrings: resources.xcstringsPath, python };
}
