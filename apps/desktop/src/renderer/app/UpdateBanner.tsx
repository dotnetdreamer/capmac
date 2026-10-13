import { useMemo } from 'react';
import { t } from '../../shared/i18n';
import { isActive, useRuns } from '../state/runs';
import { useUpdates } from '../state/updates';
import { Button } from '../ui/Button';
import { InfoBar } from '../ui/Feedback';

/** A downloaded update: restart when convenient, or it installs when capmac Studio quits. */
export function UpdateBanner() {
  const info = useUpdates((s) => s.info);
  const dismissed = useUpdates((s) => s.dismissed);
  const dismiss = useUpdates((s) => s.dismiss);
  const install = useUpdates((s) => s.install);
  const byKey = useRuns((s) => s.byKey);
  const busy = useMemo(() => Object.values(byKey).some(isActive), [byKey]);
  if (!info || info.state.state !== 'ready' || dismissed === info.state.version) return null;
  const version = info.state.version;
  return (
    <div className="engine-banner">
      <InfoBar
        tone="info"
        title={t.updateBanner.title(version)}
        live
        onDismiss={() => dismiss(version)}
        actions={
          <>
            {info.notesUrl && (
              <Button size="sm" variant="ghost" onClick={() => void window.capmac.invoke('app:open-external', { url: info.notesUrl! })}>
                {t.updateBanner.whatsNew}
              </Button>
            )}
            <Button size="sm" variant={busy ? 'standard' : 'accent'} icon="refresh" onClick={() => void install()}>
              {t.updateBanner.restart}
            </Button>
          </>
        }
      >
        {busy ? t.updateBanner.busy : t.updateBanner.idle}
      </InfoBar>
    </div>
  );
}
