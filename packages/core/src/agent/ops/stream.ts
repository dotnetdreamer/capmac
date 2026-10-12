/**
 * The simulator's screen as H.264 (streaming v2). Runs capmac's helper on
 * the Mac, compiling it on first use, and relays its messages as binary frames
 * without transcoding. Takes input through the same helper (AXe when the
 * helper has none), answers clock pings, keeps latency bounded on a slow
 * network, and notices a stalled stream. When the call ends (the client
 * closes the channel, or stops talking), the helper stops too: no orphans.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InputEvent, ScreenInfo, StreamHelperState, StreamParams } from '../../shared/protocol.js';
import { STREAM_CONFIG } from '../../shared/stream.js';
import { toolEnv } from '../env.js';
import { ensureHelper, helperState } from '../helper/build.js';
import { HelperInput } from '../helper/input.js';
import { HelperProcess, type HelperExit } from '../helper/process.js';
import { HELPER_SOURCE } from '../helper/source.js';
import { StallWatch } from '../helper/stall.js';
import { VideoWindow } from '../helper/window.js';
import type { AgentIO } from '../io.js';
import { AgentError, run, sleep, which } from '../proc.js';
import { createAxeInput, setSimulatorPasteboard } from './screen.js';

/** The client pings every couple of seconds; this long without a word means it is gone. */
const CLIENT_TIMEOUT_MS = 15_000;

const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Why the helper could not start or kept going, as an error the engine turns into a fallback reason. */
export function helperFailure(exit: HelperExit, started: boolean): AgentError {
  // Exit 0 is the helper's own clean shutdown (end of input, SIGTERM): nothing more to say.
  const how = exit.signal ? ` (signal ${exit.signal})` : exit.code ? ` (exit ${exit.code})` : '';
  if (exit.fatal) {
    const hint = exit.fatal.code === 'NO_DISPLAY' ? 'Boot the simulator again, or restart it.' : undefined;
    return new AgentError(exit.fatal.message, started ? 'HELPER_EXITED' : 'HELPER_START_FAILED', hint, exit.stderr.slice(-8));
  }
  return started
    ? new AgentError(`The smooth stream's helper stopped unexpectedly${how}.`, 'HELPER_EXITED', undefined, exit.stderr.slice(-8))
    : new AgentError(`The smooth stream's helper did not start${how}.`, 'HELPER_START_FAILED', undefined, exit.stderr.slice(-8));
}

/** A fingerprint of what the simulator shows right now (for the stall check), or null. */
async function screenFingerprint(udid: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | null> {
  const file = path.join(os.tmpdir(), `capmac-probe-${udid}-${process.pid}.jpg`);
  try {
    const r = await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', file], { env, signal, timeoutMs: 15_000 });
    if (r.code !== 0) return null;
    return createHash('sha1').update(await fs.readFile(file)).digest('hex');
  } catch {
    return null;
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
}

export async function opStream(params: StreamParams, io: AgentIO): Promise<{ frames: number; dropped: number }> {
  const env = await toolEnv();
  const binary = await ensureHelper(HELPER_SOURCE, env, {
    signal: io.signal,
    onBuild: (xcode) => io.send({ t: 'stream-prepare', stage: 'building', xcode: xcode.version }),
  });
  if (io.signal.aborted) throw new AgentError('Cancelled', 'CANCELLED');
  io.send({ t: 'stream-prepare', stage: 'starting', xcode: binary.xcode.version });

  const window = new VideoWindow();
  const watch = new StallWatch(() => screenFingerprint(params.udid, env, io.signal));
  let frames = 0;
  let footprint = 0;
  let helperDropped = 0;
  const helper = new HelperProcess(
    binary.path,
    [
      params.udid,
      '--developer-dir', binary.xcode.developerDir,
      '--max-size', String(clampInt(params.maxSize, 480, 3000, 1400)),
      '--fps', String(clampInt(params.fps, 10, 60, 60)),
      '--bitrate', String(clampInt(params.bitrate, 1_000_000, 20_000_000, 6_000_000)),
    ],
    {
      onVideo: (message, header) => {
        watch.activity();
        if (header.type === STREAM_CONFIG) {
          io.sendLive(message);
          return;
        }
        if (!window.offer(header.seq, header.key, io.backlog)) return;
        frames += 1;
        io.sendLive(message);
      },
      onStatus: (status) => {
        if (status.callbacks > 0) watch.activity();
        footprint = status.footprint;
        helperDropped += status.dropped;
      },
      onInputError: (message) => io.log('warn', `Input: ${message}`),
    },
    env,
  );
  let stopping = false;
  try {
    const hello = await helper.hello;
    if (!hello) throw helperFailure(await helper.exited, false);
    if (!hello.video) throw new AgentError(`${hello.device || 'The simulator'} has no screen the helper can stream.`, 'HELPER_START_FAILED');

    // Input: the helper when it can; AXe (taps and swipes) when installed; else view only, with the reason.
    const axe = hello.input ? null : await which('axe', env);
    const axeInput = axe && hello.points ? createAxeInput(axe, hello.points, params.udid, env, io) : null;
    const helperInput = hello.input
      ? new HelperInput(
          {
            send: (line) => helper.send(line),
            sleep: (ms) => sleep(ms, io.signal),
            setPasteboard: (text) => setSimulatorPasteboard(params.udid, text, env),
          },
          (message) => io.log('warn', `Input failed: ${message}`),
        )
      : null;
    const info: ScreenInfo = {
      t: 'screen',
      source: 'helper',
      codec: 'h264',
      points: hello.points ?? null,
      scale: hello.scale,
      input: Boolean(helperInput || axeInput),
      inputMode: helperInput ? 'touch' : axeInput ? 'gestures' : undefined,
      inputReason: helperInput ? undefined : hello.inputReason ?? 'This simulator does not take input from CapMac.',
    };
    io.send(info);
    io.send({ t: 'ready', data: { xcode: binary.xcode.version, compiled: binary.compiled } });

    let lastHeard = Date.now();
    io.onMessage((message) => {
      lastHeard = Date.now();
      switch (message?.t) {
        case 'ack':
          if (Number.isInteger(message.seq)) window.ack(message.seq);
          break;
        case 'keyframe':
          helper.send('k');
          break;
        case 'ping':
          io.send({ t: 'pong', id: Number(message.id) || 0, pc: Number(message.pc) || 0, mac: nowUs() });
          break;
        case 'size':
          helper.send(`s ${clampInt(message.maxSize, 480, 3000, 1400)}`);
          break;
        case 'input': {
          const event = message.event as InputEvent | undefined;
          if (!event) break;
          if (helperInput) void helperInput.push(event);
          else axeInput?.(event);
          break;
        }
      }
    });

    // Set from callbacks (the helper exiting, the stall check): ends the loop below.
    const ended: { failure: AgentError | null } = { failure: null };
    void helper.exited.then((exit) => {
      if (!stopping && !io.signal.aborted) ended.failure ??= helperFailure(exit, true);
    });
    let lastKeyAsk = 0;
    let lastCheck = Date.now();
    let lastStatus = Date.now();
    let lastFrames = 0;
    while (!io.signal.aborted && !ended.failure) {
      await sleep(100, io.signal);
      const now = Date.now();
      // Dropped frames to catch up: once the way is clear, restart from a keyframe.
      if (window.wantsKeyframe(io.backlog) && now - lastKeyAsk > 400) {
        helper.send('k');
        lastKeyAsk = now;
      }
      if (now - lastHeard > CLIENT_TIMEOUT_MS) break;
      if (now - lastCheck >= 1000) {
        lastCheck = now;
        void watch.check().then((stalled) => {
          if (!stalled) return;
          ended.failure ??= new AgentError(
            "The simulator's screen changed but the smooth stream saw nothing.",
            'STREAM_STALLED',
            'Restarting the simulator brings the smooth stream back.',
          );
        });
      }
      if (now - lastStatus >= 5000) {
        io.send({ t: 'stream-status', footprint, fps: Math.round(((frames - lastFrames) * 1000) / (now - lastStatus)), dropped: window.dropped + helperDropped });
        lastStatus = now;
        lastFrames = frames;
      }
    }
    if (ended.failure) throw ended.failure;
    return { frames, dropped: window.dropped + helperDropped };
  } finally {
    stopping = true;
    await helper.stop();
  }
}

/** The helper's state for this Mac's Xcode; `build` compiles it now (`force` retries after a failure). */
export async function opStreamHelper(params: { build?: boolean; force?: boolean }, io: AgentIO): Promise<StreamHelperState> {
  const env = await toolEnv();
  if (params.build) {
    try {
      const binary = await ensureHelper(HELPER_SOURCE, env, { force: params.force, signal: io.signal });
      return { state: 'ready', xcode: binary.xcode.version };
    } catch (err) {
      if (err instanceof AgentError && err.code === 'HELPER_BUILD_FAILED') return helperState(HELPER_SOURCE, env);
      throw err;
    }
  }
  return helperState(HELPER_SOURCE, env);
}
