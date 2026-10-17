import { describe, expect, it } from 'vitest';
import { appChannels, DEFAULT_SETTINGS, engineMethods, inputEventSchema, settingsPatchSchema, settingsSchema } from '../src/shared/contract';

// Main validates every request from the renderer against these schemas.
describe('IPC validation', () => {
  it('opens only https links', () => {
    const openExternal = appChannels['app:open-external'];
    expect(openExternal.safeParse({ url: 'https://github.com/cameroncooke/AXe' }).success).toBe(true);
    for (const url of ['http://example.com', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'not a url']) {
      expect(openExternal.safeParse({ url }).success, url).toBe(false);
    }
  });

  it('rejects unknown fields', () => {
    expect(appChannels['app:visibility'].safeParse({ visible: true }).success).toBe(true);
    expect(appChannels['app:visibility'].safeParse({ visible: true, extra: 1 }).success).toBe(false);
    expect(engineMethods['sessions.start'].safeParse({ projectPath: 'C:\\apps\\hello', mode: 'run', sneaky: true }).success).toBe(false);
  });

  it('accepts only known session modes and device ids', () => {
    const start = engineMethods['sessions.start'];
    expect(start.safeParse({ projectPath: 'C:\\apps\\hello', mode: 'live', target: 'A1B2C3D4-0000-0000-0000-000000000000' }).success).toBe(true);
    expect(start.safeParse({ projectPath: 'C:\\apps\\hello', mode: 'shell' }).success).toBe(false);
    expect(start.safeParse({ projectPath: 'C:\\apps\\hello', mode: 'run', target: 'booted; rm -rf ~' }).success).toBe(false);
  });

  it('accepts only the apps CapMac runs', () => {
    const setApp = engineMethods['projects.setApp'];
    expect(setApp.safeParse({ path: 'C:\\apps\\ludo', app: 'electron' }).success).toBe(true);
    expect(setApp.safeParse({ path: 'C:\\apps\\ludo', app: 'ios' }).success).toBe(true);
    expect(setApp.safeParse({ path: 'C:\\apps\\ludo', app: 'android' }).success).toBe(false);
    expect(setApp.safeParse({ path: '', app: 'ios' }).success).toBe(false);
    expect(engineMethods['projects.detect'].safeParse({ path: 'C:\\apps' }).success).toBe(true);
    const start = engineMethods['sessions.start'];
    expect(start.safeParse({ projectPath: 'C:\\apps\\ludo', mode: 'run', app: 'electron' }).success).toBe(true);
    // A Flutter app's Mac and Windows apps, and its build modes.
    expect(start.safeParse({ projectPath: 'C:\\apps\\ludo', mode: 'run', app: 'macos' }).success).toBe(true);
    expect(start.safeParse({ projectPath: 'C:\\apps\\ludo', mode: 'live', app: 'windows', options: { flutterMode: 'profile' } }).success).toBe(true);
    expect(start.safeParse({ projectPath: 'C:\\apps\\ludo', mode: 'run', app: 'android' }).success).toBe(false);
    expect(start.safeParse({ projectPath: 'C:\\apps\\ludo', mode: 'run', options: { flutterMode: 'jit' } }).success).toBe(false);
    expect(engineMethods['projects.createSample'].safeParse({ kind: 'flutter' }).success).toBe(true);
    // A React Native app's release build, its sample, and React Native DevTools.
    expect(start.safeParse({ projectPath: 'C:\\apps\\hello', mode: 'run', app: 'windows', options: { configuration: 'Release' } }).success).toBe(true);
    expect(engineMethods['projects.createSample'].safeParse({ kind: 'react-native' }).success).toBe(true);
    expect(engineMethods['projects.createSample'].safeParse({ kind: 'react' }).success).toBe(false);
    expect(engineMethods['sessions.devtools'].safeParse({ sessionId: 's1' }).success).toBe(true);
    expect(engineMethods['sessions.devtools'].safeParse({ sessionId: 's1', url: 'https://example.com' }).success).toBe(false);
  });

  it('keeps simulator input in range', () => {
    expect(inputEventSchema.safeParse({ kind: 'tap', x: 0.5, y: 0.25 }).success).toBe(true);
    expect(inputEventSchema.safeParse({ kind: 'tap', x: 1.5, y: 0.25 }).success).toBe(false);
    expect(inputEventSchema.safeParse({ kind: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 5 }).success).toBe(false);
    expect(inputEventSchema.safeParse({ kind: 'key', key: 'return' }).success).toBe(true);
    expect(inputEventSchema.safeParse({ kind: 'key', key: 'F13' }).success).toBe(false);
    expect(inputEventSchema.safeParse({ kind: 'text', text: '' }).success).toBe(false);
  });

  it('validates settings, defaults included', () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ theme: 'dark' }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ theme: 'purple' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ consoleLimit: 50 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ password: 'hunter2' }).success).toBe(false);
  });
});
