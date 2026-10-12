import { useEffect, useState } from 'react';
import type { MacSummary } from '../../../shared/contract';
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
import './macs.css';

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
      if (!e.cancelled) toast({ tone: 'critical', title: e.message, body: e.hint });
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
            {mac.isDefault && <Badge tone="accent">Default</Badge>}
          </div>
          <div className="mac-card__host mono">
            {mac.username}@{mac.host}
            {mac.port !== 22 ? `:${mac.port}` : ''}
          </div>
        </div>
        <div className="mac-card__status">
          <span className={`mac-card__state mac-card__state--${tone}`}>{mac.state === 'connected' || mac.state === 'restored' ? 'Connected' : macStatusText(mac)}</span>
          {mac.state === 'offline' && mac.error && <span className="mac-card__error">{mac.error}</span>}
        </div>
        <div className="mac-card__actions">
          {(mac.state === 'offline' || mac.state === 'idle') && (
            <Button size="sm" icon="plugConnected" onClick={() => void act(() => call('macs.connect', { name: mac.name }))}>
              Connect
            </Button>
          )}
          <Button size="sm" icon="health" onClick={() => {
            if (!expanded) onToggle();
            void runHealth(mac.name);
          }}>
            Check health
          </Button>
          <button type="button" className="icon-btn icon-btn--sm" aria-label={`More actions for ${mac.label}`} aria-haspopup="menu" {...menu.triggerProps}>
            <Icon name="more" size={16} />
          </button>
          <Menu
            state={menu}
            label={`${mac.label} actions`}
            width={240}
            items={[
              { id: 'default', label: 'Make default', icon: 'check', disabled: mac.isDefault, onSelect: () => void act(() => call('macs.setDefault', { name: mac.name }), `${mac.label} is now the default Mac`) },
              { id: 'keychain', label: 'Unlock keychain…', icon: 'key', onSelect: () => void act(() => call('macs.unlockKeychain', { name: mac.name }), 'Keychain unlocked') },
              { id: 'reconnect', label: 'Reconnect', icon: 'refresh', onSelect: () => void act(() => call('macs.connect', { name: mac.name })) },
              { id: 'unpair', label: 'Unpair…', icon: 'unlink', danger: true, separatorBefore: true, onSelect: () => setUnpairing(true) },
            ]}
          />
          <IconButton icon={expanded ? 'chevronUp' : 'chevronDown'} size="sm" label={expanded ? 'Hide details' : 'Show details'} onClick={onToggle} />
        </div>
      </div>
      <dl className="mac-card__facts">
        <div>
          <dt>macOS</dt>
          <dd>{probe?.macos ?? '—'}</dd>
        </div>
        <div>
          <dt>Xcode</dt>
          <dd>{probe?.xcode?.version ?? mac.xcode ?? '—'}</dd>
        </div>
        <div>
          <dt>Chip</dt>
          <dd>{probe ? (probe.arch === 'arm64' ? 'Apple silicon' : 'Intel') : '—'}</dd>
        </div>
        <div>
          <dt>Simulators</dt>
          <dd>{probe ? `${probe.simulators.devices} · ${probe.simulators.runtimes.join(', ') || 'none'}` : '—'}</dd>
        </div>
        <div>
          <dt>Paired</dt>
          <dd>{timeAgo(Date.parse(mac.pairedAt))}</dd>
        </div>
      </dl>
      {expanded && (
        <div className="mac-card__health">
          {health ? (
            <>
              <div className="mac-card__health-head">
                <h3>Health</h3>
                <span className="faint">
                  {health.status === 'checking' ? 'Checking…' : failing ? `${failing} need${failing === 1 ? 's' : ''} attention` : 'All good'}
                  {health.status !== 'checking' && ` · ${timeAgo(health.at)}`}
                </span>
              </div>
              <CheckList mac={mac.name} checks={health.checks.filter((c) => c.group === 'mac' && c.id !== 'mac')} checking={health.status === 'checking'} />
            </>
          ) : (
            <div className="mac-card__health-empty">
              <Button icon="health" onClick={() => void runHealth(mac.name)}>
                Check {mac.label}
              </Button>
              <span className="faint">Xcode, simulators, Node.js, CocoaPods, disk space and signing.</span>
            </div>
          )}
        </div>
      )}
      {unpairing && (
        <Dialog
          open
          size="sm"
          icon="warning"
          title={`Unpair ${mac.label}?`}
          onClose={() => setUnpairing(false)}
          footer={
            <>
              <Button
                variant="danger"
                onClick={() => {
                  setUnpairing(false);
                  void act(() => call('macs.unpair', { name: mac.name }), `${mac.label} unpaired`);
                }}
              >
                Unpair
              </Button>
              <Button onClick={() => setUnpairing(false)} data-autofocus>
                Cancel
              </Button>
            </>
          }
        >
          <p>capmac forgets this Mac. Its key stays in ~/.ssh/authorized_keys on the Mac; remove the line ending in “capmac@” there to revoke it.</p>
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
  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__header">
          <div>
            <h1 className="page__title">Macs</h1>
            <p className="page__subtitle">The Macs this PC builds on, over one SSH connection each.</p>
          </div>
          {macs.length > 0 && (
            <div className="page__actions">
              <Button variant="accent" icon="add" onClick={() => navigate({ name: 'onboarding' })}>
                Pair a Mac
              </Button>
            </div>
          )}
        </header>
        {loaded && macs.length === 0 ? (
          <EmptyState icon="mac" title="No Mac paired yet" actions={<Button variant="accent" icon="add" onClick={() => navigate({ name: 'onboarding' })}>Pair a Mac</Button>}>
            capmac Studio builds your app with Xcode on a Mac on your network. Pairing takes a minute: turn on Remote Login on the Mac and sign in once.
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
