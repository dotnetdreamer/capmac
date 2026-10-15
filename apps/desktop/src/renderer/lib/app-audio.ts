import { APP_AUDIO } from '@capmac/core/shared/electron';

/** How far behind the newest sound playback runs: enough to ride out the network's hiccups. */
const LEAD_S = 0.12;
/** Further behind than this, playback catches up (drops what is late). */
const MAX_BEHIND_S = 0.6;

/**
 * An Electron app's sound, played on this PC: Opus packets from the app
 * (see core's APP_AUDIO), decoded with WebCodecs and played back in order
 * with a small cushion.
 */
export class AppAudioPlayer {
  private ctx: AudioContext | null = null;
  private decoder: AudioDecoder | null = null;
  private gain: GainNode | null = null;
  private next = 0;
  private timestamp = 0;
  private wanted = false;

  /** Starts (or resumes) playback; a page may need a click first. */
  start(): void {
    this.wanted = true;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return;
    }
    if (typeof AudioDecoder === 'undefined') return;
    this.ctx = new AudioContext({ sampleRate: APP_AUDIO.sampleRate, latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.decoder = new AudioDecoder({ output: (data) => this.play(data), error: () => this.reset() });
    this.decoder.configure({ codec: APP_AUDIO.codec, sampleRate: APP_AUDIO.sampleRate, numberOfChannels: APP_AUDIO.numberOfChannels });
  }

  get running(): boolean {
    return this.ctx !== null;
  }

  push(packet: ArrayBuffer | Uint8Array): void {
    // After a decoding error: a fresh decoder.
    if (!this.decoder && this.wanted) this.start();
    const decoder = this.decoder;
    if (!decoder || decoder.state !== 'configured') return;
    try {
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.timestamp, data: packet }));
      this.timestamp += 20_000;
    } catch {
      this.reset();
    }
  }

  private play(data: AudioData): void {
    const ctx = this.ctx;
    const gain = this.gain;
    if (!ctx || !gain) {
      data.close();
      return;
    }
    try {
      const channels = data.numberOfChannels;
      const frames = data.numberOfFrames;
      const buffer = ctx.createBuffer(channels, frames, data.sampleRate);
      if (data.format === 'f32-planar') {
        for (let c = 0; c < channels; c++) {
          const plane = new Float32Array(frames);
          data.copyTo(plane, { planeIndex: c });
          buffer.copyToChannel(plane, c);
        }
      } else {
        // Interleaved: one copy, split by channel.
        const all = new Float32Array(frames * channels);
        data.copyTo(all, { planeIndex: 0, format: 'f32' });
        for (let c = 0; c < channels; c++) {
          const plane = new Float32Array(frames);
          for (let i = 0; i < frames; i++) plane[i] = all[i * channels + c]!;
          buffer.copyToChannel(plane, c);
        }
      }
      const now = ctx.currentTime;
      // Starved, or too far behind: start again a little ahead of now.
      if (this.next < now + 0.01 || this.next > now + LEAD_S + MAX_BEHIND_S) this.next = now + LEAD_S;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(this.next);
      this.next += buffer.duration;
    } catch {
      // a packet the decoder could not give back: skipped
    } finally {
      data.close();
    }
  }

  private reset(): void {
    try {
      this.decoder?.close();
    } catch {
      // closed already
    }
    this.decoder = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    void ctx?.close().catch(() => undefined);
  }

  stop(): void {
    this.wanted = false;
    this.reset();
  }
}
