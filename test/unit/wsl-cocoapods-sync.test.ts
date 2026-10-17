/** Opt in with CAPMAC_TEST_CAPACITOR_SYNC=1 after installing the example's npm dependencies. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { silentContext } from '../../packages/core/src/engine/context.js';
import type { ProjectInfo } from '../../packages/core/src/engine/project.js';
import { syncMirroredCapacitor } from '../../packages/core/src/engine/wsl/cocoapods.js';

const example = fileURLToPath(new URL('../../examples/hello-capacitor/', import.meta.url));
const dependencies = path.join(example, 'node_modules');
const cli = path.join(dependencies, '@capacitor', 'cli');
const installed = existsSync(path.join(cli, 'assets', 'ios-pods-template.tar.gz')) && ['core', 'ios', 'device'].every((name) => existsSync(path.join(dependencies, '@capacitor', name, 'package.json')));
const enabled = process.env.CAPMAC_TEST_CAPACITOR_SYNC === '1' && installed;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!enabled)('real installed Capacitor CocoaPods sync (opt-in; no Xcode or pod install)', () => {
  it('generates Device and Cordova registration, native podspecs and web assets while preserving custom app code', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'capmac-native-sync-proof-'));
    const links: string[] = [];
    const originalHost = path.join(example, 'ios', 'App', 'App', 'AppDelegate.swift');
    const originalHostHash = digest(await readFile(originalHost));
    const originalPlugin = path.join(dependencies, '@capacitor', 'device', 'Package.swift');
    const originalPluginHash = digest(await readFile(originalPlugin));
    const put = async (relative: string, text: string) => {
      const filename = path.join(directory, relative);
      await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, text);
    };
    try {
      await put('package.json', JSON.stringify({ name: 'capmac-native-sync-proof', version: '1.0.0', private: true,
        dependencies: { '@capacitor/core': '8.5.3', '@capacitor/ios': '8.5.3', '@capacitor/device': '8.0.3', 'cordova-plugin-capmac-proof': '1.0.0' }, devDependencies: { '@capacitor/cli': '8.5.3' } }));
      await put('capacitor.config.json', JSON.stringify({ appId: 'dev.capmac.proof', appName: 'Native Proof', webDir: 'www' }));
      const html = '<!doctype html><html><body>Real Capacitor sync proof</body></html>';
      await put('www/index.html', html);
      await mkdir(path.join(directory, 'node_modules', '@capacitor'), { recursive: true });
      // Junction only installed, read-only dependencies. The Cordova fixture
      // belongs to this disposable tree, never to the user's node_modules.
      for (const name of ['cli', 'core', 'ios', 'device']) {
        const link = path.join(directory, 'node_modules', '@capacitor', name);
        await symlink(path.join(dependencies, '@capacitor', name), link, process.platform === 'win32' ? 'junction' : 'dir'); links.push(link);
      }
      await put('node_modules/cordova-plugin-capmac-proof/package.json', JSON.stringify({ name: 'cordova-plugin-capmac-proof', version: '1.0.0', cordova: { id: 'cordova-plugin-capmac-proof', platforms: ['ios'] } }));
      await put('node_modules/cordova-plugin-capmac-proof/plugin.xml', '<?xml version="1.0" encoding="UTF-8"?><plugin xmlns="http://apache.org/cordova/ns/plugins/1.0" id="cordova-plugin-capmac-proof" version="1.0.0"><name>CapMacProof</name><js-module src="www/proof.js" name="CapMacProof"><clobbers target="capmacProof"/></js-module><platform name="ios"><config-file target="config.xml" parent="/*"><feature name="CapMacProof"><param name="ios-package" value="CDVCapMacProof"/></feature></config-file><header-file src="src/ios/CDVCapMacProof.h"/><source-file src="src/ios/CDVCapMacProof.m" compiler-flags="-fno-objc-arc"/></platform></plugin>');
      await put('node_modules/cordova-plugin-capmac-proof/www/proof.js', 'module.exports={test:function(){return true}};');
      await put('node_modules/cordova-plugin-capmac-proof/src/ios/CDVCapMacProof.h', '#import <Cordova/CDVPlugin.h>\n@interface CDVCapMacProof: CDVPlugin\n@end\n');
      await put('node_modules/cordova-plugin-capmac-proof/src/ios/CDVCapMacProof.m', '#import "CDVCapMacProof.h"\n@implementation CDVCapMacProof\n@end\n');
      const require = createRequire(path.join(cli, 'package.json'));
      const template = require(path.join(cli, 'dist', 'util', 'template.js')) as { extractTemplate(source: string, destination: string): Promise<void> };
      await template.extractTemplate(path.join(cli, 'assets', 'ios-pods-template.tar.gz'), path.join(directory, 'ios'));
      const host = path.join(directory, 'ios', 'App', 'App', 'AppDelegate.swift');
      await writeFile(host, (await readFile(host, 'utf8')) + '\n// CAPMAC_CUSTOM_NATIVE_CODE_PRESERVED\n');
      const customHostHash = digest(await readFile(host));
      const project: ProjectInfo = { kind: 'capacitor', capDir: directory, syncRoot: directory, projectRel: '', iosDir: 'ios', webDir: 'www', scheme: 'App', appId: 'dev.capmac.proof', appName: 'Native Proof', config: {}, configFile: path.join(directory, 'capacitor.config.json'), iosPackageManager: 'CocoaPods', packageManager: 'npm', hasIos: true, projectId: 'sync-integration-proof', scripts: {}, electron: null };
      const output: string[] = [];
      const context = silentContext(); context.emit = (event) => { if (event.type === 'tool-output') output.push(event.text); };
      await syncMirroredCapacitor(project, directory, context, new AbortController().signal);
      const config = JSON.parse(await readFile(path.join(directory, 'ios', 'App', 'App', 'capacitor.config.json'), 'utf8')) as { packageClassList: string[] };
      expect(config.packageClassList).toEqual(expect.arrayContaining(['DevicePlugin', 'CDVPlugin']));
      expect(await readFile(path.join(directory, 'ios', 'App', 'App', 'public', 'index.html'), 'utf8')).toBe(html);
      expect(await readFile(path.join(directory, 'ios', 'App', 'Podfile'), 'utf8')).toContain("pod 'CapacitorDevice'");
      const cordova = await readdir(path.join(directory, 'ios', 'capacitor-cordova-ios-plugins'), { recursive: true });
      expect(cordova.some((name) => name.endsWith('CDVCapMacProof.m') && name.includes('noarc'))).toBe(true);
      expect(cordova.some((name) => name.endsWith('CDVCapMacProof.h'))).toBe(true);
      expect(cordova).toEqual(expect.arrayContaining(['CordovaPlugins.podspec', 'CordovaPluginsResources.podspec', 'CordovaPluginsStatic.podspec']));
      expect(await readFile(path.join(directory, 'ios', 'App', 'App', 'public', 'cordova_plugins.js'), 'utf8')).toContain('cordova-plugin-capmac-proof');
      expect(digest(await readFile(host))).toBe(customHostHash);
      expect(digest(await readFile(originalHost))).toBe(originalHostHash);
      expect(digest(await readFile(originalPlugin))).toBe(originalPluginHash);
      expect(output.join('')).toContain('Sync finished');
    } finally {
      // Unlink source dependency junctions before deleting the checked fixture.
      for (const link of links) await unlink(link);
      const resolved = path.resolve(directory); const temporaryRoot = path.resolve(os.tmpdir());
      if (!resolved.startsWith(temporaryRoot + path.sep) || !path.basename(resolved).startsWith('capmac-native-sync-proof-')) throw new Error('Refusing to remove an unverified integration fixture path.');
      await rm(resolved, { recursive: true, force: true });
    }
  }, 60_000);
});
