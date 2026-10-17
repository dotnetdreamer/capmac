import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { t } from '../../../shared/i18n';
import { workspaceBus, type WorkspaceAction } from '../../app/commands';
import { toast, useApp } from '../../state/app';
import { consoleFor, ConsoleView, DEFAULT_FILTER, jsonPayload, SOURCE_LABELS, SOURCE_TAGS, type ConsoleFilter, type ConsoleLevel, type ConsoleLine, type ConsoleSource } from '../../state/console';
import { useProject } from '../../state/projects';
import { clockTime } from '../../lib/format';
import { IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/Feedback';
import { SearchField } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { Menu, usePopover } from '../../ui/Popover';
import { JsonTree } from './JsonTree';

const IOS_SOURCES: ConsoleSource[] = ['js', 'cap', 'native', 'bridge', 'web', 'capmac'];
const ELECTRON_SOURCES: ConsoleSource[] = ['js', 'main', 'electron', 'web', 'capmac'];
const BOTH_SOURCES: ConsoleSource[] = ['js', 'cap', 'native', 'bridge', 'main', 'electron', 'web', 'capmac'];
/** A Flutter app: Dart's print() and debugPrint() (the 'js' lines), the engine's and plugins' native logs, CapMac's. */
const FLUTTER_SOURCES: ConsoleSource[] = ['js', 'native', 'capmac'];
const sourceTag = (source: ConsoleSource, dart: boolean) => (dart && source === 'js' ? t.console.dartTag : dart && source === 'native' ? t.console.flutterNativeTag : SOURCE_TAGS[source]);
const sourceLabel = (source: ConsoleSource, dart: boolean) => (dart && source === 'js' ? t.console.dart : SOURCE_LABELS[source]);
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

function lineText(line: ConsoleLine, dart = false): string {
  return `${clockTime(line.ts, true)} ${sourceTag(line.source, dart).padEnd(3)} ${line.level === 'error' ? 'ERROR ' : line.level === 'warn' ? 'WARN ' : ''}${line.text}`;
}

const Row = memo(function Row({ line, timestamps, highlight, current, dart }: { line: ConsoleLine; timestamps: boolean; highlight: (text: string) => ReactNode; current: boolean; dart: boolean }) {
  const json = line.source === 'js' || line.source === 'cap' || line.source === 'main' ? jsonPayload(line) : null;
  return (
    <div className={`cl-row cl-row--${line.level} cl-row--${line.source}${current ? ' is-current' : ''}`}>
      {timestamps && <span className="cl-time tabular">{clockTime(line.ts, true)}</span>}
      <span className={`cl-src cl-src--${line.source}`} title={sourceLabel(line.source, dart)}>
        {sourceTag(line.source, dart)}
      </span>
      <span className="cl-level">
        {line.level === 'error' ? <Icon name="errorCircle" size={12} filled label={t.console.error} /> : line.level === 'warn' ? <Icon name="warning" size={12} filled label={t.console.warning} /> : null}
      </span>
      <span className="cl-text">{json ? <JsonTree prefix={json.prefix} value={json.value} highlight={highlight} /> : highlight(line.text)}</span>
    </div>
  );
});

export function Console({ path, visible }: { path: string; visible: boolean }) {
  const buffer = consoleFor(path);
  // The sources this project's app can log from: iOS, Electron, or both.
  const summary = useProject(path).summary;
  const dart = summary?.kind === 'flutter';
  const sources = dart ? FLUTTER_SOURCES : !summary?.electron ? IOS_SOURCES : summary.kind === 'electron' || !summary.hasIos ? ELECTRON_SOURCES : BOTH_SOURCES;
  const version = useSyncExternalStore(buffer.subscribe, buffer.getVersion);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const timestamps = settings?.consoleTimestamps ?? true;
  const wrap = settings?.consoleWrap ?? true;
  const [filter, setFilter] = useState<ConsoleFilter>(loadFilter);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState(0);
  const [atEnd, setAtEnd] = useState(true);
  const [seen, setSeen] = useState(0);
  const levelMenu = usePopover();
  const moreMenu = usePopover();
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef(new ConsoleView());
  const view = viewRef.current;
  const highlight = useHighlighter(query);

  // Incremental: only lines added since the last render are filtered.
  view.update(buffer, filter, query);
  void version;
  const count = paused ? Math.min(frozen, view.ids.length) : view.ids.length;

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
    } catch {
      // per-viewer convenience only
    }
  }, [filter]);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    getItemKey: (index) => view.ids[index] ?? index,
    overscan: 16,
    anchorTo: 'end',
    followOnAppend: !paused,
    scrollEndThreshold: 24,
  });

  useEffect(() => {
    if (!visible || paused) return;
    const raf = requestAnimationFrame(() => {
      virtualizer.scrollToEnd();
      setAtEnd(true);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAtEnd(end);
  }, []);

  useEffect(() => {
    if (atEnd && !paused) setSeen(count);
  }, [atEnd, paused, count]);

  const jumpToEnd = () => {
    setPaused(false);
    requestAnimationFrame(() => virtualizer.scrollToEnd());
  };

  // Search navigation
  const matches = view.matches.filter((pos) => pos < count);
  const goTo = useCallback(
    (index: number) => {
      if (matches.length === 0) return;
      const next = ((index % matches.length) + matches.length) % matches.length;
      setCurrent(next);
      virtualizer.scrollToIndex(matches[next]!, { align: 'center' });
    },
    [matches, virtualizer],
  );
  useEffect(() => setCurrent(0), [query]);

  // Workspace commands (Ctrl+F, Ctrl+L)
  useEffect(() => {
    const onAction = (e: Event) => {
      const action = (e as CustomEvent<WorkspaceAction>).detail;
      if (action === 'find-console') {
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (action === 'clear-console') {
        buffer.clear();
        setSeen(0);
      }
    };
    workspaceBus.addEventListener('action', onAction);
    return () => workspaceBus.removeEventListener('action', onAction);
  }, [buffer]);

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

  const visibleLines = () => view.ids.slice(0, count).map((id) => buffer.byId(id)).filter((l): l is ConsoleLine => Boolean(l));
  const copyAll = () => {
    const text = visibleLines().map((line) => lineText(line, dart)).join('\n');
    void navigator.clipboard.writeText(text).then(() => toast({ tone: 'success', title: t.console.copied(count) }));
  };
  const exportLog = async () => {
    const name = `${path.split(/[\\/]/).pop()}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    const saved = await window.capmac.invoke('app:save-text', { text: visibleLines().map((line) => lineText(line, dart)).join('\r\n'), name });
    if (saved) toast({ tone: 'success', title: t.console.saved, body: saved, action: { label: t.common.showInFolder, run: () => void window.capmac.invoke('app:show-in-folder', { path: saved }) } });
  };

  const hiddenLevels = LEVELS.filter((l) => !filter.levels[l.level]).length;
  const newLines = Math.max(0, count - seen);
  const items = virtualizer.getVirtualItems();
  const currentLine = matches.length ? view.ids[matches[current] ?? -1] : undefined;
  const errorCount = buffer.errors;

  return (
    <div className="console">
      <div className="console__bar" role="toolbar" aria-label={t.console.filters}>
        <div className="console__sources" role="group" aria-label={t.console.sourcesLabel}>
          {sources.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip chip--${s}${filter.sources[s] ? ' is-on' : ''}`}
              aria-pressed={filter.sources[s]}
              onClick={() => setFilter((f) => ({ ...f, sources: { ...f.sources, [s]: !f.sources[s] } }))}
            >
              {sourceLabel(s, dart)}
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
            ...LEVELS.map((l) => ({ id: l.level, label: l.label, checked: filter.levels[l.level], onSelect: () => setFilter((f) => ({ ...f, levels: { ...f.levels, [l.level]: !f.levels[l.level] } })) })),
            { id: 'errors-only', label: t.console.onlyProblems, separatorBefore: true, onSelect: () => setFilter((f) => ({ ...f, levels: { error: true, warn: true, info: false, log: false, debug: false } })) },
            { id: 'all', label: t.console.showAllLevels, onSelect: () => setFilter((f) => ({ ...f, levels: { ...DEFAULT_FILTER.levels } })) },
          ]}
        />
        {errorCount > 0 && (
          <span className="count count--error" title={t.console.errorsHere(errorCount)}>
            {errorCount}
          </span>
        )}
        <div className="console__tools">
        <SearchField
          ref={searchRef}
          compact
          className="console__search"
          placeholder={t.console.find}
          aria-label={t.console.findLabel}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
          count={matches.length ? t.console.match(current + 1, matches.length) : t.console.noResults}
          onPrev={() => goTo(current - 1)}
          onNext={() => goTo(current + 1)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'F3') {
              e.preventDefault();
              goTo(e.shiftKey ? current - 1 : current + 1);
            } else if (e.key === 'Escape') {
              setQuery('');
              scrollRef.current?.focus();
            }
          }}
        />
        <IconButton icon={paused ? 'play' : 'pause'} size="sm" label={paused ? t.console.resume : t.console.pause} pressed={paused} onClick={() => (paused ? jumpToEnd() : (setFrozen(view.ids.length), setPaused(true)))} />
        <IconButton icon="eraser" size="sm" label={t.console.clear} shortcut="Ctrl+L" onClick={() => buffer.clear()} disabled={buffer.lines.length === 0} />
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t.console.moreOptions} aria-haspopup="menu" {...moreMenu.triggerProps}>
          <Icon name="more" size={16} />
        </button>
        <Menu
          state={moreMenu}
          label={t.console.options}
          width={220}
          items={[
            { id: 'time', label: t.console.timestamps, checked: timestamps, onSelect: () => void updateSettings({ consoleTimestamps: !timestamps }) },
            { id: 'wrap', label: t.console.wrap, checked: wrap, onSelect: () => void updateSettings({ consoleWrap: !wrap }) },
            { id: 'copy', label: t.console.copyVisible, icon: 'copy', separatorBefore: true, disabled: count === 0, onSelect: copyAll },
            { id: 'export', label: t.console.saveToFile, icon: 'download', disabled: count === 0, onSelect: () => void exportLog() },
          ]}
        />
        </div>
      </div>
      <div
        ref={scrollRef}
        className={`console__scroll${wrap ? ' is-wrapped' : ''}`}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-live="off"
        aria-label={t.console.output}
      >
        {count === 0 ? (
          <EmptyState compact icon="console" title={buffer.lines.length ? t.console.noMatchTitle : t.console.emptyTitle}>
            {buffer.lines.length ? t.console.noMatchBody : t.console.emptyBody}
          </EmptyState>
        ) : (
          <div className="console__inner" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const line = buffer.byId(view.ids[item.index]!);
              if (!line) return null;
              return (
                <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="console__item" style={{ transform: `translateY(${item.start}px)` }}>
                  <Row line={line} timestamps={timestamps} highlight={highlight} current={line.id === currentLine} dart={dart} />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {(paused || (!atEnd && newLines > 0)) && count > 0 && (
        <button type="button" className="console__jump" onClick={jumpToEnd}>
          <Icon name="arrowDown" size={14} />
          {paused ? t.console.paused(view.ids.length - frozen) : t.count.newLines(newLines)}
        </button>
      )}
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

