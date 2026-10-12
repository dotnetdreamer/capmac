import { AgentCallError } from './agent-client.js';
import { isCancelled, UserError } from './errors.js';
import { ProjectError } from './project.js';
import { SshError } from './ssh.js';
import { clearStatus, isVerbose, log, pc } from './ui.js';

/** Prints any error the way a developer wants to read it: what, why, how to fix. */
export function reportError(err: unknown): void {
  clearStatus();
  if (isCancelled(err)) {
    log.dim('Cancelled.');
    return;
  }
  if (err instanceof UserError || err instanceof SshError || err instanceof ProjectError || err instanceof AgentCallError) {
    log.error(err.message);
    const details = err instanceof UserError ? err.details : err instanceof AgentCallError ? err.tail : undefined;
    if (details?.length) {
      log.line(pc.dim('  ┌ last output'));
      for (const line of details) log.line(`${pc.dim('  │')} ${line}`);
      log.line(pc.dim('  └'));
    }
    if (err.hint) log.line(`  ${pc.cyan('→')} ${err.hint}`);
    return;
  }
  const e = err as Error;
  log.error(e?.message ?? String(err));
  if (isVerbose() && e?.stack) log.dim(e.stack);
  else log.dim('  (run with --verbose for details)');
}
