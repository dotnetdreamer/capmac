import { useMemo, useState } from 'react';
import type { Target } from '../../../shared/contract';
import { toast, useApp } from '../../state/app';
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

function SimulatorRow({ mac, t }: { mac: string; t: Target }) {
  const [busy, setBusy] = useState<'boot' | 'shutdown' | null>(null);
  const menu = usePopover();
  const booted = t.state === 'Booted';
  const act = async (what: 'boot' | 'shutdown') => {
    setBusy(what);
    try {
      await call(what === 'boot' ? 'simulators.boot' : 'simulators.shutdown', { mac, udid: t.udid });
    } catch (err) {
      const e = errorInfo(err);
      toast({ tone: 'critical', title: e.message, body: e.hint });
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="device-row">
      <span className="device-row__glyph">
        <Icon name={targetGlyph(t)} size={20} />
      </span>
      <span className="device-row__name">
        <span className="truncate">{t.name}</span>
        {t.model && simplify(t.model) !== simplify(t.name) && <span className="device-row__model truncate">{t.model}</span>}
      </span>
      <span className="device-row__os">{t.os}</span>
      <span className={`device-row__state${booted ? ' is-on' : ''}`}>
        <StatusDot tone={busy ? 'busy' : targetTone(t)} pulse={Boolean(busy)} />
        {busy === 'boot' ? 'Booting…' : busy === 'shutdown' ? 'Shutting down…' : targetState(t)}
      </span>
      <span className="device-row__actions">
        {booted ? (
          <Button size="sm" icon="power" busy={busy === 'shutdown'} disabled={Boolean(busy)} onClick={() => void act('shutdown')}>
            Shut down
          </Button>
        ) : (
          <Button size="sm" icon="play" busy={busy === 'boot'} disabled={Boolean(busy)} onClick={() => void act('boot')}>
            Boot
          </Button>
        )}
        <button type="button" className="icon-btn icon-btn--sm" aria-label={`More for ${t.name}`} aria-haspopup="menu" {...menu.triggerProps}>
          <Icon name="more" size={16} />
        </button>
        <Menu
          state={menu}
          label={`${t.name} actions`}
          items={[{ id: 'udid', label: 'Copy UDID', icon: 'copy', hint: t.udid.slice(0, 8), onSelect: () => void navigator.clipboard.writeText(t.udid).then(() => toast({ tone: 'success', title: 'UDID copied' })) }]}
        />
      </span>
    </li>
  );
}

function DeviceRow({ t }: { t: Target }) {
  const devOff = t.developerMode === 'disabled';
  return (
    <li className="device-row device-row--device">
      <span className="device-row__glyph">
        <Icon name={targetGlyph(t)} size={20} />
      </span>
      <span className="device-row__name">
        <span className="truncate">{t.name}</span>
        {t.model && <span className="device-row__model truncate">{t.model}</span>}
      </span>
      <span className="device-row__os">{t.os}</span>
      <span className="device-row__badges">
        <Badge tone={t.state === 'connected' ? 'success' : 'neutral'} icon={t.state !== 'connected' ? 'plugDisconnected' : t.connection === 'network' ? 'wifi' : 'usb'}>
          {t.state === 'connected' ? (t.connection === 'network' ? 'Wi-Fi' : 'USB') : 'Not connected'}
        </Badge>
        <Badge tone={devOff ? 'caution' : t.developerMode === 'enabled' ? 'success' : 'neutral'}>Developer Mode {devOff ? 'off' : t.developerMode === 'enabled' ? 'on' : 'unknown'}</Badge>
        {t.paired === false && <Badge tone="caution">Not paired</Badge>}
      </span>
      <span className="device-row__hint">
        {devOff
          ? 'On the iPhone: Settings › Privacy & Security › Developer Mode.'
          : t.paired === false
            ? 'Connect it to the Mac and tap Trust.'
            : t.state !== 'connected'
              ? 'Plug it into the Mac or keep it on the same Wi-Fi, unlocked.'
              : 'Ready for Run and Live.'}
      </span>
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
    const match = (t: Target) => !q || `${t.name} ${t.os} ${t.model ?? ''} ${t.udid}`.toLowerCase().includes(q);
    const sims = (targets?.simulators ?? []).filter(match);
    const map = new Map<string, Target[]>();
    for (const t of sims) map.set(t.os, [...(map.get(t.os) ?? []), t]);
    const sorted = [...map.entries()].map(([os, list]) => [os, [...list].sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted'))] as const);
    return { devices: (targets?.devices ?? []).filter(match), groups: sorted, total: sims.length };
  }, [targets, query]);

  if (macs.length === 0) {
    return (
      <div className="page">
        <EmptyState icon="phone" title="Pair a Mac to see its simulators" actions={<Button variant="accent" onClick={() => navigate({ name: 'onboarding' })}>Pair a Mac</Button>}>
          Simulators and iPhones are attached to your Mac; capmac lists them here with their live state.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__header">
          <div>
            <h1 className="page__title">Devices</h1>
            <p className="page__subtitle">Simulators and iPhones on {mac?.label ?? 'your Mac'}, live.</p>
          </div>
          <div className="page__actions">
            {macs.length > 1 && <Select value={mac?.name ?? ''} onChange={(v) => setPicked(v)} label="Mac" width={200} options={macs.map((m) => ({ value: m.name, label: m.label }))} />}
            <SearchField placeholder="Search" aria-label="Search devices" value={query} onChange={(e) => setQuery(e.target.value)} onClear={() => setQuery('')} className="devices-search" />
          </div>
        </header>
        {entry?.error && !targets ? (
          <InfoBar tone="critical" title={`Can’t list devices on ${mac?.label}`} actions={<Button size="sm" onClick={() => mac && void call('macs.connect', { name: mac.name }).catch(() => undefined)}>Retry</Button>}>
            {entry.error.message} {entry.error.hint}
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
            <Section title="Devices" count={devices.length}>
              {devices.length ? (
                <ul className="device-list">
                  {devices.map((t) => (
                    <DeviceRow key={t.udid} t={t} />
                  ))}
                </ul>
              ) : (
                <div className="device-empty">
                  <Icon name="phone" size={20} />
                  <div>
                    <strong>{targets.deviceSupport ? 'No iPhone or iPad connected' : 'This Xcode can’t list devices'}</strong>
                    <p className="muted">{targets.deviceSupport ? 'Plug it into the Mac (or pair it over Wi-Fi in Xcode › Window › Devices), unlock it and tap Trust. It shows up here by itself.' : 'Device runs need Xcode 15 or newer on the Mac.'}</p>
                  </div>
                </div>
              )}
            </Section>
            <Section title="Simulators" count={total}>
              {groups.length === 0 ? (
                <div className="device-empty">
                  <Icon name="phone" size={20} />
                  <div>
                    <strong>{query ? 'Nothing matches' : 'No simulators installed'}</strong>
                    {!query && <p className="muted">Install the iOS platform on the Mac: Xcode › Settings › Components (or Macs › Check health).</p>}
                  </div>
                </div>
              ) : (
                groups.map(([os, list]) => (
                  <div key={os} className="device-group">
                    <h3 className="device-group__title">{os}</h3>
                    <ul className="device-list">
                      {list.map((t) => (
                        <SimulatorRow key={t.udid} mac={mac!.name} t={t} />
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
