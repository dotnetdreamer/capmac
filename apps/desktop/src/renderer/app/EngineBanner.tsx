import { useApp } from '../state/app';
import { InfoBar } from '../ui/Feedback';

/** Shown only when capmac's engine process is down (it restarts by itself). */
export function EngineBanner() {
  const engine = useApp((s) => s.engine);
  if (engine.state !== 'crashed') return null;
  return (
    <div className="engine-banner">
      <InfoBar tone={engine.restarting ? 'caution' : 'critical'} title={engine.restarting ? 'capmac’s engine stopped. Restarting it…' : 'capmac’s engine keeps stopping.'} live>
        {engine.restarting ? 'Running sessions were stopped; start them again once it is back.' : 'Restart capmac Studio. If it keeps happening, run capmac doctor in a terminal.'}
      </InfoBar>
    </div>
  );
}
