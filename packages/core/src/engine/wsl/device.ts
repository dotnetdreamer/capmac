/** Device I/O stays on the host: Windows owns the USB cable, WSL only builds. */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Target } from '../../shared/protocol.js';
import { CancelledError, UserError } from '../errors.js';

// These commands and the unprivileged userspace tunnel were verified against this release.
export const WSL_DEVICE_TOOL_VERSION = '11.32.0';

export interface WslDevice {
  udid: string;
  name: string;
  productVersion?: string;
  productType?: string;
}

/** An iPhone plugged into this PC, as the target pickers show devices. */
export function wslDeviceTarget(device: WslDevice): Target {
  return {
    kind: 'device', udid: device.udid, name: device.name,
    os: device.productVersion ? `iOS ${device.productVersion}` : 'iOS', osVersion: device.productVersion ?? '',
    state: 'connected', available: true, connection: 'usb', ...(device.productType ? { model: device.productType } : {}),
  };
}

export interface WslDeviceOptions {
  /** Host Python executable path, not a shell command. */
  python?: string;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
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
  return { executable, prefix: /(^|[\\/])py(?:\.exe)?$/i.test(executable) ? ['-3'] : [] };
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

/** Read-only doctor probe; it never installs Python, pip packages, drivers, or device services. */
export async function inspectWslDeviceTools(options: WslDeviceOptions = {}): Promise<WslDeviceTools> {
  const configured = options.python ?? process.env.CAPMAC_PYTHON;
  const candidates = configured ? [configured] : process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
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

function commandError(action: string, output: ProcessOutput): UserError {
  const text = `${output.stderr}\n${output.stdout}`;
  let hint = 'Check the device output, unlock the iPhone, and retry.';
  if (/DeveloperMode|developer mode|DeveloperDiskImage|personalized.*image|InvalidService|InvalidServiceError/i.test(text)) {
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
  args: string[], options: WslDeviceOptions, settings: { udid?: string; timeoutMs?: number; stream?: boolean } = {},
): Promise<string> {
  const python = await requirePython(options);
  const output = await execute(python, ['-m', 'pymobiledevice3', '--no-color', ...args], options, settings);
  if (output.code !== 0) throw commandError('The iPhone command', output);
  return output.stdout;
}

function validateUdid(udid: string): void {
  if (!/^[a-f\d-]{8,64}$/i.test(udid)) throw new UserError('Invalid iPhone UDID.', 'Use a UDID listed by capmac wsl targets.');
}

function validateBundleId(bundleId: string): void {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new UserError('Invalid iOS bundle identifier.', 'Use an identifier such as com.example.app.');
}

export async function listWslDevices(options: WslDeviceOptions = {}): Promise<WslDevice[]> {
  const stdout = await runDevice(['usbmux', 'list', '--usb'], { ...options, onLog: undefined });
  let value: unknown;
  try { value = JSON.parse(stdout.trim()); } catch { throw new UserError('The host device tools returned invalid device data.', 'Upgrade pymobiledevice3 and retry.'); }
  if (!Array.isArray(value)) throw new UserError('The host device tools returned invalid device data.');
  const devices: WslDevice[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new UserError('The host device tools returned invalid device data.');
    const data = item as Record<string, unknown>;
    if (typeof data.DeviceClass === 'string' && !['iPhone', 'iPad', 'iPod'].includes(data.DeviceClass)) continue;
    const udid = typeof data.UniqueDeviceID === 'string' ? data.UniqueDeviceID : data.Identifier;
    if (typeof udid !== 'string') throw new UserError('The host device tools returned a device without a UDID.');
    validateUdid(udid);
    if (devices.some((device) => device.udid === udid)) continue;
    devices.push({
      udid,
      name: typeof data.DeviceName === 'string' ? data.DeviceName : 'iPhone',
      productVersion: typeof data.ProductVersion === 'string' ? data.ProductVersion : undefined,
      productType: typeof data.ProductType === 'string' ? data.ProductType : undefined,
    });
  }
  return devices;
}

export async function selectWslDevice(udid?: string, options: WslDeviceOptions = {}): Promise<WslDevice> {
  if (udid) validateUdid(udid);
  const devices = await listWslDevices(options);
  if (udid) {
    const selected = devices.find((device) => device.udid.toLowerCase() === udid.toLowerCase());
    if (selected) return selected;
    throw new UserError(`iPhone ${udid} is not connected over USB.`, 'Connect and unlock that device, then accept its Trust prompt.');
  }
  if (devices.length === 1) return devices[0]!;
  if (!devices.length) throw new UserError('No iPhone or iPad is connected over USB.', 'Connect a device, unlock it, and accept “Trust This Computer”. On Windows, Apple Devices provides the required USB drivers.');
  throw new UserError('More than one iPhone or iPad is connected.', 'Select a device with --target <UDID>.', devices.map((device) => `${device.name}: ${device.udid}`));
}

export async function installWslApp(ipaPath: string, device: WslDevice, options: WslDeviceOptions = {}): Promise<void> {
  cancelled(options.signal);
  validateUdid(device.udid);
  const absolute = path.resolve(ipaPath);
  const file = await stat(absolute).catch(() => undefined);
  if (!file?.isFile() || path.extname(absolute).toLowerCase() !== '.ipa') throw new UserError('The signed IPA does not exist.', `Expected a signed .ipa file at ${absolute}.`);
  await runDevice(['apps', 'install', '--udid', device.udid, absolute], options, { udid: device.udid, timeoutMs: 180_000 });
}

function developerTransport(device: WslDevice): string[] {
  if (!device.productVersion || !/^\d+(?:\.\d+)*$/.test(device.productVersion)) {
    throw new UserError('The iPhone iOS version could not be determined.', 'Reconnect the unlocked device and list devices again before launching.');
  }
  if (atLeast(device.productVersion, '17.4.0')) return ['--userspace'];
  if (atLeast(device.productVersion, '17.0.0')) return ['--tunnel', device.udid];
  return ['--udid', device.udid];
}

/** Mounts developer services and waits for a confirmed launch; there is no manual-open success fallback. */
export async function launchWslApp(bundleId: string, device: WslDevice, options: WslDeviceOptions = {}): Promise<void> {
  validateUdid(device.udid);
  validateBundleId(bundleId);
  const transport = developerTransport(device);
  await runDevice(['mounter', 'auto-mount', '--udid', device.udid], options, { udid: device.udid, timeoutMs: 180_000 });
  const command = atLeast(device.productVersion!, '17.0.0')
    ? ['developer', 'core-device', 'launch-application', ...transport, bundleId]
    : ['developer', 'dvt', 'launch', ...transport, bundleId];
  await runDevice(command, options, { udid: device.udid, timeoutMs: 60_000 });
}

/** Exact bundle lookup avoids pkill's substring matching, which can kill another app. */
export async function stopWslApp(bundleId: string, device: WslDevice, options: WslDeviceOptions = {}): Promise<void> {
  validateUdid(device.udid);
  validateBundleId(bundleId);
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
  const args = ['syslog', 'live', '--udid', device.udid];
  if (options.processName) args.push('--process-name', options.processName);
  await runDevice(args, options, { udid: device.udid, stream: true });
  throw new UserError('The iPhone log stream ended.', 'Check the USB connection and reconnect the device.');
}
