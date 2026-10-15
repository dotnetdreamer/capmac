/**
 * Simulator screen decoder. Frames arrive on a MessagePort straight from the
 * engine (the page's main thread never touches pixels) and are drawn on an
 * OffscreenCanvas:
 *  - the smooth stream: H.264 decoded with WebCodecs (hardware when there is
 *    some), each frame drawn as soon as it is decoded;
 *  - the compatible stream: JPEGs decoded with createImageBitmap.
 * Every frame is acknowledged so the engine never queues too many. When the
 * decoder falls behind, it drops to the next keyframe and asks for one.
 */
import { parseVideoConfig, STREAM_HEADER_BYTES } from '@capmac/core/shared/stream';
import type { ScreenPortMessage } from '../../shared/contract';

type InMessage =
  | { type: 'canvas'; canvas: OffscreenCanvas }
  | { type: 'port'; port: MessagePort }
  | { type: 'size'; width: number; height: number }
  | { type: 'input'; event: unknown }
  | { type: 'restart' }
  | { type: 'retry-smooth' }
  | { type: 'video-size'; maxSize: number }
  | { type: 'window'; window: number | null }
  | { type: 'window-action'; window: number; action: 'close' | 'minimize' | 'zoom' };

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((e: MessageEvent<InMessage>) => void) | null };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let port: MessagePort | null = null;
let frameWidth = 0;
let frameHeight = 0;
let firstFrame = true;

// Stats, reported once a second.
let frames = 0;
let bytes = 0;
let decodeMs = 0;
let dropped = 0;
const latencies: number[] = [];
/** A touch, key or button went out at this time (performance.now()); the next picture answers it. */
let inputAt = 0;
let inputMs: number | null = null;

const nowUs = () => (performance.timeOrigin + performance.now()) * 1000;

function sizeChanged(width: number, height: number): void {
  if (width === frameWidth && height === frameHeight) return;
  frameWidth = width;
  frameHeight = height;
  scope.postMessage({ type: 'frame-size', width, height });
}

function shown(): void {
  frames += 1;
  if (inputAt) {
    inputMs = performance.now() - inputAt;
    inputAt = 0;
  }
  if (firstFrame) {
    firstFrame = false;
    scope.postMessage({ type: 'first-frame' });
  }
}

// ─── Compatible stream: JPEG ───────────────────────────────────────────────

let latestBitmap: ImageBitmap | null = null;
let decoding = false;
let pending: { data: ArrayBuffer; seq: number } | null = null;

function drawBitmap(): void {
  if (!ctx || !canvas || !latestBitmap) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(latestBitmap, 0, 0, canvas.width, canvas.height);
}

async function decodeJpeg(data: ArrayBuffer, seq: number): Promise<void> {
  decoding = true;
  const started = performance.now();
  try {
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
    decodeMs += performance.now() - started;
    bytes += data.byteLength;
    sizeChanged(bitmap.width, bitmap.height);
    latestBitmap?.close();
    latestBitmap = bitmap;
    drawBitmap();
    shown();
  } catch {
    // a corrupt frame: skip it
  } finally {
    port?.postMessage({ type: 'ack', seq });
    decoding = false;
    // Only the newest waiting frame matters.
    if (pending) {
      const next = pending;
      pending = null;
      void decodeJpeg(next.data, next.seq);
    }
  }
}

function onJpeg(data: ArrayBuffer, seq: number): void {
  if (decoding) {
    if (pending) port?.postMessage({ type: 'ack', seq: pending.seq });
    pending = { data, seq };
  } else {
    void decodeJpeg(data, seq);
  }
}

// ─── Smooth stream: H.264 with WebCodecs ──────────────────────────────────

let decoder: VideoDecoder | null = null;
let decoderConfig: VideoDecoderConfig | null = null;
let latestFrame: VideoFrame | null = null;
/** Deltas are useless until the next keyframe (after a reset, a drop, a new config). */
let waitingForKey = true;
let keyAskedAt = 0;
let clockOffsetUs: number | null = null;
/** When each chunk was handed to the decoder, by its timestamp (the capture time). */
const submitted = new Map<number, number>();

function askForKeyframe(): void {
  const now = performance.now();
  if (now - keyAskedAt < 500) return;
  keyAskedAt = now;
  port?.postMessage({ type: 'keyframe' });
}

function drawFrame(): void {
  if (!ctx || !canvas || !latestFrame) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // The decoder pads the picture to whole macroblocks (642 → 656 pixels, in green): scaling
  // samples past the right and bottom edges, so leave the last pixel out (invisible at this size).
  const w = latestFrame.displayWidth;
  const h = latestFrame.displayHeight;
  ctx.drawImage(latestFrame, 0, 0, w - 1, h - 1, 0, 0, canvas.width, canvas.height);
}

function onDecoded(frame: VideoFrame): void {
  const at = submitted.get(frame.timestamp);
  if (at !== undefined) {
    decodeMs += performance.now() - at;
    submitted.delete(frame.timestamp);
  }
  // Capture on the Mac to the picture here, on this PC's clock.
  if (clockOffsetUs !== null) latencies.push((nowUs() - (frame.timestamp - clockOffsetUs)) / 1000);
  sizeChanged(frame.displayWidth, frame.displayHeight);
  // Keep the newest frame (to redraw on resize); the one before is done.
  latestFrame?.close();
  latestFrame = frame;
  drawFrame();
  shown();
}

function onDecoderError(error: DOMException): void {
  scope.postMessage({ type: 'decoder-error', message: error.message });
  decoder = null;
  waitingForKey = true;
  submitted.clear();
  if (decoderConfig) configureDecoder(decoderConfig);
  askForKeyframe();
}

function configureDecoder(config: VideoDecoderConfig): void {
  if (!decoder || decoder.state === 'closed') decoder = new VideoDecoder({ output: onDecoded, error: onDecoderError });
  decoder.configure(config);
  decoderConfig = config;
  waitingForKey = true;
}

function closeDecoder(): void {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  decoderConfig = null;
  waitingForKey = true;
  submitted.clear();
}

function onVideo(message: Extract<ScreenPortMessage, { type: 'video' }>): void {
  if (message.config) {
    const config = parseVideoConfig(new Uint8Array(message.data));
    if (!config) return;
    configureDecoder({
      codec: config.codec,
      description: config.description,
      codedWidth: config.width,
      codedHeight: config.height,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    });
    return;
  }
  port?.postMessage({ type: 'ack', seq: message.seq });
  bytes += message.data.byteLength;
  if (!decoder || decoder.state !== 'configured') {
    askForKeyframe();
    return;
  }
  if (!message.key) {
    // Waiting for a keyframe, or falling behind: skip deltas up to the next keyframe.
    if (waitingForKey || decoder.decodeQueueSize > 3) {
      if (!waitingForKey) dropped += 1;
      waitingForKey = true;
      askForKeyframe();
      return;
    }
  }
  waitingForKey = false;
  submitted.set(message.captureUs, performance.now());
  if (submitted.size > 120) submitted.delete(submitted.keys().next().value!);
  try {
    decoder.decode(new EncodedVideoChunk({ type: message.key ? 'key' : 'delta', timestamp: message.captureUs, data: new Uint8Array(message.data, STREAM_HEADER_BYTES) }));
  } catch (err) {
    onDecoderError(err instanceof DOMException ? err : new DOMException(String(err)));
  }
}

// ─── Port and page ─────────────────────────────────────────────────────────

function onPortMessage(e: MessageEvent<ScreenPortMessage>): void {
  const message = e.data;
  switch (message.type) {
    case 'video':
      onVideo(message);
      return;
    case 'frame':
      onJpeg(message.data, message.seq);
      return;
    case 'clock':
      clockOffsetUs = message.offsetUs;
      return;
    case 'codec':
      // The other stream's last picture stays on the canvas until the new one draws.
      if (message.codec === 'jpeg') {
        closeDecoder();
        latestFrame?.close();
        latestFrame = null;
      } else {
        latestBitmap?.close();
        latestBitmap = null;
        waitingForKey = true;
      }
      break;
  }
  scope.postMessage(message);
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

let idleReported = false;
setInterval(() => {
  if (!port) return;
  // An idle screen: say so once, not every second.
  const idle = frames === 0 && bytes === 0;
  if (idle && idleReported) return;
  idleReported = idle;
  scope.postMessage({
    type: 'stats',
    fps: frames,
    kbps: Math.round((bytes * 8) / 1000),
    decodeMs: frames ? decodeMs / frames : 0,
    latencyMs: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    dropped,
    inputMs,
  });
  frames = 0;
  bytes = 0;
  decodeMs = 0;
  dropped = 0;
  latencies.length = 0;
}, 1000);

scope.onmessage = (e) => {
  const message = e.data;
  switch (message.type) {
    case 'canvas':
      canvas = message.canvas;
      ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      break;
    case 'port':
      port = message.port;
      port.onmessage = onPortMessage;
      break;
    case 'size':
      if (canvas && (canvas.width !== message.width || canvas.height !== message.height) && message.width > 0 && message.height > 0) {
        canvas.width = message.width;
        canvas.height = message.height;
        if (latestFrame) drawFrame();
        else drawBitmap();
      }
      break;
    case 'input': {
      // Time an input to the next picture (on an idle screen, its answer). A click counts from
      // its release, when apps react; a press that already changed the screen was counted then.
      const e = message.event as { kind?: string; phase?: string } | null;
      const starts = e?.kind === 'keypress' || e?.kind === 'tap' || e?.kind === 'button' || (e?.kind === 'touch' && e.phase === 'down') || ((e?.kind === 'mouse' || e?.kind === 'keyboard') && e.phase === 'down');
      const release = (e?.kind === 'touch' || e?.kind === 'mouse') && e.phase === 'up';
      if ((starts && !inputAt) || (release && inputAt)) inputAt = performance.now();
      port?.postMessage({ type: 'input', event: message.event });
      break;
    }
    case 'restart':
      port?.postMessage({ type: 'restart' });
      break;
    case 'retry-smooth':
      port?.postMessage({ type: 'retry-smooth' });
      break;
    case 'video-size':
      port?.postMessage({ type: 'size', maxSize: message.maxSize });
      break;
    // An app's windows: which one to show, and its traffic lights.
    case 'window':
      port?.postMessage({ type: 'window', window: message.window });
      break;
    case 'window-action':
      port?.postMessage({ type: 'window-action', window: message.window, action: message.action });
      break;
  }
};
