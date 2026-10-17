import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import type { Target, TargetsResult } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { workspaceBus, type WorkspaceAction } from '../../app/commands';
import { canRun, searchOf } from '../../lib/apps';
import { appOf, both, forgetProject, setApp, setBackend, startSession } from '../../state/actions';
import { toast, useApp } from '../../state/app';
import { useChooser } from '../../state/chooser';
import { call, errorInfo } from '../../state/engine';
import { resolveMac, useMacs, useTargets, useWatchTargets } from '../../state/macs';
import { pcReady, usePc, usePcEntry, usePcWatch } from '../../state/pc';
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
import { AppWindowPane } from './AppWindow';
import { SimulatorPane } from './Simulator';
import { automaticTarget, macDesktopTarget, thisPcTarget } from './TargetPicker';
import { MAC_TARGET_ID } from '../../state/runs';
import { PcBanner, PcDevicePane, PcSetupDialog, WindowsAppPane } from './PcSetup';
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

/** Projects already asked which app to work on, since Studio started (a dismissed question waits for the next start). */
const asked = new Set<string>();

/** Offers `npm install` (or the project's package manager) when node_modules is missing on this PC. */
function DepsBanner({ path, packageManager, onInstalled, reactNative = false }: { path: string; packageManager: string; onInstalled: () => void; reactNative?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const install = async () => {
    setBusy(true);
    try {
      await call('projects.installDeps', { path });
      toast({ tone: 'success', title: t.workspace.deps.installed, body: reactNative ? t.workspace.deps.installedBodyReactNative : t.workspace.deps.installedBody });
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
        {reactNative ? t.workspace.deps.bodyReactNative : t.workspace.deps.body}
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
  const electron = entry.summary?.electron ?? null;
  const flutter = entry.summary?.kind === 'flutter';
  const reactNative = entry.summary?.kind === 'react-native';
  // An app per platform folder: its Mac app runs on the Mac's desktop, its Windows app on this PC.
  const multi = flutter || reactNative;
  // The app Run and Live use: the Electron app and a Flutter app's Mac app run on the Mac's desktop, the iOS app in simulators and on devices.
  const app = appOf(entry.summary, prefs ?? {}) ?? 'ios';
  const onlyMac = Boolean((electron && app === 'electron') || (multi && app === 'macos'));
  // A Flutter app's Windows app runs on this PC, in its own window: no Mac and no other target.
  const pcDesktop = multi && app === 'windows';
  // Without a Mac yet, still the Mac's desktop: the pane then says how to pair one.
  const macDesktop = useMemo(() => (onlyMac ? macDesktopTarget(mac?.label ?? (multi ? t.targets.macGroupFlutter : t.targets.macGroup), mac?.macos ?? null) : null), [mac, onlyMac, flutter]);
  const pcDesktopTarget = useMemo(() => (pcDesktop ? thisPcTarget() : null), [pcDesktop]);
  // On this PC (no Mac): the iPhones plugged in here, and this PC's setup.
  const pcMode = entry.summary?.backend === 'wsl' && app === 'ios';
  usePcWatch(path, pcMode);
  const pcEntry = usePcEntry(path);
  const pcState = pcEntry.running ? 'running' : pcReady(pcEntry.status) ? 'ready' : 'setup';
  const pcTargets = useMemo((): TargetsResult | null => (pcEntry.devices ? { simulators: [], devices: pcEntry.devices.devices, deviceSupport: true } : null), [pcEntry.devices]);
  useWatchTargets(onlyMac || pcMode || pcDesktop ? null : mac?.name);
  const targetsEntry = useTargets((s) => (mac ? s.byMac[mac.name] : undefined));
  const targets = pcMode ? pcTargets : targetsEntry?.targets ?? null;

  const [tab, setTab] = useState<'console' | 'problems'>('console');
  const [ipaOpen, setIpaOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const simPanel = usePanelRef();
  const timelinePanel = usePanelRef();
  const bottomPanel = usePanelRef();
  const outer = useDefaultLayout({ id: 'capmac-ws-outer', storage, onlySaveAfterUserInteractions: true });
  // A Mac app's window is wide: its own layout, remembered apart from the simulator's.
  const outerMac = useDefaultLayout({ id: 'capmac-ws-outer-mac', storage, onlySaveAfterUserInteractions: true });
  const inner = useDefaultLayout({ id: 'capmac-ws-inner', storage, onlySaveAfterUserInteractions: true });

  useEffect(() => {
    void inspect(path).then((summary) => {
      if (summary) void window.capmac.invoke('app:project-opened', { path: summary.path, name: summary.appName, appId: summary.appId });
    });
  }, [inspect, path]);

  // A React Native run installs the packages on this PC itself (Metro needs them): once Metro is up, read the project again.
  const metroUp = reactNative && run?.phases.devserver?.status === 'done';
  const needsPackages = entry.summary ? !entry.summary.hasNodeModules : false;
  useEffect(() => {
    if (metroUp && needsPackages) void inspect(path, true);
  }, [metroUp, needsPackages, inspect, path]);

  // A project with more than one app, opened before one was picked: ask which, once.
  const summaryNow = entry.summary;
  useEffect(() => {
    if (!summaryNow || summaryNow.appChosen || summaryNow.apps.filter(canRun).length < 2) return;
    const key = projectKey(path);
    if (asked.has(key)) return;
    asked.add(key);
    // The Mac's desktop picked as the target was how the Electron app was picked before: keep that.
    if (prefs?.target === MAC_TARGET_ID && summaryNow.apps.some((a) => a.id === 'electron')) {
      void setApp(path, 'electron');
      return;
    }
    void useChooser
      .getState()
      .ask(searchOf(summaryNow))
      .then((choice) => choice && setApp(choice.dir, choice.app));
  }, [summaryNow, path, prefs?.target]);

  // The target: the toolbar pick, else the last run's, else what `capmac run` would choose. Always with live state.
  const { target, auto } = useMemo((): { target: Target | null; auto: boolean } => {
    // The Electron app (or a Flutter app's Mac app) runs on the Mac's desktop, and only there; a Flutter app's Windows app on this PC.
    if (macDesktop) return { target: macDesktop, auto: false };
    if (pcDesktopTarget) return { target: pcDesktopTarget, auto: false };
    // On this PC: the iPhone picked when it is plugged in, else the one that is.
    if (pcMode) {
      const plugged = pcTargets?.devices ?? [];
      const picked = prefs?.target ? plugged.find((item) => item.udid === prefs.target) : undefined;
      if (picked) return { target: picked, auto: false };
      if (run?.backend === 'wsl' && run.target?.kind === 'device') return { target: plugged.find((item) => item.udid === run.target!.udid) ?? run.target, auto: true };
      return { target: plugged[0] ?? null, auto: true };
    }
    const all = targets ? [...targets.simulators, ...targets.devices] : [];
    const picked = prefs?.target && prefs.target !== MAC_TARGET_ID ? all.find((item) => item.udid === prefs.target) : undefined;
    if (picked) return { target: picked, auto: false };
    // A Mac target left over from an Electron run is not for the iOS app (only it reaches here): ignore it.
    if (run?.target && run.target.kind !== 'mac') return { target: all.find((item) => item.udid === run.target!.udid) ?? run.target, auto: true };
    return { target: automaticTarget(targets), auto: true };
  }, [targets, prefs?.target, run?.target, run?.backend, macDesktop, pcDesktopTarget, pcMode, pcTargets]);

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
          // On this PC there is one kind: a development .ipa, built right away.
          if (pcMode) void startSession(path, 'build');
          else setIpaOpen(true);
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
  }, [simPanel, timelinePanel, bottomPanel, pcMode, path]);

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
  const electronKind = summary.electron && app === 'electron' ? (summary.electron.flavor === 'capacitor' ? 'capacitor' : 'plain') : null;
  const onMacTarget = target?.kind === 'mac';
  return (
    <div className="workspace">
      <Toolbar path={path} summary={summary} icon={entry.icon} run={run} macs={macs} mac={mac} targets={targets} target={target} autoTarget={auto} targetsLoading={pcMode ? !pcEntry.devices : !pcDesktop && Boolean(mac) && !targets && !targetsEntry?.error} macDesktop={macDesktop} onlyMac={onlyMac} pcDesktop={pcDesktop} app={app} pc={pcMode} pcState={pcState} />
      <SessionBar path={path} run={run} mac={mac} electron={electronKind} flutter={flutter} reactNative={reactNative} />
      {app === 'ios' && !summary.hasIos && (
        <div className="session-banner">
          <InfoBar tone="caution" title={t.workspace.noIosTitle}>
            <Rich text={flutter ? t.workspace.noIosBodyFlutter : reactNative ? t.workspace.noIosBodyReactNative : t.workspace.noIosBody} />
          </InfoBar>
        </div>
      )}
      {(summary.hasIos || summary.electron?.flavor === 'capacitor' || reactNative) && !summary.hasNodeModules && summary.devCommand && <DepsBanner path={path} packageManager={summary.packageManager} reactNative={reactNative} onInstalled={() => void inspect(path, true)} />}
      {pcMode && <PcBanner path={path} entry={pcEntry} />}
      {!pcMode && !pcDesktop && macs.length === 0 && (
        <div className="session-banner">
          <InfoBar
            tone="info"
            title={t.workspace.pairBanner}
            actions={
              <>
                <Button size="sm" variant="accent" onClick={() => useApp.getState().navigate({ name: 'onboarding' })}>
                  {t.common.pairMac}
                </Button>
                {app === 'ios' && (summary.kind === 'capacitor' || multi) && (
                  <Button size="sm" icon="desktop" onClick={() => void setBackend(path, 'wsl')}>
                    {t.pc.noMacBanner}
                  </Button>
                )}
              </>
            }
          />
        </div>
      )}
      <Group
        key={onMacTarget ? 'mac' : 'sim'}
        orientation="horizontal"
        id={onMacTarget ? 'capmac-ws-outer-mac' : 'capmac-ws-outer'}
        className="ws-panels"
        defaultLayout={(onMacTarget ? outerMac : outer).defaultLayout}
        onLayoutChanged={(onMacTarget ? outerMac : outer).onLayoutChanged}
      >
        <Panel id="simulator" panelRef={simPanel} collapsible collapsedSize={0} minSize={240} defaultSize={onMacTarget ? '50%' : '31%'} className="ws-panel">
          <Pane
            title={onMacTarget ? t.workspace.macApp : pcDesktop ? t.workspace.windowsApp : pcMode ? t.pc.device : target?.kind === 'device' ? t.workspace.device : t.workspace.simulator}
            labelledBy="pane-sim"
            sub={target ? `${target.name} · ${target.os}` : undefined}
            className={onMacTarget ? 'pane--sim pane--mac' : 'pane--sim'}
            actions={
              onMacTarget ? (
                <IconButton icon="desktop" size="sm" label={deviceFrame ? t.workspace.hideWindowFrame : t.workspace.showWindowFrame} pressed={deviceFrame} onClick={() => void updateSettings({ deviceFrame: !deviceFrame })} />
              ) : pcMode || pcDesktop ? undefined : (
                <IconButton icon="phone" size="sm" label={deviceFrame ? t.workspace.hideFrame : t.workspace.showFrame} pressed={deviceFrame} onClick={() => void updateSettings({ deviceFrame: !deviceFrame })} />
              )
            }
          >
            <ErrorBoundary label={t.crash.parts.simulator} compact>
              {onMacTarget ? <AppWindowPane mac={mac} path={path} run={run} frame={deviceFrame} /> : pcDesktop ? <WindowsAppPane run={run} name={summary.appName} reactNative={reactNative} /> : pcMode ? <PcDevicePane target={target} run={run} entry={pcEntry} /> : <SimulatorPane mac={mac} target={target} />}
            </ErrorBoundary>
          </Pane>
        </Panel>
        <Separator className="ws-sep ws-sep--v" />
        <Panel id="main" minSize="35%" className="ws-panel">
          <Group orientation="vertical" id="capmac-ws-inner" defaultLayout={inner.defaultLayout} onLayoutChanged={inner.onLayoutChanged}>
            <Panel id="timeline" panelRef={timelinePanel} collapsible collapsedSize={0} minSize={124} defaultSize={168} className="ws-panel">
              <Pane title={t.workspace.timeline} labelledBy="pane-timeline">
                <ErrorBoundary label={t.crash.parts.timeline} compact>
                  <Timeline run={run} electron={electronKind} macSelected={onMacTarget} pcSelected={pcMode} flutter={flutter} reactNative={reactNative} pcDesktopSelected={pcDesktop} />
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
      <PcSetupDialog path={path} open={pcEntry.dialog} onClose={() => usePc.getState().showSetup(path, false)} />
      <BuildLogDialog path={path} logPath={run?.buildLogPath ?? null} open={logOpen} onClose={() => setLogOpen(false)} />
    </div>
  );
}
