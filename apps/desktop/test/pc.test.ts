import { beforeEach, describe, expect, it } from 'vitest';
import type { Envelope, HostEvent, WslStatus } from '../src/shared/contract';
import { engineMethods } from '../src/shared/contract';
import { pcReady, stepStates, usePc, type PcEntry } from '../src/renderer/state/pc';
import { useRuns } from '../src/renderer/state/runs';

const projectPath = 'C:\\Users\\me\\apps\\ludo';
const key = projectPath.toLowerCase();
const status = (patch: Partial<WslStatus> = {}): WslStatus => ({ status: null, tools: false, sdk: false, signing: false, inApp: true, partialDownload: null, setupId: null, server: 'running', ...patch });
const entry = (patch: Partial<PcEntry> = {}): PcEntry => ({ status: null, phases: {}, bytes: null, lines: [], running: false, setupId: null, error: null, checks: null, checking: false, devices: null, dialog: false, ...patch });
const setupEvents = (...events: HostEvent[]) => usePc.getState().apply(events.map((event): Envelope => ({ scope: { setup: projectPath }, event })));

beforeEach(() => usePc.setState({ byKey: {} }));

describe('this PC’s setup, as the setup screen shows it', () => {
  it('is ready with the tools, the iPhone SDK and signing for the app', () => {
    expect(pcReady(status({ tools: true, sdk: true, signing: true }))).toBe(true);
    expect(pcReady(status({ tools: true, sdk: true }))).toBe(false);
    // Outside an app there is nothing to sign.
    expect(pcReady(status({ tools: true, sdk: true, inApp: false }))).toBe(true);
    expect(pcReady(null)).toBe(false);
  });

  it('shows what earlier setups put in place, and where the last one stopped', () => {
    // Ludo today: tools in place, no SDK or signing yet, Apple Devices installed.
    const ludo = stepStates(entry({ status: status({ tools: true }) }));
    expect(Object.fromEntries(Object.entries(ludo).map(([id, step]) => [id, step.state]))).toEqual({ tools: 'done', devices: 'done', signIn: 'waiting', signing: 'waiting', download: 'waiting', sdk: 'waiting' });
    const stopped = stepStates(entry({ status: status({ tools: true, status: { phase: 'apple-download', state: 'failed', updatedAt: '2026-10-16T10:00:00Z', message: 'Apple stopped sending the Xcode download.' } }) }));
    expect(stopped.download).toEqual({ state: 'failed', detail: 'Apple stopped sending the Xcode download.' });
    // Interrupted (the status still says running, but nothing runs): it stopped there too.
    expect(stepStates(entry({ status: status({ status: { phase: 'wsl', state: 'running', updatedAt: 'x' } }) })).tools.state).toBe('failed');
    expect(stepStates(entry({ status: status({ inApp: false }) })).signing.state).toBe('skipped');
  });

  it('follows a running setup from its events, with the download’s bytes and where it continued from', () => {
    setupEvents(
      { type: 'wsl-setup', phase: 'wsl', state: 'running' },
      { type: 'wsl-setup', phase: 'wsl', state: 'done' },
      { type: 'wsl-setup', phase: 'dependencies', state: 'done' },
      { type: 'wsl-setup', phase: 'apple-devices', state: 'skipped', detail: 'Not installed' },
      { type: 'wsl-setup', phase: 'apple-sign-in', state: 'done', detail: 'Example Team' },
      { type: 'wsl-setup', phase: 'signing', state: 'skipped', detail: 'Already set up' },
      { type: 'wsl-setup', phase: 'apple-catalog', state: 'done' },
      { type: 'wsl-setup', phase: 'apple-download', state: 'running', bytes: { received: 1_500_000_000, total: 3_000_000_000, resumedFrom: 800_000_000 } },
      { type: 'tool-output', stream: 'stderr', text: 'line one\nline two\n' },
    );
    const now = usePc.getState().byKey[key]!;
    const steps = stepStates(now);
    expect(steps.tools.state).toBe('done');
    expect(steps.devices).toEqual({ state: 'skipped', detail: 'Not installed' });
    expect(steps.signIn).toEqual({ state: 'done', detail: 'Example Team' });
    expect(steps.download.state).toBe('running');
    expect(steps.sdk.state).toBe('waiting');
    expect(now.bytes).toEqual({ received: 1_500_000_000, total: 3_000_000_000, resumedFrom: 800_000_000 });
    expect(now.lines).toEqual(['line one', 'line two']);
  });

  it('shows how far the iPhone SDK step is while it runs', () => {
    setupEvents(
      { type: 'wsl-setup', phase: 'sdk-import', state: 'running' },
      { type: 'wsl-setup', phase: 'sdk-import', state: 'running', fraction: 0.42 },
    );
    expect(stepStates(usePc.getState().byKey[key]!).sdk).toEqual({ state: 'running', fraction: 0.42 });
    setupEvents({ type: 'wsl-setup', phase: 'sdk-import', state: 'done' });
    expect(stepStates(usePc.getState().byKey[key]!).sdk).toEqual({ state: 'done' });
  });

  it('marks the step that failed, and ends the setup', () => {
    usePc.setState({ byKey: { [key]: entry({ running: true, setupId: 'setup-1' }) } });
    // The setup screen looks again once a setup ends.
    (globalThis as { window?: unknown }).window = { capmac: { call: async () => ({ ok: true, value: status() }) } };
    setupEvents(
      { type: 'wsl-setup', phase: 'apple-sign-in', state: 'failed', detail: 'Apple did not accept this sign-in.' },
      { type: 'setup-ended', ok: false, cancelled: false, error: { message: 'Apple did not accept this sign-in.', expected: true } },
    );
    const now = usePc.getState().byKey[key]!;
    expect(now.running).toBe(false);
    expect(stepStates(now).signIn).toEqual({ state: 'failed', detail: 'Apple did not accept this sign-in.' });
  });

  it('ignores events that aren’t a setup’s', () => {
    usePc.getState().apply([{ scope: { projectPath, sessionId: 's1' }, event: { type: 'tool-output', stream: 'stdout', text: 'build output' } }]);
    expect(usePc.getState().byKey[key]).toBeUndefined();
  });
});

describe('runs on this PC', () => {
  it('remember that they build on this PC, with no Mac', () => {
    useRuns.setState({ byKey: {} });
    useRuns.getState().apply([{ scope: { projectPath, sessionId: 's1' }, event: { type: 'session-started', mode: 'run', projectPath, mac: null, target: null, backend: 'wsl' } }]);
    expect(useRuns.getState().byKey[key]).toMatchObject({ backend: 'wsl', mac: null, status: 'starting' });
  });
});

describe('IPC validation for this PC', () => {
  it('accepts only the two backends, and a build mode', () => {
    expect(engineMethods['projects.setBackend'].safeParse({ path: projectPath, backend: 'wsl' }).success).toBe(true);
    expect(engineMethods['projects.setBackend'].safeParse({ path: projectPath, backend: 'cloud' }).success).toBe(false);
    const start = engineMethods['sessions.start'];
    expect(start.safeParse({ projectPath, mode: 'build', backend: 'wsl', target: '00008120-0001284026AB401E' }).success).toBe(true);
    expect(start.safeParse({ projectPath, mode: 'run', backend: 'linux' }).success).toBe(false);
  });

  it('takes nothing but the project for setup, its health check and iPhones', () => {
    expect(engineMethods['wsl.setup'].safeParse({ projectPath, appleLogin: true }).success).toBe(true);
    // No way to hand a password or code to setup: it asks for them itself.
    expect(engineMethods['wsl.setup'].safeParse({ projectPath, password: 'secret' }).success).toBe(false);
    expect(engineMethods['wsl.stopSetup'].safeParse({ setupId: 'setup-1' }).success).toBe(true);
    expect(engineMethods['wsl.stopSetup'].safeParse({ setupId: '../../x' }).success).toBe(false);
    for (const method of ['wsl.status', 'wsl.doctor', 'wsl.devices'] as const) {
      expect(engineMethods[method].safeParse({ projectPath }).success).toBe(true);
      expect(engineMethods[method].safeParse({ projectPath: '' }).success).toBe(false);
    }
  });
});
