/**
 * The free Apple backend runner, with the Python process faked. It checks the
 * JSON-line protocol: sign-in with a two-factor code, provisioning, and turning
 * Apple's error codes into a next step — without spawning Python or touching Apple.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { FreeApple } from '../../packages/core/src/engine/wsl/free/free-apple.js';
import { freeCodeMessage } from '../../packages/core/src/engine/wsl/free/free-signing.js';
import { UserError } from '../../packages/core/src/engine/errors.js';

type Message = Record<string, unknown>;

/** A stand-in child process whose stdin writes are handed to `handle`, which may emit stdout lines. */
function fakeProcess(handle: (message: Message, emit: (object: Message) => void) => void) {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdout = stream();
  child.stderr = stream();
  child.kill = () => {};
  const emit = (object: Message) => queueMicrotask(() => (child.stdout as EventEmitter).emit('data', JSON.stringify(object) + '\n'));
  child.stdin = {
    write: (line: string) => { for (const part of line.split('\n')) if (part.trim()) handle(JSON.parse(part) as Message, emit); return true; },
    end: () => {},
  };
  return { child, spawn: vi.fn(() => child) as unknown as typeof import('node:child_process').spawn };
}

const python = { executable: 'python', prefix: ['-I'] };

describe('the free Apple backend runner', () => {
  it('signs in, asks for the two-factor code, and returns the teams', async () => {
    let loginId: unknown;
    const { spawn } = fakeProcess((message, emit) => {
      if (message.op === 'login') { loginId = message.id; emit({ event: 'need-code', mode: 'trusted' }); }
      else if (message.op === 'code') {
        expect(message.code).toBe('123456');
        emit({ id: loginId, ok: true, result: { teams: [{ id: 'ABCDE12345', name: 'My Account', free: true }], expiry: 42 } });
      }
    });
    const runner = new FreeApple({ stateDir: 'state', python, spawn });
    let askedMode: string | undefined;
    const result = await runner.login('me@example.test', 'secret', async (mode) => { askedMode = mode; return '123456'; });
    expect(askedMode).toBe('trusted');
    expect(result).toEqual({ teams: [{ id: 'ABCDE12345', name: 'My Account', free: true }], expiry: 42 });
    runner.close();
  });

  it('asks again after a wrong code, and says how to make a code on the iPhone', async () => {
    let loginId: unknown;
    const { spawn } = fakeProcess((message, emit) => {
      if (message.op === 'login') { loginId = message.id; emit({ event: 'need-code', mode: 'trusted', again: false }); }
      else if (message.op === 'code' && message.code === '111111') emit({ event: 'need-code', mode: 'trusted', again: true });
      else if (message.op === 'code') emit({ id: loginId, ok: true, result: { teams: [], expiry: 1 } });
    });
    const runner = new FreeApple({ stateDir: 'state', python, spawn });
    const asked: [string, boolean][] = [];
    await runner.login('me@example.test', 'secret', async (mode, again) => { asked.push([mode, again]); return asked.length === 1 ? '111111' : '222222'; });
    expect(asked).toEqual([['trusted', false], ['trusted', true]]);
    // Apple shows the code only where the account is signed in, and won't push another code to a
    // non-Apple sign-in, so the prompt says both, and how to make a code.
    expect(freeCodeMessage('trusted')).toContain('must be signed in on that iPhone');
    expect(freeCodeMessage('trusted')).toContain('Get Verification Code');
    expect(freeCodeMessage('trusted', true)).toMatch(/^That code didn’t work\. /);
    expect(freeCodeMessage('sms')).toContain('texted');
    runner.close();
  });

  it('tells a refused right password apart from a wrong code', async () => {
    const hintFor = async (error: Record<string, unknown>) => {
      const { spawn } = fakeProcess((message, emit) => { if (message.op === 'login') emit({ id: message.id, ok: false, ...error }); });
      const runner = new FreeApple({ stateDir: 'state', python, spawn });
      const failure = await runner.login('me@example.test', 'secret', async () => '000000').catch((e: unknown) => e);
      runner.close();
      return (failure as UserError).hint;
    };
    expect(await hintFor({ error: 'Your Apple ID or password was entered incorrectly.', code: -22406 })).toContain('wait 15 minutes');
    expect(await hintFor({ error: 'That verification code was not accepted.', code: -21669 })).toBe('Check the code and sign in again.');
    expect(await hintFor({ error: 'Apple’s sign-in service answered HTTP 503.', code: 503 })).toContain('busy');
    // Apple wouldn't text a code (apple-free.py's NOT_ON_IPHONE): how to put the account on the
    // iPhone, not "check the code", though the message mentions the verification code.
    const notOnIphone = await hintFor({ error: 'This Apple Account must be signed in on your iPhone. Apple shows the verification code there, and won’t text it to CapMac.', code: -90001 });
    expect(notOnIphone).toContain('Sign in to it on your iPhone');
    expect(notOnIphone).toContain('Mail Accounts');
  });

  it('provisions and maps the certificate, profiles and notes', async () => {
    const { spawn } = fakeProcess((message, emit) => {
      if (message.op === 'provision') {
        expect(message.teamId).toBe('ABCDE12345');
        expect(message.targets).toEqual([{ bundleIdentifier: 'com.example.app', capabilities: ['APP_GROUPS'] }]);
        emit({ id: message.id, ok: true, result: {
          certificate: { serial: 'AABB', notAfter: '2030-01-01T00:00:00Z' },
          p12: 'cDEy', password: 'pw', profiles: { 'com.example.app': 'cHJvZmlsZQ==' }, notes: ['a note'],
        } });
      }
    });
    const runner = new FreeApple({ stateDir: 'state', python, spawn });
    const result = await runner.provision('ABCDE12345', [{ bundleIdentifier: 'com.example.app', capabilities: ['APP_GROUPS'] }], undefined, 'dir');
    expect(result.certificate).toEqual({ serial: 'AABB', notAfter: '2030-01-01T00:00:00Z' });
    expect(result.profiles).toEqual({ 'com.example.app': 'cHJvZmlsZQ==' });
    expect(result.notes).toEqual(['a note']);
    runner.close();
  });

  it('asks the helper for Apple’s Xcode download grant and keeps only that cookie', async () => {
    const asked: unknown[] = [];
    const { spawn } = fakeProcess((message, emit) => {
      if (message.op !== 'download-grant') return;
      asked.push(message.path);
      emit({ id: message.id, ok: true, result: message.path === '/none.xip'
        ? { cookies: ['dslang=US-EN'] }
        : { cookies: ['ADCDownloadAuth=grant', 'dslang=US-EN', 'ADCDownloadAuth=bad value; Path=/'], location: null } });
    });
    const runner = new FreeApple({ stateDir: 'state', python, spawn });
    expect(await runner.downloadGrant('/Developer_Tools/Xcode_26.6/Xcode_26.6_Apple_silicon.xip')).toEqual(['ADCDownloadAuth=grant']);
    await expect(runner.downloadGrant('/none.xip')).rejects.toBeInstanceOf(UserError);
    expect(asked).toEqual(['/Developer_Tools/Xcode_26.6/Xcode_26.6_Apple_silicon.xip', '/none.xip']);
    runner.close();
  });

  it('turns Apple’s sign-in block (-80045) into a clear next step', async () => {
    const { spawn } = fakeProcess((message, emit) => {
      if (message.op === 'login') emit({ id: message.id, ok: false, error: 'This action cannot be completed at this time. (-80045)', code: -80045 });
    });
    const runner = new FreeApple({ stateDir: 'state', python, spawn });
    const error = await runner.login('me@example.test', 'secret', async () => '000000').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toContain('-80045');
    expect((error as UserError).hint).toContain('Update CapMac');
    runner.close();
  });
});
