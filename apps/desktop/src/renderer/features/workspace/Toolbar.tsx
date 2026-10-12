import type { MacSummary, ProjectSummary, Target, TargetsResult } from '../../../shared/contract';
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

const PHASE_VERBS = { web: 'Building web assets', sync: 'Syncing', deps: 'Installing dependencies', cap: 'Running cap sync', build: 'Building', boot: 'Booting', install: 'Installing', launch: 'Launching', archive: 'Archiving', export: 'Exporting', download: 'Downloading' } as const;

const MAC_TONE: Record<string, Tone> = { connected: 'ok', restored: 'ok', connecting: 'busy', reconnecting: 'warn', lost: 'warn', offline: 'error', idle: 'idle', closed: 'idle' };

function MacPicker({ macs, mac, path }: { macs: MacSummary[]; mac: MacSummary | null; path: string }) {
  const menu = usePopover();
  const navigate = useApp((s) => s.navigate);
  return (
    <>
      <button type="button" className="tb-picker tb-picker--mac" aria-haspopup="menu" aria-label={`Mac: ${mac ? `${mac.label}, ${macStatusText(mac)}` : 'none'}`} {...menu.triggerProps}>
        <span className="tb-picker__icon">
          <Icon name="mac" size={16} />
          <StatusDot tone={mac ? MAC_TONE[mac.state] ?? 'idle' : 'error'} pulse={mac?.state === 'connecting' || mac?.state === 'reconnecting'} />
        </span>
        <span className="tb-picker__text">
          <span className="tb-picker__title truncate">{mac?.label ?? 'No Mac'}</span>
          <span className="tb-picker__sub truncate">{mac ? macStatusText(mac) : 'Pair one to build'}</span>
        </span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Menu
        state={menu}
        label="Choose a Mac"
        placement="bottom-start"
        width={240}
        items={[
          ...macs.map((m) => ({ id: m.name, label: m.label, hint: m.isDefault ? 'default' : undefined, checked: m.name === mac?.name, onSelect: () => setProjectPrefs(path, { mac: m.name }) })),
          { id: 'pair', label: 'Pair a Mac…', icon: 'add' as const, separatorBefore: true, onSelect: () => navigate({ name: 'onboarding' }) },
          { id: 'manage', label: 'Manage Macs', icon: 'mac' as const, onSelect: () => navigate({ name: 'macs' }) },
        ]}
      />
    </>
  );
}

/** What is happening right now, as a verb ("Building", …). */
function currentPhase(run: RunState | undefined): string | null {
  if (!run) return null;
  for (const [phase, state] of Object.entries(run.phases)) {
    if (state?.status === 'running') return PHASE_VERBS[phase as keyof typeof PHASE_VERBS] ?? PHASE_LABELS[phase as keyof typeof PHASE_LABELS];
  }
  return run.status === 'starting' ? 'Starting' : null;
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
  const runHint = !mac ? 'Pair a Mac first' : summary && !summary.hasIos ? 'This app has no iOS platform yet' : undefined;

  return (
    <div className="ws-toolbar" role="toolbar" aria-label="Project toolbar">
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
        <TargetPicker targets={targets} selected={target} auto={autoTarget} loading={targetsLoading} onSelect={(t) => setProjectPrefs(path, { target: t?.udid ?? undefined })} />
      </div>
      <div className="ws-toolbar__spacer" />
      <div className="ws-toolbar__session" aria-live="polite">
        {phase && (
          <span className="ws-toolbar__phase">
            {phase}…
          </span>
        )}
        <Tooltip content={runHint ?? (live ? 'Restart live reload' : 'Live reload: edit and see changes instantly')} shortcut="F5">
          <Button variant={live ? 'standard' : 'accent'} icon="flash" iconFilled busy={busy && run?.mode === 'live'} disabled={!canRun} onClick={() => void startSession(path, 'live')} aria-keyshortcuts="F5">
            {live ? 'Live' : 'Live'}
            {live && !busy && <StatusDot tone="live" pulse />}
          </Button>
        </Tooltip>
        <Tooltip content={runHint ?? 'Build and run with logs'} shortcut="Ctrl+F5">
          <Button icon="play" iconFilled busy={busy && run?.mode === 'run'} disabled={!canRun} onClick={() => void startSession(path, 'run')} aria-keyshortcuts="Control+F5">
            Run
            {running && !busy && <StatusDot tone="ok" />}
          </Button>
        </Tooltip>
        <IconButton icon="stop" filled label="Stop" shortcut="Shift+F5" variant="standard" disabled={!active || run?.status === 'stopping'} onClick={() => void stopSession(path)} />
      </div>
      <div className="ws-toolbar__divider" role="separator" />
      <div className="ws-toolbar__actions">
        <IconButton icon="box" label="Build IPA" disabled={!canRun} onClick={() => emitWorkspace('build-ipa')} />
        <IconButton icon="code" label="Open in Xcode on the Mac" disabled={!canRun} onClick={() => void openInXcode(path)} />
        <button type="button" className="icon-btn" aria-label="More actions" aria-haspopup="menu" {...more.triggerProps}>
          <Icon name="more" size={16} />
        </button>
        <Menu
          state={more}
          label="More project actions"
          width={240}
          items={[
            { id: 'rebuild', label: 'Rebuild and relaunch', icon: 'sync', shortcut: 'Ctrl+Shift+F5', disabled: !canRun, onSelect: () => void rebuild(path) },
            { id: 'clean', label: 'Clean rebuild', icon: 'eraser', disabled: !canRun, onSelect: () => void rebuild(path, true) },
            { id: 'log', label: 'Show full build log', icon: 'document', disabled: !run?.buildLogPath, onSelect: () => emitWorkspace('show-build-log') },
            { id: 'folder', label: 'Open project folder', icon: 'folderOpen', separatorBefore: true, onSelect: () => void window.capmac.invoke('app:open-path', { path }) },
            { id: 'editor', label: 'Open in your editor', icon: 'open', onSelect: () => void window.capmac.invoke('app:open-in-editor', { file: path }) },
            { id: 'forget', label: 'Remove from recent projects', icon: 'delete', separatorBefore: true, onSelect: () => void forgetProject(path) },
          ]}
        />
      </div>
    </div>
  );
}
