import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateIosProject, locateXcodeProject } from '../../packages/core/src/agent/ios-project.js';
import { loadProject } from '../../packages/core/src/engine/project.js';
import { xcodeOpenParams } from '../../packages/core/src/engine/tools.js';

const examples = path.join(__dirname, '../../examples');

const dirs: string[] = [];
let configDir = '';
const savedConfigDir = process.env.CAPMAC_CONFIG_DIR;

beforeEach(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), 'capmac-xcode-config-'));
  process.env.CAPMAC_CONFIG_DIR = configDir;
});
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CAPMAC_CONFIG_DIR;
  else process.env.CAPMAC_CONFIG_DIR = savedConfigDir;
  rmSync(configDir, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project's copy on the Mac, with these folders. */
const onMac = (...folders: string[]) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-xcode-'));
  dirs.push(dir);
  for (const folder of folders) mkdirSync(path.join(dir, ...folder.split('/')), { recursive: true });
  return dir;
};

describe('Open in Xcode', () => {
  it('asks the Mac for each kind of app’s own Xcode project', async () => {
    expect(xcodeOpenParams(await loadProject(path.join(examples, 'hello-flutter')))).toMatchObject({ iosDir: 'ios', xcodeName: 'Runner' });
    expect(xcodeOpenParams(await loadProject(path.join(examples, 'hello-react-native')))).toMatchObject({ iosDir: 'ios', xcodeName: 'HelloReactNative' });
    // Capacitor's ios/App: the agent finds it as it always has.
    const capacitor = xcodeOpenParams(await loadProject(path.join(examples, 'hello-capacitor')));
    expect(capacitor.iosDir).toBe('ios');
    expect(capacitor.xcodeName).toBeUndefined();
  });

  it('opens a Flutter app’s Runner workspace', async () => {
    const project = onMac('ios/Runner.xcodeproj', 'ios/Runner.xcworkspace', 'ios/RunnerTests', 'ios/Flutter');
    expect(await locateXcodeProject(project, 'ios', 'Runner')).toBe(path.join(project, 'ios', 'Runner.xcworkspace'));
  });

  it('opens a React Native app’s workspace once CocoaPods made it, else its project', async () => {
    const project = onMac('ios/HelloReactNative.xcodeproj', 'ios/HelloReactNative');
    expect(await locateXcodeProject(project, 'ios', 'HelloReactNative')).toBe(path.join(project, 'ios', 'HelloReactNative.xcodeproj'));
    mkdirSync(path.join(project, 'ios', 'Pods', 'Pods.xcodeproj'), { recursive: true });
    mkdirSync(path.join(project, 'ios', 'HelloReactNative.xcworkspace'));
    expect(await locateXcodeProject(project, 'ios', 'HelloReactNative')).toBe(path.join(project, 'ios', 'HelloReactNative.xcworkspace'));
  });

  it('says to run the app once when the Mac has no Xcode project for it yet', async () => {
    const project = onMac('ios');
    await expect(locateXcodeProject(project, 'ios', 'Runner')).rejects.toMatchObject({ code: 'NO_IOS_PLATFORM', message: 'No Xcode project in ios on the Mac.' });
    // Where the agent looked before: a Flutter app has no ios/App.
    await expect(locateIosProject(onMac('ios/Runner.xcworkspace'), 'ios')).rejects.toMatchObject({ code: 'NO_IOS_PLATFORM' });
  });
});
