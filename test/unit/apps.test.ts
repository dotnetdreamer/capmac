import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appsOf, chooseApp, findApps, nothingToRun, restoreAppChoices } from '../../packages/core/src/engine/apps.js';
import { recallAll } from '../../packages/core/src/engine/memory.js';
import { appFor, loadProject, projectIdFor, runsOnMac, type ProjectInfo } from '../../packages/core/src/engine/project.js';

let dir: string;
let configDir: string;
const savedConfigDir = process.env.CAPMAC_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-apps-'));
  // A repository: the search for the project around a folder stops at its root.
  mkdirSync(path.join(dir, '.git'));
  // CapMac's memory of projects (the app picked) goes to a folder of the test's own.
  configDir = mkdtempSync(path.join(os.tmpdir(), 'capmac-apps-config-'));
  process.env.CAPMAC_CONFIG_DIR = configDir;
});
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CAPMAC_CONFIG_DIR;
  else process.env.CAPMAC_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const write = (rel: string, content: unknown = '') => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const at = (...parts: string[]) => path.join(dir, ...parts);

/** A Capacitor project in `rel` with an iOS app (Swift packages) and, optionally, Capacitor's Electron platform. */
function capacitorProject(rel: string, { electron = true, ios = true } = {}) {
  const p = (file: string) => (rel ? `${rel}/${file}` : file);
  write(p('capacitor.config.ts'), "const config = { appId: 'com.example.ludo', appName: 'Ludo Wala', webDir: 'dist' };\nexport default config;");
  write(p('package.json'), { name: 'ludo-wala', dependencies: { '@capacitor/core': '^8.5.0', '@capacitor/ios': '^8.5.0', '@capacitor-community/electron': '^5.0.1' } });
  if (ios) {
    write(p('ios/App/App.xcodeproj/project.pbxproj'), 'productType = "com.apple.product-type.application"; SDKROOT = iphoneos;');
    write(p('ios/App/CapApp-SPM/Package.swift'));
    write(p('ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json'), { images: [{ filename: 'AppIcon-512@2x.png', size: '1024x1024', idiom: 'universal' }] });
    write(p('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), 'png');
  }
  if (electron) {
    write(p('electron/package.json'), { name: 'ludo-wala', main: 'build/src/index.js', dependencies: { '@capacitor-community/electron': '^5.0.1' }, devDependencies: { electron: '^43.4.0', 'electron-builder': '^26' } });
    write(p('electron/capacitor.config.ts'), "export default { appId: 'com.example.ludo' };");
    write(p('electron/electron-builder.config.js'), "const appId = process.env.X;\nmodule.exports = { appId: 'com.example.ludo', productName: 'Ludo Wala', mac: { icon: 'resources/icon-mac.png' } };");
    write(p('electron/resources/icon-mac.png'), 'png');
  }
}

describe('the apps in a folder', () => {
  it('finds both apps of a Capacitor project: the iOS app and the Electron app, each with its own icon', async () => {
    capacitorProject('');
    const search = await findApps(dir);
    expect(search.projects).toHaveLength(1);
    const [project] = search.projects;
    expect(project).toMatchObject({ dir, rel: '', name: 'Ludo Wala', framework: 'capacitor', chosen: null });
    expect(project!.apps).toEqual([
      expect.objectContaining({ id: 'ios', platform: 'ios', framework: 'capacitor', flavor: 'SPM', name: 'Ludo Wala', rel: 'ios/App', version: '^8.5.0', status: 'ready', icon: at('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png'), evidence: ['capacitor.config.ts', 'ios/App/App.xcodeproj'] }),
      // Its name and icon come from electron-builder's settings; `appId = process.env.X` is not one.
      expect.objectContaining({ id: 'electron', platform: 'mac', framework: 'electron', flavor: 'capacitor', name: 'Ludo Wala', rel: 'electron', version: '^43.4.0', status: 'ready', icon: at('electron', 'resources', 'icon-mac.png'), evidence: ['electron/package.json'] }),
    ]);
    expect(search.suggested).toEqual({ dir, app: 'ios' });
  });

  it('finds the project from one of its apps’ folders, and offers that app first', async () => {
    capacitorProject('');
    const fromElectron = await findApps(at('electron', 'src'));
    expect(fromElectron.projects.map((p) => p.dir)).toEqual([dir]);
    expect(fromElectron.projects[0]!.rel).toBe('../..');
    expect(fromElectron.suggested).toEqual({ dir, app: 'electron' });
    // ios/App holds an Xcode project, but it is Capacitor's.
    const fromIos = await findApps(at('ios', 'App'));
    expect(fromIos.projects.map((p) => [p.dir, p.framework])).toEqual([[dir, 'capacitor']]);
    expect(fromIos.suggested).toEqual({ dir, app: 'ios' });
  });

  it('lists an iOS app that is not added yet only when the project asks for one, or has nothing else', async () => {
    capacitorProject('', { ios: false });
    const withElectron = (await findApps(dir)).projects[0]!.apps;
    // package.json depends on @capacitor/ios: the iOS app is on its way.
    expect(withElectron.map((a) => [a.id, a.status])).toEqual([['ios', 'setup'], ['electron', 'ready']]);
    expect(withElectron[0]!.hint).toMatch(/npx cap add ios/);

    write('package.json', { dependencies: { '@capacitor/core': '8', '@capacitor-community/electron': '5' } });
    expect((await findApps(dir)).projects[0]!.apps.map((a) => a.id)).toEqual(['electron']);

    rmSync(at('electron'), { recursive: true });
    expect((await findApps(dir)).projects[0]!.apps.map((a) => [a.id, a.status])).toEqual([['ios', 'setup']]);
  });

  it('finds the apps inside a monorepo, and only apps', async () => {
    write('package.json', { private: true, workspaces: ['apps/*', 'packages/*'] });
    capacitorProject('apps/mobile', { electron: false });
    write('apps/desktop/package.json', { name: 'desktop', productName: 'Ludo Desktop', main: 'out/main.js', scripts: { dev: 'electron-vite dev' }, devDependencies: { electron: '44', 'electron-vite': '5' } });
    // A library that depends on Electron to test with it is not an app.
    write('packages/ipc/package.json', { name: '@ludo/ipc', main: 'index.js', scripts: { test: 'vitest' }, devDependencies: { electron: '44' } });
    // Dependencies and build output are never searched.
    write('node_modules/some-app/package.json', { scripts: { start: 'electron .' }, devDependencies: { electron: '44' } });
    write('dist/capacitor.config.json', { appId: 'x' });
    // Deeper than three folders: not searched.
    write('a/b/c/d/capacitor.config.json', { appId: 'too.deep' });

    const search = await findApps(dir);
    expect(search.projects.map((p) => [p.rel, p.framework, p.apps.map((a) => a.id)])).toEqual([
      ['apps/desktop', 'electron', ['electron']],
      ['apps/mobile', 'capacitor', ['ios']],
    ]);
    expect(search.projects[0]!.apps[0]).toMatchObject({ flavor: 'electron-vite', name: 'Ludo Desktop', rel: '' });
    expect(search.suggested).toEqual({ dir: at('apps', 'desktop'), app: 'electron' });
    expect(search.truncated).toBe(false);
  });

  it('also finds an app kept in its own folder next to a project’s', async () => {
    capacitorProject('', { electron: false });
    write('desktop/package.json', { name: 'desktop', scripts: { start: 'electron .' }, devDependencies: { electron: '44' } });
    const search = await findApps(dir);
    expect(search.projects.map((p) => [p.rel, p.apps.map((a) => a.id)])).toEqual([
      ['', ['ios']],
      ['desktop', ['electron']],
    ]);
  });

  it('finds a nested Electron app whose start script names its entry file, not only `electron .`', async () => {
    write('package.json', { private: true, workspaces: ['apps/*', 'packages/*'] });
    // `electron <entry>` launches the app as surely as `electron .` does.
    write('apps/named/package.json', { name: 'named', productName: 'Named', scripts: { start: 'electron main.js' }, devDependencies: { electron: '44' } });
    write('apps/nested/package.json', { name: 'nested', productName: 'Nested', scripts: { start: 'cross-env NODE_ENV=dev electron ./app/main.js' }, devDependencies: { electron: '44' } });
    write('apps/quoted/package.json', { name: 'quoted', productName: 'Quoted', scripts: { start: 'electron "main.js"' }, devDependencies: { electron: '44' } });
    write('apps/spaced/package.json', { name: 'spaced', productName: 'Spaced', scripts: { start: "electron --inspect 'my app/main.mjs'" }, devDependencies: { electron: '44' } });
    // A library that only depends on Electron (no launch, no builder) is still not an app.
    write('packages/lib/package.json', { name: 'lib', main: 'index.js', scripts: { test: 'electron-mocha' }, devDependencies: { electron: '44' } });

    const search = await findApps(dir);
    expect(search.projects.map((p) => [p.rel, p.apps.map((a) => a.id)]).sort()).toEqual([
      ['apps/named', ['electron']],
      ['apps/nested', ['electron']],
      ['apps/quoted', ['electron']],
      ['apps/spaced', ['electron']],
    ]);
  });

  it('recognises apps CapMac cannot run yet, so it can say what it found', async () => {
    write('flutter_app/pubspec.yaml', 'name: dash_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    write('flutter_app/ios/Runner.xcodeproj/project.pbxproj');
    write('flutter_app/macos/Runner.xcodeproj/project.pbxproj');
    write('rn/package.json', { name: 'RnApp', dependencies: { 'react-native': '0.82.0' } });
    write('rn/app.json', { name: 'RnApp', displayName: 'Rn App' });
    write('rn/ios/RnApp.xcodeproj/project.pbxproj');
    write('expo/package.json', { name: 'expo-app', dependencies: { expo: '~54.0.0' } });
    write('expo/app.json', { expo: { name: 'Expo App' } });
    write('tauri/package.json', { name: 'tauri-app', devDependencies: { '@tauri-apps/cli': '^2.11.4' } });
    write('tauri/src-tauri/tauri.conf.json', { productName: 'Screenshots' });
    write('tauri/src-tauri/gen/apple/project.yml');
    write('maui/Maui.csproj', '<Project><PropertyGroup><TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks><UseMaui>true</UseMaui><ApplicationTitle>Maui App</ApplicationTitle></PropertyGroup></Project>');
    write('cordova/config.xml', '<?xml version="1.0"?><widget id="com.example.c" xmlns="http://www.w3.org/ns/widgets"><name>Cordova App</name></widget>');
    write('cordova/package.json', { devDependencies: { 'cordova-ios': '^7.1.0' } });
    write('native/Native.xcodeproj/project.pbxproj', 'productType = "com.apple.product-type.application"; SDKROOT = auto; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx";');
    // A plugin's Xcode project builds a framework, not an app.
    write('plugin/ios/Plugin.xcodeproj/project.pbxproj', 'productType = "com.apple.product-type.framework"; SDKROOT = iphoneos;');
    write('swift/Package.swift', 'let package = Package(name: "SwiftApp")');
    write('swift/xtool.yml', 'version: 1');

    const search = await findApps(dir);
    const summary = Object.fromEntries(search.projects.map((p) => [p.rel, [p.framework, p.name, p.apps.map((a) => `${a.id}:${a.platform}:${a.status}`)]]));
    expect(summary).toEqual({
      cordova: ['cordova', 'Cordova App', ['ios:ios:unsupported']],
      expo: ['expo', 'Expo App', ['ios:ios:unsupported']],
      flutter_app: ['flutter', 'dash_app', ['ios:ios:unsupported', 'macos:mac:unsupported']],
      maui: ['maui', 'Maui App', ['ios:ios:unsupported', 'macos:mac:unsupported']],
      native: ['xcode', 'Native', ['ios:ios:unsupported', 'macos:mac:unsupported']],
      rn: ['react-native', 'Rn App', ['ios:ios:unsupported']],
      swift: ['xcode', 'SwiftApp', ['ios:ios:unsupported']],
      tauri: ['tauri', 'Screenshots', ['ios:ios:unsupported', 'macos:mac:unsupported']],
    });
    expect(search.suggested).toBeNull();
    expect(nothingToRun(search).message).toBe("CapMac found Cordova, Expo, Flutter, .NET MAUI, Xcode, React Native and Tauri apps here, but it can't run those yet.");
  });

  it('tells `capmac run` in a folder without an app of its own what is there instead', async () => {
    write('package.json', { private: true, workspaces: ['apps/*'] });
    capacitorProject('apps/mobile', { electron: false });
    await expect(loadProject(dir)).rejects.toThrow(/no app in this folder itself, but there are apps in the folders inside it/);
    rmSync(at('apps'), { recursive: true });
    write('flutter/pubspec.yaml', 'name: dash\nflutter:\n  uses-material-design: true\n');
    await expect(loadProject(at('flutter'))).rejects.toThrow("CapMac found a Flutter app here, but it can't run Flutter apps yet.");
  });

  it('says what it found when it cannot run it, or that there was nothing', async () => {
    write('pubspec.yaml', 'name: dash\nflutter:\n  uses-material-design: true\n');
    expect(nothingToRun(await findApps(dir)).message).toBe("CapMac found a Flutter app here, but it can't run Flutter apps yet.");
    rmSync(at('pubspec.yaml'));
    write('App.xcodeproj/project.pbxproj', 'productType = "com.apple.product-type.application"; SDKROOT = iphoneos;');
    expect(nothingToRun(await findApps(dir)).message).toBe("CapMac found an Xcode app here, but it can't run Xcode apps yet.");
    rmSync(at('App.xcodeproj'), { recursive: true });
    expect(nothingToRun(await findApps(dir)).message).toMatch(/^No Capacitor or Electron app found here/);
  });
});

describe('which app CapMac works on', () => {
  const project = (extra: Partial<ProjectInfo> = {}) =>
    ({ kind: 'capacitor', hasIos: true, electron: { flavor: 'capacitor', rel: 'electron' }, chosenApp: null, ...extra }) as unknown as ProjectInfo;

  it('takes the app asked for, then a place only one app runs, then the one picked, then iOS', () => {
    expect(appFor(project())).toBe('ios');
    expect(appFor(project({ chosenApp: 'electron' }))).toBe('electron');
    expect(appFor(project({ chosenApp: 'electron' }), { target: 'iPhone 17 Pro' })).toBe('ios');
    expect(appFor(project({ chosenApp: 'electron' }), { device: true })).toBe('ios');
    expect(appFor(project(), { electron: true })).toBe('electron');
    expect(appFor(project(), { target: 'mac' })).toBe('electron');
    expect(appFor(project({ chosenApp: 'electron' }), { app: 'IOS' })).toBe('ios');
    // The Electron app picked before is gone: back to the iOS app.
    expect(appFor(project({ chosenApp: 'electron', electron: null }))).toBe('ios');
    // No iOS app yet: the Electron app.
    expect(appFor(project({ hasIos: false }))).toBe('electron');
    expect(runsOnMac(project({ kind: 'electron' }), { target: 'iPhone 17' })).toBe(true);
    expect(() => appFor(project(), { app: 'android' })).toThrow(/no app called "android"/);
  });

  it('remembers the app picked, for the CLI and CapMac Studio alike', async () => {
    capacitorProject('');
    const before = await loadProject(dir);
    expect(before.chosenApp).toBeNull();
    expect(await appsOf(before)).toHaveLength(2);
    expect(runsOnMac(before)).toBe(false);

    await chooseApp(before, 'electron');
    const after = await loadProject(dir);
    expect(after.chosenApp).toBe('electron');
    expect(runsOnMac(after)).toBe(true);
    expect(runsOnMac(after, { app: 'ios' })).toBe(false);
    expect((await findApps(dir)).projects[0]!.chosen).toBe('electron');
    expect((await findApps(dir)).suggested).toEqual({ dir, app: 'electron' });

    await expect(chooseApp(after, 'flutter')).rejects.toThrow(/no app called "flutter"/);
  });

  it('remembers the app under the same id whether or not the Capacitor CLI is installed', async () => {
    capacitorProject('');
    // A local Capacitor CLI that evaluates a different appName than the config's text (a computed name):
    // the project id — the memory key app detection reads back — must not shift when the CLI is present.
    write('node_modules/@capacitor/cli/bin/capacitor', "console.log(JSON.stringify({ app: { appId: 'com.example.ludo', appName: 'CLI Evaluated Name', webDir: 'dist' }, ios: {} }));");

    await chooseApp(await loadProject(dir), 'electron');
    // findApps reads the config statically; it must still find the app that was picked.
    expect((await findApps(dir)).projects[0]!.chosen).toBe('electron');
    expect((await loadProject(dir)).chosenApp).toBe('electron');
  });

  it('keeps sibling projects that share a lockfile and a folder name from colliding into one id', async () => {
    // A monorepo whose leaf apps are named only by their folder (`mobile`) and share the root lockfile.
    write('pnpm-lock.yaml', '');
    for (const brand of ['one', 'two']) {
      write(`brands/${brand}/mobile/capacitor.config.json`, { appId: `com.ex.${brand}` });
      write(`brands/${brand}/mobile/ios/App/App.xcodeproj/project.pbxproj`, 'productType = "com.apple.product-type.application"; SDKROOT = iphoneos;');
    }
    const one = await loadProject(at('brands', 'one', 'mobile'));
    const two = await loadProject(at('brands', 'two', 'mobile'));
    expect([one.appName, two.appName]).toEqual(['mobile', 'mobile']);
    expect(one.projectId).not.toBe(two.projectId);
    // A choice for one must not surface for the other (a shared id would leak it, along with build state).
    await chooseApp(one, 'ios');
    expect((await loadProject(at('brands', 'two', 'mobile'))).chosenApp).toBeNull();
  });

  it('will not pick an app the project does not have', async () => {
    write('package.json', { name: 'hello', productName: 'Hello', scripts: { start: 'electron .' }, devDependencies: { electron: '44' } });
    const electronApp = await loadProject(dir);
    await expect(chooseApp(electronApp, 'ios')).rejects.toThrow(/Electron app: it has no iOS app/);
    rmSync(at('package.json'));
    capacitorProject('', { electron: false });
    await expect(chooseApp(await loadProject(dir), 'electron')).rejects.toThrow(/no Electron platform/);
  });
});

describe('what CapMac remembered under a project’s old id', () => {
  // Ids used to be made from the folder synced to the Mac (the lockfile's), with the name the Capacitor CLI evaluates.
  const rememberedBefore = (memory: Record<string, unknown>) => writeFileSync(path.join(configDir, 'projects.json'), JSON.stringify(memory));
  const memoryOf = async (projectId: string) => (await recallAll())[projectId];
  const computedProject = (rel: string, name: string, marker?: string) => {
    capacitorProject(rel);
    const p = (file: string) => rel ? `${rel}/${file}` : file;
    write(p('capacitor.config.ts'), `const name = ${JSON.stringify(name)}; export default { appId: 'com.example.computed', appName: name };`);
    write(p('node_modules/@capacitor/cli/bin/capacitor'), `${marker ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'evaluated');` : ''}console.log(JSON.stringify({ app: { appId: 'com.example.computed', appName: ${JSON.stringify(name)} }, ios: {} }));`);
  };

  it('carries a monorepo app’s target, sound and picked app over to its new id', async () => {
    write('package-lock.json', '{}');
    capacitorProject('apps/mobile');
    const oldId = projectIdFor('Ludo Wala', dir);
    rememberedBefore({ [oldId]: { lastTarget: 'SIM-1', sound: 'mac', app: 'electron' } });

    // Finding apps reads it as loading the project will.
    expect((await findApps(dir)).projects.map((p) => [p.rel, p.chosen])).toEqual([['apps/mobile', 'electron']]);
    const project = await loadProject(at('apps', 'mobile'));
    expect(project.projectId).not.toBe(oldId);
    expect(project.chosenApp).toBe('electron');
    expect(await memoryOf(project.projectId)).toEqual({ lastTarget: 'SIM-1', sound: 'mac', app: 'electron' });
  });

  it('leaves the picked app behind when apps with one name in one monorepo shared the old id', async () => {
    write('pnpm-lock.yaml', '');
    for (const brand of ['one', 'two']) {
      write(`brands/${brand}/mobile/capacitor.config.json`, { appId: `com.ex.${brand}` });
      write(`brands/${brand}/mobile/ios/App/App.xcodeproj/project.pbxproj`, 'productType = "com.apple.product-type.application"; SDKROOT = iphoneos;');
    }
    rememberedBefore({ [projectIdFor('mobile', dir)]: { lastTarget: 'SIM-1', app: 'ios' } });

    for (const brand of ['one', 'two']) {
      const project = await loadProject(at('brands', brand, 'mobile'));
      // Whose pick it was can't be told; the target was shared already, so each keeps it.
      expect(project.chosenApp).toBeNull();
      expect(await memoryOf(project.projectId)).toEqual({ lastTarget: 'SIM-1' });
    }
  });

  it('carries over what was remembered under the name the Capacitor CLI evaluated', async () => {
    capacitorProject('');
    write('node_modules/@capacitor/cli/bin/capacitor', "console.log(JSON.stringify({ app: { appId: 'com.example.ludo', appName: 'CLI Evaluated Name', webDir: 'dist' }, ios: {} }));");
    rememberedBefore({ [projectIdFor('CLI Evaluated Name', dir)]: { lastDevice: 'PHONE-1', sound: 'pc' } });

    const project = await loadProject(dir);
    expect(project.projectId).toBe(projectIdFor('Ludo Wala', dir));
    expect(await memoryOf(project.projectId)).toEqual({ lastDevice: 'PHONE-1', sound: 'pc' });
  });

  it('explicitly restores a computed-name choice before a chooser, while raw discovery runs no code', async () => {
    const marker = at('evaluated');
    computedProject('', 'Computed Name', marker);
    const oldId = projectIdFor('Computed Name', dir);
    const newId = projectIdFor(path.basename(dir), dir);
    const previous = { app: 'electron', lastTarget: 'SIM-1', lastDevice: 'PHONE-1', sound: 'pc' };
    rememberedBefore({ [oldId]: previous });

    const search = await findApps(dir);
    expect(search.projects[0]!.chosen).toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(await memoryOf(newId)).toBeUndefined();

    const restored = await restoreAppChoices(search);
    expect(restored.projects[0]!.chosen).toBe('electron');
    expect(restored.suggested).toEqual({ dir, app: 'electron' });
    expect(existsSync(marker)).toBe(true);
    expect(await memoryOf(newId)).toEqual(previous);
    expect(await memoryOf(oldId)).toEqual(previous);
    expect((await loadProject(dir)).chosenApp).toBe('electron');
  });

  it('does not call a legacy choice unique while a sibling name is unresolved by static discovery', async () => {
    write('package-lock.json', '{}');
    capacitorProject('apps/literal');
    const marker = at('computed-evaluated');
    computedProject('apps/computed', 'Ludo Wala', marker);
    rememberedBefore({ [projectIdFor('Ludo Wala', dir)]: { app: 'electron', sound: 'pc' } });

    const search = await findApps(dir);
    expect(search.projects.map((project) => project.chosen)).toEqual([null, null]);
    expect(existsSync(marker)).toBe(false);
    expect((await restoreAppChoices(search)).projects.map((project) => project.chosen)).toEqual([null, null]);
  });

  it('does not give two computed-name siblings the app picked under their shared evaluated legacy id', async () => {
    write('package-lock.json', '{}');
    for (const brand of ['one', 'two']) computedProject(`brands/${brand}/mobile`, 'Shared Evaluated Name');
    const oldId = projectIdFor('Shared Evaluated Name', dir);
    const previous = { app: 'electron', lastTarget: 'SIM-1', sound: 'pc' };
    rememberedBefore({ [oldId]: previous });

    const restored = await restoreAppChoices(await findApps(dir));
    expect(restored.projects.map((project) => project.chosen)).toEqual([null, null]);
    const projects = await Promise.all(['one', 'two'].map((brand) => loadProject(at('brands', brand, 'mobile'))));
    expect(projects[0]!.projectId).not.toBe(projects[1]!.projectId);
    for (const project of projects) {
      expect(project.chosenApp).toBeNull();
      expect(await memoryOf(project.projectId)).toEqual({ lastTarget: 'SIM-1', sound: 'pc' });
    }
    expect(await memoryOf(oldId)).toEqual(previous);
  });

  it('preserves independent choices, targets and sound for distinct computed legacy names', async () => {
    write('package-lock.json', '{}');
    computedProject('brands/one/mobile', 'First Evaluated Name');
    computedProject('brands/two/mobile', 'Second Evaluated Name');
    const first = { app: 'electron', lastTarget: 'SIM-1', sound: 'pc' };
    const second = { app: 'ios', lastDevice: 'PHONE-2', sound: 'mac' };
    rememberedBefore({ [projectIdFor('First Evaluated Name', dir)]: first, [projectIdFor('Second Evaluated Name', dir)]: second });

    const restored = await restoreAppChoices(await findApps(dir));
    expect(restored.projects.map((project) => project.chosen)).toEqual(['electron', 'ios']);
    expect(restored.suggested).toEqual({ dir: at('brands', 'one', 'mobile'), app: 'electron' });
    const one = await loadProject(at('brands', 'one', 'mobile'));
    const two = await loadProject(at('brands', 'two', 'mobile'));
    expect(await memoryOf(one.projectId)).toEqual(first);
    expect(await memoryOf(two.projectId)).toEqual(second);
  });

  it('runs no project’s config to restore choices when its name is written out', async () => {
    write('package-lock.json', '{}');
    capacitorProject('apps/literal');
    const marker = at('literal-evaluated');
    write('apps/literal/node_modules/@capacitor/cli/bin/capacitor', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'evaluated'); console.log(JSON.stringify({ app: { appId: 'com.example.ludo', appName: 'Ludo Wala' }, ios: {} }));`);
    // A choice saved under the old id of another app of this monorepo: findApps has looked under this one's old id already.
    rememberedBefore({ [projectIdFor('Gone App', dir)]: { app: 'electron' } });

    expect((await restoreAppChoices(await findApps(dir))).projects.map((project) => project.chosen)).toEqual([null]);
    expect(existsSync(marker)).toBe(false);
  });

  it('does not evaluate configs without a relevant legacy app choice or over existing new state', async () => {
    const marker = at('evaluated');
    computedProject('', 'Computed Name', marker);
    const newId = projectIdFor(path.basename(dir), dir);
    await restoreAppChoices(await findApps(dir));
    expect(existsSync(marker)).toBe(false);
    expect(await memoryOf(newId)).toBeUndefined();

    rememberedBefore({ [projectIdFor('Computed Name', dir)]: { app: 'electron', sound: 'pc' }, [newId]: { lastTarget: 'NEW' } });
    expect((await restoreAppChoices(await findApps(dir))).projects[0]!.chosen).toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(await memoryOf(newId)).toEqual({ lastTarget: 'NEW' });
  });

  it('does not treat a sibling with its own lockfile as an owner of this sync root’s legacy choice', async () => {
    write('package-lock.json', '{}');
    capacitorProject('apps/main');
    capacitorProject('apps/independent');
    write('apps/independent/package-lock.json', '{}');
    rememberedBefore({ [projectIdFor('Ludo Wala', dir)]: { app: 'electron' } });

    expect((await loadProject(at('apps', 'main'))).chosenApp).toBe('electron');
    expect((await loadProject(at('apps', 'independent'))).chosenApp).toBeNull();
  });

  it('does not migrate an ambiguous choice when another project is nested inside a detected project', async () => {
    write('package-lock.json', '{}');
    capacitorProject('apps/parent');
    capacitorProject('apps/parent/examples/mobile');
    const oldId = projectIdFor('Ludo Wala', dir);
    const previous = { app: 'electron', lastTarget: 'SIM-1', sound: 'pc' };
    rememberedBefore({ [oldId]: previous });

    // Normal discovery still presents the parent; migration must also account for its nested example.
    expect((await findApps(dir)).projects.map((project) => project.rel)).toEqual(['apps/parent']);
    for (const rel of ['apps/parent', 'apps/parent/examples/mobile']) {
      const project = await loadProject(at(rel));
      expect(project.chosenApp).toBeNull();
      expect(await memoryOf(project.projectId)).toEqual({ lastTarget: 'SIM-1', sound: 'pc' });
    }
    expect(await memoryOf(oldId)).toEqual(previous);
  });

  it('never overrides what the new id already has', async () => {
    write('package-lock.json', '{}');
    capacitorProject('apps/mobile');
    const newId = projectIdFor('Ludo Wala', at('apps', 'mobile'));
    rememberedBefore({ [projectIdFor('Ludo Wala', dir)]: { lastTarget: 'OLD', sound: 'mac', app: 'electron' }, [newId]: { lastTarget: 'NEW' } });

    expect((await loadProject(at('apps', 'mobile'))).chosenApp).toBeNull();
    expect(await memoryOf(newId)).toEqual({ lastTarget: 'NEW' });
  });
});
