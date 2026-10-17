import { describe, expect, it } from 'vitest';
import type { HostEvent } from '../../../desktop/src/shared/contract.js';
import {
  emptyRun,
  isActive,
  isBusy,
  phaseLabel,
  phaseNow,
  phasesFor,
  reduceRun,
  runningPhase,
  shortReason,
  type RunState,
} from '../../src/state/runs.js';

const apply = (run: RunState, events: HostEvent[], sessionId = 's-1') => events.reduce((r, e) => reduceRun(r, e, sessionId, 1000), run);
const started = (extra: Partial<Extract<HostEvent, { type: 'session-started' }>> = {}): HostEvent => ({ type: 'session-started', mode: 'run', projectPath: 'C:\\app', mac: 'mac-1', target: null, ...extra });

describe('run state', () => {
  it('follows a run from start to the app running and the end', () => {
    let run = apply(emptyRun('C:\\app'), [started()]);
    expect(run.status).toBe('starting');
    expect(isActive(run)).toBe(true);
    expect(isBusy(run)).toBe(true);
    run = apply(run, [
      { type: 'step', id: 'a', title: 'Copying files', phase: 'sync' },
      { type: 'step-progress', id: 'a', text: '12 files', done: 12 },
    ]);
    expect(run.status).toBe('building');
    expect(runningPhase(run)).toBe('sync');
    expect(run.phases.sync).toMatchObject({ status: 'running', progress: '12 files', count: 12 });
    run = apply(run, [
      { type: 'step-end', id: 'a', status: 'ok', ms: 300, detail: '12 files uploaded' },
      { type: 'app', state: 'running', name: 'Hello', target: 'iPhone 17 Pro' },
    ]);
    expect(run.phases.sync).toMatchObject({ status: 'done', ms: 300, detail: '12 files uploaded' });
    expect(run.status).toBe('running');
    run = apply(run, [{ type: 'session-ended', mode: 'run', ok: true, cancelled: false, ms: 5000 }]);
    expect(run.status).toBe('stopped');
    expect(run.sessionId).toBeNull();
    expect(run.app?.state).toBe('stopped');
    expect(isActive(run)).toBe(false);
  });

  it('marks the web build skipped in live reload, and keeps the last run when the next starts', () => {
    let run = apply(emptyRun('C:\\app'), [started({ mode: 'live' })]);
    expect(run.phases.web).toMatchObject({ status: 'skipped' });
    expect(run.live?.tunnel).toBe('pending');
    run = apply(run, [
      { type: 'step', id: 'b', title: 'Build', phase: 'build' },
      { type: 'step-end', id: 'b', status: 'ok', ms: 10 },
      { type: 'session-ended', mode: 'live', ok: true, cancelled: true, ms: 100 },
    ]);
    expect(run.status).toBe('stopped');
    run = apply(run, [started()], 's-2');
    expect(run.runNumber).toBe(2);
    expect(run.previous?.runNumber).toBe(1);
    expect(run.previous?.phases.build?.status).toBe('done');
  });

  it('closes running steps as failed when the session fails, with its error', () => {
    const error = { message: 'Xcode failed', expected: true };
    const run = apply(emptyRun('C:\\app'), [
      started(),
      { type: 'step', id: 'c', title: 'Xcode build', phase: 'build' },
      { type: 'session-ended', mode: 'run', ok: false, cancelled: false, error, ms: 900 },
    ]);
    expect(run.status).toBe('failed');
    expect(run.phases.build?.status).toBe('failed');
    expect(run.error?.message).toBe('Xcode failed');
  });

  it('keeps diagnostics, the dev server and hot reloads', () => {
    const run = apply(emptyRun('C:\\app'), [
      started({ mode: 'live' }),
      { type: 'diagnostic', diagnostic: { severity: 'error', message: 'nope', file: 'C:\\app\\a.swift', line: 3, own: true } },
      { type: 'devserver', url: 'http://localhost:5173', external: false, command: 'npm run dev' },
      { type: 'hmr', state: 'update', at: 42 },
    ]);
    expect(run.diagnostics).toHaveLength(1);
    expect(run.live?.devServerUrl).toBe('http://localhost:5173');
    expect(run.live?.hmrUpdatedAt).toBe(42);
  });

  it('knows where a run happens: the Mac desktop, this PC, an iPhone through this PC', () => {
    const mac = apply(emptyRun('C:\\app'), [started({ target: 'mac-desktop' })]);
    expect(mac.onMac).toBe(true);
    const pc = apply(emptyRun('C:\\app'), [started({ target: 'pc-desktop', mac: null })]);
    expect(pc.onPc).toBe(true);
    const wsl = apply(emptyRun('C:\\app'), [started({ backend: 'wsl', mac: null, mode: 'build' })]);
    expect(wsl.backend).toBe('wsl');
    expect(wsl.mode).toBe('ipa');
  });

  it('forgets the last run when the next one runs somewhere else (a Flutter app\u2019s iOS app, then its Windows app)', () => {
    let run = apply(emptyRun('C:\\app'), [started(), { type: 'session-ended', mode: 'run', ok: true, cancelled: false, ms: 1 }]);
    run = apply(run, [started({ target: 'pc-desktop', mac: null })], 's-2');
    expect(run.previous).toBeNull();
  });

  it('remembers a run that skipped its web build, and a sync that ends as done', () => {
    const noBuild = apply(emptyRun('C:\\app'), [{ ...started(), webBuild: false } as unknown as HostEvent]);
    expect(noBuild.keepsWebFiles).toBe(true);
    const sync = apply(emptyRun('C:\\app'), [started({ mode: 'sync' as never }), { type: 'session-ended', mode: 'sync' as never, ok: true, cancelled: false, ms: 1 }]);
    expect(sync.status).toBe('done');
  });

  it('marks the simulator step not needed on a device', () => {
    const run = apply(emptyRun('C:\\app'), [started(), { type: 'target', target: { kind: 'device', udid: '00008120-000', name: 'IK 14', os: 'iOS 26', osVersion: '26', state: 'connected', available: true } }]);
    expect(run.phases.boot?.status).toBe('skipped');
  });
});

describe('timeline', () => {
  const base = { mode: 'run' as const, onMac: false, onPc: false, backend: 'mac' as const, phases: {} };
  it('picks the steps for each kind of run', () => {
    expect(phasesFor(base, { flutter: false, capacitorElectron: false })).toEqual(['web', 'sync', 'deps', 'cap', 'build', 'boot', 'install', 'launch']);
    expect(phasesFor({ ...base, mode: 'ipa' }, { flutter: false, capacitorElectron: false })).toContain('archive');
    expect(phasesFor({ ...base, onMac: true }, { flutter: false, capacitorElectron: true })).toContain('electron');
    expect(phasesFor({ ...base, onMac: true }, { flutter: false, capacitorElectron: false })).not.toContain('web');
    expect(phasesFor({ ...base, backend: 'wsl' }, { flutter: false, capacitorElectron: false })).toEqual(['web', 'deps', 'build', 'install', 'launch']);
    expect(phasesFor({ ...base, onPc: true }, { flutter: true, capacitorElectron: false })).toEqual(['deps', 'build', 'launch']);
    expect(phasesFor({ ...base, mode: 'sync' }, { flutter: false, capacitorElectron: false })).toEqual(['sync', 'deps', 'cap']);
    // React Native and Expo, as Studio shows them: Metro first, no web build, no cap sync.
    const native = { flutter: false, native: true, capacitorElectron: false };
    expect(phasesFor(base, native)).toEqual(['devserver', 'sync', 'deps', 'boot', 'build', 'install', 'launch']);
    expect(phasesFor({ ...base, onMac: true }, native)).toEqual(['devserver', 'sync', 'deps', 'build', 'launch']);
    expect(phasesFor({ ...base, onPc: true }, native)).toEqual(['devserver', 'deps', 'build', 'install', 'launch']);
    expect(phasesFor({ ...base, backend: 'wsl' }, native)).toEqual(['devserver', 'deps', 'build', 'install', 'launch']);
    expect(phasesFor({ ...base, backend: 'wsl', mode: 'ipa' }, native)).toEqual(['web', 'deps', 'build']);
  });

  it('follows Metro as a step of its own', () => {
    const run = apply(emptyRun('C:\\rn'), [started(), { type: 'step', id: 'metro', title: 'Starting Metro (react-native start)', phase: 'devserver' }]);
    expect(run.phases.devserver?.status).toBe('running');
    expect(phaseNow('devserver', false)).toBe('Starting the dev server');
  });

  it('keeps a running app running while it loads its first bundle', () => {
    const running = apply(emptyRun('C:\\rn'), [started({ mode: 'live' }), { type: 'app', state: 'running', name: 'Hello' }]);
    expect(running.status).toBe('running');
    const loading = reduceRun(running, { type: 'step', id: 'bundle', title: 'Bundling the JavaScript for iOS', phase: 'launch' }, 's-1', 2000);
    expect(loading.status).toBe('running');
    expect(loading.phases.launch?.status).toBe('running');
  });

  it('shows a step a run reports even when its list lacks it, unless it was skipped', () => {
    const run = { ...base, phases: { download: { status: 'done' as const } } };
    expect(phasesFor(run, { flutter: true, capacitorElectron: false }).at(-1)).toBe('download');
    const skipped = { ...base, phases: { web: { status: 'skipped' as const, detail: 'served by your dev server' } } };
    expect(phasesFor(skipped, { flutter: false, native: true, capacitorElectron: false })).not.toContain('web');
  });

  it('names the steps as CapMac Studio does', () => {
    expect(phaseLabel('build', { onMac: false, pc: false, flutter: false })).toBe('Xcode build');
    expect(phaseLabel('build', { onMac: true, pc: false, flutter: false })).toBe('Build');
    expect(phaseLabel('deps', { onMac: false, pc: false, flutter: true })).toBe('Flutter and packages');
    expect(phaseLabel('build', { onMac: false, onPc: true, pc: false, flutter: true })).toBe('Build');
    expect(phaseLabel('build', { onMac: false, pc: true, flutter: false })).toBe('Build and sign');
    // React Native: Metro, and its packages come with pods.
    const rn = { onMac: false, pc: false, flutter: false, reactNative: true };
    expect(phaseLabel('devserver', rn)).toBe('Metro');
    expect(phaseLabel('deps', rn)).toBe('Packages and pods');
    expect(phaseLabel('build', { ...rn, onMac: true })).toBe('Build');
    expect(phaseLabel('build', rn)).toBe('Xcode build');
    expect(phaseLabel('devserver', { onMac: false, pc: false, flutter: false })).toBe('Dev server');
  });

  it('shortens why a step was skipped', () => {
    expect(shortReason('dependencies unchanged')).toBe('unchanged');
    expect(shortReason('served by your dev server')).toBe('dev server');
    expect(shortReason('already booted')).toBe('already on');
    expect(shortReason('using the web files already built')).toBe('prebuilt');
    expect(shortReason(undefined)).toBe('skipped');
  });
});
