import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import type { Target } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { workspaceBus, type WorkspaceAction } from '../../app/commands';
import { both, forgetProject } from '../../state/actions';
import { toast, useApp } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { resolveMac, useMacs, useTargets, useWatchTargets } from '../../state/macs';
import { projectKey, useProject, useProjects } from '../../state/projects';
import { useRun } from '../../state/runs';
import { Button, IconButton } from '../../ui/Button';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { EmptyState, InfoBar, Spinner } from '../../ui/Feedback';
import { Rich } from '../../ui/Rich';
import { Console } from './Console';
import { BuildIpaDialog, BuildLogDialog } from './Dialogs';
import { isListed, Problems } from './Problems';
import { SessionBar } from './SessionBar';
import { SimulatorPane } from './Simulator';
import { automaticTarget } from './TargetPicker';
import { Timeline } from './Timeline';
import { Toolbar } from './Toolbar';
import './workspace.css';

function Pane({ title, sub, actions, children, className, labelledBy }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; labelledBy: string }) {
  return (
    <section className={`pane${className ? ` ${className}` : ''}`} aria-labelledby={labelledBy}>
      <header className="pane__header">
        <h2 id={labelledBy} className="pane__title">
          {title}
        </h2>
        {sub && <span className="pane__sub truncate">{sub}</span>}
        <span className="pane__spacer" />
        {actions}
      </header>
      <div className="pane__body">{children}</div>
    </section>
  );
}

const storage = typeof localStorage === 'undefined' ? undefined : localStorage;

/** Offers `npm install` (or the project's package manager) when node_modules is missing on this PC. */
function DepsBanner({ path, packageManager, onInstalled }: { path: string; packageManager: string; onInstalled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const install = async () => {
    setBusy(true);
    try {
      await call('projects.installDeps', { path });
      toast({ tone: 'success', title: t.workspace.deps.installed, body: t.workspace.deps.installedBody });
      onInstalled();
    } catch (err) {
      const e = errorInfo(err);
      if (!e.cancelled) toast({ tone: 'critical', title: t.workspace.deps.failed, body: both(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="session-banner">
      <InfoBar
        tone="info"
        title={t.workspace.deps.title}
        onDismiss={busy ? undefined : () => setDismissed(true)}
        actions={
          <Button size="sm" variant="accent" busy={busy} onClick={() => void install()}>
            {busy ? t.workspace.deps.installing : t.workspace.deps.install(packageManager)}
          </Button>
        }
      >
        {t.workspace.deps.body}
      </InfoBar>
    </div>
  );
}

export function Workspace({ path }: { path: string }) {
  const entry = useProject(path);
  const inspect = useProjects((s) => s.inspect);
  const run = useRun(path);
  const macs = useMacs((s) => s.macs);
  const prefs = useApp((s) => s.settings?.projectPrefs[projectKey(path)]);
  const updateSettings = useApp((s) => s.updateSettings);
  const deviceFrame = useApp((s) => s.settings?.deviceFrame ?? true);
  const mac = resolveMac(macs, prefs?.mac ?? entry.summary?.host);
  useWatchTargets(mac?.name);
  const targetsEntry = useTargets((s) => (mac ? s.byMac[mac.name] : undefined));
  const targets = targetsEntry?.targets ?? null;

  const [tab, setTab] = useState<'console' | 'problems'>('console');
  const [ipaOpen, setIpaOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const simPanel = usePanelRef();
  const timelinePanel = usePanelRef();
  const bottomPanel = usePanelRef();
  const outer = useDefaultLayout({ id: 'capmac-ws-outer', storage, onlySaveAfterUserInteractions: true });
  const inner = useDefaultLayout({ id: 'capmac-ws-inner', storage, onlySaveAfterUserInteractions: true });

  useEffect(() => {
    void inspect(path).then((summary) => {
      if (summary) void window.capmac.invoke('app:project-opened', { path: summary.path, name: summary.appName, appId: summary.appId });
    });
  }, [inspect, path]);

  // The target: the toolbar pick, else the last run's, else what `capmac run` would choose. Always with live state.
  const { target, auto } = useMemo((): { target: Target | null; auto: boolean } => {
    const all = targets ? [...targets.simulators, ...targets.devices] : [];
    const picked = prefs?.target ? all.find((item) => item.udid === prefs.target) : undefined;
    if (picked) return { target: picked, auto: false };
    if (run?.target) return { target: all.find((item) => item.udid === run.target!.udid) ?? run.target, auto: true };
    return { target: automaticTarget(targets), auto: true };
  }, [targets, prefs?.target, run?.target]);

  const errors = run?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
  // The tab counts what the Problems list shows, not the dependency warnings folded away.
  const showDeps = useApp((s) => s.settings?.dependencyWarnings ?? false);
  const listed = run?.diagnostics.filter((d) => isListed(d, showDeps)).length ?? 0;
  useEffect(() => {
    if (run?.status === 'failed' && errors > 0) setTab('problems');
  }, [run?.status, run?.runNumber, errors]);

  useEffect(() => {
    const toggle = (panel: typeof simPanel) => {
      const p = panel.current;
      if (!p) return;
      if (p.isCollapsed()) p.expand();
      else p.collapse();
    };
    const onAction = (e: Event) => {
      switch ((e as CustomEvent<WorkspaceAction>).detail) {
        case 'toggle-simulator':
          toggle(simPanel);
          break;
        case 'toggle-timeline':
          toggle(timelinePanel);
          break;
        case 'toggle-console':
          if (bottomPanel.current?.isCollapsed()) bottomPanel.current.expand();
          setTab('console');
          break;
        case 'show-problems':
          if (bottomPanel.current?.isCollapsed()) bottomPanel.current.expand();
          setTab('problems');
          break;
        case 'find-console':
          setTab('console');
          break;
        case 'build-ipa':
          setIpaOpen(true);
          break;
        case 'show-build-log':
          setLogOpen(true);
          break;
        default:
          break;
      }
    };
    workspaceBus.addEventListener('action', onAction);
    return () => workspaceBus.removeEventListener('action', onAction);
  }, [simPanel, timelinePanel, bottomPanel]);

  if (!entry.summary) {
    return (
      <div className="workspace workspace--empty">
        {entry.error ? (
          <EmptyState
            icon="warning"
            title={t.workspace.cantOpen}
            actions={
              <>
                <Button onClick={() => void inspect(path, true)}>{t.common.tryAgain}</Button>
                <Button variant="subtle" onClick={() => void forgetProject(path)}>
                  {t.workspace.removeFromList}
                </Button>
              </>
            }
          >
            {both(entry.error)}
          </EmptyState>
        ) : (
          <div className="workspace__loading">
            <Spinner size={24} label={t.workspace.opening} />
          </div>
        )}
      </div>
    );
  }

  const summary = entry.summary;
  return (
    <div className="workspace">
      <Toolbar path={path} summary={summary} icon={entry.icon} run={run} macs={macs} mac={mac} targets={targets} target={target} autoTarget={auto} targetsLoading={Boolean(mac) && !targets && !targetsEntry?.error} />
      <SessionBar path={path} run={run} mac={mac} />
      {!summary.hasIos && (
        <div className="session-banner">
          <InfoBar tone="caution" title={t.workspace.noIosTitle}>
            <Rich text={t.workspace.noIosBody} />
          </InfoBar>
        </div>
      )}
      {summary.hasIos && !summary.hasNodeModules && summary.devCommand && <DepsBanner path={path} packageManager={summary.packageManager} onInstalled={() => void inspect(path, true)} />}
      {macs.length === 0 && (
        <div className="session-banner">
          <InfoBar tone="info" title={t.workspace.pairBanner} actions={<Button size="sm" variant="accent" onClick={() => useApp.getState().navigate({ name: 'onboarding' })}>{t.common.pairMac}</Button>} />
        </div>
      )}
      <Group orientation="horizontal" id="capmac-ws-outer" className="ws-panels" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
        <Panel id="simulator" panelRef={simPanel} collapsible collapsedSize={0} minSize={240} defaultSize="31%" className="ws-panel">
          <Pane
            title={t.workspace.simulator}
            labelledBy="pane-sim"
            sub={target?.kind === 'simulator' ? `${target.name} · ${target.os}` : undefined}
            className="pane--sim"
            actions={<IconButton icon="phone" size="sm" label={deviceFrame ? t.workspace.hideFrame : t.workspace.showFrame} pressed={deviceFrame} onClick={() => void updateSettings({ deviceFrame: !deviceFrame })} />}
          >
            <ErrorBoundary label={t.crash.parts.simulator} compact>
              <SimulatorPane mac={mac} target={target} />
            </ErrorBoundary>
          </Pane>
        </Panel>
        <Separator className="ws-sep ws-sep--v" />
        <Panel id="main" minSize="35%" className="ws-panel">
          <Group orientation="vertical" id="capmac-ws-inner" defaultLayout={inner.defaultLayout} onLayoutChanged={inner.onLayoutChanged}>
            <Panel id="timeline" panelRef={timelinePanel} collapsible collapsedSize={0} minSize={124} defaultSize={168} className="ws-panel">
              <Pane title={t.workspace.timeline} labelledBy="pane-timeline">
                <ErrorBoundary label={t.crash.parts.timeline} compact>
                  <Timeline run={run} />
                </ErrorBoundary>
              </Pane>
            </Panel>
            <Separator className="ws-sep ws-sep--h" />
            <Panel id="output" panelRef={bottomPanel} collapsible collapsedSize={0} minSize={160} className="ws-panel">
              <section className="pane pane--tabs" aria-label={t.workspace.output}>
                <div className="pane__header pane__header--tabs" role="tablist" aria-label={t.workspace.output}>
                  <button type="button" role="tab" id="tab-console" aria-selected={tab === 'console'} aria-controls="tabpanel-console" className={`tab${tab === 'console' ? ' is-selected' : ''}`} onClick={() => setTab('console')}>
                    {t.workspace.console}
                  </button>
                  <button type="button" role="tab" id="tab-problems" aria-selected={tab === 'problems'} aria-controls="tabpanel-problems" className={`tab${tab === 'problems' ? ' is-selected' : ''}`} onClick={() => setTab('problems')}>
                    {t.workspace.problems}
                    {listed > 0 && <span className={`count ${errors ? 'count--error' : 'count--warn'}`}>{errors || listed}</span>}
                  </button>
                </div>
                <div className="pane__body" role="tabpanel" id={tab === 'console' ? 'tabpanel-console' : 'tabpanel-problems'} aria-labelledby={tab === 'console' ? 'tab-console' : 'tab-problems'}>
                  {/* Keep the console mounted: it holds scroll position and search state. */}
                  <div className="tab-content" hidden={tab !== 'console'}>
                    <ErrorBoundary label={t.crash.parts.console} compact>
                      <Console path={path} visible={tab === 'console'} />
                    </ErrorBoundary>
                  </div>
                  {tab === 'problems' && (
                    <ErrorBoundary label={t.crash.parts.problems} compact>
                      <Problems path={path} run={run} />
                    </ErrorBoundary>
                  )}
                </div>
              </section>
            </Panel>
          </Group>
        </Panel>
      </Group>
      <BuildIpaDialog path={path} open={ipaOpen} onClose={() => setIpaOpen(false)} />
      <BuildLogDialog path={path} logPath={run?.buildLogPath ?? null} open={logOpen} onClose={() => setLogOpen(false)} />
    </div>
  );
}
