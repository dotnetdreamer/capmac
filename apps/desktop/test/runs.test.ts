import { beforeEach, describe, expect, it } from 'vitest';
import type { Envelope, HostEvent } from '../src/shared/contract';
import { isActive, isBusy, useRuns, type RunState } from '../src/renderer/state/runs';

const projectPath = 'C:\\Users\\me\\apps\\hello';
const scope = { projectPath, sessionId: 's1', mac: 'ik-s-m1' };
const apply = (...events: HostEvent[]) => useRuns.getState().apply(events.map((event): Envelope => ({ scope, event })));
const run = (): RunState => useRuns.getState().byKey[projectPath.toLowerCase()]!;
const target = { kind: 'simulator', udid: 'A1B2C3D4-0000-0000-0000-000000000000', name: 'iPhone 17', os: 'iOS 26.5', state: 'Booted' } as never;

beforeEach(() => useRuns.setState({ byKey: {} }));

describe('the run timeline', () => {
  it('says what a run does before its first build step', () => {
    apply({ type: 'session-started', mode: 'run', projectPath, mac: null, target: null, backend: 'wsl' });
    apply({ type: 'step', id: 'check', title: 'Checking this PC’s build tools', phase: 'other' });
    expect(run().preparing).toEqual({ id: 'check', title: 'Checking this PC’s build tools' });
    apply({ type: 'step-end', id: 'check', status: 'ok', ms: 60_000 });
    expect(run().preparing).toBeNull();
    apply({ type: 'step', id: 'other', title: 'Something else', phase: 'other' }, { type: 'step', id: 'web', title: 'Building the web app', phase: 'web' });
    expect(run().preparing).toBeNull();
    expect(run().phases.web).toMatchObject({ status: 'running' });
  });

  it('follows a successful run from start to the app running', () => {
    apply({ type: 'session-started', mode: 'run', projectPath, mac: 'ik-s-m1', target: null });
    expect(run().status).toBe('starting');
    expect(run().runNumber).toBe(1);
    expect(isBusy(run())).toBe(true);

    apply(
      { type: 'phase-skipped', phase: 'web', reason: 'unchanged' },
      { type: 'step', id: 'sync', title: 'Syncing', phase: 'sync' },
      { type: 'step-progress', id: 'sync', text: '12 files', done: 0.5 },
    );
    expect(run().status).toBe('building');
    expect(run().phases.sync).toMatchObject({ status: 'running', progress: '12 files', fraction: 0.5 });

    apply(
      { type: 'step-end', id: 'sync', status: 'ok', ms: 137 },
      { type: 'phase-skipped', phase: 'build', reason: 'unchanged' },
      { type: 'target', target },
      { type: 'step', id: 'launch', title: 'Launching', phase: 'launch' },
      { type: 'step-end', id: 'launch', status: 'ok', ms: 4000 },
      { type: 'app', state: 'running', name: 'Hello CapMac', target: 'iPhone 17' },
    );
    expect(run().phases.sync).toMatchObject({ status: 'done', ms: 137 });
    expect(run().phases.web).toMatchObject({ status: 'skipped', detail: 'unchanged' });
    expect(run().phases.build?.status).toBe('skipped');
    expect(run().status).toBe('running');
    expect(run().app?.state).toBe('running');
    expect(isActive(run())).toBe(true);
    expect(isBusy(run())).toBe(false);

    apply({ type: 'session-ended', mode: 'run', ok: true, cancelled: false, ms: 9000 });
    expect(run().status).toBe('stopped');
    expect(run().app?.state).toBe('stopped');
    expect(isActive(run())).toBe(false);
  });

  it('marks the running phase failed and keeps the error and problems', () => {
    apply(
      { type: 'session-started', mode: 'run', projectPath, mac: 'ik-s-m1', target: null },
      { type: 'step', id: 'b', title: 'Building', phase: 'build' },
      { type: 'diagnostic', diagnostic: { severity: 'error', message: "cannot find 'foo' in scope", file: 'C:\\apps\\hello\\ios\\App\\App\\AppDelegate.swift', line: 12, own: true } },
      { type: 'error', error: { message: 'The Xcode build failed.', hint: 'Fix the errors in Problems, then run again.', expected: true } },
    );
    expect(run().status).toBe('failed');
    expect(run().phases.build?.status).toBe('failed');
    expect(run().diagnostics).toHaveLength(1);
    expect(run().error?.message).toBe('The Xcode build failed.');

    apply({ type: 'session-ended', mode: 'run', ok: false, cancelled: false, ms: 20_000 });
    expect(run().status).toBe('failed');
  });

  it('treats a cancelled run as stopped, not failed', () => {
    apply(
      { type: 'session-started', mode: 'run', projectPath, mac: 'ik-s-m1', target: null },
      { type: 'step', id: 'b', title: 'Building', phase: 'build' },
      { type: 'session-ended', mode: 'run', ok: false, cancelled: true, ms: 3000 },
    );
    expect(run().status).toBe('stopped');
    expect(run().phases.build?.status).toBe('cancelled');
  });

  it('starts a new timeline for each live-reload rebuild and keeps the last one', () => {
    apply({ type: 'session-started', mode: 'live', projectPath, mac: 'ik-s-m1', target: null });
    expect(run().phases.web).toMatchObject({ status: 'skipped', detail: 'served by your dev server' });
    expect(run().live?.hmr).toBe('waiting');

    apply(
      { type: 'session', mode: 'live', state: 'building' },
      { type: 'step', id: 's', title: 'Syncing', phase: 'sync' },
      { type: 'step-end', id: 's', status: 'ok', ms: 100 },
      { type: 'devserver', url: 'http://localhost:5173/', external: false, command: 'npm run dev' },
      { type: 'tunnel', state: 'up', liveUrl: 'http://localhost:5173/', localUrl: 'http://localhost:5173/' },
      { type: 'hmr', state: 'connected', at: 1 },
      { type: 'app', state: 'running', name: 'Hello CapMac' },
      { type: 'session', mode: 'live', state: 'running' },
    );
    expect(run()).toMatchObject({ status: 'running', runNumber: 1 });
    expect(run().live).toMatchObject({ tunnel: 'up', hmr: 'connected', command: 'npm run dev' });

    // A native change: capmac rebuilds while the app keeps running.
    apply({ type: 'native-change', paths: ['ios/App/App/Info.plist'], kinds: ['native'] as never }, { type: 'session', mode: 'live', state: 'building' });
    expect(run().runNumber).toBe(2);
    expect(run().status).toBe('building');
    expect(run().previous).toMatchObject({ runNumber: 1, ok: true });
    expect(run().app?.state).toBe('running');
    expect(run().live?.lastNativeChange?.paths).toEqual(['ios/App/App/Info.plist']);
  });

  it('skips Boot on a physical device', () => {
    apply(
      { type: 'session-started', mode: 'run', projectPath, mac: 'ik-s-m1', target: null },
      { type: 'target', target: { kind: 'device', udid: '00008120-001A2B3C4D5E6F70', name: 'IK 14 Pro Max', os: 'iOS 26.6.2', state: 'connected' } as never },
    );
    expect(run().phases.boot).toMatchObject({ status: 'skipped', detail: 'not needed on a device' });
  });

  it('starts afresh when the next run is somewhere else (a Flutter app’s iOS app, then its Windows app)', () => {
    apply(
      { type: 'session-started', mode: 'run', projectPath, mac: 'ik-s-m1', target: null },
      { type: 'target', target },
      { type: 'step', id: 'build', title: 'Running Xcode build', phase: 'build' },
      { type: 'step-end', id: 'build', status: 'ok', ms: 33_000 },
      { type: 'session-ended', mode: 'run', ok: true, cancelled: false, ms: 60_000 },
    );
    // Again on the same simulator: the last run stays to compare with.
    apply({ type: 'session-started', mode: 'run', projectPath, mac: 'ik-s-m1', target: null });
    expect(run().target?.name).toBe('iPhone 17');
    expect(run().previous?.phases.build).toMatchObject({ status: 'done' });
    apply({ type: 'session-ended', mode: 'run', ok: true, cancelled: true, ms: 1000 });
    // On this PC's desktop: no simulator, and nothing of the iOS runs.
    apply({ type: 'session-started', mode: 'run', projectPath, mac: null, target: 'pc-desktop' });
    expect(run().onPc).toBe(true);
    expect(run().target).toBeNull();
    expect(run().previous).toBeNull();
    expect(run().phases.build).toBeUndefined();
  });

  it('ignores events without a project', () => {
    useRuns.getState().apply([{ scope: { mac: 'ik-s-m1' }, event: { type: 'app', state: 'running' } }]);
    expect(useRuns.getState().byKey).toEqual({});
  });
});
