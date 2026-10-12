/** Simulators and devices: live state, boot/shut down, screenshots. */
import type { AgentEvent, Target, TargetsResult } from '../shared/protocol.js';
import type { AgentCall, CallHandlers } from './agent-client.js';
import { toErrorInfo, type ErrorInfo } from './errors.js';
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
