import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iphoneTouchTarget, mirroringIphone } from '../../packages/core/src/engine/iphone/touch.js';
import { wifiPairedIphone } from '../../packages/core/src/engine/wsl/device.js';

const proMax = '00008120-00012840269B401E';
const iphone8 = '808ccae4399545073522715663f015d9727366c4';
const twin = '00008030-001A2B3C4D5E6F70';
const mirroring = (name: string, model: string) => ({ name, model, deviceId: 'CA:E5:70:45:CA:32' });

let dir = '';

beforeEach(async () => {
  // The iPhones this PC has seen on the cable, in a folder of the test's own.
  dir = await mkdtemp(path.join(os.tmpdir(), 'capmac-touch-'));
  vi.stubEnv('LOCALAPPDATA', dir);
  vi.stubEnv('CAPMAC_IOS_CERTIFICATE', '');
  vi.stubEnv('CAPMAC_IOS_PROFILE', '');
  await mkdir(path.join(dir, 'CapMac'), { recursive: true });
  await writeFile(path.join(dir, 'CapMac', 'iphones.json'), JSON.stringify({
    [proMax]: { name: 'IK 14 Pro Max', productVersion: '26.6.2', productType: 'iPhone15,3' },
    [iphone8]: { name: 'iPhone', productVersion: '16.7.11', productType: 'iPhone10,4' },
    [twin]: { name: 'iPhone', productVersion: '17.5', productType: 'iPhone10,4' },
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('which iPhone touch drives', () => {
  it('is the one that mirrors, by the name and model it gave the receiver', async () => {
    expect(await mirroringIphone(mirroring('IK 14 Pro Max', 'iPhone15,3'), iphone8)).toBe(proMax);
    // Same name, another model: not that one.
    expect(await mirroringIphone(mirroring('IK 14 Pro Max', 'iPhone16,2'), iphone8)).toBeUndefined();
    expect(await mirroringIphone(mirroring('Guest iPhone', 'iPhone15,3'), iphone8)).toBeUndefined();
  });

  it('is the pane’s own iPhone when two alike could be mirroring, else neither', async () => {
    expect(await mirroringIphone(mirroring('iPhone', 'iPhone10,4'), twin)).toBe(twin);
    expect(await mirroringIphone(mirroring('iPhone', 'iPhone10,4'), proMax)).toBeUndefined();
  });

  it('takes an iPhone paired for Wi-Fi as on the Wi-Fi when a quick search missed it', async () => {
    // Its Wi-Fi pairing (made over the cable once) is in the iPhone tools' folder.
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    await mkdir(path.join(dir, '.pymobiledevice3'));
    await writeFile(path.join(dir, '.pymobiledevice3', `remote_${proMax}.plist`), '');
    expect(await wifiPairedIphone(proMax.toLowerCase())).toEqual({ name: 'IK 14 Pro Max', productVersion: '26.6.2', productType: 'iPhone15,3', udid: proMax.toLowerCase(), connection: 'network' });
    // Never paired for Wi-Fi: it isn't there.
    expect(await wifiPairedIphone(iphone8)).toBeUndefined();
  });

  it('follows the picture, also when the pane knows no iPhone', async () => {
    const cwd = path.join(dir, 'app');
    await mkdir(cwd);
    // The pane shows the iPhone 8, the 14 Pro Max mirrors: touch is for the 14 Pro Max (here not set up yet).
    const target = await iphoneTouchTarget(cwd, iphone8, mirroring('IK 14 Pro Max', 'iPhone15,3'));
    expect(target.device).toMatchObject({ udid: proMax, name: 'IK 14 Pro Max', productType: 'iPhone15,3' });
    expect(target.touch).toEqual({ unavailable: 'Touch needs this app’s iPhone signing: set up This PC first', canSetUp: false });
    // No iPhone at this PC in the pane, but the one that mirrors was on the cable once.
    expect((await iphoneTouchTarget(cwd, 'wifi-mirror', mirroring('IK 14 Pro Max', 'iPhone15,3'))).device.udid).toBe(proMax);
    // Nothing this PC knows: the pane's stand-in, with nothing to set up.
    const unknown = await iphoneTouchTarget(cwd, 'wifi-mirror', mirroring('Guest iPhone', 'iPhone16,1'));
    expect(unknown.device.udid).toBe('wifi-mirror');
    expect(unknown.touch).toEqual({ unavailable: 'Touch needs an iPhone this PC knows', canSetUp: false });
  });
});
