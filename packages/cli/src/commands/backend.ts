/**
 * `capmac backend`: where this project's iOS app builds, on a paired Mac or
 * on this PC with no Mac (WSL). `capmac backend wsl` picks it for `run`,
 * `dev`, `build` and `doctor`, and for CapMac Studio alike.
 */
import { backendIn, backendOf, chooseBackend, loadProject, type BuildBackend } from '@capmac/core/engine';
import { log, pc } from '../ui.js';

const WHERE: Record<BuildBackend, string> = { mac: 'on your paired Mac', wsl: 'on this PC, with no Mac (WSL)' };

let saved: Promise<BuildBackend> | undefined;

/** The backend a command uses: its --backend, else the project's pick, else the Mac. */
export function commandBackend(flag: unknown, app?: unknown): Promise<BuildBackend> {
  if (flag === 'mac' || flag === 'wsl') return Promise.resolve(flag);
  // An Electron app runs on the Mac's desktop, whatever builds the iOS app.
  if (app === 'electron') return Promise.resolve('mac');
  saved ??= backendIn(process.cwd()).catch(() => 'mac' as const);
  return saved;
}

export async function backendCommand(where: string | undefined, options: { json?: boolean }): Promise<void> {
  const project = await loadProject(process.cwd());
  const backend = where ? await chooseBackend(project, where) : await backendOf(project);
  if (options.json) {
    log.line(JSON.stringify({ backend }));
    return;
  }
  if (where) log.success(`${pc.bold(project.appName)} builds ${WHERE[backend]} from now on, in CapMac Studio too.`);
  else log.line(`${pc.bold(project.appName)} builds ${WHERE[backend]}.`);
  if (backend === 'wsl') log.dim('Set this PC up once with `capmac wsl setup`. Use `--backend mac` for one command on the Mac.');
  else log.dim('Build on this PC instead with `capmac backend wsl`.');
}
