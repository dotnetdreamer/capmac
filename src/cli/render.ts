import { classifyAppLine, type AppLogLine } from '../shared/app-log.js';
import type { PathMapper } from '../shared/paths.js';
import type { AgentEvent, Diagnostic } from '../shared/protocol.js';
import { isVerbose, log, pc, step, type Step } from './ui.js';

export interface RenderOptions {
  mapper?: PathMapper | null;
  /** Show Capacitor bridge traffic ("To Native ->", "TO JS"). */
  bridge?: boolean;
  /** Show warnings from Pods / Swift packages / node_modules too. */
  allWarnings?: boolean;
}

/** Turns agent events into terminal output (steps, diagnostics, app logs). */
export class EventRenderer {
  private readonly steps = new Map<string, Step>();
  private hiddenWarnings = 0;
  errors = 0;
  warnings = 0;
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly options: RenderOptions = {}) {}

  setMapper(mapper: PathMapper | null): void {
    this.options.mapper = mapper;
  }

  private map(text: string): string {
    return this.options.mapper ? this.options.mapper.mapText(text) : text;
  }

  handle = (event: AgentEvent): void => {
    switch (event.t) {
      case 'step': {
        this.steps.set(event.id, step(event.title));
        break;
      }
      case 'step-end': {
        const s = this.steps.get(event.id);
        if (!s) break;
        this.steps.delete(event.id);
        if (event.ok) s.succeed(event.detail);
        else s.fail(event.detail);
        break;
      }
      case 'progress': {
        const s = [...this.steps.values()].pop();
        s?.update(event.text);
        break;
      }
      case 'log': {
        const text = this.map(event.msg);
        if (event.level === 'debug') log.debug(text);
        else if (event.level === 'warn') log.warn(text);
        else if (event.level === 'error') log.error(text);
        else log.info(text);
        break;
      }
      case 'out': {
        const text = this.map(event.text);
        if (isVerbose()) log.dim(`  ${text}`);
        break;
      }
      case 'diag': {
        this.diagnostic(event);
        break;
      }
      case 'app': {
        this.appLine(event.text);
        break;
      }
      default:
        break;
    }
  };

  /** Marks any steps still spinning as failed (e.g. the call was interrupted). */
  failOpenSteps(): void {
    for (const s of this.steps.values()) s.fail();
    this.steps.clear();
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
    const file = diag.file ? this.options.mapper?.toLocal(diag.file) ?? diag.file : null;
    const location = file ? `${file}${diag.line ? `:${diag.line}` : ''}${diag.column ? `:${diag.column}` : ''}: ` : '';
    // "file:line:col: error: message" — clickable in VS Code and matched by the $gcc problem matcher.
    log.raw(`${location}${color(`${diag.severity}:`)} ${this.map(diag.message)}`);
    for (const line of diag.context ?? []) log.raw(pc.dim(`    ${this.map(line)}`));
  }

  get hiddenWarningCount(): number {
    return this.hiddenWarnings;
  }

  /** Extra consumer for app log lines (the remote screen's console panel). */
  onAppLine: ((raw: string) => void) | null = null;

  private lastConsole: AppLogLine | null = null;

  appLine(raw: string): void {
    this.onAppLine?.(raw);
    let line = classifyAppLine(raw);
    // Multi-line console messages only carry the ⚡️ prefix on their first line.
    if (line.kind === 'native' && this.lastConsole && !/^\d{4}-\d{2}-\d{2}[ T]\d/.test(raw)) {
      line = { ...this.lastConsole, text: raw };
    }
    this.lastConsole = line.kind === 'console' ? line : null;
    if (line.kind === 'bridge' && !this.options.bridge) return;
    if (!line.text.trim()) return;
    switch (line.kind) {
      case 'console': {
        const badge = line.level === 'error' ? pc.red('js ✖') : line.level === 'warn' ? pc.yellow('js ▲') : line.level === 'info' ? pc.cyan('js  ') : line.level === 'debug' ? pc.dim('js  ') : pc.blue('js  ');
        const text = line.level === 'error' ? pc.red(line.text) : line.level === 'warn' ? pc.yellow(line.text) : line.level === 'debug' ? pc.dim(line.text) : line.text;
        log.raw(`${badge} ${text}`);
        break;
      }
      case 'capacitor':
        log.raw(`${pc.magenta('cap ')} ${line.level === 'error' ? pc.red(line.text) : pc.dim(line.text)}`);
        break;
      case 'bridge':
        log.raw(`${pc.dim('↔   ')} ${pc.dim(line.text)}`);
        break;
      default:
        log.raw(`${pc.dim('ios ')} ${line.level === 'error' ? pc.red(line.text) : line.text}`);
    }
  }
}
