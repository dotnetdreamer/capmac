/**
 * The console's lines: a virtual list made for logs. Only the rows near the
 * view are in the page, between spacers sized from a height index, so 100k+
 * lines scroll, stream and search like 100. Rows sit in normal flow: when a
 * row's real height differs from its estimate, the browser's scroll
 * anchoring keeps the view still (even mid smooth-scroll).
 *
 * Text selection spans any number of lines. While there is a selection, the
 * rows at its two ends stay in the page wherever they are, so the browser's
 * own selection (dragging, auto-scroll, Shift+click, the highlight) never
 * loses its place; the lines in between are copied from the console itself.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { t } from '../../../shared/i18n';
import { clockTime } from '../../lib/format';
import { HeightIndex } from '../../lib/heights';
import { END, jsonPayload, lineText, lowerBound, rowText, SOURCE_LABELS, SOURCE_TAGS, textBetween, type ConsoleBuffer, type ConsoleLine, type ConsoleView, type RowText, type TextPoint } from '../../state/console';
import { Icon } from '../../ui/Icon';
import { Menu, usePopover, type MenuItemSpec } from '../../ui/Popover';
import { Tooltip } from '../../ui/Tooltip';
import { JsonTree } from './JsonTree';

/** A line of console text is 18px and a row adds 2px of padding (see .cl-row). */
const LINE = 18;
const ROW_PAD = 2;
/** This close to the bottom counts as being at the latest line (less than a row: one new line counts). */
const END_SLACK = 8;

/** A row's height before it is measured: its lines of text, wrapped at `columns` characters (0: no wrapping). */
function estimate(text: string, columns: number): number {
  let rows = 0;
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const length = (nl < 0 ? text.length : nl) - start;
    rows += columns > 0 ? Math.max(1, Math.ceil(length / columns)) : 1;
    if (nl < 0) break;
    start = nl + 1;
  }
  return ROW_PAD + LINE * rows;
}

type DomPoint = { node: Node; offset: number };
/** The selection, as two points in the console's lines (the anchor where it started, the head where it ends). */
interface Selected {
  anchor: TextPoint;
  head: TextPoint;
}

const Row = memo(function Row({ line, timestamps, highlight, current, rowRef }: { line: ConsoleLine; timestamps: boolean; highlight: (text: string) => ReactNode; current: boolean; rowRef: (el: HTMLDivElement | null) => (() => void) | undefined }) {
  const json = line.source === 'js' || line.source === 'cap' || line.source === 'main' ? jsonPayload(line) : null;
  return (
    <div ref={rowRef} data-id={line.id} data-json={json ? '' : undefined} className={`cl-row cl-row--${line.level} cl-row--${line.source}${current ? ' is-current' : ''}`}>
      {timestamps && (
        <span className="cl-time tabular" data-col="time">
          {clockTime(line.ts, true)}
        </span>
      )}
      <span className={`cl-src cl-src--${line.source}`} data-col="src" title={SOURCE_LABELS[line.source]}>
        {SOURCE_TAGS[line.source]}
      </span>
      <span className="cl-level" data-col="level">
        {line.level === 'error' ? <Icon name="errorCircle" size={12} filled label={t.console.error} /> : line.level === 'warn' ? <Icon name="warning" size={12} filled label={t.console.warning} /> : null}
      </span>
      <span className="cl-text" data-col="text">
        {json ? <JsonTree prefix={json.prefix} value={json.value} highlight={highlight} /> : highlight(line.text)}
      </span>
    </div>
  );
});

/** Characters from the start of `el` to a point in it. */
function charsBefore(el: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The point `chars` characters into `el`'s text. */
function pointAt(el: HTMLElement, chars: number): DomPoint {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = Math.max(0, chars);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).data.length;
    if (left <= length) return { node, offset: left };
    left -= length;
  }
  return { node: el, offset: el.childNodes.length };
}

function columnStart(column: string | undefined, row: RowText): number {
  return column === 'time' ? 0 : column === 'src' ? row.tagStart : column === 'level' ? row.levelStart : row.textStart;
}

const isRow = (node: Node | null): node is HTMLElement => node instanceof HTMLElement && node.dataset.id !== undefined;

export interface ConsoleListHandle {
  /** Brings a row to the middle of the view (search results). */
  reveal(index: number): void;
  /** Goes to the latest line and follows new ones again. */
  toLatest(): void;
  selectAll(): void;
  focus(): void;
}

export interface ConsoleListProps {
  buffer: ConsoleBuffer;
  view: ConsoleView;
  /** Rows shown: the view's lines (up to where it was paused). */
  count: number;
  timestamps: boolean;
  wrap: boolean;
  highlight: (text: string) => ReactNode;
  /** The search result to outline. */
  currentLine: number | undefined;
  visible: boolean;
  paused: boolean;
  /** Lines that came in while paused. */
  pausedNew: number;
  onResume: () => void;
  onSave: () => void;
  onClear: () => void;
  /** Shown with no rows. */
  empty: ReactNode;
}

export const ConsoleList = forwardRef<ConsoleListHandle, ConsoleListProps>(function ConsoleList(props, ref) {
  const { buffer, view, count, timestamps, wrap, highlight, currentLine, visible, paused } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [heights] = useState(() => new HeightIndex());
  /** Measured row heights by line id: kept through filter changes, dropped when the layout changes. */
  const [measured] = useState(() => new Map<number, number>());
  /** Rows in the page, by line id. */
  const [rows] = useState(() => new Map<number, HTMLDivElement>());
  const [, setTick] = useState(0);
  const [atEnd, setAtEnd] = useState(true);
  const menu = usePopover();
  const [menuFor, setMenuFor] = useState<{ line: number | null; selected: Selected | null } | null>(null);
  const selected = useRef<Selected | null>(null);
  // Scroll and layout state, read by event handlers between renders.
  const s = useRef({
    /** The view generation and layout the heights were made for. */
    generation: -1,
    layout: '',
    /** Characters per line when wrapping, for estimates (0: not known yet). */
    columns: 0,
    /** Last known scroll position, from the top of the first row. */
    top: 0,
    viewport: 0,
    /** Stick to the latest line as lines come in. */
    following: true,
    /** The scroll position this list set last, to tell its own scrolls from the user's. */
    wrote: -1,
    /** Rows around the view in the page: [start, end) (the selection's ends may be there too). */
    start: 0,
    end: 0,
    /** The line at the top of the view, and how far into it: kept in view when the lines shown change. */
    anchor: null as { id: number; delta: number } | null,
    pendingAnchor: null as { id: number; delta: number } | null,
    /** A row to bring to the middle after the next render. */
    reveal: -1,
    /** Put the whole kept selection into the page after the next render (Select all). */
    placeSelection: false,
    /** The selection's lines went away: clear the page's selection after the next render. */
    unselect: false,
    /** Rows when the view last showed the latest line. */
    seen: 0,
    atEnd: true,
    /** Rows at the last render (lines that came in since then were not seen). */
    lastCount: 0,
    /** Corrective renders this frame (guards against loops). */
    passes: 0,
    /** The console was on screen at the last render (hiding it loses the scroll position). */
    shown: false,
  }).current;
  const latest = useRef(props);
  latest.current = props;

  // ─── Heights ──────────────────────────────────────────────────────────────

  const sizeFor = (id: number) => measured.get(id) ?? estimate(buffer.byId(id)?.text ?? '', wrap ? s.columns : 0);
  // Wrapped rows are estimated again once the line width is known.
  const layout = `${wrap}|${timestamps}|${wrap && s.columns > 0}`;
  if (s.layout !== layout) measured.clear();
  if (s.generation !== view.generation || s.layout !== layout || count < heights.count) {
    // The lines shown changed (filters, old lines dropped) or the layout did: keep the top line in view.
    if (!s.following && s.anchor && s.generation !== -1) s.pendingAnchor = s.anchor;
    // Forget heights of lines that were dropped.
    if (measured.size > count * 2) for (const id of [...measured.keys()]) if (id < buffer.firstId) measured.delete(id);
    // Only old lines dropped (the line limit): the same rows without the first ones.
    const trim = s.generation === view.generation - 1 && s.layout === layout && view.trimmed >= 0 && view.trimmed <= heights.count;
    if (trim) heights.dropFront(view.trimmed);
    else heights.reset(Math.min(count, view.ids.length), (i) => sizeFor(view.ids[i]!));
    s.generation = view.generation;
    s.layout = layout;
    if (count < heights.count) heights.shrink(count);
    else heights.grow(count, (i) => sizeFor(view.ids[i]!));
  } else if (count > heights.count) {
    heights.grow(count, (i) => sizeFor(view.ids[i]!));
  }

  const indexOf = useCallback((id: number) => {
    const { view: v, count: n } = latest.current;
    const index = lowerBound(v.ids, id, n);
    return v.ids[index] === id ? index : -1;
  }, []);

  // A selection whose line went away (filtered out, dropped) goes too.
  const kept = selected.current;
  if (kept && (indexOf(kept.anchor.id) < 0 || indexOf(kept.head.id) < 0)) {
    selected.current = null;
    s.unselect = true;
  }

  // ─── The rows to render ───────────────────────────────────────────────────

  // Empty (cleared, or nothing passes the filters): the next lines are followed again.
  if (count === 0) {
    s.following = true;
    s.top = 0;
    s.anchor = null;
    s.pendingAnchor = null;
    s.reveal = -1;
  }
  const viewport = s.viewport || 600;
  const following = s.following && !paused;
  let top = s.top;
  if (following) top = Math.max(0, heights.total - viewport);
  else if (s.pendingAnchor) {
    const at = lowerBound(view.ids, s.pendingAnchor.id, count);
    top = heights.offsetOf(at) + (view.ids[at] === s.pendingAnchor.id ? s.pendingAnchor.delta : 0);
  } else if (s.reveal >= 0) top = Math.max(0, heights.offsetOf(s.reveal) - viewport / 2);
  // A screen of rows above and below: scrolling re-renders only every so often.
  const start = count ? heights.indexAt(Math.max(0, top - viewport)) : 0;
  const end = count ? Math.min(count, heights.indexAt(top + viewport * 2) + 1) : 0;
  s.start = start;
  s.end = end;
  // The selection's ends stay in the page, wherever they are.
  const pins: number[] = [];
  for (const p of selected.current ? [selected.current.anchor, selected.current.head] : []) {
    const index = indexOf(p.id);
    if (index >= 0 && (index < start || index >= end) && !pins.includes(index)) pins.push(index);
  }
  pins.sort((a, b) => a - b);

  const rerender = useCallback(() => setTick((n) => n + 1), []);

  /** Whether the rows in the page cover the view and a third of a screen around it. */
  const covered = useCallback(() => {
    const n = latest.current.count;
    const margin = s.viewport / 3;
    const from = Math.max(0, s.top - margin);
    const to = Math.min(heights.total, s.top + s.viewport + margin);
    return (s.start === 0 || heights.offsetOf(s.start) <= from) && (s.end >= n || heights.offsetOf(s.end) >= to);
  }, [heights, s]);

  const setTop = useCallback(
    (value: number) => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = Math.max(0, Math.min(value, el.scrollHeight - el.clientHeight));
      s.wrote = el.scrollTop;
      s.top = el.scrollTop - (rowsRef.current?.offsetTop ?? 0);
    },
    [s],
  );

  /** How many characters fit on a wrapped line (for estimates); true when it was not known before. */
  const measureColumns = useCallback(() => {
    const probe = probeRef.current;
    const text = rowsRef.current?.querySelector<HTMLElement>('.cl-text');
    if (!probe || !text || probe.offsetWidth === 0 || text.clientWidth === 0) return false;
    const first = s.columns === 0;
    s.columns = Math.max(1, Math.floor(text.clientWidth / (probe.offsetWidth / probe.textContent!.length)));
    return first;
  }, [s]);

  /** Remembers which line is at the top of the view. */
  const noteAnchor = useCallback(() => {
    const { view: v, count: n } = latest.current;
    if (n === 0) {
      s.anchor = null;
      return;
    }
    const index = heights.indexAt(s.top);
    const id = v.ids[index];
    s.anchor = id === undefined ? null : { id, delta: s.top - heights.offsetOf(index) };
  }, [heights, s]);

  // ─── Selection ────────────────────────────────────────────────────────────

  /** A point in a row, from a place in the page. */
  const pointIn = useCallback((row: HTMLElement, node: Node, offset: number): TextPoint => {
    const id = Number(row.dataset.id);
    const line = latest.current.buffer.byId(id);
    const text = line ? rowText(line, latest.current.timestamps) : null;
    if (!text) return { id, offset: 0 };
    if (node === row) {
      // Between columns: the start of the next one, or the end of the row.
      const next = row.childNodes[offset] as HTMLElement | undefined;
      return { id, offset: next ? columnStart(next.dataset.col, text) : END };
    }
    let column: Node | null = node;
    while (column && column.parentNode !== row) column = column.parentNode;
    const name = (column as HTMLElement | null)?.dataset?.col;
    if (!column || !name) return { id, offset: 0 };
    // An expanded JSON tree's text is not the line's: the whole message counts.
    if (name === 'text' && row.hasAttribute('data-json')) return { id, offset: text.textStart, json: true };
    const chars = charsBefore(column, node, offset);
    if (name === 'time') return { id, offset: Math.min(chars, text.timeEnd) };
    if (name === 'src') return { id, offset: Math.min(text.tagStart + chars, text.tagEnd) };
    if (name === 'level') return { id, offset: text.levelStart };
    return { id, offset: text.textStart + chars };
  }, []);

  /**
   * Where a selection boundary is in the console's lines. Outside the
   * console: the edge of the rows in the page on that side. In a spacer: the
   * row next to it.
   */
  const pointOf = useCallback(
    (node: Node | null, offset: number): TextPoint | 'outside' | null => {
      const list = rowsRef.current;
      if (!node || !list) return null;
      const edgeRow = (first: boolean): TextPoint | null => {
        let el: Node | null = first ? list.firstChild : list.lastChild;
        while (el && !isRow(el)) el = first ? el.nextSibling : el.previousSibling;
        return isRow(el) ? { id: Number(el.dataset.id), offset: first ? 0 : END } : null;
      };
      if (!list.contains(node)) {
        const position = list.compareDocumentPosition(node);
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return edgeRow(true) ?? 'outside';
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return edgeRow(false) ?? 'outside';
        return null;
      }
      let child: Node | null = node;
      while (child && child.parentNode !== list) child = child.parentNode;
      if (isRow(child)) return pointIn(child, node, offset);
      // Between rows: the start of the next row, else the end of the one before.
      let next: Node | null = node === list ? (list.childNodes[offset] ?? null) : (child?.nextSibling ?? null);
      while (next && !isRow(next)) next = next.nextSibling;
      if (isRow(next)) return { id: Number(next.dataset.id), offset: 0 };
      return edgeRow(false);
    },
    [pointIn],
  );

  /** Updates the kept selection from the page's. */
  const readSelection = useCallback(() => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      selected.current = null;
      return;
    }
    const anchor = pointOf(selection.anchorNode, selection.anchorOffset);
    const head = pointOf(selection.focusNode, selection.focusOffset);
    const list = rowsRef.current;
    // Not in the console (both ends outside it, and it doesn't span it).
    const touches = list && (list.contains(selection.anchorNode) || list.contains(selection.focusNode) || selection.containsNode(list, true));
    if (!touches || !anchor || !head || anchor === 'outside' || head === 'outside') {
      selected.current = null;
      return;
    }
    selected.current = anchor.id === head.id && anchor.offset === head.offset && !anchor.json ? null : { anchor, head };
  }, [pointOf]);

  /** Where a kept point goes in the page (its row is there: pinned, or near the view). */
  const domPoint = useCallback(
    (p: TextPoint): DomPoint | null => {
      const row = rows.get(p.id);
      if (!row) return null;
      if (p.offset >= END) return { node: row, offset: row.childNodes.length };
      const line = latest.current.buffer.byId(p.id);
      const text = line ? rowText(line, latest.current.timestamps) : null;
      const column = (name: string) => row.querySelector<HTMLElement>(`:scope > [data-col="${name}"]`);
      if (!text) return { node: row, offset: 0 };
      if (p.json) {
        const el = column('text');
        return el ? { node: el, offset: 0 } : { node: row, offset: 0 };
      }
      if (p.offset < text.tagStart) {
        const el = column('time');
        if (el) return pointAt(el, p.offset);
      }
      if (p.offset < text.levelStart) {
        const el = column('src');
        if (el) return pointAt(el, p.offset - text.tagStart);
      }
      if (p.offset < text.textStart) {
        const el = column('level');
        if (el) return { node: el, offset: 0 };
      }
      const el = column('text');
      return el ? pointAt(el, p.offset - text.textStart) : { node: row, offset: row.childNodes.length };
    },
    [rows],
  );

  /**
   * Puts the kept selection into the page. Normally the page has it already
   * (its rows stay); this mends ends whose text changed underneath (a search
   * highlight), and places a new one (`all`: Select all).
   */
  const placeSelection = useCallback(
    (all = false) => {
      const kept = selected.current;
      const selection = document.getSelection();
      if (!kept || !selection) return;
      const inRow = (node: Node | null) => {
        let el: Node | null = node;
        while (el && !isRow(el)) el = el.parentNode;
        return isRow(el) && el.isConnected;
      };
      const place = (p: TextPoint, node: Node | null, offset: number): DomPoint | null => (!all && node && inRow(node) ? { node, offset } : domPoint(p));
      const a = place(kept.anchor, selection.anchorNode, selection.anchorOffset);
      const f = place(kept.head, selection.focusNode, selection.focusOffset);
      if (!a || !f) return;
      if (selection.anchorNode === a.node && selection.anchorOffset === a.offset && selection.focusNode === f.node && selection.focusOffset === f.offset) return;
      try {
        selection.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
      } catch {
        // a node left the page meanwhile; the next render puts it back
      }
    },
    [domPoint],
  );

  const textOf = useCallback((kept: Selected) => {
    const { view: v, count: n, buffer: b, timestamps: ts } = latest.current;
    return textBetween(kept.anchor, kept.head, v.ids, n, (id) => b.byId(id), ts);
  }, []);

  const selectAll = useCallback(() => {
    const { view: v, count: n } = latest.current;
    if (n === 0) return;
    selected.current = { anchor: { id: v.ids[0]!, offset: 0 }, head: { id: v.ids[n - 1]!, offset: END } };
    // Render with the first and last lines in the page, then select from one to the other.
    s.placeSelection = true;
    flushSync(rerender);
  }, [rerender, s]);

  const copy = useCallback((text: string) => void navigator.clipboard.writeText(text).catch(() => undefined), []);

  // ─── After each render: scroll position, selection, coverage ─────────────

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !visible || el.clientHeight === 0) {
      s.shown = false;
      return;
    }
    s.viewport = el.clientHeight;
    // Wrapped lines: estimate the rest again once the line width is known (once).
    if (wrap && s.columns === 0 && measureColumns()) {
      rerender();
      return;
    }
    // Back from another tab: the page forgot where the console was scrolled to.
    if (!s.shown && !s.following && !s.pendingAnchor && s.reveal < 0 && s.anchor) {
      s.shown = true;
      s.pendingAnchor = s.anchor;
      rerender();
      return;
    }
    s.shown = true;
    if (s.pendingAnchor) {
      // The line that was at the top, where it was (from its real place in the page).
      const kept = s.pendingAnchor;
      s.pendingAnchor = null;
      const at = lowerBound(view.ids, kept.id, count);
      const id = view.ids[at];
      const row = id === undefined ? undefined : rows.get(id);
      if (row) setTop(row.offsetTop + (id === kept.id ? kept.delta : 0));
    } else if (s.reveal >= 0) {
      const id = view.ids[s.reveal];
      s.reveal = -1;
      const row = id === undefined ? undefined : rows.get(id);
      if (row) setTop(row.offsetTop - (el.clientHeight - row.offsetHeight) / 2);
    }
    if (s.following && !paused) setTop(el.scrollHeight);
    noteAnchor();
    // Lines came in below while not following (no scroll happened): no longer at the latest line.
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < END_SLACK;
    if (end !== s.atEnd) {
      if (!end) s.seen = Math.min(s.lastCount, count);
      s.atEnd = end;
      setAtEnd(end);
    }
    s.lastCount = count;
    if (selected.current) placeSelection(s.placeSelection);
    else if (s.unselect) {
      const selection = document.getSelection();
      if (selection && rowsRef.current && (rowsRef.current.contains(selection.anchorNode) || rowsRef.current.contains(selection.focusNode))) selection.removeAllRanges();
    }
    s.placeSelection = false;
    s.unselect = false;
    if (!covered() && s.passes < 4) {
      s.passes += 1;
      requestAnimationFrame(() => (s.passes = 0));
      rerender();
    }
  });

  // Coming back into view (the Problems tab was showing).
  useEffect(() => {
    if (visible) rerender();
  }, [visible, rerender]);

  // ─── Events ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // Hidden (another tab): the page resets the position, which says nothing about the user.
      if (el.clientHeight === 0) return;
      const pad = rowsRef.current?.offsetTop ?? 0;
      const ours = Math.abs(el.scrollTop - s.wrote) < 1.5;
      s.wrote = -1;
      s.top = el.scrollTop - pad;
      const end = el.scrollHeight - el.scrollTop - el.clientHeight < END_SLACK;
      if (end) s.following = true;
      else if (!ours) s.following = false;
      if (end !== s.atEnd) {
        if (!end) s.seen = latest.current.count;
        s.atEnd = end;
        setAtEnd(end);
      }
      noteAnchor();
      if (!covered()) {
        // Rows are about to leave the page: keep the selection's ends among those that stay.
        readSelection();
        flushSync(rerender);
      }
    };
    // Scrolling up, by wheel, keyboard or scrollbar, stops following at once (before the scroll lands).
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && el.scrollTop > 0) s.following = false;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const onScrollbar = e.clientX >= el.getBoundingClientRect().left + el.clientWidth;
      // Selecting text holds the view still, so lines coming in don't move it.
      const inRows = rowsRef.current?.contains(e.target as Node) && !(e.target as Element).closest('button, a');
      if (onScrollbar || inRows) s.following = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') {
        s.following = false;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [covered, noteAnchor, readSelection, rerender, s, selectAll]);

  useEffect(() => {
    const touches = (selection: Selection | null) => {
      const list = rowsRef.current;
      return Boolean(list && selection && selection.rangeCount > 0 && (list.contains(selection.anchorNode) || list.contains(selection.focusNode) || selection.containsNode(list, true)));
    };
    const onSelectionChange = () => {
      const had = selected.current;
      // Only selections in the console (or leaving it) matter.
      if (!had && !touches(document.getSelection())) return;
      readSelection();
      // Its ends are new: pin them before rows move.
      const now = selected.current;
      if (now && (!had || had.anchor.id !== now.anchor.id || had.head.id !== now.head.id)) rerender();
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!touches(document.getSelection())) return;
      readSelection();
      const kept = selected.current;
      // Inside one expanded JSON tree: copied as shown.
      if (!kept || (kept.anchor.json && kept.head.json && kept.anchor.id === kept.head.id)) return;
      e.clipboardData?.setData('text/plain', textOf(kept));
      e.preventDefault();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('copy', onCopy);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('copy', onCopy);
    };
  }, [readSelection, rerender, textOf]);

  // Rows: measured as they appear and whenever they change size (wrapping, an expanded JSON tree).
  const onResizeRef = useRef<(entries: ResizeObserverEntry[]) => void>(() => undefined);
  const [resize] = useState(() => (typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => onResizeRef.current(entries))));
  onResizeRef.current = (entries) => {
    const el = scrollRef.current;
    let changed = false;
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      if (target === el) {
        // The console itself: its height, and how many characters fit on a wrapped line now
        // (for rows still to come; rows on screen are measured as they reflow).
        s.viewport = el.clientHeight;
        measureColumns();
        changed = true;
        continue;
      }
      if (!target.isConnected) continue;
      const height = entry.borderBoxSize?.[0]?.blockSize ?? target.offsetHeight;
      // Hidden (another tab): nothing to learn.
      if (!(height > 0)) continue;
      const id = Number(target.dataset.id);
      measured.set(id, height);
      const index = indexOf(id);
      if (index >= 0 && heights.set(index, height)) changed = true;
    }
    if (!changed || !el || el.clientHeight === 0) return;
    if (s.following && !latest.current.paused) setTop(el.scrollHeight);
    if (!covered()) flushSync(rerender);
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !resize) return;
    resize.observe(el);
    // Rows stop being observed as they leave the page (rowRef).
    return () => resize.unobserve(el);
  }, [resize]);

  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return undefined;
      const id = Number(el.dataset.id);
      rows.set(id, el);
      resize?.observe(el);
      return () => {
        if (rows.get(id) === el) rows.delete(id);
        resize?.unobserve(el);
      };
    },
    [resize, rows],
  );

  // ─── API ──────────────────────────────────────────────────────────────────

  const toLatest = useCallback(() => {
    s.following = true;
    s.pendingAnchor = null;
    s.reveal = -1;
    flushSync(rerender);
  }, [rerender, s]);

  useImperativeHandle(
    ref,
    () => ({
      reveal(index: number) {
        if (index < 0 || index >= latest.current.count) return;
        s.following = false;
        s.pendingAnchor = null;
        s.reveal = index;
        flushSync(rerender);
      },
      toLatest,
      selectAll,
      focus: () => scrollRef.current?.focus(),
    }),
    [rerender, s, selectAll, toLatest],
  );

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    readSelection();
    const row = (e.target as Element).closest<HTMLElement>('[data-id]');
    setMenuFor({ line: row ? Number(row.dataset.id) : null, selected: selected.current });
    // From the keyboard (Shift+F10 or the menu key): at the top of the console.
    const box = scrollRef.current?.getBoundingClientRect();
    const keyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
    menu.showAt(keyboard && box ? box.left + 16 : e.clientX, keyboard && box ? box.top + 16 : e.clientY);
  };

  const menuLine = menuFor?.line != null ? buffer.byId(menuFor.line) : undefined;
  const menuItems: MenuItemSpec[] = [
    { id: 'copy', label: t.console.copy, icon: 'copy', shortcut: 'Ctrl+C', disabled: !menuFor?.selected, onSelect: () => menuFor?.selected && copy(textOf(menuFor.selected)) },
    { id: 'select-all', label: t.console.selectAll, icon: 'text', shortcut: 'Ctrl+A', disabled: count === 0, onSelect: selectAll },
    ...(menuLine ? [{ id: 'copy-line', label: t.console.copyLine, icon: 'copy' as const, separatorBefore: true, onSelect: () => copy(lineText(menuLine, timestamps)) }] : []),
    { id: 'save', label: t.console.saveToFile, icon: 'download', separatorBefore: !menuLine, disabled: count === 0, onSelect: props.onSave },
    { id: 'clear', label: t.console.clear, icon: 'eraser', shortcut: 'Ctrl+L', disabled: buffer.lines.length === 0, onSelect: props.onClear },
  ];

  const newLines = atEnd ? 0 : Math.max(0, count - s.seen);
  const jumpLabel = paused ? t.console.paused(props.pausedNew) : newLines > 0 ? t.count.newLines(newLines) : null;
  const jump = () => {
    if (paused) props.onResume();
    toLatest();
  };

  // The rows near the view, and the selection's ends wherever they are, with spacers standing in for the rest.
  const children: ReactNode[] = [];
  let laid = 0;
  const spacer = (until: number, key: string) => {
    children.push(<div key={key} className="console__gap" style={{ height: Math.max(0, heights.offsetOf(until) - heights.offsetOf(laid)) }} aria-hidden="true" />);
  };
  const rowAt = (index: number) => {
    const line = buffer.byId(view.ids[index]!);
    if (line) children.push(<Row key={line.id} line={line} timestamps={timestamps} highlight={highlight} current={line.id === currentLine} rowRef={rowRef} />);
  };
  for (const index of pins.filter((i) => i < start)) {
    spacer(index, `gap-${index}`);
    rowAt(index);
    laid = index + 1;
  }
  spacer(start, 'gap-top');
  for (let i = start; i < end; i++) rowAt(i);
  laid = Math.max(laid, end);
  for (const index of pins.filter((i) => i >= end)) {
    spacer(index, `gap-${index}`);
    rowAt(index);
    laid = index + 1;
  }
  spacer(count, 'gap-bottom');

  return (
    <>
      <div
        ref={scrollRef}
        className={`console__scroll${wrap ? ' is-wrapped' : ''}`}
        tabIndex={0}
        role="log"
        aria-live="off"
        aria-label={t.console.output}
        onContextMenu={onContextMenu}
      >
        <span ref={probeRef} className="cl-probe" aria-hidden="true">
          00000000000000000000000000000000
        </span>
        {count === 0 ? (
          props.empty
        ) : (
          <div ref={rowsRef} className="console__rows">
            {children}
          </div>
        )}
      </div>
      {count > 0 && (paused || !atEnd) && (
        <Tooltip content={t.console.toLatest}>
          <button type="button" className={`console__jump${jumpLabel ? '' : ' console__jump--icon'}`} aria-label={jumpLabel ? `${jumpLabel}. ${t.console.toLatest}` : t.console.toLatest} onClick={jump}>
            <Icon name="arrowDown" size={14} />
            {jumpLabel}
          </button>
        </Tooltip>
      )}
      <Menu state={menu} label={t.console.contextMenu} placement="point" width={220} items={menuItems} />
    </>
  );
});
