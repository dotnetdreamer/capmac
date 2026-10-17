/**
 * The CLI's front end for the engine: renders engine events to the terminal
 * (spinner steps, app logs, `file:line:col: error:` diagnostics) and answers
 * the engine's questions with readline prompts.
 */
import type { AppLogEntry, ChooseRequest, ConfirmRequest, EngineContext, EngineEvent, Phase, Prompter } from '@capmac/core/engine';
import { describeTarget } from '@capmac/core/engine';
import type { AppDialog, AppDialogAnswer } from '@capmac/core/shared/electron';
import type { Diagnostic } from '@capmac/core/shared/protocol';
import { printErrorInfo } from './report.js';
import { ask, askUnless, canPrompt, confirm, isVerbose, log, password, pc, plural, select, step, type Step } from './ui.js';

export interface TerminalOptions {
  /** Show Capacitor bridge traffic ("To Native ->", "TO JS"). */
  bridge?: boolean;
  /** Show warnings from Pods / Swift packages / node_modules too. */
  allWarnings?: boolean;
  /** Which command is running, for wording ("press l to relaunch"). */
  mode?: 'run' | 'dev' | 'other';
  /** `run` streams app logs (vs `--no-logs`). */
  attach?: boolean;
  /** An iOS app (the default) or an Electron app on the Mac's desktop: decides labels and wording. */
  platform?: 'ios' | 'electron';
}

const URL = /\bhttps?:\/\/[^\s'"`)]+/g;

/** Colours URLs in a message, like the CLI always did. */
function highlight(text: string): string {
  return text.replace(URL, (url) => pc.cyan(url));
}

export class TerminalReporter {
  private readonly steps = new Map<string, { step: Step; phase: Phase }>();
  private hiddenWarnings = 0;
  private tunnelAnnounced = false;
  errors = 0;
  warnings = 0;
  readonly diagnostics: Diagnostic[] = [];
  /** Called when the app reports it is running (dev mode prints its key help here). */
  onAppRunning: (() => void) | null = null;
  /** Extra consumer for app log lines (the browser screen viewer's console). */
  onAppLog: ((entry: AppLogEntry) => void) | null = null;
  /** Answers an Electron app's dialog (`run` and `dev` set it): the terminal asks when it has a keyboard. */
  onDialogAnswer: ((dialog: AppDialog, answer: AppDialogAnswer) => Promise<void>) | null = null;
  private readonly openDialogs = new Map<number, AppDialog>();
  /** Dialogs answered in this terminal (already said). */
  private readonly answeredHere = new Set<number>();
  private asking: { id: number; abort: AbortController } | null = null;

  constructor(private readonly options: TerminalOptions = {}) {}

  handle = (event: EngineEvent): void => {
    switch (event.type) {
      case 'step':
        // Launching is announced by the "is running" line instead.
        if (event.phase !== 'launch') this.steps.set(event.id, { step: step(event.title), phase: event.phase });
        break;
      case 'step-progress':
        this.steps.get(event.id)?.step.update(event.text);
        break;
      case 'step-end': {
        const entry = this.steps.get(event.id);
        if (!entry) break;
        this.steps.delete(event.id);
        if (event.status === 'ok') entry.step.succeed(event.detail);
        else if (event.status === 'skipped') entry.step.skip(event.detail);
        else entry.step.fail(event.detail);
        if (entry.phase === 'build' && event.status === 'ok' && this.hiddenWarnings > 0) {
          log.dim(`  ${plural(this.hiddenWarnings, 'warning')} from dependencies hidden (show with --all-warnings)`);
          this.hiddenWarnings = 0;
        }
        break;
      }
      case 'log': {
        const text = highlight(event.message);
        if (event.level === 'debug') log.debug(event.message);
        else if (event.level === 'note') log.dim(event.message);
        else if (event.level === 'success') log.success(text);
        else if (event.level === 'warn') log.warn(event.message);
        else if (event.level === 'error') log.error(event.message);
        else log.info(text);
        if (event.hint) log.line(`  ${pc.cyan('→')} ${event.hint}`);
        break;
      }
      case 'error':
        printErrorInfo(event.error);
        if (this.options.mode === 'dev' && !event.error.cancelled) log.dim(`  Fix the problem and save, or press ${pc.bold('r')} to retry.`);
        break;
      case 'tool-output':
        if (isVerbose()) log.dim(`  ${event.text}`);
        break;
      case 'devserver-output':
        log.raw(`${pc.dim(this.options.platform === 'electron' ? 'dev │' : 'web │')} ${event.text}`);
        break;
      case 'diagnostic':
        this.diagnostic(event.diagnostic);
        break;
      case 'app-log':
        this.appLine(event.entry);
        break;
      case 'target':
        log.info(`Target: ${pc.bold(describeTarget(event.target))}`);
        break;
      case 'devserver':
        log.success(`Dev server: ${pc.cyan(event.url)}`);
        break;
      case 'tunnel':
        if (event.state === 'up' && !this.tunnelAnnounced && event.liveUrl) {
          this.tunnelAnnounced = true;
          log.success(`Live reload: the app loads ${pc.cyan(event.liveUrl)} ${pc.dim(`→ tunnel → ${event.localUrl ?? 'the dev server'} on this PC`)}`);
        }
        break;
      case 'app':
        this.appState(event);
        break;
      case 'app-dialogs':
        this.dialogsChanged(event);
        break;
      case 'build-reused':
        log.dim('  Native code unchanged: reused the previous build.');
        break;
      case 'build-log':
        log.debug(`build log on the Mac: ${event.path}`);
        break;
      case 'native-change': {
        const shown = event.paths.slice(0, 3).join(', ') + (event.paths.length > 3 ? ` +${event.paths.length - 3} more` : '');
        log.info(`Native change (${shown}) → rebuilding`);
        break;
      }
      case 'connection': {
        // Over the internet, say so (on the local network nothing changes).
        const via = event.route === 'direct' ? ' peer to peer over the internet' : event.route === 'relay' ? ' through the relay' : '';
        const rtt = via && event.rttMs !== undefined ? pc.dim(` (${event.rttMs} ms)`) : '';
        // Only live reload (dev) dials back in by itself.
        if (event.state === 'lost') log.warn(this.options.mode === 'dev' ? `Lost the connection to ${event.label}. Reconnecting…` : `Lost the connection to ${event.label}.`);
        else if (event.state === 'reconnecting' && event.attempt && (event.attempt === 1 || event.attempt % 10 === 0)) log.dim(`  still trying to reach the Mac… (${event.error ?? 'no answer'})`);
        else if (event.state === 'restored') log.success(`Reconnected to ${event.label}${via}${rtt}`);
        else if (event.state === 'connected' && via) log.dim(`  Connected to ${event.label}${via}${rtt}`);
        break;
      }
      default:
        break;
    }
  };

  private appState(event: Extract<EngineEvent, { type: 'app' }>): void {
    const name = pc.bold(event.name ?? 'The app');
    if (event.state === 'running') {
      if (this.options.mode === 'dev' && this.options.platform === 'electron') {
        log.success(`${name} is running on ${event.target} ${pc.dim('· edit your code and CapMac reloads it')}`);
      } else if (this.options.mode === 'dev') {
        log.success(`${name} is running on ${event.target} ${pc.dim('· edit your web code and it reloads instantly')}`);
      } else {
        log.success(`${name} is running on ${event.target}${this.options.attach !== false ? pc.dim('  (app logs below · Ctrl+C to stop)') : ''}`);
      }
      this.onAppRunning?.();
    } else if (event.state === 'exited') {
      const code = event.exitCode !== null && event.exitCode !== undefined ? ` (code ${event.exitCode})` : '';
      log.info(`The app exited${code}.${this.options.mode === 'dev' ? ` Press ${pc.bold('l')} to relaunch.` : ''}`);
    } else if (event.state === 'stopped' && this.options.mode === 'run') {
      log.dim('Stopped.');
    }
  }

  // ─── An Electron app's dialogs ───────────────────────────────────────────

  private dialogsChanged(event: Extract<EngineEvent, { type: 'app-dialogs' }>): void {
    const open = new Set(event.dialogs.map((d) => d.id));
    for (const [id, dialog] of this.openDialogs) {
      if (open.has(id)) continue;
      this.openDialogs.delete(id);
      if (this.asking?.id === id) {
        this.asking.abort.abort();
        this.asking = null;
      }
      if (this.answeredHere.delete(id)) continue;
      const how = event.closed?.id === id ? event.closed.how : 'app';
      if (how === 'answered') log.dim(`  ${dialog.app || 'The app'}’s dialog was answered in the window viewer`);
      else if (how === 'mac') log.info(`${dialog.app || 'The app'}’s dialog is on the Mac now: someone switched to the app there`);
      else log.dim(`  ${dialog.app || 'The app'} closed its dialog`);
    }
    for (const dialog of event.dialogs) {
      if (this.openDialogs.has(dialog.id)) continue;
      this.openDialogs.set(dialog.id, dialog);
      this.printDialog(dialog);
    }
    void this.askNext();
  }

  private printDialog(dialog: AppDialog): void {
    for (const line of dialogLines(dialog)) log.raw(line);
    if (!this.onDialogAnswer || !canPrompt()) {
      log.raw(pc.dim(`    Answer it over the app’s window (${this.options.mode === 'dev' ? `press ${pc.bold('o')}` : pc.cyan('capmac screen --electron')}), with ${pc.cyan('capmac dialog')}, or on the Mac.`));
    }
  }

  /** Asks about the oldest open dialog, one at a time. */
  private async askNext(): Promise<void> {
    if (this.asking || !this.onDialogAnswer || !canPrompt()) return;
    // Answered here already: it goes once the app says so.
    const dialog = [...this.openDialogs.values()].find((d) => !this.answeredHere.has(d.id));
    if (!dialog) return;
    const abort = new AbortController();
    this.asking = { id: dialog.id, abort };
    try {
      const answer = await this.askDialog(dialog, abort.signal);
      if (!answer || abort.signal.aborted) return;
      this.answeredHere.add(dialog.id);
      await this.onDialogAnswer(dialog, answer).then(
        () => log.success(dialog.kind === 'message' ? `Answered “${(dialog.buttons[answer.kind === 'message' ? answer.response : 0] ?? 'OK')}”` : answer.kind === 'files' && answer.paths.length ? `Picked ${answer.paths.join(', ')}` : 'Cancelled the dialog'),
        (err: Error) => {
          this.answeredHere.delete(dialog.id);
          log.warn(`Could not answer the dialog: ${err.message}`);
        },
      );
    } finally {
      if (this.asking?.abort === abort) this.asking = null;
      if ([...this.openDialogs.keys()].some((id) => !this.answeredHere.has(id))) setImmediate(() => void this.askNext());
    }
  }

  private async askDialog(dialog: AppDialog, signal: AbortSignal): Promise<AppDialogAnswer | null> {
    if (dialog.kind === 'message') {
      const buttons = dialog.buttons.length ? dialog.buttons : ['OK'];
      const tick = dialog.checkboxLabel ? pc.dim(`, add + to ${dialog.checkboxChecked ? 'untick' : 'tick'} “${dialog.checkboxLabel}”`) : '';
      for (;;) {
        const reply = await askUnless(`Answer 1-${buttons.length} (Enter: ${buttons[dialog.defaultId] ?? buttons[0]}${tick}):`, signal);
        if (reply === null) return null;
        const toggled = reply.endsWith('+');
        const choice = reply.replace(/\+$/, '').trim();
        const response = choice === '' ? dialog.defaultId : Number(choice) - 1;
        if (Number.isInteger(response) && response >= 0 && response < buttons.length) {
          return { kind: 'message', response, checkboxChecked: toggled ? !dialog.checkboxChecked : dialog.checkboxChecked };
        }
        log.warn(`Type a number from 1 to ${buttons.length}.`);
      }
    }
    const suggested = dialog.kind === 'save' && dialog.defaultPath ? macPath(dialog.defaultPath, dialog.home) : '';
    const multiple = dialog.kind === 'open' && dialog.properties.includes('multiSelections');
    const question = dialog.kind === 'save'
      ? suggested ? `Path on the Mac (Enter: ${suggested}, - to cancel):` : 'Path on the Mac (Enter to cancel):'
      : `Path on the Mac${multiple ? ', several with ;' : ''} (Enter to cancel):`;
    const reply = await askUnless(question, signal);
    if (reply === null) return null;
    if (reply === '-' || (reply === '' && !suggested)) return { kind: 'files', paths: [] };
    const typed = reply === '' ? [suggested] : multiple ? reply.split(';') : [reply];
    const base = dialog.defaultPath ? macPath(dialog.defaultPath, dialog.home) : dialog.home;
    const baseFolder = dialog.kind === 'save' || /\.[^/]+$/.test(base) ? base.replace(/\/[^/]*$/, '') || '/' : base;
    return { kind: 'files', paths: typed.map((p) => resolveMacPath(p, baseFolder, dialog.home)).filter(Boolean).map((p) => withSaveExtension(dialog, p)) };
  }

  diagnostic(diag: Diagnostic): void {
    this.diagnostics.push(diag);
    if (diag.severity === 'error') this.errors += 1;
    if (diag.severity === 'warning') this.warnings += 1;
    if (diag.severity !== 'error' && !diag.own && !this.options.allWarnings && !isVerbose()) {
      if (diag.severity === 'warning') this.hiddenWarnings += 1;
      return;
    }
    const color = diag.severity === 'error' ? pc.red : diag.severity === 'warning' ? pc.yellow : pc.cyan;
    const location = diag.file ? `${diag.file}${diag.line ? `:${diag.line}` : ''}${diag.column ? `:${diag.column}` : ''}: ` : '';
    // "file:line:col: error: message" — clickable in VS Code and matched by the $gcc problem matcher.
    log.raw(`${location}${color(`${diag.severity}:`)} ${diag.message}`);
    for (const line of diag.context ?? []) log.raw(pc.dim(`    ${line}`));
  }

  appLine(entry: AppLogEntry): void {
    this.onAppLog?.(entry);
    if (entry.kind === 'bridge' && !this.options.bridge) return;
    switch (entry.kind) {
      case 'console': {
        const badge = entry.level === 'error' ? pc.red('js ✖') : entry.level === 'warn' ? pc.yellow('js ▲') : entry.level === 'info' ? pc.cyan('js  ') : entry.level === 'debug' ? pc.dim('js  ') : pc.blue('js  ');
        const text = entry.level === 'error' ? pc.red(entry.text) : entry.level === 'warn' ? pc.yellow(entry.text) : entry.level === 'debug' ? pc.dim(entry.text) : entry.text;
        // A page's errors say where they came from (a file on this PC, clickable in VS Code).
        const where = entry.source && (entry.level === 'error' || entry.level === 'warn') ? pc.dim(`  ${entry.source}`) : '';
        log.raw(`${badge} ${text}${where}`);
        break;
      }
      case 'main': {
        const text = entry.level === 'error' ? pc.red(entry.text) : entry.level === 'warn' ? pc.yellow(entry.text) : entry.text;
        log.raw(`${pc.magenta('main')} ${text}`);
        break;
      }
      case 'capacitor':
        log.raw(`${pc.magenta('cap ')} ${entry.level === 'error' ? pc.red(entry.text) : pc.dim(entry.text)}`);
        break;
      case 'bridge':
        log.raw(`${pc.dim('↔   ')} ${pc.dim(entry.text)}`);
        break;
      case 'electron':
        // Chromium inside Electron logs its own notices; most are noise unless they are errors.
        if (entry.level === 'debug' && !isVerbose()) return;
        log.raw(`${pc.dim('elec')} ${entry.level === 'error' ? pc.red(entry.text) : entry.level === 'warn' ? pc.yellow(entry.text) : entry.text}`);
        break;
      default:
        log.raw(`${pc.dim('ios ')} ${entry.level === 'error' ? pc.red(entry.text) : entry.text}`);
    }
  }
}

/** What a dialog shows, as terminal lines (its id first when `withId`). */
export function dialogLines(dialog: AppDialog, withId = false): string[] {
  const lines: string[] = [];
  const app = pc.bold(dialog.app || 'The app');
  const id = withId ? pc.dim(`#${dialog.id} `) : '';
  if (dialog.kind === 'message') {
    const mark = dialog.type === 'error' ? pc.red('✖') : dialog.type === 'warning' ? pc.yellow('▲') : pc.cyan('?');
    lines.push(`${mark} ${id}${app} asks: ${dialog.message || dialog.title || '(no message)'}`);
    if (dialog.title && dialog.message) lines.push(pc.dim(`    ${dialog.title}`));
    for (const line of dialog.detail.split('\n').filter(Boolean)) lines.push(pc.dim(`    ${line}`));
    const buttons = dialog.buttons.length ? dialog.buttons : ['OK'];
    lines.push(`    ${buttons.map((b, i) => `${pc.cyan(`${i + 1})`)} ${i === dialog.defaultId ? pc.bold(b) : b}`).join('   ')}`);
    if (dialog.checkboxLabel) lines.push(pc.dim(`    [${dialog.checkboxChecked ? 'x' : ' '}] ${dialog.checkboxLabel}`));
  } else {
    const what = dialog.kind === 'save'
      ? 'a place to save a file'
      : dialog.properties.includes('openDirectory') ? (dialog.properties.includes('openFile') ? 'a file or folder' : 'a folder') : dialog.properties.includes('multiSelections') ? 'files to open' : 'a file to open';
    lines.push(`${pc.cyan('?')} ${id}${app} wants ${what}${dialog.title ? `: ${dialog.title}` : ''}`);
    if (dialog.message) lines.push(pc.dim(`    ${dialog.message}`));
    const types = dialog.filters.map((f) => (f.extensions.includes('*') || f.extensions.length === 0 ? f.name : `${f.name} (${f.extensions.join(', ')})`)).join(' · ');
    if (types) lines.push(pc.dim(`    Types: ${types}`));
    if (dialog.defaultPath) lines.push(pc.dim(`    ${dialog.kind === 'save' ? 'Suggested' : 'Starts in'}: ${macPath(dialog.defaultPath, dialog.home)}`));
  }
  if (dialog.blocking) lines.push(pc.dim('    The app waits until it is answered.'));
  return lines;
}

/** Saving with a file type and no extension typed: the type's, as the Mac's save panel adds it. */
export function withSaveExtension(dialog: AppDialog, file: string): string {
  if (dialog.kind !== 'save') return file;
  const extensions = dialog.filters[0]?.extensions ?? [];
  if (!extensions.length || extensions.includes('*') || /\.[^/.]+$/.test(file)) return file;
  return `${file}.${extensions[0]}`;
}

/** A Mac path as typed back: the home folder as "~". */
export function macPath(p: string, home: string): string {
  if (p.startsWith('~')) return p;
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/** A path typed in the terminal, as a full path on the Mac ("~/x", "/x", or relative to `base`). */
export function resolveMacPath(typed: string, base: string, home: string): string {
  let p = typed.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!p) return '';
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  else if (!p.startsWith('/')) p = `${(base.startsWith('~') ? home + base.slice(1) : base).replace(/\/+$/, '')}/${p}`;
  // Tidy "a/./b" and "a/../b" the POSIX way.
  const parts: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Answers the engine's questions in the terminal. */
export class TerminalPrompter implements Prompter {
  get interactive(): boolean {
    return canPrompt();
  }

  password(request: { message: string }): Promise<string> {
    return password(request.message);
  }

  async confirm(request: ConfirmRequest): Promise<boolean> {
    // The detail lists what a "yes" will do, so it is shown before the question.
    if (request.detail) for (const line of request.detail.split('\n')) log.line(`  ${pc.dim(line)}`);
    if (!request.waiting && !request.signal) return confirm(request.message, request.defaultYes ?? true);
    // CapMac may take this question back: it goes on by itself once what it waits for happens.
    if (request.waiting) log.line(`  ${pc.cyan('…')} ${request.waiting}`);
    const choices = pc.dim(`(y: ${request.confirmLabel ?? 'yes'}, n: ${request.cancelLabel ?? 'no'})`);
    for (;;) {
      const reply = await askUnless(`${request.message} ${choices}`, request.signal ?? new AbortController().signal);
      if (reply === null) return false;
      const answer = reply.toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      if (!answer && !request.waiting) return request.defaultYes ?? true;
    }
  }

  choose<T>(request: ChooseRequest<T>): Promise<T> {
    if (request.detail) for (const line of request.detail.split('\n')) log.line(`  ${pc.dim(line)}`);
    return select(request.message, request.items);
  }

  text(request: { message: string; defaultValue?: string }): Promise<string> {
    return ask(request.message, request.defaultValue);
  }
}

/** An engine context that renders to this terminal. */
export function terminalContext(options: TerminalOptions = {}): { ctx: EngineContext; reporter: TerminalReporter } {
  const reporter = new TerminalReporter(options);
  return { reporter, ctx: { emit: reporter.handle, prompter: new TerminalPrompter(), verbose: isVerbose() } };
}
