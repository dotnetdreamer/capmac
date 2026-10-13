import { forwardRef, useId, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../../shared/i18n';
import { Icon, type IconName } from './Icon';
import { Menu, usePopover } from './Popover';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  icon?: IconName;
  trailing?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField({ label, hint, error, icon, trailing, className, id, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  return (
    <div className={`field${error ? ' has-error' : ''}${className ? ` ${className}` : ''}`}>
      {label && (
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className="input">
        {icon && <Icon name={icon} size={16} className="input__icon" />}
        <input ref={ref} id={inputId} aria-invalid={error ? true : undefined} aria-describedby={hint || error ? hintId : undefined} spellCheck={false} {...rest} />
        {trailing}
      </div>
      {(error || hint) && (
        <div id={hintId} className={error ? 'field__error' : 'field__hint'}>
          {error ?? hint}
        </div>
      )}
    </div>
  );
});

export const PasswordField = forwardRef<HTMLInputElement, FieldProps>(function PasswordField(props, ref) {
  const [reveal, setReveal] = useState(false);
  return (
    <TextField
      ref={ref}
      type={reveal ? 'text' : 'password'}
      autoComplete="off"
      {...props}
      trailing={
        <button type="button" className="input__action" aria-label={reveal ? t.ui.hidePassword : t.ui.showPassword} aria-pressed={reveal} onClick={() => setReveal((r) => !r)}>
          <Icon name={reveal ? 'eyeOff' : 'eye'} size={16} />
        </button>
      }
    />
  );
});

export const SearchField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { onClear?: () => void; count?: ReactNode; onPrev?: () => void; onNext?: () => void; compact?: boolean }>(function SearchField(
  { onClear, count, onPrev, onNext, compact, className, value, ...rest },
  ref,
) {
  return (
    <div className={`input input--search${compact ? ' input--compact' : ''}${className ? ` ${className}` : ''}`}>
      <Icon name="search" size={14} className="input__icon" />
      <input ref={ref} type="search" value={value} spellCheck={false} {...rest} />
      {count !== undefined && value ? <span className="input__count tabular">{count}</span> : null}
      {onPrev && value ? (
        <button type="button" className="input__action" aria-label={t.ui.previousMatch} onClick={onPrev}>
          <Icon name="chevronUp" size={14} />
        </button>
      ) : null}
      {onNext && value ? (
        <button type="button" className="input__action" aria-label={t.ui.nextMatch} onClick={onNext}>
          <Icon name="chevronDown" size={14} />
        </button>
      ) : null}
      {onClear && value ? (
        <button type="button" className="input__action" aria-label={t.ui.clearSearch} onClick={onClear}>
          <Icon name="dismiss" size={12} />
        </button>
      ) : null}
    </div>
  );
});

/** Fluent ToggleSwitch. */
export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="switch-row">
      <div className="switch-row__text">
        <label htmlFor={id} className="switch-row__label">
          {label}
        </label>
        {description && <div className="switch-row__desc">{description}</div>}
      </div>
      <span className="switch-row__state" aria-hidden="true">
        {checked ? t.common.on : t.common.off}
      </span>
      <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled} className="switch" onClick={() => onChange(!checked)}>
        <span className="switch__thumb" />
      </button>
    </div>
  );
}

/** An On/Off switch with its state written next to it (settings rows, cards). */
export function Toggle({ checked, onChange, label, disabled, loading }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; loading?: boolean }) {
  return (
    <span className="toggle-control">
      <span className="toggle-control__state" aria-hidden="true">
        {loading ? '…' : checked ? t.common.on : t.common.off}
      </span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} aria-busy={loading || undefined} onClick={() => onChange(!checked)}>
        <span className="switch__thumb" />
      </button>
    </span>
  );
}

/** A segmented control (radio group) for 2–4 choices. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: Array<{ value: T; label: string; icon?: IconName }>; label: string }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex((o) => o.value === value);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(index + step + options.length) % options.length]!;
    onChange(next.value);
    (e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          data-value={o.value}
          className={`segmented__item${o.value === value ? ' is-selected' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={16} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A dropdown that picks one value (Fluent ComboBox look, menu behaviour). */
export function Select<T extends string>({ value, onChange, options, label, width }: { value: T; onChange: (value: T) => void; options: Array<{ value: T; label: string; hint?: string }>; label: string; width?: number }) {
  const popover = usePopover();
  const current = options.find((o) => o.value === value);
  return (
    <>
      <button type="button" className="select" aria-label={label} aria-haspopup="menu" style={width ? { width } : undefined} {...popover.triggerProps}>
        <span className="truncate">{current?.label ?? value}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Menu
        state={popover}
        label={label}
        placement="bottom-start"
        width={width}
        items={options.map((o) => ({ id: o.value, label: o.label, hint: o.hint, checked: o.value === value, onSelect: () => onChange(o.value) }))}
      />
    </>
  );
}
