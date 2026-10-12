// Decodes a simstream dump (bench DUMP=...) with WebCodecs inside a running capmac Studio
// dev app (npm run desktop:dev opens a debugging port on 39217): hardware and software decode.
//   node spikes/streaming-v2/decode-test.mjs <dump.bin>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const data = readFileSync(process.argv[2]).toString('base64');
const browser = await chromium.connectOverCDP('http://127.0.0.1:39217');
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /127\.0\.0\.1/.test(p.url()));
const result = await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const messages = [];
  for (let at = 0; at + 4 <= bytes.length; ) {
    const length = view.getUint32(at);
    const msg = bytes.subarray(at + 4, at + 4 + length);
    messages.push({ type: msg[0], key: (msg[1] & 1) === 1, payload: msg.subarray(16) });
    at += 4 + length;
  }
  const config = messages.find((m) => m.type === 1);
  const width = (config.payload[0] << 8) | config.payload[1];
  const height = (config.payload[2] << 8) | config.payload[3];
  const avcc = config.payload.subarray(4);
  const hex = (n) => n.toString(16).padStart(2, '0');
  const codec = `avc1.${hex(avcc[1])}${hex(avcc[2])}${hex(avcc[3])}`;
  const frames = messages.filter((m) => m.type === 2);
  const support = {};
  for (const hardwareAcceleration of ['prefer-hardware', 'prefer-software']) {
    support[hardwareAcceleration] = (await VideoDecoder.isConfigSupported({ codec, description: avcc, codedWidth: width, codedHeight: height, hardwareAcceleration, optimizeForLatency: true })).supported;
  }
  const run = (hardwareAcceleration) => new Promise((resolve) => {
    const started = new Map();
    const latencies = [];
    let outputs = 0;
    let errors = 0;
    const t0 = performance.now();
    const decoder = new VideoDecoder({
      output: (frame) => {
        const s = started.get(frame.timestamp);
        if (s !== undefined) latencies.push(performance.now() - s);
        outputs++;
        frame.close();
        if (outputs === frames.length) finish();
      },
      error: () => { errors++; },
    });
    const finish = () => {
      const total = performance.now() - t0;
      latencies.sort((a, b) => a - b);
      resolve({ hardwareAcceleration, outputs, errors, totalMs: Math.round(total), fpsCapacity: Math.round((outputs / total) * 1000), decodeMs: { p50: +latencies[Math.floor(latencies.length / 2)].toFixed(2), p95: +latencies[Math.floor(latencies.length * 0.95)].toFixed(2) } });
      decoder.close();
    };
    decoder.configure({ codec, description: avcc, codedWidth: width, codedHeight: height, hardwareAcceleration, optimizeForLatency: true });
    // Real-time pacing would hide throughput; decode one frame at a time to measure latency per frame.
    (async () => {
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        started.set(i * 16667, performance.now());
        decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: i * 16667, data: f.payload }));
        while (decoder.decodeQueueSize > 0) await new Promise((r) => setTimeout(r, 0));
      }
      await decoder.flush().catch(() => undefined);
      if (outputs < frames.length) finish();
    })();
  });
  return { codec, size: `${width}x${height}`, frames: frames.length, support, hw: await run('prefer-hardware'), sw: await run('prefer-software') };
}, data);
console.log(JSON.stringify(result, null, 1));
await browser.close();
