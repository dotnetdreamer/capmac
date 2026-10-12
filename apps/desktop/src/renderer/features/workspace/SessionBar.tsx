import { useEffect, useState } from 'react';
import type { MacSummary } from '../../../shared/contract';
import { emitWorkspace } from '../../app/commands';
import { rebuild, relaunch, startSession } from '../../state/actions';
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
  const hmrText = live.hmr === 'connected' ? (live.hmrUpdatedAt ? `updated ${clockTime(live.hmrUpdatedAt)}` : 'connected') : live.hmr === 'disconnected' ? 'not connected' : 'waiting for the app';
  return (
    <div className="session-bar session-bar--live" role="status" aria-label="Live reload">
      <span className="session-bar__mode">
        <Icon name="flash" size={14} filled />
        Live
      </span>
      <span className="session-bar__route">
        <Tooltip content={live.command ? `Dev server (${live.command})` : 'Your dev server'}>
          <span className="session-bar__chip mono" tabIndex={0}>
            {live.devServerUrl ? hostOf(live.devServerUrl) : <Spinner size={12} />}
          </span>
        </Tooltip>
        <span className={`session-bar__link${live.tunnel === 'up' ? ' is-up' : ''}`} aria-label={live.tunnel === 'up' ? 'tunnel up' : 'tunnel down'}>
          <span className="session-bar__line" />
          <span className="session-bar__tunnel">tunnel</span>
          <span className="session-bar__line" />
        </span>
        <span className="session-bar__chip">
          <Icon name="mac" size={14} />
          {mac?.label ?? 'Mac'}
        </span>
      </span>
      <span className="session-bar__sep" />
      <span className="session-bar__hmr" title={live.hmrUpdatedAt ? `Last update ${timeAgo(live.hmrUpdatedAt, now)}` : undefined}>
        <StatusDot tone={live.hmr === 'connected' ? 'live' : live.hmr === 'disconnected' ? 'warn' : 'idle'} pulse={live.hmr === 'connected'} />
        HMR {hmrText}
      </span>
      {live.lastNativeChange && busy && (
        <span className="session-bar__native truncate">
          <Icon name="wrench" size={14} />
          Native change: {live.lastNativeChange.paths[0]?.split('/').pop()}
          {live.lastNativeChange.paths.length > 1 ? ` +${live.lastNativeChange.paths.length - 1}` : ''}
        </span>
      )}
      <span className="session-bar__spacer" />
      <Button size="sm" variant="subtle" icon="refresh" onClick={() => void relaunch(path)} disabled={busy}>
        Relaunch
      </Button>
      <Button size="sm" variant="subtle" icon="sync" onClick={() => void rebuild(path)} disabled={busy}>
        Rebuild
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
        Run
      </span>
      {busy ? (
        <span className="session-bar__text">
          <Spinner size={14} /> Building and launching{run.target ? ` on ${run.target.name}` : ''}…
        </span>
      ) : app?.state === 'running' ? (
        <span className="session-bar__text">
          <StatusDot tone="ok" />
          {app.name} is running on {app.target} <span className="faint tabular">· {formatDuration(now - app.at)}</span>
        </span>
      ) : (
        <span className="session-bar__text muted">Starting…</span>
      )}
      <span className="session-bar__spacer" />
      <span className="faint">Logs stream into the console below</span>
    </div>
  );
}

function FailureCard({ path, run }: { path: string; run: RunState }) {
  const [details, setDetails] = useState(false);
  const error = run.error!;
  const errors = run.diagnostics.filter((d) => d.severity === 'error').length;
  return (
    <div className="session-error">
      <InfoBar
        tone="critical"
        title={error.message}
        live
        actions={
          <>
            {errors > 0 && (
              <Button size="sm" onClick={() => emitWorkspace('show-problems')}>
                Show {errors === 1 ? 'problem' : `${errors} problems`}
              </Button>
            )}
            {error.details?.length ? (
              <Button size="sm" variant="subtle" iconRight={details ? 'chevronUp' : 'chevronDown'} onClick={() => setDetails((d) => !d)} aria-expanded={details}>
                Output
              </Button>
            ) : null}
            {run.buildLogPath && (
              <Button size="sm" variant="subtle" onClick={() => emitWorkspace('show-build-log')}>
                Build log
              </Button>
            )}
            <Button size="sm" variant="subtle" icon="refresh" onClick={() => void startSession(path, run.mode === 'live' ? 'live' : 'run')}>
              Try again
            </Button>
          </>
        }
      >
        {error.hint}
      </InfoBar>
      {details && error.details && <pre className="session-error__details selectable">{error.details.join('\n')}</pre>}
    </div>
  );
}

export function SessionBar({ path, run, mac }: { path: string; run: RunState | undefined; mac: MacSummary | null }) {
  const active = isActive(run);
  if (mac && active && (mac.state === 'lost' || mac.state === 'reconnecting')) {
    return (
      <div className="session-banner">
        <InfoBar tone="caution" title={`${mac.label} isn’t answering. It may be asleep.`} live actions={<Spinner size={16} label="Reconnecting" />}>
          Reconnecting… capmac restores the tunnel and relaunches the app when it’s back.{mac.error ? ` (${mac.error})` : ''}
        </InfoBar>
      </div>
    );
  }
  if (!run) return null;
  if (run.status === 'failed' && run.error && !run.error.cancelled) return <FailureCard path={path} run={run} />;
  if (active && run.mode === 'live' && run.live) return <LiveCard path={path} run={run} mac={mac} />;
  if (active && run.mode === 'run') return <RunCard run={run} />;
  if (mac && mac.state === 'restored' && active) {
    return (
      <div className="session-banner">
        <InfoBar tone="success" title={`Reconnected to ${mac.label}`} live />
      </div>
    );
  }
  return null;
}
