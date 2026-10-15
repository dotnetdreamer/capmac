/** Simulators and devices: live state, boot/shut down, screenshots. */
import type { AgentEvent, Target, TargetsResult } from '../shared/protocol.js';
import { parseStreamHeader, STREAM_FRAME, STREAM_HEADER_BYTES, STREAM_STILL } from '../shared/stream.js';
import type { AgentCall, CallHandlers } from './agent-client.js';
import { toErrorInfo, UserError, type ErrorInfo } from './errors.js';
import type { EngineContext } from './context.js';
import type { MacLink } from './link.js';
import type { MacSession } from './session.js';
import { AgentEventTranslator } from './translate.js';

/** Runs an agent operation and reports its events (steps, logs) to `ctx`. */
export async function callAgent<T>(session: MacSession, ctx: EngineContext, op: string, params: object = {}, handlers: CallHandlers = {}): Promise<T> {
  const translator = new AgentEventTranslator(ctx, op);
  try {
    return await session.call<T>(op, params, {
      ...handlers,
      onEvent: (event: AgentEvent) => {
        translator.handle(event);
        handlers.onEvent?.(event);
      },
    });
  } catch (err) {
    translator.closeOpenSteps(handlers.signal?.aborted ? 'cancelled' : 'failed');
    throw err;
  }
}

export function bootSimulator(session: MacSession, target: Target, ctx: EngineContext, show = false): Promise<{ booted: boolean }> {
  return callAgent(session, ctx, 'boot', { target, show });
}

export function shutdownSimulator(session: MacSession, target: Target, ctx: EngineContext): Promise<{ shutdown: boolean }> {
  return callAgent(session, ctx, 'shutdown', { target });
}

/** A full-resolution PNG of the simulator's screen. */
export async function takeScreenshot(session: MacSession, udid: string): Promise<{ png: Buffer; width: number | null; height: number | null }> {
  const chunks: Buffer[] = [];
  const result = await session.call<{ width: number | null; height: number | null }>('screenshot', { udid }, { onBinary: (chunk) => chunks.push(chunk) });
  return { png: Buffer.concat(chunks), width: result.width, height: result.height };
}

export interface DeviceScreenshotOptions {
  /** Waiting for the cable, or for Allow on the Mac (told once each). */
  onWait?(wait: 'device' | 'permission'): void;
  /** How long to wait for the cable and for Allow (default a minute). */
  waitMs?: number;
}

/**
 * A full-size PNG of an iPhone plugged into the Mac: CapMac.app opens its
 * screen (agent op `device-stream`), takes the first picture at the iPhone's
 * own size, and closes it again. The video itself is kept tiny: only the
 * still matters.
 */
export async function takeDeviceScreenshot(session: MacSession, target: Pick<Target, 'udid' | 'name'>, options: DeviceScreenshotOptions = {}): Promise<{ png: Buffer; width: number | null; height: number | null }> {
  const told = new Set<string>();
  let call: AgentCall<unknown> | null = null;
  let timer: NodeJS.Timeout | undefined;
  let pinger: NodeJS.Timeout | undefined;
  try {
    return await new Promise((resolve, reject) => {
      let asked = false;
      const done = (error: Error | null, png?: Buffer) => {
        if (error || !png) reject(error ?? new Error('No picture came.'));
        else resolve({ png, width: png.length > 24 ? png.readUInt32BE(16) : null, height: png.length > 24 ? png.readUInt32BE(20) : null });
      };
      timer = setTimeout(
        () => done(new UserError(`No picture came from ${target.name}.`, 'Plug it into the Mac with a cable, unlock it, and allow CapMac on the Mac if it asks.')),
        options.waitMs ?? 60_000,
      );
      session.agent
        .start('device-stream', { udid: target.udid, name: target.name, maxSize: 480, fps: 10, bitrate: 500_000, minBitrate: 300_000, maxBitrate: 1_000_000 }, {
          onEvent: (event) => {
            if (event.t === 'stream-wait' && event.for && !told.has(event.for)) {
              told.add(event.for);
              options.onWait?.(event.for);
            } else if (event.t === 'still-error') {
              // No picture yet: the next frame asks again.
              asked = false;
            }
          },
          onBinary: (data) => {
            const header = parseStreamHeader(data);
            if (header?.type === STREAM_FRAME && !asked) {
              asked = true;
              call?.send({ t: 'still' });
            } else if (header?.type === STREAM_STILL) {
              done(null, data.subarray(STREAM_HEADER_BYTES));
            }
          },
        })
        .then((started) => {
          call = started;
          // The op takes a client that stops talking for gone.
          pinger = setInterval(() => started.send({ t: 'ping', id: 0, pc: 0 }), 2000);
          started.result.then(
            () => done(new Error(`${target.name}'s screen closed before its picture came.`)),
            (err) => done(err instanceof Error ? err : new Error(String(err))),
          );
        }, reject);
    });
  } finally {
    clearTimeout(timer);
    clearInterval(pinger);
    (call as AgentCall<unknown> | null)?.cancel();
  }
}

/**
 * Keeps an up-to-date list of a Mac's simulators and devices (agent
 * `watch-targets`). Restarts by itself after a reconnect while running.
 */
export class TargetWatch {
  latest: TargetsResult | null = null;
  private call: AgentCall<unknown> | null = null;
  private active = false;
  private starting: Promise<void> | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly link: MacLink,
    private readonly onTargets: (targets: TargetsResult) => void,
    private readonly onError: (error: ErrorInfo) => void = () => undefined,
    private readonly intervals: { simulatorsEveryMs?: number; devicesEveryMs?: number } = {},
  ) {
    this.unsubscribe = link.onChange((state) => {
      if (state === 'lost') this.call = null;
      if ((state === 'restored' || state === 'connected') && this.active) void this.ensure();
    });
  }

  get running(): boolean {
    return this.call !== null;
  }

  start(): Promise<void> {
    this.active = true;
    return this.ensure();
  }

  private ensure(): Promise<void> {
    if (this.call) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const session = await this.link.session();
        const call = await session.agent.start('watch-targets', this.intervals, {
          onEvent: (event) => {
            if (event.t !== 'targets') return;
            this.latest = event.data;
            this.onTargets(event.data);
          },
        });
        if (!this.active) {
          call.cancel();
          return;
        }
        this.call = call;
        call.result.catch((err) => {
          const info = toErrorInfo(err);
          if (!info.cancelled && this.link.connected) this.onError(info);
        }).finally(() => {
          if (this.call === call) this.call = null;
        });
      } catch (err) {
        this.onError(toErrorInfo(err));
      }
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Restarts the watch so the next update comes right away (after boot/shutdown). */
  refresh(): void {
    if (!this.active) return;
    this.call?.cancel();
    this.call = null;
    void this.ensure();
  }

  stop(): void {
    this.active = false;
    this.call?.cancel();
    this.call = null;
  }

  dispose(): void {
    this.stop();
    this.unsubscribe();
  }
}
