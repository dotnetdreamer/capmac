import { describe, expect, it } from 'vitest';
import { startStep, withStep, type EngineContext } from '../../packages/core/src/engine/context.js';
import { CancelledError, toErrorInfo, UserError } from '../../packages/core/src/engine/errors.js';
import type { EngineEvent } from '../../packages/core/src/engine/events.js';
import { AgentEventTranslator, AppLogClassifier, phaseOf } from '../../packages/core/src/engine/translate.js';
import { AgentCallError } from '../../packages/core/src/engine/agent-client.js';
import { SshError } from '../../packages/core/src/engine/ssh.js';
import { PathMapper } from '../../packages/core/src/shared/paths.js';
import { localChecks, macChecks } from '../../packages/core/src/engine/doctor.js';
import type { MacLink } from '../../packages/core/src/engine/link.js';
import type { ProjectInfo } from '../../packages/core/src/engine/project.js';
import { runApp } from '../../packages/core/src/engine/run.js';
import type { ProbeResult } from '../../packages/core/src/shared/protocol.js';

function recorder(): { ctx: EngineContext; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return {
    events,
    ctx: { emit: (e) => events.push(e), verbose: false, prompter: { interactive: false, password: async () => '', confirm: async () => false, choose: async () => { throw new Error('no'); }, text: async () => '' } },
  };
}

describe('AgentEventTranslator', () => {
  it('gives agent steps a timeline phase and an op-scoped id', () => {
    const { ctx, events } = recorder();
    const prepare = new AgentEventTranslator(ctx, 'prepare');
    prepare.handle({ t: 'step', id: 'install', title: 'Installing dependencies (npm install)' });
    prepare.handle({ t: 'step-end', id: 'install', ok: true, ms: 1200 });
    const deploy = new AgentEventTranslator(ctx, 'deploy');
    deploy.handle({ t: 'step', id: 'install', title: 'Installing on iPhone 17' });
    expect(events[0]).toEqual({ type: 'step', id: 'prepare:install', title: 'Installing dependencies (npm install)', phase: 'deps' });
    expect(events[1]).toEqual({ type: 'step-end', id: 'prepare:install', status: 'ok', ms: 1200, detail: undefined });
    expect(events[2]).toMatchObject({ type: 'step', id: 'deploy:install', phase: 'install' });
  });

  it('maps every pipeline step to the right phase', () => {
    expect(phaseOf('prepare', 'cap')).toBe('cap');
    expect(phaseOf('build', 'build')).toBe('build');
    expect(phaseOf('build', 'web')).toBe('build');
    expect(phaseOf('deploy', 'boot')).toBe('boot');
    expect(phaseOf('archive', 'archive')).toBe('archive');
    expect(phaseOf('archive', 'export')).toBe('export');
    expect(phaseOf('install-tools', 'brew-axe')).toBe('other');
  });

  it('sends progress to the innermost open step and closes leftovers', () => {
    const { ctx, events } = recorder();
    const t = new AgentEventTranslator(ctx, 'deploy');
    t.handle({ t: 'step', id: 'boot', title: 'Booting' });
    t.handle({ t: 'progress', text: 'waiting for SpringBoard' });
    t.handle({ t: 'step', id: 'install', title: 'Installing' });
    t.handle({ t: 'progress', text: 'copying' });
    t.closeOpenSteps('cancelled');
    expect(events.filter((e) => e.type === 'step-progress')).toEqual([
      { type: 'step-progress', id: 'deploy:boot', text: 'waiting for SpringBoard', done: undefined },
      { type: 'step-progress', id: 'deploy:install', text: 'copying', done: undefined },
    ]);
    expect(events.filter((e) => e.type === 'step-end').map((e) => (e as { id: string }).id)).toEqual(['deploy:install', 'deploy:boot']);
  });

  it('maps Mac paths in diagnostics back to Windows paths', () => {
    const { ctx, events } = recorder();
    const mapper = new PathMapper('/Users/me/.capmac/projects/app-1/src', 'C:\\work\\app');
    const t = new AgentEventTranslator(ctx, 'build', mapper);
    t.handle({ t: 'diag', severity: 'error', message: "cannot find 'foo' in scope", file: '/Users/me/.capmac/projects/app-1/src/ios/App/App/AppDelegate.swift', line: 12, column: 9, context: ['    foo()', '    ^~~'], own: true });
    expect(events[0]).toEqual({
      type: 'diagnostic',
      diagnostic: { severity: 'error', message: "cannot find 'foo' in scope", file: 'C:\\work\\app\\ios\\App\\App\\AppDelegate.swift', line: 12, column: 9, context: ['    foo()', '    ^~~'], own: true },
    });
  });

  it('classifies app output', () => {
    const { ctx, events } = recorder();
    const t = new AgentEventTranslator(ctx, 'deploy');
    t.handle({ t: 'app', stream: 'stdout', text: '⚡️  [log] - Hello CapMac!' });
    t.handle({ t: 'app', stream: 'stderr', text: '⚡️  To Native ->  Device getInfo 123' });
    t.handle({ t: 'app', stream: 'stdout', text: '   ' });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'app-log', entry: { kind: 'console', level: 'log', text: 'Hello CapMac!', stream: 'stdout' } });
    expect(events[1]).toMatchObject({ type: 'app-log', entry: { kind: 'bridge', stream: 'stderr' } });
  });
});

describe('AppLogClassifier', () => {
  it('marks the lines after a console message as its continuation', () => {
    const c = new AppLogClassifier();
    const first = c.classify('⚡️  [error] - TypeError: boom');
    const second = c.classify('    at main.js:10:5');
    const native = c.classify('2026-10-12 14:34:31.216 App[1:2] native NSLog line');
    expect(first).toMatchObject({ kind: 'console', level: 'error', text: 'TypeError: boom' });
    expect(first?.continuation).toBeUndefined();
    expect(second).toMatchObject({ kind: 'console', level: 'error', text: '    at main.js:10:5', continuation: true });
    expect(native).toMatchObject({ kind: 'native' });
    expect(native?.continuation).toBeUndefined();
  });
});

describe('a run without building', () => {
  it('shows the web build as skipped, keeping the web files built before (like `cap run`)', async () => {
    const { ctx, events } = recorder();
    const project = { kind: 'capacitor', hasIos: true, iosDir: 'ios' } as unknown as ProjectInfo;
    // No Mac: the run stops at connecting, after the web step was decided.
    const link = { session: () => Promise.reject(new Error('no Mac here')) } as unknown as MacLink;
    await expect(runApp(project, link, { webBuild: false }, ctx, new AbortController().signal)).rejects.toThrow('no Mac here');
    expect(events).toEqual([{ type: 'phase-skipped', phase: 'web', reason: 'using the web files already built' }]);
  });
});

describe('toErrorInfo', () => {
  it('keeps hints and tool output of CapMac errors', () => {
    expect(toErrorInfo(new UserError('No Mac is paired yet.', 'Run `capmac pair`.'))).toMatchObject({ message: 'No Mac is paired yet.', hint: 'Run `capmac pair`.', expected: true });
    expect(toErrorInfo(new AgentCallError({ message: 'Build failed', code: 'BUILD_FAILED', tail: ['error: x'] }))).toMatchObject({ code: 'BUILD_FAILED', details: ['error: x'], expected: true });
    expect(toErrorInfo(new SshError('The connection to the Mac was closed.'))).toMatchObject({ expected: true });
  });

  it('recognises cancellation and unexpected errors', () => {
    expect(toErrorInfo(new CancelledError())).toMatchObject({ cancelled: true, expected: true });
    const info = toErrorInfo(new TypeError('x is undefined'));
    expect(info.expected).toBe(false);
    expect(info.stack).toContain('TypeError');
  });
});

describe('steps', () => {
  it('reports start, progress and the outcome', async () => {
    const { ctx, events } = recorder();
    await withStep(ctx, 'Syncing', 'sync', async (s) => {
      s.update('3 files', 0.5);
      return 3;
    }, (n) => `${n} files`);
    await withStep(ctx, 'Failing', 'other', async () => {
      throw new CancelledError();
    }).catch(() => undefined);
    const types = events.map((e) => (e.type === 'step-end' ? `end:${e.status}` : e.type));
    expect(types).toEqual(['step', 'step-progress', 'end:ok', 'step', 'end:cancelled']);
    expect(events[2]).toMatchObject({ detail: '3 files' });
    const s = startStep(ctx, 'Twice', 'other');
    s.succeed();
    s.fail();
    expect(events.filter((e) => e.type === 'step-end')).toHaveLength(3);
  });
});

describe('doctor checks', () => {
  const probe: ProbeResult = {
    agentVersion: '0.1.0', home: '/Users/ik', user: 'ik', hostname: 'IKs-M1', computerName: "IK's M1", macos: '26.6.1', arch: 'arm64',
    node: { path: '/usr/local/bin/node', version: 'v24.21.0' }, npm: '11.19.0',
    xcode: { developerDir: '/Applications/Xcode.app', version: '26.6', build: '17F113', ready: true },
    tools: { pod: null, axe: null, brew: { path: '/opt/homebrew/bin/brew', version: '4' } },
    simulators: { devices: 28, runtimes: ['iOS 26.5'] }, freeDiskGb: 27.1, keychainLocked: true, signingIdentities: [], consoleUser: 'ik',
  };

  it('offers one-click fixes where CapMac can fix things', () => {
    const checks = macChecks(probe);
    expect(checks.find((c) => c.id === 'axe')?.action?.id).toBe('install-axe');
    expect(checks.find((c) => c.id === 'keychain')?.action?.id).toBe('unlock-keychain');
    expect(checks.find((c) => c.id === 'xcode')?.level).toBe('ok');
    expect(checks.every((c) => c.group === 'mac')).toBe(true);
  });

  it('cannot install with Homebrew when it is missing', () => {
    const checks = macChecks({ ...probe, tools: { pod: null, axe: null, brew: null } });
    expect(checks.find((c) => c.id === 'axe')?.action).toBeUndefined();
    expect(localChecks(null, null).find((c) => c.id === 'paired')?.level).toBe('fail');
  });
});
