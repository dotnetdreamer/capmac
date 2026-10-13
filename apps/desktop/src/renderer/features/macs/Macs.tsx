import { useEffect, useState } from 'react';
import type { MacSummary } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { macStatusText } from '../../app/Sidebar';
import { toast, useApp } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { useMacs } from '../../state/macs';
import { timeAgo } from '../../lib/format';
import { Button, IconButton } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Badge, EmptyState, StatusDot, type Tone } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Menu, usePopover } from '../../ui/Popover';
import { CheckList } from './CheckList';
import { RemoteAccess } from './RemoteAccess';
import './macs.css';

/** "Connected", or how over the internet: "Connected directly over the internet · 42 ms". */
function connectedText(mac: MacSummary): string {
  if (mac.route === 'direct') return `${t.macState.connectedRoute('direct')}${mac.rttMs !== null ? ` · ${mac.rttMs} ms` : ''}`;
  if (mac.route === 'relay') return t.macState.connectedRoute('relay');
  return t.macState.connected;
}

const TONE: Record<string, Tone> = { connected: 'ok', restored: 'ok', connecting: 'busy', reconnecting: 'warn', lost: 'warn', offline: 'error', idle: 'idle', closed: 'idle' };

function MacCard({ mac, expanded, onToggle }: { mac: MacSummary; expanded: boolean; onToggle: () => void }) {
  const health = useMacs((s) => s.health[mac.name]);
  const runHealth = useMacs((s) => s.runHealth);
  const refresh = useMacs((s) => s.refresh);
  const menu = usePopover();
  const [unpairing, setUnpairing] = useState(false);
  const probe = health?.probe;
  const tone = TONE[mac.state] ?? 'idle';
  const failing = health?.checks.filter((c) => c.group === 'mac' && (c.level === 'fail' || c.level === 'warn')).length ?? 0;

  const act = async (what: () => Promise<unknown>, done?: string) => {
    try {
      await what();
      if (done) toast({ tone: 'success', title: done });
    } catch (err) {
      const e = errorInfo(err);
      if (!e.cancelled) toast({ tone: 'critical', title: tidy(e.message), body: tidy(e.hint) });
    }
    void refresh();
  };

  return (
    <article className={`mac-card${expanded ? ' is-expanded' : ''}`} aria-label={mac.label}>
      <div className="mac-card__head">
        <span className="mac-card__glyph">
          <Icon name="mac" size={20} />
          <StatusDot tone={tone} pulse={tone === 'busy' || tone === 'warn'} />
        </span>
        <div className="mac-card__ident">
          <div className="mac-card__name">
            {mac.label}
            {mac.isDefault && <Badge tone="accent">{t.common.default}</Badge>}
          </div>
          <div className="mac-card__host mono">
            {mac.username}@{mac.host}
            {mac.port !== 22 ? `:${mac.port}` : ''}
          </div>
        </div>
        <div className="mac-card__status">
          <span className={`mac-card__state mac-card__state--${tone}`}>{mac.state === 'connected' || mac.state === 'restored' ? connectedText(mac) : macStatusText(mac)}</span>
          {mac.state === 'offline' && mac.error && <span className="mac-card__error">{tidy(mac.error)}</span>}
        </div>
        <div className="mac-card__actions">
          {(mac.state === 'offline' || mac.state === 'idle') && (
            <Button size="sm" icon="plugConnected" onClick={() => void act(() => call('macs.connect', { name: mac.name }))}>
              {t.macs.connect}
            </Button>
          )}
          <Button size="sm" icon="health" onClick={() => {
            if (!expanded) onToggle();
            void runHealth(mac.name);
          }}>
            {t.macs.checkHealth}
          </Button>
          <button type="button" className="icon-btn icon-btn--sm" aria-label={t.common.moreActionsFor(mac.label)} aria-haspopup="menu" {...menu.triggerProps}>
            <Icon name="more" size={16} />
          </button>
          <Menu
            state={menu}
            label={t.common.actionsFor(mac.label)}
            width={240}
            items={[
              { id: 'default', label: t.macs.makeDefault, icon: 'check', disabled: mac.isDefault, onSelect: () => void act(() => call('macs.setDefault', { name: mac.name }), t.macs.nowDefault(mac.label)) },
              { id: 'keychain', label: t.macs.unlockKeychain, icon: 'key', onSelect: () => void act(() => call('macs.unlockKeychain', { name: mac.name }), t.macs.keychainUnlocked) },
              { id: 'reconnect', label: t.macs.reconnect, icon: 'refresh', onSelect: () => void act(() => call('macs.connect', { name: mac.name })) },
              { id: 'unpair', label: t.macs.unpairMenu, icon: 'unlink', danger: true, separatorBefore: true, onSelect: () => setUnpairing(true) },
            ]}
          />
          <IconButton icon={expanded ? 'chevronUp' : 'chevronDown'} size="sm" label={expanded ? t.macs.hideDetails : t.macs.showDetails} onClick={onToggle} />
        </div>
      </div>
      <dl className="mac-card__facts">
        <div>
          <dt>{t.macs.facts.macos}</dt>
          <dd>{probe?.macos ?? '—'}</dd>
        </div>
        <div>
          <dt>{t.macs.facts.xcode}</dt>
          <dd>{probe?.xcode?.version ?? mac.xcode ?? '—'}</dd>
        </div>
        <div>
          <dt>{t.macs.facts.chip}</dt>
          <dd>{probe ? (probe.arch === 'arm64' ? t.macs.appleSilicon : t.macs.intel) : '—'}</dd>
        </div>
        <div>
          <dt>{t.macs.facts.simulators}</dt>
          <dd>{probe ? `${probe.simulators.devices} · ${probe.simulators.runtimes.join(', ') || t.common.none}` : '—'}</dd>
        </div>
        <div>
          <dt>{t.macs.facts.paired}</dt>
          <dd>{timeAgo(Date.parse(mac.pairedAt))}</dd>
        </div>
      </dl>
      <RemoteAccess mac={mac} />
      {expanded && (
        <div className="mac-card__health">
          {health ? (
            <>
              <div className="mac-card__health-head">
                <h3>{t.macs.health}</h3>
                <span className="faint">
                  {health.status === 'checking' ? t.macs.checking : failing ? t.macs.needAttention(failing) : t.macs.allGood}
                  {health.status !== 'checking' && ` · ${timeAgo(health.at)}`}
                </span>
              </div>
              <CheckList mac={mac.name} checks={health.checks.filter((c) => c.group === 'mac' && c.id !== 'mac')} checking={health.status === 'checking'} />
            </>
          ) : (
            <div className="mac-card__health-empty">
              <Button icon="health" onClick={() => void runHealth(mac.name)}>
                {t.macs.checkMac(mac.label)}
              </Button>
              <span className="faint">{t.macs.checkWhat}</span>
            </div>
          )}
        </div>
      )}
      {unpairing && (
        <Dialog
          open
          size="sm"
          icon="warning"
          title={t.macs.unpairTitle(mac.label)}
          onClose={() => setUnpairing(false)}
          footer={
            <>
              <Button
                variant="danger"
                onClick={() => {
                  setUnpairing(false);
                  void act(() => call('macs.unpair', { name: mac.name }), t.macs.unpaired(mac.label));
                }}
              >
                {t.macs.unpair}
              </Button>
              <Button onClick={() => setUnpairing(false)} data-autofocus>
                {t.common.cancel}
              </Button>
            </>
          }
        >
          <p>{t.macs.unpairBody}</p>
        </Dialog>
      )}
    </article>
  );
}

export function Macs() {
  const macs = useMacs((s) => s.macs);
  const loaded = useMacs((s) => s.loaded);
  const navigate = useApp((s) => s.navigate);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    void useMacs.getState().refresh();
  }, []);
  useEffect(() => {
    if (!expanded && macs[0]) setExpanded((macs.find((m) => m.isDefault) ?? macs[0]).name);
  }, [macs, expanded]);
  // Check connected Macs once per session: it fills in macOS, chip and simulators, and finds problems early.
  useEffect(() => {
    const { health, runHealth } = useMacs.getState();
    for (const m of macs) {
      if ((m.state === 'connected' || m.state === 'restored') && !health[m.name]) void runHealth(m.name);
    }
  }, [macs]);
  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__header">
          <div>
            <h1 className="page__title">{t.macs.title}</h1>
            <p className="page__subtitle">{t.macs.subtitle}</p>
          </div>
          {macs.length > 0 && (
            <div className="page__actions">
              <Button variant="accent" icon="add" onClick={() => navigate({ name: 'onboarding' })}>
                {t.common.pairMac}
              </Button>
            </div>
          )}
        </header>
        {loaded && macs.length === 0 ? (
          <EmptyState icon="mac" title={t.macs.emptyTitle} actions={<Button variant="accent" icon="add" onClick={() => navigate({ name: 'onboarding' })}>{t.common.pairMac}</Button>}>
            {t.macs.emptyBody}
          </EmptyState>
        ) : (
          <div className="mac-list">
            {macs.map((m) => (
              <MacCard key={m.name} mac={m} expanded={expanded === m.name} onToggle={() => setExpanded((e) => (e === m.name ? null : m.name))} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
