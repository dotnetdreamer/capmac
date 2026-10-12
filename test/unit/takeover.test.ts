import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capTarget, isThisPc, liveReload } from '../../packages/cli/src/commands/cap.js';
import { isTakeoverCommand, parseCapArgs } from '../../packages/cli/src/takeover/cap-args.js';
import { isCapacitorCli, takeoverArgs } from '../../packages/cli/src/takeover/intercept.js';
import {
  addPreload,
  disableTakeover,
  enableTakeover,
  ensureTakeoverDefault,
  refreshTakeover,
  hasPreload,
  removePreload,
  requireOption,
  samePath,
  takeoverStatus,
  userEnvironment,
} from '../../packages/core/src/engine/takeover.js';

const CAP_BIN = 'C:\\work\\app\\node_modules\\@capacitor\\cli\\bin\\capacitor';

describe('parseCapArgs', () => {
  it('reads command, platform and options the way Capacitor does', () => {
    const inv = parseCapArgs(['run', 'ios', '--target', 'ABC-123', '--no-sync', '-l', '--port=5173', '--https']);
    expect(inv.command).toBe('run');
    expect(inv.platform).toBe('ios');
    expect(inv.options).toEqual({ target: 'ABC-123', sync: false, 'live-reload': true, port: '5173', https: true });
  });

  it('does not take an option value for the platform', () => {
    expect(parseCapArgs(['run', '--target', 'X', 'ios']).platform).toBe('ios');
    expect(parseCapArgs(['build', '--xcode-export-method', 'debugging', 'ios']).platform).toBe('ios');
  });

  it('takes over run, open and build for iOS only', () => {
    const takes = (args: string[]) => isTakeoverCommand(parseCapArgs(args));
    expect(takes(['run', 'ios'])).toBe(true);
    expect(takes(['open', 'ios'])).toBe(true);
    expect(takes(['build', 'ios'])).toBe(true);
    expect(takes(['run', 'ios', '--list', '--json'])).toBe(true);
    expect(takes(['sync', 'ios'])).toBe(false);
    expect(takes(['copy', 'ios'])).toBe(false);
    expect(takes(['run', 'android'])).toBe(false);
    expect(takes(['run'])).toBe(false);
    expect(takes(['run', 'ios', '--help'])).toBe(false);
    expect(takes(['config', '--json'])).toBe(false);
  });
});

describe('takeoverArgs', () => {
  it('recognises the Capacitor CLI from npm, pnpm and yarn', () => {
    expect(isCapacitorCli(CAP_BIN)).toBe(true);
    expect(isCapacitorCli('/home/me/app/node_modules/.pnpm/@capacitor+cli@8.5.3/node_modules/@capacitor/cli/bin/capacitor')).toBe(true);
    expect(isCapacitorCli('C:\\app\\node_modules\\@ionic\\cli\\bin\\ionic')).toBe(false);
    expect(isCapacitorCli('C:\\app\\node_modules\\vite\\bin\\vite.js')).toBe(false);
    expect(isCapacitorCli(undefined)).toBe(false);
  });

  it('hands iOS run/open/build to CapMac and leaves everything else alone', () => {
    expect(takeoverArgs(['node', CAP_BIN, 'run', 'ios', '--target', 'X'], 'win32', {})).toEqual(['cap', 'run', 'ios', '--target', 'X']);
    expect(takeoverArgs(['node', CAP_BIN, 'sync', 'ios'], 'win32', {})).toBeNull();
    expect(takeoverArgs(['node', 'C:\\app\\server.js', 'run', 'ios'], 'win32', {})).toBeNull();
    expect(takeoverArgs(['node'], 'win32', {})).toBeNull();
  });

  it('stays out of the way on a Mac and when switched off', () => {
    expect(takeoverArgs(['node', CAP_BIN, 'run', 'ios'], 'darwin', {})).toBeNull();
    expect(takeoverArgs(['node', CAP_BIN, 'run', 'ios'], 'win32', { CAPMAC_TAKEOVER: '0' })).toBeNull();
    expect(takeoverArgs(['node', CAP_BIN, 'run', 'ios'], 'linux', {})).toEqual(['cap', 'run', 'ios']);
  });
});

describe('NODE_OPTIONS', () => {
  const file = 'C:\\Users\\ik\\.capmac\\takeover.cjs';

  it('uses forward slashes, and quotes only paths with spaces', () => {
    expect(requireOption(file)).toBe('--require C:/Users/ik/.capmac/takeover.cjs');
    expect(requireOption('C:\\Users\\Jo Smith\\.capmac\\takeover.cjs')).toBe('--require "C:/Users/Jo Smith/.capmac/takeover.cjs"');
  });

  it('adds once, keeps the user\'s own options, and removes cleanly', () => {
    const on = addPreload('--max-old-space-size=8192', file);
    expect(on).toBe('--max-old-space-size=8192 --require C:/Users/ik/.capmac/takeover.cjs');
    expect(addPreload(on, file)).toBe(on);
    expect(hasPreload(on)).toBe(true);
    expect(removePreload(on)).toBe('--max-old-space-size=8192');
    expect(addPreload(undefined, file)).toBe('--require C:/Users/ik/.capmac/takeover.cjs');
    expect(removePreload(addPreload(undefined, file))).toBe('');
  });

  it('removes quoted and -r forms, and leaves other preloads', () => {
    const value = '-r ts-node/register --require "C:/Users/Jo Smith/.capmac/takeover.cjs" --enable-source-maps';
    expect(hasPreload(value)).toBe(true);
    expect(removePreload(value)).toBe('-r ts-node/register --enable-source-maps');
    expect(hasPreload('-r ts-node/register')).toBe(false);
    expect(hasPreload(undefined)).toBe(false);
  });
});

describe('cap run ios: live reload', () => {
  let dir: string;
  let server: net.Server;
  let port: number;
  const project = () => ({ capDir: dir, iosDir: 'ios' });
  const writeGenerated = (url?: string) => {
    mkdirSync(path.join(dir, 'ios', 'App', 'App'), { recursive: true });
    writeFileSync(path.join(dir, 'ios', 'App', 'App', 'capacitor.config.json'), JSON.stringify({ appId: 'a.b', server: url ? { url } : undefined }));
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-takeover-'));
    server = net.createServer((s) => s.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('cap run ios -l: CapMac starts the dev server, or uses the given host and port', async () => {
    expect(await liveReload(parseCapArgs(['run', 'ios', '-l']), project())).toEqual({});
    expect(await liveReload(parseCapArgs(['run', 'ios', '-l', '--port', '5173']), project())).toEqual({ url: 'http://localhost:5173' });
    expect(await liveReload(parseCapArgs(['run', 'ios', '--live-reload', '--host', '192.168.1.20', '--port', '8100', '--https']), project()))
      .toEqual({ url: 'https://192.168.1.20:8100' });
  });

  it('ionic cap run ios -l: uses the dev server Ionic wrote into the generated config', async () => {
    writeGenerated(`http://127.0.0.1:${port}`);
    expect(await liveReload(parseCapArgs(['run', 'ios', '--no-sync', '--target', 'X']), project())).toEqual({ url: `http://127.0.0.1:${port}/` });
  });

  it('a normal run is not live reload, even with a stale or remote server.url', async () => {
    writeGenerated(`http://127.0.0.1:${port}`);
    expect(await liveReload(parseCapArgs(['run', 'ios', '--target', 'X']), project())).toBeNull();
    writeGenerated('https://app.example.com');
    expect(await liveReload(parseCapArgs(['run', 'ios', '--no-sync']), project())).toBeNull();
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    writeGenerated(`http://localhost:${deadPort}`);
    expect(await liveReload(parseCapArgs(['run', 'ios', '--no-sync']), project())).toBeNull();
    writeGenerated();
    expect(await liveReload(parseCapArgs(['run', 'ios', '--no-sync']), project())).toBeNull();
  });

  it('knows this PC\'s own addresses', () => {
    expect(isThisPc('localhost')).toBe(true);
    expect(isThisPc('127.0.0.1')).toBe(true);
    expect(isThisPc('[::1]')).toBe(true);
    expect(isThisPc('app.example.com')).toBe(false);
  });
});

it('lists Mac targets in the shape Ionic reads from `cap run ios --list --json`', () => {
  expect(capTarget({ kind: 'simulator', udid: 'SIM-1', name: 'iPhone 17 Pro', os: 'iOS 26.5', osVersion: '26.5', state: 'Shutdown', available: true }))
    .toEqual({ name: 'iPhone 17 Pro (simulator)', api: 'iOS 26.5', id: 'SIM-1' });
  expect(capTarget({ kind: 'device', udid: 'DEV-1', name: 'IK 14 Pro Max', os: 'iOS 26.5', osVersion: '26.5', state: 'connected', available: true }))
    .toEqual({ name: 'IK 14 Pro Max', api: 'iOS 26.5', id: 'DEV-1' });
});

describe('the preload, end to end', () => {
  let dir: string;
  let preload: string;
  let capBin: string;
  let configDir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-preload-'));
    preload = path.join(dir, 'takeover.cjs');
    await build({
      entryPoints: [path.resolve('packages/cli/src/takeover/preload.ts')],
      outfile: preload,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node12',
      logLevel: 'silent',
    });
    // A stand-in Capacitor CLI and a stand-in capmac.
    capBin = path.join(dir, 'app', 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
    mkdirSync(path.dirname(capBin), { recursive: true });
    writeFileSync(capBin, 'console.log("capacitor " + process.argv.slice(2).join(" "));\n');
    const fakeCapmac = path.join(dir, 'capmac.cjs');
    writeFileSync(fakeCapmac, 'console.log("capmac " + process.argv.slice(2).join(" ") + " via=" + process.env.CAPMAC_VIA + " takeover=" + process.env.CAPMAC_TAKEOVER); process.exit(7);\n');
    configDir = path.join(dir, 'config');
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, 'takeover.json'), JSON.stringify({ cli: fakeCapmac }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const runCap = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [capBin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: requireOption(preload), CAPMAC_CONFIG_DIR: configDir, CAPMAC_TAKEOVER: '', ...env },
  });
  const onMac = process.platform === 'darwin';

  it.skipIf(onMac)('runs capmac instead of Capacitor for `cap run ios`, with its exit code', () => {
    const r = runCap(['run', 'ios', '--target', 'SIM-1']);
    expect(r.stdout.trim()).toBe('capmac cap run ios --target SIM-1 via=capacitor takeover=0');
    expect(r.status).toBe(7);
  });

  it('lets Capacitor run everything else', () => {
    const r = runCap(['sync', 'ios']);
    expect(r.stdout.trim()).toBe('capacitor sync ios');
    expect(r.status).toBe(0);
  });

  it('lets Capacitor run when takeover is off for one command, or turned off', () => {
    expect(runCap(['run', 'ios'], { CAPMAC_TAKEOVER: '0' }).stdout.trim()).toBe('capacitor run ios');
    const empty = path.join(dir, 'no-config');
    mkdirSync(empty, { recursive: true });
    expect(runCap(['run', 'ios'], { CAPMAC_CONFIG_DIR: empty }).stdout.trim()).toBe('capacitor run ios');
  });

  it.skipIf(onMac)('falls back to Capacitor, with a warning, when CapMac has gone', () => {
    const gone = path.join(dir, 'gone');
    mkdirSync(gone, { recursive: true });
    writeFileSync(path.join(gone, 'takeover.json'), JSON.stringify({ cli: path.join(dir, 'missing.cjs') }));
    const r = runCap(['run', 'ios'], { CAPMAC_CONFIG_DIR: gone });
    expect(r.stdout.trim()).toBe('capacitor run ios');
    expect(r.stderr).toContain('CapMac is no longer at');
  });

  it('does nothing in other Node.js programs', () => {
    const r = spawnSync(process.execPath, ['-e', 'console.log("plain node")'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: requireOption(preload), CAPMAC_CONFIG_DIR: configDir },
    });
    expect(r.stdout.trim()).toBe('plain node');
    expect(r.status).toBe(0);
  });
});

describe.skipIf(process.platform !== 'win32')('on by default', () => {
  let dir: string;
  let userValue: string | undefined;
  const saved = { real: userEnvironment.real, read: userEnvironment.read, peek: userEnvironment.peek, write: userEnvironment.write };
  const savedEnv = { CAPMAC_CONFIG_DIR: process.env.CAPMAC_CONFIG_DIR, CI: process.env.CI, CAPMAC_VIA: process.env.CAPMAC_VIA };
  const install = (name: string) => {
    const folder = path.join(dir, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'cli.js'), '');
    writeFileSync(path.join(folder, 'takeover.cjs'), `// ${name}`);
    return { cli: path.join(folder, 'cli.js'), preload: path.join(folder, 'takeover.cjs'), version: '1.0.0' };
  };
  const config = () => JSON.parse(readFileSync(path.join(dir, 'config', 'config.json'), 'utf8'));
  const state = () => JSON.parse(readFileSync(path.join(dir, 'config', 'takeover.json'), 'utf8'));

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-default-'));
    process.env.CAPMAC_CONFIG_DIR = path.join(dir, 'config');
    delete process.env.CI;
    delete process.env.CAPMAC_VIA;
    userValue = '--max-old-space-size=8192';
    userEnvironment.real = false; // a stand-in: these tests may write it
    userEnvironment.read = async () => userValue;
    userEnvironment.peek = async () => userValue;
    userEnvironment.write = async (value) => {
      userValue = value || undefined;
    };
  });
  afterEach(() => {
    Object.assign(userEnvironment, saved);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("turns itself on the first time, once, keeping the user's own NODE_OPTIONS", async () => {
    const cli = install('npm');
    expect(await ensureTakeoverDefault(cli)).toBe(true);
    expect(userValue).toBe(`--max-old-space-size=8192 ${requireOption(path.join(dir, 'config', 'takeover.cjs'))}`);
    expect(state().cli).toBe(cli.cli);
    expect(readFileSync(path.join(dir, 'config', 'takeover.cjs'), 'utf8')).toBe('// npm');
    expect(await ensureTakeoverDefault(cli)).toBe(false);
    expect((await takeoverStatus()).on).toBe(true);
  });

  it('stays off once turned off, until turned on again', async () => {
    const cli = install('npm');
    await ensureTakeoverDefault(cli);
    await disableTakeover();
    expect(userValue).toBe('--max-old-space-size=8192');
    expect(existsSync(path.join(dir, 'config', 'takeover.json'))).toBe(false);
    expect(config().takeover).toBe('off');
    expect(await ensureTakeoverDefault(cli)).toBe(false);
    expect((await takeoverStatus()).on).toBe(false);
    await enableTakeover(cli);
    expect(config().takeover).toBe('on');
    expect(hasPreload(userValue)).toBe(true);
  });

  it('keeps the CapMac in use, and moves to another one when it is gone', async () => {
    const studio = install('studio');
    const npm = install('npm');
    await ensureTakeoverDefault(studio);
    expect(await ensureTakeoverDefault(npm)).toBe(false);
    expect(state().cli).toBe(studio.cli);
    rmSync(studio.cli);
    expect((await takeoverStatus()).cliMissing).toBe(true);
    expect(await ensureTakeoverDefault(npm)).toBe(true);
    expect(state().cli).toBe(npm.cli);
  });

  it('keeps recognising its capmac when the install folder only changes case (capmac Studio → CapMac Studio)', async () => {
    const cli = install('capmac Studio');
    await ensureTakeoverDefault(cli);
    expect(samePath(cli.cli, cli.cli.replace('capmac Studio', 'CapMac Studio'))).toBe(true);
    // An upgrade (new version) through the renamed folder refreshes the copied preload.
    writeFileSync(cli.preload, '// upgraded');
    await refreshTakeover({ ...cli, cli: cli.cli.replace('capmac Studio', 'CapMac Studio'), version: '2.0.0' });
    expect(readFileSync(path.join(dir, 'config', 'takeover.cjs'), 'utf8')).toBe('// upgraded');
  });

  it('never points at a throwaway npx copy, and stays out of CI', async () => {
    const npx = install(path.join('npm-cache', '_npx', 'abc'));
    expect(await ensureTakeoverDefault(npx)).toBe(false);
    process.env.CI = 'true';
    expect(await ensureTakeoverDefault(install('npm'))).toBe(false);
    expect(userValue).toBe('--max-old-space-size=8192');
  });
});

describe.skipIf(process.platform !== 'win32')('never points the real NODE_OPTIONS at a folder that can vanish', () => {
  // The real environment, simulated: writes are only recorded, and `real` stays true so every guard applies.
  let dir: string;
  let writes: string[];
  const saved = { real: userEnvironment.real, read: userEnvironment.read, write: userEnvironment.write };
  const savedEnv = { CAPMAC_CONFIG_DIR: process.env.CAPMAC_CONFIG_DIR, CI: process.env.CI, CAPMAC_VIA: process.env.CAPMAC_VIA };
  const install = () => {
    writeFileSync(path.join(dir, 'cli.js'), '');
    writeFileSync(path.join(dir, 'takeover.cjs'), '');
    return { cli: path.join(dir, 'cli.js'), preload: path.join(dir, 'takeover.cjs'), version: '1.0.0' };
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-guard-'));
    process.env.CAPMAC_CONFIG_DIR = path.join(dir, 'config');
    delete process.env.CI;
    delete process.env.CAPMAC_VIA;
    writes = [];
    userEnvironment.real = true;
    userEnvironment.read = async () => undefined;
    userEnvironment.write = async (value) => {
      writes.push(value);
    };
  });
  afterEach(() => {
    Object.assign(userEnvironment, saved);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('default-on leaves the environment alone under CAPMAC_CONFIG_DIR (tests, CI, sandboxes)', async () => {
    expect(await ensureTakeoverDefault(install())).toBe(false);
    expect(writes).toEqual([]);
  });

  it('turning it on refuses a preload in the temp folder', async () => {
    await expect(enableTakeover(install())).rejects.toThrow(/temporary folder/);
    expect(writes).toEqual([]);
  });
});
