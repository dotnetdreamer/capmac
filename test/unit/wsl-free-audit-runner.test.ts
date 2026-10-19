/** Independent runner audit. These tests assert required behavior, including known regressions. */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { CancelledError, UserError } from '../../packages/core/src/engine/errors.js';
import { ensureFreeSigningSupport, FreeApple } from '../../packages/core/src/engine/wsl/free/free-apple.js';
import backendSource from '../../packages/core/src/engine/wsl/free/apple-free.py';

type Message = Record<string, unknown>;
const python = { executable: 'audit-python', prefix: [] };
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const outcome = (promise: Promise<unknown>) => promise.then((value) => ({ status: 'resolved', value }), (error: unknown) => ({ status: 'rejected', error }));

function fakeChild(handle: (message: Message, emit: (message: Message) => void) => void = () => {}) {
  const child = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  const emit = (message: Message) => queueMicrotask(() => stdout.emit('data', JSON.stringify(message) + '\n'));
  const kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; });
  const stdin = {
    write: vi.fn((text: string) => { for (const line of text.trim().split('\n')) handle(JSON.parse(line) as Message, emit); return true; }),
    end: vi.fn(),
  };
  Object.assign(child, { stdin, stdout, stderr, kill });
  return { process: child as unknown as ChildProcessWithoutNullStreams, stdout, stderr, stdin, kill };
}

describe('independent free Apple runner audit', () => {
  it('launches the helper from a file path, keeping the oversized source off the command line', async () => {
    // The bundled helper is far larger than a Windows command line can carry, so the runner must
    // not pass it through `python -c`; it writes a file and runs that. This proves the fix works
    // on any platform (an actual -c launch of this source throws ENAMETOOLONG on Windows).
    expect(backendSource.length).toBeGreaterThan(30_000);
    let argv: string[] = [];
    const child = fakeChild();
    const spawn = vi.fn((_executable: string, args: string[]) => { argv = args; return child.process; }) as unknown as typeof nodeSpawn;
    const runner = new FreeApple({ stateDir: path.join(os.tmpdir(), 'capmac-free-launch-audit'), python, spawn });
    const pending = outcome(runner.login('nobody@example.invalid', 'fake-password', async () => ''));
    await delay(20);
    runner.close();
    await pending;
    expect(argv).not.toContain('-c');
    expect(argv.some((argument) => argument.endsWith('.py'))).toBe(true);
    expect(argv.join('\u0000')).not.toContain(backendSource.slice(0, 500));
  });

  it('handles real pipes, fragmented Unicode JSON, two-factor authentication, and provisioning', async () => {
    const helper = String.raw`
      const readline = require('node:readline');
      let loginId;
      const emit = (object) => {
        const bytes = Buffer.from(JSON.stringify(object) + '\n');
        for (let offset = 0; offset < bytes.length; offset += 3) process.stdout.write(bytes.subarray(offset, offset + 3));
      };
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.op === 'shutdown') return process.exit(0);
        if (message.op === 'login') { loginId = message.id; emit({ event: 'need-code', mode: 'trusted' }); }
        if (message.op === 'code') emit({ id: loginId, ok: true, result: { teams: [{ id: 'ABCDE12345', name: 'Élodie 📱', free: true }], expiry: 42 } });
        if (message.op === 'provision') emit({ id: message.id, ok: true, result: { certificate: { serial: 'AB', notAfter: '2030-01-01' }, p12: 'YQ==', password: 'test', profiles: { 'com.audit.app': 'Yg==' }, notes: [] } });
      });
    `;
    let child: ReturnType<typeof nodeSpawn> | undefined;
    const spawn = vi.fn(() => (child = nodeSpawn(process.execPath, ['-e', helper], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))) as unknown as typeof nodeSpawn;
    const runner = new FreeApple({ stateDir: 'audit-state', python, spawn });
    try {
      const prompt = vi.fn(async () => '000000');
      const login = await runner.login('nobody@example.invalid', 'fake-password', prompt);
      expect(login.teams[0]?.name).toBe('Élodie 📱');
      expect(prompt).toHaveBeenCalledWith('trusted', false);
      const provisioned = await runner.provision('ABCDE12345', [{ bundleIdentifier: 'com.audit.app', capabilities: [] }], undefined, 'audit-state');
      expect(provisioned.profiles).toEqual({ 'com.audit.app': 'Yg==' });
    } finally { runner.close(); child?.kill(); }
  });

  it('rejects pending requests with the real subprocess exit and stderr', async () => {
    let child: ReturnType<typeof nodeSpawn> | undefined;
    const spawn = vi.fn(() => (child = nodeSpawn(process.execPath, ['-e', "process.stdin.once('data', () => { process.stderr.write('audit-exit-detail\\n'); process.exit(7); });"], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))) as unknown as typeof nodeSpawn;
    const runner = new FreeApple({ stateDir: 'audit-state', python, spawn });
    try {
      const result = await outcome(runner.login('nobody@example.invalid', 'fake-password', async () => ''));
      expect(result.status).toBe('rejected');
      if ('error' in result) {
        expect(result.error).toBeInstanceOf(UserError);
        expect((result.error as UserError).hint).toContain('7');
        expect((result.error as UserError).details).toContain('audit-exit-detail');
      }
    } finally { runner.close(); child?.kill(); }
  });

  it('rejects pre-aborted dependency preparation before spawning anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn(() => {
      const child = fakeChild();
      queueMicrotask(() => child.process.emit('close', 0));
      return child.process;
    }) as unknown as typeof nodeSpawn;
    const result = await outcome(ensureFreeSigningSupport(python, { spawn, signal: controller.signal }));
    expect(result.status).toBe('rejected');
    if ('error' in result) expect(result.error).toBeInstanceOf(CancelledError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not start pip installation after dependency preparation is cancelled', async () => {
    const controller = new AbortController();
    const spawnMock = vi.fn(() => {
      const child = fakeChild();
      if (spawnMock.mock.calls.length === 1) queueMicrotask(() => controller.abort());
      else queueMicrotask(() => child.process.emit('close', 0));
      return child.process;
    });
    const result = await outcome(ensureFreeSigningSupport(python, { spawn: spawnMock as unknown as typeof nodeSpawn, signal: controller.signal }));
    expect(result.status).toBe('rejected');
    if ('error' in result) expect(result.error).toBeInstanceOf(CancelledError);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects or restarts promptly when a new request follows a dead helper', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child.process) as unknown as typeof nodeSpawn;
    const runner = new FreeApple({ stateDir: 'audit-state', python, spawn });
    try {
      const first = outcome(runner.login('nobody@example.invalid', 'fake-password', async () => ''));
      await delay(0);
      child.process.emit('close', 1);
      expect((await first).status).toBe('rejected');
      const second = outcome(runner.login('nobody@example.invalid', 'fake-password', async () => ''));
      const state = await Promise.race([second, delay(50).then(() => ({ status: 'still-pending' }))]);
      expect(state.status).not.toBe('still-pending');
    } finally { runner.close(); }
  });

  it('does not let a previous helper close reject a request on its replacement', async () => {
    const firstChild = fakeChild();
    const secondChild = fakeChild();
    const spawn = vi.fn().mockReturnValueOnce(firstChild.process).mockReturnValueOnce(secondChild.process) as unknown as typeof nodeSpawn;
    const runner = new FreeApple({ stateDir: 'audit-state', python, spawn });
    try {
      const first = outcome(runner.login('nobody@example.invalid', 'fake-password', async () => ''));
      await delay(0);
      runner.close();
      expect((await first).status).toBe('rejected');
      const second = outcome(runner.login('nobody@example.invalid', 'fake-password', async () => ''));
      await delay(0);
      firstChild.process.emit('close', 0);
      secondChild.stdout.emit('data', JSON.stringify({ id: 2, ok: true, result: { teams: [], expiry: 42 } }) + '\n');
      expect((await second).status).toBe('resolved');
    } finally { runner.close(); }
  });

  it('cancels an outstanding login when closed', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child.process) as unknown as typeof nodeSpawn;
    const runner = new FreeApple({ stateDir: 'audit-state', python, spawn });
    const pending = outcome(runner.login('nobody@example.invalid', 'fake-password', async () => ''));
    await delay(0);
    runner.close();
    const result = await pending;
    expect(result.status).toBe('rejected');
    if ('error' in result) expect(result.error).toBeInstanceOf(CancelledError);
  });

  it('does not crash its host process on a valid JSON line that is not an object', async () => {
    // Isolate malformed framing in a real Node host so an unhandled runner
    // rejection cannot terminate the audit process itself. Never run the backend.
    const result = await build({
      stdin: { contents: `
        import { EventEmitter } from 'node:events';
        import { FreeApple } from './packages/core/src/engine/wsl/free/free-apple.ts';
        const child = new EventEmitter();
        const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
        Object.assign(child, { stdout: stream(), stderr: stream(), kill() {}, stdin: {
          write(line) {
            const message = JSON.parse(line);
            if (message.op === 'login') queueMicrotask(() => {
              child.stdout.emit('data', 'null\\n');
              child.stdout.emit('data', JSON.stringify({ id: message.id, ok: true, result: { teams: [], expiry: 42 } }) + '\\n');
            });
            return true;
          }, end() {},
        } });
        const runner = new FreeApple({ stateDir: 'audit', python: { executable: 'never-run', prefix: [] }, spawn: () => child });
        runner.login('nobody@example.invalid', 'fake-password', async () => '').finally(() => runner.close());
      `, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.py': 'text' }, logLevel: 'silent',
    });
    const child = nodeSpawn(process.execPath, ['-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin.end(result.outputFiles[0]!.text);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      expect(exit, stderr).toBe(0);
    } finally { child.kill(); }
  });
});
