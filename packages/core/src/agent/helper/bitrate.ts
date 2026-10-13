/**
 * Adaptive bitrate for the smooth stream. The engine acknowledges frames as
 * they arrive (VideoWindow); once a second this looks at how that went and
 * moves the helper's bitrate: down by 30% as soon as frames lag or have to be
 * dropped, back up by 15% after a few calm seconds of real traffic. On the
 * local network it stays at the top; over a slow uplink it finds what fits.
 */
export interface BitrateOptions {
  start: number;
  min: number;
  max: number;
}

/** What happened during the last second. */
export interface BitrateSignal {
  /** The oldest unacknowledged frame's age at its worst (ms). */
  peakLagMs: number;
  /** Frames dropped to catch up. */
  dropped: number;
  /** Frames sent. */
  frames: number;
  /** Bytes waiting in the agent's own output. */
  backlogBytes: number;
}

const LAGGING_MS = 220;
const CALM_MS = 100;
const CALM_SECONDS = 3;
const COOLDOWN_MS = 4000;
const BACKLOG_BYTES = 192 * 1024;

export class BitrateController {
  current: number;
  private calm = 0;
  private holdUntil = 0;

  constructor(private readonly options: BitrateOptions, private readonly now: () => number = Date.now) {
    this.current = Math.min(options.max, Math.max(options.min, Math.round(options.start)));
  }

  /** Call once a second; returns the new bitrate when it changed enough to send. */
  tick(signal: BitrateSignal): number | null {
    const t = this.now();
    let next = this.current;
    if (signal.dropped > 0 || signal.peakLagMs > LAGGING_MS || signal.backlogBytes > BACKLOG_BYTES) {
      next = Math.max(this.options.min, Math.round(this.current * 0.7));
      this.calm = 0;
      this.holdUntil = t + COOLDOWN_MS;
    } else if (signal.frames >= 15 && signal.peakLagMs < CALM_MS) {
      // Only real traffic says the link has room: an idle screen sends nothing.
      this.calm += 1;
      if (this.calm >= CALM_SECONDS && t >= this.holdUntil && this.current < this.options.max) {
        next = Math.min(this.options.max, Math.round(this.current * 1.15 + 100_000));
        this.calm = 0;
      }
    } else if (signal.frames > 0) {
      this.calm = 0;
    }
    if (next === this.current) return null;
    // Small steps are not worth an encoder change, except the last one to a bound.
    const atBound = next === this.options.max || next === this.options.min;
    if (!atBound && Math.abs(next - this.current) / this.current < 0.05) return null;
    this.current = next;
    return next;
  }
}
