import { useState } from 'react';
import type { Check, FixId } from '../../../shared/contract';
import { toast } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { useMacs } from '../../state/macs';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Skeleton } from '../../ui/Feedback';
import { Icon, type IconName } from '../../ui/Icon';
import './macs.css';

const LEVEL_ICON: Record<Check['level'], IconName> = { ok: 'checkCircle', warn: 'warning', fail: 'errorCircle', info: 'info' };

/** Shown instead of CLI wording ("Run `capmac doctor --fix`") when a button does the fix. */
function fixText(check: Check): string | undefined {
  if (!check.fix || check.level === 'ok') return undefined;
  if (check.action && /capmac doctor --fix/.test(check.fix)) return undefined;
  return check.fix.replace(/`capmac doctor`/g, 'Check again');
}

function CheckRow({ mac, check }: { mac: string; check: Check }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const runHealth = useMacs((s) => s.runHealth);
  const fix = async (id: FixId) => {
    setConfirming(false);
    setBusy(true);
    try {
      await call('macs.fix', { name: mac, fix: id });
      toast({ tone: 'success', title: `${check.action?.label ?? 'Fix'}: done` });
      void runHealth(mac);
    } catch (err) {
      const e = errorInfo(err);
      if (!e.cancelled) toast({ tone: 'critical', title: e.message, body: e.hint });
    } finally {
      setBusy(false);
    }
  };
  const text = fixText(check);
  return (
    <li className={`check check--${check.level}`}>
      <Icon name={LEVEL_ICON[check.level]} size={16} filled={check.level !== 'info'} className="check__icon" />
      <div className="check__body">
        <div className="check__label">
          {check.label}
          {check.detail && <span className="check__detail"> · {check.detail}</span>}
        </div>
        {text && <div className="check__fix">{text}</div>}
      </div>
      {check.action && (
        <Button size="sm" busy={busy} onClick={() => (check.action!.confirm ? setConfirming(true) : void fix(check.action!.id))}>
          {check.action.label}
        </Button>
      )}
      {confirming && check.action && (
        <Dialog
          open
          size="sm"
          title={check.action.label}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="accent" onClick={() => void fix(check.action!.id)} data-autofocus>
                {check.action.label}
              </Button>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
            </>
          }
        >
          <p>{check.action.confirm}</p>
        </Dialog>
      )}
    </li>
  );
}

export function CheckList({ mac, checks, checking }: { mac: string; checks: Check[]; checking: boolean }) {
  return (
    <ul className="checks" aria-busy={checking} aria-live="polite">
      {checks.map((c) => (
        <CheckRow key={c.id} mac={mac} check={c} />
      ))}
      {checking &&
        Array.from({ length: Math.max(1, 6 - checks.length) }, (_, i) => (
          <li key={`s${i}`} className="check check--loading" aria-hidden="true">
            <Skeleton width={16} height={16} radius={8} />
            <div className="check__body">
              <Skeleton width={`${40 + ((i * 17) % 35)}%`} height={12} />
            </div>
          </li>
        ))}
    </ul>
  );
}
