import { useMemo, useState } from 'react';
import type { Target } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { toast, useApp } from '../../state/app';
import { both } from '../../state/actions';
import { call, errorInfo } from '../../state/engine';
import { resolveMac, useMacs, useTargets, useWatchTargets } from '../../state/macs';
import { Button } from '../../ui/Button';
import { Badge, EmptyState, InfoBar, Skeleton, StatusDot } from '../../ui/Feedback';
import { SearchField, Select } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { Menu, usePopover } from '../../ui/Popover';
import { targetGlyph, targetState, targetTone } from '../workspace/TargetPicker';
import './devices.css';

/** "iPad (A16)" and "iPad A16" are the same thing. */
const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function SimulatorRow({ mac, target }: { mac: string; target: Target }) {
  const [busy, setBusy] = useState<'boot' | 'shutdown' | null>(null);
  const menu = usePopover();
  const booted = target.state === 'Booted';
  const act = async (what: 'boot' | 'shutdown') => {
    setBusy(what);
    try {
      await call(what === 'boot' ? 'simulators.boot' : 'simulators.shutdown', { mac, udid: target.udid });
    } catch (err) {
      const e = errorInfo(err);
      toast({ tone: 'critical', title: tidy(e.message), body: tidy(e.hint) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="device-row">
      <span className="device-row__glyph">
        <Icon name={targetGlyph(target)} size={20} />
      </span>
      <span className="device-row__name">
        <span className="truncate">{target.name}</span>
        {target.model && simplify(target.model) !== simplify(target.name) && <span className="device-row__model truncate">{target.model}</span>}
      </span>
      <span className="device-row__os">{target.os}</span>
      <span className={`device-row__state${booted ? ' is-on' : ''}`}>
        <StatusDot tone={busy ? 'busy' : targetTone(target)} pulse={Boolean(busy)} />
        {busy === 'boot' ? t.devices.starting : busy === 'shutdown' ? t.devices.stopping : targetState(target)}
      </span>
      <span className="device-row__actions">
        {booted ? (
          <Button size="sm" icon="power" busy={busy === 'shutdown'} disabled={Boolean(busy)} onClick={() => void act('shutdown')}>
            {t.devices.shutDown}
          </Button>
        ) : (
          <Button size="sm" icon="play" busy={busy === 'boot'} disabled={Boolean(busy)} onClick={() => void act('boot')}>
            {t.devices.start}
          </Button>
        )}
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t.common.moreActionsFor(target.name)} aria-haspopup="menu" {...menu.triggerProps}>
          <Icon name="more" size={16} />
        </button>
        <Menu
          state={menu}
          label={t.common.actionsFor(target.name)}
          items={[{ id: 'udid', label: t.devices.copyUdid, icon: 'copy', hint: target.udid.slice(0, 8), onSelect: () => void navigator.clipboard.writeText(target.udid).then(() => toast({ tone: 'success', title: t.devices.udidCopied })) }]}
        />
      </span>
    </li>
  );
}

function DeviceRow({ target }: { target: Target }) {
  const menu = usePopover();
  const connected = target.state === 'connected';
  const devOff = target.developerMode === 'disabled';
  // Only say something when there is something to do.
  const hint = devOff
    ? t.devices.devModeHint
    : target.paired === false
      ? t.devices.trustHint
      : !connected
        ? t.devices.connectHint
        : null;
  return (
    <li className={`device-row${hint ? ' has-hint' : ''}`}>
      <span className="device-row__glyph">
        <Icon name={targetGlyph(target)} size={20} />
      </span>
      <span className="device-row__name">
        <span className="truncate">{target.name}</span>
        {target.model && simplify(target.model) !== simplify(target.name) && <span className="device-row__model truncate">{target.model}</span>}
      </span>
      <span className="device-row__os">{target.os}</span>
      <span className={`device-row__state${connected ? ' is-on' : ''}`}>
        {connected ? <StatusDot tone="ok" /> : <Icon name="plugDisconnected" size={14} className="faint" />}
        {connected ? (target.connection === 'network' ? t.devices.connectedWifi : t.devices.connectedUsb) : t.devices.notConnected}
      </span>
      <span className="device-row__actions">
        {devOff ? (
          <Badge tone="caution">{t.devices.devModeOff}</Badge>
        ) : target.paired === false ? (
          <Badge tone="caution">{t.devices.notTrusted}</Badge>
        ) : (
          target.developerMode === 'enabled' && <Badge tone="success">{t.devices.devModeOn}</Badge>
        )}
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t.common.moreActionsFor(target.name)} aria-haspopup="menu" {...menu.triggerProps}>
          <Icon name="more" size={16} />
        </button>
        <Menu
          state={menu}
          label={t.common.actionsFor(target.name)}
          items={[{ id: 'udid', label: t.devices.copyUdid, icon: 'copy', hint: target.udid.slice(0, 8), onSelect: () => void navigator.clipboard.writeText(target.udid).then(() => toast({ tone: 'success', title: t.devices.udidCopied })) }]}
        />
      </span>
      {hint && <span className="device-row__hint">{hint}</span>}
    </li>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="device-section" aria-label={title}>
      <h2 className="section-title">
        {title}
        {count !== undefined && <span className="faint"> · {count}</span>}
      </h2>
      {children}
    </section>
  );
}

export function Devices() {
  const macs = useMacs((s) => s.macs);
  const navigate = useApp((s) => s.navigate);
  const [picked, setPicked] = useState<string | null>(null);
  const mac = resolveMac(macs, picked);
  useWatchTargets(mac?.name);
  const entry = useTargets((s) => (mac ? s.byMac[mac.name] : undefined));
  const [query, setQuery] = useState('');
  const targets = entry?.targets;

  const { devices, groups, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (target: Target) => !q || `${target.name} ${target.os} ${target.model ?? ''} ${target.udid}`.toLowerCase().includes(q);
    const sims = (targets?.simulators ?? []).filter(match);
    const map = new Map<string, Target[]>();
    for (const target of sims) map.set(target.os, [...(map.get(target.os) ?? []), target]);
    const sorted = [...map.entries()].map(([os, list]) => [os, [...list].sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted'))] as const);
    return { devices: (targets?.devices ?? []).filter(match), groups: sorted, total: sims.length };
  }, [targets, query]);

  if (macs.length === 0) {
    return (
      <div className="page">
        <div className="page__inner">
          <header className="page__header">
            <div>
              <h1 className="page__title">{t.devices.title}</h1>
              <p className="page__subtitle">{t.devices.subtitle(t.common.yourMac)}</p>
            </div>
          </header>
          <EmptyState icon="phone" title={t.devices.emptyTitle} actions={<Button variant="accent" icon="add" onClick={() => navigate({ name: 'onboarding' })}>{t.common.pairMac}</Button>}>
            {t.devices.emptyBody}
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__header">
          <div>
            <h1 className="page__title">{t.devices.title}</h1>
            <p className="page__subtitle">{t.devices.subtitle(mac?.label ?? t.common.yourMac)}</p>
          </div>
          <div className="page__actions">
            {macs.length > 1 && <Select value={mac?.name ?? ''} onChange={(v) => setPicked(v)} label={t.devices.mac} width={200} options={macs.map((m) => ({ value: m.name, label: m.label }))} />}
            <SearchField placeholder={t.devices.search} aria-label={t.devices.searchLabel} value={query} onChange={(e) => setQuery(e.target.value)} onClear={() => setQuery('')} className="devices-search" />
          </div>
        </header>
        {entry?.error && !targets ? (
          <InfoBar tone="critical" title={t.devices.listFailed(mac?.label ?? t.common.theMac)} actions={<Button size="sm" onClick={() => mac && void call('macs.connect', { name: mac.name }).catch(() => undefined)}>{t.common.tryAgain}</Button>}>
            {both(entry.error)}
          </InfoBar>
        ) : !targets ? (
          <ul className="device-list" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="device-row">
                <Skeleton width={36} height={36} radius={8} />
                <Skeleton width={`${30 + ((i * 13) % 25)}%`} height={12} />
              </li>
            ))}
          </ul>
        ) : (
          <>
            <Section title={t.devices.devices} count={devices.length}>
              {devices.length ? (
                <ul className="device-list">
                  {devices.map((target) => (
                    <DeviceRow key={target.udid} target={target} />
                  ))}
                </ul>
              ) : (
                <div className="device-empty">
                  <Icon name="phone" size={20} />
                  <div>
                    <strong>{targets.deviceSupport ? t.devices.noDevice : t.devices.oldXcode}</strong>
                    <p className="muted">{targets.deviceSupport ? t.devices.noDeviceBody : t.devices.oldXcodeBody}</p>
                  </div>
                </div>
              )}
            </Section>
            <Section title={t.devices.simulators} count={total}>
              {groups.length === 0 ? (
                <div className="device-empty">
                  <Icon name="phone" size={20} />
                  <div>
                    <strong>{query ? t.common.nothingMatches : t.devices.noSimulators}</strong>
                    {!query && <p className="muted">{t.devices.noSimulatorsBody}</p>}
                  </div>
                </div>
              ) : (
                groups.map(([os, list]) => (
                  <div key={os} className="device-group">
                    <h3 className="device-group__title">{os}</h3>
                    <ul className="device-list">
                      {list.map((target) => (
                        <SimulatorRow key={target.udid} mac={mac!.name} target={target} />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
