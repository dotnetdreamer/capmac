/** Talking to the engine (through main) from the renderer. */
import type { EngineMethod, ErrorInfo, MethodParams, MethodResults } from '../../shared/contract';

/** An engine error with its hint and tool output intact. */
export class EngineCallError extends Error {
  constructor(readonly info: ErrorInfo) {
    super(info.message);
  }
}

export async function call<M extends EngineMethod>(method: M, params: MethodParams<M>): Promise<MethodResults[M]> {
  const result = await window.capmac.call(method, params);
  if (!result.ok) throw new EngineCallError(result.error);
  return result.value;
}

/** Any thrown value as an ErrorInfo (what to show the user). */
export function errorInfo(err: unknown): ErrorInfo {
  if (err instanceof EngineCallError) return err.info;
  const e = err as { message?: string; stack?: string } | undefined;
  const message = (e?.message ?? String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  return { message, expected: false, stack: e?.stack };
}

export function isCancelledError(err: unknown): boolean {
  return err instanceof EngineCallError && Boolean(err.info.cancelled);
}
