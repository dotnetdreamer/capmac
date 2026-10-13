import { t } from '../../shared/i18n';
import { useApp } from '../state/app';
import { InfoBar } from '../ui/Feedback';

/** Shown only when capmac's engine process is down (it restarts by itself). */
export function EngineBanner() {
  const engine = useApp((s) => s.engine);
  if (engine.state !== 'crashed') return null;
  return (
    <div className="engine-banner">
      <InfoBar tone={engine.restarting ? 'caution' : 'critical'} title={engine.restarting ? t.engine.restartingTitle : t.engine.crashedTitle} live>
        {engine.restarting ? t.engine.restartingBody : t.engine.crashedBody}
      </InfoBar>
    </div>
  );
}
