/**
 * An Electron app's windows as H.264 video: the size the capture asks for,
 * the sessions that start, retry and give up (the window then comes as JPEG),
 * and the capture page's own script, run against stand-ins for the browser's
 * capture and WebCodecs.
 */
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CapturePage } from '../../packages/core/src/electron-hook/capture.js';
import { soundPageScript } from '../../packages/core/src/electron-hook/sound.js';
import { VideoCapture, videoPageScript, videoSize } from '../../packages/core/src/electron-hook/video.js';
import { parseStreamHeader, parseVideoConfig, STREAM_CONFIG, STREAM_FRAME } from '../../packages/core/src/shared/stream.js';

describe('the size of a window’s video', () => {
  it('is the page’s own pixels, never more, in even numbers', () => {
    expect(videoSize(1000, 768, 1, 2400)).toEqual({ width: 1000, height: 768 });
    expect(videoSize(1001, 767, 1, 2400)).toEqual({ width: 1000, height: 766 });
    // Retina: twice the points.
    expect(videoSize(920, 648, 2, 2400)).toEqual({ width: 1840, height: 1296 });
  });

  it('fits the longest side the viewer asked for', () => {
    expect(videoSize(1000, 768, 2, 1400)).toEqual({ width: 1400, height: 1074 });
    expect(videoSize(600, 1200, 1, 800)).toEqual({ width: 400, height: 800 });
  });

  it('stays within what the Mac’s encoder takes (4096 x 2304)', () => {
    expect(videoSize(2560, 1440, 2, 4096)).toEqual({ width: 4096, height: 2304 });
    // A tall window is limited by its height.
    expect(videoSize(800, 1600, 2, 4096)).toEqual({ width: 1152, height: 2304 });
  });
});

/** The capture page, without Electron: commands sent to it, and its messages played back. */
class FakePage {
  readonly sent: Array<{ channel: string; command: any }> = [];
  readonly listeners = new Map<string, (...args: any[]) => void>();
  holders = new Set<object>();
  closes = 0;
  loads = true;
  available = true;
  readonly contents = { id: 'capture-page' };
  on(channel: string, listener: (...args: any[]) => void): void {
    this.listeners.set(channel, listener);
  }
  hold(owner: object): Promise<any> {
    this.holders.add(owner);
    return this.loads ? Promise.resolve(this.contents) : Promise.reject(new Error('no page'));
  }
  drop(owner: object): void {
    if (this.holders.delete(owner) && this.holders.size === 0) this.closes += 1;
  }
  send(channel: string, command: any): void {
    this.sent.push({ channel, command });
  }
  emit(channel: string, ...args: any[]): void {
    this.listeners.get(channel)?.({}, ...args);
  }
}

/** A window's page: a fresh capture source each time it is asked. */
function windowPage() {
  let n = 0;
  return { destroyed: false, isDestroyed() { return this.destroyed; }, getMediaSourceId: () => `source-${++n}` };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function capture() {
  const page = new FakePage();
  const messages: Array<[number, Buffer]> = [];
  const failures: Array<[number, string]> = [];
  const video = new VideoCapture(page as unknown as CapturePage, {
    onMessage: (key, message) => messages.push([key, message]),
    onFailed: (key, reason) => failures.push([key, reason]),
  });
  return { page, video, messages, failures, starts: () => page.sent.filter((s) => s.command.t === 'start') };
}

describe('video sessions', () => {
  it('start on the window’s page with a fresh source, and hand the page’s messages on', async () => {
    const { page, video, messages, starts } = capture();
    video.start(7, windowPage(), { width: 1000, height: 768, fps: 30, bitrate: 4_000_000 });
    await tick();
    expect(starts()).toEqual([{ channel: 'capmac-video', command: { t: 'start', key: 7, source: 'source-1', width: 1000, height: 768, fps: 30, bitrate: 4_000_000 } }]);
    page.emit('capmac-video', 7, new Uint8Array([2, 1, 0, 0]));
    expect(messages.map(([key, m]) => [key, [...m]])).toEqual([[7, [2, 1, 0, 0]]]);
    video.stop(7);
  });

  it('try again with a fresh source when the capture hangs or stops, then give up', async () => {
    const { page, video, failures, starts } = capture();
    video.start(1, windowPage(), { width: 800, height: 600, fps: 30, bitrate: 2_000_000 });
    for (let i = 0; i < 4; i++) {
      await tick();
      page.emit('capmac-video-retry', 1, 'timeout');
      await new Promise((resolve) => setTimeout(resolve, 320));
    }
    expect(starts().map((s) => s.command.source)).toEqual(['source-1', 'source-2', 'source-3', 'source-4']);
    expect(failures).toEqual([[1, 'the window could not be captured (timeout)']]);
    // The page closes once no session needs it.
    expect(page.closes).toBe(1);
  });

  it('tell every client to use JPEG once the app cannot encode at all', async () => {
    const { page, video, failures } = capture();
    video.start(1, windowPage(), { width: 800, height: 600, fps: 30, bitrate: 2_000_000 });
    await tick();
    expect(video.available).toBe(true);
    page.emit('capmac-video-failed', 1, 'the H.264 encoder did not start: unsupported', true);
    expect(failures).toEqual([[1, 'the H.264 encoder did not start: unsupported']]);
    expect(video.available).toBe(false);
  });

  it('give up at once, for every client, when the capture page never answers', async () => {
    vi.useFakeTimers();
    try {
      const { video, failures } = capture();
      video.start(5, windowPage(), { width: 800, height: 600, fps: 30, bitrate: 2_000_000 });
      await vi.advanceTimersByTimeAsync(6100);
      expect(failures).toEqual([[5, 'CapMac’s capture page does not answer']]);
      expect(video.available).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('give up when the capture page cannot load', async () => {
    const { page, video, failures } = capture();
    page.loads = false;
    video.start(3, windowPage(), { width: 800, height: 600, fps: 30, bitrate: 2_000_000 });
    await tick();
    await tick();
    expect(failures[0]?.[0]).toBe(3);
    expect(failures[0]?.[1]).toMatch(/capture page did not load/);
  });

  it('pass keyframes and bitrate changes on, once each', async () => {
    const { page, video } = capture();
    video.start(2, windowPage(), { width: 800, height: 600, fps: 30, bitrate: 2_000_000 });
    await tick();
    video.keyframe(2);
    video.setBitrate(2, 1_000_000);
    video.setBitrate(2, 1_000_000);
    video.keyframe(99);
    expect(page.sent.slice(1).map((s) => s.command)).toEqual([
      { t: 'keyframe', key: 2 },
      { t: 'bitrate', key: 2, bitrate: 1_000_000 },
    ]);
  });

  it('start the capture again at a new size once it settles (a running capture cannot change size)', async () => {
    const { video, starts } = capture();
    video.start(2, windowPage(), { width: 800, height: 600, fps: 30, bitrate: 2_000_000 });
    await tick();
    video.setSize(2, { width: 800, height: 600 });
    video.setSize(2, { width: 1000, height: 750 });
    video.setSize(2, { width: 1200, height: 900 });
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(starts().map((s) => [s.command.source, s.command.width, s.command.height])).toEqual([
      ['source-1', 800, 600],
      ['source-2', 1200, 900],
    ]);
  });
});

describe('the capture page’s scripts', () => {
  it('parse, together, as the page runs them', () => {
    expect(() => new vm.Script(`const ipcRenderer = {}; ${soundPageScript()}\n${videoPageScript()}`)).not.toThrow();
  });
});

// ─── The video script against stand-ins for the browser ─────────────────────

/** A picture from the capture: WebCodecs-like, with a visible rect and a timestamp. */
class FakeFrame {
  closed = false;
  readonly visibleRect: { x: number; y: number; width: number; height: number };
  constructor(readonly width: number, readonly height: number, readonly timestamp: number, readonly source: FakeFrame | null = null) {
    this.visibleRect = { x: 0, y: 0, width, height };
  }
  close(): void {
    this.closed = true;
  }
}

function browser() {
  const ipc: Array<[string, ...any[]]> = [];
  const handlers = new Map<string, (...args: any[]) => void>();
  const encoders: FakeEncoder[] = [];
  let pushFrame: ((frame: FakeFrame | null) => void) | null = null;
  const queue: Array<FakeFrame | null> = [];
  let encodeFails = false;

  class FakeEncoder {
    state = 'unconfigured';
    encodeQueueSize = 0;
    config: any = null;
    readonly encoded: Array<{ key: boolean; ts: number }> = [];
    constructor(private readonly init: { output: (chunk: any, metadata?: any) => void; error: (e: Error) => void }) {
      encoders.push(this);
    }
    configure(config: any): void {
      if (encodeFails) {
        this.state = 'closed';
        this.init.error(new Error('Encoder creation error.'));
        return;
      }
      this.state = 'configured';
      const fresh = this.config === null || this.config.width !== config.width;
      this.config = config;
      if (fresh) this.needsConfig = true;
    }
    needsConfig = false;
    encode(frame: any, options: { keyFrame: boolean }): void {
      const key = options.keyFrame || this.encoded.length === 0;
      this.encoded.push({ key, ts: frame.timestamp });
      const bytes = new Uint8Array(key ? 40 : 4).fill(key ? 7 : 1);
      const metadata = this.needsConfig ? { decoderConfig: { codec: this.config.codec, description: new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe0, 0x00]) } } : undefined;
      this.needsConfig = false;
      this.init.output({ type: key ? 'key' : 'delta', timestamp: frame.timestamp, byteLength: bytes.length, copyTo: (dest: Uint8Array) => dest.set(bytes) }, metadata);
    }
    close(): void {
      this.state = 'closed';
    }
  }

  const track = {
    readyState: 'live',
    stopped: false,
    stop() {
      this.stopped = true;
    },
    getSettings: () => ({ width: 1000, height: 768 }),
    applyConstraints: async () => undefined,
  };
  const sandbox: Record<string, unknown> = {
    ipcRenderer: {
      send: (channel: string, ...args: any[]) => ipc.push([channel, ...args]),
      on: (channel: string, handler: (...args: any[]) => void) => handlers.set(channel, handler),
    },
    window: { addEventListener: () => undefined },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) } },
    MediaStreamTrackProcessor: class {
      readonly readable = {
        getReader: () => ({
          read: () =>
            new Promise((resolve) => {
              const next = queue.shift();
              if (next !== undefined) resolve(next ? { value: next, done: false } : { done: true });
              else pushFrame = (frame) => resolve(frame ? { value: frame, done: false } : { done: true });
            }),
          cancel: async () => undefined,
        }),
      };
    },
    VideoEncoder: FakeEncoder,
    VideoFrame: class extends FakeFrame {
      constructor(source: FakeFrame, init: { timestamp: number; visibleRect: { width: number; height: number } }) {
        super(init.visibleRect.width, init.visibleRect.height, init.timestamp, source);
      }
    },
    performance: { timeOrigin: 1_700_000_000_000, now: () => 1000 },
    setTimeout,
    clearTimeout,
    DataView,
    BigInt,
    ArrayBuffer,
    Uint8Array,
    Math,
    JSON,
    String,
    Object,
    Promise,
    Error,
  };
  vm.runInNewContext(videoPageScript(), sandbox);
  return {
    ipc,
    encoders,
    track,
    command: (c: unknown) => handlers.get('capmac-video')!({}, c),
    frame: (frame: FakeFrame | null) => {
      if (pushFrame) {
        const push = pushFrame;
        pushFrame = null;
        push(frame);
      } else {
        queue.push(frame);
      }
    },
    failEncoders: (on: boolean) => {
      encodeFails = on;
    },
    messages: () => ipc.filter(([channel]) => channel === 'capmac-video').map(([, , m]) => m as Uint8Array),
    sent: (channel: string) => ipc.filter(([c]) => c === channel),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('the capture page’s video script', () => {
  it('sends a config, then a keyframe and deltas, in the simulator stream’s format', async () => {
    const b = browser();
    b.command({ t: 'start', key: 1, source: 's', width: 1000, height: 768, fps: 30, bitrate: 3_000_000 });
    await settle();
    expect(b.sent('capmac-video-started')).toHaveLength(1);
    b.frame(new FakeFrame(1000, 768, 1));
    b.frame(new FakeFrame(1000, 768, 2));
    await settle();
    const [config, key, delta] = b.messages();
    expect(parseStreamHeader(config!)?.type).toBe(STREAM_CONFIG);
    expect(parseVideoConfig(config!)).toMatchObject({ width: 1000, height: 768, codec: 'avc1.64001f' });
    expect(parseStreamHeader(key!)).toMatchObject({ type: STREAM_FRAME, key: true, seq: 1 });
    expect(parseStreamHeader(delta!)).toMatchObject({ type: STREAM_FRAME, key: false, seq: 2 });
    expect(b.encoders[0]!.config).toMatchObject({ hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime', avc: { format: 'avc' }, bitrate: 3_000_000 });
  });

  it('encodes even sizes only (H.264 counts colour in 2 x 2 blocks)', async () => {
    const b = browser();
    b.command({ t: 'start', key: 1, source: 's', width: 1001, height: 767, fps: 30, bitrate: 3_000_000 });
    await settle();
    b.frame(new FakeFrame(1001, 767, 1));
    await settle();
    expect(b.encoders[0]!.config).toMatchObject({ width: 1000, height: 766 });
  });

  it('sends its last picture again as a keyframe when the window is still', async () => {
    const b = browser();
    b.command({ t: 'start', key: 1, source: 's', width: 800, height: 600, fps: 30, bitrate: 3_000_000 });
    await settle();
    b.frame(new FakeFrame(800, 600, 1));
    b.frame(new FakeFrame(800, 600, 2));
    await settle();
    b.command({ t: 'keyframe', key: 1 });
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(b.encoders[0]!.encoded.map((e) => e.key)).toEqual([true, false, true]);
  });

  it('starts over at a new size with a new config and a keyframe', async () => {
    const b = browser();
    b.command({ t: 'start', key: 1, source: 's', width: 800, height: 600, fps: 30, bitrate: 3_000_000 });
    await settle();
    b.frame(new FakeFrame(800, 600, 1));
    b.frame(new FakeFrame(1200, 900, 2));
    await settle();
    const headers = b.messages().map((m) => parseStreamHeader(m));
    expect(headers.map((h) => [h?.type, h?.key])).toEqual([[STREAM_CONFIG, false], [STREAM_FRAME, true], [STREAM_CONFIG, false], [STREAM_FRAME, true]]);
    expect(parseVideoConfig(b.messages()[2]!)).toMatchObject({ width: 1200, height: 900 });
  });

  it('tries software once when the hardware encoder refuses, then says the app cannot encode', async () => {
    const b = browser();
    b.failEncoders(true);
    b.command({ t: 'start', key: 4, source: 's', width: 800, height: 600, fps: 30, bitrate: 3_000_000 });
    await settle();
    b.frame(new FakeFrame(800, 600, 1));
    await settle();
    b.frame(new FakeFrame(800, 600, 2));
    await settle();
    const failed = b.sent('capmac-video-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]![1]).toBe(4);
    expect(failed[0]![2]).toMatch(/encoder did not start/);
    expect(failed[0]![3]).toBe(true);
    expect(b.track.stopped).toBe(true);
  });

  it('says so when the capture ends by itself', async () => {
    const b = browser();
    b.command({ t: 'start', key: 9, source: 's', width: 800, height: 600, fps: 30, bitrate: 3_000_000 });
    await settle();
    b.frame(null);
    await settle();
    expect(b.sent('capmac-video-ended')).toEqual([['capmac-video-ended', 9]]);
  });
});
