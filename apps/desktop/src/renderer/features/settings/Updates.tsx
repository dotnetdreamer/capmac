import { useState } from 'react';
import type { UpdateInfo } from '../../../shared/contract';
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
      return { icon: 'info', title: 'Updates are off', detail: s.reason };
    case 'idle':
      return { icon: 'checkCircle', title: `capmac Studio ${info.current}`, detail: 'capmac Studio checks for updates every few hours.' };
    case 'checking':
      return { icon: 'spinner', title: 'Checking for updates…' };
    case 'up-to-date':
      return { icon: 'checkCircle', title: 'capmac Studio is up to date', detail: `Checked at ${time(s.checkedAt)}.` };
    case 'available':
      return { icon: 'download', title: `capmac Studio ${s.version} is available`, detail: 'The portable app can’t update itself: download the new version and replace this one.' };
    case 'downloading':
      return { icon: 'download', title: `Downloading capmac Studio ${s.version}…`, detail: `${s.percent}%` };
    case 'ready':
      return { icon: 'checkCircle', title: `capmac Studio ${s.version} is ready`, detail: 'It installs when you restart or quit capmac Studio.' };
    case 'error':
      return { icon: 'warning', title: 'Couldn’t check for updates', detail: `${s.message} (${time(s.checkedAt)})`, tone: 'caution' };
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
      toast({ tone: 'critical', title: 'Couldn’t check for updates', body: String((err as Error)?.message ?? err) });
    } finally {
      setBusy(false);
    }
  };
  const open = (url: string) => void window.capmac.invoke('app:open-external', { url }).catch(() => toast({ tone: 'critical', title: 'Couldn’t open the link', body: url }));
  return (
    <div className="settings-updates" role="group" aria-label="Updates">
      <div className="settings-updates__status">
        <span className={`settings-updates__icon${d.tone ? ` is-${d.tone}` : ''}`}>{d.icon === 'spinner' ? <Spinner size={16} /> : <Icon name={d.icon} size={16} filled={d.icon === 'checkCircle'} />}</span>
        <div className="settings-updates__text" aria-live="polite">
          <strong>{d.title}</strong>
          {d.detail && <span>{d.detail}</span>}
          {s.state === 'downloading' && <ProgressBar value={s.percent / 100} label={`Downloading capmac Studio ${s.version}`} className="settings-updates__progress" />}
          {info.feed && <span className="settings-updates__feed">Updates from {new URL(info.feed).host}</span>}
        </div>
      </div>
      <div className="settings-updates__actions">
        {s.state === 'ready' ? (
          <Button variant="accent" icon="refresh" onClick={() => void install()}>
            Restart to update
          </Button>
        ) : s.state === 'available' && s.download ? (
          <Button variant="accent" icon="download" onClick={() => open(s.download!)}>
            Download {s.version}
          </Button>
        ) : (
          <Button icon="refresh" busy={busy || s.state === 'checking'} disabled={!canCheck} onClick={() => void onCheck()}>
            Check for updates
          </Button>
        )}
        {info.notesUrl && (
          <Button variant="ghost" iconRight="open" onClick={() => open(info.notesUrl!)}>
            Release notes
          </Button>
        )}
      </div>
    </div>
  );
}
