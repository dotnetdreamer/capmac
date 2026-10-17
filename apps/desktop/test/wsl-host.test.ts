import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CancelledError, silentContext, UserError, type EngineContext, type ProjectInfo } from '@capmac/core/engine';
import type { WslSetupState } from '@capmac/core/shared/wsl-setup';
import { createWslHost, type WslEngine } from '../src/engine/wsl-host';
import type { HostEvent, Scope } from '../src/shared/contract';

const projectPath = 'C:\\Users\\me\\apps\\ludo';
const state: WslSetupState = { status: null, tools: true, sdk: false, signing: false, inApp: true, partialDownload: { bytes: 1_200_000_000 } };
const iphone = { udid: '00008120-0001284026AB401E', name: 'IK 14 Pro Max', productVersion: '26.5', productType: 'iPhone15,3' };
let temporary: string | undefined;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

/** The host with a fake engine; events and the contexts it made are recorded. */
function host(overrides: Partial<WslEngine> = {}) {
  const events: Array<{ scope: Scope; event: HostEvent }> = [];
  const contexts: Array<{ scope: Scope; ctx: EngineContext }> = [];
  let id = 0;
  const engine = {
    setupWsl: vi.fn(async () => undefined),
    wslSetupState: vi.fn(async () => state),
    doctorWsl: vi.fn(async () => ({ ready: false, checks: [] })),
    runWsl: vi.fn(async () => undefined),
    devWsl: vi.fn(async () => undefined),
    buildWsl: vi.fn(),
    listWslDevices: vi.fn(async () => [iphone]),
    loadWslOptions: vi.fn(async () => ({ python: 'C:\\CapMac\\python.exe' })),
    inspectAppleDeviceServer: vi.fn(async () => 'running' as const),
    startAppleDeviceServer: vi.fn(async () => 'running' as const),
    ...overrides,
  } as unknown as WslEngine & Record<keyof WslEngine, ReturnType<typeof vi.fn>>;
  const wsl = createWslHost({
    emit: (scope, event) => events.push({ scope, event }),
    contextFor: (scope) => {
      const ctx = { ...silentContext(), emit: (event: HostEvent) => events.push({ scope, event }) } as EngineContext;
      contexts.push({ scope, ctx });
      return ctx;
    },
    newId: (prefix) => `${prefix}-${++id}`,
    engine,
  });
  return { wsl, engine, events, contexts };
}

describe('this PC in CapMac Studio: setup', () => {
  it('reports what setup has put in place, with Apple’s device server and no setup running', async () => {
    const { wsl, engine } = host({ inspectAppleDeviceServer: vi.fn(async () => 'missing') as never });
    expect(await wsl.status(projectPath)).toEqual({ ...state, server: 'missing', setupId: null });
    expect(engine.wslSetupState).toHaveBeenCalledWith(projectPath);
  });

  it('runs the guided setup in the background, on the setup scope, and says when it ended', async () => {
    let finish!: () => void;
    const { wsl, engine, events, contexts } = host({ setupWsl: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) as never });
    const { setupId } = wsl.setup(projectPath, true);
    expect(engine.setupWsl).toHaveBeenCalledWith({ cwd: projectPath, appleLogin: true }, expect.anything(), expect.any(AbortSignal), { guided: true });
    // Asked again while it runs: the same setup.
    expect(wsl.setup(projectPath).setupId).toBe(setupId);
    expect(engine.setupWsl).toHaveBeenCalledOnce();
    expect((await wsl.status(projectPath)).setupId).toBe(setupId);
    // Its events (progress, questions' context) go to the setup screen.
    expect(contexts[0]!.scope).toEqual({ setup: projectPath });
    contexts[0]!.ctx.emit({ type: 'wsl-setup', phase: 'apple-download', state: 'running', bytes: { received: 1, total: 2 } });
    finish();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ scope: { setup: projectPath }, event: { type: 'setup-ended', ok: true, cancelled: false, error: undefined } }));
    expect(events[0]!.event).toMatchObject({ type: 'wsl-setup', phase: 'apple-download' });
    expect((await wsl.status(projectPath)).setupId).toBeNull();
  });

  it('reports a failed setup with the engine’s own message', async () => {
    const { wsl, events } = host({ setupWsl: vi.fn(async () => { throw new UserError('Apple did not allow this Xcode download.', 'Accept the terms'); }) as never });
    wsl.setup(projectPath);
    await vi.waitFor(() => expect(events.at(-1)?.event).toMatchObject({ type: 'setup-ended', ok: false, cancelled: false, error: { message: 'Apple did not allow this Xcode download.', hint: 'Accept the terms' } }));
  });

  it('stops a running setup and reports it as stopped, not failed', async () => {
    const { wsl, events } = host({
      setupWsl: vi.fn((_input: unknown, _ctx: unknown, signal: AbortSignal) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new CancelledError())))) as never,
    });
    const { setupId } = wsl.setup(projectPath);
    await wsl.stopSetup(setupId);
    expect(events.at(-1)?.event).toEqual({ type: 'setup-ended', ok: false, cancelled: true, error: undefined });
    // Unknown or ended setups: nothing to stop.
    await expect(wsl.stopSetup(setupId)).resolves.toBeUndefined();
  });
});

describe('this PC in CapMac Studio: health check and iPhones', () => {
  it('shows `capmac wsl doctor`’s checks as health check rows, with the same fixes', async () => {
    const checks = [
      { id: 'wsl-0', level: 'ok' as const, label: 'WSL distribution', detail: 'CapMac-Ubuntu' },
      { id: 'certificate', level: 'fail' as const, label: 'Signing certificate (.p12)', detail: 'not configured', fix: 'Run `capmac wsl setup` in your app’s folder.' },
    ];
    const { wsl, engine } = host({ doctorWsl: vi.fn(async () => ({ ready: false, checks })) as never });
    expect(await wsl.doctor(projectPath)).toEqual({
      ready: false,
      checks: [
        { id: 'wsl-0', group: 'pc', level: 'ok', label: 'WSL distribution', detail: 'CapMac-Ubuntu' },
        { id: 'certificate', group: 'pc', level: 'fail', label: 'Signing certificate (.p12)', detail: 'not configured', fix: 'Run `capmac wsl setup` in your app’s folder.' },
      ],
    });
    expect(engine.doctorWsl).toHaveBeenCalledWith({ cwd: projectPath }, expect.anything(), expect.any(AbortSignal));
  });

  it('lists the iPhones plugged into this PC as device targets, with the project’s Python', async () => {
    const { wsl, engine } = host();
    const [first, second] = await Promise.all([wsl.devices(projectPath), wsl.devices(projectPath)]);
    expect(first).toEqual({ server: 'running', error: null, devices: [{ kind: 'device', udid: iphone.udid, name: 'IK 14 Pro Max', os: 'iOS 26.5', osVersion: '26.5', state: 'connected', available: true, connection: 'usb', model: 'iPhone15,3' }] });
    // Asked twice at once: one look at the USB devices.
    expect(second).toBe(first);
    expect(engine.listWslDevices).toHaveBeenCalledOnce();
    expect(engine.listWslDevices).toHaveBeenCalledWith({ python: 'C:\\CapMac\\python.exe' });
  });

  it('starts Apple’s device server when it is installed but not running, at most once a minute', async () => {
    const { wsl, engine } = host({ inspectAppleDeviceServer: vi.fn(async () => 'stopped') as never, startAppleDeviceServer: vi.fn(async () => 'stopped') as never });
    expect(await wsl.devices(projectPath)).toEqual({ server: 'stopped', devices: [], error: null });
    await wsl.devices(projectPath);
    expect(engine.startAppleDeviceServer).toHaveBeenCalledOnce();
    expect(engine.listWslDevices).not.toHaveBeenCalled();
  });

  it('says why iPhones can’t be listed instead of failing', async () => {
    const { wsl } = host({ listWslDevices: vi.fn(async () => { throw new UserError('pymobiledevice3 is not installed.'); }) as never });
    expect(await wsl.devices(projectPath)).toMatchObject({ server: 'running', devices: [], error: { message: 'pymobiledevice3 is not installed.' } });
  });
});

describe('this PC in CapMac Studio: run, live and build', () => {
  const project = { capDir: projectPath } as ProjectInfo;
  const ctx = silentContext();

  it('runs and live-reloads with `capmac wsl run` and `dev`, on the iPhone picked', async () => {
    const { wsl, engine } = host();
    const signal = new AbortController().signal;
    await wsl.session('run', project, iphone.udid, ctx, signal, vi.fn());
    expect(engine.runWsl).toHaveBeenCalledWith({ cwd: projectPath, target: iphone.udid }, ctx, signal);
    await wsl.session('live', project, undefined, ctx, signal, vi.fn());
    expect(engine.devWsl).toHaveBeenCalledWith({ cwd: projectPath }, ctx, signal);
    // Clean rebuild: `--clean`.
    await wsl.session('run', project, undefined, ctx, signal, vi.fn(), { clean: true });
    expect(engine.runWsl).toHaveBeenLastCalledWith({ cwd: projectPath, clean: true }, ctx, signal);
  });

  it('builds the signed .ipa and says where it is', async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'capmac-wsl-host-'));
    const ipa = path.join(temporary, 'App.ipa');
    await writeFile(ipa, Buffer.alloc(1234));
    const { wsl } = host({ buildWsl: vi.fn(async () => ({ appPath: 'App.app', ipaPath: ipa, bundleId: 'dev.example.app', signed: true })) as never });
    const onIpa = vi.fn();
    await wsl.session('build', project, undefined, ctx, new AbortController().signal, onIpa);
    expect(onIpa).toHaveBeenCalledWith(ipa, 1234);
  });

  it('refuses to hand out an unsigned build as the .ipa', async () => {
    const { wsl } = host({ buildWsl: vi.fn(async () => ({ appPath: 'App.app', ipaPath: 'App.ipa', bundleId: 'dev.example.app', signed: false })) as never });
    const onIpa = vi.fn();
    await expect(wsl.session('build', project, undefined, ctx, new AbortController().signal, onIpa)).rejects.toThrow('without signing');
    expect(onIpa).not.toHaveBeenCalled();
  });
});
