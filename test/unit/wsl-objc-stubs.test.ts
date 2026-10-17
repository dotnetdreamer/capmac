import { describe, expect, it, vi } from 'vitest';
import { UserError } from '../../packages/core/src/engine/errors.js';
import { linkWithObjCStubs, OBJC_STUBS } from '../../packages/core/src/engine/wsl/objc-stubs.js';
import { WslExecutor, type WslCommandResult } from '../../packages/core/src/engine/wsl/toolchain.js';

const done = (stdout = ''): WslCommandResult => ({ code: 0, stdout, stderr: '' });
const link = ['swiftc', '-target', 'arm64-apple-ios15.0', 'App.o'];
const options = { clang: '/tools/clang', target: 'arm64-apple-ios15.0', work: '/build/Objects' };

describe('Objective-C stubs for Apple-compiled code', () => {
  it('writes the stubs the linker made, links again with them, and checks every stub', async () => {
    const run = vi.fn(async (argv: string[]) => (argv[0] === 'python3' ? done(argv[3] === 'prepare' ? '2\n' : '2\n') : done()));
    await linkWithObjCStubs(run, link, '/app/App', options);
    expect(run.mock.calls.map(([argv]) => (argv[0] === 'python3' ? `python3 ${argv[3]}` : argv.join(' ')))).toEqual([
      'swiftc -target arm64-apple-ios15.0 App.o -o /app/App',
      'python3 prepare',
      '/tools/clang -c -target arm64-apple-ios15.0 /build/Objects/objc-stubs.s -o /build/Objects/objc-stubs.o',
      'swiftc -target arm64-apple-ios15.0 App.o /build/Objects/objc-stubs.o -o /app/App',
      'python3 check',
    ]);
  });

  it('links once when the linker made no stubs, and refuses an app whose stubs call the wrong methods', async () => {
    const run = vi.fn(async (argv: string[]) => done(argv[0] === 'python3' ? '0\n' : ''));
    await linkWithObjCStubs(run, link, '/app/App', options);
    expect(run).toHaveBeenCalledTimes(3);
    const wrong = vi.fn(async (argv: string[]) => (argv[3] === 'check' ? { code: 1, stdout: '{"checked":2,"wrong":1,"examples":[["defaultCenter","mAsync"]]}', stderr: '' } : done(argv[0] === 'python3' ? '0' : '')));
    await expect(linkWithObjCStubs(wrong, link, '/app/App', options)).rejects.toMatchObject({ details: ['{"checked":2,"wrong":1,"examples":[["defaultCenter","mAsync"]]}'] });
    await expect(linkWithObjCStubs(wrong, link, '/app/App', options)).rejects.toBeInstanceOf(UserError);
  });
});

describe.skipIf(!process.env.CAPMAC_SDK_TEST_WSL)('Objective-C stubs with the real linker', () => {
  it('replaces the linker’s stubs with right ones, and its check catches a stub that loads another method', async () => {
    const executor = new WslExecutor(process.env.CAPMAC_SDK_TEST_WSL!);
    const sh = async (script: string) => (await executor.run(['bash', '-c', script], { timeoutMs: 120_000 })).stdout.trim();
    const work = await sh('mktemp -d');
    const sdk = await sh('ls -d /root/.local/share/capmac/apple-sdk/*/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk | head -1');
    const clang = await sh('ls /root/.local/share/capmac/toolchains/*/usr/bin/clang | head -1');
    const write = (file: string, text: string) => executor.run(['python3', '-c', 'import sys; open(sys.argv[1], "w").write(sys.stdin.read())', `${work}/${file}`], { stdin: text });
    try {
      // As Apple's compiler emits: calls through stubs whose method names no input carries.
      await write('main.s', '.section __TEXT,__text,regular,pure_instructions\n.globl _main\n.p2align 2\n_main:\n bl "_objc_msgSend$defaultCenter"\n bl "_objc_msgSend$addObserver:selector:name:object:"\n ret\n');
      await executor.run([clang, '-c', '-target', 'arm64-apple-ios15.0', `${work}/main.s`, '-o', `${work}/main.o`]);
      const run = (argv: string[], extra?: object) => executor.run(argv, { timeoutMs: 120_000, ...extra });
      const linker = ['ld64.lld-18', '-arch', 'arm64', '-platform_version', 'ios', '15.0', '26.0', '-syslibroot', sdk, '-lSystem', '-lobjc', `${work}/main.o`];
      await linkWithObjCStubs(run, linker, `${work}/App`, { clang, target: 'arm64-apple-ios15.0', work });
      expect(await sh(`llvm-objdump-18 --section-headers ${work}/App | grep -c __objc_stubs || true`)).toBe('0');
      expect((await executor.run(['python3', '-c', OBJC_STUBS, 'check', `${work}/App`])).stdout.trim()).toBe('2');
      // A stub that loads another method's name is refused.
      await write('bad.s', '.section __TEXT,__objc_methname,cstring_literals\nLname: .asciz "removeObserver:"\n.section __DATA,__objc_selrefs,literal_pointers,no_dead_strip\n.p2align 3\nLref: .quad Lname\n.section __TEXT,__text,regular,pure_instructions\n.globl _main\n.p2align 2\n_main:\n bl "_objc_msgSend$addObserver:"\n ret\n.globl "_objc_msgSend$addObserver:"\n.p2align 2\n"_objc_msgSend$addObserver:":\n adrp x1, Lref@PAGE\n ldr x1, [x1, Lref@PAGEOFF]\n b _objc_msgSend\n');
      await executor.run([clang, '-c', '-target', 'arm64-apple-ios15.0', `${work}/bad.s`, '-o', `${work}/bad.o`]);
      await executor.run(['ld64.lld-18', '-arch', 'arm64', '-platform_version', 'ios', '15.0', '26.0', '-syslibroot', sdk, '-lSystem', '-lobjc', `${work}/bad.o`, '-o', `${work}/Bad`]);
      const refused = await executor.run(['python3', '-c', OBJC_STUBS, 'check', `${work}/Bad`], { allowFailure: true });
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({ checked: 1, wrong: 1, examples: [['addObserver:', 'removeObserver:']] });
    } finally {
      await executor.run(['rm', '-rf', '--', work], { allowFailure: true });
    }
  }, 180_000);
});
