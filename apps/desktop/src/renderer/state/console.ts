/**
 * The console: a capped buffer per project (100k+ lines) with incremental
 * filtering. Not React state: lines arrive fast and in bursts, so components
 * subscribe to a version number and render through a virtualized list.
 */
import type { AppLogEntry } from '../../shared/contract';
import { t } from '../../shared/i18n';
import { projectKey } from './projects';

export type ConsoleSource = 'js' | 'cap' | 'native' | 'bridge' | 'web' | 'capmac';
export type ConsoleLevel = 'error' | 'warn' | 'info' | 'log' | 'debug';

export interface ConsoleLine {
  id: number;
  ts: number;
  source: ConsoleSource;
  level: ConsoleLevel;
  text: string;
  /** stderr output. */
  err?: boolean;
}

export const SOURCE_LABELS: Record<ConsoleSource, string> = t.console.sources;
export const SOURCE_TAGS: Record<ConsoleSource, string> = t.console.tags;

const KIND_TO_SOURCE: Record<AppLogEntry['kind'], ConsoleSource> = { console: 'js', capacitor: 'cap', native: 'native', bridge: 'bridge' };
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export class ConsoleBuffer {
  lines: ConsoleLine[] = [];
  /** Error lines in the buffer (kept up to date as lines come and go). */
  errors = 0;
  private nextId = 1;
  version = 0;
  /** Bumped when lines are dropped from the front or cleared (views must rebuild). */
  epoch = 0;
  private readonly listeners = new Set<() => void>();
  private scheduled = false;

  constructor(public limit: number) {}

  get firstId(): number {
    return this.lines[0]?.id ?? this.nextId;
  }

  byId(id: number): ConsoleLine | undefined {
    return this.lines[id - this.firstId];
  }

  push(line: Omit<ConsoleLine, 'id'>): void {
    this.lines.push({ ...line, id: this.nextId++ });
    if (line.level === 'error') this.errors += 1;
    this.trim();
    this.changed();
  }

  /** App output: multi-line console messages are merged into one line. */
  pushApp(entry: AppLogEntry): void {
    const last = this.lines[this.lines.length - 1];
    if (entry.continuation && last && last.source === 'js') {
      // Replace (not mutate) so memoized rows re-render.
      this.lines[this.lines.length - 1] = { ...last, text: `${last.text}\n${entry.text}` };
      this.changed();
      return;
    }
    this.push({ ts: entry.ts, source: KIND_TO_SOURCE[entry.kind], level: entry.level, text: entry.text, err: entry.stream === 'stderr' || undefined });
  }

  pushText(source: ConsoleSource, text: string, level: ConsoleLevel = 'log'): void {
    this.push({ ts: Date.now(), source, level, text: text.replace(ANSI, '') });
  }

  clear(): void {
    this.lines = [];
    this.errors = 0;
    this.epoch += 1;
    this.changed();
  }

  private trim(): void {
    if (this.lines.length <= this.limit) return;
    // Drop in chunks (10 %) so views rebuild rarely.
    const dropped = this.lines.splice(0, Math.max(this.lines.length - this.limit, Math.ceil(this.limit / 10)));
    for (const line of dropped) if (line.level === 'error') this.errors -= 1;
    this.epoch += 1;
  }

  private changed(): void {
    this.version += 1;
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const listener of this.listeners) listener();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;
}

const buffers = new Map<string, ConsoleBuffer>();
let defaultLimit = 100_000;

export function setConsoleLimit(limit: number): void {
  defaultLimit = limit;
  for (const buffer of buffers.values()) buffer.limit = limit;
}

export function consoleFor(path: string): ConsoleBuffer {
  const key = projectKey(path);
  let buffer = buffers.get(key);
  if (!buffer) {
    buffer = new ConsoleBuffer(defaultLimit);
    buffers.set(key, buffer);
  }
  return buffer;
}

// ─── Filtering ─────────────────────────────────────────────────────────────

export interface ConsoleFilter {
  sources: Record<ConsoleSource, boolean>;
  levels: Record<ConsoleLevel, boolean>;
}

export const DEFAULT_FILTER: ConsoleFilter = {
  sources: { js: true, cap: true, native: true, bridge: false, web: true, capmac: true },
  levels: { error: true, warn: true, info: true, log: true, debug: true },
};

/**
 * The lines a filter shows (`ids`) and where a search query matches among
 * them (`matches`, positions in `ids`). Both are kept up to date
 * incrementally as lines arrive; they are rebuilt only when the filter or
 * query changes, or when old lines were dropped.
 */
export class ConsoleView {
  ids: number[] = [];
  matches: number[] = [];
  private processedUpTo = 0;
  private epoch = -1;
  private filterKey = '';
  private needle = '';
  private lastSeen: { id: number; text: string } | null = null;

  update(buffer: ConsoleBuffer, filter: ConsoleFilter, query: string): void {
    const key = JSON.stringify(filter);
    const needle = query.trim().toLowerCase();
    const accepts = (line: ConsoleLine) => filter.sources[line.source] && filter.levels[line.level];
    const hit = (line: ConsoleLine) => needle !== '' && line.text.toLowerCase().includes(needle);
    if (key !== this.filterKey || this.epoch !== buffer.epoch) {
      this.filterKey = key;
      this.epoch = buffer.epoch;
      this.ids = [];
      this.matches = [];
      this.processedUpTo = buffer.firstId - 1;
      this.lastSeen = null;
      this.needle = needle;
    } else if (needle !== this.needle) {
      this.needle = needle;
      this.matches = [];
      if (needle) this.ids.forEach((id, i) => hit(buffer.byId(id)!) && this.matches.push(i));
    }
    // The newest line may have grown (a merged multi-line console message): re-check it.
    const lastLine = buffer.lines[buffer.lines.length - 1];
    if (lastLine && this.lastSeen?.id === lastLine.id && this.lastSeen.text !== lastLine.text) {
      const included = this.ids[this.ids.length - 1] === lastLine.id;
      if (included) {
        const pos = this.ids.length - 1;
        const wasHit = this.matches[this.matches.length - 1] === pos;
        if (hit(lastLine) && !wasHit) this.matches.push(pos);
        else if (!hit(lastLine) && wasHit) this.matches.pop();
      }
    }
    const start = Math.max(0, this.processedUpTo + 1 - buffer.firstId);
    for (let i = start; i < buffer.lines.length; i++) {
      const line = buffer.lines[i]!;
      if (!accepts(line)) continue;
      this.ids.push(line.id);
      if (hit(line)) this.matches.push(this.ids.length - 1);
    }
    if (lastLine) {
      this.processedUpTo = lastLine.id;
      this.lastSeen = { id: lastLine.id, text: lastLine.text };
    }
  }
}

// ─── JSON in console.log output ────────────────────────────────────────────

export interface JsonPayload {
  prefix: string;
  value: unknown;
}

const jsonCache = new WeakMap<ConsoleLine, JsonPayload | null>();

/** `console.log('Device info', obj)` arrives as "Device info {…}": find the JSON part. */
export function jsonPayload(line: ConsoleLine): JsonPayload | null {
  if (jsonCache.has(line)) return jsonCache.get(line)!;
  let result: JsonPayload | null = null;
  const text = line.text;
  if (text.length < 1_000_000) {
    const at = text.search(/[{[]/);
    if (at >= 0) {
      const candidate = text.slice(at).trim();
      if ((candidate.startsWith('{') && candidate.endsWith('}')) || (candidate.startsWith('[') && candidate.endsWith(']'))) {
        try {
          const value = JSON.parse(candidate);
          if (value && typeof value === 'object') result = { prefix: text.slice(0, at).trimEnd(), value };
        } catch {
          // not JSON
        }
      }
    }
  }
  jsonCache.set(line, result);
  return result;
}
