/** A remote-access failure with a message for people and, usually, how to fix it. */
export class RemoteError extends Error {
  readonly expected = true;
  constructor(message: string, readonly hint?: string, readonly code?: string, readonly details?: string[]) {
    super(message);
  }
}
