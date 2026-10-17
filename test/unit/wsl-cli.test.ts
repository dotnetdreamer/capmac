import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateWslOptions } from '../../packages/core/src/engine/wsl/settings.js';

/** Exercise Commander and the real WSL terminal commands, without a Mac or iPhone. */
describe('WSL CLI routing', () => {
  let dir: string;
  let cli: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-wsl-cli-'));
    cli = path.join(dir, 'cli.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url))],
      outfile: cli,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      external: ['node-datachannel', 'cpu-features', '*.node'],
      plugins: [{
        name: 'isolated-backends',
        setup(builder) {
          builder.onResolve({ filter: /^@capmac\/core\/engine\/wsl\/index$/ }, () => ({ path: 'wsl', namespace: 'test' }));
          builder.onResolve({ filter: /^@capmac\/core\/engine\/wsl\/device$/ }, () => ({ path: 'device', namespace: 'test' }));
          builder.onResolve({ filter: /^@capmac\/core\/engine\/wsl\/apple-devices$/ }, () => ({ path: 'apple-devices', namespace: 'test' }));
          builder.onResolve({ filter: /^\.\/commands\/takeover\.js$/ }, () => ({ path: 'takeover', namespace: 'test' }));
          builder.onResolve({ filter: /^\.\/commands\/build\.js$/ }, () => ({ path: 'mac-build', namespace: 'test' }));
          builder.onLoad({ filter: /.*/, namespace: 'test' }, (args) => {
            if (args.path === 'device') return { contents: `
              exports.listWslDevices = async () => [{udid:'000081-phone',name:'My iPhone',productVersion:'18.0'}];
            ` };
            // CI runners have no Apple Devices app.
            if (args.path === 'apple-devices') return { contents: `
              exports.requireAppleDeviceServer = async () => {};
            ` };
            if (args.path === 'takeover') return { contents: `
              exports.takeoverByDefault = async () => { throw new Error('MAC_TAKEOVER_FORBIDDEN'); };
              exports.takeoverCommand = async () => {};
            ` };
            if (args.path === 'mac-build') return { contents: `
              exports.buildCommand = async () => { throw new Error('MAC_BUILD_FORBIDDEN'); };
            ` };
            return { contents: `
              function record(action, options) { console.log('BACKEND:' + JSON.stringify({action, options})); }
              exports.doctorWsl = async (options) => ({ready: false, checks: [{id:'toolchain',level:'fail',label:'iOS compiler',fix:'Provide the toolchain'}]});
              exports.setupWsl = async (options) => record('setup', options);
              exports.buildWsl = async (options) => { record('build', options); return {appPath:'build/App.app',ipaPath:'build/App.ipa',bundleId:'dev.test.app'}; };
              exports.runWsl = async (options) => record('run', options);
              exports.devWsl = async (options) => record('dev', options);
            ` };
          });
        },
      }],
    });
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]) => runIn(dir, ...args);
  const runIn = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CAPMAC_CONFIG_DIR: path.join(dir, 'config'), CAPMAC_NO_TTY: '1', NODE_OPTIONS: '' },
  });
  const backend = (output: string) => JSON.parse(output.split(/\r?\n/).find((line) => line.startsWith('BACKEND:'))!.slice(8));

  it('runs the dedicated build without enabling Mac takeover or reaching the Mac builder', () => {
    const result = run('wsl', 'build', '--sdk', '/sdk/iPhoneOS.sdk', '--swift-resources', '/sdk/swift', '--no-web-build', '--out', 'device build');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(backend(result.stdout)).toMatchObject({ action: 'build', options: { sdk: '/sdk/iPhoneOS.sdk', swiftResources: '/sdk/swift', webBuild: false, out: 'device build', cwd: dir } });
    expect(result.stdout).toContain('build/App.ipa');
  });

  it.each(['build', 'run', 'dev'])('routes the existing %s command to WSL before any Mac work', (command) => {
    const result = run(command, '--backend', 'wsl', '--distro', 'Ubuntu', '--certificate', 'C:\\Signing\\dev.p12', '--profile', 'C:\\Signing\\dev.mobileprovision');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(backend(result.stdout)).toMatchObject({ action: command, options: { distro: 'Ubuntu', certificate: 'C:\\Signing\\dev.p12', profile: 'C:\\Signing\\dev.mobileprovision' } });
  });

  it.each([['wsl', 'doctor', '--json'], ['doctor', '--backend', 'wsl', '--json']])('returns a clean JSON readiness failure for %j', (...args) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: false, checks: [{ id: 'toolchain', level: 'fail' }] });
  });

  it('forwards a device-reachable live URL and the selected phone', () => {
    const result = run('wsl', 'dev', '--url', 'http://192.168.1.20:5173', '--target', '000081-device', '--live-host', '192.168.1.20', '--no-watch', '--no-logs');
    expect(result.status).toBe(0);
    expect(backend(result.stdout)).toMatchObject({ action: 'dev', options: { url: 'http://192.168.1.20:5173', target: '000081-device', liveHost: '192.168.1.20', watch: false, logs: false } });
  });

  it('forwards native CocoaPods configurations and resource setup', () => {
    const result = run('wsl', 'build', '--configuration', 'Staging', '--scheme', 'Original App', '--ruby', '/opt/ruby/bin/ruby', '--pod', '/opt/ruby/bin/pod');
    expect(result.status).toBe(0);
    expect(backend(result.stdout)).toMatchObject({ action: 'build', options: { configuration: 'Staging', scheme: 'Original App', ruby: '/opt/ruby/bin/ruby', pod: '/opt/ruby/bin/pod' } });
    const setup = run('wsl', 'setup', '--install-resources');
    expect(setup.status).toBe(0);
    expect(backend(setup.stdout)).toMatchObject({ action: 'setup', options: { installResources: true } });
  });

  it.skipIf(process.platform !== 'win32')('uses the backend picked with `capmac backend` (and in CapMac Studio) when --backend is left out', () => {
    const app = path.join(dir, 'picked-app');
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'dev.test.picked', appName: 'Picked App', webDir: 'www' }));
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'picked-app' }));
    expect(JSON.parse(runIn(app, 'backend', '--json').stdout)).toEqual({ backend: 'mac' });
    const picked = runIn(app, 'backend', 'wsl');
    expect(picked.status).toBe(0);
    expect(picked.stdout).toContain('Picked App builds on this PC');
    expect(JSON.parse(runIn(app, 'backend', '--json').stdout)).toEqual({ backend: 'wsl' });
    // No --backend: this PC, and the Mac's command takeover is never turned on.
    const result = runIn(app, 'run', '--no-logs');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(backend(result.stdout)).toMatchObject({ action: 'run', options: { logs: false } });
    // --backend mac still goes to the Mac (here its takeover step, which this test forbids).
    expect(runIn(app, 'build', '--backend', 'mac').stderr).toContain('MAC_TAKEOVER_FORBIDDEN');
    // The Electron app runs on the Mac's desktop, whatever builds the iOS app.
    expect(runIn(app, 'run', '--app', 'electron').stderr).toContain('MAC_TAKEOVER_FORBIDDEN');
    expect(runIn(app, 'backend', 'linux').stderr).toContain('Unknown backend');
  });

  it('lists host-connected devices without requiring the build environment or Mac takeover', () => {
    const result = run('wsl', 'targets', '--json');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual([{ udid: '000081-phone', name: 'My iPhone', productVersion: '18.0' }]);
  });
});

describe('WSL option compatibility', () => {
  it.each([
    { simulator: true },
    { team: 'TEAM123' },
    { apiKey: 'AuthKey_123.p8' },
    { route: 'internet' },
    { showSimulator: true },
    { sound: 'pc' },
    { bridge: true },
    { fix: true },
  ])('rejects incompatible Mac operations instead of ignoring %j', (options) => {
    expect(() => validateWslOptions(options)).toThrow('The WSL backend does not support');
  });

  it('accepts physical-device release settings and local signing', () => {
    expect(() => validateWslOptions({ device: true, configuration: 'Release', certificate: 'dev.p12', profile: 'dev.mobileprovision', allWarnings: true })).not.toThrow();
  });
});
