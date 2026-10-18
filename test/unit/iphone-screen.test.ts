import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserError } from '../../packages/core/src/engine/errors.js';
import { PhoneScreen } from '../../packages/core/src/engine/iphone/screen.js';
import { WdaStartError } from '../../packages/core/src/engine/iphone/wda.js';
import type { VideoPacket } from '../../packages/core/src/engine/screen.js';
import { STREAM_CONFIG, STREAM_FRAME } from '../../packages/core/src/shared/stream.js';

/** WebDriverAgent's screen stream, while the screen watches it. */
interface FakeWatch {
  onJpeg(jpeg: Buffer): void;
  onEnd(reason: string): void;
  stopped: boolean;
}

interface FakeHelper {
  udid: string;
  bundleId: string;
  ready: boolean;
  stopped: boolean;
  options: { onEnded?(reason: string): void; onLocked?(): void; signal?: AbortSignal };
  watches: FakeWatch[];
  finish(): void;
  fail(error: unknown): void;
}

interface FakeListener {
  onState(state: string, client: unknown): void;
  onVideo(packet: VideoPacket): void;
}

// The receiver and WebDriverAgent, as the screen sees them: subscriptions, and helpers that start when told.
const fakes = vi.hoisted(() => ({
  helpers: [] as FakeHelper[],
  receiver: { subscribes: 0, unsubscribed: [] as Array<{ now?: boolean } | undefined>, listener: null as null | FakeListener },
}));

vi.mock('../../packages/core/src/engine/iphone/receiver.js', () => ({
  mirrorReceiver: () => ({
    // Like the real one: a new listener hears the state now (stopped, until start() starts it).
    subscribe: (listener: FakeListener) => {
      fakes.receiver.subscribes += 1;
      fakes.receiver.listener = listener;
      listener.onState('stopped', null);
      return (options?: { now?: boolean }) => fakes.receiver.unsubscribed.push(options);
    },
    start: async () => undefined,
    lastLines: [],
  }),
}));

vi.mock('../../packages/core/src/engine/iphone/wda.js', async () => {
  const { UserError: Base } = await import('../../packages/core/src/engine/errors.js');
  class WdaStartError extends Base {
    constructor(message: string, hint: string, details: string[], readonly retry: boolean) {
      super(message, hint, details);
    }
  }
  class WdaControl {
    private readonly helper: FakeHelper;
    constructor(device: { udid: string }, bundleId: string, options: FakeHelper['options']) {
      this.helper = { udid: device.udid, bundleId, ready: false, stopped: false, options, watches: [], finish: () => undefined, fail: () => undefined };
      fakes.helpers.push(this.helper);
    }
    get ready(): boolean {
      return this.helper.ready;
    }
    get canWatchScreen(): boolean {
      return this.helper.ready;
    }
    get screenSize(): { width: number; height: number } | null {
      return this.helper.ready ? { width: 375, height: 667 } : null;
    }
    watchScreen(onJpeg: FakeWatch['onJpeg'], onEnd: FakeWatch['onEnd']): () => void {
      const watch: FakeWatch = { onJpeg, onEnd, stopped: false };
      this.helper.watches.push(watch);
      return () => void (watch.stopped = true);
    }
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        this.helper.finish = () => {
          this.helper.ready = true;
          resolve();
        };
        this.helper.fail = reject;
      });
    }
    async stop(): Promise<void> {
      this.helper.stopped = true;
    }
  }
  return { WdaControl, WdaStartError };
});

const iphone = (udid: string) => ({ udid, name: 'iPhone', productVersion: undefined, connection: 'usb' as const });
const proMax = { udid: '00008120-00012840269B401E', name: 'IK 14 Pro Max', productType: 'iPhone15,3', connection: 'network' as const };
const proMaxMirroring = { name: 'IK 14 Pro Max', model: 'iPhone15,3', deviceId: 'CA:E5:70:45:CA:32' };
const helper = { bundleId: 'dev.capmac.WebDriverAgentRunner.9XCZL2PPRH' };
const iphone8 = { ...iphone('808ccae4399545073522715663f015d9727366c4'), productType: 'iPhone10,4' };
const iphone8Mirroring = { name: 'iPhone', model: 'iPhone10,4', deviceId: '9A:1B:2C:3D:4E:5F' };
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A mirrored config (picture size, then the decoder's record) or frame, as the receiver passes them on. */
const mirrored = (type: number, key = false): VideoPacket => {
  const data = Buffer.alloc(16 + 15);
  if (type === STREAM_CONFIG) {
    data.writeUInt16BE(498, 16);
    data.writeUInt16BE(1080, 18);
  }
  return { data, header: { type, key, captureUs: 0, seq: 1 } };
};

/** A screen that writes down what it tells the pane. */
function watched(device: ConstructorParameters<typeof PhoneScreen>[0]) {
  const said: string[] = [];
  const shown: string[] = [];
  const screen = new PhoneScreen(device, { touch: helper }, {
    onFrame: (jpeg) => shown.push(`jpeg ${jpeg.toString()}`),
    onVideo: (packet) => shown.push(packet.header.type === STREAM_CONFIG ? 'config' : 'frame'),
    onCodec: (codec) => said.push(`codec ${codec}`),
    onWaiting: (wait) => said.push(`wait ${wait}`),
  });
  return { screen, said, shown };
}

beforeEach(() => {
  fakes.helpers.length = 0;
  fakes.receiver.unsubscribed.length = 0;
  fakes.receiver.subscribes = 0;
});

describe('an iPhone’s screen at this PC', () => {
  it('ends when the receiver stops, not when it opens before the receiver started', async () => {
    const ends: unknown[] = [];
    const screen = new PhoneScreen(iphone('wifi-mirror'), { touch: { unavailable: 'Touch needs Developer Mode on the iPhone' } }, { onFrame: () => undefined, onEnd: (error) => ends.push(error) });
    await screen.start();
    expect(ends).toEqual([]);
    fakes.receiver.listener!.onState('waiting', null);
    fakes.receiver.listener!.onState('stopped', null);
    expect(ends).toHaveLength(1);
    screen.stop();
  });

  it('asks to start mirroring again when an iPhone connected but sends no picture', async () => {
    const waits: Array<string | null> = [];
    const screen = new PhoneScreen(proMax, { touch: { unavailable: 'Turn on touch to use the iPhone from here' } }, { onFrame: () => undefined, onWaiting: (wait) => waits.push(wait) });
    await screen.start();
    fakes.receiver.listener!.onState('waiting', null);
    expect(waits.at(-1)).toBe('mirror');
    // It reconnected with the session it had with the receiver before Studio restarted.
    fakes.receiver.listener!.onState('no-picture', proMaxMirroring);
    expect(waits.at(-1)).toBe('restart-mirroring');
    fakes.receiver.listener!.onState('mirroring', proMaxMirroring);
    expect(waits.at(-1)).toBeNull();
    screen.stop();
  });

  it('says which iPhone touch is for, but never a stand-in for an iPhone nobody knows', async () => {
    const known = new PhoneScreen(proMax, { touch: { unavailable: 'Turn on touch to use the iPhone from here' } }, { onFrame: () => undefined });
    await known.start();
    expect(known.info?.phone).toEqual({ udid: proMax.udid, name: 'IK 14 Pro Max' });
    known.stop();
    const stand = new PhoneScreen(iphone('wifi-mirror'), { touch: { unavailable: 'Touch needs an iPhone this PC knows' } }, { onFrame: () => undefined });
    await stand.start();
    expect(stand.info?.phone).toBeUndefined();
    stand.stop();
  });

  it('keeps touch off while an iPhone this PC doesn’t know mirrors', async () => {
    const infos: Array<{ input: boolean; inputReason?: string }> = [];
    const screen = new PhoneScreen(iphone8, { touch: helper }, { onFrame: () => undefined, onInfo: (info) => infos.push(info) });
    await screen.start();
    fakes.helpers.at(-1)!.finish();
    await settle();
    expect(screen.info?.input).toBe(true);
    // Another iPhone starts mirroring: a click would land on the iPhone 8, which nobody sees.
    fakes.receiver.listener!.onState('mirroring', { name: 'Guest iPhone', model: 'iPhone16,1', deviceId: '1A:2B:3C:4D:5E:6F' });
    expect(screen.info?.input).toBe(false);
    expect(screen.info?.inputReason).toBe('Touch is for iPhone, but Guest iPhone is mirroring. To use touch on Guest iPhone, plug it into this PC once with a cable');
    await expect(screen.still()).rejects.toThrow(/Guest iPhone is mirroring/);
    // The iPhone 8 mirrors instead: touch is back.
    fakes.receiver.listener!.onState('mirroring', iphone8Mirroring);
    expect(screen.info?.input).toBe(true);
    expect(infos.at(-1)?.input).toBe(true);
    screen.stop();
  });

  it('moves touch to another iPhone or app while the picture goes on', async () => {
    const screen = new PhoneScreen(iphone('00008120-00012840269B401E'), { touch: { unavailable: 'Turn on touch to use the iPhone from here' } }, { onFrame: () => undefined });
    await screen.start();
    expect(fakes.helpers).toHaveLength(0);
    expect(screen.info?.inputReason).toBe('Turn on touch to use the iPhone from here');

    // Touch was just turned on for this iPhone: it starts, on the same picture.
    screen.retarget(iphone('00008120-00012840269B401E'), helper);
    expect(fakes.helpers).toHaveLength(1);
    fakes.helpers[0]!.finish();
    await settle();
    expect(screen.info?.input).toBe(true);

    // Another app signed by the same team, on the same iPhone: touch stays as it is.
    screen.retarget(iphone('00008120-00012840269B401E'), helper);
    expect(fakes.helpers).toHaveLength(1);
    expect(fakes.helpers[0]!.stopped).toBe(false);

    // Another iPhone: the old touch stops and the new one starts.
    screen.retarget(iphone('00008030-001A2B3C4D5E6F70'), helper);
    expect(fakes.helpers[0]!.stopped).toBe(true);
    expect(fakes.helpers).toHaveLength(2);
    expect(screen.info?.input).toBe(false);

    // The pane moved on before that one started: its start is called off (it may be waiting for an
    // iPhone that is away), it stops again, and touch says why it is off.
    expect(fakes.helpers[1]!.options.signal?.aborted).toBe(false);
    screen.retarget(iphone('wifi-mirror'), { unavailable: 'Touch needs Developer Mode on the iPhone' });
    expect(fakes.helpers[1]!.options.signal?.aborted).toBe(true);
    fakes.helpers[1]!.finish();
    await settle();
    expect(fakes.helpers[1]!.stopped).toBe(true);
    expect(screen.info?.input).toBe(false);
    expect(screen.info?.inputReason).toBe('Touch needs Developer Mode on the iPhone');

    // One subscription to the receiver the whole time; closed for good, it can stop at once.
    expect(fakes.receiver.subscribes).toBe(1);
    screen.stop({ forGood: true });
    expect(fakes.receiver.unsubscribed).toEqual([{ now: true }]);
  });

  it('starts touch again by itself after it stopped, for as long as the pane shows the iPhone', async () => {
    vi.useFakeTimers();
    try {
      const screen = new PhoneScreen(proMax, { touch: helper }, { onFrame: () => undefined });
      await screen.start();
      fakes.helpers[0]!.finish();
      await settle();
      expect(screen.info?.input).toBe(true);
      // The iPhone locked and left the Wi-Fi: the runner ended.
      fakes.helpers[0]!.options.onEnded!('Runner DTX connection closed');
      expect(screen.info?.input).toBe(false);
      expect(screen.info?.inputReason).toBe('Touch stopped. It comes back by itself when IK 14 Pro Max is unlocked on this Wi-Fi');
      await vi.advanceTimersByTimeAsync(5000);
      expect(fakes.helpers).toHaveLength(2);
      // Still away: the new one says so, gives up a while later, and touch tries again after that.
      fakes.helpers[1]!.options.onLocked!();
      expect(screen.info?.inputReason).toBe('Unlock IK 14 Pro Max and keep it on this Wi-Fi to use touch');
      fakes.helpers[1]!.fail(new UserError('WebDriverAgent did not start on the iPhone.', 'Unlock the iPhone and keep it on this Wi-Fi, then try again.'));
      await settle();
      await vi.advanceTimersByTimeAsync(14_000);
      expect(fakes.helpers).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fakes.helpers).toHaveLength(3);
      fakes.helpers[2]!.finish();
      await settle();
      expect(screen.info?.input).toBe(true);
      // The pane closed: no more tries.
      fakes.helpers[2]!.options.onEnded!('Runner DTX connection closed');
      screen.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fakes.helpers).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves touch off when WebDriverAgent is gone from the iPhone, for Turn on touch to put it back', async () => {
    vi.useFakeTimers();
    try {
      const screen = new PhoneScreen(proMax, { touch: helper }, { onFrame: () => undefined });
      await screen.start();
      fakes.helpers[0]!.fail(new WdaStartError('WebDriverAgent did not start on the iPhone.', 'WebDriverAgent is not on the iPhone any more. Turn touch on again to put it back.', [], false));
      await settle();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fakes.helpers).toHaveLength(1);
      expect(screen.info?.inputReason).toBe('WebDriverAgent did not start on the iPhone. WebDriverAgent is not on the iPhone any more. Turn touch on again to put it back.');
      // Turned on again: touch starts on the same picture.
      screen.retarget(proMax, helper);
      expect(fakes.helpers).toHaveLength(2);
      screen.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the picture over the cable', () => {
  it('shows while nothing mirrors, gives way to mirroring when a session starts, and comes back after it', async () => {
    const { screen, said, shown } = watched(iphone8);
    await screen.start();
    fakes.receiver.listener!.onState('waiting', null);
    expect(said.at(-1)).toBe('wait mirror');
    // Touch is on: WebDriverAgent's screen stream is asked for, and its first picture ends the wait.
    fakes.helpers[0]!.finish();
    await settle();
    const first = fakes.helpers[0]!.watches[0]!;
    expect(said.at(-1)).toBe('wait mirror');
    first.onJpeg(Buffer.from('1'));
    expect(said.slice(-2)).toEqual(['codec jpeg', 'wait null']);
    expect(screen.currentCodec).toBe('jpeg');
    expect(screen.info?.points).toEqual({ width: 375, height: 667 });
    first.onJpeg(Buffer.from('2'));
    expect(shown).toEqual(['jpeg 1', 'jpeg 2']);

    // The iPhone mirrors, in a session this screen can't show from the start: the cable's picture stays.
    fakes.receiver.listener!.onState('mirroring', iphone8Mirroring);
    fakes.receiver.listener!.onVideo(mirrored(STREAM_FRAME));
    expect(first.stopped).toBe(false);
    expect(shown).toEqual(['jpeg 1', 'jpeg 2']);
    // A session opens with its config and keyframe: mirroring takes over.
    fakes.receiver.listener!.onVideo(mirrored(STREAM_CONFIG, true));
    fakes.receiver.listener!.onVideo(mirrored(STREAM_FRAME, true));
    expect(first.stopped).toBe(true);
    expect(said.slice(-2)).toEqual(['codec h264', 'wait null']);
    expect(shown.slice(2)).toEqual(['config', 'frame']);
    expect(screen.currentCodec).toBe('h264');
    expect(screen.info?.input).toBe(true);

    // Mirroring stopped: the pane keeps its last picture, without asking for mirroring, until the cable's is back.
    fakes.receiver.listener!.onState('waiting', null);
    expect(said.at(-1)).toBe('wait null');
    const second = fakes.helpers[0]!.watches[1]!;
    second.onJpeg(Buffer.from('3'));
    expect(said.slice(-2)).toEqual(['codec jpeg', 'wait null']);
    screen.stop();
    expect(second.stopped).toBe(true);
  });

  it('asks for mirroring when the cable’s picture doesn’t come back after mirroring stopped', async () => {
    vi.useFakeTimers();
    try {
      const { screen, said } = watched(iphone8);
      await screen.start();
      fakes.receiver.listener!.onState('waiting', null);
      fakes.helpers[0]!.finish();
      await settle();
      fakes.receiver.listener!.onState('mirroring', iphone8Mirroring);
      fakes.receiver.listener!.onVideo(mirrored(STREAM_CONFIG, true));
      fakes.receiver.listener!.onState('waiting', null);
      expect(said.at(-1)).toBe('wait null');
      await vi.advanceTimersByTimeAsync(3000);
      expect(said.at(-1)).toBe('wait mirror');
      screen.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays while an iPhone is connected that sends no picture, and touch stays on with it', async () => {
    const { screen, said } = watched(iphone8);
    await screen.start();
    fakes.receiver.listener!.onState('waiting', null);
    fakes.helpers[0]!.finish();
    await settle();
    fakes.helpers[0]!.watches[0]!.onJpeg(Buffer.from('1'));
    // Another iPhone came back with an old mirroring session: the picture shown is still the iPhone 8's.
    fakes.receiver.listener!.onState('no-picture', { name: 'Guest iPhone', model: 'iPhone16,1', deviceId: '1A:2B:3C:4D:5E:6F' });
    expect(said.at(-1)).toBe('wait null');
    expect(screen.info?.input).toBe(true);
    screen.stop();
  });

  it('goes with touch, and is asked for again while touch stays on', async () => {
    vi.useFakeTimers();
    try {
      const { screen, said } = watched(iphone8);
      await screen.start();
      fakes.receiver.listener!.onState('waiting', null);
      fakes.helpers[0]!.finish();
      await settle();
      fakes.helpers[0]!.watches[0]!.onJpeg(Buffer.from('1'));
      // The stream ended, touch didn't: it is asked for again a moment later.
      fakes.helpers[0]!.watches[0]!.onEnd('the screen stream ended');
      expect(said.at(-1)).toBe('wait mirror');
      await vi.advanceTimersByTimeAsync(2000);
      expect(fakes.helpers[0]!.watches).toHaveLength(2);
      fakes.helpers[0]!.watches[1]!.onJpeg(Buffer.from('2'));
      expect(said.at(-1)).toBe('wait null');
      // Touch stopped: so did its picture, and the pane waits for mirroring until touch is back.
      fakes.helpers[0]!.options.onEnded!('Runner DTX connection closed');
      expect(fakes.helpers[0]!.watches[1]!.stopped).toBe(true);
      expect(said.at(-1)).toBe('wait mirror');
      await vi.advanceTimersByTimeAsync(5000);
      fakes.helpers[1]!.finish();
      await settle();
      expect(fakes.helpers[1]!.watches).toHaveLength(1);
      screen.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not used for an iPhone on Wi-Fi: mirroring is its picture', async () => {
    const { screen, said } = watched(proMax);
    await screen.start();
    fakes.receiver.listener!.onState('waiting', null);
    fakes.helpers[0]!.finish();
    await settle();
    expect(fakes.helpers[0]!.watches).toHaveLength(0);
    expect(said.at(-1)).toBe('wait mirror');
    screen.stop();
  });
});
