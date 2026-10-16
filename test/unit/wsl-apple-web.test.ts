import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nonInteractivePrompter, silentContext, type Prompter } from '../../packages/core/src/engine/context.js';
import { chooseAppleSignIn, chromiumBrowser, commandProgram, forgetAppleWebSignIn, hasAppleWebSignIn } from '../../packages/core/src/engine/wsl/apple-web.js';

describe('which browser opens Apple’s website', () => {
  it('reads the program from the default browser’s registry command', () => {
    expect(commandProgram('"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --single-argument %1')).toBe('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe');
    expect(commandProgram('C:\\Chromium\\chrome.exe -- "%1"')).toBe('C:\\Chromium\\chrome.exe');
    const local = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Users\\someone\\AppData\\Local';
    try { expect(commandProgram('"%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe" %1')).toBe('C:\\Users\\someone\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe'); }
    finally { if (local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = local; }
  });

  it('drives Chromium browsers only, each with a profile of its own', () => {
    expect(chromiumBrowser('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')).toEqual({ name: 'Microsoft Edge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', key: 'msedge' });
    expect(chromiumBrowser('C:\\Brave\\BRAVE.EXE')).toMatchObject({ name: 'Brave', key: 'brave' });
    expect(chromiumBrowser('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toMatchObject({ name: 'Google Chrome', key: 'chrome' });
    // Firefox doesn't speak the DevTools protocol any more: CapMac falls back to Edge.
    expect(chromiumBrowser('C:\\Program Files\\Mozilla Firefox\\firefox.exe')).toBeUndefined();
  });
});

describe('how setup signs in to Apple', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'capmac-apple-web-choice-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const brave = { name: 'Brave', exe: 'C:\\Brave\\brave.exe', key: 'brave' };
  const picking = (value: string) => ({ ...nonInteractivePrompter, interactive: true, choose: vi.fn(async (request: { items: { value: unknown }[] }) => request.items.find((item) => item.value === value)!.value) }) as Prompter & { choose: ReturnType<typeof vi.fn> };

  it('asks first: CapMac signs in on Apple’s website and does the rest, or the developer signs in here', async () => {
    const ask = picking('web');
    expect(await chooseAppleSignIn(silentContext(ask), { root, browser: brave })).toEqual({ way: 'website', fresh: false });
    const question = ask.choose.mock.calls[0]![0] as { message: string; items: { label: string; hint?: string; value: string }[] };
    expect(question.message).toBe('Sign in to Apple');
    expect(question.items.map((item) => [item.label, item.value])).toEqual([['Let CapMac do it (recommended)', 'web'], ['Do it myself', 'password']]);
    expect(question.items[0]!.hint).toContain('Sign in once on Apple’s website in Brave');
    expect(await chooseAppleSignIn(silentContext(picking('password')), { root, browser: brave })).toEqual({ way: 'password' });
  });

  it('with a saved sign-in, offers to use it or to start fresh', async () => {
    await writeFile(path.join(root, 'sign-in.dpapi'), 'sealed');
    const ask = picking('web-fresh');
    expect(await chooseAppleSignIn(silentContext(ask), { root, browser: brave })).toEqual({ way: 'website', fresh: true });
    const question = ask.choose.mock.calls[0]![0] as { items: { label: string; hint?: string; value: string }[] };
    expect(question.items.map((item) => item.value)).toEqual(['web', 'web-fresh', 'password']);
    expect(question.items[0]!.hint).toContain('saved sign-in');
  });

  it('without a browser CapMac can drive, signs in here without asking', async () => {
    const before = process.env.CAPMAC_BROWSER;
    process.env.CAPMAC_BROWSER = path.join(root, 'missing.exe');
    try {
      const ask = picking('web');
      expect(await chooseAppleSignIn(silentContext(ask), { root })).toEqual({ way: 'password' });
      expect(ask.choose).not.toHaveBeenCalled();
    } finally { if (before === undefined) delete process.env.CAPMAC_BROWSER; else process.env.CAPMAC_BROWSER = before; }
  });
});

describe('the saved sign-in to Apple’s website', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'capmac-apple-web-store-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('is there once saved, and Restart forgets it with the browser profiles, keeping anything else', async () => {
    expect(hasAppleWebSignIn({ root })).toBe(false);
    await writeFile(path.join(root, 'sign-in.dpapi'), 'sealed');
    await mkdir(path.join(root, 'Profiles', 'brave', 'Default'), { recursive: true });
    await mkdir(path.join(root, 'last-attempt'), { recursive: true });
    expect(hasAppleWebSignIn({ root })).toBe(true);
    await forgetAppleWebSignIn({ root });
    expect(hasAppleWebSignIn({ root })).toBe(false);
    expect(await readdir(root)).toEqual(['last-attempt']);
  });
});
