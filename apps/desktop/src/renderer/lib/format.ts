import { t } from '../../shared/i18n';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return t.time.justNow;
  if (abs < 45 * 60) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 22 * 3600) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 6 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(ts: number, withMs = false): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return withMs ? `${hh}:${mm}:${ss}.${String(d.getMilliseconds()).padStart(3, '0')}` : `${hh}:${mm}:${ss}`;
}

/** Shortens a path for display: "C:\Users\ik\work\app" → "…\work\app". */
export function shortPath(p: string, keep = 2): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= keep + 1 ? p : `…\\${parts.slice(-keep).join('\\')}`;
}

/** Path relative to a folder, for display ("ios\App\App\AppDelegate.swift"). */
export function relativeTo(file: string, root: string): string {
  const f = file.replace(/\//g, '\\');
  const r = root.replace(/\//g, '\\').replace(/\\+$/, '');
  return f.toLowerCase().startsWith(`${r.toLowerCase()}\\`) ? f.slice(r.length + 1) : f;
}
