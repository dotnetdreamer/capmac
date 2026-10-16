import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelledError } from '../../packages/core/src/engine/errors.js';
import {
  inspectWslDeviceTools, installWslApp, launchWslApp, listWslDevices, selectWslDevice,
  stopWslApp, streamWslDeviceLogs,
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

beforeEach(() => {
  boundary.replies = [];
  boundary.probe = undefined;
  boundary.spawn.mockReset();
  boundary.spawn.mockImplementation((_file: string, args: string[]) => {
    const reply = args.includes('-c') ? boundary.probe ?? probeOk : boundary.replies.shift() ?? {};
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

function commands(): Array<{ file: string; args: string[]; options: Record<string, unknown> }> {
  return boundary.spawn.mock.calls.filter((call) => !(call[1] as string[]).includes('-c')).map(([file, args, spawnOptions]) => ({ file, args, options: spawnOptions }));
}

describe('host iPhone tooling', () => {
  it('reports the host Python and supported pymobiledevice3 version without invoking device commands', async () => {
    await expect(inspectWslDeviceTools(options)).resolves.toEqual({ ready: true, python: options.python, pythonVersion: '3.13.2', pymobiledevice3Version: '11.32.0', issues: [] });
    expect(commands()).toHaveLength(0);
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
    await expect(listWslDevices(options)).resolves.toEqual([{ ...device, productType: 'iPhone17,3' }]);
    expect(commands()[0]?.args).toEqual(['-m', 'pymobiledevice3', '--no-color', 'usbmux', 'list', '--usb']);
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

  it('mounts developer services before modern launch with an unprivileged userspace tunnel', async () => {
    await launchWslApp('com.example.app', device, options);
    expect(commands().map((call) => call.args.slice(3))).toEqual([
      ['mounter', 'auto-mount', '--udid', udid],
      ['developer', 'core-device', 'launch-application', '--userspace', 'com.example.app'],
    ]);
    expect(commands()[1]?.options.env).toHaveProperty('PYMOBILEDEVICE3_UDID', udid);
  });

  it('uses the selected tunneld device for iOS 17.0–17.3 and DVT for iOS 16', async () => {
    await launchWslApp('com.example.app', { ...device, productVersion: '17.3.1' }, options);
    expect(commands()[1]?.args.slice(3)).toEqual(['developer', 'core-device', 'launch-application', '--tunnel', udid, 'com.example.app']);
    await launchWslApp('com.example.app', { ...device, productVersion: '16.7' }, options);
    expect(commands()[3]?.args.slice(3)).toEqual(['developer', 'dvt', 'launch', '--udid', udid, 'com.example.app']);
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
