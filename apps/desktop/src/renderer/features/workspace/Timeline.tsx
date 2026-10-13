import { useEffect, useState } from 'react';
import { t, tidy } from '../../../shared/i18n';
import { formatDuration } from '../../lib/format';
import { Rich } from '../../ui/Rich';
import { IPA_PHASES, isBusy, PHASE_LABELS, RUN_PHASES, type PhaseState, type RunState, type TimelinePhase } from '../../state/runs';
import { ProgressBar, Spinner } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';

const SHORT_DETAIL: Array<[RegExp, string]> = [
  [/native code unchanged/i, t.timeline.short.unchanged],
  [/dependencies unchanged/i, t.timeline.short.unchanged],
  [/web assets unchanged/i, t.timeline.short.unchanged],
  [/nothing to copy/i, t.timeline.short.upToDate],
  [/already booted/i, t.timeline.short.alreadyOn],
  [/served by your dev server/i, t.timeline.short.devServer],
  [/not needed on a device/i, t.timeline.short.device],
  [/turned off/i, t.timeline.short.off],
  [/not installed on this PC/i, t.timeline.short.prebuilt],
  [/no build script/i, t.timeline.short.noScript],
];

function shortDetail(state: PhaseState): string | null {
  if (state.status === 'done') return state.ms !== undefined ? formatDuration(state.ms) : null;
  if (state.status === 'skipped') return (state.detail && SHORT_DETAIL.find(([re]) => re.test(state.detail!))?.[1]) || t.timeline.short.skipped;
  if (state.status === 'failed') return t.timeline.short.failed;
  if (state.status === 'cancelled') return t.timeline.short.stopped;
  return null;
}

function Node({ status }: { status: PhaseState['status'] }) {
  switch (status) {
    case 'running':
      return <Spinner size={18} />;
    case 'done':
      return <Icon name="checkCircle" size={20} filled className="tl-icon tl-icon--done" />;
    case 'failed':
      return <Icon name="errorCircle" size={20} filled className="tl-icon tl-icon--failed" />;
    case 'skipped':
      return <Icon name="subtractCircle" size={20} className="tl-icon tl-icon--skipped" />;
    case 'cancelled':
      return <Icon name="dismissCircle" size={20} className="tl-icon tl-icon--skipped" />;
    default:
      return <Icon name="circle" size={20} className="tl-icon tl-icon--pending" />;
  }
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

export function Timeline({ run }: { run: RunState | undefined }) {
  const busy = isBusy(run);
  const now = useNow(busy);
  const hasCurrent = Boolean(run && Object.keys(run.phases).length > 1);
  const showingPrevious = !hasCurrent && Boolean(run?.previous);
  const phases: Partial<Record<TimelinePhase, PhaseState>> = hasCurrent ? run!.phases : run?.previous?.phases ?? {};
  const order = run?.mode === 'ipa' ? IPA_PHASES : RUN_PHASES;
  const runningPhase = order.find((p) => phases[p]?.status === 'running');
  const running = runningPhase ? phases[runningPhase] : undefined;
  const failed = order.find((p) => phases[p]?.status === 'failed');

  let elapsed: number | null = null;
  if (run?.startedAt && hasCurrent) elapsed = (busy ? now : run.endedAt ?? now) - run.startedAt;
  else if (showingPrevious) elapsed = run?.previous?.ms ?? null;

  if (!run || (!hasCurrent && !showingPrevious)) {
    return (
      <div className="timeline timeline--empty">
        <ol className="tl-steps" aria-label={t.timeline.steps}>
          {order.map((p) => (
            <li key={p} className="tl-step tl-step--idle">
              <span className="tl-step__node">
                <Icon name="circle" size={20} className="tl-icon tl-icon--pending" />
              </span>
              <span className="tl-step__label">{PHASE_LABELS[p]}</span>
            </li>
          ))}
        </ol>
        <p className="timeline__hint">
          <Rich text={t.timeline.hint} />
        </p>
      </div>
    );
  }

  return (
    <div className={`timeline${showingPrevious ? ' is-previous' : ''}`}>
      <div className="timeline__summary" aria-live="polite">
        <span className="timeline__run">
          {showingPrevious ? t.timeline.lastRun(run.previous!.runNumber) : t.timeline.run(run.runNumber)}
          {run.mode === 'live' && !showingPrevious && <span className="badge badge--success">{t.common.live}</span>}
        </span>
        {elapsed !== null && <span className="timeline__time tabular">{formatDuration(elapsed)}</span>}
        <span className="timeline__state">
          {busy ? t.timeline.inProgress : failed ? t.timeline.failedAt(PHASE_LABELS[failed]) : run.status === 'stopped' ? t.timeline.stopped : showingPrevious ? (run.previous!.ok ? t.timeline.succeeded : t.timeline.failed) : run.app?.state === 'running' ? t.timeline.appRunning : t.timeline.done}
        </span>
      </div>
      <ol className="tl-steps" aria-label={t.timeline.steps}>
        {order.map((p, i) => {
          const state = phases[p] ?? { status: 'pending' as const };
          const detail = shortDetail(state);
          const prev = phases[order[i - 1]!];
          const connected = i > 0 && prev && (prev.status === 'done' || prev.status === 'skipped');
          return (
            <li key={p} className={`tl-step tl-step--${state.status}${connected ? ' is-connected' : ''}`} title={tidy(state.detail ?? state.title)} aria-label={`${PHASE_LABELS[p]}: ${t.timeline.status[state.status]}${state.detail ? `, ${tidy(state.detail)}` : ''}${state.ms ? `, ${formatDuration(state.ms)}` : ''}`}>
              <span className="tl-step__node">
                <Node status={state.status} />
              </span>
              <span className="tl-step__label">{PHASE_LABELS[p]}</span>
              <span className="tl-step__meta tabular">{state.status === 'running' && state.startedAt ? formatDuration(now - state.startedAt) : detail ?? ' '}</span>
            </li>
          );
        })}
      </ol>
      {running && (
        <div className="tl-progress">
          <ProgressBar value={running.fraction ?? null} label={t.timeline.progress(PHASE_LABELS[runningPhase!])} />
          <span className="tl-progress__text mono truncate">{running.progress ?? running.title ?? ''}</span>
        </div>
      )}
      {!running && run.notes.some((n) => n.level === 'warn') && !showingPrevious && (
        <ul className="tl-notes">
          {run.notes
            .filter((n) => n.level === 'warn')
            .slice(-2)
            .map((n) => (
              <li key={n.id}>
                <Icon name="warning" size={14} filled />
                <span className="truncate">{tidy(n.message)}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
