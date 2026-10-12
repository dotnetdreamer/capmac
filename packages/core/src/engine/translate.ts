/**
 * Translates the agent's wire events into engine events: steps get a timeline
 * phase, Mac paths become Windows paths, and app output is classified.
 * Presentation (colours, hiding bridge traffic or dependency warnings) is up
 * to each front end.
 */
import { classifyAppLine, type AppLogLine } from '../shared/app-log.js';
import type { PathMapper } from '../shared/paths.js';
import type { AgentEvent } from '../shared/protocol.js';
import type { EngineContext } from './context.js';
import type { AppLogEntry, Phase, StepStatus } from './events.js';

/** Which timeline phase an agent step belongs to, by operation and step id. */
export function phaseOf(op: string, stepId: string): Phase {
  switch (`${op}:${stepId}`) {
    case 'prepare:install':
      return 'deps';
    case 'prepare:cap':
      return 'cap';
    case 'build:build':
    case 'build:web':
      return 'build';
    case 'deploy:boot':
    case 'boot:boot':
    case 'screen:boot':
      return 'boot';
    case 'deploy:install':
      return 'install';
    case 'archive:archive':
      return 'archive';
    case 'archive:export':
      return 'export';
    default:
      return 'other';
  }
}

const TIMESTAMPED = /^\d{4}-\d{2}-\d{2}[ T]\d/;

/**
 * Classifies app output line by line. Multi-line console messages only carry
 * Capacitor's "⚡️ [log]" prefix on their first line, so the lines that follow
 * (without a timestamp of their own) are marked as continuations.
 */
export class AppLogClassifier {
  private lastConsole: AppLogLine | null = null;

  classify(raw: string, stream: 'stdout' | 'stderr' = 'stdout'): AppLogEntry | null {
    let line = classifyAppLine(raw);
    let continuation = false;
    if (line.kind === 'native' && this.lastConsole && !TIMESTAMPED.test(raw)) {
      line = { ...this.lastConsole, text: raw.replace(/\r$/, '') };
      continuation = true;
    }
    this.lastConsole = line.kind === 'console' ? line : null;
    if (!line.text.trim()) return null;
    return { kind: line.kind, level: line.level, text: line.text, stream, ts: Date.now(), ...(continuation ? { continuation } : {}) };
  }
}

export class AgentEventTranslator {
  private readonly open: string[] = [];
  private readonly classifier: AppLogClassifier;

  constructor(
    private readonly ctx: EngineContext,
    private readonly op: string,
    private readonly mapper: PathMapper | null = null,
    classifier?: AppLogClassifier,
  ) {
    this.classifier = classifier ?? new AppLogClassifier();
  }

  private map(text: string): string {
    return this.mapper ? this.mapper.mapText(text) : text;
  }

  /** Engine-side id for an agent step (agent ids are only unique within one operation). */
  private id(stepId: string): string {
    return `${this.op}:${stepId}`;
  }

  handle = (event: AgentEvent): void => {
    const emit = this.ctx.emit;
    switch (event.t) {
      case 'step':
        this.open.push(this.id(event.id));
        emit({ type: 'step', id: this.id(event.id), title: this.map(event.title), phase: phaseOf(this.op, event.id) });
        break;
      case 'step-end': {
        const id = this.id(event.id);
        const index = this.open.lastIndexOf(id);
        if (index >= 0) this.open.splice(index, 1);
        emit({ type: 'step-end', id, status: event.ok ? 'ok' : 'failed', ms: event.ms, detail: event.detail });
        break;
      }
      case 'progress': {
        const id = this.open[this.open.length - 1];
        if (id) emit({ type: 'step-progress', id, text: this.map(event.text), done: event.done });
        break;
      }
      case 'log':
        emit({ type: 'log', level: event.level, message: this.map(event.msg) });
        break;
      case 'out':
        emit({ type: 'tool-output', stream: event.stream, text: this.map(event.text) });
        break;
      case 'diag': {
        const { t: _t, ...diag } = event;
        emit({
          type: 'diagnostic',
          diagnostic: {
            ...diag,
            file: diag.file ? this.mapper?.toLocal(diag.file) ?? diag.file : undefined,
            message: this.map(diag.message),
            context: diag.context?.map((line) => this.map(line)),
          },
        });
        break;
      }
      case 'app': {
        const entry = this.classifier.classify(event.text, event.stream);
        if (entry) emit({ type: 'app-log', entry });
        break;
      }
      default:
        break;
    }
  };

  /** Ends steps the agent left open (the call failed or was cancelled). */
  closeOpenSteps(status: StepStatus): void {
    for (const id of this.open.splice(0).reverse()) this.ctx.emit({ type: 'step-end', id, status, ms: 0 });
  }
}
