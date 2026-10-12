/**
 * Keeps the live video's latency bounded when the network is slower than the
 * stream. The engine acknowledges frames as they arrive; when the oldest
 * unacknowledged frame gets too old, the agent stops sending deltas (an H.264
 * delta is useless without the frames before it), waits for the backlog to
 * clear, then asks the helper for a keyframe and resumes from it.
 */
export interface VideoWindowOptions {
  /** Start dropping when the oldest frame in flight is older than this. */
  maxLagMs?: number;
  /** Resume (with a keyframe) once the oldest frame in flight is younger than this. */
  resumeLagMs?: number;
  /** The agent's own unsent bytes that count as congestion. */
  maxBacklogBytes?: number;
}

export class VideoWindow {
  private readonly inFlight: Array<{ seq: number; at: number }> = [];
  private dropping = false;
  private readonly maxLagMs: number;
  private readonly resumeLagMs: number;
  private readonly maxBacklogBytes: number;
  dropped = 0;

  constructor(private readonly now: () => number = Date.now, options: VideoWindowOptions = {}) {
    this.maxLagMs = options.maxLagMs ?? 350;
    this.resumeLagMs = options.resumeLagMs ?? 120;
    this.maxBacklogBytes = options.maxBacklogBytes ?? 256 * 1024;
  }

  private lag(now: number): number {
    const oldest = this.inFlight[0];
    return oldest ? now - oldest.at : 0;
  }

  /** Whether to send this frame now (true) or drop it (false). */
  offer(seq: number, key: boolean, backlogBytes: number): boolean {
    const now = this.now();
    const lag = this.lag(now);
    if (this.dropping) {
      if (!key || lag > this.resumeLagMs || backlogBytes > this.maxBacklogBytes / 4) {
        this.dropped += 1;
        return false;
      }
      this.dropping = false;
    } else if (!key && (lag > this.maxLagMs || backlogBytes > this.maxBacklogBytes)) {
      this.dropping = true;
      this.dropped += 1;
      return false;
    }
    this.inFlight.push({ seq, at: now });
    return true;
  }

  /** The engine received every frame up to `seq`. */
  ack(seq: number): void {
    while (this.inFlight.length && this.inFlight[0]!.seq <= seq) this.inFlight.shift();
  }

  /** Dropping, and the way is clear again: time to ask for a keyframe. */
  wantsKeyframe(backlogBytes: number): boolean {
    return this.dropping && this.lag(this.now()) <= this.resumeLagMs && backlogBytes <= this.maxBacklogBytes / 4;
  }

  get congested(): boolean {
    return this.dropping;
  }
}
