import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Target, TargetsResult } from '../../../shared/contract';
import { useApp } from '../../state/app';
import { Popover, usePopover } from '../../ui/Popover';
import { StatusDot, type Tone } from '../../ui/Feedback';
import { Icon, type IconName } from '../../ui/Icon';
import { Spinner } from '../../ui/Feedback';

/** What `capmac run` would pick when nothing is chosen: a booted iPhone, else the newest iPhone. */
export function automaticTarget(targets: TargetsResult | null | undefined): Target | null {
  if (!targets) return null;
  const sims = targets.simulators.filter((t) => t.available);
  return sims.find((t) => t.state === 'Booted' && /iPhone/.test(t.name)) ?? sims.find((t) => /^iPhone \d+$/.test(t.name)) ?? sims.find((t) => /iPhone/.test(t.name)) ?? sims[0] ?? null;
}

export function targetTone(t: Target): Tone {
  if (t.kind === 'simulator') return t.state === 'Booted' ? 'ok' : t.state === 'Booting' || t.state === 'Shutting Down' ? 'busy' : 'idle';
  if (t.state === 'connected') return 'ok';
  return t.available ? 'warn' : 'error';
}

export function targetState(t: Target): string {
  if (t.kind === 'simulator') return t.state === 'Booted' ? 'Booted' : t.state === 'Shutdown' ? 'Shut down' : t.state;
  if (t.developerMode === 'disabled') return 'Developer Mode off';
  if (t.state === 'connected') return t.connection === 'network' ? 'Connected · Wi-Fi' : 'Connected · USB';
  if (t.paired === false) return 'Not paired';
  return t.available ? 'Paired · not connected' : 'Not connected';
}

export function targetGlyph(t: Target): IconName {
  return /iPad/i.test(t.name) || /iPad/i.test(t.model ?? '') ? 'tablet' : 'phone';
}

export function TargetPicker({ targets, selected, auto, onSelect, loading, disabled }: { targets: TargetsResult | null; selected: Target | null; auto: boolean; onSelect: (target: Target | null) => void; loading: boolean; disabled?: boolean }) {
  const popover = usePopover();
  const navigate = useApp((s) => s.navigate);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (popover.open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [popover.open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (t: Target) => !q || `${t.name} ${t.os} ${t.model ?? ''}`.toLowerCase().includes(q);
    const sims = (targets?.simulators ?? []).filter(match);
    const devices = (targets?.devices ?? []).filter(match);
    const booted = sims.filter((t) => t.state === 'Booted');
    const byRuntime = new Map<string, Target[]>();
    for (const t of sims) {
      if (t.state === 'Booted') continue;
      byRuntime.set(t.os, [...(byRuntime.get(t.os) ?? []), t]);
    }
    const result: Array<{ label: string; items: Target[] }> = [];
    if (devices.length) result.push({ label: 'Devices', items: devices });
    if (booted.length) result.push({ label: 'Booted', items: booted });
    for (const [os, items] of byRuntime) result.push({ label: `${os} simulators`, items });
    return result;
  }, [targets, query]);
  const flat = groups.flatMap((g) => g.items);

  const choose = (t: Target) => {
    onSelect(t);
    popover.close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (active + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % Math.max(1, flat.length);
      setActive(next);
      document.getElementById(`target-opt-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = flat[active];
      if (t) choose(t);
    }
  };

  let index = -1;
  return (
    <>
      <button type="button" className="tb-picker tb-picker--target" aria-haspopup="listbox" aria-label={`Target: ${selected ? `${selected.name}, ${selected.os}, ${targetState(selected)}` : 'none'}`} disabled={disabled} {...popover.triggerProps}>
        {selected ? <Icon name={targetGlyph(selected)} size={16} /> : <Icon name="phone" size={16} />}
        <span className="tb-picker__text">
          <span className="tb-picker__title truncate">{selected ? selected.name : loading ? 'Looking for simulators…' : 'No simulator'}</span>
          {selected && (
            <span className="tb-picker__sub truncate">
              <StatusDot tone={targetTone(selected)} />
              {selected.os} · {targetState(selected)}
              {auto && <span className="tb-picker__auto">auto</span>}
            </span>
          )}
        </span>
        {loading && !targets ? <Spinner size={12} /> : <Icon name="chevronDown" size={12} />}
      </button>
      <Popover state={popover} placement="bottom-start" className="target-flyout" label="Choose a simulator or device">
        <div className="target-flyout__search">
          <Icon name="search" size={14} />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="target-list"
            aria-activedescendant={flat[active] ? `target-opt-${active}` : undefined}
            placeholder="Search simulators and devices"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </div>
        <div id="target-list" role="listbox" aria-label="Simulators and devices" className="target-flyout__list">
          {!targets && (
            <div className="target-flyout__empty">
              <Spinner size={16} /> Asking the Mac…
            </div>
          )}
          {targets && flat.length === 0 && <div className="target-flyout__empty">{query ? 'Nothing matches.' : 'No simulators installed on the Mac.'}</div>}
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <div className="target-flyout__group">{group.label}</div>
              {group.items.map((t) => {
                index += 1;
                const i = index;
                const isSelected = selected?.udid === t.udid;
                const unusable = t.kind === 'device' && !t.available;
                return (
                  <div
                    key={t.udid}
                    id={`target-opt-${i}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={unusable || undefined}
                    className={`target-option${i === active ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${unusable ? ' is-unusable' : ''}`}
                    onPointerMove={() => i !== active && setActive(i)}
                    onClick={() => choose(t)}
                  >
                    <Icon name={targetGlyph(t)} size={16} />
                    <span className="target-option__name truncate">{t.name}</span>
                    <span className="target-option__state">
                      <StatusDot tone={targetTone(t)} />
                      {t.kind === 'device' ? targetState(t) : t.state === 'Booted' ? t.os : t.os}
                    </span>
                    {isSelected && <Icon name="check" size={16} className="target-option__check" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="target-flyout__footer">
          <button type="button" className="btn btn--sm btn--subtle" onClick={() => onSelect(null)} disabled={auto}>
            Choose automatically
          </button>
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            onClick={() => {
              popover.close();
              navigate({ name: 'devices' });
            }}
          >
            Manage devices
            <Icon name="chevronRight" size={12} />
          </button>
        </div>
      </Popover>
    </>
  );
}
