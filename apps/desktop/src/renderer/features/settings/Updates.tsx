import { useState } from 'react';
import type { UpdateInfo } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { toast } from '../../state/app';
import { useUpdates } from '../../state/updates';
import { Button } from '../../ui/Button';
import { ProgressBar, Spinner } from '../../ui/Feedback';
import { Icon, type IconName } from '../../ui/Icon';
import './updates.css';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function describe(info: UpdateInfo): { icon: IconName | 'spinner'; title: string; detail?: string; tone?: 'caution' } {
  const s = info.state;
  switch (s.state) {
    case 'unavailable':
      return { icon: 'info', title: t.updates.off, detail: tidy(s.reason) };
    case 'idle':
      return { icon: 'checkCircle', title: t.updates.current(info.current), detail: t.updates.autoCheck };
    case 'checking':
      return { icon: 'spinner', title: t.updates.checking };
    case 'up-to-date':
      return { icon: 'checkCircle', title: t.updates.upToDate, detail: t.updates.checkedAt(time(s.checkedAt)) };
    case 'available':
      return { icon: 'download', title: t.updates.available(s.version), detail: t.updates.portable };
    case 'downloading':
      return { icon: 'download', title: t.updates.downloading(s.version), detail: `${s.percent}%` };
    case 'ready':
      return { icon: 'checkCircle', title: t.updates.ready(s.version), detail: t.updates.readyDetail };
    case 'error':
      return { icon: 'warning', title: t.updates.failed, detail: t.updates.failedAt(tidy(s.message), time(s.checkedAt)), tone: 'caution' };
  }
}

/** Settings › About: the version, the update status, Check for updates and the release notes. */
export function UpdatesPanel() {
  const info = useUpdates((s) => s.info);
  const check = useUpdates((s) => s.check);
  const install = useUpdates((s) => s.install);
  const [busy, setBusy] = useState(false);
  if (!info) return null;
  const d = describe(info);
  const s = info.state;
  const canCheck = s.state === 'idle' || s.state === 'up-to-date' || s.state === 'error' || s.state === 'available';
  const onCheck = async () => {
    setBusy(true);
    try {
      await check();
    } catch (err) {
      toast({ tone: 'critical', title: t.updates.failed, body: tidy(String((err as Error)?.message ?? err)) });
    } finally {
      setBusy(false);
    }
  };
  const open = (url: string) => void window.capmac.invoke('app:open-external', { url }).catch(() => toast({ tone: 'critical', title: t.updates.linkFailed, body: url }));
  return (
    <div className="settings-updates" role="group" aria-label={t.updates.label}>
      <div className="settings-updates__status">
        <span className={`settings-updates__icon${d.tone ? ` is-${d.tone}` : ''}`}>{d.icon === 'spinner' ? <Spinner size={16} /> : <Icon name={d.icon} size={16} filled={d.icon === 'checkCircle'} />}</span>
        <div className="settings-updates__text" aria-live="polite">
          <strong>{d.title}</strong>
          {d.detail && <span>{d.detail}</span>}
          {s.state === 'downloading' && <ProgressBar value={s.percent / 100} label={t.updates.downloadingLabel(s.version)} className="settings-updates__progress" />}
          {info.feed && <span className="settings-updates__feed">{t.updates.feed(new URL(info.feed).host)}</span>}
        </div>
      </div>
      <div className="settings-updates__actions">
        {s.state === 'ready' ? (
          <Button variant="accent" icon="refresh" onClick={() => void install()}>
            {t.updates.restart}
          </Button>
        ) : s.state === 'available' && s.download ? (
          <Button variant="accent" icon="download" onClick={() => open(s.download!)}>
            {t.updates.download(s.version)}
          </Button>
        ) : (
          <Button icon="refresh" busy={busy || s.state === 'checking'} disabled={!canCheck} onClick={() => void onCheck()}>
            {t.updates.check}
          </Button>
        )}
        {info.notesUrl && (
          <Button variant="ghost" iconRight="open" onClick={() => open(info.notesUrl!)}>
            {t.updates.notes}
          </Button>
        )}
      </div>
    </div>
  );
}
