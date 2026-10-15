/**
 * The smooth stream (v2): a screen as H.264 from capmac's helpers on the Mac,
 * relayed as binary frames without transcoding (helper/relay.ts).
 *
 * - `stream`: a simulator. The helper (simstream) is compiled on first use and
 *   also takes touch and keys (AXe when it has no input); a stall check
 *   notices a screen the helper stopped seeing.
 * - `device-stream`: an iPhone or iPad plugged into the Mac with a cable. The
 *   helper (devstream) runs as a background app, CapMac.app, so macOS can ask
 *   for camera access for it once (see helper/app.ts). It waits for the cable
 *   and for that answer as long as the client is there, and says so.
 *
 * When the call ends (the client closes the channel, or stops talking), the
 * helper stops too: no orphans.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceStreamParams, ScreenInfo, StreamHelperState, StreamParams } from '../../shared/protocol.js';
import { toolEnv } from '../env.js';
import { AppHelper } from '../helper/app.js';
import { ensureHelper, ensureScreenApp, helperState } from '../helper/build.js';
import { HelperInput } from '../helper/input.js';
import { HelperProcess, type HelperExit } from '../helper/process.js';
import { clampInt, StreamRelay } from '../helper/relay.js';
import { DEVICE_HELPER_SOURCE, HELPER_SOURCE } from '../helper/source.js';
import { StallWatch } from '../helper/stall.js';
import type { AgentIO } from '../io.js';
import { AgentError, run, sleep, which } from '../proc.js';
import { createAxeInput, setSimulatorPasteboard } from './screen.js';

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

  const watch = new StallWatch(() => screenFingerprint(params.udid, env, io.signal));
  const relay = new StreamRelay(io, params, watch);
  const helper = new HelperProcess(
    binary.path,
    [
      params.udid,
      '--developer-dir', binary.xcode.developerDir,
      '--max-size', String(clampInt(params.maxSize, 480, 3000, 1400)),
      '--fps', String(clampInt(params.fps, 10, 60, 60)),
      '--bitrate', String(relay.bitrate.current),
    ],
    { ...relay.handlers, onInputError: (message) => io.log('warn', `Input: ${message}`) },
    env,
  );
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

    relay.attach(helper, {
      failure: (exit) => helperFailure(exit, true),
      onInput: (event) => {
        if (helperInput) void helperInput.push(event);
        else axeInput?.(event);
      },
      stalled: () => new AgentError("The simulator's screen changed but the smooth stream saw nothing.", 'STREAM_STALLED', 'Restarting the simulator brings the smooth stream back.'),
    });
    return await relay.run();
  } finally {
    await relay.close();
    await helper.stop();
  }
}

/** What a device helper's last word means for the person looking at the screen. */
export function deviceFailure(exit: HelperExit, started: boolean, device: string): AgentError {
  switch (exit.fatal?.code) {
    case 'NO_PERMISSION':
      return new AgentError(
        `CapMac is not allowed to see ${device}'s screen.`,
        'DEVICE_SCREEN_DENIED',
        'On the Mac, open System Settings › Privacy & Security › Camera and turn on CapMac. Then try again.',
      );
    case 'CAPTURE_FAILED':
      return new AgentError(exit.fatal.message, 'HELPER_EXITED', 'Unplug the iPhone, plug it in again, and unlock it. QuickTime Player showing the same iPhone also gets in the way.', exit.stderr.slice(-8));
    default:
      return helperFailure(exit, started);
  }
}

/**
 * A plugged-in iPhone's screen: CapMac.app captures it on the Mac (built on
 * first use) and the relay sends it on like a simulator's. Stills (`still`)
 * are full-size PNGs from the newest picture. No input yet.
 */
export async function opDeviceStream(params: DeviceStreamParams, io: AgentIO): Promise<{ frames: number; dropped: number }> {
  const env = await toolEnv();
  const app = await ensureScreenApp(DEVICE_HELPER_SOURCE, env, {
    signal: io.signal,
    onBuild: () => io.send({ t: 'stream-prepare', stage: 'building' }),
  });
  if (io.signal.aborted) throw new AgentError('Cancelled', 'CANCELLED');
  io.send({ t: 'stream-prepare', stage: 'starting' });

  const device = params.name || 'The iPhone';
  const relay = new StreamRelay(io, params);
  // Stills go out reliably, in order with nothing else: a PNG is too big to drop and too rare to matter.
  let stills = Promise.resolve();
  const helper = await AppHelper.launch(
    app.path,
    [
      '--udid', params.udid,
      '--name', params.name ?? '',
      '--max-size', String(clampInt(params.maxSize, 480, 3000, 1400)),
      '--fps', String(clampInt(params.fps, 10, 60, 60)),
      '--bitrate', String(relay.bitrate.current),
    ],
    {
      ...relay.handlers,
      onStill: (message) => {
        stills = stills.then(() => io.sendBinary(message, true));
      },
      onEvent: (event) => {
        if (event.t === 'wait') io.send({ t: 'stream-wait', for: event.for });
        else if (event.t === 'resume') io.send({ t: 'stream-wait', for: null });
        else if (event.t === 'still-error') io.send({ t: 'still-error', message: event.message });
      },
    },
    env,
    io.signal,
  );
  let started = false;
  try {
    relay.attach(helper, {
      failure: (exit) => deviceFailure(exit, started, device),
      onInput: () => undefined,
      onMessage: (message) => {
        if (message?.t === 'still') helper.send('S');
      },
    });
    // Waits for the cable and for camera access as long as someone is looking.
    const hello = await relay.waitFor(helper.hello);
    if (!hello) {
      // The helper gave up before its picture came (camera access refused, the capture failed)…
      if (!helper.running && !io.signal.aborted) throw deviceFailure(await helper.exited, false, device);
      // …or the client went away while it waited: nothing to report.
      return { frames: 0, dropped: 0 };
    }
    started = true;
    io.send({ t: 'stream-wait', for: null });
    const info: ScreenInfo = {
      t: 'screen',
      source: 'device',
      codec: 'h264',
      points: hello.points ?? null,
      scale: hello.scale,
      input: false,
      inputReason: hello.inputReason,
    };
    io.send(info);
    io.send({ t: 'ready', data: { compiled: app.compiled, model: hello.model ?? null } });
    return await relay.run();
  } finally {
    await relay.close();
  }
}

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
