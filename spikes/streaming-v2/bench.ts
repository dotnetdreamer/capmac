// Streaming v2 spike: builds the H.264 helper on the paired Mac and measures it
// against today's JPEG stream, over capmac's own SSH connection.
//
//   npm run build                                   (the CLI's agent bundle, for v1)
//   npx esbuild spikes/streaming-v2/bench.ts --bundle --platform=node --format=cjs \
//     --external:cpu-features --external:*.node --outfile=spikes/streaming-v2/out/bench.cjs
//   node spikes/streaming-v2/out/bench.cjs build                 compile simstream on the Mac
//   node spikes/streaming-v2/out/bench.cjs v2 <udid> [seconds] [maxSize] [fps] [bitrate]
//   node spikes/streaming-v2/out/bench.cjs v1 <udid> [seconds]
//
// Environment: SIMSTREAM_ARGS (extra helper flags, e.g. "--low-latency 1"),
// DUMP=<file> (v2: save the raw stream for decode-test.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MacSession } from '../../packages/core/src/engine/session.js';

const HELPER_DIR = '.capmac/spike';
const [mode = 'v2', udid = '', secondsArg = '10', maxSize = '1400', fps = '60', bitrate = '6000000'] = process.argv.slice(2);
const seconds = Number(secondsArg);

// Microseconds on this PC's wall clock, with sub-millisecond resolution.
const base = BigInt(Date.now()) * 1000n - process.hrtime.bigint() / 1000n;
const nowUs = () => Number(base + process.hrtime.bigint() / 1000n);

function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function build(session: MacSession): Promise<void> {
  const source = readFileSync(path.join(__dirname, '..', 'simstream.m'));
  const put = await session.conn.pipeTo(`mkdir -p ~/${HELPER_DIR} && cat > ~/${HELPER_DIR}/simstream.m`, source);
  if (put.code !== 0) throw new Error(put.stderr);
  const r = await session.conn.runScript(
    `cd ~/${HELPER_DIR} && xcrun clang -fobjc-arc -O2 -Wno-objc-method-access -framework Foundation -framework CoreMedia -framework CoreVideo -framework IOSurface -framework VideoToolbox simstream.m -o simstream`,
    { timeoutMs: 120_000 },
  );
  process.stdout.write(r.stdout + r.stderr);
  console.log(r.code === 0 ? `built ~/${HELPER_DIR}/simstream` : 'build failed');
}

async function v2(session: MacSession): Promise<void> {
  const channel = await session.conn.exec(`exec ~/${HELPER_DIR}/simstream ${udid} --max-size ${maxSize} --fps ${fps} --bitrate ${bitrate} ${process.env.SIMSTREAM_ARGS ?? ''}`);
  channel.stderr.on('data', (d: Buffer) => process.stderr.write(`[mac] ${d}`));
  let pending = Buffer.alloc(0);
  let offsetUs = 0; // Mac clock minus PC clock, from the ping with the shortest round trip
  let bestRtt = Infinity;
  const rtts: number[] = [];
  const frames: Array<{ at: number; bytes: number; key: boolean; latencyUs: number }> = [];
  const dump: Buffer[] = [];
  let width = 0;
  let height = 0;
  channel.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (pending.length < 4 + length) break;
      const msg = pending.subarray(4, 4 + length);
      if (process.env.DUMP && (msg[0] === 1 || msg[0] === 2)) dump.push(Buffer.from(pending.subarray(0, 4 + length)));
      pending = pending.subarray(4 + length);
      const type = msg[0];
      const flags = msg[1]!;
      const captureUs = Number(msg.readBigUInt64BE(4));
      const payload = msg.subarray(16);
      const at = nowUs();
      if (type === 1) {
        width = payload.readUInt16BE(0);
        height = payload.readUInt16BE(2);
      } else if (type === 2) {
        frames.push({ at, bytes: length + 4, key: Boolean(flags & 1), latencyUs: at - (captureUs - offsetUs) });
      } else if (type === 3) {
        const sentUs = Number(payload.readBigUInt64BE(0));
        const rtt = at - sentUs;
        rtts.push(rtt);
        if (rtt < bestRtt) {
          bestRtt = rtt;
          offsetUs = captureUs - (sentUs + rtt / 2);
        }
      }
    }
  });
  // Clock sync first (NTP-style, shortest round trip wins), then measure.
  for (let i = 0; i < 20; i++) {
    channel.write(`p${nowUs()}\n`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const ping = setInterval(() => channel.write(`p${nowUs()}\n`), 1000);
  frames.length = 0;
  channel.write('k\n');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(ping);
  channel.write('q\n');
  channel.end();
  if (process.env.DUMP) writeFileSync(process.env.DUMP, Buffer.concat(dump));
  const window = frames.length > 1 ? (frames.at(-1)!.at - frames[0]!.at) / 1e6 : seconds;
  const bytes = frames.reduce((s, f) => s + f.bytes, 0);
  const lat = frames.slice(1).map((f) => f.latencyUs / 1000);
  const keys = frames.filter((f) => f.key);
  console.log(JSON.stringify({
    mode: 'v2 h264',
    size: `${width}x${height}`,
    frames: frames.length,
    fps: +(frames.length / window).toFixed(1),
    kbps: Math.round((bytes * 8) / window / 1000),
    avgFrameKB: +(bytes / Math.max(1, frames.length) / 1024).toFixed(1),
    keyframeKB: keys.length ? +(keys.reduce((s, f) => s + f.bytes, 0) / keys.length / 1024).toFixed(1) : null,
    // Capture on the Mac to arrival on this PC: encode, SSH and the network.
    latencyMs: { p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), max: +Math.max(...lat).toFixed(1) },
    rttMs: { min: +(bestRtt / 1000).toFixed(1), p50: +(pct(rtts, 50) / 1000).toFixed(1) },
  }, null, 1));
}

async function v1(session: MacSession): Promise<void> {
  const frames: Array<{ at: number; bytes: number }> = [];
  const call = await session.agent.start('screen', { udid, fps: 15, quality: 72, maxSize: Number(maxSize) }, {
    onBinary: (jpeg: Buffer) => frames.push({ at: nowUs(), bytes: jpeg.length }),
  });
  await new Promise((r) => setTimeout(r, 2000));
  frames.length = 0;
  await new Promise((r) => setTimeout(r, seconds * 1000));
  call.cancel();
  await call.result.catch(() => undefined);
  const window = frames.length > 1 ? (frames.at(-1)!.at - frames[0]!.at) / 1e6 : seconds;
  const bytes = frames.reduce((s, f) => s + f.bytes, 0);
  const gaps = frames.slice(1).map((f, i) => (f.at - frames[i]!.at) / 1000);
  console.log(JSON.stringify({
    mode: 'v1 jpeg',
    frames: frames.length,
    fps: +(frames.length / window).toFixed(1),
    kbps: Math.round((bytes * 8) / window / 1000),
    avgFrameKB: +(bytes / Math.max(1, frames.length) / 1024).toFixed(1),
    frameGapMs: { p50: +pct(gaps, 50).toFixed(0), p95: +pct(gaps, 95).toFixed(0) },
  }, null, 1));
}

async function main(): Promise<void> {
  const session = await MacSession.open({});
  try {
    if (mode === 'build') await build(session);
    else if (mode === 'v1') await v1(session);
    else await v2(session);
  } finally {
    session.close();
  }
}
main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
