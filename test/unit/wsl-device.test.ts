import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelledError } from '../../packages/core/src/engine/errors.js';
import {
  ensureWslWifiPairing, inspectWslDeviceTools, installWslApp, LAUNCH_APP, launchWslApp, listWslDevices, mountWslDeveloperImage, selectWslDevice,
  stopWslApp, streamWslDeviceLogs, USB_IPHONES, waitForDeveloperMode, WIFI_COMMAND, WIFI_IPHONES, wslDeviceTarget,
} from '../../packages/core/src/engine/wsl/device.js';

interface Reply { stdout?: string[]; stderr?: string; code?: number | null; hold?: boolean; error?: Error }
const boundary = vi.hoisted(() => ({ spawn: vi.fn(), replies: [] as Reply[], probe: undefined as Reply | undefined }));
vi.mock('node:child_process', () => ({ spawn: boundary.spawn }));

const udid = '00008110-001A2B3C4D5E001E';
const device = { udid, name: 'Test iPhone', productVersion: '18.5' };
const options = { python: 'C:\\Managed Python\\python.exe' };
const info = [{ DeviceClass: 'iPhone', DeviceName: device.name, UniqueDeviceID: udid, ProductVersion: device.productVersion, ProductType: 'iPhone17,3' }];
const probeOk: Reply = { stdout: ['{"python":"3.13.2","pymobiledevice3":"11.32.0"}'] };
let directories: string[] = [];

let home: string;

beforeEach(async () => {
  // Wi-Fi pairings and remembered iPhones live in a home folder of the test's own.
  home = await mkdtemp(path.join(os.tmpdir(), 'capmac-home-'));
  directories.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('LOCALAPPDATA', home);
  boundary.replies = [];
  boundary.probe = undefined;
  boundary.spawn.mockReset();
  boundary.spawn.mockImplementation((_file: string, args: string[]) => {
    const reply = probing(args) ? boundary.probe ?? probeOk : boundary.replies.shift() ?? {};
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; }),
    });
    queueMicrotask(() => {
      if (reply.error) { child.emit('error', reply.error); return; }
      for (const chunk of reply.stdout ?? []) child.stdout.write(chunk);
      if (reply.stderr) child.stderr.write(reply.stderr);
      if (!reply.hold) child.emit('close', reply.code === undefined ? 0 : reply.code);
    });
    return child;
  });
});

afterEach(async () => {
  vi.mocked(os.homedir).mockRestore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

function probing(args: string[]): boolean {
  return args.includes('-c') && String(args[args.indexOf('-c') + 1]).includes('importlib.metadata');
}

function commands(): Array<{ file: string; args: string[]; options: Record<string, unknown> }> {
  return boundary.spawn.mock.calls.filter((call) => !probing(call[1] as string[])).map(([file, args, spawnOptions]) => ({ file, args, options: spawnOptions }));
}

describe('host iPhone tooling', () => {
  it('reports the host Python and supported pymobiledevice3 version without invoking device commands', async () => {
    await expect(inspectWslDeviceTools(options)).resolves.toEqual({ ready: true, python: options.python, pythonVersion: '3.13.2', pymobiledevice3Version: '11.32.0', issues: [] });
    expect(commands()).toHaveLength(0);
  });

  it('uses the Python CapMac set up for another project when this one names none', async () => {
    vi.stubEnv('CAPMAC_PYTHON', '');
    const own = path.join(home, 'CapMac', 'device-tools', '11.32.0-python-3.13.16', 'python.exe');
    await mkdir(path.dirname(own), { recursive: true });
    await writeFile(own, '');
    await expect(inspectWslDeviceTools()).resolves.toMatchObject({ ready: true, python: own });
    expect(boundary.spawn.mock.calls[0]?.slice(0, 2)).toEqual([own, ['-I', '-c', expect.stringContaining('importlib.metadata')]]);
  });

  it('explains an absent module and an unsupported older version', async () => {
    boundary.probe = { stdout: ['{"python":"3.13.2","pymobiledevice3":null}'] };
    expect(await inspectWslDeviceTools(options)).toMatchObject({ ready: false, issues: [expect.stringContaining('Install pymobiledevice3 11.32.0')] });
    boundary.probe = { stdout: ['{"python":"3.13.2","pymobiledevice3":"9.9.0"}'] };
    expect(await inspectWslDeviceTools(options)).toMatchObject({ ready: false, issues: [expect.stringContaining('Upgrade host pymobiledevice3')] });
    await expect(listWslDevices(options)).rejects.toMatchObject({ expected: true, message: 'The host iPhone tools are not ready.' });
    expect(commands()).toHaveLength(0);
  });

  it('uses the Windows Python launcher without passing a shell command', async () => {
    await inspectWslDeviceTools({ python: 'py' });
    expect(boundary.spawn.mock.calls[0]?.[1].slice(0, 2)).toEqual(['-3', '-c']);
    expect(boundary.spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('reports a missing executable as a setup problem', async () => {
    boundary.probe = { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
    expect(await inspectWslDeviceTools(options)).toMatchObject({ ready: false, issues: [expect.stringContaining('Install Python on the host')] });
  });
});

describe('USB device discovery', () => {
  it('parses pymobiledevice3 JSON and filters unsupported device classes', async () => {
    boundary.replies.push({ stdout: [JSON.stringify([...info, { ...info[0], DeviceClass: 'AppleTV' }])] });
    await expect(listWslDevices(options)).resolves.toEqual([{ ...device, productType: 'iPhone17,3', connection: 'usb' }]);
    expect(commands()[0]?.args.slice(0, 2)).toEqual(['-c', USB_IPHONES]);
  });

  it('tells which iPhones have Developer Mode off or don’t trust this PC, and shows the switch in Settings once', async () => {
    const off = { ...info[0], UniqueDeviceID: '00008110-001A2B3C4D5E005E', DeviceName: 'Dev iPhone', Paired: true, DeveloperModeStatus: false, Revealed: true };
    const untrusted = { ...info[0], UniqueDeviceID: '00008110-001A2B3C4D5E004E', DeviceName: 'Spare iPhone', Paired: false };
    boundary.replies.push({ stdout: [JSON.stringify([off, untrusted])] });
    const devices = await listWslDevices(options);
    expect(devices).toEqual([
      { udid: off.UniqueDeviceID, name: 'Dev iPhone', productVersion: '18.5', productType: 'iPhone17,3', connection: 'usb', developerMode: 'disabled' },
      { udid: untrusted.UniqueDeviceID, name: 'Spare iPhone', productVersion: '18.5', productType: 'iPhone17,3', connection: 'usb', paired: false },
    ]);
    expect(devices.map(wslDeviceTarget)).toMatchObject([{ developerMode: 'disabled', available: false }, { paired: false, available: false }]);
    // Turned on: ready to run. The switch was shown on it already, so this listing doesn't show it again.
    boundary.replies.push({ stdout: [JSON.stringify([{ ...off, DeveloperModeStatus: true, Revealed: undefined }])] });
    const [on] = await listWslDevices(options);
    expect(on).toMatchObject({ developerMode: 'enabled' });
    expect(wslDeviceTarget(on!)).toMatchObject({ developerMode: 'enabled', available: true });
    expect(commands().at(-1)?.args).toEqual(['-c', USB_IPHONES, off.UniqueDeviceID]);
  });

  it('waits for Developer Mode while the iPhone restarts, and Stop ends the wait', async () => {
    const off = { ...info[0], DeveloperModeStatus: false };
    boundary.replies.push(
      { stdout: [JSON.stringify([off])] },
      // Restarting: the iPhone can't answer, then it is gone for a while.
      { code: 1, stderr: 'ConnectionFailedError: the device restarted' },
      { stdout: ['[]'] },
      { stdout: [JSON.stringify([{ ...off, DeveloperModeStatus: true }])] },
    );
    await waitForDeveloperMode(device, options, 1);
    expect(commands()).toHaveLength(4);
    const stop = new AbortController();
    boundary.replies.push({ stdout: [JSON.stringify([off])] });
    const waiting = waitForDeveloperMode(device, { ...options, signal: stop.signal }, 60_000);
    await vi.waitFor(() => expect(commands()).toHaveLength(5));
    stop.abort();
    await expect(waiting).rejects.toBeInstanceOf(CancelledError);
  });

  it('requires an explicit choice for multiple iPhones and never silently switches devices', async () => {
    const second = { ...info[0], UniqueDeviceID: '00008110-001A2B3C4D5E002E', DeviceName: 'Second iPhone' };
    boundary.replies.push({ stdout: [JSON.stringify([...info, second])] });
    await expect(selectWslDevice(undefined, options)).rejects.toMatchObject({ message: 'More than one iPhone or iPad is connected.', hint: expect.stringContaining('--target') });
    boundary.replies.push({ stdout: [JSON.stringify(info)] });
    await expect(selectWslDevice(second.UniqueDeviceID, options)).rejects.toMatchObject({ message: expect.stringContaining('is not connected') });
  });

  it('distinguishes malformed device output from no connected devices', async () => {
    boundary.replies.push({ stdout: ['not json'] });
    await expect(listWslDevices(options)).rejects.toThrow('invalid device data');
    boundary.replies.push({ stdout: ['[]'] });
    await expect(selectWslDevice(undefined, options)).rejects.toThrow('No iPhone or iPad');
  });

  it('translates trust failures without hiding the process failure', async () => {
    boundary.replies.push({ code: 1, stderr: 'PairingDialogResponsePending: accept Trust dialog' });
    await expect(listWslDevices(options)).rejects.toMatchObject({ hint: expect.stringContaining('Trust This Computer'), details: [expect.stringContaining('PairingDialogResponsePending')] });
  });
});

describe('install and launch', () => {
  it('passes a signed IPA path literally to the host and resets inherited device routing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-device-'));
    directories.push(directory);
    const ipa = path.join(directory, 'signed app $(whoami).ipa');
    await writeFile(ipa, 'fixture');
    vi.stubEnv('PYMOBILEDEVICE3_TUNNEL', 'wrong-device@attacker:9000');
    vi.stubEnv('PYMOBILEDEVICE3_UDID', 'wrong-device');
    vi.stubEnv('USBMUXD_SOCKET_ADDRESS', 'attacker:9000');
    await installWslApp(ipa, device, options);
    const command = commands()[0]!;
    expect(command.args).toEqual(['-m', 'pymobiledevice3', '--no-color', 'apps', 'install', '--udid', udid, ipa]);
    expect(command.options).toMatchObject({ shell: false, env: { PYMOBILEDEVICE3_UDID: udid } });
    expect(command.options.env).not.toHaveProperty('PYMOBILEDEVICE3_TUNNEL');
    expect(command.options.env).not.toHaveProperty('USBMUXD_SOCKET_ADDRESS');
  });

  it('rejects missing IPA files, invalid bundle identifiers, and UDIDs before invoking tools', async () => {
    await expect(installWslApp('missing.ipa', device, options)).rejects.toThrow('signed IPA does not exist');
    await expect(launchWslApp('--help; rm -rf /', device, options)).rejects.toThrow('Invalid iOS bundle');
    await expect(selectWslDevice('--help', options)).rejects.toThrow('Invalid iPhone UDID');
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('mounts developer services, then opens the app through one unprivileged userspace tunnel', async () => {
    await launchWslApp('com.example.app', device, options);
    expect(commands()[0]?.args.slice(3)).toEqual(['mounter', 'auto-mount', '--udid', udid]);
    expect(commands()[1]?.args).toEqual(['-c', LAUNCH_APP, 'launch', udid, 'usb', 'com.example.app']);
    expect(commands()[1]?.options.env).toHaveProperty('PYMOBILEDEVICE3_UDID', udid);
  });

  it('waits while the iPhone is locked, and says so once', async () => {
    const onLocked = vi.fn();
    const onLog = vi.fn();
    boundary.replies.push({}, { stdout: ['CAPMAC_LOCKED\n'] });
    await launchWslApp('com.example.app', device, { ...options, onLocked, onLog });
    expect(onLocked).toHaveBeenCalledOnce();
    expect(onLog).not.toHaveBeenCalledWith('CAPMAC_LOCKED');
    // Any other refusal stops with Apple's reason.
    boundary.replies.push({}, { code: 1, stderr: 'Failed to invoke com.apple.coredevice.feature.launchapplication: The application failed to launch. (code 10002) Unable to launch because of an invalid signature.' });
    await expect(launchWslApp('com.example.app', device, options)).rejects.toMatchObject({ message: 'Opening the app failed (exit 1).', details: [expect.stringContaining('invalid signature')] });
  });

  it('uses the selected tunneld device for iOS 17.0–17.3 and DVT for iOS 16', async () => {
    await launchWslApp('com.example.app', { ...device, productVersion: '17.3.1' }, options);
    expect(commands()[1]?.args.slice(3)).toEqual(['developer', 'core-device', 'launch-application', '--tunnel', udid, 'com.example.app']);
    await launchWslApp('com.example.app', { ...device, productVersion: '16.7' }, options);
    expect(commands()[3]?.args.slice(3)).toEqual(['developer', 'dvt', 'launch', '--udid', udid, 'com.example.app']);
  });

  it('mounts the developer image once a locked iPhone is unlocked, says so once, and Stop ends the wait', async () => {
    // A restarted iPhone is locked and has no developer image: it refuses the image (the end of what
    // the tools printed on a real one).
    const locked = { code: 1, stderr: [
      '| > 222             raise PyMobileDevice3Exception(f"command ReceiveBytes     |',
      '|       failed with: {result}")                                               |',
      '+-----------------------------------------------------------------------------+',
      "PyMobileDevice3Exception: command ReceiveBytes failed with: {'Error': ",
      "'DeviceLocked'}",
    ].join('\r\n') + '\r\n' };
    const onLocked = vi.fn();
    const onLog = vi.fn();
    boundary.replies.push(locked, locked, { stderr: 'INFO DeveloperDiskImage mounted successfully\n' });
    await mountWslDeveloperImage(device, { ...options, onLocked, onLog }, 1);
    expect(commands().map((call) => call.args.slice(3))).toEqual(Array(3).fill(['mounter', 'auto-mount', '--udid', udid]));
    expect(onLocked).toHaveBeenCalledOnce();
    // The refused tries' tracebacks stay out of the log.
    expect(onLog.mock.calls.map(([line]) => line)).toEqual(['INFO DeveloperDiskImage mounted successfully']);
    const stop = new AbortController();
    boundary.replies.push(locked);
    const waiting = mountWslDeveloperImage(device, { ...options, signal: stop.signal }, 60_000);
    await vi.waitFor(() => expect(commands()).toHaveLength(4));
    stop.abort();
    await expect(waiting).rejects.toBeInstanceOf(CancelledError);
  });

  it('does not report launch success or attempt launch when developer image mounting fails', async () => {
    boundary.replies.push({ code: 1, stderr: 'DeveloperModeIsNotEnabled' });
    await expect(launchWslApp('com.example.app', device, options)).rejects.toMatchObject({ hint: expect.stringContaining('Developer Mode') });
    expect(commands()).toHaveLength(1);
  });

  it('fails the run when launch fails and explains a missing iOS 17 tunnel', async () => {
    boundary.replies.push({}, { code: 1, stderr: 'ConnectionRefused: tunneld is unavailable' });
    await expect(launchWslApp('com.example.app', { ...device, productVersion: '17.2' }, options)).rejects.toMatchObject({ message: expect.stringContaining('failed'), hint: expect.stringContaining('administrator') });
    expect(commands()).toHaveLength(2);
  });

  it('stops only the PID resolved from the exact bundle identifier', async () => {
    boundary.replies.push({ stdout: ['321\n'] }, {});
    await stopWslApp('com.example.app', device, options);
    expect(commands().map((call) => call.args.slice(3))).toEqual([
      ['developer', 'dvt', 'process-id-for-bundle-id', '--userspace', 'com.example.app'],
      ['developer', 'dvt', 'kill', '--userspace', '321'],
    ]);
  });

  it('does not kill anything when the exact process lookup is invalid', async () => {
    boundary.replies.push({ stdout: [''] });
    await expect(stopWslApp('com.example.app', device, options)).rejects.toThrow('Could not determine');
    expect(commands()).toHaveLength(1);
  });
});

describe('Wi-Fi', () => {
  const wifi = { ...device, connection: 'network' as const };

  it('lists iPhones paired for Wi-Fi on this network, named from when they were plugged in, and the cable wins', async () => {
    await mkdir(path.join(home, '.pymobiledevice3'));
    await writeFile(path.join(home, '.pymobiledevice3', `remote_${udid}.plist`), 'pairing');
    const other = '00008110-001A2B3C4D5E003E';
    boundary.replies.push({ stdout: [JSON.stringify(info)] }, { stdout: [JSON.stringify([udid])] });
    expect(await listWslDevices(options)).toEqual([{ ...device, productType: 'iPhone17,3', connection: 'usb' }]);
    expect(commands().at(-1)?.args).toEqual(['-c', WIFI_IPHONES]);
    // Unplugged, the same iPhone is on the Wi-Fi; one never seen over the cable has no name yet.
    boundary.replies.push({ stdout: ['[]'] }, { stdout: [JSON.stringify([udid, other])] });
    expect(await listWslDevices(options)).toEqual([
      { udid, name: device.name, productVersion: '18.5', productType: 'iPhone17,3', connection: 'network' },
      { udid: other, name: 'iPhone', connection: 'network' },
    ]);
    // A search that misses a sleepy iPhone keeps one seen a moment ago; after 30 seconds it is gone.
    boundary.replies.push({ stdout: [JSON.stringify(info)] }, { code: 1, stderr: 'OSError' });
    expect((await listWslDevices(options)).map((item) => `${item.udid} ${item.connection}`)).toEqual([`${udid} usb`, `${other} network`]);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    boundary.replies.push({ stdout: [JSON.stringify(info)] }, { stdout: ['[]'] });
    expect(await listWslDevices(options)).toHaveLength(1);
    vi.mocked(Date.now).mockRestore();
  });

  it('looks for nothing on the Wi-Fi before an iPhone was paired for it', async () => {
    boundary.replies.push({ stdout: ['[]'] });
    expect(await listWslDevices(options)).toEqual([]);
    expect(commands()).toHaveLength(1);
  });

  it('installs, opens, stops and streams logs over Wi-Fi', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-device-'));
    directories.push(directory);
    const ipa = path.join(directory, 'App.ipa');
    await writeFile(ipa, 'fixture');
    await installWslApp(ipa, wifi, options);
    // Over Wi-Fi every command goes through the no-admin tunnel, reaching the iPhone by RemotePairing.
    expect(commands()[0]?.args.slice(0, 2)).toEqual(['-c', WIFI_COMMAND]);
    expect(commands()[0]?.args.slice(3)).toEqual(['apps', 'install', '--userspace', '--udid', udid, ipa]);
    boundary.replies.push({}, { stdout: ['CAPMAC_PID 4321\n'] });
    await launchWslApp('com.example.app', wifi, options);
    expect(commands()[1]?.args.slice(3)).toEqual(['mounter', 'auto-mount', '--userspace', '--udid', udid]);
    expect(commands()[2]?.args).toEqual(['-c', LAUNCH_APP, 'launch', udid, 'wifi', 'com.example.app']);
    await stopWslApp('com.example.app', wifi, options);
    expect(commands()[3]?.args).toEqual(['-c', LAUNCH_APP, 'stop', udid, 'wifi', '4321']);
    // Stopped once: nothing left to stop.
    await stopWslApp('com.example.app', wifi, options);
    expect(commands()).toHaveLength(4);
    // A stream the iPhone dropped (locked, asleep) comes back while the run lasts; Stop ends the wait.
    const run = new AbortController();
    const onLocked = vi.fn(() => run.abort());
    boundary.replies.push({ code: 1, stderr: 'ERROR Connection was terminated abruptly' });
    await expect(streamWslDeviceLogs(wifi, { ...options, onLocked, signal: run.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(onLocked).toHaveBeenCalledOnce();
    expect(commands()[4]?.args.slice(3)).toEqual(['syslog', 'live', '--userspace', '--udid', udid]);
    // Any other failure ends it.
    boundary.replies.push({ code: 1, stderr: 'InvalidServiceError' });
    await expect(streamWslDeviceLogs(wifi, options)).rejects.toMatchObject({ message: 'The iPhone log stream ended.', hint: expect.stringContaining('Wi-Fi') });
  });

  it('waits for an asleep iPhone to come back on the Wi-Fi, and says so once', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-device-'));
    directories.push(directory);
    const ipa = path.join(directory, 'App.ipa');
    await writeFile(ipa, 'fixture');
    const onLocked = vi.fn();
    const onLog = vi.fn();
    boundary.replies.push({ stdout: ['CAPMAC_LOCKED\n', 'Installation succeed.\n'] });
    await installWslApp(ipa, wifi, { ...options, onLocked, onLog });
    expect(onLocked).toHaveBeenCalledOnce();
    expect(onLog).toHaveBeenCalledWith('Installation succeed.');
    expect(onLog).not.toHaveBeenCalledWith('CAPMAC_LOCKED');
  });

  it('tries a Wi-Fi command again when a locked iPhone drops the tunnel, and asks for it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-device-'));
    directories.push(directory);
    const ipa = path.join(directory, 'App.ipa');
    await writeFile(ipa, 'fixture');
    const onLocked = vi.fn();
    const dropped = { code: 1, stderr: 'pymobiledevice3.remote.tunnel_service.RemotePairingTcpTunnel WARNING got ConnectionResetError\nERROR Connection was terminated abruptly' };
    boundary.replies.push(dropped, { stdout: ['Installation succeed.\n'] });
    await installWslApp(ipa, wifi, { ...options, onLocked });
    expect(onLocked).toHaveBeenCalledOnce();
    expect(commands()).toHaveLength(2);
    // Three drops in a row stop it, with a Wi-Fi hint rather than a Trust one.
    boundary.replies.push(dropped, dropped, dropped);
    await expect(installWslApp(ipa, wifi, { ...options, onLocked })).rejects.toMatchObject({ hint: expect.stringContaining('dropped the Wi-Fi connection') });
    expect(commands()).toHaveLength(5);
    // Over the cable, a failure is not tried again.
    boundary.replies.push(dropped);
    await expect(installWslApp(ipa, device, options)).rejects.toBeInstanceOf(Error);
    expect(commands()).toHaveLength(6);
  });

  it('pairs a plugged-in iPhone for Wi-Fi once, with no prompt on it', async () => {
    await expect(ensureWslWifiPairing(device, options)).resolves.toBe(true);
    expect(commands().map((call) => call.args.slice(3))).toEqual([['lockdown', 'remotepairing', '--pair', '--udid', udid]]);
    await mkdir(path.join(home, '.pymobiledevice3'));
    await writeFile(path.join(home, '.pymobiledevice3', `remote_${udid}.plist`), 'pairing');
    await expect(ensureWslWifiPairing(device, options)).resolves.toBe(false);
    await expect(ensureWslWifiPairing({ ...device, productVersion: '16.7' }, options)).resolves.toBe(false);
    await expect(ensureWslWifiPairing(wifi, options)).resolves.toBe(false);
    expect(commands()).toHaveLength(1);
  });
});

describe('cancellation and logs', () => {
  it('does not start any process for an already-cancelled operation', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(listWslDevices({ ...options, signal: abort.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('buffers partial log lines, filters the requested process, and kills the host process on cancellation', async () => {
    const abort = new AbortController();
    const onLog = vi.fn();
    boundary.replies.push({ stdout: ['first par', 't\nsecond\n'], hold: true });
    const streaming = streamWslDeviceLogs(device, { ...options, processName: 'App', signal: abort.signal, onLog });
    const failed = expect(streaming).rejects.toBeInstanceOf(CancelledError);
    await vi.waitFor(() => expect(onLog).toHaveBeenCalledWith('second'));
    abort.abort();
    await failed;
    expect(onLog.mock.calls.map(([line]) => line)).toEqual(['first part', 'second']);
    expect(commands()[0]?.args.slice(3)).toEqual(['syslog', 'live', '--udid', udid, '--process-name', 'App']);
    expect(boundary.spawn.mock.results.at(-1)?.value.kill).toHaveBeenCalledOnce();
  });

  it('treats an unexpectedly closed log transport as a failure even when its process exits zero', async () => {
    await expect(streamWslDeviceLogs(device, options)).rejects.toThrow('log stream ended');
  });

  it('terminates a stalled command and reports the timeout as a failure', async () => {
    vi.useFakeTimers();
    boundary.replies.push({ hold: true });
    const listing = listWslDevices(options);
    const failed = expect(listing).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(boundary.spawn.mock.results.at(-1)?.value.kill).toHaveBeenCalledOnce();
  });
});
