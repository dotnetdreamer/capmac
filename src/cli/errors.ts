/** An expected failure with a friendly message and an optional "how to fix" hint. */
export class UserError extends Error {
  constructor(message: string, readonly hint?: string, readonly details?: string[]) {
    super(message);
  }
}

export function isCancelled(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  return e?.code === 'CANCELLED' || e?.message === 'Cancelled';
}
