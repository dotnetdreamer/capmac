import { useState, type ReactNode } from 'react';
import { Icon } from '../../ui/Icon';

function preview(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth > 0) return `Array(${value.length})`;
    const items = value.slice(0, 5).map((v) => preview(v, depth + 1));
    return `[${items.join(', ')}${value.length > 5 ? ', …' : ''}]`;
  }
  if (typeof value === 'object') {
    if (depth > 0) return '{…}';
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries.slice(0, 4).map(([k, v]) => `${k}: ${preview(v, depth + 1)}`);
    return `{${shown.join(', ')}${entries.length > 4 ? ', …' : ''}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}…` : value);
  return String(value);
}

function Primitive({ value }: { value: unknown }) {
  const kind = value === null ? 'null' : typeof value;
  return <span className={`json-${kind}`}>{typeof value === 'string' ? JSON.stringify(value) : String(value)}</span>;
}

function Entry({ name, value, depth }: { name: ReactNode; value: unknown; depth: number }) {
  const [open, setOpen] = useState(false);
  const composite = value !== null && typeof value === 'object';
  if (!composite) {
    return (
      <div className="json-entry" style={{ paddingLeft: depth * 14 + 18 }}>
        <span className="json-key">{name}</span>: <Primitive value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  return (
    <div>
      <button type="button" className="json-entry json-toggle" style={{ paddingLeft: depth * 14 }} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span className="json-key">{name}</span>: <span className="json-preview">{open ? (Array.isArray(value) ? `Array(${entries.length})` : '') : preview(value)}</span>
      </button>
      {open && entries.map(([k, v]) => <Entry key={k} name={k} value={v} depth={depth + 1} />)}
    </div>
  );
}

/** console.log(object) output as a collapsed preview that expands into a tree. */
export function JsonTree({ prefix, value, highlight }: { prefix: string; value: unknown; highlight: (text: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  return (
    <span className="json">
      <button type="button" className="json-root" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        {prefix && <span className="json-prefix">{highlight(prefix)} </span>}
        <span className="json-preview">{preview(value)}</span>
      </button>
      {open && (
        <span className="json-body" role="group">
          {entries.map(([k, v]) => (
            <Entry key={k} name={k} value={v} depth={1} />
          ))}
          <button type="button" className="btn btn--sm btn--subtle json-copy" onClick={() => void navigator.clipboard.writeText(JSON.stringify(value, null, 2))}>
            <Icon name="copy" size={12} />
            Copy JSON
          </button>
        </span>
      )}
    </span>
  );
}
