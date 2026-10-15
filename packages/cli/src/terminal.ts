/**
 * The CLI's front end for the engine: renders engine events to the terminal
 * (spinner steps, app logs, `file:line:col: error:` diagnostics) and answers
 * the engine's questions with readline prompts.
 */
import type { AppLogEntry, EngineContext, EngineEvent, Phase, Prompter } from '@capmac/core/engine';
import { describeTarget } from '@capmac/core/engine';
import type { Diagnostic } from '@capmac/core/shared/protocol';
import { printErrorInfo } from './report.js';
import { ask, canPrompt, confirm, isVerbose, log, password, pc, plural, select, step, type Step } from './ui.js';

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

/** Answers the engine's questions in the terminal. */
export class TerminalPrompter implements Prompter {
  get interactive(): boolean {
    return canPrompt();
  }

  password(request: { message: string }): Promise<string> {
    return password(request.message);
  }

  confirm(request: { message: string; defaultYes?: boolean }): Promise<boolean> {
    return confirm(request.message, request.defaultYes ?? true);
  }

  choose<T>(request: { message: string; items: Array<{ label: string; value: T; hint?: string }> }): Promise<T> {
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
