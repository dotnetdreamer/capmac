import { loadProject, MacSession, type ProjectInfo } from '@capmac/core/engine';
import { log } from './ui.js';

/** Installs a Ctrl+C handler: first press cancels gracefully, second exits. */
export function cancelOnSigint(controller: AbortController, message = 'Stopping…'): () => void {
  let presses = 0;
  const handler = () => {
    presses += 1;
    if (presses === 1) {
      log.line();
      log.dim(message);
      controller.abort();
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}

export interface MacOption {
  mac?: string;
}

/** Loads the project in the current folder and connects to its Mac. */
export async function openForProject(options: MacOption): Promise<{ project: ProjectInfo; session: MacSession }> {
  const project = await loadProject(process.cwd());
  const session = await MacSession.open({ host: options.mac ?? project.config.host });
  return { project, session };
}
