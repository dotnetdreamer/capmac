/** An expected failure with a friendly message and an optional "how to fix" hint. */
export class UserError extends Error {
  readonly expected = true;
  constructor(message: string, readonly hint?: string, readonly details?: string[]) {
    super(message);
  }
}

/** Thrown when the user cancels (Ctrl+C, Stop, a dismissed prompt). */
export class CancelledError extends Error {
  readonly code = 'CANCELLED';
  constructor(message = 'Cancelled') {
    super(message);
  }
}

export function isCancelled(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  return e?.code === 'CANCELLED' || e?.message === 'Cancelled';
}

/** Everything a front end needs to show an error: what happened, why, how to fix it. */
export interface ErrorInfo {
  message: string;
  hint?: string;
  /** Last lines of tool output, for context. */
  details?: string[];
  code?: string;
  cancelled?: boolean;
  /** False for unexpected errors (bugs); the UI then offers "copy details" instead of a fix. */
  expected: boolean;
  /** Stack trace of an unexpected error (shown only on request). */
  stack?: string;
}

/**
 * Converts any thrown value into an ErrorInfo. capmac's own errors (UserError,
 * SshError, AgentCallError, ProjectError) are "expected" and carry a hint or
 * tool output; anything else is reported as an unexpected problem.
 */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (isCancelled(err)) return { message: 'Cancelled', cancelled: true, code: 'CANCELLED', expected: true };
  const e = err as { message?: string; hint?: string; details?: string[]; tail?: string[]; code?: unknown; stack?: string; expected?: boolean } | undefined;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const details = e?.details ?? e?.tail;
  const expected = e?.expected === true || typeof e?.hint === 'string';
  return {
    message: e?.message ?? String(err),
    hint: e?.hint,
    details: details?.length ? details : undefined,
    code,
    expected,
    stack: expected ? undefined : e?.stack,
  };
}
