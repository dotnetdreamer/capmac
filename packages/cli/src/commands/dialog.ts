import { answerAppDialog, listAppDialogs, loadProject, MacSession, requireElectron, UserError } from '@capmac/core/engine';
import type { AppDialog, AppDialogAnswer } from '@capmac/core/shared/electron';
import { dialogLines, macPath, resolveMacPath, withSaveExtension } from '../terminal.js';
import { log, pc } from '../ui.js';

export interface DialogOptions {
  mac?: string;
  json?: boolean;
  /** Cancel it (Escape on a message box, Cancel on a file dialog). */
  cancel?: boolean;
  /** Tick (or untick) the message box's checkbox with the answer. */
  check?: boolean;
  /** Which dialog (default: the oldest). */
  id?: string;
}

/** The answer typed on the command line, for this dialog. */
export function answerFor(dialog: AppDialog, answer: string | undefined, options: DialogOptions): AppDialogAnswer {
  if (dialog.kind === 'message') {
    const buttons = dialog.buttons.length ? dialog.buttons : ['OK'];
    let response = options.cancel ? dialog.cancelId : dialog.defaultId;
    if (!options.cancel && answer !== undefined) {
      const byNumber = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
      const byLabel = buttons.findIndex((b) => b.toLowerCase() === answer.toLowerCase());
      response = byNumber >= 0 && byNumber < buttons.length ? byNumber : byLabel;
      if (response < 0) throw new UserError(`“${answer}” is not one of the buttons.`, `Pick 1-${buttons.length} or a label: ${buttons.map((b) => `“${b}”`).join(', ')}.`);
    }
    return { kind: 'message', response, checkboxChecked: options.check ? !dialog.checkboxChecked : dialog.checkboxChecked };
  }
  if (options.cancel) return { kind: 'files', paths: [] };
  // A path on this PC: typed by mistake, or made one by Git Bash (it turns /tmp/x into C:/…/Temp/x).
  if (answer !== undefined && /(^|;)\s*[A-Za-z]:[\\/]/.test(answer)) {
    throw new UserError(`“${answer}” is a path on this PC, and the app runs on the Mac.`, 'Give a path on the Mac, like `~/Documents/photo.png`. In Git Bash, start a full path with // (`//tmp/photo.png`) so it stays as typed.');
  }
  const suggested = dialog.kind === 'save' && dialog.defaultPath ? dialog.defaultPath : '';
  if (answer === undefined && !suggested) throw new UserError('Say which path on the Mac to use.', 'For example `capmac dialog "~/Documents/photo.png"`, or `capmac dialog --cancel`.');
  const base = dialog.defaultPath ? macPath(dialog.defaultPath, dialog.home) : dialog.home;
  const folder = dialog.kind === 'save' || /\.[^/]+$/.test(base) ? base.replace(/\/[^/]*$/, '') || '/' : base;
  const typed = answer === undefined ? [suggested] : dialog.kind === 'open' && dialog.properties.includes('multiSelections') ? answer.split(';') : [answer];
  return { kind: 'files', paths: typed.map((p) => resolveMacPath(p, folder, dialog.home)).filter(Boolean).map((p) => withSaveExtension(dialog, p)) };
}

/** `capmac dialog [answer]`: the running Electron app's dialogs, and an answer to the oldest (or `--id`). */
export async function dialogCommand(answer: string | undefined, options: DialogOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  requireElectron(project);
  const session = await MacSession.open({ host: options.mac ?? project.config.host });
  try {
    const dialogs = await listAppDialogs(session, project.projectId);
    const answering = answer !== undefined || options.cancel || options.check;
    if (!answering) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(dialogs, null, 2)}\n`);
        return;
      }
      if (dialogs.length === 0) {
        log.info(`${project.electron?.name ?? project.appName} has no dialog waiting for an answer.`);
        return;
      }
      for (const dialog of dialogs) for (const line of dialogLines(dialog, dialogs.length > 1)) log.raw(line);
      log.dim(`  Answer with ${pc.cyan('capmac dialog <button number or label>')}, ${pc.cyan('capmac dialog "<path on the Mac>"')} or ${pc.cyan('capmac dialog --cancel')}.`);
      return;
    }
    const dialog = options.id ? dialogs.find((d) => d.id === Number(options.id)) : dialogs[0];
    if (!dialog) throw new UserError(options.id ? `No dialog #${options.id} is open.` : 'The app has no dialog waiting for an answer.', 'See what is open with `capmac dialog`.');
    const reply = answerFor(dialog, answer, options);
    await answerAppDialog(session, project.projectId, dialog.id, reply);
    if (reply.kind === 'message') log.success(`Answered “${(dialog.kind === 'message' && dialog.buttons[reply.response]) || 'OK'}”`);
    else log.success(reply.paths.length ? `Picked ${reply.paths.join(', ')}` : 'Cancelled the dialog');
  } finally {
    session.close();
  }
}
