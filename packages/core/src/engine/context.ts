/**
 * How engine code talks to its front end: it reports through `emit` and asks
 * through the `Prompter`. The CLI renders to the terminal and prompts with
 * readline; capmac Studio forwards events over IPC and asks with dialogs.
 */
import { CancelledError, isCancelled, UserError } from './errors.js';
import type { EngineEvent, LogLevel, Phase, StepStatus } from './events.js';

export interface PasswordRequest {
  /** Why the password is needed, which decides the dialog's wording. */
  purpose: 'pair' | 'keychain' | 'sudo';
  message: string;
  /** Friendly name of the Mac. */
  mac?: string;
  user?: string;
}

export interface ConfirmRequest {
  message: string;
  detail?: string;
  defaultYes?: boolean;
  /** Destructive action (red button in the UI). */
  danger?: boolean;
  /** Label for the "yes" button in the UI. */
  confirmLabel?: string;
}

export interface ChooseRequest<T> {
  message: string;
  items: Array<{ label: string; value: T; hint?: string }>;
}

export interface TextRequest {
  message: string;
  defaultValue?: string;
  placeholder?: string;
}

export interface Prompter {
  /** False in CI or without a terminal: the engine then fails with a hint instead of asking. */
  readonly interactive: boolean;
  /** Resolves with the secret; rejects with CancelledError when the user cancels. */
  password(request: PasswordRequest): Promise<string>;
  confirm(request: ConfirmRequest): Promise<boolean>;
  choose<T>(request: ChooseRequest<T>): Promise<T>;
  text(request: TextRequest): Promise<string>;
}

export interface EngineContext {
  emit(event: EngineEvent): void;
  prompter: Prompter;
  /** Full tool output wanted (the CLI's --verbose). */
  verbose: boolean;
}

const notInteractive = () => Promise.reject(new UserError('capmac needs an answer, but it cannot ask here (not an interactive terminal).'));

/** A prompter for CI and tests: every question fails, `confirm` says no. */
export const nonInteractivePrompter: Prompter = {
  interactive: false,
  password: notInteractive,
  confirm: async () => false,
  choose: notInteractive,
  text: notInteractive,
};

/** A context that drops every event (for helpers called outside a session). */
export function silentContext(prompter: Prompter = nonInteractivePrompter): EngineContext {
  return { emit: () => undefined, prompter, verbose: false };
}

export function log(ctx: EngineContext, level: LogLevel, message: string, hint?: string): void {
  ctx.emit({ type: 'log', level, message, hint });
}

export interface StepHandle {
  readonly id: string;
  readonly elapsed: number;
  update(text: string, done?: number): void;
  succeed(detail?: string): void;
  fail(detail?: string): void;
  skip(detail?: string): void;
  cancel(): void;
}

let nextStepId = 1;

/** Starts a titled, timed step (shown as a spinner line in the CLI, a timeline entry in the app). */
export function startStep(ctx: EngineContext, title: string, phase: Phase = 'other'): StepHandle {
  const id = `local-${nextStepId++}`;
  const started = Date.now();
  let done = false;
  ctx.emit({ type: 'step', id, title, phase });
  const end = (status: StepStatus, detail?: string) => {
    if (done) return;
    done = true;
    ctx.emit({ type: 'step-end', id, status, ms: Date.now() - started, detail });
  };
  return {
    id,
    get elapsed() {
      return Date.now() - started;
    },
    update(text, progress) {
      if (!done) ctx.emit({ type: 'step-progress', id, text, done: progress });
    },
    succeed: (detail) => end('ok', detail),
    fail: (detail) => end('failed', detail),
    skip: (detail) => end('skipped', detail),
    cancel: () => end('cancelled'),
  };
}

/** Runs `fn` as a step: succeeds with `detail(result)`, fails (or cancels) when it throws. */
export async function withStep<T>(
  ctx: EngineContext,
  title: string,
  phase: Phase,
  fn: (step: StepHandle) => Promise<T>,
  detail?: (value: T) => string | undefined,
): Promise<T> {
  const step = startStep(ctx, title, phase);
  try {
    const value = await fn(step);
    step.succeed(detail?.(value));
    return value;
  } catch (err) {
    if (isCancelled(err)) step.cancel();
    else step.fail();
    throw err;
  }
}

/** Rejects with CancelledError once `signal` aborts. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

/** Waits `ms`, resolving early (without error) when `signal` aborts. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
