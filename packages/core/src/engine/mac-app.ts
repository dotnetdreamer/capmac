/**
 * A native Mac app CapMac built and launched on the Mac with its module in it
 * (a Flutter or React Native app's Mac app): behind whatever the Mac shows,
 * its window in CapMac Studio's pane and the CLI's viewer, its output in the
 * console. The agent's `mac-app-launch` op (or a framework's own variant of
 * it) runs it until it quits or is stopped.
 */
import type { PathMapper } from '../shared/paths.js';
import type { AgentEvent, MacAppLaunchResult } from '../shared/protocol.js';
import { AgentCallError } from './agent-client.js';
import { log, startStep, type EngineContext } from './context.js';
import { CancelledError, isCancelled, UserError } from './errors.js';
import type { AppLogEntry } from './events.js';
import type { MacSession } from './session.js';
import { AgentEventTranslator } from './translate.js';

/** A Mac app CapMac launched on the Mac. */
export interface LaunchedMacApp {
  /** Its window is open (or it has run a while without one). */
  readonly ready: Promise<void>;
  readonly done: Promise<MacAppLaunchResult>;
  stop(): void;
}

export interface MacAppLaunch {
  /** The agent op that launches it, and its parameters. */
  op: string;
  params: object;
  /** For titles and the app's states. */
  appName: string;
  bundleId?: string;
  /** Where it runs ("IK's M1"). */
  where: string;
  mapper: PathMapper | null;
  /** One of the app's lines as a console entry (null: not one to show). */
  logEntry: (text: string, stream: 'stdout' | 'stderr') => AppLogEntry | null;
  /** A framework's own events (Flutter's Dart VM address); true when handled. */
  onEvent?: (event: AgentEvent) => boolean;
}

/** An agent error as a UserError with its messages (paths as this PC's). */
export function agentErrorToUser(err: unknown, mapper: PathMapper | null): unknown {
  if (err instanceof AgentCallError) {
    const tail = (err.tail ?? []).map((line) => (mapper ? mapper.mapText(line) : line));
    return Object.assign(new UserError(err.message, err.hint, tail.length ? tail : undefined), err.code ? { code: err.code } : {});
  }
  return err;
}

/** Launches the built app behind whatever the Mac shows; its window shows in CapMac, its output in the console. */
export async function launchMacApp(session: MacSession, launch: MacAppLaunch, ctx: EngineContext, signal?: AbortSignal): Promise<LaunchedMacApp> {
  const { appName, bundleId, where, mapper } = launch;
  const step = startStep(ctx, `Launching ${appName}`, 'launch');
  let running = false;
  let markReady!: () => void;
  let failReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  ready.catch(() => undefined);
  const translator = new AgentEventTranslator(ctx, launch.op, mapper);
  const call = await session.agent.start<MacAppLaunchResult>(launch.op, launch.params, {
    signal,
    onEvent: (event) => {
      if (launch.onEvent?.(event)) return;
      if (event.t === 'ready') {
        if (running) return;
        running = true;
        step.succeed();
        ctx.emit({ type: 'app', state: 'running', name: appName, bundleId, target: where });
        markReady();
      } else if (event.t === 'app') {
        const entry = launch.logEntry(mapper ? mapper.mapText(event.text) : event.text, event.stream);
        if (entry) ctx.emit({ type: 'app-log', entry });
      } else if (event.t === 'electron') {
        if (event.event.e === 'note') log(ctx, 'note', event.event.message);
      } else {
        translator.handle(event);
      }
    },
  });
  const done = call.result.then(
    (result) => {
      if (!running) {
        if (result.reason === 'cancelled') step.cancel();
        else step.fail();
        failReady(result.reason === 'cancelled' ? new CancelledError() : new UserError('The Mac app quit before its window opened.'));
      } else {
        ctx.emit({ type: 'app', state: result.reason === 'cancelled' ? 'stopped' : 'exited', name: appName, bundleId, target: where, exitCode: result.exitCode });
      }
      return result;
    },
    (err) => {
      const error = agentErrorToUser(err, mapper);
      if (!running) {
        if (isCancelled(err)) step.cancel();
        else step.fail();
      }
      translator.closeOpenSteps(isCancelled(err) ? 'cancelled' : 'failed');
      failReady(error);
      throw error;
    },
  );
  done.catch(() => undefined);
  return { ready, done, stop: () => call.cancel() };
}
