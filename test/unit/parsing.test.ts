import { describe, expect, it } from 'vitest';
import { exportMethod, exportOptionsPlist } from '../../packages/core/src/agent/ops/archive.js';
import { jpegSize, pointsFromPixels } from '../../packages/core/src/agent/ops/screen.js';
import { parseDevices, parseSimulators } from '../../packages/core/src/agent/ops/targets.js';
import { parseDestination } from '../../packages/core/src/engine/pair.js';
import { pickDevUrl } from '../../packages/core/src/engine/devserver.js';
import { parseDiscovery, pickNode } from '../../packages/core/src/engine/remote-env.js';
import { chooseTarget } from '../../packages/core/src/engine/targets.js';
import type { TargetsResult } from '../../packages/core/src/shared/protocol.js';

const SIMS = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
      { udid: 'OLD-1', name: 'iPhone 15', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
      { udid: 'NEW-PRO', name: 'iPhone 16 Pro', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro' },
      { udid: 'NEW-16', name: 'iPhone 16', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
      { udid: 'IPAD', name: 'iPad Air 11-inch (M2)', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'x' },
      { udid: 'BROKEN', name: 'iPhone X', state: 'Shutdown', isAvailable: false, deviceTypeIdentifier: 'x' },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-2': [{ udid: 'WATCH', name: 'Apple Watch', state: 'Booted', isAvailable: true }],
  },
});
const RUNTIMES = JSON.stringify({
  runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2', version: '18.2', name: 'iOS 18.2', platform: 'iOS', isAvailable: true },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-2', version: '11.2', name: 'watchOS 11.2', platform: 'watchOS', isAvailable: true },
  ],
});

describe('simulator and device parsing', () => {
  it('keeps available iOS simulators, newest first, iPhones before iPads', () => {
    const sims = parseSimulators(SIMS, RUNTIMES);
    expect(sims.map((s) => s.udid)).toEqual(['NEW-16', 'NEW-PRO', 'IPAD', 'OLD-1']);
    expect(sims[0]).toMatchObject({ kind: 'simulator', os: 'iOS 18.2', osVersion: '18.2', model: 'iPhone 16' });
    expect(sims.find((s) => s.udid === 'OLD-1')!.os).toBe('iOS 17.5');
  });

  it('puts booted simulators first', () => {
    const data = JSON.parse(SIMS);
    data.devices['com.apple.CoreSimulator.SimRuntime.iOS-17-5'][0].state = 'Booted';
    const sims = parseSimulators(JSON.stringify(data), RUNTIMES);
    expect(sims[0]!.udid).toBe('OLD-1');
  });

  it('parses devicectl output', () => {
    const devices = parseDevices(JSON.stringify({
      result: {
        devices: [
          {
            identifier: 'CORE-1',
            hardwareProperties: { udid: '00008120-AAA', platform: 'iOS', marketingName: 'iPhone 14 Pro', reality: 'physical' },
            deviceProperties: { name: "Kabir's iPhone", osVersionNumber: '18.1', developerModeStatus: 'enabled' },
            connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' },
          },
          {
            identifier: 'CORE-2',
            hardwareProperties: { udid: '00008030-BBB', platform: 'iOS', marketingName: 'iPad', reality: 'physical' },
            deviceProperties: { name: 'Old iPad', osVersionNumber: '17.0', developerModeStatus: 'disabled' },
            connectionProperties: { pairingState: 'paired', tunnelState: 'disconnected', transportType: 'localNetwork' },
          },
          { identifier: 'WATCH', hardwareProperties: { platform: 'watchOS' }, deviceProperties: {}, connectionProperties: {} },
        ],
      },
    }));
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ kind: 'device', udid: '00008120-AAA', name: "Kabir's iPhone", os: 'iOS 18.1', state: 'connected', available: true, connection: 'usb' });
    expect(devices[1]).toMatchObject({ state: 'available', available: false, connection: 'network' });
  });

  it('parses the Xcode 27 devicectl format (JSON v5) and skips simulators', () => {
    const devices = parseDevices(`noise before json\n${JSON.stringify({
      info: { jsonVersion: 5, outcome: 'success' },
      result: {
        devices: [
          {
            identifier: 'CORE-1',
            _deprecationNotice: 'hardwareProperties etc. are deprecated',
            properties: {
              connection: { pairingState: 'paired', state: 'connected', transportType: 'localNetwork' },
              hardware: { udid: '00008140-CCC', platform: 'iOS', marketingName: 'iPhone 17 Pro', reality: 'physical' },
              software: { osVersionNumber: { stringValue: '27.0' } },
              state: { name: 'Work iPhone', developerModeStatus: 'enabled' },
            },
          },
          {
            identifier: 'SIM-1',
            visibilityClass: 'simulators',
            properties: { hardware: { udid: 'SIM-1', platform: 'iOS', reality: 'simulated' }, state: { name: 'iPhone 17' } },
          },
        ],
      },
    })}`);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ udid: '00008140-CCC', name: 'Work iPhone', os: 'iOS 27.0', state: 'connected', available: true, connection: 'network' });
  });
});

describe('chooseTarget', () => {
  const all: TargetsResult = {
    simulators: parseSimulators(SIMS, RUNTIMES),
    devices: parseDevices(JSON.stringify({ result: { devices: [{ identifier: 'C', hardwareProperties: { udid: 'PHONE', platform: 'iOS' }, deviceProperties: { name: 'My iPhone', osVersionNumber: '18.1' }, connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' } }] } })),
    deviceSupport: true,
  };

  it('defaults to the newest plain iPhone simulator', () => {
    expect(chooseTarget(all, {}).udid).toBe('NEW-16');
  });
  it('remembers the last target', () => {
    expect(chooseTarget(all, { last: 'NEW-PRO' }).udid).toBe('NEW-PRO');
  });
  it('matches names, partial names, versions and UDIDs', () => {
    expect(chooseTarget(all, { wanted: 'iphone 16 pro' }).udid).toBe('NEW-PRO');
    expect(chooseTarget(all, { wanted: 'iPhone 15 (17.5)' }).udid).toBe('OLD-1');
    expect(chooseTarget(all, { wanted: 'ipad' }).udid).toBe('IPAD');
    expect(chooseTarget(all, { wanted: 'phone' }).udid).toBe('PHONE');
    expect(chooseTarget(all, { wanted: 'NEW-16' }).udid).toBe('NEW-16');
  });
  it('picks a connected device with --device', () => {
    expect(chooseTarget(all, { device: true }).udid).toBe('PHONE');
  });
  it('explains when nothing matches', () => {
    expect(() => chooseTarget(all, { wanted: 'Pixel 9' })).toThrow(/No simulator or device matches/);
    expect(() => chooseTarget({ ...all, devices: [] }, { device: true })).toThrow(/No iPhone or iPad/);
  });
});

describe('remote environment discovery', () => {
  it('parses the discovery script output and prefers the newest Node', () => {
    const rt = parseDiscovery(`Welcome to zsh\n@@CAPMAC@@\nhome=/Users/kabir\nuser=kabir\nos=Darwin\narch=arm64\nshell=/bin/zsh\nnode=/usr/local/bin/node|v16.20.0\nnode=/Users/kabir/.nvm/versions/node/v22.11.0/bin/node|v22.11.0\nnode=/opt/homebrew/bin/node|v20.18.1\nnode=/opt/homebrew/bin/node|v20.18.1\n@@END@@\n`);
    expect(rt).toMatchObject({ home: '/Users/kabir', user: 'kabir', os: 'Darwin', arch: 'arm64' });
    expect(rt.candidates).toHaveLength(3);
    expect(rt.node?.path).toBe('/Users/kabir/.nvm/versions/node/v22.11.0/bin/node');
  });
  it('rejects Node versions that are too old', () => {
    expect(pickNode([{ path: '/x', version: 'v16.0.0' }])).toBeNull();
  });
});

describe('misc parsing', () => {
  it('parses pairing destinations', () => {
    expect(parseDestination('kabir@macbook.local')).toEqual({ username: 'kabir', host: 'macbook.local', port: 22 });
    expect(parseDestination('192.168.1.20:2222')).toEqual({ username: undefined, host: '192.168.1.20', port: 2222 });
    expect(parseDestination('me@[fe80::1]:22')).toEqual({ username: 'me', host: 'fe80::1', port: 22 });
  });

  it('finds the dev server URL in tool output', () => {
    const vite = '\x1b[32m  VITE v8.3.4\x1b[39m  ready in 312 ms\n\n  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: http://192.168.1.10:5173/\n';
    expect(pickDevUrl(vite)?.href).toBe('http://localhost:5173/');
    expect(pickDevUrl('** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **')?.href).toBe('http://localhost:4200/');
    expect(pickDevUrl('Server running at http://0.0.0.0:8100')?.href).toBe('http://localhost:8100/');
    expect(pickDevUrl('compiling...')).toBeNull();
  });

  it('maps export kinds to the right Xcode method names', () => {
    expect(exportMethod('app-store', '16.2')).toBe('app-store-connect');
    expect(exportMethod('ad-hoc', '15.3')).toBe('release-testing');
    expect(exportMethod('development', '15.2')).toBe('development');
    const plist = exportOptionsPlist({ method: 'debugging', teamID: 'ABC<DE', stripSwiftSymbols: true });
    expect(plist).toContain('<key>method</key>\n\t<string>debugging</string>');
    expect(plist).toContain('<string>ABC&lt;DE</string>');
    expect(plist).toContain('<true/>');
  });

  it('reads JPEG dimensions and guesses point sizes', () => {
    // Minimal JPEG header: SOI, APP0 stub, SOF0 with 2556x1179.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x09, 0xfc, 0x04, 0x9b, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(jpegSize(jpeg)).toEqual({ width: 1179, height: 2556 });
    expect(pointsFromPixels(1179, 2556)).toEqual({ width: 393, height: 852 });
    expect(pointsFromPixels(750, 1334)).toEqual({ width: 375, height: 667 });
    expect(pointsFromPixels(1640, 2360)).toEqual({ width: 820, height: 1180 });
  });
});
