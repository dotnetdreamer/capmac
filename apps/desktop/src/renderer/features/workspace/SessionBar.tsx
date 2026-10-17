import { useEffect, useState } from 'react';
import type { ErrorInfo, MacSummary } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { emitWorkspace } from '../../app/commands';
import { rebuild, relaunch, reloadApp, startSession } from '../../state/actions';
import { isActive, isBusy, type RunState } from '../../state/runs';
import { clockTime, formatDuration, timeAgo } from '../../lib/format';
import { Button } from '../../ui/Button';
import { InfoBar, Spinner, StatusDot } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';

/** Re-renders every `ms` while mounted (for "updated 3 s ago" style text). */
function useTick(ms: number, enabled = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms, enabled]);
  return now;
}

function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function LiveCard({ path, run, mac }: { path: string; run: RunState; mac: MacSummary | null }) {
  const live = run.live!;
  const now = useTick(15_000, Boolean(live.hmrUpdatedAt));
  const busy = isBusy(run);
  // On this PC the iPhone loads the dev server through a relay on this PC's network: linked once it is up.
  const pc = run.backend === 'wsl';
  const linked = pc ? Boolean(live.devServerUrl) : live.tunnel === 'up';
  const hmrText = pc ? t.pc.liveHint : live.hmr === 'connected' ? (live.hmrUpdatedAt ? t.session.updatedAt(clockTime(live.hmrUpdatedAt)) : t.session.updatesReady) : live.hmr === 'disconnected' ? t.session.appNotConnected : t.session.waitingForApp;
  const hmrTone = pc ? (run.app?.state === 'running' ? 'live' : 'idle') : live.hmr === 'connected' ? 'live' : live.hmr === 'disconnected' ? 'warn' : 'idle';
  return (
    <div className="session-bar session-bar--live" role="status" aria-label={t.session.liveLabel}>
      <span className="session-bar__mode">
        <Icon name="flash" size={14} filled />
        {t.common.live}
      </span>
      <span className="session-bar__route">
        <Tooltip content={t.session.devServer(live.command)}>
          <span className="session-bar__chip mono" tabIndex={0}>
            {live.devServerUrl ? hostOf(live.devServerUrl) : <Spinner size={12} />}
          </span>
        </Tooltip>
        <span className={`session-bar__link${linked ? ' is-up' : ''}`} aria-label={pc ? (linked ? t.pc.linkUp : t.pc.linkDown) : linked ? t.session.linkUp : t.session.linkDown}>
          <span className="session-bar__line" />
          <span className="session-bar__tunnel">{t.session.link}</span>
          <span className="session-bar__line" />
        </span>
        <span className="session-bar__chip">
          <Icon name={pc ? 'phone' : 'mac'} size={14} />
          {pc ? run.target?.name ?? t.pc.device : mac?.label ?? t.session.mac}
        </span>
      </span>
      <span className="session-bar__sep" />
      <span className="session-bar__hmr" title={live.hmrUpdatedAt ? t.session.lastUpdate(timeAgo(live.hmrUpdatedAt, now)) : undefined}>
        <StatusDot tone={hmrTone} pulse={hmrTone === 'live'} />
        {hmrText}
      </span>
      {live.lastNativeChange && busy && (
        <span className="session-bar__native truncate">
          <Icon name="wrench" size={14} />
          {t.session.nativeChange(live.lastNativeChange.paths[0]?.split('/').pop() ?? '', live.lastNativeChange.paths.length - 1)}
        </span>
      )}
      <span className="session-bar__spacer" />
      <Button size="sm" variant="subtle" icon="refresh" onClick={() => void relaunch(path)} disabled={busy}>
        {t.session.restartApp}
      </Button>
      <Button size="sm" variant="subtle" icon="sync" onClick={() => void rebuild(path)} disabled={busy}>
        {t.session.rebuild}
      </Button>
    </div>
  );
}

/** Live reload of an Electron app on the Mac: edits sync as you save (no dev server or link on this PC). */
function MacLiveCard({ path, run, mac }: { path: string; run: RunState; mac: MacSummary | null }) {
  const live = run.live!;
  const busy = isBusy(run);
  const label = mac?.label ?? t.session.mac;
  return (
    <div className="session-bar session-bar--live" role="status" aria-label={t.session.liveLabel}>
      <span className="session-bar__mode">
        <Icon name="flash" size={14} filled />
        {t.common.live}
      </span>
      <span className="session-bar__chip">
        <Icon name="mac" size={14} />
        {label}
      </span>
      <span className="session-bar__sep" />
      <span className="session-bar__hmr">
        <StatusDot tone={run.app?.state === 'running' ? 'live' : 'idle'} pulse={run.app?.state === 'running'} />
        {live.hmrUpdatedAt ? t.session.macUpdated(clockTime(live.hmrUpdatedAt)) : t.session.macSync(label)}
      </span>
      <span className="session-bar__spacer" />
      <Tooltip content={t.session.reloadTip}>
        <Button size="sm" variant="subtle" icon="refresh" onClick={() => void reloadApp(path)} disabled={busy || run.app?.state !== 'running'}>
          {t.session.reload}
        </Button>
      </Tooltip>
      <Button size="sm" variant="subtle" icon="power" onClick={() => void relaunch(path)} disabled={busy}>
        {t.session.restartApp}
      </Button>
      <Button size="sm" variant="subtle" icon="sync" onClick={() => void rebuild(path)} disabled={busy}>
        {t.session.rebuild}
      </Button>
    </div>
  );
}

function RunCard({ run }: { run: RunState }) {
  const busy = isBusy(run);
  const now = useTick(1000, run.app?.state === 'running');
  const app = run.app;
  return (
    <div className="session-bar" role="status">
      <span className="session-bar__mode session-bar__mode--run">
        <Icon name="play" size={14} filled />
        {t.common.run}
      </span>
      {busy ? (
        <span className="session-bar__text">
          <Spinner size={14} /> {t.session.building(run.target?.name)}
        </span>
      ) : app?.state === 'running' ? (
        <span className="session-bar__text">
          <StatusDot tone="ok" />
          {t.session.running(app.name ?? t.common.theApp, app.target ?? t.common.theSimulator)} <span className="faint tabular">· {formatDuration(now - app.at)}</span>
        </span>
      ) : (
        <span className="session-bar__text muted">{t.session.starting}</span>
      )}
      <span className="session-bar__spacer" />
      <span className="faint">{t.session.logsBelow}</span>
    </div>
  );
}

/**
 * The engine's hint for a failed build is written for the terminal ("re-run with
 * --verbose"); here the problems, the output and the build log are one click away.
 */
function hintFor(error: ErrorInfo, run: RunState, errors: number): string | undefined {
  if (error.code !== 'BUILD_FAILED' && error.code !== 'ELECTRON_BUILD_FAILED') return tidy(error.hint);
  if (errors > 0) return run.mode === 'live' ? t.session.fixAndSave : t.session.fixAndRun;
  return run.buildLogPath ? t.session.seeLog : tidy(error.hint);
}

function FailureCard({ path, run }: { path: string; run: RunState }) {
  const [details, setDetails] = useState(false);
  const error = run.error!;
  const errors = run.diagnostics.filter((d) => d.severity === 'error').length;
  return (
    <div className="session-error">
      <InfoBar
        tone="critical"
        title={tidy(error.message)}
        live
        actions={
          <>
            {errors > 0 && (
              <Button size="sm" onClick={() => emitWorkspace('show-problems')}>
                {t.session.showProblems(errors)}
              </Button>
            )}
            {error.details?.length ? (
              <Button size="sm" variant="subtle" iconRight={details ? 'chevronUp' : 'chevronDown'} onClick={() => setDetails((d) => !d)} aria-expanded={details}>
                {t.session.output}
              </Button>
            ) : null}
            {run.buildLogPath && (
              <Button size="sm" variant="subtle" onClick={() => emitWorkspace('show-build-log')}>
                {t.session.buildLog}
              </Button>
            )}
            <Button size="sm" variant="subtle" icon="refresh" onClick={() => void startSession(path, run.mode === 'live' ? 'live' : run.mode === 'ipa' && run.backend === 'wsl' ? 'build' : 'run')}>
              {t.common.tryAgain}
            </Button>
          </>
        }
      >
        {hintFor(error, run, errors)}
      </InfoBar>
      {details && error.details && <pre className="session-error__details selectable">{error.details.join('\n')}</pre>}
    </div>
  );
}

/** `electron`: the project's Electron app is Capacitor's (live reload goes through a dev server on this PC) or its own. */
export function SessionBar({ path, run, mac, electron = null }: { path: string; run: RunState | undefined; mac: MacSummary | null; electron?: 'capacitor' | 'plain' | null }) {
  const active = isActive(run);
  if (mac && active && (mac.state === 'lost' || mac.state === 'reconnecting')) {
    return (
      <div className="session-banner">
        <InfoBar tone="caution" title={t.session.notResponding(mac.label)} live actions={<Spinner size={16} label={t.common.reconnecting} />}>
          {t.session.notRespondingBody}{mac.error ? ` (${tidy(mac.error)})` : ''}
        </InfoBar>
      </div>
    );
  }
  if (!run) return null;
  if (run.status === 'failed' && run.error && !run.error.cancelled) return <FailureCard path={path} run={run} />;
  if (active && run.mode === 'live' && run.live && run.onMac && electron !== 'capacitor') return <MacLiveCard path={path} run={run} mac={mac} />;
  if (active && run.mode === 'live' && run.live) return <LiveCard path={path} run={run} mac={mac} />;
  if (active && run.mode === 'run') return <RunCard run={run} />;
  if (mac && mac.state === 'restored' && active) {
    return (
      <div className="session-banner">
        <InfoBar tone="success" title={t.session.reconnected(mac.label)} live />
      </div>
    );
  }
  return null;
}
