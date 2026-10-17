import { describe, expect, it, vi } from 'vitest';
import { PhoneScreen } from '../../packages/core/src/engine/iphone/screen.js';

// The receiver and WebDriverAgent, as the screen sees them: subscriptions, and helpers that start when told.
const fakes = vi.hoisted(() => ({
  helpers: [] as Array<{ udid: string; bundleId: string; ready: boolean; stopped: boolean; finish(): void }>,
  receiver: { subscribes: 0, unsubscribed: [] as Array<{ now?: boolean } | undefined>, listener: null as null | { onState(state: string, client: null): void } },
}));

vi.mock('../../packages/core/src/engine/iphone/receiver.js', () => ({
  mirrorReceiver: () => ({
    // Like the real one: a new listener hears the state now (stopped, until start() starts it).
    subscribe: (listener: { onState(state: string, client: null): void }) => {
      fakes.receiver.subscribes += 1;
      fakes.receiver.listener = listener;
      listener.onState('stopped', null);
      return (options?: { now?: boolean }) => fakes.receiver.unsubscribed.push(options);
    },
    start: async () => undefined,
    lastLines: [],
  }),
}));

vi.mock('../../packages/core/src/engine/iphone/wda.js', () => ({
  WdaControl: class {
    private readonly helper: (typeof fakes.helpers)[number];
    constructor(device: { udid: string }, bundleId: string) {
      this.helper = { udid: device.udid, bundleId, ready: false, stopped: false, finish: () => undefined };
      fakes.helpers.push(this.helper);
    }
    get ready(): boolean {
      return this.helper.ready;
    }
    start(): Promise<void> {
      return new Promise((resolve) => {
        this.helper.finish = () => {
          this.helper.ready = true;
          resolve();
        };
      });
    }
    async stop(): Promise<void> {
      this.helper.stopped = true;
    }
  },
}));

const iphone = (udid: string) => ({ udid, name: 'iPhone', productVersion: undefined, connection: 'usb' as const });
const helper = { bundleId: 'dev.capmac.WebDriverAgentRunner.9XCZL2PPRH' };
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

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
    fakes.receiver.unsubscribed.length = 0;
    fakes.receiver.subscribes = 0;
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

    // The pane moved on before that one started: it stops again, and touch says why it is off.
    screen.retarget(iphone('wifi-mirror'), { unavailable: 'Touch needs Developer Mode on the iPhone' });
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
});
