/**
 * Adaptive bitrate for the smooth stream: down fast when frames lag or drop,
 * up slowly after calm seconds of real traffic, never outside its bounds.
 */
import { describe, expect, it } from 'vitest';
import { BitrateController } from '../../packages/core/src/agent/helper/bitrate.js';
import { VideoWindow } from '../../packages/core/src/agent/helper/window.js';
import { bitratesFor } from '../../packages/core/src/engine/screen.js';

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
