import { useState } from 'react';
import type { MacSummary, ProjectSummary, RunnableApp, Target, TargetsResult } from '../../../shared/contract';
import { t } from '../../../shared/i18n';
import { emitWorkspace } from '../../app/commands';
import { macStatusText } from '../../app/Sidebar';
import { appGlyph, appKind, appTech, appTechShort, canRun as runnable } from '../../lib/apps';
import { forgetProject, openInXcode, rebuild, setApp, setProjectPrefs, startSession, stopSession } from '../../state/actions';
import { useApp } from '../../state/app';
import { useProjects } from '../../state/projects';
import { isActive, isBusy, phaseLabel, type RunState, type TimelinePhase } from '../../state/runs';
import { AppIcon } from '../../ui/AppIcon';
import { Button, IconButton } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { StatusDot, type Tone } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Menu, usePopover } from '../../ui/Popover';
import { Tooltip } from '../../ui/Tooltip';
import { TargetPicker } from './TargetPicker';

const MAC_TONE: Record<string, Tone> = { connected: 'ok', restored: 'ok', connecting: 'busy', reconnecting: 'warn', lost: 'warn', offline: 'error', idle: 'idle', closed: 'idle' };

function MacPicker({ macs, mac, path }: { macs: MacSummary[]; mac: MacSummary | null; path: string }) {
  const menu = usePopover();
  const navigate = useApp((s) => s.navigate);
  return (
    <>
      <button type="button" className="tb-picker tb-picker--mac" aria-haspopup="menu" aria-label={t.toolbar.mac(mac ? `${mac.label}, ${macStatusText(mac)}` : t.common.none)} {...menu.triggerProps}>
        <span className="tb-picker__icon">
          <Icon name="mac" size={16} />
          <StatusDot tone={mac ? MAC_TONE[mac.state] ?? 'idle' : 'error'} pulse={mac?.state === 'connecting' || mac?.state === 'reconnecting'} />
        </span>
        <span className="tb-picker__text">
          <span className="tb-picker__title truncate">{mac?.label ?? t.toolbar.noMac}</span>
          <span className="tb-picker__sub truncate">{mac ? macStatusText(mac) : t.toolbar.pairOne}</span>
        </span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Menu
        state={menu}
        label={t.toolbar.chooseMac}
        placement="bottom-start"
        width={240}
        items={[
          ...macs.map((m) => ({ id: m.name, label: m.label, hint: m.isDefault ? t.common.default.toLowerCase() : undefined, checked: m.name === mac?.name, onSelect: () => setProjectPrefs(path, { mac: m.name }) })),
          { id: 'pair', label: t.common.pairMacMenu, icon: 'add' as const, separatorBefore: true, onSelect: () => navigate({ name: 'onboarding' }) },
          { id: 'manage', label: t.toolbar.manageMacs, icon: 'mac' as const, onSelect: () => navigate({ name: 'macs' }) },
        ]}
      />
    </>
  );
}

/** Which of the project's apps Run and Live use (like Xcode's scheme): shown when it has more than one. */
function AppPicker({ path, summary, app, run }: { path: string; summary: ProjectSummary; app: RunnableApp; run: RunState | undefined }) {
  const menu = usePopover();
  const [switchTo, setSwitchTo] = useState<RunnableApp | null>(null);
  const apps = summary.apps.filter(runnable);
  const current = apps.find((a) => a.id === app) ?? apps[0]!;
  const pick = (id: RunnableApp) => {
    if (id === app) return;
    // A running app is the one being switched away from: stop it first, after asking.
    if (isActive(run)) setSwitchTo(id);
    else void setApp(path, id);
  };
  const target = switchTo ? apps.find((a) => a.id === switchTo) : undefined;
  return (
    <>
      <button type="button" className="tb-picker tb-picker--app" aria-haspopup="menu" aria-label={t.apps.label(`${appKind(current)}, ${appTech(current)}`)} {...menu.triggerProps}>
        <span className="tb-picker__icon">
          <Icon name={appGlyph(current)} size={16} />
        </span>
        <span className="tb-picker__text">
          <span className="tb-picker__title truncate">{appKind(current)}</span>
          <span className="tb-picker__sub truncate">{appTechShort(current)}</span>
        </span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Menu
        state={menu}
        label={t.apps.choose}
        placement="bottom-start"
        width={300}
        items={[
          ...apps.map((a) => ({ id: a.id, label: appKind(a), icon: appGlyph(a), hint: a.status === 'setup' ? t.apps.setup : t.apps.whereShort[a.id], checked: a.id === app, onSelect: () => pick(a.id as RunnableApp) })),
          { id: 'look', label: t.apps.lookAgain, icon: 'refresh' as const, separatorBefore: true, onSelect: () => void useProjects.getState().inspect(path, true) },
        ]}
      />
      {target && (
        <Dialog
          open
          size="sm"
          title={t.apps.switchTitle(appKind(target))}
          onClose={() => setSwitchTo(null)}
          footer={
            <>
              <Button
                variant="accent"
                onClick={async () => {
                  setSwitchTo(null);
                  await stopSession(path);
                  await setApp(path, target.id as RunnableApp);
                }}
              >
                {t.apps.switch}
              </Button>
              <Button onClick={() => setSwitchTo(null)}>{t.common.cancel}</Button>
            </>
          }
        >
          <p className="muted">{t.apps.switchBody(appKind(current))}</p>
        </Dialog>
      )}
    </>
  );
}

/**
 * Run, with an arrow for the other ways to run a Capacitor app: without the
 * web build (like `npx cap run`), or Sync only (like `npx cap sync`, the iOS
 * app's). Run itself always builds the web app first.
 */
function RunButton({ path, run, enabled, hint, capacitor, ios }: { path: string; run: RunState | undefined; enabled: boolean; hint: string | undefined; capacitor: boolean; ios: boolean }) {
  const menu = usePopover();
  const busy = isBusy(run);
  const running = isActive(run) && run?.mode === 'run';
  const main = (
    <Tooltip content={hint ?? t.toolbar.runTip} shortcut="Ctrl+F5">
      <Button icon="play" iconFilled busy={busy && (run?.mode === 'run' || run?.mode === 'sync')} disabled={!enabled} onClick={() => void startSession(path, 'run')} aria-keyshortcuts="Control+F5">
        {t.common.run}
        {running && !busy && <StatusDot tone="ok" />}
      </Button>
    </Tooltip>
  );
  if (!capacitor) return main;
  return (
    <div className="split">
      {main}
      <Tooltip content={hint ?? t.toolbar.runOptions}>
        <button type="button" className="btn btn--standard btn--md split__more" aria-label={t.toolbar.runOptions} aria-haspopup="menu" disabled={!enabled} {...menu.triggerProps}>
          <Icon name="chevronDown" size={12} />
        </button>
      </Tooltip>
      <Menu
        state={menu}
        label={t.toolbar.runOptions}
        placement="bottom-end"
        width={300}
        items={[
          { id: 'run', label: t.toolbar.runFull, description: t.toolbar.runFullHint, icon: 'play', shortcut: 'Ctrl+F5', onSelect: () => void startSession(path, 'run') },
          { id: 'run-no-build', label: t.toolbar.runNoBuild, description: t.toolbar.runNoBuildHint, icon: 'history', onSelect: () => void startSession(path, 'run', { webBuild: false }) },
          ...(ios ? [{ id: 'sync', label: t.toolbar.sync, description: t.toolbar.syncHint, icon: 'sync' as const, separatorBefore: true, onSelect: () => void startSession(path, 'sync') }] : []),
        ]}
      />
    </div>
  );
}

/** What is happening right now, as a verb ("Building", …). */
function currentPhase(run: RunState | undefined): string | null {
  if (!run) return null;
  for (const [phase, state] of Object.entries(run.phases)) {
    if (state?.status === 'running') return t.phaseNow[phase as keyof typeof t.phaseNow] ?? phaseLabel(phase as TimelinePhase, run.onMac);
  }
  return run.status === 'starting' ? t.phaseNow.starting : null;
}

export function Toolbar({ path, summary, icon, run, macs, mac, targets, target, autoTarget, targetsLoading, macDesktop = null, onlyMac = false, app = 'ios' }: {
  path: string;
  summary: ProjectSummary | null;
  icon: string | null;
  run: RunState | undefined;
  macs: MacSummary[];
  mac: MacSummary | null;
  targets: TargetsResult | null;
  target: Target | null;
  autoTarget: boolean;
  targetsLoading: boolean;
  /** The Mac's desktop as a target (the project has an Electron app). */
  macDesktop?: Target | null;
  /** The project's only target is the Mac's desktop. */
  onlyMac?: boolean;
  /** The app Run and Live use. */
  app?: RunnableApp;
}) {
  const more = usePopover();
  const active = isActive(run);
  const busy = isBusy(run);
  const live = active && run?.mode === 'live';
  const phase = busy ? currentPhase(run) : null;
  const name = summary?.appName ?? path.split(/[\\/]/).pop() ?? path;
  // The app picked must be there to run: an iOS app once iOS is added.
  const appReady = app === 'electron' ? Boolean(summary?.electron) : Boolean(summary?.hasIos);
  const canRun = appReady && Boolean(mac);
  const runHint = !mac ? t.toolbar.pairFirst : summary && !appReady && app === 'ios' ? t.toolbar.addIosFirst : undefined;
  // IPA builds and Xcode are for the iOS app.
  const canIos = Boolean(summary?.hasIos && mac);
  // Capacitor apps (iOS, or Capacitor's Electron platform) can also run without the web build; the iOS app can sync.
  const iosApp = app === 'ios' && Boolean(summary?.hasIos);
  const capacitorApp = iosApp || (app === 'electron' && summary?.electron?.flavor === 'capacitor');

  return (
    <div className="ws-toolbar" role="toolbar" aria-label={t.toolbar.label}>
      <div className="ws-toolbar__ident">
        <AppIcon src={icon} name={name} seed={summary?.appId} size={28} />
        <div className="ws-toolbar__names">
          <h1 className="ws-toolbar__name truncate">{name}</h1>
          <span className="ws-toolbar__id mono truncate">{summary?.appId ?? ''}</span>
        </div>
      </div>
      <div className="ws-toolbar__pickers">
        {summary && summary.apps.filter(runnable).length > 1 && (
          <>
            <AppPicker path={path} summary={summary} app={app} run={run} />
            <span className="ws-toolbar__pickers-divider" role="separator" />
          </>
        )}
        <MacPicker macs={macs} mac={mac} path={path} />
        <Icon name="chevronRight" size={12} className="ws-toolbar__arrow" />
        <TargetPicker targets={targets} selected={target} auto={autoTarget} loading={targetsLoading} mac={macDesktop} onlyMac={onlyMac} onSelect={(picked) => setProjectPrefs(path, { target: picked?.udid ?? undefined })} />
      </div>
      <div className="ws-toolbar__spacer" />
      <div className="ws-toolbar__session" aria-live="polite">
        {phase && (
          <span className="ws-toolbar__phase">
            {phase}…
          </span>
        )}
        <Tooltip content={runHint ?? (live ? t.toolbar.restartLive : t.toolbar.liveTip)} shortcut="F5">
          <Button variant={live ? 'standard' : 'accent'} icon="flash" iconFilled busy={busy && run?.mode === 'live'} disabled={!canRun} onClick={() => void startSession(path, 'live')} aria-keyshortcuts="F5">
            {t.common.live}
            {live && !busy && <StatusDot tone="live" pulse />}
          </Button>
        </Tooltip>
        <RunButton path={path} run={run} enabled={canRun} hint={runHint} capacitor={capacitorApp} ios={iosApp} />
        <IconButton icon="stop" filled label={t.common.stop} shortcut="Shift+F5" variant="standard" disabled={!active || run?.status === 'stopping'} onClick={() => void stopSession(path)} />
      </div>
      <div className="ws-toolbar__divider" role="separator" />
      <div className="ws-toolbar__actions">
        {!onlyMac && (
          <>
            <IconButton icon="box" label={canIos || !mac ? t.toolbar.buildIpa : `${t.toolbar.buildIpa} (${t.toolbar.iosOnly.toLowerCase()})`} disabled={!canIos} onClick={() => emitWorkspace('build-ipa')} />
            <IconButton icon="code" label={canIos || !mac ? t.toolbar.openXcode : `${t.toolbar.openXcode} (${t.toolbar.iosOnly.toLowerCase()})`} disabled={!canIos} onClick={() => void openInXcode(path)} />
          </>
        )}
        <button type="button" className="icon-btn" aria-label={t.common.moreActions} aria-haspopup="menu" {...more.triggerProps}>
          <Icon name="more" size={16} />
        </button>
        <Menu
          state={more}
          label={t.toolbar.moreProject}
          width={240}
          items={[
            { id: 'rebuild', label: t.toolbar.rebuild, icon: 'sync', shortcut: 'Ctrl+Shift+F5', disabled: !canRun, onSelect: () => void rebuild(path) },
            { id: 'clean', label: t.toolbar.cleanRebuild, icon: 'eraser', disabled: !canRun, onSelect: () => void rebuild(path, true) },
            { id: 'log', label: t.toolbar.buildLog, icon: 'document', disabled: !run?.buildLogPath, onSelect: () => emitWorkspace('show-build-log') },
            { id: 'folder', label: t.toolbar.openFolder, icon: 'folderOpen', separatorBefore: true, onSelect: () => void window.capmac.invoke('app:open-path', { path }) },
            { id: 'editor', label: t.toolbar.openEditor, icon: 'open', onSelect: () => void window.capmac.invoke('app:open-in-editor', { file: path }) },
            { id: 'forget', label: t.toolbar.forget, icon: 'delete', separatorBefore: true, onSelect: () => void forgetProject(path) },
          ]}
        />
      </div>
    </div>
  );
}
