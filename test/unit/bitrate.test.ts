/**
 * Adaptive bitrate for the smooth stream: down fast when frames lag or drop,
 * up slowly after calm seconds of real traffic, never outside its bounds.
 */
import { describe, expect, it } from 'vitest';
import { BitrateController } from '../../packages/core/src/agent/helper/bitrate.js';
import { VideoPacer } from '../../packages/core/src/agent/helper/relay.js';
import { VideoWindow } from '../../packages/core/src/agent/helper/window.js';
import { bitratesFor } from '../../packages/core/src/engine/screen.js';
import { STREAM_CONFIG, STREAM_FRAME, type StreamHeader } from '../../packages/core/src/shared/stream.js';

const calm = { peakLagMs: 30, dropped: 0, frames: 60, backlogBytes: 0 };
const lagging = { peakLagMs: 400, dropped: 0, frames: 30, backlogBytes: 0 };

function controller(start = 4_000_000) {
  let t = 0;
  const c = new BitrateController({ start, min: 500_000, max: 6_000_000 }, () => t);
  return { c, advance: (ms = 1000) => (t += ms) };
}

describe('adaptive bitrate', () => {
  it('backs off by 30% as soon as frames lag, down to its floor', () => {
    const { c, advance } = controller();
    expect(c.tick(lagging)).toBe(2_800_000);
    let last = 0;
    for (let i = 0; i < 20; i++) {
      advance();
      last = c.tick({ ...lagging, dropped: 3 }) ?? last;
    }
    expect(c.current).toBe(500_000);
    expect(last).toBeGreaterThanOrEqual(500_000);
  });

  it('climbs back after three calm seconds, and waits out a cool-down after backing off', () => {
    const { c, advance } = controller();
    c.tick(lagging); // 2.8 Mbps, hold for 4 s
    advance();
    expect(c.tick(calm)).toBeNull();
    advance();
    expect(c.tick(calm)).toBeNull();
    advance();
    expect(c.tick(calm)).toBeNull(); // calm for 3 s, but still inside the cool-down
    advance();
    expect(c.tick(calm)).toBe(Math.round(2_800_000 * 1.15 + 100_000));
  });

  it('does not climb on an idle screen, and never above its ceiling', () => {
    const { c, advance } = controller(5_900_000);
    for (let i = 0; i < 10; i++) {
      advance();
      c.tick({ peakLagMs: 0, dropped: 0, frames: 0, backlogBytes: 0 });
    }
    expect(c.current).toBe(5_900_000);
    for (let i = 0; i < 10; i++) {
      advance();
      c.tick(calm);
    }
    expect(c.current).toBe(6_000_000);
  });

  it('treats the agent’s own backlog as congestion', () => {
    const { c } = controller();
    expect(c.tick({ ...calm, backlogBytes: 512 * 1024 })).toBe(2_800_000);
  });

  it('starts by route: full rate on the local network, lower over the internet and the relay', () => {
    expect(bitratesFor('lan')).toMatchObject({ bitrate: 6_000_000, maxBitrate: 6_000_000 });
    expect(bitratesFor('direct').bitrate).toBeLessThan(bitratesFor('lan').bitrate);
    expect(bitratesFor('relay').maxBitrate).toBeLessThan(bitratesFor('direct').maxBitrate);
  });

  it('reports the worst lag of the last second from the frame window', () => {
    let t = 0;
    const window = new VideoWindow(() => t);
    window.offer(1, true, 0);
    t = 150;
    window.offer(2, false, 0); // frame 1 is 150 ms old and unacknowledged
    window.ack(2);
    expect(window.takePeakLag()).toBe(150);
    expect(window.takePeakLag()).toBe(0);
  });
});

/** Shared by every smooth stream: a simulator's, an iPhone's and an Electron app's window. */
describe('video pacing', () => {
  const frame = (seq: number, key = false): StreamHeader => ({ type: STREAM_FRAME, key, captureUs: 0, seq });
  function pacer() {
    let t = 0;
    const p = new VideoPacer({ bitrate: 6_000_000, minBitrate: 1_000_000, maxBitrate: 6_000_000 }, () => t);
    return { p, advance: (ms: number) => (t += ms) };
  }

  it('sends configs always, and frames while the client keeps up', () => {
    const { p, advance } = pacer();
    expect(p.offer({ type: STREAM_CONFIG, key: false, captureUs: 0, seq: 0 }, 0)).toBe(true);
    for (let seq = 1; seq <= 30; seq++) {
      expect(p.offer(frame(seq, seq === 1), 0)).toBe(true);
      p.ack(seq);
      advance(33);
    }
    expect(p.frames).toBe(30);
    expect(p.tick(0)).toMatchObject({ keyframe: false, bitrate: null });
  });

  it('drops deltas when frames stop being acknowledged, asks for a keyframe once the way is clear, and backs the bitrate off', () => {
    const { p, advance } = pacer();
    p.offer(frame(1, true), 0);
    advance(400);
    // Frame 1 is 400 ms old and unacknowledged: deltas wait.
    expect(p.offer(frame(2), 0)).toBe(false);
    expect(p.tick(0).keyframe).toBe(false);
    p.ack(1);
    advance(600);
    const pace = p.tick(0);
    expect(pace.keyframe).toBe(true);
    expect(pace.bitrate).toBe(4_200_000);
    expect(p.offer(frame(3, true), 0)).toBe(true);
    expect(p.dropped).toBe(1);
  });

  it('reports every five seconds', () => {
    const { p, advance } = pacer();
    const statuses: unknown[] = [];
    for (let seq = 1; seq <= 160; seq++) {
      p.offer(frame(seq, seq === 1), 0);
      p.ack(seq);
      advance(1000 / 30);
      const pace = p.tick(0);
      if (pace.status) statuses.push(pace.status);
    }
    expect(statuses).toEqual([{ fps: 30, dropped: 0 }]);
  });

  it('forgets the frames in flight when the source starts over, and keeps its bitrate', () => {
    const { p, advance } = pacer();
    p.offer(frame(1, true), 0);
    advance(400);
    p.offer(frame(2), 0);
    advance(1000);
    p.tick(0);
    const bitrate = p.bitrate.current;
    p.restart();
    // A new app sends seq 1 again: nothing old is in the way.
    expect(p.offer(frame(1, true), 0)).toBe(true);
    expect(p.offer(frame(2), 0)).toBe(true);
    expect(p.bitrate.current).toBe(bitrate);
    expect(p.dropped).toBe(1);
  });
});
