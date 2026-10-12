/**
 * Simulator screen decoder. Frames arrive on a MessagePort straight from the
 * engine (the page's main thread never touches pixels), are decoded with
 * createImageBitmap and drawn on an OffscreenCanvas. Each frame is acked so
 * the engine never queues more than two; under backpressure it drops frames.
 * v2 will swap the JPEG path for WebCodecs H.264 here.
 */
import type { ScreenPortMessage } from '../../shared/contract';

type InMessage =
  | { type: 'canvas'; canvas: OffscreenCanvas }
  | { type: 'port'; port: MessagePort }
  | { type: 'size'; width: number; height: number }
  | { type: 'input'; event: unknown }
  | { type: 'restart' };

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((e: MessageEvent<InMessage>) => void) | null };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let port: MessagePort | null = null;
let latest: ImageBitmap | null = null;
let frameWidth = 0;
let frameHeight = 0;
let frames = 0;
let bytes = 0;
let decodeMs = 0;
let decoding = false;
let pending: { data: ArrayBuffer; seq: number } | null = null;

function draw(): void {
  if (!ctx || !canvas || !latest) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(latest, 0, 0, canvas.width, canvas.height);
}

async function decode(data: ArrayBuffer, seq: number): Promise<void> {
  decoding = true;
  const started = performance.now();
  try {
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
    decodeMs += performance.now() - started;
    frames += 1;
    bytes += data.byteLength;
    if (bitmap.width !== frameWidth || bitmap.height !== frameHeight) {
      frameWidth = bitmap.width;
      frameHeight = bitmap.height;
      scope.postMessage({ type: 'frame-size', width: frameWidth, height: frameHeight });
    }
    latest?.close();
    latest = bitmap;
    draw();
    if (frames === 1) scope.postMessage({ type: 'first-frame' });
  } catch {
    // a corrupt frame: skip it
  } finally {
    port?.postMessage({ type: 'ack', seq });
    decoding = false;
    // Only the newest waiting frame matters.
    if (pending) {
      const next = pending;
      pending = null;
      void decode(next.data, next.seq);
    }
  }
}

function onPortMessage(e: MessageEvent<ScreenPortMessage>): void {
  const message = e.data;
  if (message.type === 'frame') {
    if (decoding) {
      if (pending) port?.postMessage({ type: 'ack', seq: pending.seq });
      pending = { data: message.data, seq: message.seq };
    } else {
      void decode(message.data, message.seq);
    }
  } else {
    scope.postMessage(message);
  }
}

setInterval(() => {
  if (!port) return;
  scope.postMessage({ type: 'stats', fps: frames, kbps: Math.round((bytes * 8) / 1000), decodeMs: frames ? decodeMs / frames : 0 });
  frames = 0;
  bytes = 0;
  decodeMs = 0;
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
        draw();
      }
      break;
    case 'input':
      port?.postMessage({ type: 'input', event: message.event });
      break;
    case 'restart':
      port?.postMessage({ type: 'restart' });
      break;
  }
};
