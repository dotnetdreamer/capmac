/**
 * Notices the one failure the H.264 stream cannot report itself: CoreSimulator
 * keeps the helper registered but stops updating the framebuffer it reads,
 * while the simulator itself keeps rendering (seen once with Xcode 26.6). The
 * stream then simply goes quiet, like an idle screen.
 *
 * Only while the stream is quiet, it compares two small screenshots taken a
 * few seconds apart: if the screen changed and the helper saw nothing, the
 * stream is stalled. Probes back off while the screen stays idle, and stop as
 * soon as a frame arrives.
 */
export interface StallWatchOptions {
  /** Silence before the first probe. */
  quietMs?: number;
  /** Probes back off to this interval while the screen stays idle. */
  maxIntervalMs?: number;
}

export class StallWatch {
  private lastActivity: number;
  private lastProbe: string | null = null;
  private interval: number;
  private nextProbeAt = 0;
  private probing = false;
  private readonly quietMs: number;
  private readonly maxIntervalMs: number;

  /**
   * @param probe  a fingerprint of what the simulator shows right now (a screenshot's hash), or null if it failed
   */
  constructor(private readonly probe: () => Promise<string | null>, private readonly now: () => number = Date.now, options: StallWatchOptions = {}) {
    this.quietMs = options.quietMs ?? 3000;
    this.maxIntervalMs = options.maxIntervalMs ?? 20_000;
    this.interval = this.quietMs;
    this.lastActivity = now();
  }

  /** The helper saw the screen change (or sent a frame). */
  activity(): void {
    this.lastActivity = this.now();
    this.lastProbe = null;
    this.interval = this.quietMs;
    this.nextProbeAt = 0;
  }

  /** Call about once a second. True when the screen changed while the stream stayed quiet. */
  async check(): Promise<boolean> {
    const now = this.now();
    if (this.probing || now - this.lastActivity < this.quietMs || now < this.nextProbeAt) return false;
    this.probing = true;
    const started = now;
    try {
      const fingerprint = await this.probe();
      // Frames arrived meanwhile: the stream is alive; whatever the probe saw proves nothing.
      if (this.lastActivity > started || fingerprint === null) return false;
      if (this.lastProbe !== null && fingerprint !== this.lastProbe) return true;
      this.lastProbe = fingerprint;
      this.nextProbeAt = this.now() + this.interval;
      this.interval = Math.min(this.maxIntervalMs, this.interval * 2);
      return false;
    } finally {
      this.probing = false;
    }
  }
}
