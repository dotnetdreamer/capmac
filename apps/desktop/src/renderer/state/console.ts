/**
 * The console: a capped buffer per project (100k+ lines) with incremental
 * filtering. Not React state: lines arrive fast and in bursts, so components
 * subscribe to a version number and render through a virtualized list.
 */
import type { AppLogEntry } from '../../shared/contract';
import { t } from '../../shared/i18n';
import { clockTime } from '../lib/format';
import { projectKey } from './projects';

/** 'main' and 'electron': an Electron app's main process, and Chromium inside it. */
export type ConsoleSource = 'js' | 'cap' | 'native' | 'bridge' | 'web' | 'capmac' | 'main' | 'electron';
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

const KIND_TO_SOURCE: Record<AppLogEntry['kind'], ConsoleSource> = { console: 'js', capacitor: 'cap', native: 'native', bridge: 'bridge', main: 'main', electron: 'electron' };
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
    const source = KIND_TO_SOURCE[entry.kind];
    if (entry.continuation && last && last.source === source && (source === 'js' || source === 'main')) {
      // Replace (not mutate) so memoized rows re-render.
      this.lines[this.lines.length - 1] = { ...last, text: `${last.text}\n${entry.text}` };
      this.changed();
      return;
    }
    this.push({ ts: entry.ts, source, level: entry.level, text: entry.text, err: entry.stream === 'stderr' || undefined });
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
  sources: { js: true, cap: true, native: true, bridge: false, web: true, capmac: true, main: true, electron: true },
  levels: { error: true, warn: true, info: true, log: true, debug: true },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A case-insensitive test for `needle` (a regular expression allocates nothing per line, unlike toLowerCase). */
function matcherFor(needle: string): (text: string) => boolean {
  const re = new RegExp(escapeRegExp(needle), 'i');
  return (text) => re.test(text);
}

/** The first position in sorted `values` (up to `end`) whose value is at least `value`. */
export function lowerBound(values: ArrayLike<number>, value: number, end = values.length): number {
  let lo = 0;
  let hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The lines a filter shows (`ids`, ascending) and where a search query
 * matches among them (`matches`, ascending positions in `ids`). Both are kept
 * up to date incrementally as lines arrive. `generation` counts the times
 * `ids` changed other than by lines added at the end: a new filter or a
 * cleared console rebuilds it; old lines dropped at the line limit only cut
 * its front (`trimmed` says how many). Typing more of a query only re-checks
 * the lines that matched before.
 */
export class ConsoleView {
  ids: number[] = [];
  matches: number[] = [];
  /** Bumped whenever `ids` changed other than by lines added at the end. */
  generation = 0;
  /** At the last generation: how many ids were cut from the front (old lines dropped), or -1 (rebuilt). */
  trimmed = -1;
  private processedUpTo = 0;
  private epoch = -1;
  private filterKey = '';
  private needle = '';
  private test: ((text: string) => boolean) | null = null;
  private lastSeen: { id: number; text: string } | null = null;

  update(buffer: ConsoleBuffer, filter: ConsoleFilter, query: string): void {
    const key = JSON.stringify(filter);
    const needle = query.trim().toLowerCase();
    const accepts = (line: ConsoleLine) => filter.sources[line.source] && filter.levels[line.level];
    if (needle !== this.needle || (needle && !this.test)) this.test = needle ? matcherFor(needle) : null;
    const test = this.test;
    const hit = (line: ConsoleLine) => test !== null && test(line.text);
    if (key === this.filterKey && this.epoch !== buffer.epoch && buffer.lines.length > 0 && this.processedUpTo >= buffer.firstId - 1) {
      // Old lines were dropped at the line limit: the same view without its first lines.
      this.epoch = buffer.epoch;
      const cut = lowerBound(this.ids, buffer.firstId);
      if (cut > 0) {
        this.ids = this.ids.slice(cut);
        const firstMatch = lowerBound(this.matches, cut);
        this.matches = this.matches.slice(firstMatch);
        for (let i = 0; i < this.matches.length; i++) this.matches[i]! -= cut;
        this.generation += 1;
        this.trimmed = cut;
      }
    }
    if (key !== this.filterKey || this.epoch !== buffer.epoch) {
      this.filterKey = key;
      this.epoch = buffer.epoch;
      this.generation += 1;
      this.trimmed = -1;
      this.ids = [];
      this.matches = [];
      this.processedUpTo = buffer.firstId - 1;
      this.lastSeen = null;
      this.needle = needle;
    } else if (needle !== this.needle) {
      // A longer query only matches lines the shorter one did: re-check those alone.
      const narrower = this.needle !== '' && needle.includes(this.needle);
      this.needle = needle;
      if (!needle) this.matches = [];
      else if (narrower) this.matches = this.matches.filter((pos) => hit(buffer.byId(this.ids[pos]!)!));
      else {
        const matches: number[] = [];
        const ids = this.ids;
        for (let i = 0; i < ids.length; i++) if (hit(buffer.byId(ids[i]!)!)) matches.push(i);
        this.matches = matches;
      }
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

// ─── Copying ───────────────────────────────────────────────────────────────

/**
 * A line as text ("12:04:05.123 JS  ERROR message"), and where each of its
 * columns starts in that text: copying part of a row maps a point in the
 * row's time, tag, level or message to an offset here.
 */
export interface RowText {
  text: string;
  /** End of the time (0 without timestamps). */
  timeEnd: number;
  tagStart: number;
  tagEnd: number;
  levelStart: number;
  /** Where the message starts. */
  textStart: number;
}

export function rowText(line: ConsoleLine, timestamps = true): RowText {
  const time = timestamps ? clockTime(line.ts, true) : '';
  const tag = SOURCE_TAGS[line.source];
  const level = line.level === 'error' ? 'ERROR ' : line.level === 'warn' ? 'WARN ' : '';
  const tagStart = time ? time.length + 1 : 0;
  const levelStart = tagStart + Math.max(3, tag.length) + 1;
  return {
    text: `${time ? `${time} ` : ''}${tag.padEnd(3)} ${level}${line.text}`,
    timeEnd: time.length,
    tagStart,
    tagEnd: tagStart + tag.length,
    levelStart,
    textStart: levelStart + level.length,
  };
}

/** A line as one line of text, for copying and saving. */
export function lineText(line: ConsoleLine, timestamps = true): string {
  return rowText(line, timestamps).text;
}

/** A point in the console's text: the line and an offset in its `rowText` (`END`: its end). */
export interface TextPoint {
  id: number;
  offset: number;
  /** In an expanded JSON tree, where offsets don't follow the line's text: the whole message counts. */
  json?: boolean;
}

export const END = Number.MAX_SAFE_INTEGER;

/**
 * The text between two points (in either order) over the lines a view shows,
 * as copied: whole lines in between, the first and last cut at the points.
 * Lines that went away since (filtered out or dropped) are skipped.
 */
export function textBetween(a: TextPoint, b: TextPoint, ids: ArrayLike<number>, count: number, lineOf: (id: number) => ConsoleLine | undefined, timestamps: boolean): string {
  const [from, to] = a.id < b.id || (a.id === b.id && a.offset <= b.offset) ? [a, b] : [b, a];
  const first = lowerBound(ids, from.id, count);
  // The last line: `to`'s own, or the one before where it would be.
  let last = lowerBound(ids, to.id, count);
  const lastExact = last < count && ids[last] === to.id;
  if (!lastExact) last -= 1;
  const firstExact = first < count && ids[first] === from.id;
  const out: string[] = [];
  for (let i = first; i <= last; i++) {
    const line = lineOf(ids[i]!);
    if (!line) continue;
    const row = rowText(line, timestamps);
    let start = 0;
    let end = row.text.length;
    if (i === first && firstExact) start = from.json ? row.textStart : Math.min(from.offset, end);
    if (i === last && lastExact) end = to.json ? row.text.length : Math.min(to.offset, end);
    out.push(row.text.slice(start, Math.max(start, end)));
  }
  return out.join('\n');
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
