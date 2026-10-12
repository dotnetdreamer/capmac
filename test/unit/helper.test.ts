import { describe, expect, it } from 'vitest';
import { compilerSummary, helperHash, legacyInputWorks, plistString } from '../../packages/core/src/agent/helper/build.js';
import { HelperInput, immediateLines, keystrokeLines, TYPE_LIMIT } from '../../packages/core/src/agent/helper/input.js';
import { StallWatch } from '../../packages/core/src/agent/helper/stall.js';
import { VideoWindow } from '../../packages/core/src/agent/helper/window.js';
import { macChecks } from '../../packages/core/src/engine/doctor.js';
import { ClockSync, fallbackFor } from '../../packages/core/src/engine/screen.js';
import { keystrokeForChar, keystrokeForKey, keystrokesFor, MOD_GUI, MOD_SHIFT, usageForCode } from '../../packages/core/src/shared/hid.js';
import type { ProbeResult, StreamHelperState } from '../../packages/core/src/shared/protocol.js';

const key = (k: Partial<{ key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) => ({ key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...k });

describe('keyboard mapping (HID usages)', () => {
  it('types printable ASCII with the US key and Shift', () => {
    expect(keystrokeForChar('a')).toEqual({ usage: 0x04, modifiers: 0 });
    expect(keystrokeForChar('Z')).toEqual({ usage: 0x1d, modifiers: MOD_SHIFT });
    expect(keystrokeForChar('1')).toEqual({ usage: 0x1e, modifiers: 0 });
    expect(keystrokeForChar('!')).toEqual({ usage: 0x1e, modifiers: MOD_SHIFT });
    expect(keystrokeForChar('?')).toEqual({ usage: 0x38, modifiers: MOD_SHIFT });
    expect(keystrokeForChar(' ')).toEqual({ usage: 0x2c, modifiers: 0 });
    expect(keystrokesFor('Hi!\r\n')).toEqual([
      { usage: 0x0b, modifiers: MOD_SHIFT },
      { usage: 0x0c, modifiers: 0 },
      { usage: 0x1e, modifiers: MOD_SHIFT },
      { usage: 0x28, modifiers: 0 },
    ]);
  });

  it('sends text with characters no US key types through the pasteboard', () => {
    expect(keystrokesFor('café')).toBeNull();
    expect(keystrokesFor('ok 👍')).toBeNull();
    expect(keystrokeForChar('é')).toBeNull();
  });

  it('maps keys that type nothing by their position', () => {
    expect(usageForCode('Enter')).toBe(0x28);
    expect(usageForCode('Backspace')).toBe(0x2a);
    expect(usageForCode('ArrowLeft')).toBe(0x50);
    expect(usageForCode('F12')).toBe(0x45);
    expect(usageForCode('KeyA')).toBeNull();
  });

  it('turns key presses into keystrokes, and Windows shortcuts into iOS ones', () => {
    expect(keystrokeForKey(key({ key: 'a', code: 'KeyA' }))).toEqual({ usage: 0x04, modifiers: 0 });
    // Layout-aware: a German keyboard's Z key reports code KeyY and key "z".
    expect(keystrokeForKey(key({ key: 'z', code: 'KeyY' }))).toEqual({ usage: 0x1d, modifiers: 0 });
    expect(keystrokeForKey(key({ key: 'Tab', code: 'Tab', shiftKey: true }))).toEqual({ usage: 0x2b, modifiers: MOD_SHIFT });
    expect(keystrokeForKey(key({ key: 'c', code: 'KeyC', ctrlKey: true }))).toEqual({ usage: 0x06, modifiers: MOD_GUI });
    expect(keystrokeForKey(key({ key: 'y', code: 'KeyY', ctrlKey: true }))).toEqual({ usage: 0x1d, modifiers: MOD_GUI | MOD_SHIFT });
    expect(keystrokeForKey(key({ key: 'p', code: 'KeyP', ctrlKey: true }))).toBeNull();
    expect(keystrokeForKey(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
    expect(keystrokeForKey(key({ key: 'Dead', code: 'Quote' }))).toBeNull();
    // AltGr (Ctrl+Alt) types characters on many layouts: "@" on a German keyboard.
    expect(keystrokeForKey(key({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }))).toEqual({ usage: 0x1f, modifiers: MOD_SHIFT });
  });
});

describe('helper input commands', () => {
  it('streams touches, scrolling, keys and buttons as single commands', () => {
    expect(immediateLines({ kind: 'touch', phase: 'down', x: 0.5, y: 0.123456789 })).toEqual(['t d 0.5 0.12346']);
    expect(immediateLines({ kind: 'touch', phase: 'move', x: 1.4, y: -1 })).toEqual(['t m 1 0']);
    expect(immediateLines({ kind: 'touch', phase: 'cancel', x: 0, y: 0 })).toEqual(['c']);
    expect(immediateLines({ kind: 'touch2', phase: 'up', x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 })).toEqual(['T u 0.25 0.5 0.75 0.5']);
    expect(immediateLines({ kind: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 141.4213 })).toEqual(['w 0.5 0.5 0 141.42']);
    expect(immediateLines({ kind: 'button', button: 'apple-pay', phase: 'down' })).toEqual(['b applepay d']);
    expect(immediateLines({ kind: 'key', key: 'return' })).toEqual(['K 40 d', 'K 40 u']);
    expect(immediateLines({ kind: 'key', key: 'nonsense' })).toEqual([]);
    expect(immediateLines({ kind: 'keypress', usage: 0x19, modifiers: MOD_GUI | MOD_SHIFT })).toEqual(['K 227 d', 'K 225 d', 'K 25 d', 'K 25 u', 'K 225 u', 'K 227 u']);
    expect(immediateLines({ kind: 'keypress', usage: 70_000 })).toEqual([]);
    // Gestures need timing.
    expect(immediateLines({ kind: 'tap', x: 0.5, y: 0.5 })).toBeNull();
    expect(immediateLines({ kind: 'button', button: 'home' })).toBeNull();
  });

  async function run(events: Parameters<HelperInput['push']>[0][]) {
    const lines: string[] = [];
    const pasted: string[] = [];
    const input = new HelperInput({ send: (l) => lines.push(l), sleep: async () => undefined, setPasteboard: async (t) => void pasted.push(t) });
    for (const e of events) await input.push(e);
    return { lines, pasted };
  }

  it('turns whole gestures into finger sequences', async () => {
    const tap = await run([{ kind: 'tap', x: 0.5, y: 0.25 }]);
    expect(tap.lines).toEqual(['t d 0.5 0.25', 't u 0.5 0.25']);
    const swipe = await run([{ kind: 'swipe', x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, durationMs: 64 }]);
    expect(swipe.lines[0]).toBe('t d 0.5 0.8');
    expect(swipe.lines.at(-1)).toBe('t u 0.5 0.2');
    expect(swipe.lines.slice(1, -1).every((l) => l.startsWith('t m 0.5 '))).toBe(true);
    expect(swipe.lines.at(-2)).toBe('t m 0.5 0.2');
    const press = await run([{ kind: 'button', button: 'home' }]);
    expect(press.lines).toEqual(['b home d', 'b home u']);
  });

  it('types ASCII key by key and pastes everything else', async () => {
    const typed = await run([{ kind: 'text', text: 'Hi' }]);
    expect(typed.lines).toEqual(['K 225 d', 'K 11 d', 'K 11 u', 'K 225 u', 'K 12 d', 'K 12 u']);
    expect(typed.pasted).toEqual([]);
    const accented = await run([{ kind: 'text', text: 'Ünïcode ✓' }]);
    expect(accented.pasted).toEqual(['Ünïcode ✓']);
    expect(accented.lines).toEqual(keystrokeLines({ usage: 0x19, modifiers: MOD_GUI }));
    const pasted = await run([{ kind: 'text', text: 'plain', via: 'paste' }]);
    expect(pasted.pasted).toEqual(['plain']);
    const long = await run([{ kind: 'text', text: 'a'.repeat(TYPE_LIMIT + 1) }]);
    expect(long.pasted).toHaveLength(1);
  });

  it('keeps events in order across gestures', async () => {
    const r = await run([
      { kind: 'tap', x: 0.1, y: 0.1 },
      { kind: 'touch', phase: 'down', x: 0.2, y: 0.2 },
      { kind: 'touch', phase: 'up', x: 0.2, y: 0.2 },
    ]);
    expect(r.lines).toEqual(['t d 0.1 0.1', 't u 0.1 0.1', 't d 0.2 0.2', 't u 0.2 0.2']);
  });
});

describe('stall watch', () => {
  function rig() {
    let now = 0;
    const shots: Array<string | null> = [];
    let probes = 0;
    const watch = new StallWatch(async () => {
      probes += 1;
      return shots.shift() ?? null;
    }, () => now);
    return { watch, shots, advance: (ms: number) => (now += ms), probes: () => probes };
  }

  it('says nothing while frames flow, and does not probe', async () => {
    const r = rig();
    for (let i = 0; i < 10; i++) {
      r.advance(1000);
      r.watch.activity();
      expect(await r.watch.check()).toBe(false);
    }
    expect(r.probes()).toBe(0);
  });

  it('reports a stall when the screen changed while the stream was quiet', async () => {
    const r = rig();
    r.shots.push('A', 'B');
    r.advance(3000);
    expect(await r.watch.check()).toBe(false); // first probe: A
    r.advance(3000);
    expect(await r.watch.check()).toBe(true); // B: the screen moved, the helper saw nothing
  });

  it('accepts an idle screen and backs off', async () => {
    const r = rig();
    r.shots.push('A', 'A', 'A');
    r.advance(3000);
    expect(await r.watch.check()).toBe(false);
    r.advance(3000);
    expect(await r.watch.check()).toBe(false);
    r.advance(3000);
    expect(await r.watch.check()).toBe(false); // the interval doubled: no probe yet
    expect(r.probes()).toBe(2);
    r.advance(3000);
    expect(await r.watch.check()).toBe(false);
    expect(r.probes()).toBe(3);
  });

  it('forgets earlier probes once frames arrive again', async () => {
    const r = rig();
    r.shots.push('A', 'B', 'C');
    r.advance(3000);
    await r.watch.check(); // A
    r.watch.activity(); // the stream moved
    r.advance(3000);
    expect(await r.watch.check()).toBe(false); // B is a fresh start, not compared with A
    r.advance(3000);
    expect(await r.watch.check()).toBe(true); // C after B
  });

  it('draws no conclusion from a failed probe', async () => {
    const r = rig();
    r.shots.push('A', null as unknown as string, 'A');
    r.advance(3000);
    await r.watch.check();
    r.advance(3000);
    expect(await r.watch.check()).toBe(false);
  });
});

describe('video window (latency on a slow network)', () => {
  it('sends everything while the network keeps up', () => {
    let now = 0;
    const w = new VideoWindow(() => now);
    for (let seq = 1; seq <= 100; seq++) {
      expect(w.offer(seq, seq === 1, 0)).toBe(true);
      now += 16;
      w.ack(seq);
    }
    expect(w.dropped).toBe(0);
  });

  it('drops deltas when frames stop being acknowledged, then resumes at a keyframe', () => {
    let now = 0;
    const w = new VideoWindow(() => now, { maxLagMs: 350, resumeLagMs: 120 });
    let seq = 0;
    expect(w.offer(++seq, true, 0)).toBe(true);
    // No acks for a while: lag grows past 350 ms.
    for (let i = 0; i < 30; i++) {
      now += 16;
      w.offer(++seq, false, 0);
    }
    expect(w.congested).toBe(true);
    expect(w.dropped).toBeGreaterThan(0);
    // Still behind: even a keyframe waits.
    expect(w.offer(++seq, true, 0)).toBe(false);
    expect(w.wantsKeyframe(0)).toBe(false);
    // The engine catches up.
    w.ack(seq);
    expect(w.wantsKeyframe(0)).toBe(true);
    expect(w.offer(++seq, false, 0)).toBe(false); // deltas wait for the keyframe
    expect(w.offer(++seq, true, 0)).toBe(true);
    expect(w.congested).toBe(false);
    expect(w.offer(++seq, false, 0)).toBe(true);
  });

  it('counts the agent’s own unsent bytes as congestion', () => {
    let now = 0;
    const w = new VideoWindow(() => now, { maxBacklogBytes: 1000 });
    expect(w.offer(1, true, 5000)).toBe(true); // keyframes are never dropped while flowing
    expect(w.offer(2, false, 5000)).toBe(false);
    expect(w.wantsKeyframe(5000)).toBe(false);
    now = 500;
    expect(w.wantsKeyframe(100)).toBe(false); // frame 1 is still unacknowledged after 500 ms
    w.ack(1);
    expect(w.wantsKeyframe(100)).toBe(true);
  });
});

describe('fallback decisions', () => {
  const err = (code: string, message = 'm', extra: object = {}) => Object.assign(new Error(message), { code, expected: true, ...extra });

  it('falls back with the reason for every way the smooth stream can fail', () => {
    expect(fallbackFor(err('HELPER_BUILD_FAILED', 'does not compile', { tail: ['simstream.m:1: error: x'] }))).toMatchObject({ code: 'helper-build', message: 'does not compile', details: ['simstream.m:1: error: x'] });
    expect(fallbackFor(err('HELPER_START_FAILED'))).toMatchObject({ code: 'helper-start', restartSimulator: true });
    expect(fallbackFor(err('HELPER_EXITED'))).toMatchObject({ code: 'helper-exit', restartSimulator: true });
    expect(fallbackFor(err('STREAM_STALLED', 'quiet', { hint: 'restart' }))).toMatchObject({ code: 'stalled', hint: 'restart', restartSimulator: true });
    expect(fallbackFor(err('STREAM_UNSUPPORTED'))).toMatchObject({ code: 'unsupported' });
    expect(fallbackFor(err('BAD_REQUEST', 'Unknown operation "stream"'))).toMatchObject({ code: 'unsupported' });
    expect(fallbackFor(new Error('something else'))).toMatchObject({ code: 'error', message: 'something else' });
  });

  it('does not fall back when there is nothing to show or the stream was stopped', () => {
    expect(fallbackFor(err('TARGET_NOT_FOUND'))).toBeNull();
    expect(fallbackFor(err('CANCELLED'))).toBeNull();
    expect(fallbackFor(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }))).toBeNull();
  });
});

describe('clock sync', () => {
  it('takes the offset from the ping with the shortest round trip', () => {
    const clock = new ClockSync();
    expect(clock.offsetUs).toBeNull();
    // The Mac is 5 s ahead; one-way delays vary.
    clock.add(1_000_000, 6_000_000 + 20_000, 1_000_000 + 60_000); // rtt 60 ms, asymmetric
    clock.add(2_000_000, 7_000_000 + 4_000, 2_000_000 + 8_000); // rtt 8 ms
    clock.add(3_000_000, 8_000_000 + 30_000, 3_000_000 + 45_000);
    expect(clock.rttUs).toBe(8_000);
    expect(clock.offsetUs).toBe(5_000_000);
    clock.add(4_000_000, 1, 3_000_000); // negative round trip: ignored
    expect(clock.rttUs).toBe(8_000);
  });
});

describe('helper builds', () => {
  const xcode = { developerDir: '/Applications/Xcode.app/Contents/Developer', version: '26.6', build: '17F113' };

  it('rebuilds for a new source, a new Xcode or another architecture', () => {
    const base = helperHash('source', xcode, 'arm64');
    expect(helperHash('source', xcode, 'arm64')).toBe(base);
    expect(helperHash('source 2', xcode, 'arm64')).not.toBe(base);
    expect(helperHash('source', { ...xcode, build: '17F114' }, 'arm64')).not.toBe(base);
    expect(helperHash('source', { ...xcode, developerDir: '/Applications/Xcode-beta.app/Contents/Developer' }, 'arm64')).not.toBe(base);
    expect(helperHash('source', xcode, 'x64')).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reads Xcode version.plist values', () => {
    const plist = '<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>26.6</string>\n\t<key>ProductBuildVersion</key>\n\t<string>17F113</string>\n</dict>';
    expect(plistString(plist, 'CFBundleShortVersionString')).toBe('26.6');
    expect(plistString(plist, 'ProductBuildVersion')).toBe('17F113');
    expect(plistString(plist, 'Missing')).toBe('');
  });

  it('keeps the compiler errors from a failed build', () => {
    const log = 'simstream.m:10:5: warning: unused\nsimstream.m:42:1: error: use of undeclared identifier\n1 error generated.';
    expect(compilerSummary(log)).toEqual(['simstream.m:42:1: error: use of undeclared identifier', '1 error generated.']);
    expect(compilerSummary('ld: library not found')).toEqual(['ld: library not found']);
  });

  it('knows which CoreSimulator still takes legacy input', () => {
    expect(legacyInputWorks('1051.55')).toBe(true);
    expect(legacyInputWorks('1155.3')).toBe(true);
    expect(legacyInputWorks('1155.4')).toBe(false);
    expect(legacyInputWorks('1160.1')).toBe(false);
    expect(legacyInputWorks('')).toBe(true);
  });
});

describe('health check', () => {
  const probe = (streamHelper: StreamHelperState | undefined, axe = false): ProbeResult => ({
    agentVersion: '0.1.0',
    home: '/Users/ik',
    user: 'ik',
    hostname: 'IKs-M1',
    computerName: "IK's M1",
    macos: '26.6.1',
    arch: 'arm64',
    node: { path: '/usr/local/bin/node', version: 'v24.11.1' },
    npm: '11.6.0',
    xcode: { developerDir: '/Applications/Xcode.app/Contents/Developer', version: '26.6', build: '17F113', ready: true },
    tools: { axe: axe ? { path: '/opt/homebrew/bin/axe', version: '1.0' } : null, brew: { path: '/opt/homebrew/bin/brew', version: '4' } },
    simulators: { devices: 28, runtimes: ['iOS 26.5'] },
    freeDiskGb: 100,
    keychainLocked: false,
    signingIdentities: [],
    consoleUser: 'ik',
    streamHelper,
  });
  const check = (p: ProbeResult, id: string) => macChecks(p).find((c) => c.id === id);

  it('reports the smooth stream helper', () => {
    expect(check(probe({ state: 'ready', xcode: '26.6', input: true }), 'stream')).toMatchObject({ level: 'ok', detail: 'helper built for Xcode 26.6' });
    expect(check(probe({ state: 'not-built', xcode: '26.6', input: true }), 'stream')).toMatchObject({ level: 'info', action: { id: 'build-stream-helper' } });
    expect(check(probe({ state: 'failed', xcode: '26.6', detail: 'simstream.m:1: error: boom' }), 'stream')).toMatchObject({ level: 'warn', action: { id: 'build-stream-helper', label: 'Try again' } });
    expect(check(probe(undefined), 'stream')).toBeUndefined();
  });

  it('makes AXe optional when the helper handles input', () => {
    const axe = check(probe({ state: 'ready', xcode: '26.6', input: true }), 'axe');
    expect(axe).toMatchObject({ level: 'info' });
    expect(axe?.action).toBeUndefined();
    // Xcode 27 simulators ignore the helper's input: AXe is the way to touch the screen.
    expect(check(probe({ state: 'ready', xcode: '27.0', input: false }), 'axe')).toMatchObject({ action: { id: 'install-axe' } });
    expect(check(probe({ state: 'failed', xcode: '26.6' }), 'axe')).toMatchObject({ action: { id: 'install-axe' } });
    expect(check(probe(undefined), 'axe')).toMatchObject({ action: { id: 'install-axe' } });
  });
});
