import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { t } from '../../../shared/i18n';
import { workspaceBus, type WorkspaceAction } from '../../app/commands';
import { toast, useApp } from '../../state/app';
import { consoleFor, ConsoleView, DEFAULT_FILTER, lineText, lowerBound, SOURCE_LABELS, type ConsoleFilter, type ConsoleLevel, type ConsoleLine, type ConsoleSource } from '../../state/console';
import { useProject } from '../../state/projects';
import { IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/Feedback';
import { SearchField } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { Menu, usePopover } from '../../ui/Popover';
import { ConsoleList, type ConsoleListHandle } from './ConsoleList';

const IOS_SOURCES: ConsoleSource[] = ['js', 'cap', 'native', 'bridge', 'web', 'capmac'];
const ELECTRON_SOURCES: ConsoleSource[] = ['js', 'main', 'electron', 'web', 'capmac'];
const BOTH_SOURCES: ConsoleSource[] = ['js', 'cap', 'native', 'bridge', 'main', 'electron', 'web', 'capmac'];
const LEVELS: Array<{ level: ConsoleLevel; label: string }> = (['error', 'warn', 'info', 'log', 'debug'] as const).map((level) => ({ level, label: t.console.levels[level] }));
const FILTER_KEY = 'capmac.consoleFilter';

function loadFilter(): ConsoleFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null');
    if (saved?.sources && saved?.levels) return { sources: { ...DEFAULT_FILTER.sources, ...saved.sources }, levels: { ...DEFAULT_FILTER.levels, ...saved.levels } };
  } catch {
    // defaults
  }
  return DEFAULT_FILTER;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function useHighlighter(query: string) {
  return useMemo(() => {
    const q = query.trim();
    if (!q) return (text: string): ReactNode => text;
    const re = new RegExp(`(${escapeRegExp(q)})`, 'ig');
    return (text: string): ReactNode => {
      const parts = text.split(re);
      return parts.length === 1 ? text : parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
    };
  }, [query]);
}

interface BarProps {
  sources: ConsoleSource[];
  filter: ConsoleFilter;
  setFilter: (update: (f: ConsoleFilter) => ConsoleFilter) => void;
  query: string;
  setQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** "3 of 12", or no results. */
  matchLabel: string;
  onFind: (step: 1 | -1) => void;
  onLeaveSearch: () => void;
  errors: number;
  paused: boolean;
  onPause: () => void;
  canClear: boolean;
  onClear: () => void;
  hasLines: boolean;
  timestamps: boolean;
  wrap: boolean;
  onCopyAll: () => void;
  onExport: () => void;
}

/** Filters, search and options. Its own memoized part: lines streaming in don't re-render it. */
const ConsoleBar = memo(function ConsoleBar(p: BarProps) {
  const levelMenu = usePopover();
  const moreMenu = usePopover();
  const updateSettings = useApp((s) => s.updateSettings);
  const hiddenLevels = LEVELS.filter((l) => !p.filter.levels[l.level]).length;
  return (
    <div className="console__bar" role="toolbar" aria-label={t.console.filters}>
      <div className="console__sources" role="group" aria-label={t.console.sourcesLabel}>
        {p.sources.map((s) => (
          <button
            key={s}
            type="button"
            className={`chip chip--${s}${p.filter.sources[s] ? ' is-on' : ''}`}
            aria-pressed={p.filter.sources[s]}
            onClick={() => p.setFilter((f) => ({ ...f, sources: { ...f.sources, [s]: !f.sources[s] } }))}
          >
            {SOURCE_LABELS[s]}
          </button>
        ))}
      </div>
      <button type="button" className={`chip chip--menu${hiddenLevels ? ' is-on' : ''}`} aria-haspopup="menu" {...levelMenu.triggerProps}>
        {hiddenLevels ? t.console.levelsShown(LEVELS.length - hiddenLevels) : t.console.allLevels}
        <Icon name="chevronDown" size={12} />
      </button>
      <Menu
        state={levelMenu}
        label={t.console.levelsMenu}
        placement="bottom-start"
        items={[
          ...LEVELS.map((l) => ({ id: l.level, label: l.label, checked: p.filter.levels[l.level], onSelect: () => p.setFilter((f) => ({ ...f, levels: { ...f.levels, [l.level]: !f.levels[l.level] } })) })),
          { id: 'errors-only', label: t.console.onlyProblems, separatorBefore: true, onSelect: () => p.setFilter((f) => ({ ...f, levels: { error: true, warn: true, info: false, log: false, debug: false } })) },
          { id: 'all', label: t.console.showAllLevels, onSelect: () => p.setFilter((f) => ({ ...f, levels: { ...DEFAULT_FILTER.levels } })) },
        ]}
      />
      {p.errors > 0 && (
        <span className="count count--error" title={t.console.errorsHere(p.errors)}>
          {p.errors}
        </span>
      )}
      <div className="console__tools">
        <SearchField
          ref={p.searchRef}
          compact
          className="console__search"
          placeholder={t.console.find}
          aria-label={t.console.findLabel}
          value={p.query}
          onChange={(e) => p.setQuery(e.target.value)}
          onClear={() => p.setQuery('')}
          count={p.matchLabel}
          onPrev={() => p.onFind(-1)}
          onNext={() => p.onFind(1)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'F3') {
              e.preventDefault();
              p.onFind(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              p.setQuery('');
              p.onLeaveSearch();
            }
          }}
        />
        <IconButton icon={p.paused ? 'play' : 'pause'} size="sm" label={p.paused ? t.console.resume : t.console.pause} pressed={p.paused} onClick={p.onPause} />
        <IconButton icon="eraser" size="sm" label={t.console.clear} shortcut="Ctrl+L" onClick={p.onClear} disabled={!p.canClear} />
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t.console.moreOptions} aria-haspopup="menu" {...moreMenu.triggerProps}>
          <Icon name="more" size={16} />
        </button>
        <Menu
          state={moreMenu}
          label={t.console.options}
          width={220}
          items={[
            { id: 'time', label: t.console.timestamps, checked: p.timestamps, onSelect: () => void updateSettings({ consoleTimestamps: !p.timestamps }) },
            { id: 'wrap', label: t.console.wrap, checked: p.wrap, onSelect: () => void updateSettings({ consoleWrap: !p.wrap }) },
            { id: 'copy', label: t.console.copyVisible, icon: 'copy', separatorBefore: true, disabled: !p.hasLines, onSelect: p.onCopyAll },
            { id: 'export', label: t.console.saveToFile, icon: 'download', disabled: !p.hasLines, onSelect: p.onExport },
          ]}
        />
      </div>
    </div>
  );
});

export function Console({ path, visible }: { path: string; visible: boolean }) {
  const buffer = consoleFor(path);
  // The sources this project's app can log from: iOS, Electron, or both.
  const summary = useProject(path).summary;
  const sources = !summary?.electron ? IOS_SOURCES : summary.kind === 'electron' || !summary.hasIos ? ELECTRON_SOURCES : BOTH_SOURCES;
  const version = useSyncExternalStore(buffer.subscribe, buffer.getVersion);
  const settings = useApp((s) => s.settings);
  const timestamps = settings?.consoleTimestamps ?? true;
  const wrap = settings?.consoleWrap ?? true;
  const [filter, setFilter] = useState<ConsoleFilter>(loadFilter);
  const [query, setQuery] = useState('');
  // Typing stays quick in a long console: the search over every line follows a moment later.
  const search = useDeferredValue(query);
  const [current, setCurrent] = useState(0);
  /** Paused: the last line shown (lines after it wait). */
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const paused = pausedAt !== null;
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<ConsoleListHandle>(null);
  const [view] = useState(() => new ConsoleView());
  const highlight = useHighlighter(search);

  // Incremental: only lines added since the last render are filtered.
  view.update(buffer, filter, search);
  void version;
  const count = paused ? lowerBound(view.ids, pausedAt + 1) : view.ids.length;
  // Matches are positions in the view, in order: those shown are the first ones.
  const matchCount = lowerBound(view.matches, count);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
    } catch {
      // per-viewer convenience only
    }
  }, [filter]);

  useEffect(() => setCurrent(0), [search]);

  // The latest values, for callbacks that stay the same between renders (the bar is memoized).
  const live = useRef({ matchCount, current, count });
  live.current = { matchCount, current, count };

  const onFind = useCallback(
    (step: 1 | -1) => {
      const { matchCount: n, current: at } = live.current;
      if (n === 0) return;
      const next = (((at + step) % n) + n) % n;
      setCurrent(next);
      listRef.current?.reveal(view.matches[next]!);
    },
    [view],
  );

  const resume = useCallback(() => setPausedAt(null), []);
  const onPause = useCallback(() => {
    if (pausedAt !== null) {
      setPausedAt(null);
      listRef.current?.toLatest();
    } else setPausedAt(buffer.lines[buffer.lines.length - 1]?.id ?? 0);
  }, [buffer, pausedAt]);

  const clear = useCallback(() => {
    buffer.clear();
    setPausedAt(null);
    // The next lines show at the bottom, as they come.
    listRef.current?.toLatest();
  }, [buffer]);

  // Workspace commands (Ctrl+F, Ctrl+L)
  useEffect(() => {
    const onAction = (e: Event) => {
      const action = (e as CustomEvent<WorkspaceAction>).detail;
      if (action === 'find-console') {
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (action === 'clear-console') {
        clear();
      }
    };
    workspaceBus.addEventListener('action', onAction);
    return () => workspaceBus.removeEventListener('action', onAction);
  }, [clear]);

  // Screen readers: announce new errors, at most every few seconds.
  const [announcement, setAnnouncement] = useState('');
  const lastAnnounced = useRef({ id: 0, at: 0 });
  useEffect(() => {
    if (!visible) return;
    const last = buffer.lines[buffer.lines.length - 1];
    if (!last || last.level !== 'error' || last.id === lastAnnounced.current.id) return;
    if (Date.now() - lastAnnounced.current.at < 4000) return;
    lastAnnounced.current = { id: last.id, at: Date.now() };
    setAnnouncement(t.console.errorAnnounce(last.text.slice(0, 140)));
  }, [version, buffer, visible]);

  const shownLines = useCallback((): ConsoleLine[] => {
    const lines: ConsoleLine[] = [];
    const n = live.current.count;
    for (let i = 0; i < n; i++) {
      const line = buffer.byId(view.ids[i]!);
      if (line) lines.push(line);
    }
    return lines;
  }, [buffer, view]);
  const copyAll = useCallback(() => {
    const text = shownLines().map((line) => lineText(line)).join('\n');
    const n = live.current.count;
    void navigator.clipboard.writeText(text).then(() => toast({ tone: 'success', title: t.console.copied(n) }));
  }, [shownLines]);
  const exportLog = useCallback(async () => {
    const name = `${path.split(/[\\/]/).pop()}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    const saved = await window.capmac.invoke('app:save-text', { text: shownLines().map((line) => lineText(line)).join('\r\n'), name });
    if (saved) toast({ tone: 'success', title: t.console.saved, body: saved, action: { label: t.common.showInFolder, run: () => void window.capmac.invoke('app:show-in-folder', { path: saved }) } });
  }, [path, shownLines]);
  const onExport = useCallback(() => void exportLog(), [exportLog]);
  const onLeaveSearch = useCallback(() => listRef.current?.focus(), []);

  const currentLine = matchCount ? view.ids[view.matches[Math.min(current, matchCount - 1)]!] : undefined;
  const matchLabel = matchCount ? t.console.match(Math.min(current, matchCount - 1) + 1, matchCount) : t.console.noResults;

  return (
    <div className="console">
      <ConsoleBar
        sources={sources}
        filter={filter}
        setFilter={setFilter}
        query={query}
        setQuery={setQuery}
        searchRef={searchRef}
        matchLabel={matchLabel}
        onFind={onFind}
        onLeaveSearch={onLeaveSearch}
        errors={buffer.errors}
        paused={paused}
        onPause={onPause}
        canClear={buffer.lines.length > 0}
        onClear={clear}
        hasLines={count > 0}
        timestamps={timestamps}
        wrap={wrap}
        onCopyAll={copyAll}
        onExport={onExport}
      />
      <ConsoleList
        ref={listRef}
        buffer={buffer}
        view={view}
        count={count}
        timestamps={timestamps}
        wrap={wrap}
        highlight={highlight}
        currentLine={currentLine}
        visible={visible}
        paused={paused}
        pausedNew={view.ids.length - count}
        onResume={resume}
        onSave={onExport}
        onClear={clear}
        empty={
          <EmptyState compact icon="console" title={buffer.lines.length ? t.console.noMatchTitle : t.console.emptyTitle}>
            {buffer.lines.length ? t.console.noMatchBody : t.console.emptyBody}
          </EmptyState>
        }
      />
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
