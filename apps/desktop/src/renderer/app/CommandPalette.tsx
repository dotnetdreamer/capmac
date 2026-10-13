import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Target } from '../../shared/contract';
import { t } from '../../shared/i18n';
import { macFor, openProject, setProjectPrefs } from '../state/actions';
import { useApp } from '../state/app';
import { call } from '../state/engine';
import { useMacs, useTargets } from '../state/macs';
import { buildCommands, type Command } from './commands';
import { targetState } from '../features/workspace/TargetPicker';
import { fuzzyScore } from '../lib/fuzzy';
import { Kbd } from '../ui/Feedback';
import { Icon, type IconName } from '../ui/Icon';

interface Item {
  id: string;
  title: string;
  group: string;
  icon?: IconName;
  hint?: string;
  shortcut?: string;
  keywords?: string;
  run: () => void;
}

const RECENT_KEY = 'capmac.recentCommands';
function recentIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function rememberCommand(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 5)));
  } catch {
    // a convenience only
  }
}

function targetLabel(target: Target): string {
  return target.kind === 'simulator' ? target.name : t.targets.device(target.name);
}

function useItems(mode: string | null): { items: Item[]; placeholder: string } {
  const route = useApp((s) => s.route);
  const settings = useApp((s) => s.settings);
  const macs = useMacs((s) => s.macs);
  const path = route.name === 'project' ? route.path : null;
  const mac = path ? macFor(path) : null;
  const targets = useTargets((s) => (mac ? s.byMac[mac]?.targets : null));
  useEffect(() => {
    if (mode === 'target' && mac && !targets) {
      void call('targets.list', { mac }).then((list) => useTargets.getState().set(mac, list), () => undefined);
    }
  }, [mode, mac, targets]);

  return useMemo(() => {
    if (mode === 'project') {
      return {
        placeholder: t.palette.switchProject,
        items: (settings?.recentProjects ?? []).map((p) => ({ id: p.path, title: p.name, group: t.palette.recentProjects, icon: 'grid' as IconName, hint: p.appId, run: () => void openProject(p.path) })),
      };
    }
    if (mode === 'mac' && path) {
      return {
        placeholder: t.palette.whichMac,
        items: macs.map((m) => ({ id: m.name, title: m.label, group: t.palette.pairedMacs, icon: 'mac' as IconName, hint: `${m.username}@${m.host}`, run: () => setProjectPrefs(path, { mac: m.name }) })),
      };
    }
    if (mode === 'target' && path) {
      const list = targets ? [...targets.simulators, ...targets.devices] : [];
      return {
        placeholder: targets ? t.palette.whichTarget : t.palette.loadingTargets,
        items: list.map((target) => ({
          id: target.udid,
          title: targetLabel(target),
          group: target.kind === 'device' ? t.targets.devices : target.state === 'Booted' ? t.targets.running : target.os,
          icon: (target.kind === 'device' ? 'phone' : /iPad/.test(target.name) ? 'tablet' : 'phone') as IconName,
          hint: target.kind === 'device' ? `${target.os} · ${targetState(target)}` : target.state === 'Booted' ? t.palette.runningHint(target.os) : target.os,
          keywords: target.udid,
          run: () => setProjectPrefs(path, { target: target.udid }),
        })),
      };
    }
    return {
      placeholder: t.palette.search,
      items: buildCommands().map((c: Command) => ({ id: c.id, title: c.title, group: t.palette.groups[c.group], icon: c.icon, shortcut: c.shortcut, keywords: c.keywords, hint: c.hint, run: c.run })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, path, macs, targets, settings?.recentProjects, route]);
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const mode = useApp((s) => s.paletteMode);
  const close = useApp((s) => s.closePalette);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { items, placeholder } = useItems(open ? mode : null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      setActive(0);
      d.showModal();
      input.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  useEffect(() => setActive(0), [query, mode]);

  const results = useMemo(() => {
    if (!query.trim()) {
      if (mode) return items;
      const recent = recentIds();
      const recentItems = recent.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => Boolean(i)).map((i) => ({ ...i, group: t.palette.recent }));
      return [...recentItems, ...items.filter((i) => !recent.includes(i.id))];
    }
    return items
      .map((item) => ({ item, score: Math.max(fuzzyScore(query, item.title) ?? -1, (fuzzyScore(query, item.keywords ?? '') ?? -1) - 2, (fuzzyScore(query, item.group) ?? -1) - 4) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item);
  }, [items, query, mode]);

  const runItem = (item: Item | undefined) => {
    if (!item) return;
    if (!mode) rememberCommand(item.id);
    close();
    // Let the dialog close (and focus return) before running.
    requestAnimationFrame(() => item.run());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length);
      setActive(next);
      list.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(results[active]);
    } else if (e.key === 'Backspace' && !query && mode) {
      useApp.getState().openPalette(null);
    }
  };

  let lastGroup = '';
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label={t.palette.label}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
    >
      {open && (
        <>
          <div className="palette__search">
            <Icon name="search" size={16} />
            <input
              ref={input}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={results[active] ? `palette-${active}` : undefined}
              aria-autocomplete="list"
              placeholder={placeholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
            />
            {mode && (
              <button type="button" className="btn btn--sm btn--subtle" onClick={() => useApp.getState().openPalette(null)}>
                {t.palette.allCommands}
              </button>
            )}
          </div>
          <div ref={list} id="palette-list" className="palette__list" role="listbox" aria-label={t.palette.list}>
            {results.length === 0 && <div className="palette__empty">{t.palette.empty}</div>}
            {results.map((item, index) => {
              const header = item.group !== lastGroup ? item.group : null;
              lastGroup = item.group;
              return (
                <div key={`${item.group}-${item.id}`}>
                  {header && <div className="palette__group" role="presentation">{header}</div>}
                  <div
                    id={`palette-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={index === active}
                    className={`palette__item${index === active ? ' is-active' : ''}`}
                    onPointerMove={() => index !== active && setActive(index)}
                    onClick={() => runItem(item)}
                  >
                    {item.icon ? <Icon name={item.icon} size={16} /> : <span className="palette__no-icon" />}
                    <span className="palette__title truncate">{item.title}</span>
                    {item.hint && <span className="palette__hint truncate">{item.hint}</span>}
                    {item.shortcut && <Kbd keys={item.shortcut} />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="palette__footer" aria-hidden="true">
            <span>
              <Kbd keys="↑" /> <Kbd keys="↓" /> {t.palette.keys.navigate}
            </span>
            <span>
              <Kbd keys="Enter" /> {t.palette.keys.run}
            </span>
            <span>
              <Kbd keys="Esc" /> {t.palette.keys.close}
            </span>
          </div>
        </>
      )}
    </dialog>
  );
}
