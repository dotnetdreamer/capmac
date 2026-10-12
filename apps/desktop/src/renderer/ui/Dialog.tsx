import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Fluent ContentDialog on the native <dialog> element: modal, focus trapped,
 * Esc closes, focus returns to where it was.
 */
export function Dialog({
  open,
  onClose,
  title,
  icon,
  children,
  footer,
  size = 'md',
  onSubmit,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: IconName;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Makes the dialog a form: Enter submits. */
  onSubmit?: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
      // Focus the first field (or the primary button) like ContentDialog does.
      const first = dialog.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), textarea, select');
      (first ?? dialog.querySelector<HTMLElement>('.btn--accent'))?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      returnFocus.current?.focus?.();
    }
  }, [open]);

  const body = (
    <>
      <div className="dialog__content">
        <div className="dialog__header">
          {icon && <Icon name={icon} size={20} className="dialog__icon" />}
          <h2 id={titleId} className="dialog__title">
            {title}
          </h2>
        </div>
        {children && <div className="dialog__body">{children}</div>}
      </div>
      {footer && <div className="dialog__footer">{footer}</div>}
    </>
  );

  return (
    <dialog
      ref={ref}
      className={`dialog dialog--${size}${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open &&
        (onSubmit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {body}
          </form>
        ) : (
          body
        ))}
    </dialog>
  );
}
