/** Device I/O stays on the host: Windows owns the USB cable and the Wi-Fi, WSL only builds. */
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Target } from '../../shared/protocol.js';
import { wait } from '../context.js';
import { CancelledError, UserError } from '../errors.js';

// These commands and the unprivileged userspace tunnel were verified against this release.
export const WSL_DEVICE_TOOL_VERSION = '11.32.0';

export interface WslDevice {
  udid: string;
  name: string;
  productVersion?: string;
  productType?: string;
  /** How this PC reaches it: the cable, or Wi-Fi once a run over the cable paired it for Wi-Fi. */
  connection?: 'usb' | 'network';
  /** iOS 16 and later open the apps CapMac installs only with Developer Mode on. Known over the cable. */
  developerMode?: 'enabled' | 'disabled';
  /** False while the iPhone doesn't trust this PC yet (its Trust prompt). Known over the cable. */
  paired?: boolean;
}

/** An iPhone plugged into this PC or on its Wi-Fi, as the target pickers show devices. */
export function wslDeviceTarget(device: WslDevice): Target {
  return {
    kind: 'device', udid: device.udid, name: device.name,
    os: device.productVersion ? `iOS ${device.productVersion}` : 'iOS', osVersion: device.productVersion ?? '',
    state: 'connected', available: device.paired !== false && device.developerMode !== 'disabled', connection: device.connection ?? 'usb',
    ...(device.productType ? { model: device.productType } : {}),
    ...(device.developerMode ? { developerMode: device.developerMode } : {}),
    ...(device.paired === false ? { paired: false } : {}),
  };
}

/** Where to turn on Developer Mode, for the CLI and run messages (Studio shows its own steps). */
export const DEVELOPER_MODE_STEPS = 'On your iPhone, open Settings, tap Privacy & Security, then Developer Mode. Turn it on and tap Restart. After it restarts, unlock it and tap Turn On.';

/** The iPhone tools keep a device's Wi-Fi pairing (RemotePairing) here. */
const pairingFolder = () => path.join(os.homedir(), '.pymobiledevice3');
/** iPhones seen over the cable, so one reached over Wi-Fi can be named. */
const knownFile = () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'CapMac', 'iphones.json');

async function knownIphones(): Promise<Record<string, Omit<WslDevice, 'udid' | 'connection'>>> {
  try {
    const value: unknown = JSON.parse(await readFile(knownFile(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Omit<WslDevice, 'udid' | 'connection'>> : {};
  } catch { return {}; }
}

async function rememberIphones(devices: WslDevice[]): Promise<void> {
  const known = await knownIphones();
  let changed = false;
  for (const { udid, name, productVersion, productType } of devices) {
    const entry = { name, ...(productVersion ? { productVersion } : {}), ...(productType ? { productType } : {}) };
    if (JSON.stringify(known[udid]) === JSON.stringify(entry)) continue;
    known[udid] = entry; changed = true;
  }
  if (!changed) return;
  await mkdir(path.dirname(knownFile()), { recursive: true });
  await writeFile(knownFile(), JSON.stringify(known, null, 2) + '\n');
}

/**
 * Paired iPhones on this Wi-Fi: those advertising RemotePairing whose `authTag` matches a Wi-Fi
 * pairing, found without connecting to them. Prints their UDIDs as JSON.
 */
export const WIFI_IPHONES = String.raw`import asyncio,json
from pymobiledevice3.bonjour import iter_browse_remotepairing
from pymobiledevice3.pair_records import iter_remote_pair_records_by_identifier
from pymobiledevice3.remote.tunnel_service import PEER_ALT_IRK_KEY,_match_remote_pair_record
async def main():
 keys={identifier:record[PEER_ALT_IRK_KEY] for identifier,_,record in iter_remote_pair_records_by_identifier() if record.get(PEER_ALT_IRK_KEY)}
 found=set()
 if keys:
  answers=iter_browse_remotepairing(timeout=3)
  try:
   async for answer in answers:
    identifier=_match_remote_pair_record(answer,keys)
    if identifier: found.add(identifier)
  finally: await answers.aclose()
 print(json.dumps(sorted(found)))
asyncio.run(main())
`;

/**
 * iPhones plugged into this PC, as `usbmux list --usb` prints them, with whether each trusts this PC
 * (`Paired`) and, from iOS 16, whether Developer Mode is on (`DeveloperModeStatus`). For an iPhone with
 * it off, it also shows the Developer Mode switch in Settings, which iOS hides until a developer tool
 * asks (`Revealed`; argv: the UDIDs it was shown on already). Errors end it with one line.
 */
export const USB_IPHONES = String.raw`import asyncio,json,sys
from pymobiledevice3 import usbmux
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.amfi import AmfiService
async def main(*revealed):
 found=[]
 for device in await usbmux.list_devices():
  if not device.is_usb: continue
  lockdown=await create_using_usbmux(device.serial,autopair=False,connection_type=device.connection_type)
  try:
   info=lockdown.short_info
   info['Paired']=lockdown.paired
   major=str(info.get('ProductVersion') or '0').split('.')[0]
   if lockdown.paired and major.isdigit() and int(major)>=16:
    try:
     status=await lockdown.get_value('com.apple.security.mac.amfi','DeveloperModeStatus')
     if isinstance(status,bool): info['DeveloperModeStatus']=status
     if status is False and device.serial not in revealed:
      info['Revealed']=True
      await AmfiService(lockdown).reveal_developer_mode_option_in_ui()
    except Exception: pass
   found.append(info)
  finally: await lockdown.close()
 print(json.dumps(found))
try: asyncio.run(main(*sys.argv[1:]))
except Exception as error: raise SystemExit(f'{type(error).__name__}: {error}')
`;

/** iPhones whose Developer Mode switch this process showed in Settings already. */
const revealedDeveloperMode = new Set<string>();

/** When each iPhone last answered on Wi-Fi. A sleepy iPhone misses some searches; one seen lately stays listed. */
const seenOnWifi = new Map<string, number>();
const WIFI_GRACE_MS = 30_000;

/** UDIDs of the iPhones paired for Wi-Fi that are on this network now (or were a moment ago). */
async function wifiIphones(options: WslDeviceOptions): Promise<string[]> {
  const pairings = await readdir(pairingFolder()).catch(() => [] as string[]);
  if (!pairings.some((name) => /^remote_.+\.plist$/.test(name))) return [];
  try {
    const output = await execute(await requirePython(options), ['-c', WIFI_IPHONES], { ...options, onLog: undefined }, { timeoutMs: 20_000 });
    const value: unknown = JSON.parse(output.stdout.trim());
    const now = Date.now();
    if (Array.isArray(value)) for (const udid of value) if (typeof udid === 'string' && /^[a-f\d-]{8,64}$/i.test(udid)) seenOnWifi.set(udid, now);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
  }
  return [...seenOnWifi].filter(([, at]) => Date.now() - at < WIFI_GRACE_MS).map(([udid]) => udid);
}

/**
 * Python for the iPhone tools' no-admin tunnel (`--userspace`) over Wi-Fi. An iPhone on Wi-Fi refuses
 * CoreDeviceProxy's tunnel, so it goes through RemotePairing, as Xcode does (paired over the cable
 * before). An asleep iPhone leaves the network, so it waits up to five minutes (`searches` of ten
 * seconds) for it to wake and says so once (CAPMAC_LOCKED, as for a locked iPhone).
 */
const OVER_WIFI = String.raw`from pymobiledevice3.remote import tunnel_service,userspace_tunnel
searches=30
async def over_wifi(serial,autopair,fallback):
 for attempt in range(searches):
  services=await tunnel_service.get_remote_pairing_tunnel_services(bonjour_timeout=10,udid=serial)
  if services: break
  if attempt==0: print('CAPMAC_LOCKED',flush=True)
 else: raise SystemExit('The iPhone did not come back on this Wi-Fi network. Unlock it, or plug it in.')
 for extra in services[1:]: await extra.close()
 return services[0],None
`;

/** Runs a pymobiledevice3 command whose `--userspace` tunnel reaches the iPhone over Wi-Fi. */
export const WIFI_COMMAND = String.raw`import sys
${OVER_WIFI}userspace_tunnel._create_no_root_tunnel_provider=over_wifi
from pymobiledevice3.__main__ import main
sys.argv=['pymobiledevice3',*sys.argv[1:]]
sys.exit(main())
`;

/** Device options for a command: over Wi-Fi, the no-admin tunnel (see WIFI_COMMAND). */
const reach = (device: WslDevice): string[] => (device.connection === 'network' ? ['--userspace'] : []);

export interface WslDeviceOptions {
  /** Host Python executable path, not a shell command. */
  python?: string;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  /** The iPhone is locked or asleep, and the command goes on once it is unlocked (Stop ends the wait). */
  onLocked?: () => void;
}

export interface WslDeviceTools {
  ready: boolean;
  python?: string;
  pythonVersion?: string;
  pymobiledevice3Version?: string;
  issues: string[];
}

interface PythonCommand { executable: string; prefix: string[] }
interface ProcessOutput { code: number | null; stdout: string; stderr: string }

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

function pythonCommand(executable: string): PythonCommand {
  if (/(^|[\\/])py(?:\.exe)?$/i.test(executable)) return { executable, prefix: ['-3'] };
  // CapMac's own Python ignores the PC's Python settings (PYTHONHOME, PYTHONPATH, user packages).
  return { executable, prefix: /[\\/]CapMac[\\/]device-tools[\\/][^\\/]+-python-[^\\/]+[\\/]python\.exe$/i.test(executable) ? ['-I'] : [] };
}

/** Do not inherit unrelated device/tunnel selection from the invoking terminal. */
function deviceEnvironment(udid?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', NO_COLOR: '1' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PYMOBILEDEVICE3_')) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.USBMUXD_SOCKET_ADDRESS;
  if (udid) env.PYMOBILEDEVICE3_UDID = udid;
  return env;
}

function execute(
  python: PythonCommand,
  args: string[],
  options: WslDeviceOptions,
  settings: { udid?: string; timeoutMs?: number; stream?: boolean } = {},
): Promise<ProcessOutput> {
  cancelled(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(python.executable, [...python.prefix, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: deviceEnvironment(settings.udid),
    });
    let done = false;
    let stdout = '';
    let stderr = '';
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const pending = { stdout: '', stderr: '' };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      child.kill();
      reject(error);
    };
    const onAbort = () => fail(new CancelledError());
    // Streaming logs are deliberately unbounded in time, but never in memory.
    const timer = settings.stream ? undefined : setTimeout(() => fail(new UserError(
      'The iPhone device command timed out.',
      'Unlock the iPhone, check its USB connection and any Trust prompt, then retry.',
    )), settings.timeoutMs ?? 30_000);
    const receive = (stream: 'stdout' | 'stderr', text: string) => {
      if (stream === 'stdout') stdout = (stdout + text).slice(-1_048_576);
      else stderr = (stderr + text).slice(-32_768);
      const lines = (pending[stream] + text).split(/\r?\n/);
      pending[stream] = (lines.pop() ?? '').slice(-32_768);
      for (const line of lines) if (line.trim()) options.onLog?.(line);
    };
    child.stdout.on('data', (chunk: Buffer) => receive('stdout', decoders.stdout.write(chunk)));
    child.stderr.on('data', (chunk: Buffer) => receive('stderr', decoders.stderr.write(chunk)));
    child.on('error', (error) => fail(error));
    child.on('close', (code) => {
      if (done) return;
      done = true;
      cleanup();
      for (const stream of ['stdout', 'stderr'] as const) {
        receive(stream, decoders[stream].end());
        if (pending[stream].trim()) options.onLog?.(pending[stream]);
      }
      resolve({ code, stdout, stderr });
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function atLeast(actual: string, required: string): boolean {
  const a = actual.split(/[.+-]/).map(Number);
  const b = required.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(a[i] ?? 0)) return false;
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** CapMac's own Python with these iPhone tools, once setup put it on this PC (see bootstrap's privatePythonPath). */
async function ownPython(): Promise<string | undefined> {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA : undefined;
  if (!base || !path.isAbsolute(base)) return undefined;
  const root = path.join(base, 'CapMac', 'device-tools');
  const folder = (await readdir(root).catch(() => [] as string[])).filter((name) => name.startsWith(`${WSL_DEVICE_TOOL_VERSION}-python-`)).sort().at(-1);
  return folder ? path.join(root, folder, 'python.exe') : undefined;
}

/** Read-only doctor probe; it never installs Python, pip packages, drivers, or device services. */
export async function inspectWslDeviceTools(options: WslDeviceOptions = {}): Promise<WslDeviceTools> {
  const configured = options.python ?? process.env.CAPMAC_PYTHON;
  // A project not set up yet still reaches the iPhones with the tools setup installed for another one.
  const own = configured ? undefined : await ownPython();
  const candidates = configured ? [configured] : process.platform === 'win32' ? [...(own ? [own] : []), 'py', 'python'] : ['python3', 'python'];
  let found: WslDeviceTools | undefined;
  const probe = 'import importlib.metadata,importlib.util,json,platform; print(json.dumps({"python":platform.python_version(),"pymobiledevice3":importlib.metadata.version("pymobiledevice3") if importlib.util.find_spec("pymobiledevice3") else None}))';
  for (const candidate of candidates) {
    cancelled(options.signal);
    let output: ProcessOutput;
    try {
      output = await execute(pythonCommand(candidate), ['-c', probe], { ...options, onLog: undefined }, { timeoutMs: 10_000 });
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      continue;
    }
    if (output.code !== 0) continue;
    try {
      const info: unknown = JSON.parse(output.stdout.trim());
      if (!info || typeof info !== 'object') continue;
      const data = info as Record<string, unknown>;
      if (typeof data.python !== 'string') continue;
      const version = typeof data.pymobiledevice3 === 'string' ? data.pymobiledevice3 : undefined;
      const issues = !version
        ? [`Install pymobiledevice3 ${WSL_DEVICE_TOOL_VERSION} or newer in the host Python environment.`]
        : !atLeast(version, WSL_DEVICE_TOOL_VERSION)
          ? [`Upgrade host pymobiledevice3 ${version} to ${WSL_DEVICE_TOOL_VERSION} or newer for the supported device commands.`]
          : [];
      const status = { ready: issues.length === 0, python: candidate, pythonVersion: data.python, pymobiledevice3Version: version, issues };
      if (status.ready) return status;
      found ??= status;
    } catch { /* Another candidate may be a real Python rather than an executable alias. */ }
  }
  return found ?? { ready: false, issues: ['Install Python on the host (Windows, outside WSL), or set wsl.python to its executable path.'] };
}

async function requirePython(options: WslDeviceOptions): Promise<PythonCommand> {
  const tools = await inspectWslDeviceTools(options);
  if (!tools.ready || !tools.python) throw new UserError('The host iPhone tools are not ready.', tools.issues.join(' '));
  return pythonCommand(tools.python);
}

/** A Wi-Fi tunnel the iPhone dropped: locked or asleep in the middle of a command. */
const DROPPED = /terminated abruptly|transport closed|ConnectionResetError|ConnectionTerminatedError|did not come back on this Wi-Fi/i;

function commandError(action: string, output: ProcessOutput): UserError {
  const text = `${output.stderr}\n${output.stdout}`;
  let hint = 'Check the device output, unlock the iPhone, and retry.';
  if (DROPPED.test(text)) {
    // First: the tools' Wi-Fi log lines name "RemotePairing", which is no Trust problem.
    hint = 'The iPhone dropped the Wi-Fi connection. Keep it unlocked and on this Wi-Fi, or plug it in.';
  } else if (/DeveloperMode|developer mode/i.test(text)) {
    hint = `Developer Mode is off. ${DEVELOPER_MODE_STEPS}`;
  } else if (/DeveloperDiskImage|personalized.*image|InvalidService|InvalidServiceError/i.test(text)) {
    hint = 'Enable Settings → Privacy & Security → Developer Mode on the iPhone and finish its restart/confirmation. The developer disk image must mount successfully.';
  } else if (/Pairing|pairing|Trust|trust|UserDenied|PasswordProtected|DeviceLocked|InvalidHostID|GetProhibited/i.test(text)) {
    hint = 'Unlock the iPhone, accept “Trust This Computer”, and retry with the device unlocked.';
  } else if (/tunnel|RSD|CoreDeviceProxy|ConnectionRefused|connect call failed/i.test(text)) {
    hint = 'For iOS 17.4+ use current pymobiledevice3. iOS 17.0–17.3 needs a host administrator to run “python -m pymobiledevice3 remote tunneld” in a separate terminal. Keep USB connected and the iPhone unlocked.';
  } else if (/NoDevice|DeviceNotFound|usbmux|WinError 10061|ConnectionRefused|No such file or directory/i.test(text)) {
    hint = 'Connect the iPhone to this PC over USB. On Windows, install Apple Devices (including its USB drivers); on Linux, start usbmuxd. Unlock and trust the computer.';
  } else if (/ApplicationVerificationFailed|provision|0xe800801|signature|certificate/i.test(text)) {
    hint = 'Use a valid development signature and provisioning profile that includes this iPhone and matches the app bundle identifier.';
  }
  return new UserError(`${action} failed (exit ${output.code ?? 'signal'}).`, hint, text.trim().split(/\r?\n/).filter(Boolean).slice(-25));
}

async function runDevice(
  args: string[], options: WslDeviceOptions, settings: { udid?: string; timeoutMs?: number; stream?: boolean; wifi?: boolean } = {},
): Promise<string> {
  const python = await requirePython(options);
  // Over Wi-Fi, the tunnel waits for an asleep iPhone and says so once.
  const onLog = (line: string) => (line === 'CAPMAC_LOCKED' ? options.onLocked?.() : options.onLog?.(line));
  for (let attempt = 1; ; attempt++) {
    const output = await execute(python, [...(settings.wifi ? ['-c', WIFI_COMMAND] : ['-m', 'pymobiledevice3']), '--no-color', ...args], { ...options, onLog }, settings);
    if (output.code === 0) return output.stdout;
    // A locked or asleep iPhone drops the Wi-Fi tunnel mid-command: ask for it, then try again.
    if (!settings.wifi || settings.stream || attempt >= 3 || !DROPPED.test(`${output.stderr}\n${output.stdout}`)) throw commandError('The iPhone command', output);
    options.onLocked?.();
  }
}

function validateUdid(udid: string): void {
  if (!/^[a-f\d-]{8,64}$/i.test(udid)) throw new UserError('Invalid iPhone UDID.', 'Use a UDID listed by capmac wsl targets.');
}

function validateBundleId(bundleId: string): void {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new UserError('Invalid iOS bundle identifier.', 'Use an identifier such as com.example.app.');
}

/** The iPhones plugged into this PC (see USB_IPHONES). */
async function usbIphones(options: WslDeviceOptions): Promise<WslDevice[]> {
  const output = await execute(await requirePython(options), ['-c', USB_IPHONES, ...revealedDeveloperMode], { ...options, onLog: undefined });
  if (output.code !== 0) throw commandError('Listing iPhones', output);
  let value: unknown;
  try { value = JSON.parse(output.stdout.trim()); } catch { throw new UserError('The host device tools returned invalid device data.', 'Upgrade pymobiledevice3 and retry.'); }
  if (!Array.isArray(value)) throw new UserError('The host device tools returned invalid device data.');
  const devices: WslDevice[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new UserError('The host device tools returned invalid device data.');
    const data = item as Record<string, unknown>;
    if (typeof data.DeviceClass === 'string' && !['iPhone', 'iPad', 'iPod'].includes(data.DeviceClass)) continue;
    const udid = typeof data.UniqueDeviceID === 'string' ? data.UniqueDeviceID : data.Identifier;
    if (typeof udid !== 'string') throw new UserError('The host device tools returned a device without a UDID.');
    validateUdid(udid);
    if (data.Revealed === true) revealedDeveloperMode.add(udid);
    if (devices.some((device) => device.udid === udid)) continue;
    devices.push({
      udid,
      name: typeof data.DeviceName === 'string' ? data.DeviceName : 'iPhone',
      productVersion: typeof data.ProductVersion === 'string' ? data.ProductVersion : undefined,
      productType: typeof data.ProductType === 'string' ? data.ProductType : undefined,
      connection: 'usb',
      ...(typeof data.DeveloperModeStatus === 'boolean' ? { developerMode: data.DeveloperModeStatus ? 'enabled' as const : 'disabled' as const } : {}),
      ...(data.Paired === false ? { paired: false } : {}),
    });
  }
  return devices;
}

export async function listWslDevices(options: WslDeviceOptions = {}): Promise<WslDevice[]> {
  const devices = await usbIphones(options);
  // An iPhone that doesn't trust this PC yet may not tell its name: it keeps the one it had.
  await rememberIphones(devices.filter((device) => device.paired !== false)).catch(() => undefined);
  // The cable wins when an iPhone is both plugged in and on the Wi-Fi.
  const wifi = (await wifiIphones(options)).filter((udid) => !devices.some((device) => device.udid.toLowerCase() === udid.toLowerCase()));
  const known = wifi.length ? await knownIphones() : {};
  for (const udid of wifi) devices.push({ name: 'iPhone', ...known[udid], udid, connection: 'network' });
  return devices;
}

export async function selectWslDevice(udid?: string, options: WslDeviceOptions = {}): Promise<WslDevice> {
  if (udid) validateUdid(udid);
  const devices = await listWslDevices(options);
  if (udid) {
    const selected = devices.find((device) => device.udid.toLowerCase() === udid.toLowerCase());
    if (selected) return selected;
    throw new UserError(`iPhone ${udid} is not connected over USB or Wi-Fi.`, 'Connect and unlock that device, then accept its Trust prompt. After one run over the cable, it also works over the same Wi-Fi.');
  }
  if (devices.length === 1) return devices[0]!;
  if (!devices.length) throw new UserError('No iPhone or iPad is connected over USB or Wi-Fi.', 'Connect a device, unlock it, and accept “Trust This Computer”. On Windows, Apple Devices provides the required USB drivers. After one run over the cable, it also works over the same Wi-Fi.');
  throw new UserError('More than one iPhone or iPad is connected.', 'Select a device with --target <UDID>.', devices.map((device) => `${device.name}: ${device.udid}`));
}

/**
 * Waits until Developer Mode is on: the user turns it on in Settings, the iPhone restarts (it leaves
 * the list for a while) and they confirm it once it's back. Stop (the signal) ends the wait.
 */
export async function waitForDeveloperMode(device: WslDevice, options: WslDeviceOptions = {}, everyMs = 3_000): Promise<void> {
  validateUdid(device.udid);
  for (;;) {
    cancelled(options.signal);
    // While it restarts, the iPhone is gone or can't answer yet: ask again.
    const found = await usbIphones(options).catch((error: unknown) => {
      if (error instanceof CancelledError) throw error;
      return [] as WslDevice[];
    });
    if (found.find((item) => item.udid.toLowerCase() === device.udid.toLowerCase())?.developerMode === 'enabled') return;
    await wait(everyMs, options.signal);
  }
}

export async function installWslApp(ipaPath: string, device: WslDevice, options: WslDeviceOptions = {}): Promise<void> {
  cancelled(options.signal);
  validateUdid(device.udid);
  const absolute = path.resolve(ipaPath);
  const file = await stat(absolute).catch(() => undefined);
  if (!file?.isFile() || path.extname(absolute).toLowerCase() !== '.ipa') throw new UserError('The signed IPA does not exist.', `Expected a signed .ipa file at ${absolute}.`);
  const wifi = device.connection === 'network';
  await runDevice(['apps', 'install', ...reach(device), '--udid', device.udid, absolute], options, { udid: device.udid, timeoutMs: wifi ? 600_000 : 180_000, wifi });
}

/**
 * Pairs a plugged-in iPhone for Wi-Fi, so later runs work without the cable: the RemotePairing
 * pairing, made over the trusted cable with no prompt on the iPhone. True when it paired it now;
 * Wi-Fi needs iOS 17 or later.
 */
export async function ensureWslWifiPairing(device: WslDevice, options: WslDeviceOptions = {}): Promise<boolean> {
  validateUdid(device.udid);
  if (device.connection === 'network' || !device.productVersion || !atLeast(device.productVersion, '17.0.0')) return false;
  const paired = await stat(path.join(pairingFolder(), `remote_${device.udid}.plist`)).then(() => true, () => false);
  if (paired) return false;
  await runDevice(['lockdown', 'remotepairing', '--pair', '--udid', device.udid], { ...options, onLog: undefined }, { udid: device.udid, timeoutMs: 60_000 });
  return true;
}

function developerTransport(device: WslDevice): string[] {
  if (!device.productVersion || !/^\d+(?:\.\d+)*$/.test(device.productVersion)) {
    throw new UserError('The iPhone iOS version could not be determined.', 'Reconnect the unlocked device and list devices again before launching.');
  }
  if (atLeast(device.productVersion, '17.4.0')) return ['--userspace'];
  if (atLeast(device.productVersion, '17.0.0')) return ['--tunnel', device.udid];
  return ['--udid', device.udid];
}

/**
 * Opens or stops an app through one no-admin tunnel: over the cable through CoreDeviceProxy (iOS
 * 17.4+), over Wi-Fi through RemotePairing (paired over the cable before). argv: launch|stop, UDID,
 * usb|wifi, bundle id|process. While the iPhone is locked, iOS refuses to open apps and shows the
 * passcode screen, so this keeps asking until it is unlocked and says so once (CAPMAC_LOCKED); it
 * prints the app's process (CAPMAC_PID). Any other refusal ends it with Apple's reason.
 */
export const LAUNCH_APP = String.raw`import asyncio,sys
from pymobiledevice3.exceptions import CoreDeviceError
from pymobiledevice3.remote.core_device.app_service import AppServiceService
${OVER_WIFI}def find(value,key,kind=str):
 if isinstance(value,dict):
  if isinstance(value.get(key),kind): yield value[key]
  for item in value.values(): yield from find(item,key,kind)
 elif isinstance(value,(list,tuple)):
  for item in value: yield from find(item,key,kind)
async def main(action,udid,transport,target,*arguments):
 global searches
 # Stopping an app on an iPhone that is away is not worth a wait: its app is not running either.
 if action=='stop': searches=1
 if transport=='wifi': userspace_tunnel._create_no_root_tunnel_provider=over_wifi
 tunnel=userspace_tunnel.UserspaceRsdTunnel(serial=udid)
 rsd=await asyncio.wait_for(tunnel.aopen(),120)
 try:
  async with AppServiceService(rsd) as apps:
   if action=='stop':
    await asyncio.wait_for(apps.send_signal_to_process(int(target),9),60)
    return
   told=False
   while True:
    try: launched=await asyncio.wait_for(apps.launch_application(target,list(arguments)),120)
    except CoreDeviceError as error:
     details=error.user_info or {}
     if 'Locked' not in find(details,'BSErrorCodeDescription'): raise SystemExit(' '.join([str(error),*list(find(details,'NSLocalizedFailureReason'))[-1:]]))
     if not told: print('CAPMAC_LOCKED',flush=True); told=True
     await asyncio.sleep(2)
     continue
    for pid in find(launched,'processIdentifier',int):
     print('CAPMAC_PID',pid,flush=True)
     break
    return
 finally: await tunnel.aclose()
asyncio.run(main(*sys.argv[1:]))
`;

/** The process each launch opened, so a run can stop its app over Wi-Fi. */
const launchedProcesses = new Map<string, number>();

/**
 * Mounts developer services and waits for a confirmed launch; there is no manual-open success fallback.
 * `onLocked`: the iPhone is locked, and the app opens once it is unlocked (Stop ends the wait).
 */
export async function launchWslApp(bundleId: string, device: WslDevice, options: WslDeviceOptions & { args?: string[] } = {}): Promise<void> {
  validateUdid(device.udid);
  validateBundleId(bundleId);
  const wifi = device.connection === 'network';
  const transport = wifi ? [] : developerTransport(device);
  await runDevice(['mounter', 'auto-mount', ...reach(device), '--udid', device.udid], options, { udid: device.udid, timeoutMs: wifi ? 600_000 : 180_000, wifi });
  if (wifi || atLeast(device.productVersion!, '17.4.0')) {
    const python = await requirePython(options);
    const onLog = (line: string) => {
      const pid = /^CAPMAC_PID (\d+)$/.exec(line)?.[1];
      if (pid) launchedProcesses.set(`${device.udid}:${bundleId}`, Number(pid));
      else if (line === 'CAPMAC_LOCKED') options.onLocked?.();
      else options.onLog?.(line);
    };
    const output = await execute(python, ['-c', LAUNCH_APP, 'launch', device.udid, wifi ? 'wifi' : 'usb', bundleId, ...(options.args ?? [])], { ...options, onLog }, { udid: device.udid, stream: true });
    if (output.code !== 0) throw commandError('Opening the app', output);
    return;
  }
  const args = options.args ?? [];
  // dvt's launch takes the bundle id and its arguments as one line, the way a shell splits it.
  const shellWord = (word: string) => (/^[A-Za-z0-9_.:/=@+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
  const command = atLeast(device.productVersion!, '17.0.0')
    ? ['developer', 'core-device', 'launch-application', ...transport, bundleId, ...args]
    : ['developer', 'dvt', 'launch', ...transport, [bundleId, ...args].map(shellWord).join(' ')];
  await runDevice(command, options, { udid: device.udid, timeoutMs: 60_000 });
}

/** Exact bundle lookup avoids pkill's substring matching, which can kill another app. */
export async function stopWslApp(bundleId: string, device: WslDevice, options: WslDeviceOptions = {}): Promise<void> {
  validateUdid(device.udid);
  validateBundleId(bundleId);
  if (device.connection === 'network') {
    // Over Wi-Fi, the process the launch reported: nothing to stop when it opened none here.
    const pid = launchedProcesses.get(`${device.udid}:${bundleId}`);
    if (pid === undefined) return;
    launchedProcesses.delete(`${device.udid}:${bundleId}`);
    const output = await execute(await requirePython(options), ['-c', LAUNCH_APP, 'stop', device.udid, 'wifi', String(pid)], { ...options, onLog: undefined }, { udid: device.udid, timeoutMs: 180_000 });
    if (output.code !== 0) throw commandError('Stopping the app', output);
    return;
  }
  const transport = developerTransport(device);
  const pidText = await runDevice(['developer', 'dvt', 'process-id-for-bundle-id', ...transport, bundleId], { ...options, onLog: undefined }, { udid: device.udid });
  const pid = Number(pidText.trim());
  if (!/^\d+$/.test(pidText.trim()) || !Number.isSafeInteger(pid)) throw new UserError('Could not determine the running app process.', 'Check the device developer services and retry.');
  if (pid === 0) return;
  await runDevice(['developer', 'dvt', 'kill', ...transport, String(pid)], options, { udid: device.udid });
}

export async function streamWslDeviceLogs(
  device: WslDevice, options: WslDeviceOptions & { processName?: string } = {},
): Promise<void> {
  validateUdid(device.udid);
  const wifi = device.connection === 'network';
  const args = ['syslog', 'live', ...reach(device), '--udid', device.udid];
  if (options.processName) args.push('--process-name', options.processName);
  // The stream ends when the iPhone goes: unplugged, or off this Wi-Fi.
  const hint = wifi ? 'Keep the iPhone on this Wi-Fi and awake, or plug it in.' : 'The iPhone was unplugged. Plug it in again, or run over Wi-Fi.';
  for (;;) {
    let details: string[] | undefined;
    try {
      await runDevice(args, options, { udid: device.udid, stream: true, wifi });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      details = error.details;
      // Over Wi-Fi a locked or asleep iPhone drops the stream: wait for it to come back while the run lasts.
      if (!wifi || !DROPPED.test((details ?? []).join('\n'))) throw new UserError('The iPhone log stream ended.', hint, details);
    }
    if (!wifi) throw new UserError('The iPhone log stream ended.', hint, details);
    options.onLocked?.();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    cancelled(options.signal);
  }
}
