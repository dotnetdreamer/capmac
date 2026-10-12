import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** Fluent ProgressRing. */
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  const stroke = size <= 16 ? 2 : size <= 24 ? 2.5 : 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className="spinner" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role={label ? 'progressbar' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * 0.28} ${c}`} />
    </svg>
  );
}

export function ProgressBar({ value, label, className }: { value?: number | null; label?: string; className?: string }) {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  return (
    <div
      className={`progress${determinate ? '' : ' progress-indeterminate'}${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
    >
      {determinate && <div className="progress__bar" style={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} />}
    </div>
  );
}

export type Tone = 'ok' | 'busy' | 'warn' | 'error' | 'idle' | 'info' | 'live';

export function StatusDot({ tone, pulse, label }: { tone: Tone; pulse?: boolean; label?: string }) {
  return <span className={`dot dot--${tone}${pulse ? ' dot--pulse' : ''}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function Badge({ children, tone = 'neutral', icon }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'caution' | 'critical' | 'outline'; icon?: IconName }) {
  return (
    <span className={`badge badge--${tone}`}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

const INFOBAR_ICONS: Record<string, IconName> = { info: 'info', success: 'checkCircle', caution: 'warning', critical: 'errorCircle' };

/** Fluent InfoBar: an inline message about something that needs attention. */
export function InfoBar({ tone = 'info', title, children, actions, onDismiss, className, live }: { tone?: 'info' | 'success' | 'caution' | 'critical'; title?: ReactNode; children?: ReactNode; actions?: ReactNode; onDismiss?: () => void; className?: string; live?: boolean }) {
  return (
    <div className={`infobar infobar--${tone}${className ? ` ${className}` : ''}`} role={live ? (tone === 'critical' ? 'alert' : 'status') : undefined}>
      <Icon name={INFOBAR_ICONS[tone]!} size={16} filled className="infobar__icon" />
      <div className="infobar__body">
        {title && <strong className="infobar__title">{title}</strong>}
        {children && <span className="infobar__message">{children}</span>}
      </div>
      {actions && <div className="infobar__actions">{actions}</div>}
      {onDismiss && (
        <button type="button" className="icon-btn icon-btn--sm icon-btn--subtle" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="dismiss" size={12} />
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, art, title, children, actions, compact }: { icon?: IconName; art?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty${compact ? ' empty--compact' : ''}`}>
      {art ?? (icon && (
        <div className="empty__icon">
          <Icon name={icon} size={compact ? 20 : 28} />
        </div>
      ))}
      <div className="empty__title">{title}</div>
      {children && <div className="empty__body">{children}</div>}
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  );
}

export function Skeleton({ width, height = 12, radius }: { width?: number | string; height?: number; radius?: number }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

/** A keyboard shortcut ("Ctrl+K") as key caps. */
export function Kbd({ keys }: { keys: string }) {
  return (
    <span className="kbd" aria-label={keys}>
      {keys.split('+').map((k, i) => (
        <kbd key={`${k}-${i}`}>{k}</kbd>
      ))}
    </span>
  );
}
