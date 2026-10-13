import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Target, TargetsResult } from '../../../shared/contract';
import { t } from '../../../shared/i18n';
import { useApp } from '../../state/app';
import { Popover, usePopover } from '../../ui/Popover';
import { StatusDot, type Tone } from '../../ui/Feedback';
import { Icon, type IconName } from '../../ui/Icon';
import { Spinner } from '../../ui/Feedback';

/** What `capmac run` would pick when nothing is chosen: a booted iPhone, else the newest iPhone. */
export function automaticTarget(targets: TargetsResult | null | undefined): Target | null {
  if (!targets) return null;
  const sims = targets.simulators.filter((sim) => sim.available);
  return sims.find((sim) => sim.state === 'Booted' && /iPhone/.test(sim.name)) ?? sims.find((sim) => /^iPhone \d+$/.test(sim.name)) ?? sims.find((sim) => /iPhone/.test(sim.name)) ?? sims[0] ?? null;
}

export function targetTone(target: Target): Tone {
  if (target.kind === 'simulator') return target.state === 'Booted' ? 'ok' : target.state === 'Booting' || target.state === 'Shutting Down' ? 'busy' : 'idle';
  if (target.state === 'connected') return 'ok';
  return target.available ? 'warn' : 'error';
}

export function targetState(target: Target): string {
  const s = t.targets.state;
  if (target.kind === 'simulator') {
    return target.state === 'Booted' ? s.running : target.state === 'Shutdown' ? s.off : target.state === 'Booting' ? s.starting : target.state === 'Shutting Down' ? s.stopping : target.state;
  }
  if (target.developerMode === 'disabled') return s.devModeOff;
  if (target.state === 'connected') return target.connection === 'network' ? s.wifi : s.usb;
  if (target.paired === false) return s.notTrusted;
  return target.available ? s.pairedNotConnected : s.notConnected;
}

export function targetGlyph(target: Target): IconName {
  return /iPad/i.test(target.name) || /iPad/i.test(target.model ?? '') ? 'tablet' : 'phone';
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
    const match = (target: Target) => !q || `${target.name} ${target.os} ${target.model ?? ''}`.toLowerCase().includes(q);
    const sims = (targets?.simulators ?? []).filter(match);
    const devices = (targets?.devices ?? []).filter(match);
    const booted = sims.filter((target) => target.state === 'Booted');
    const byRuntime = new Map<string, Target[]>();
    for (const target of sims) {
      if (target.state === 'Booted') continue;
      byRuntime.set(target.os, [...(byRuntime.get(target.os) ?? []), target]);
    }
    const result: Array<{ label: string; items: Target[] }> = [];
    if (devices.length) result.push({ label: t.targets.devices, items: devices });
    if (booted.length) result.push({ label: t.targets.running, items: booted });
    for (const [os, items] of byRuntime) result.push({ label: t.targets.simulatorsFor(os), items });
    return result;
  }, [targets, query]);
  const flat = groups.flatMap((g) => g.items);

  const choose = (target: Target) => {
    onSelect(target);
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
      const target = flat[active];
      if (target) choose(target);
    }
  };

  let index = -1;
  return (
    <>
      <button type="button" className="tb-picker tb-picker--target" aria-haspopup="listbox" aria-label={t.targets.label(selected ? `${selected.name}, ${selected.os}, ${targetState(selected)}` : t.common.none)} disabled={disabled} {...popover.triggerProps}>
        {selected ? <Icon name={targetGlyph(selected)} size={16} /> : <Icon name="phone" size={16} />}
        <span className="tb-picker__text">
          <span className="tb-picker__title truncate">{selected ? selected.name : loading ? t.targets.looking : t.targets.noSimulator}</span>
          {selected && (
            <span className="tb-picker__sub truncate">
              <StatusDot tone={targetTone(selected)} />
              {selected.os} · {targetState(selected)}
              {auto && <span className="tb-picker__auto">{t.targets.auto}</span>}
            </span>
          )}
        </span>
        {loading && !targets ? <Spinner size={12} /> : <Icon name="chevronDown" size={12} />}
      </button>
      <Popover state={popover} placement="bottom-start" className="target-flyout" label={t.targets.choose}>
        <div className="target-flyout__search">
          <Icon name="search" size={14} />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="target-list"
            aria-activedescendant={flat[active] ? `target-opt-${active}` : undefined}
            placeholder={t.targets.search}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </div>
        <div id="target-list" role="listbox" aria-label={t.targets.list} className="target-flyout__list">
          {!targets && (
            <div className="target-flyout__empty">
              <Spinner size={16} /> {t.common.askingMac}
            </div>
          )}
          {targets && flat.length === 0 && <div className="target-flyout__empty">{query ? t.common.nothingMatches : t.targets.noneOnMac}</div>}
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <div className="target-flyout__group">{group.label}</div>
              {group.items.map((target) => {
                index += 1;
                const i = index;
                const isSelected = selected?.udid === target.udid;
                const unusable = target.kind === 'device' && !target.available;
                return (
                  <div
                    key={target.udid}
                    id={`target-opt-${i}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={unusable || undefined}
                    className={`target-option${i === active ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${unusable ? ' is-unusable' : ''}`}
                    onPointerMove={() => i !== active && setActive(i)}
                    onClick={() => choose(target)}
                  >
                    <Icon name={targetGlyph(target)} size={16} />
                    <span className="target-option__name truncate">{target.name}</span>
                    <span className="target-option__state">
                      <StatusDot tone={targetTone(target)} />
                      {target.kind === 'device' ? targetState(target) : target.os}
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
            {t.targets.pickAuto}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            onClick={() => {
              popover.close();
              navigate({ name: 'devices' });
            }}
          >
            {t.targets.manage}
            <Icon name="chevronRight" size={12} />
          </button>
        </div>
      </Popover>
    </>
  );
}
