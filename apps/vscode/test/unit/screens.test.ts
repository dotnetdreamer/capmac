import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Target } from '../../../desktop/src/shared/contract.js';
import { localReceiverDir, placeReceiver, receiverForEngine, receiverInstalled } from '../../src/mirrorReceiver.js';
import { MIRROR_UDID, pcScreen, sameStream, type ScreenSource } from '../../src/state/screens.js';
import { fingerDown, fingerMoved, fingerUp } from '../../src/webview/screen/gesture.js';

const phone = (patch: Partial<Target> = {}): Target => ({ kind: 'device', udid: '00008120-00012840269B401E', name: 'IK 14 Pro Max', os: 'iOS 26.6.2', osVersion: '26.6.2', state: 'connected', available: true, ...patch });

describe('the screen of an iPhone at this PC', () => {
  it('shows the iPhone the app runs on or is picked, else the one mirroring over Wi-Fi, and none that doesn’t trust this PC', () => {
    expect(pcScreen('C:\\apps\\hello', phone())).toEqual({ backend: 'wsl', udid: '00008120-00012840269B401E', projectPath: 'C:\\apps\\hello', name: 'IK 14 Pro Max' });
    // No iPhone found: mirroring needs no cable and no pairing.
    expect(pcScreen('C:\\apps\\hello', null)).toEqual({ backend: 'wsl', udid: MIRROR_UDID, projectPath: 'C:\\apps\\hello', name: 'iPhone' });
    expect(pcScreen('C:\\apps\\hello', phone({ paired: false }))).toBeNull();
  });

  it('keeps one stream for every iPhone and app at this PC, and a stream per Mac screen', () => {
    const pc = (udid: string, projectPath = 'C:\\a'): ScreenSource => ({ backend: 'wsl', udid, projectPath, name: 'iPhone' });
    const mac = (udid: string, projectPath?: string): ScreenSource => ({ backend: 'mac', mac: 'ik-s-m1', udid, projectPath, name: 'iPhone 17' });
    expect(sameStream(pc('A0000000'), pc('B0000000', 'C:\\b'))).toBe(true);
    expect(sameStream(pc('A0000000'), mac('A0000000'))).toBe(false);
    expect(sameStream(mac('A0000000'), mac('A0000000'))).toBe(true);
    expect(sameStream(mac('A0000000'), mac('B0000000'))).toBe(false);
    expect(sameStream(mac('mac-desktop', 'C:\\a'), mac('mac-desktop', 'C:\\b'))).toBe(false);
  });
});

describe('gestures (AXe, WebDriverAgent)', () => {
  it('taps, and long-presses a finger that stays', () => {
    expect(fingerUp(fingerDown(0.5, 0.5, 0), 0.505, 0.5, 120)).toEqual({ kind: 'tap', x: 0.505, y: 0.5 });
    expect(fingerUp(fingerDown(0.5, 0.5, 0), 0.5, 0.5, 900)).toEqual({ kind: 'swipe', x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5, durationMs: 900 });
  });

  it('swipes as fast as the finger moved, with a press before it moved and a hold before it lifted', () => {
    const quick = fingerDown(0.5, 0.9, 0);
    fingerMoved(quick, 0.5, 0.7, 60);
    expect(fingerUp(quick, 0.5, 0.4, 150)).toEqual({ kind: 'swipe', x1: 0.5, y1: 0.9, x2: 0.5, y2: 0.4, durationMs: 150 });
    // Swipe up and hold (the app switcher): it rested 600 ms at the end.
    const hold = fingerDown(0.5, 0.99, 0);
    fingerMoved(hold, 0.5, 0.8, 50);
    fingerMoved(hold, 0.5, 0.6, 200);
    expect(fingerUp(hold, 0.5, 0.6, 800)).toEqual({ kind: 'swipe', x1: 0.5, y1: 0.99, x2: 0.5, y2: 0.6, durationMs: 200, holdMs: 600 });
    // A long press, then a drag (moving an icon).
    const press = fingerDown(0.3, 0.3, 0);
    fingerMoved(press, 0.3, 0.3005, 300);
    fingerMoved(press, 0.4, 0.4, 700);
    expect(fingerUp(press, 0.6, 0.6, 1000)).toEqual({ kind: 'swipe', x1: 0.3, y1: 0.3, x2: 0.6, y2: 0.6, durationMs: 300, pressMs: 700 });
  });
});

describe('the screen-mirroring receiver the .vsix ships', () => {
  const made: string[] = [];
  const dir = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'capmac-receiver-'));
    made.push(d);
    return d;
  };
  const receiver = (home: string) => {
    for (const file of ['bin/uxplay.exe', 'lib/gstreamer-1.0/libgstrtp.dll', 'licenses/uxplay/LICENSE']) {
      mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
      writeFileSync(path.join(home, file), file);
    }
    return home;
  };
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('runs from CapMac’s own folder, copied there once, so Windows Firewall asks about it once', async () => {
    const shipped = receiver(path.join(dir(), 'dist', 'mirror-receiver'));
    const env = { LOCALAPPDATA: dir() };
    // Not copied yet: the engine is told about the shipped one.
    expect(receiverForEngine(shipped, '1.74-x-1', env)).toBe(shipped);
    await placeReceiver(shipped, '1.74-x-1', env);
    const own = localReceiverDir('1.74-x-1', env);
    expect(receiverInstalled(own)).toBe(true);
    expect(path.dirname(own)).toBe(path.join(env.LOCALAPPDATA, 'CapMac', 'mirror-receiver'));
    // Copied: the engine finds it there by itself.
    expect(receiverForEngine(shipped, '1.74-x-1', env)).toBeNull();
    // Already there (a later start, another VS Code window): nothing to do.
    await placeReceiver(shipped, '1.74-x-1', env);
    expect(receiverInstalled(own)).toBe(true);
  });

  it('replaces a half-copied folder, and does nothing for a build that ships none', async () => {
    const shipped = receiver(path.join(dir(), 'dist', 'mirror-receiver'));
    const env = { LOCALAPPDATA: dir() };
    const own = localReceiverDir('1.74-x-1', env);
    mkdirSync(path.join(own, 'bin'), { recursive: true });
    await placeReceiver(shipped, '1.74-x-1', env);
    expect(receiverInstalled(own)).toBe(true);
    const none = path.join(dir(), 'dist', 'mirror-receiver');
    await placeReceiver(none, '1.74-x-2', env);
    expect(receiverInstalled(localReceiverDir('1.74-x-2', env))).toBe(false);
    expect(receiverForEngine(none, '1.74-x-2', env)).toBeNull();
  });
});
