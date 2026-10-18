import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneMirror, type MirrorDeps, type MirrorTarget, type MirrorWorker, type WorkerMessage } from '../src/renderer/lib/phone-mirror';

class FakeWorker implements MirrorWorker {
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** The worker says something (its own news, or the engine's passed on). */
  say(message: WorkerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
  types(): unknown[] {
    return this.posted.map((m) => m.type);
  }
}

const ludo: MirrorTarget = { udid: '00008120-00012840269B401E', projectPath: 'C:\\apps\\ludo' };
const notes: MirrorTarget = { udid: '00008120-00012840269B401E', projectPath: 'C:\\apps\\notes' };
const canvas = (name: string) => ({ name }) as unknown as OffscreenCanvas;

function setup() {
  const workers: FakeWorker[] = [];
  const opens: Array<{ target: MirrorTarget; resolve: () => void; reject: (error: Error) => void; port: { closed: boolean } }> = [];
  const stopped: string[] = [];
  const deps: MirrorDeps = {
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    open: (target) =>
      new Promise((resolve, reject) => {
        const port = { closed: false, close() { this.closed = true; } };
        const streamId = `scr-${opens.length + 1}`;
        opens.push({ target, port, resolve: () => resolve({ streamId, port: port as unknown as MessagePort }), reject });
      }),
    stop: async (streamId) => {
      stopped.push(streamId);
    },
    errorInfo: (error) => ({ message: (error as Error).message, expected: true }),
  };
  return { mirror: new PhoneMirror(deps, 60_000), workers, opens, stopped };
}

/** A pane: what it was told, in order. */
function pane() {
  const got: WorkerMessage[] = [];
  return { got, onMessage: (message: WorkerMessage) => got.push(message), types: () => got.map((m) => m.type) };
}

/** Lets promises that already settled run their callbacks (timers are fake here). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A stream that mirrors: what the worker and the engine said so far. */
function mirroring(worker: FakeWorker): void {
  worker.say({ type: 'state', state: 'connecting' });
  worker.say({ type: 'codec', codec: 'h264', fallback: null });
  worker.say({ type: 'info', info: { input: false } });
  worker.say({ type: 'mirror-client', name: 'IK 14 Pro Max', model: 'iPhone15,3' });
  worker.say({ type: 'device-wait', wait: null });
  worker.say({ type: 'state', state: 'streaming' });
  worker.say({ type: 'frame-size', width: 498, height: 1080 });
  worker.say({ type: 'first-frame' });
  worker.say({ type: 'stats', fps: 41, kbps: 980 });
}

describe('the iPhone mirroring to this PC, in Studio', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('keeps one decoder for every pane: a pane that opens again gets a fresh canvas and the picture as it is', async () => {
    const { mirror, workers, opens, stopped } = setup();
    const first = pane();
    const a = mirror.attach(ludo, canvas('a'), first.onMessage);
    expect(workers).toHaveLength(1);
    expect(opens.map((o) => o.target)).toEqual([ludo]);
    opens[0]!.resolve();
    await settle();
    const worker = workers[0]!;
    expect(worker.types()).toContain('port');
    // Never skip frames to wait for a keyframe: the iPhone sends one only when mirroring starts.
    expect(worker.posted[0]).toEqual({ type: 'keyframes', onRequest: false });
    expect(worker.posted[1]).toEqual({ type: 'canvas', canvas: canvas('a') });
    mirroring(worker);
    expect(first.types()).toContain('first-frame');

    // The pane closes (another project or target): the decoder goes on without a canvas.
    a.detach();
    expect(worker.posted.at(-1)).toEqual({ type: 'canvas', canvas: null });
    worker.say({ type: 'stats', fps: 50, kbps: 1200 });
    expect(first.got.at(-1)).toEqual({ type: 'stats', fps: 41, kbps: 980 });

    // It opens again: the same worker and stream, a new canvas, and the stream as it is now.
    const again = pane();
    const b = mirror.attach(ludo, canvas('b'), again.onMessage);
    expect(workers).toHaveLength(1);
    expect(opens).toHaveLength(1);
    expect(worker.terminated).toBe(false);
    expect(stopped).toEqual([]);
    expect(worker.posted.at(-1)).toEqual({ type: 'canvas', canvas: canvas('b') });
    expect(again.types()).toEqual(['state', 'codec', 'info', 'mirror-client', 'device-wait', 'frame-size', 'first-frame', 'stats']);
    expect(again.got[0]).toEqual({ type: 'state', state: 'streaming' });
    expect(again.got.at(-1)).toEqual({ type: 'stats', fps: 50, kbps: 1200 });
    expect(b.streamId).toBe('scr-1');

    // Input goes to the worker from the pane shown now only.
    a.post({ type: 'input', event: { kind: 'tap', x: 0.5, y: 0.5 } });
    b.post({ type: 'input', event: { kind: 'tap', x: 0.2, y: 0.3 } });
    expect(worker.posted.filter((m) => m.type === 'input')).toEqual([{ type: 'input', event: { kind: 'tap', x: 0.2, y: 0.3 } }]);
    expect(a.streamId).toBeNull();
  });

  it('sends the stream’s news to the pane shown now, and a broken picture as “start mirroring again”', async () => {
    const { mirror, workers, opens } = setup();
    const first = pane();
    const a = mirror.attach(ludo, canvas('a'), first.onMessage);
    opens[0]!.resolve();
    await settle();
    // A newer pane takes over: the one before gets nothing more.
    const second = pane();
    mirror.attach(ludo, canvas('b'), second.onMessage);
    workers[0]!.say({ type: 'decoder-error', message: 'Decoding error.' });
    expect(first.got).toEqual([]);
    expect(second.got).toEqual([{ type: 'device-wait', wait: 'restart-mirroring' }]);
    // A detach from the pane that lost its place changes nothing.
    a.detach();
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'canvas', canvas: canvas('b') });
    const third = pane();
    mirror.attach(ludo, canvas('c'), third.onMessage);
    expect(third.got).toEqual([{ type: 'device-wait', wait: 'restart-mirroring' }]);
  });

  it('lets the stream go a while after the last pane closed, and not when a pane comes back before', async () => {
    const { mirror, workers, opens, stopped } = setup();
    const a = mirror.attach(ludo, canvas('a'), pane().onMessage);
    opens[0]!.resolve();
    await settle();
    a.detach();
    vi.advanceTimersByTime(59_000);
    const b = mirror.attach(ludo, canvas('b'), pane().onMessage);
    vi.advanceTimersByTime(120_000);
    expect(stopped).toEqual([]);
    b.detach();
    vi.advanceTimersByTime(60_000);
    // Closed for good in the engine first (the receiver can stop), then the worker.
    expect(stopped).toEqual(['scr-1']);
    expect(workers[0]!.terminated).toBe(false);
    await settle();
    expect(workers[0]!.terminated).toBe(true);
    // The next pane starts it again.
    mirror.attach(notes, canvas('c'), pane().onMessage);
    expect(workers).toHaveLength(2);
    expect(opens.map((o) => o.target)).toEqual([ludo, notes]);
  });

  it('starts again after the stream ended: the receiver stopped, the open failed, or the engine restarted', async () => {
    const { mirror, workers, opens, stopped } = setup();
    const shown = pane();
    const a = mirror.attach(ludo, canvas('a'), shown.onMessage);
    opens[0]!.resolve();
    await settle();
    workers[0]!.say({ type: 'state', state: 'ended', error: { message: 'The screen receiver stopped.', expected: true } });
    expect(shown.got.at(-1)?.state).toBe('ended');
    // Try again (or the pane closes): the dead stream goes at once, and a new one starts.
    a.detach();
    expect(stopped).toEqual(['scr-1']);
    const failing = pane();
    const b = mirror.attach(ludo, canvas('b'), failing.onMessage);
    expect(workers).toHaveLength(2);
    opens[1]!.reject(new Error('The screen-mirroring receiver is not set up on this PC yet.'));
    await settle();
    expect(failing.got.at(-1)).toEqual({ type: 'state', state: 'ended', error: { message: 'The screen-mirroring receiver is not set up on this PC yet.', expected: true } });
    b.detach();
    await settle();
    expect(workers[1]!.terminated).toBe(true);

    // The engine restarted: the pane says so, and Try again starts a new stream.
    const restarted = pane();
    const c = mirror.attach(ludo, canvas('c'), restarted.onMessage);
    opens[2]!.resolve();
    await settle();
    mirror.lost({ message: 'CapMac stopped unexpectedly', expected: true });
    expect(restarted.got.at(-1)).toEqual({ type: 'state', state: 'ended', error: { message: 'CapMac stopped unexpectedly', expected: true } });
    c.detach();
    expect(stopped).toEqual(['scr-1', 'scr-3']);

    // The receiver stopped while no pane was open: the stream goes at once, not after the wait.
    const d = mirror.attach(ludo, canvas('d'), pane().onMessage);
    expect(workers).toHaveLength(4);
    opens[3]!.resolve();
    await settle();
    d.detach();
    workers[3]!.say({ type: 'state', state: 'ended' });
    expect(stopped).toEqual(['scr-1', 'scr-3', 'scr-4']);
  });

  it('keeps a stream that said it ended and then went on', async () => {
    const { mirror, workers, opens, stopped } = setup();
    const a = mirror.attach(ludo, canvas('a'), pane().onMessage);
    opens[0]!.resolve();
    await settle();
    workers[0]!.say({ type: 'state', state: 'ended' });
    workers[0]!.say({ type: 'state', state: 'streaming' });
    a.detach();
    const again = pane();
    mirror.attach(ludo, canvas('b'), again.onMessage);
    expect(workers).toHaveLength(1);
    expect(stopped).toEqual([]);
    expect(again.got[0]).toEqual({ type: 'state', state: 'streaming' });
  });

  it('moves touch to the pane’s iPhone and app, with no new stream', async () => {
    const { mirror, workers, opens } = setup();
    const a = mirror.attach(ludo, canvas('a'), pane().onMessage);
    // Another project's pane opens before the stream is up: touch follows once the port is there.
    a.detach();
    const b = mirror.attach(notes, canvas('b'), pane().onMessage);
    opens[0]!.resolve();
    await settle();
    const worker = workers[0]!;
    expect(worker.types().slice(-2)).toEqual(['port', 'phone-target']);
    expect(worker.posted.at(-1)).toEqual({ type: 'phone-target', ...notes });
    // Back to the first project: one more retarget, still one stream.
    b.detach();
    mirror.attach(ludo, canvas('c'), pane().onMessage).refreshTouch();
    expect(worker.posted.filter((m) => m.type === 'phone-target')).toEqual([{ type: 'phone-target', ...notes }, { type: 'phone-target', ...ludo }, { type: 'phone-target', ...ludo }]);
    expect(opens).toHaveLength(1);
  });

  it('closes a stream that opened after it was let go', async () => {
    const { mirror, opens, stopped } = setup();
    const a = mirror.attach(ludo, canvas('a'), pane().onMessage);
    a.detach();
    vi.advanceTimersByTime(60_000);
    opens[0]!.resolve();
    await settle();
    expect(opens[0]!.port.closed).toBe(true);
    expect(stopped).toEqual(['scr-1']);
  });
});
