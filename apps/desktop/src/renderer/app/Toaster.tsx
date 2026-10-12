import { useEffect, useRef, useState } from 'react';
import { useToasts, type Toast } from '../state/app';
import { Icon, type IconName } from '../ui/Icon';

const ICONS: Record<Toast['tone'], IconName> = { info: 'info', success: 'checkCircle', caution: 'warning', critical: 'errorCircle' };

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const [hover, setHover] = useState(false);
  const remaining = useRef(toast.timeout ?? (toast.tone === 'critical' ? 8000 : 4500));
  useEffect(() => {
    if (hover || remaining.current <= 0 || toast.timeout === 0) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [hover, dismiss, toast.id, toast.timeout]);
  return (
    <div className={`toast toast--${toast.tone}`} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} role={toast.tone === 'critical' ? 'alert' : 'status'}>
      <Icon name={ICONS[toast.tone]} size={16} filled className="toast__icon" />
      <div className="toast__body">
        <div className="toast__title">{toast.title}</div>
        {toast.body && <div className="toast__text selectable">{toast.body}</div>}
        {toast.action && (
          <button
            type="button"
            className="btn btn--sm btn--standard toast__action"
            onClick={() => {
              toast.action!.run();
              dismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" className="icon-btn icon-btn--sm" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>
        <Icon name="dismiss" size={12} />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <section className="toaster" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </section>
  );
}
