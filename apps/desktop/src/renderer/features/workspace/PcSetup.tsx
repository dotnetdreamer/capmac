/**
 * Building on this PC, with no Mac: the setup screen (the same steps as
 * `capmac wsl setup`), the workspace banner that leads to it, and the pane
 * that stands for the iPhone plugged into this PC.
 */
import { useEffect } from 'react';
import type { Target } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { pcReady, SETUP_STEPS, stepStates, usePc, usePcEntry, type PcEntry, type SetupStepId, type StepNow, type StepState } from '../../state/pc';
import type { RunState } from '../../state/runs';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { EmptyState, InfoBar, ProgressBar, Spinner } from '../../ui/Feedback';
import { Icon, type IconName } from '../../ui/Icon';
import { CheckList } from '../macs/CheckList';

const gigabytes = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;
const DEVELOPER_PROGRAM_URL = 'https://developer.apple.com/programs/enroll/';
const STATE_ICON: Record<StepState, IconName> = { waiting: 'circle', running: 'hourglass', done: 'checkCircle', failed: 'errorCircle', skipped: 'subtractCircle' };

/** "1.2 GB of 3.0 GB · Continued from 0.8 GB". */
function downloadText(bytes: NonNullable<PcEntry['bytes']>): string {
  const got = bytes.total ? t.pc.progress(gigabytes(bytes.received), gigabytes(bytes.total)) : gigabytes(bytes.received);
  return bytes.resumedFrom ? `${got} · ${t.pc.continuedFrom(gigabytes(bytes.resumedFrom))}` : got;
}

/** How far a step is, as the setup screen shows it: the download's gigabytes, else a percent. */
function progressText(id: SetupStepId, fraction: number | undefined, entry: PcEntry): string | null {
  if (id === 'download') return entry.bytes ? downloadText(entry.bytes) : null;
  return fraction === undefined ? null : t.pc.percent(Math.round(fraction * 100));
}

/** The step setup is on now, else the one it stopped at. */
function stepNow(entry: PcEntry): ({ id: SetupStepId } & StepNow) | null {
  const steps = stepStates(entry);
  const running = SETUP_STEPS.find((step) => steps[step.id].state === 'running');
  const failed = SETUP_STEPS.find((step) => steps[step.id].state === 'failed');
  const step = running ?? failed;
  return step ? { id: step.id, ...steps[step.id] } : null;
}

function StepRow({ id, state, detail, fraction, entry }: { id: SetupStepId; entry: PcEntry } & StepNow) {
  const words = t.pc.steps[id];
  const progress = state === 'running' ? progressText(id, fraction, entry) : null;
  // Without a bar, what the tools print last, so a long step shows it is moving.
  const lastLine = state === 'running' && id !== 'download' && !progress ? entry.lines.at(-1) : undefined;
  const partial = id === 'download' && (state === 'waiting' || state === 'failed') ? entry.status?.partialDownload : null;
  return (
    <li className={`pc-step pc-step--${state}`}>
      <span className="pc-step__icon">{state === 'running' ? <Spinner size={16} /> : <Icon name={STATE_ICON[state]} size={16} filled={state === 'done' || state === 'failed'} />}</span>
      <div className="pc-step__body">
        <div className="pc-step__head">
          <span className="pc-step__title">{words.title}</span>
          <span className="pc-step__state">{t.pc.state[state]}</span>
        </div>
        <div className="pc-step__desc">{words.desc}</div>
        {progress && (
          <div className="pc-step__progress">
            <ProgressBar value={id === 'download' ? (entry.bytes?.total ? entry.bytes.received / entry.bytes.total : null) : fraction} label={words.title} />
            <span className="pc-step__note">{progress}</span>
          </div>
        )}
        {partial && <div className="pc-step__note">{t.pc.partial(gigabytes(partial.bytes))}</div>}
        {detail && state === 'failed' && <div className="pc-step__error selectable">{tidy(detail)}</div>}
        {detail && state === 'done' && <div className="pc-step__note">{tidy(detail)}</div>}
        {lastLine && <div className="pc-step__line mono truncate">{tidy(lastLine)}</div>}
      </div>
    </li>
  );
}

/** Setting up this PC, step by step: start or continue it, follow it, and check this PC. */
export function PcSetupDialog({ path, open, onClose }: { path: string; open: boolean; onClose: () => void }) {
  const entry = usePcEntry(path);
  useEffect(() => {
    if (open) void usePc.getState().refresh(path);
  }, [open, path]);
  if (!open) return null;
  const pc = usePc.getState();
  const steps = stepStates(entry);
  const ready = pcReady(entry.status);
  const now = stepNow(entry);
  const begun = Boolean(entry.status?.status) || SETUP_STEPS.some((step) => steps[step.id].state === 'done');
  return (
    <Dialog
      open
      size="lg"
      icon="desktop"
      title={t.pc.title}
      onClose={onClose}
      footer={
        <>
          {entry.running ? (
            <Button variant="danger" icon="stop" onClick={() => void pc.stopSetup(path)}>
              {t.pc.stop}
            </Button>
          ) : (
            !ready && (
              <Button variant="accent" icon="play" onClick={() => void pc.startSetup(path)} data-autofocus>
                {begun ? t.pc.continue : t.pc.start}
              </Button>
            )
          )}
          {!entry.running && ready && entry.status?.inApp && (
            <Button icon="key" title={t.pc.signInAgainHint} onClick={() => void pc.startSetup(path, true)}>
              {t.pc.signInAgain}
            </Button>
          )}
          <Button icon="health" busy={entry.checking} onClick={() => void pc.check(path)}>
            {t.pc.check}
          </Button>
          {/* Everything is in place: nothing left to do here. */}
          {ready && !entry.running ? (
            <Button variant="accent" onClick={onClose} data-autofocus>
              {t.common.done}
            </Button>
          ) : (
            <Button onClick={onClose}>{t.common.close}</Button>
          )}
        </>
      }
    >
      <p className="muted">{t.pc.intro}</p>
      {/* Before the sign-in has worked: a free Apple Account stops there, after the long tools step. */}
      {!ready && steps.signIn.state !== 'done' && (
        <InfoBar
          title={t.pc.paid.title}
          actions={
            <Button size="sm" icon="open" onClick={() => void window.capmac.invoke('app:open-external', { url: DEVELOPER_PROGRAM_URL })}>
              {t.pc.paid.join}
            </Button>
          }
        >
          {t.pc.paid.body}
        </InfoBar>
      )}
      {ready && !entry.running && <InfoBar tone="success" title={t.pc.isReady} />}
      {!entry.running && (now?.state === 'failed' || entry.error) && (
        <InfoBar tone="caution" title={now?.state === 'failed' ? t.pc.stoppedAt(t.pc.steps[now.id].title) : t.pc.setupFailed}>
          <p>{tidy(entry.error?.message ?? now?.detail)}</p>
          {entry.error?.hint && <p>{tidy(entry.error.hint)}</p>}
          {/* What Apple or the tools said, word for word. */}
          {entry.error?.details?.length ? <pre className="pc-details__log mono selectable">{entry.error.details.join('\n')}</pre> : null}
        </InfoBar>
      )}
      <ol className="pc-steps" aria-label={t.pc.title} aria-live="polite">
        {SETUP_STEPS.map((step) => (
          <StepRow key={step.id} id={step.id} {...steps[step.id]} entry={entry} />
        ))}
      </ol>
      {entry.lines.length > 0 && (
        <details className="pc-details">
          <summary>{t.pc.details}</summary>
          <pre className="pc-details__log mono selectable">{entry.lines.slice(-80).join('\n')}</pre>
        </details>
      )}
      {(entry.checks || entry.checking) && (
        <section className="pc-checks" aria-label={t.pc.checksTitle}>
          <h3 className="pc-checks__title">{t.pc.checksTitle}</h3>
          <CheckList checks={entry.checks ?? []} checking={entry.checking} />
        </section>
      )}
    </Dialog>
  );
}

/** Above the workspace while this PC isn't ready: what setup does, where it is, or where it stopped. */
export function PcBanner({ path, entry }: { path: string; entry: PcEntry }) {
  if (!entry.status && !entry.running) return null;
  if (pcReady(entry.status) && !entry.running) return null;
  const show = () => usePc.getState().showSetup(path, true);
  const now = stepNow(entry);
  if (entry.running) {
    const step = now ? t.pc.steps[now.id].title : t.pc.settingUp;
    const shown = now ? progressText(now.id, now.fraction, entry) : null;
    const progress = shown ? ` · ${shown}` : '';
    return (
      <div className="session-banner">
        <InfoBar tone="info" title={t.pc.bannerRunning(`${step}${progress}`)} actions={<Button size="sm" onClick={show}>{t.pc.show}</Button>} />
      </div>
    );
  }
  if (now?.state === 'failed') {
    return (
      <div className="session-banner">
        <InfoBar tone="caution" title={t.pc.bannerFailed(t.pc.steps[now.id].title)} actions={<Button size="sm" variant="accent" onClick={show}>{t.pc.continue}</Button>}>
          {now.detail ? tidy(now.detail) : null}
        </InfoBar>
      </div>
    );
  }
  return (
    <div className="session-banner">
      <InfoBar tone="info" title={t.pc.bannerTitle} actions={<Button size="sm" variant="accent" onClick={show}>{t.pc.setUp}</Button>}>
        {t.pc.bannerBody}
      </InfoBar>
    </div>
  );
}

/** Where the simulator shows on a Mac: the iPhone plugged into this PC, which shows the app itself. */
/** A Flutter or React Native app's Windows app: it runs on this PC in its own window, so the pane says where it is. */
export function WindowsAppPane({ run, name, reactNative = false }: { run: RunState | undefined; name: string; reactNative?: boolean }) {
  const running = Boolean(run?.onPc && run.app?.state === 'running');
  return (
    <div className="pc-pane">
      <EmptyState icon="desktop" title={running ? t.workspace.windowsAppRunning(run?.app?.name ?? name) : t.workspace.windowsAppTitle} compact>
        <p>{reactNative ? t.workspace.windowsAppBodyReactNative : t.workspace.windowsAppBody}</p>
        {!running && <p className="faint">{reactNative ? t.workspace.windowsAppIdleReactNative : t.workspace.windowsAppIdle}</p>}
      </EmptyState>
    </div>
  );
}

export function PcDevicePane({ target, run, entry }: { target: Target | null; run: RunState | undefined; entry: PcEntry }) {
  const devices = entry.devices;
  if (!target) {
    const missing = devices?.server === 'missing';
    return (
      <div className="pc-pane">
        <EmptyState icon="phone" title={missing ? t.pc.noAppleDevices : devices ? t.pc.none : t.pc.looking} compact>
          {missing ? null : t.pc.noPhone}
        </EmptyState>
      </div>
    );
  }
  const running = run?.backend === 'wsl' && run.app?.state === 'running';
  return (
    <div className="pc-pane">
      <EmptyState icon="phone" title={target.name} compact>
        <p className="pc-pane__os">{target.os}</p>
        {target.paired === false ? (
          <div className="pc-pane__todo" role="note">
            <div className="pc-pane__todo-title">
              <Icon name="warning" size={16} filled />
              {t.pc.trust.title}
            </div>
            <p>{t.pc.trust.body}</p>
          </div>
        ) : target.developerMode === 'disabled' ? (
          <div className="pc-pane__todo" role="note">
            <div className="pc-pane__todo-title">
              <Icon name="warning" size={16} filled />
              {t.pc.devMode.title}
            </div>
            <ol>
              {t.pc.devMode.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ) : (
          <>
            <p>{t.pc.devicePane}</p>
            {running && <p className="faint">{t.pc.devicePaneHint}</p>}
          </>
        )}
      </EmptyState>
    </div>
  );
}
