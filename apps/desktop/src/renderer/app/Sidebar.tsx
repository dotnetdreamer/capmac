import { useEffect, type ReactNode } from 'react';
import type { MacSummary } from '../../shared/contract';
import { t } from '../../shared/i18n';
import { useApp, type Route } from '../state/app';
import { resolveMac, useMacs } from '../state/macs';
import { projectKey, useProjects } from '../state/projects';
import { isActive, isBusy, useRuns } from '../state/runs';
import { AppIcon } from '../ui/AppIcon';
import { StatusDot, type Tone } from '../ui/Feedback';
import { Icon, type IconName } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';

function NavItem({ icon, label, route, children, collapsed, badge }: { icon?: IconName; label: string; route: Route; children?: ReactNode; collapsed: boolean; badge?: ReactNode }) {
  const current = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);
  const selected = current.name === route.name && (route.name !== 'project' || (current.name === 'project' && projectKey(current.path) === projectKey(route.path)));
  const button = (
    <button
      type="button"
      className={`nav-item${selected ? ' is-selected' : ''}`}
      aria-current={selected ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      onClick={() => navigate(route)}
    >
      {children ?? <Icon name={icon!} size={16} filled={selected} />}
      {!collapsed && <span className="nav-item__label truncate">{label}</span>}
      {!collapsed && badge}
    </button>
  );
  return collapsed ? (
    <Tooltip content={label} placement="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

const MAC_TONE: Record<string, Tone> = { connected: 'ok', restored: 'ok', connecting: 'busy', reconnecting: 'warn', lost: 'warn', offline: 'error', closed: 'idle', idle: 'idle' };

export function macStatusText(mac: MacSummary): string {
  switch (mac.state) {
    case 'connected':
    case 'restored':
      if (mac.route === 'direct' || mac.route === 'relay') return t.macState.connectedRoute(mac.route);
      return mac.xcode ? t.macState.connectedWith(t.macState.xcode(mac.xcode)) : t.macState.connected;
    case 'connecting':
      return t.macState.connecting;
    case 'lost':
    case 'reconnecting':
      return t.macState.reconnecting;
    case 'offline':
      return t.macState.offline;
    default:
      return mac.xcode ? t.macState.xcode(mac.xcode) : t.macState.paired;
  }
}

function MacChip({ collapsed }: { collapsed: boolean }) {
  const macs = useMacs((s) => s.macs);
  const navigate = useApp((s) => s.navigate);
  const mac = resolveMac(macs);
  const tone = mac ? MAC_TONE[mac.state] ?? 'idle' : 'idle';
  const label = mac ? `${mac.label}: ${macStatusText(mac)}` : t.sidebar.noMac;
  const button = (
    <button type="button" className="mac-chip" onClick={() => navigate({ name: mac ? 'macs' : 'onboarding' })} aria-label={collapsed ? label : undefined}>
      <span className="mac-chip__icon">
        <Icon name="mac" size={16} />
        <StatusDot tone={tone} pulse={tone === 'busy' || tone === 'warn'} />
      </span>
      {!collapsed && (
        <span className="mac-chip__text">
          <span className="mac-chip__name truncate">{mac ? mac.label : t.common.pairMac}</span>
          <span className="mac-chip__status truncate">{mac ? macStatusText(mac) : t.sidebar.pairHint}</span>
        </span>
      )}
    </button>
  );
  return collapsed ? (
    <Tooltip content={label} placement="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

function ProjectItem({ path, name, collapsed }: { path: string; name: string; collapsed: boolean }) {
  const entry = useProjects((s) => s.byKey[projectKey(path)]);
  const run = useRuns((s) => s.byKey[projectKey(path)]);
  const inspect = useProjects((s) => s.inspect);
  useEffect(() => {
    if (!entry) void inspect(path);
  }, [entry, inspect, path]);
  const active = isActive(run);
  const tone: Tone | null = run?.status === 'failed' ? 'error' : active ? (isBusy(run) ? 'busy' : run?.mode === 'live' ? 'live' : 'ok') : null;
  return (
    <NavItem label={entry?.summary?.appName ?? name} route={{ name: 'project', path }} collapsed={collapsed} badge={tone ? <StatusDot tone={tone} pulse={tone === 'busy'} label={tone === 'error' ? t.sidebar.failed : run?.mode === 'live' ? t.common.live : t.sidebar.running} /> : undefined}>
      <span className="nav-item__app">
        <AppIcon src={entry?.icon} name={entry?.summary?.appName ?? name} seed={entry?.summary?.appId} size={16} />
        {collapsed && tone && <StatusDot tone={tone} />}
      </span>
    </NavItem>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const recents = useApp((s) => s.settings?.recentProjects ?? []);
  return (
    <nav className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label={t.sidebar.label}>
      <div className="sidebar__group">
        <NavItem icon="home" label={t.sidebar.home} route={{ name: 'home' }} collapsed={collapsed} />
      </div>
      {recents.length > 0 && (
        <div className="sidebar__group" role="group" aria-label={t.sidebar.recentProjects}>
          {!collapsed && <div className="sidebar__heading">{t.sidebar.projects}</div>}
          {recents.slice(0, 6).map((p) => (
            <ProjectItem key={p.path} path={p.path} name={p.name} collapsed={collapsed} />
          ))}
        </div>
      )}
      <div className="sidebar__group">
        {!collapsed && recents.length > 0 && <div className="sidebar__heading">{t.sidebar.tools}</div>}
        <NavItem icon="phone" label={t.sidebar.devices} route={{ name: 'devices' }} collapsed={collapsed} />
        <NavItem icon="mac" label={t.sidebar.macs} route={{ name: 'macs' }} collapsed={collapsed} />
      </div>
      <div className="sidebar__spacer" />
      <div className="sidebar__group sidebar__group--bottom">
        <MacChip collapsed={collapsed} />
        <NavItem icon="settings" label={t.sidebar.settings} route={{ name: 'settings' }} collapsed={collapsed} />
      </div>
    </nav>
  );
}
