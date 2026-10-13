import type { MacSummary, ProjectSummary, Target, TargetsResult } from '../../../shared/contract';
import { t } from '../../../shared/i18n';
import { emitWorkspace } from '../../app/commands';
import { macStatusText } from '../../app/Sidebar';
import { forgetProject, openInXcode, rebuild, setProjectPrefs, startSession, stopSession } from '../../state/actions';
import { useApp } from '../../state/app';
import { isActive, isBusy, PHASE_LABELS, type RunState } from '../../state/runs';
import { AppIcon } from '../../ui/AppIcon';
import { Button, IconButton } from '../../ui/Button';
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

/** What is happening right now, as a verb ("Building", …). */
function currentPhase(run: RunState | undefined): string | null {
  if (!run) return null;
  for (const [phase, state] of Object.entries(run.phases)) {
    if (state?.status === 'running') return t.phaseNow[phase as keyof typeof t.phases] ?? PHASE_LABELS[phase as keyof typeof PHASE_LABELS];
  }
  return run.status === 'starting' ? t.phaseNow.starting : null;
}

export function Toolbar({ path, summary, icon, run, macs, mac, targets, target, autoTarget, targetsLoading }: {
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
}) {
  const more = usePopover();
  const active = isActive(run);
  const busy = isBusy(run);
  const live = active && run?.mode === 'live';
  const running = active && run?.mode === 'run';
  const phase = busy ? currentPhase(run) : null;
  const name = summary?.appName ?? path.split(/[\\/]/).pop() ?? path;
  const canRun = Boolean(summary?.hasIos && mac);
  const runHint = !mac ? t.toolbar.pairFirst : summary && !summary.hasIos ? t.toolbar.addIosFirst : undefined;

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
        <MacPicker macs={macs} mac={mac} path={path} />
        <Icon name="chevronRight" size={12} className="ws-toolbar__arrow" />
        <TargetPicker targets={targets} selected={target} auto={autoTarget} loading={targetsLoading} onSelect={(picked) => setProjectPrefs(path, { target: picked?.udid ?? undefined })} />
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
        <Tooltip content={runHint ?? t.toolbar.runTip} shortcut="Ctrl+F5">
          <Button icon="play" iconFilled busy={busy && run?.mode === 'run'} disabled={!canRun} onClick={() => void startSession(path, 'run')} aria-keyshortcuts="Control+F5">
            {t.common.run}
            {running && !busy && <StatusDot tone="ok" />}
          </Button>
        </Tooltip>
        <IconButton icon="stop" filled label={t.common.stop} shortcut="Shift+F5" variant="standard" disabled={!active || run?.status === 'stopping'} onClick={() => void stopSession(path)} />
      </div>
      <div className="ws-toolbar__divider" role="separator" />
      <div className="ws-toolbar__actions">
        <IconButton icon="box" label={t.toolbar.buildIpa} disabled={!canRun} onClick={() => emitWorkspace('build-ipa')} />
        <IconButton icon="code" label={t.toolbar.openXcode} disabled={!canRun} onClick={() => void openInXcode(path)} />
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
