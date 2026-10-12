import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InputEvent, ScreenInfo, ScreenParams } from '../../shared/protocol.js';
import { toolEnv } from '../env.js';
import type { AgentIO } from '../io.js';
import { AgentError, run, sleep, which } from '../proc.js';

export interface PointSize {
  width: number;
  height: number;
}

/** Reads a JPEG's pixel size from its SOF marker. */
export function jpegSize(data: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1]!;
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** Best guess of the screen size in points from the pixel size (iPhones @2x/@3x, iPads @2x). */
export function pointsFromPixels(width: number, height: number): PointSize {
  const portraitW = Math.min(width, height);
  const portraitH = Math.max(width, height);
  const aspect = portraitH / portraitW;
  const scale = aspect < 1.6 ? 2 : portraitW >= 1000 ? 3 : 2;
  return { width: Math.round(width / scale), height: Math.round(height / scale) };
}

/** Reads the root element frame (in points) from `axe describe-ui`. */
async function pointsFromAxe(axe: string, udid: string, env: NodeJS.ProcessEnv): Promise<PointSize | null> {
  const r = await run(axe, ['describe-ui', '--udid', udid], { env, timeoutMs: 20_000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    const frame = root?.frame ?? root?.AXFrame;
    if (frame && frame.width > 0 && frame.height > 0) return { width: Math.round(frame.width), height: Math.round(frame.height) };
  } catch {
    // unexpected output; fall back to pixel heuristics
  }
  return null;
}

const KEYCODES: Record<string, number> = {
  return: 40,
  enter: 40,
  escape: 41,
  delete: 42,
  backspace: 42,
  tab: 43,
  space: 44,
};

function inputArgs(event: InputEvent, points: PointSize, udid: string): string[][] {
  const px = (v: number) => String(Math.round(Math.min(1, Math.max(0, v)) * points.width));
  const py = (v: number) => String(Math.round(Math.min(1, Math.max(0, v)) * points.height));
  switch (event.kind) {
    case 'tap':
      return [['tap', '-x', px(event.x), '-y', py(event.y), '--udid', udid]];
    case 'swipe':
      return [[
        'swipe',
        '--start-x', px(event.x1), '--start-y', py(event.y1),
        '--end-x', px(event.x2), '--end-y', py(event.y2),
        '--duration', (Math.max(50, event.durationMs) / 1000).toFixed(2),
        '--udid', udid,
      ]];
    case 'text':
      return event.text ? [['type', event.text, '--udid', udid]] : [];
    case 'key': {
      const code = KEYCODES[event.key];
      return code ? [['key', String(code), '--udid', udid]] : [];
    }
    case 'button': {
      const map: Record<string, string> = { home: 'home', lock: 'lock', side: 'side-button', siri: 'siri', 'apple-pay': 'apple-pay' };
      return [['button', map[event.button] ?? 'home', '--udid', udid]];
    }
  }
}

/**
 * Streams the simulator screen as JPEG frames (binary frames on stdout) and
 * performs input events sent by the client (via AXe, when installed).
 */
export async function opScreen(params: ScreenParams, io: AgentIO): Promise<{ frames: number }> {
  const env = await toolEnv();
  const axe = await which('axe', env);
  const fps = Math.min(30, Math.max(1, params.fps || 10));
  const shotFile = path.join(os.tmpdir(), `capmac-screen-${params.udid}-${process.pid}.jpg`);
  let points: PointSize | null = axe ? await pointsFromAxe(axe, params.udid, env) : null;
  let announced = false;
  const announce = () => {
    const info: ScreenInfo = { t: 'screen', source: 'simctl', points, input: Boolean(axe) };
    io.send(info);
    announced = true;
  };

  // Input events are executed one at a time, in order.
  let inputChain = Promise.resolve();
  io.onMessage((message) => {
    if (message?.t !== 'input' || !axe) return;
    const event = message.event as InputEvent;
    inputChain = inputChain.then(async () => {
      if (!points) return;
      for (const args of inputArgs(event, points, params.udid)) {
        const r = await run(axe, args, { env, timeoutMs: 20_000 }).catch((err) => ({ code: 1, stderr: String(err), tail: [] as string[] }));
        if (r.code !== 0) io.log('warn', `Input failed: ${('stderr' in r ? r.stderr : '').trim().split('\n').pop() ?? 'unknown error'}`);
      }
    });
  });

  // Full-resolution simulator JPEGs are ~450 KB; sips (built into macOS)
  // shrinks them ~8x in ~60 ms, which keeps the stream smooth over Wi-Fi.
  const sips = await which('sips', env);
  const smallFile = `${shotFile}.small.jpg`;
  const quality = String(Math.min(100, Math.max(20, params.quality || 60)));
  const maxSize = String(Math.max(400, params.maxSize ?? 1280));

  let frames = 0;
  let lastHash = '';
  let failures = 0;
  const interval = 1000 / fps;
  try {
    while (!io.signal.aborted) {
      const started = Date.now();
      const r = await run('xcrun', ['simctl', 'io', params.udid, 'screenshot', '--type=jpeg', shotFile], { env, signal: io.signal, timeoutMs: 20_000 });
      if (io.signal.aborted) break;
      if (r.code !== 0) {
        failures += 1;
        if (failures === 1 || failures % 20 === 0) io.log('warn', `Screenshot failed: ${r.stderr.trim().split('\n').pop() ?? ''}`);
        if (/not booted|Invalid device|No devices are booted/i.test(r.stderr)) throw new AgentError('The simulator is not running.', 'TARGET_NOT_FOUND');
        await sleep(1000, io.signal);
        continue;
      }
      failures = 0;
      const original = await fs.readFile(shotFile);
      if (!points) {
        const size = jpegSize(original);
        if (size) points = pointsFromPixels(size.width, size.height);
      }
      if (!announced) announce();
      // Unchanged screen: send nothing (and skip the resize).
      const hash = createHash('sha1').update(original).digest('hex');
      if (hash !== lastHash) {
        lastHash = hash;
        let frame = original;
        if (sips) {
          const resized = await run(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', quality, '-Z', maxSize, shotFile, '--out', smallFile], { env, timeoutMs: 10_000 });
          if (resized.code === 0) frame = await fs.readFile(smallFile).catch(() => original);
        }
        frames += 1;
        await io.sendBinary(frame, true);
      }
      const wait = interval - (Date.now() - started);
      if (wait > 0) await sleep(wait, io.signal);
    }
  } finally {
    await fs.rm(shotFile, { force: true }).catch(() => undefined);
    await fs.rm(smallFile, { force: true }).catch(() => undefined);
  }
  await inputChain;
  return { frames };
}
