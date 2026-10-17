import { describe, expect, it } from 'vitest';
import type { Target, WslStatus } from '../../../desktop/src/shared/contract.js';
import { automaticTarget, keyOf, parseAddress, pcReady, sourceOf, WebBuildDiagnostics } from '../../src/state/pure.js';

const sim = (name: string, state = 'Shutdown', available = true): Target => ({ kind: 'simulator', udid: `${name}-0000`, name, os: 'iOS 26.5', osVersion: '26.5', state, available });

describe('pure helpers', () => {
  it('reads Mac addresses people type', () => {
    expect(parseAddress('ik@my-mac.local')).toEqual({ host: 'my-mac.local', port: 22, user: 'ik' });
    expect(parseAddress('192.168.2.48:2222')).toEqual({ host: '192.168.2.48', port: 2222, user: undefined });
    expect(parseAddress('  mac-mini ')).toEqual({ host: 'mac-mini', port: 22, user: undefined });
    expect(parseAddress('ik@host:70000')).toBeNull();
    expect(parseAddress('')).toBeNull();
    expect(parseAddress('two words')).toBeNull();
  });

  it('picks the simulator CapMac would: a running iPhone, else "iPhone N", else any iPhone', () => {
    expect(automaticTarget({ simulators: [sim('iPad Air'), sim('iPhone 17 Pro', 'Booted')], devices: [], deviceSupport: true })?.name).toBe('iPhone 17 Pro');
    expect(automaticTarget({ simulators: [sim('iPhone Air'), sim('iPhone 17')], devices: [], deviceSupport: true })?.name).toBe('iPhone 17');
    expect(automaticTarget({ simulators: [sim('iPad mini'), sim('iPhone SE (3rd generation)')], devices: [], deviceSupport: true })?.name).toBe('iPhone SE (3rd generation)');
    expect(automaticTarget({ simulators: [sim('iPhone 17', 'Shutdown', false)], devices: [], deviceSupport: true })).toBeNull();
    expect(automaticTarget(null)).toBeNull();
  });

  it('says this PC is ready when tools, SDK and (in an app) signing are there', () => {
    const status = (patch: Partial<WslStatus>) => ({ status: null, tools: true, sdk: true, signing: true, inApp: true, partialDownload: null, setupId: null, server: 'running', ...patch }) as WslStatus;
    expect(pcReady(status({}))).toBe(true);
    expect(pcReady(status({ signing: false }))).toBe(false);
    expect(pcReady(status({ signing: false, inApp: false }))).toBe(true);
    expect(pcReady(status({ sdk: false }))).toBe(false);
    expect(pcReady(null)).toBe(false);
  });

  it('compares project paths without case or trailing slashes', () => {
    expect(keyOf('C:\\Apps\\Hello\\')).toBe(keyOf('c:\\apps\\hello'));
  });

  it('links console lines to files on this PC, not to URLs', () => {
    expect(sourceOf({ source: 'C:\\app\\src\\main.ts:12' })).toEqual({ path: 'C:\\app\\src\\main.ts', line: 12 });
    expect(sourceOf({ source: 'C:\\app\\src\\main.ts:12:7' })).toEqual({ path: 'C:\\app\\src\\main.ts', line: 12 });
    expect(sourceOf({ source: 'http://localhost:5173/src/main.ts:12' })).toBeNull();
    expect(sourceOf({ source: 'capacitor://localhost/main.js:3' })).toBeNull();
    expect(sourceOf({})).toBeNull();
  });

  it("reads the web build's TypeScript, esbuild and Vite errors with this PC's paths", () => {
    const build = new WebBuildDiagnostics('C:\\Users\\ik\\My App\\');
    expect(build.push("src\\main.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.")).toEqual([
      { severity: 'error', message: "Type 'string' is not assignable to type 'number'. (TS2322)", file: 'C:\\Users\\ik\\My App\\src\\main.ts', line: 12, column: 5, own: true },
    ]);
    expect(build.push('c:\\users\\ik\\my app\\src\\a.ts:3:7 - warning TS6133: x is declared but never used.')[0]).toMatchObject({ file: 'C:\\users\\ik\\my app\\src\\a.ts', line: 3, column: 7, severity: 'warning', own: true });
    expect(build.push('C:/Users/ik/My App/src/b.ts:3:19: ERROR: Expected ";" but found "x"')[0]).toMatchObject({ file: 'C:\\Users\\ik\\My App\\src\\b.ts', severity: 'error', message: 'Expected ";" but found "x"' });
    expect(build.push('node_modules/lib/index.d.ts(1,1): error TS1005: oops')[0]).toMatchObject({ own: false });
    expect(build.push('D:\\shared\\types.ts(2,2): error TS1005: oops')[0]).toMatchObject({ file: 'D:\\shared\\types.ts', own: false });
    // esbuild: the location comes a couple of lines after the error.
    expect(build.push('✘ [ERROR] Could not resolve "./missing"')).toEqual([]);
    expect(build.push('')).toEqual([]);
    expect(build.push('    src/main.ts:3:19:')).toEqual([{ severity: 'error', message: 'Could not resolve "./missing"', file: 'C:\\Users\\ik\\My App\\src\\main.ts', line: 3, column: 19, own: true }]);
    expect(build.push('vite v8.3.4 building client environment for production...')).toEqual([]);
    expect(build.push('  ➜  Local:   http://localhost:5173/')).toEqual([]);
    // Rolldown (Vite 8), with an absolute path.
    expect(build.push('error during build:')).toEqual([]);
    expect(build.push('[PARSE_ERROR] Unexpected token')).toEqual([]);
    expect(build.push('    ╭─[ C:\\Users\\ik\\My App\\src\\main.js:48:11 ]')).toEqual([{ severity: 'error', message: 'Unexpected token', file: 'C:\\Users\\ik\\My App\\src\\main.js', line: 48, column: 11, own: true }]);
  });
});
