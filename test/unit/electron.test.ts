import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { electronPlan } from '../../packages/core/src/engine/electron.js';
import { capacitorElectronDir, dependsOnElectron, describeElectronApp, electronFlavor } from '../../packages/core/src/engine/electron-project.js';
import { findProjectDir, runsOnMac, type ProjectInfo } from '../../packages/core/src/engine/project.js';
import {
  CHROMIUM_LOG,
  electronKeyCode,
  electronModifiers,
  frontFile,
  HOOK_MARK,
  KEY_ALT,
  KEY_CONTROL,
  KEY_META,
  KEY_SHIFT,
  MAIN_MARK,
  macModifiers,
  matchesAccelerator,
  parseAccelerator,
  parseAppLine,
  ROLE_ACCELERATORS,
  typedText,
} from '../../packages/core/src/shared/electron.js';
import { JsDiagnosticParser } from '../../packages/core/src/shared/js-diagnostics.js';

describe('keys from the PC, as the Mac app gets them', () => {
  it('makes Ctrl the Mac’s ⌘ and the Windows key its Control', () => {
    expect(macModifiers({ shiftKey: false, ctrlKey: true, altKey: false, metaKey: false })).toBe(KEY_META);
    expect(macModifiers({ shiftKey: true, ctrlKey: false, altKey: true, metaKey: true })).toBe(KEY_SHIFT | KEY_ALT | KEY_CONTROL);
    expect(electronModifiers(KEY_SHIFT | KEY_META)).toEqual(['shift', 'meta']);
  });

  it('names keys the way sendInputEvent takes them', () => {
    expect(electronKeyCode('ArrowLeft', 'ArrowLeft')).toBe('Left');
    expect(electronKeyCode('F12', 'F12')).toBe('F12');
    expect(electronKeyCode(' ', 'Space')).toBe('Space');
    expect(electronKeyCode('+', 'Equal')).toBe('Plus');
    expect(electronKeyCode('é', 'Digit2')).toBe('é');
    // A dead key types nothing itself: the physical key stands in.
    expect(electronKeyCode('Dead', 'KeyE')).toBe('e');
    expect(electronKeyCode('Process', 'Unknown')).toBeNull();
  });

  it('types text only for character keys without ⌘ or Control', () => {
    expect(typedText('a')).toBe('a');
    expect(typedText('Enter')).toBe('\r');
    expect(typedText('c', KEY_META)).toBeNull();
    expect(typedText('Tab')).toBeNull();
  });
});

describe('menu shortcuts, the way macOS matches them', () => {
  it('reads Electron accelerators', () => {
    expect(parseAccelerator('CmdOrCtrl+Shift+Z')).toEqual({ key: 'z', meta: true, shift: true, alt: false, control: false });
    expect(parseAccelerator('CmdOrCtrl++')).toEqual({ key: '+', meta: true, shift: false, alt: false, control: false });
    expect(parseAccelerator('Option+Return')?.key).toBe('enter');
    expect(parseAccelerator('AltGr+X')).toBeNull();
    expect(parseAccelerator('Cmd+Z+X')).toBeNull();
    for (const accelerator of Object.values(ROLE_ACCELERATORS)) expect(parseAccelerator(accelerator)).not.toBeNull();
  });

  it('matches key presses by the letter the PC’s layout types', () => {
    const undo = parseAccelerator('Command+Z')!;
    expect(matchesAccelerator(undo, 'z', 'KeyZ', KEY_META)).toBe(true);
    // AZERTY: Z sits where QWERTY has W, and the key in QWERTY's Z place types W (⌘W closes the window).
    expect(matchesAccelerator(undo, 'z', 'KeyW', KEY_META)).toBe(true);
    expect(matchesAccelerator(undo, 'w', 'KeyZ', KEY_META)).toBe(false);
    expect(matchesAccelerator(parseAccelerator('Command+Q')!, 'a', 'KeyQ', KEY_META)).toBe(false);
    // A layout without Latin letters: the key's place, as on a Mac.
    expect(matchesAccelerator(undo, 'я', 'KeyZ', KEY_META)).toBe(true);
    expect(matchesAccelerator(undo, 'Z', 'KeyZ', KEY_META | KEY_SHIFT)).toBe(false);
    expect(matchesAccelerator(undo, 'z', 'KeyZ', KEY_CONTROL)).toBe(false);
  });

  it('takes ⌘= and ⌘+ (Shift on most layouts) for Command+Plus', () => {
    const zoomIn = parseAccelerator(ROLE_ACCELERATORS.zoomin!)!;
    expect(matchesAccelerator(zoomIn, '=', 'Equal', KEY_META)).toBe(true);
    expect(matchesAccelerator(zoomIn, '+', 'Equal', KEY_META | KEY_SHIFT)).toBe(true);
    expect(matchesAccelerator(zoomIn, '-', 'Minus', KEY_META)).toBe(false);
  });
});

describe('the app’s output', () => {
  it('tells CapMac’s events, the main process and everything else apart', () => {
    expect(parseAppLine(`${HOOK_MARK}{"e":"note","message":"hi"}`)).toEqual({ kind: 'hook', event: { e: 'note', message: 'hi' } });
    expect(parseAppLine(`${MAIN_MARK}Hello from main`)).toEqual({ kind: 'main', text: 'Hello from main' });
    expect(parseAppLine(`${HOOK_MARK}{not json`)).toEqual({ kind: 'other', text: `${HOOK_MARK}{not json` });
    expect(parseAppLine('vite v8 ready')).toEqual({ kind: 'other', text: 'vite v8 ready' });
  });

  it('recognises Chromium’s own log lines', () => {
    expect(CHROMIUM_LOG.test('[12345:1015/094709.123456:ERROR:gpu_init.cc(123)] GPU process exited')).toBe(true);
    expect(CHROMIUM_LOG.test('[vite] connected.')).toBe(false);
  });

  it('keeps the front-app note next to the socket', () => {
    expect(frontFile('/Users/me/.capmac/run/abc.sock')).toBe('/Users/me/.capmac/run/abc.front');
  });
});

describe('build errors from JavaScript tools', () => {
  it('reads TypeScript, esbuild and generic errors with their places', () => {
    const parser = new JsDiagnosticParser('/p/app', '/p');
    expect(parser.push("src/main.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.")).toEqual({
      severity: 'error',
      message: "Type 'string' is not assignable to type 'number'. (TS2322)",
      file: '/p/app/src/main.ts',
      line: 3,
      column: 7,
      own: true,
    });
    expect(parser.push('\x1b[31msrc/a.ts:1:2 - error TS1005: \';\' expected.\x1b[0m')?.file).toBe('/p/app/src/a.ts');
    expect(parser.push('✘ [ERROR] Could not resolve "./missing"')).toBeNull();
    expect(parser.push('')).toBeNull();
    expect(parser.push('    src/main.ts:3:19:')).toMatchObject({ severity: 'error', message: 'Could not resolve "./missing"', line: 3, column: 19 });
    expect(parser.push('/p/node_modules/x/index.js:1:1: warning: odd')).toMatchObject({ severity: 'warning', own: false });
    expect(parser.push('http://localhost:5173: error: nope')).toBeNull();
  });
});

describe('finding the Electron app', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-electron-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (rel: string, content: unknown) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  };

  it('tells the flavor from the tools the app depends on', () => {
    expect(dependsOnElectron({ devDependencies: { electron: '^44.0.0' } })).toBe(true);
    expect(dependsOnElectron({ dependencies: { react: '19' } })).toBe(false);
    expect(electronFlavor({ devDependencies: { electron: '44', 'electron-vite': '5' } }, false)).toBe('electron-vite');
    expect(electronFlavor({ devDependencies: { electron: '44', '@electron-forge/cli': '7' } }, false)).toBe('forge');
    expect(electronFlavor({ devDependencies: { electron: '44', 'electron-vite': '5' } }, true)).toBe('capacitor');
    expect(electronFlavor({ devDependencies: { electron: '44' } }, false)).toBe('plain');
  });

  it('describes the app: name, app id and icon from its packaging settings', () => {
    write('package.json', { name: 'my-app', productName: 'My App', main: 'main.js', devDependencies: { electron: '^44.0.0', '@electron-forge/cli': '7' } });
    write('forge.config.js', "module.exports = { packagerConfig: { appBundleId: 'com.example.myapp', icon: './assets/app' } };");
    write('assets/app.png', 'png');
    const app = describeElectronApp(dir, '', false);
    expect(app).toMatchObject({ flavor: 'forge', name: 'My App', appId: 'com.example.myapp', electronRange: '^44.0.0', main: 'main.js', icon: path.join(dir, 'assets', 'app.png') });
  });

  it('finds the project from inside it, and Capacitor’s Electron platform from its folder', () => {
    write('plain/package.json', { devDependencies: { electron: '44' } });
    write('plain/src/main.js', '');
    expect(findProjectDir(path.join(dir, 'plain', 'src'))).toEqual({ dir: path.join(dir, 'plain'), kind: 'electron' });

    write('cap/capacitor.config.json', { appId: 'com.example.cap', webDir: 'dist' });
    write('cap/package.json', { dependencies: { '@capacitor/core': '8' } });
    write('cap/electron/package.json', { dependencies: { '@capacitor-community/electron': '5' }, devDependencies: { electron: '44' } });
    write('cap/electron/capacitor.config.json', { appId: 'com.example.cap' });
    expect(findProjectDir(path.join(dir, 'cap', 'electron'))).toEqual({ dir: path.join(dir, 'cap'), kind: 'capacitor' });
    expect(capacitorElectronDir(path.join(dir, 'cap'), {})).toBe(path.join(dir, 'cap', 'electron'));
    expect(capacitorElectronDir(path.join(dir, 'plain'), {})).toBeNull();
  });
});

describe('how CapMac builds, launches and reloads each flavor', () => {
  const project = (flavor: string, scripts: Record<string, string>, extra: Partial<ProjectInfo> = {}) =>
    ({
      kind: flavor === 'capacitor' ? 'capacitor' : 'electron',
      webDir: 'dist',
      hasIos: false,
      config: {},
      electron: { flavor, dir: '/p', rel: flavor === 'capacitor' ? 'electron' : '', name: 'App', appId: null, electronRange: null, scripts, main: null, icon: null },
      ...extra,
    }) as unknown as ProjectInfo;

  it('plain Electron: its own build script (never a packaging one), CapMac reloads', () => {
    expect(electronPlan(project('plain', { build: 'tsc' }))).toMatchObject({ build: 'npm run build', launch: { electron: ['.'] }, dev: null });
    expect(electronPlan(project('plain', { build: 'electron-builder --mac' })).build).toBeNull();
    expect(electronPlan(project('plain', { dev: 'electronmon .' })).dev).toEqual({ command: 'npm run dev' });
  });

  it('electron-vite: its dev command, with --watch to restart main', () => {
    expect(electronPlan(project('electron-vite', { dev: 'electron-vite dev' }))).toMatchObject({ build: 'npx electron-vite build', dev: { command: 'npx electron-vite dev --watch' } });
    expect(electronPlan(project('electron-vite', { dev: 'electron-vite dev --mode staging' })).dev).toEqual({ command: 'npm run dev' });
  });

  it('Electron Forge: start, restarted with "rs"', () => {
    expect(electronPlan(project('forge', { start: 'electron-forge start' }))).toMatchObject({ build: null, launch: { command: 'npm run start' }, dev: { command: 'npm run start', restartInput: 'rs\n' } });
  });

  it('Capacitor Electron: the platform’s build, the web app from the dev server', () => {
    expect(electronPlan(project('capacitor', { build: 'tsc' }))).toMatchObject({ flavor: 'capacitor', appRel: 'electron', build: 'npm run build', dev: null, webDir: 'dist' });
  });

  it('capmac.json wins', () => {
    const plan = electronPlan(project('plain', { build: 'tsc' }, { config: { electron: { build: '', start: 'npm run go', dev: 'npm run watch' } } } as Partial<ProjectInfo>));
    expect(plan).toMatchObject({ build: null, launch: { command: 'npm run go' }, dev: { command: 'npm run watch' } });
  });

  it('runs an Electron app on the Mac’s desktop, a Capacitor app there when asked', () => {
    const electronApp = project('plain', {});
    const capacitorApp = project('capacitor', {}, { hasIos: true });
    expect(runsOnMac(electronApp)).toBe(true);
    expect(runsOnMac(capacitorApp)).toBe(false);
    expect(runsOnMac(capacitorApp, { electron: true })).toBe(true);
    expect(runsOnMac(capacitorApp, { target: 'macOS' })).toBe(true);
    expect(runsOnMac(capacitorApp, { target: 'iPhone 17' })).toBe(false);
    expect(runsOnMac({ ...capacitorApp, hasIos: false })).toBe(true);
  });
});
