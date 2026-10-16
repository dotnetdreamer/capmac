import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { buildWithToolchain, validateWslBuildPlan, type WslBuildPlan } from '../../packages/core/src/engine/wsl/compiler.js';
import { decodeWslOutput, inferSwiftResourcePath, inspectWslToolchain, iosCompilerArguments, parseWslDistributions, WslExecutor, type WslCommandResult, type WslRunOptions } from '../../packages/core/src/engine/wsl/toolchain.js';

const temporary: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function plan(): WslBuildPlan {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capmac-wsl-test-'));
  temporary.push(root);
  return {
    projectRoot: root, outputDirectory: path.join(root, 'out'), bundleName: 'App', executableName: 'App', bundleIdentifier: 'dev.capmac.example', minimumIosVersion: '15.0',
    infoPlistPath: path.join(root, 'Info.plist'), sourceFiles: [path.join(root, 'Main.swift')],
    frameworks: [{ path: path.join(root, 'Capacitor.framework') }],
    swiftModules: [{ name: 'CapacitorDevice', sourceFiles: [path.join(root, 'DevicePlugin.swift')] }],
    resources: [{ source: path.join(root, 'web'), destination: 'public' }],
    signing: { certificatePath: path.join(root, 'developer.p12'), provisioningProfilePath: path.join(root, 'development.mobileprovision'), password: "s'ecret $value" },
  };
}

const tools = { sdkPath: '/opt/sdk/iPhoneOS.sdk', swiftcPath: '/opt/swift/bin/swiftc', signerPath: '/usr/local/bin/zsign', linkerPath: '/usr/bin/ld64.lld', swiftResourcePath: '/opt/darwin/usr/lib/swift' };

function fakeExecutor(p: WslBuildPlan, failAt?: 'compile' | 'sign' | 'legacy' | 'password') {
  const calls: { argv: string[]; options: WslRunOptions }[] = [];
  const executor = {
    distro: 'Ubuntu',
    path: vi.fn(async (input: string) => input.replace(/\\/g, '/')),
    run: vi.fn(async (args: readonly string[], options: WslRunOptions = {}): Promise<WslCommandResult> => {
      const argv = [...args];
      calls.push({ argv, options });
      if (argv[0] === 'mktemp') return { code: 0, stdout: '/tmp/capmac-sign.ABC12345\n', stderr: '' };
      if (argv[0] === 'python3' && argv.at(-1)?.endsWith('/Capacitor.framework/Capacitor')) return { code: 0, stdout: 'dynamic\n', stderr: '' };
      if (argv[0] === 'openssl' && argv[1] === 'pkcs12') {
        if (failAt === 'legacy' && !argv.includes('-legacy')) return { code: 1, stdout: '', stderr: 'digital envelope routines:inner_evp_generic_fetch:unsupported: Algorithm (RC2-40-CBC : 0)' };
        if (failAt === 'password') return { code: 1, stdout: '', stderr: 'Mac verify error: invalid password?' };
      }
      if ((failAt === 'compile' && argv[0] === tools.swiftcPath) || (failAt === 'sign' && argv[0] === tools.signerPath)) throw new Error(`intentional ${failAt} failure`);
      if (argv[0] === tools.signerPath) {
        const ipa = argv[argv.indexOf('-o') + 1]!;
        mkdirSync(path.dirname(ipa), { recursive: true });
        writeFileSync(ipa, 'transport test fixture');
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
  };
  return { executor, calls };
}

describe('WSL iOS build plan boundaries', () => {
  it.each(['../outside', '/outside', 'public/../../outside', 'Info.plist', 'Frameworks/Fake.framework', 'App', '_CodeSignature/CodeResources'])('rejects unsafe or reserved resource destination %s', (destination) => {
    const p = plan();
    p.resources = [{ source: path.join(p.projectRoot, 'web'), destination }];
    expect(() => validateWslBuildPlan(p)).toThrow();
  });

  it('rejects unsupported source plugins and unordered module dependencies before a build', () => {
    const p = plan();
    p.swiftModules![0]!.sourceFiles = [path.join(p.projectRoot, 'Plugin.m')];
    expect(() => validateWslBuildPlan(p)).toThrow(/Swift/);
    p.swiftModules![0]!.sourceFiles = [path.join(p.projectRoot, 'Plugin.swift')];
    p.swiftModules![0]!.dependencies = ['Missing'];
    expect(() => validateWslBuildPlan(p)).toThrow(/dependency/);
  });

  it('rejects duplicate Swift modules and malformed executable names', () => {
    const p = plan();
    p.swiftModules!.push({ ...p.swiftModules![0]! });
    expect(() => validateWslBuildPlan(p)).toThrow(/duplicate/);
    p.swiftModules = [];
    p.executableName = '../App';
    expect(() => validateWslBuildPlan(p)).toThrow(/executable/);
  });
});

describe('WSL compiler orchestration (no hardware build simulated)', () => {
  it('compiles plugin objects into the app, embeds dynamic frameworks, and sends signing password only over stdin', async () => {
    const p = plan();
    const { executor, calls } = fakeExecutor(p);
    const phases: string[] = [];
    const result = await buildWithToolchain(p, executor, tools, { onPhase: (phase) => phases.push(phase) });
    expect(phases).toEqual(['prepare', 'compile', 'sign']);
    const compilations = calls.filter((call) => call.argv[0] === tools.swiftcPath);
    expect(compilations).toHaveLength(2);
    expect(compilations[0]!.argv).toContain('-emit-object');
    expect(compilations[0]!.argv).toContain('CapacitorDevice');
    expect(compilations[1]!.argv.some((arg) => arg.endsWith('/modules/CapacitorDevice.o'))).toBe(true);
    expect(compilations[1]!.argv).toContain('@executable_path/Frameworks');
    expect(compilations[1]!.argv).toContain('-resource-dir');
    expect(compilations[1]!.argv).toContain('arm64-apple-ios15.0');
    expect(calls.some((call) => call.argv[0] === 'cp' && call.argv.at(-1)?.includes('/Frameworks/Capacitor.framework'))).toBe(true);
    const keyExport = calls.find((call) => call.argv[0] === 'openssl' && call.argv[1] === 'pkcs12')!;
    expect(keyExport.options.stdin).toBe(p.signing.password + '\n');
    expect(keyExport.argv).toContain('stdin');
    expect(JSON.stringify(calls.map((call) => call.argv))).not.toContain(p.signing.password);
    expect(calls.at(-1)!.argv).toEqual(['rm', '-rf', '--', '/tmp/capmac-sign.ABC12345']);
    expect(result.ipaPath).toMatch(/App\.ipa$/);
  });

  it('cleans private signing material after signer failure', async () => {
    const p = plan();
    const { executor, calls } = fakeExecutor(p, 'sign');
    await expect(buildWithToolchain(p, executor, tools)).rejects.toThrow('intentional sign failure');
    expect(calls.at(-1)!.argv).toEqual(['rm', '-rf', '--', '/tmp/capmac-sign.ABC12345']);
    expect(calls.at(-1)!.options.signal).toBeUndefined();
  });

  it('does not export signing credentials if compilation fails', async () => {
    const p = plan();
    const { executor, calls } = fakeExecutor(p, 'compile');
    await expect(buildWithToolchain(p, executor, tools)).rejects.toThrow('intentional compile failure');
    expect(calls.some((call) => call.argv.includes('pkcs12'))).toBe(false);
  });

  it('retries an RC2 provider failure with OpenSSL legacy support while keeping the password on stdin', async () => {
    const p = plan();
    const { executor, calls } = fakeExecutor(p, 'legacy');
    await buildWithToolchain(p, executor, tools);
    const exports = calls.filter((call) => call.argv[0] === 'openssl' && call.argv[1] === 'pkcs12');
    expect(exports).toHaveLength(2);
    expect(exports[0]!.argv).not.toContain('-legacy');
    expect(exports[1]!.argv).toContain('-legacy');
    expect(exports.map((call) => call.options.stdin)).toEqual([p.signing.password + '\n', p.signing.password + '\n']);
    expect(JSON.stringify(exports.map((call) => call.argv))).not.toContain(p.signing.password);
  });

  it('reports wrong certificate passwords without retrying or invoking the signer', async () => {
    const p = plan();
    const { executor, calls } = fakeExecutor(p, 'password');
    await expect(buildWithToolchain(p, executor, tools)).rejects.toThrow('Could not unlock the signing certificate');
    expect(calls.filter((call) => call.argv.includes('pkcs12'))).toHaveLength(1);
    expect(calls.some((call) => call.argv[0] === tools.signerPath)).toBe(false);
    expect(calls.at(-1)!.argv).toEqual(['rm', '-rf', '--', '/tmp/capmac-sign.ABC12345']);
  });

  it('stops before filesystem and tool operations when already cancelled', async () => {
    const p = plan();
    const { executor } = fakeExecutor(p);
    const controller = new AbortController();
    controller.abort();
    await expect(buildWithToolchain(p, executor, tools, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(executor.run).not.toHaveBeenCalled();
  });
});

describe('WSL transport', () => {
  it('handles UTF-16 distribution lists and excludes Docker helper distributions', () => {
    expect(parseWslDistributions(decodeWslOutput(Buffer.from('Ubuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\nDebian\r\n', 'utf16le')))).toEqual(['Ubuntu', 'Debian']);
  });

  it('infers Apple Swift resources only from an extracted Xcode device SDK layout', () => {
    expect(inferSwiftResourcePath('/opt/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS27.0.sdk')).toBe('/opt/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift');
    expect(inferSwiftResourcePath('/opt/iPhoneOS.sdk')).toBeUndefined();
  });

  it('keeps shell metacharacters literal and passes command input through the supervised pipe', async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    let request = '';
    child.stdin.on('data', (chunk: Buffer) => { request += chunk.toString(); });
    mocks.spawn.mockImplementation(() => {
      setImmediate(() => { child.stdout.end('ok'); child.emit('close', 0); });
      return child;
    });
    const argv = ['printf', "a'; $(touch /tmp/unwanted); `bad`"];
    await new WslExecutor('Ubuntu').run(argv, { stdin: 'private-input' });
    const call = mocks.spawn.mock.calls[0]!;
    expect(call[0]).toBe('wsl.exe');
    expect(call[2]).toMatchObject({ shell: false, windowsHide: true });
    expect(call[1].join(' ')).not.toContain(argv[1]);
    const payload = JSON.parse(request.trim());
    expect(payload.argv).toEqual(argv);
    expect(Buffer.from(payload.stdin, 'base64').toString()).toBe('private-input');
    expect(iosCompilerArguments(tools, '15.0')).toEqual(expect.arrayContaining(['-use-ld=lld', '-ld-path=/usr/bin/ld64.lld']));
  });

  it('rejects invalid distributions and pre-aborted commands without starting WSL', async () => {
    expect(() => new WslExecutor('--help')).toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(new WslExecutor('Ubuntu').run(['swiftc'], { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('fails doctor when the real UIKit compile/link probe fails despite installed tools', async () => {
    mocks.spawn.mockImplementation((_executable: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
      let input = '';
      child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString(); });
      setImmediate(() => {
        let output = ''; let error = ''; let code = 0;
        if (args.includes('--list')) output = 'Ubuntu\r\ndocker-desktop\r\n';
        else if (!input) output = 'Python 3.12.0';
        else {
          const argv: string[] = JSON.parse(input.trim()).argv;
          if (argv[0] === 'swiftc' && argv.includes('--version')) output = 'Swift version 6.3';
          else if (argv[0] === 'swiftc' && argv.includes('-print-target-info')) output = JSON.stringify({ paths: { runtimeResourcePath: '/opt/swift/lib/swift' } });
          else if (argv[0] === 'swiftc') { code = 1; error = 'error: no such module UIKit'; }
          else if (argv[0] === 'zsign') output = 'Usage: zsign --pkey';
          else if (argv[0] === 'mktemp') output = '/tmp/capmac-doctor.ABC12345\n';
          else if (argv[0] === 'ld64.lld') output = 'LLD 20';
          else if (argv[0] === 'openssl') output = 'OpenSSL 3.0';
          else if (argv[0] === 'python3' && argv[2]?.includes('fingerprint=')) output = '/home/test/.cache/capmac/swift-resources/abc123\n';
          else if (argv[0] === 'python3' && argv[2]?.includes('shutil.which')) output = '/usr/bin/ld64.lld\n';
          else if (argv[0] === 'python3' && argv[2]?.includes('libclang_rt.ios.a')) output = '/opt/apple/lib/clang/21/lib/darwin/libclang_rt.ios.a\n';
        }
        child.stdout.end(output); child.stderr.end(error); child.emit('close', code);
      });
      return child;
    });
    const report = await inspectWslToolchain({ sdkPath: '/opt/iPhoneOS.sdk', swiftResourcePath: '/opt/apple/lib/swift' });
    expect(report.checks.find((check) => check.name === 'Apple compiler runtime')).toMatchObject({ ok: true, message: '/opt/apple/lib/clang/21/lib/darwin/libclang_rt.ios.a' });
    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.name === 'Swift compiler')!.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'iOS compile and link')).toMatchObject({ ok: false, message: expect.stringContaining('no such module UIKit') });
  });
});
