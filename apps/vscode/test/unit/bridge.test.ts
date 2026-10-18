/**
 * The extension's engine process: CapMac Studio's engine host behind a
 * Node.js stand-in for Electron's parent port, driven by EngineClient over
 * Node's IPC (structured clone). First against a fake host that exercises
 * every message, then against Studio's real host.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineStatus, Envelope, PromptRequest } from '../../../desktop/src/shared/contract.js';
import type { HostInit } from '../../../desktop/src/shared/host-protocol.js';
import { EngineClient } from '../../src/engine/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..', '..');
const repoDir = path.resolve(extensionDir, '..', '..');
const out = mkdtempSync(path.join(os.tmpdir(), 'capmac-vscode-bridge-'));

async function bundle(entry: string, outfile: string): Promise<string> {
  await build({
    absWorkingDir: extensionDir,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron', 'cpu-features', '*.node', 'node-datachannel'],
    loader: { '.rb': 'text', '.sh': 'text', '.py': 'text', '.c': 'text' },
    define: { __APP_VERSION__: '"0.0.0"', __AGENT_VERSION__: '"0.0.0"', __CAPMAC_VERSION__: '"0.0.0"', __RELEASE_NOTES_URL__: '""', __CAPMAC_SIGNAL_URL__: '""' },
    logLevel: 'silent',
    logOverride: { 'empty-import-meta': 'silent' },
  });
  return outfile;
}

function client(modulePath: string) {
  const events: Envelope[] = [];
  const prompts: PromptRequest[] = [];
  const withdrawn: string[] = [];
  const statuses: EngineStatus[] = [];
  const logs: string[] = [];
  // The React Native sample is for a host that knows it (feature/react-native).
  const init = (): HostInit & { reactNativeSampleDir: string | null } => ({ agentPath: 'none', sampleDir: null, electronSampleDir: null, flutterSampleDir: null, reactNativeSampleDir: null, samplesHome: out, remoteModulesDir: null, mirrorReceiverDir: null, settings: { verbose: false, osLogs: false } });
  const engine = new EngineClient(
    modulePath,
    init,
    {
      onEvents: (batch) => events.push(...batch),
      onPrompt: (prompt) => prompts.push(prompt),
      onPromptWithdraw: (id) => withdrawn.push(id),
      onStatus: (status) => statuses.push(status),
      onLog: (_level, message) => logs.push(message),
    },
  );
  return { engine, events, prompts, withdrawn, statuses, logs };
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('engine bridge (fake host)', () => {
  let fake: ReturnType<typeof client>;

  beforeAll(async () => {
    fake = client(await bundle('test/unit/fixtures/fake-host.ts', path.join(out, 'fake.cjs')));
    fake.engine.start();
  });
  afterAll(async () => {
    await fake.engine.shutdown(2000);
  });

  it('answers calls, with the events they caused first', async () => {
    const result = await fake.engine.call('echo' as never, { hello: 'world' } as never);
    expect(result).toEqual({ ok: true, value: { hello: 'world' } });
    expect(fake.events.some((e) => e.event.type === 'log')).toBe(true);
    expect(fake.statuses.map((s) => s.state)).toContain('ready');
  });

  it('turns a failed call into an EngineError with invoke', async () => {
    await expect(fake.engine.invoke('nope' as never, {} as never)).rejects.toThrow('Unknown request');
  });

  it('asks, and gives the answer back', async () => {
    const asking = fake.engine.call('ask' as never, {} as never);
    await until(() => fake.prompts.length > 0);
    expect(fake.prompts[0]).toMatchObject({ id: 'p-1', kind: 'confirm', message: 'Go on?' });
    fake.engine.respondPrompt({ id: 'p-1', ok: true, value: true });
    expect(await asking).toEqual({ ok: true, value: { id: 'p-1', ok: true, value: true } });
  });

  it('passes on a withdrawn question', async () => {
    await fake.engine.call('withdraw' as never, {} as never);
    expect(fake.withdrawn).toContain('p-2');
  });

  it('carries a screen both ways, binary frames included, and closes it from either side', async () => {
    const messages: unknown[] = [];
    let closed = false;
    const channel = fake.engine.openScreen({ mac: 'm', udid: 'sim-1234', prefer: 'smooth' }, { onMessage: (m) => messages.push(m), onClose: () => (closed = true) });
    await until(() => messages.length > 0);
    expect(messages[0]).toEqual({ type: 'state', state: 'streaming' });
    channel.post({ type: 'keyframe' });
    await until(() => messages.length > 1);
    const echo = messages[1] as { type: string; got: unknown; data: ArrayBuffer };
    expect(echo.got).toEqual({ type: 'keyframe' });
    expect(echo.data).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(echo.data)]).toEqual([1, 2, 3]);
    // The extension's end closes: the host hears it.
    channel.close();
    await until(() => fake.logs.some((l) => l.includes(`port closed ${channel.streamId}`)));
    // The host's end closes: the extension hears it.
    const second = fake.engine.openScreen({ mac: 'm', udid: 'sim-5678', prefer: 'compatible' }, { onMessage: () => undefined, onClose: () => (closed = true) });
    second.post({ type: 'close-from-host' } as never);
    await until(() => closed);
  });

  it('restarts the engine after a crash, and fails the call it was answering', async () => {
    const result = await fake.engine.call('crash' as never, {} as never);
    expect(result.ok).toBe(false);
    await until(() => fake.statuses.filter((s) => s.state === 'ready').length >= 2, 8000);
    expect(fake.statuses.some((s) => s.state === 'crashed')).toBe(true);
    expect(await fake.engine.call('echo' as never, { again: true } as never)).toEqual({ ok: true, value: { again: true } });
  });

  it('keeps what a screen sends until the host listens, as Electron does', async () => {
    const messages: Array<{ type: string; got?: unknown }> = [];
    const channel = fake.engine.openScreen({ mac: 'm', udid: 'slow', prefer: 'smooth' }, { onMessage: (m) => messages.push(m as never), onClose: () => undefined });
    channel.post({ type: 'size', width: 400, height: 800 } as never);
    await until(() => messages.some((m) => m.type === 'echo'));
    expect(messages.find((m) => m.type === 'echo')?.got).toEqual({ type: 'size', width: 400, height: 800 });
    // Closed before the host listens: it hears that too, after what came before.
    const early = fake.engine.openScreen({ mac: 'm', udid: 'slow', prefer: 'smooth' }, { onMessage: () => undefined, onClose: () => undefined });
    early.close();
    await until(() => fake.logs.some((l) => l.includes(`port closed ${early.streamId}`)));
    channel.close();
  });

  it('answers a call made while the engine starts, when it dies before it is ready', async () => {
    process.env.FAKE_HOST_DIES = '1';
    const dying = client(path.join(out, 'fake.cjs'));
    try {
      dying.engine.start();
      const result = await dying.engine.call('echo' as never, {} as never);
      expect(result).toMatchObject({ ok: false, error: { code: 'ENGINE_CRASHED' } });
    } finally {
      await dying.engine.shutdown(1000);
      delete process.env.FAKE_HOST_DIES;
    }
  });
});

describe('engine bridge (CapMac Studio’s real host)', () => {
  let real: ReturnType<typeof client>;
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'capmac-vscode-config-'));
  const saved = process.env.CAPMAC_CONFIG_DIR;

  beforeAll(async () => {
    // An empty CapMac config: no paired Macs, nothing of this PC's touched.
    process.env.CAPMAC_CONFIG_DIR = configDir;
    real = client(await bundle('src/engine/main.ts', path.join(out, 'engine.cjs')));
    real.engine.start();
  }, 60_000);
  afterAll(async () => {
    await real.engine.shutdown(4000);
    if (saved === undefined) delete process.env.CAPMAC_CONFIG_DIR;
    else process.env.CAPMAC_CONFIG_DIR = saved;
    rmSync(configDir, { recursive: true, force: true });
  });

  it('finds the apps of the samples, as Studio does', async () => {
    const capacitor = await real.engine.invoke('projects.detect', { path: path.join(repoDir, 'examples', 'hello-capacitor') });
    expect(capacitor.projects[0]?.apps.map((a) => a.id).sort()).toEqual(['electron', 'ios']);
    const flutter = await real.engine.invoke('projects.detect', { path: path.join(repoDir, 'examples', 'hello-flutter') });
    expect(flutter.projects[0]?.framework).toBe('flutter');
    expect(flutter.projects[0]?.apps.map((a) => a.id).sort()).toEqual(['ios', 'macos', 'windows']);
    const electron = await real.engine.invoke('projects.detect', { path: path.join(repoDir, 'examples', 'hello-electron') });
    expect(electron.projects[0]?.apps.map((a) => a.id)).toEqual(['electron']);
  });

  it('lists no Macs with an empty config, and says no to an unknown request', async () => {
    expect(await real.engine.invoke('macs.list', {})).toEqual([]);
    const result = await real.engine.call('no.such.method' as never, {} as never);
    expect(result.ok).toBe(false);
  });

  it('sums up a project, with where its iOS app builds', async () => {
    const summary = await real.engine.invoke('projects.inspect', { path: path.join(repoDir, 'examples', 'hello-capacitor') });
    expect(summary.kind).toBe('capacitor');
    expect(summary.appName).toBe('Hello CapMac');
    expect(summary.backend).toBe('mac');
  });

  // With feature/react-native merged: its sample's apps, and DevTools only for a live session.
  const reactNative = path.join(repoDir, 'examples', 'hello-react-native');
  it.skipIf(!existsSync(reactNative))('finds the React Native sample’s apps, and opens DevTools only for a live session', async () => {
    const found = await real.engine.invoke('projects.detect', { path: reactNative });
    expect(found.projects[0]?.framework).toBe('react-native');
    expect(found.projects[0]?.apps.map((a) => a.id).sort()).toEqual(['ios', 'macos', 'windows']);
    const devtools = await real.engine.call('sessions.devtools' as never, { sessionId: 'nothing-runs' } as never);
    expect(devtools.ok).toBe(false);
    expect(devtools.ok ? '' : devtools.error.message).not.toMatch(/Unknown request/);
  });
});
