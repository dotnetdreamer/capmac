import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InputEvent, ScreenInfo, ScreenParams } from '../../shared/protocol.js';
import { toolEnv } from '../env.js';
import { ensureHelper } from '../helper/build.js';
import { HelperInput } from '../helper/input.js';
import { HelperProcess } from '../helper/process.js';
import { HELPER_SOURCE } from '../helper/source.js';
import type { AgentIO } from '../io.js';
import { AgentError, run, sleep, which } from '../proc.js';

/** Puts text on the simulator's pasteboard. */
export async function setSimulatorPasteboard(udid: string, text: string, env: NodeJS.ProcessEnv): Promise<void> {
  const r = await run('xcrun', ['simctl', 'pbcopy', udid], { env, input: text, timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`simctl pbcopy failed: ${r.stderr.trim().split('\n').pop() ?? r.code}`);
}

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

/** AXe command lines for an input event (AXe takes whole gestures; streaming events have no equivalent). */
export function inputArgs(event: InputEvent, points: PointSize, udid: string): string[][] {
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
    case 'keypress':
      return event.modifiers ? [] : [['key', String(event.usage), '--udid', udid]];
    case 'button': {
      if (event.phase === 'up') return [];
      const map: Record<string, string> = { home: 'home', lock: 'lock', side: 'side-button', siri: 'siri', 'apple-pay': 'apple-pay' };
      return [['button', map[event.button] ?? 'home', '--udid', udid]];
    }
    default:
      return [];
  }
}

/** Runs input events through AXe, one at a time, in order. */
export function createAxeInput(axe: string, points: PointSize, udid: string, env: NodeJS.ProcessEnv, io: AgentIO): (event: InputEvent) => void {
  let chain = Promise.resolve();
  return (event) => {
    chain = chain.then(async () => {
      for (const args of inputArgs(event, points, udid)) {
        const r = await run(axe, args, { env, timeoutMs: 20_000 }).catch((err) => ({ code: 1, stderr: String(err), tail: [] as string[] }));
        if (r.code !== 0) io.log('warn', `Input failed: ${('stderr' in r ? r.stderr : '').trim().split('\n').pop() ?? 'unknown error'}`);
      }
    });
  };
}

/** Input through capmac's helper, without video (for the compatible stream). Null when it is not available. */
async function startHelperInput(udid: string, env: NodeJS.ProcessEnv, io: AgentIO): Promise<{ helper: HelperProcess; input: HelperInput; points: PointSize | null } | { reason: string }> {
  try {
    const binary = await ensureHelper(HELPER_SOURCE, env, { signal: io.signal });
    const helper = new HelperProcess(binary.path, [udid, '--developer-dir', binary.xcode.developerDir, '--video', '0'], { onInputError: (m) => io.log('warn', `Input: ${m}`) }, env);
    const hello = await helper.hello;
    if (!hello?.input) {
      await helper.stop();
      return { reason: hello?.inputReason ?? "CapMac's helper takes no input on this Mac." };
    }
    const input = new HelperInput({
      send: (line) => helper.send(line),
      sleep: (ms) => sleep(ms, io.signal),
      setPasteboard: (text) => setSimulatorPasteboard(udid, text, env),
    }, (m) => io.log('warn', `Input failed: ${m}`));
    return { helper, input, points: hello.points ?? null };
  } catch (err) {
    return { reason: (err as Error)?.message ?? String(err) };
  }
}

/** One full-resolution screenshot (PNG), sent as binary frames; the result carries its size. */
export async function opScreenshot(params: { udid: string }, io: AgentIO): Promise<{ bytes: number; width: number | null; height: number | null }> {
  const env = await toolEnv();
  const file = path.join(os.tmpdir(), `capmac-shot-${params.udid}-${process.pid}.png`);
  try {
    const r = await run('xcrun', ['simctl', 'io', params.udid, 'screenshot', '--type=png', file], { env, signal: io.signal, timeoutMs: 30_000 });
    if (r.code !== 0) {
      if (/not booted|Invalid device|No devices are booted/i.test(r.stderr)) throw new AgentError('The simulator is not running.', 'TARGET_NOT_FOUND');
      throw new AgentError('Taking the screenshot failed', 'DEPLOY_FAILED', undefined, r.tail.slice(-5));
    }
    const data = await fs.readFile(file);
    // PNG IHDR: width and height are the first two 32-bit fields after the signature and chunk header.
    const width = data.length > 24 ? data.readUInt32BE(16) : null;
    const height = data.length > 24 ? data.readUInt32BE(20) : null;
    await io.sendBinary(data);
    return { bytes: data.length, width, height };
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
}

/**
 * Streams the simulator screen as JPEG frames (binary frames on stdout) and
 * performs input events sent by the client (via AXe, when installed).
 */
export async function opScreen(params: ScreenParams, io: AgentIO): Promise<{ frames: number }> {
  const env = await toolEnv();
  const fps = Math.min(30, Math.max(1, params.fps || 10));
  const shotFile = path.join(os.tmpdir(), `capmac-screen-${params.udid}-${process.pid}.jpg`);
  // Input: capmac's helper when asked and it works, else AXe when installed, else view only.
  const viaHelper = params.helperInput ? await startHelperInput(params.udid, env, io) : null;
  const helper = viaHelper && 'helper' in viaHelper ? viaHelper : null;
  const axe = helper ? null : await which('axe', env);
  let points: PointSize | null = helper?.points ?? (axe ? await pointsFromAxe(axe, params.udid, env) : null);
  let announced = false;
  const announce = () => {
    const input = Boolean(helper || axe);
    const info: ScreenInfo = {
      t: 'screen',
      source: 'simctl',
      codec: 'jpeg',
      points,
      input,
      inputMode: helper ? 'touch' : axe ? 'gestures' : undefined,
      inputReason: helper ? undefined : viaHelper && 'reason' in viaHelper ? viaHelper.reason : axe ? undefined : "Touch and typing need CapMac's helper or AXe on the Mac.",
    };
    io.send(info);
    announced = true;
  };

  // Input events are executed one at a time, in order.
  let axeInput: ((event: InputEvent) => void) | null = null;
  let lastHeard = 0;
  io.onMessage((message) => {
    if (message?.t === 'ping') {
      lastHeard = Date.now();
      io.send({ t: 'pong', id: Number(message.id) || 0, pc: Number(message.pc) || 0, mac: Math.round((performance.timeOrigin + performance.now()) * 1000) });
      return;
    }
    if (message?.t !== 'input') return;
    const event = message.event as InputEvent;
    if (helper) {
      void helper.input.push(event);
      return;
    }
    if (!axe || !points) return;
    axeInput ??= createAxeInput(axe, points, params.udid, env, io);
    axeInput(event);
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
      // A client that pings and then goes quiet is gone (a dropped network leaves the SSH channel open).
      if (lastHeard && Date.now() - lastHeard > 15_000) break;
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
    await helper?.helper.stop();
  }
  return { frames };
}
