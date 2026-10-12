import { useMemo, useState } from 'react';
import type { Diagnostic } from '../../../shared/contract';
import { openInEditor } from '../../state/actions';
import { toast, useApp } from '../../state/app';
import type { RunState } from '../../state/runs';
import { plural, relativeTo } from '../../lib/format';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';

function asText(d: Diagnostic): string {
  const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}${d.column ? `:${d.column}` : ''}: ` : '';
  return `${where}${d.severity}: ${d.message}${d.context?.length ? `\n${d.context.join('\n')}` : ''}`;
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast({ tone: 'success', title: `Copied ${what}` }),
    () => toast({ tone: 'critical', title: 'Could not copy to the clipboard' }),
  );
}

/** The source line and the caret line under it (xcodebuild's excerpt). */
function Excerpt({ lines, line }: { lines: string[]; line?: number }) {
  return (
    <pre className="excerpt selectable" aria-label="Code excerpt">
      {lines.map((text, i) => {
        const caret = /^\s*[\^~]+\s*$/.test(text);
        return (
          <span key={i} className={`excerpt__line${caret ? ' is-caret' : ''}`}>
            <span className="excerpt__gutter" aria-hidden="true">
              {!caret && line && i === 0 ? line : ''}
            </span>
            {text || ' '}
          </span>
        );
      })}
    </pre>
  );
}

function DiagnosticRow({ d, root }: { d: Diagnostic; root: string }) {
  const icon = d.severity === 'error' ? 'errorCircle' : d.severity === 'warning' ? 'warning' : 'info';
  const open = () => d.file && void openInEditor(d.file, d.line, d.column);
  return (
    <li className={`problem problem--${d.severity}`}>
      <button type="button" className="problem__main" onClick={open} disabled={!d.file} aria-label={`${d.severity}: ${d.message}${d.file ? `, ${relativeTo(d.file, root)} line ${d.line ?? ''}. Open in editor` : ''}`}>
        <Icon name={icon} size={16} filled className="problem__icon" />
        <span className="problem__message">{d.message}</span>
        {d.line && (
          <span className="problem__loc tabular">
            {d.line}
            {d.column ? `:${d.column}` : ''}
          </span>
        )}
      </button>
      {d.context && d.context.length > 0 && <Excerpt lines={d.context} line={d.line} />}
      <span className="problem__actions">
        <IconButton icon="copy" size="sm" label="Copy problem" onClick={() => copy(asText(d), 'the problem')} />
      </span>
    </li>
  );
}

interface FileGroup {
  file: string | null;
  items: Diagnostic[];
  errors: number;
  warnings: number;
}

function group(diags: Diagnostic[]): FileGroup[] {
  const map = new Map<string, FileGroup>();
  for (const d of diags) {
    const key = d.file ?? '';
    const g = map.get(key) ?? { file: d.file ?? null, items: [], errors: 0, warnings: 0 };
    g.items.push(d);
    if (d.severity === 'error') g.errors += 1;
    if (d.severity === 'warning') g.warnings += 1;
    map.set(key, g);
  }
  const rank = (d: Diagnostic) => (d.severity === 'error' ? 0 : d.severity === 'warning' ? 1 : 2);
  for (const g of map.values()) g.items.sort((a, b) => rank(a) - rank(b) || (a.line ?? 0) - (b.line ?? 0));
  return [...map.values()].sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);
}

function Group({ g, root, defaultOpen }: { g: FileGroup; root: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const name = g.file ? relativeTo(g.file, root) : 'General';
  const base = name.split(/[\\/]/).pop();
  // The folder next to the file name, as VS Code shows it ("ios\App\App").
  const dir = name.slice(0, name.length - (base?.length ?? 0)).replace(/[\\/]+$/, '');
  return (
    <li className="problem-group">
      <button type="button" className="problem-group__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <Icon name="document" size={16} className="problem-group__file" />
        <span className="problem-group__name truncate">
          {base}
          {dir && <span className="faint"> {dir}</span>}
        </span>
        {g.errors > 0 && <span className="count count--error">{g.errors}</span>}
        {g.warnings > 0 && <span className="count count--warn">{g.warnings}</span>}
      </button>
      {open && (
        <ul className="problem-group__items">
          {g.items.map((d, i) => (
            <DiagnosticRow key={i} d={d} root={root} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Problems listed on their own: errors anywhere, warnings in your code (and in dependencies when the setting says so). */
export function isListed(d: Diagnostic, showDeps: boolean): boolean {
  return Boolean(d.own) || d.severity === 'error' || showDeps;
}

export function Problems({ path, run }: { path: string; run: RunState | undefined }) {
  const showDeps = useApp((s) => s.settings?.dependencyWarnings ?? false);
  const [depsOpen, setDepsOpen] = useState(false);
  const diags = run?.diagnostics ?? [];
  const own = useMemo(() => diags.filter((d) => isListed(d, showDeps)), [diags, showDeps]);
  const deps = useMemo(() => diags.filter((d) => !isListed(d, showDeps)), [diags, showDeps]);
  const groups = useMemo(() => group(own), [own]);
  const errors = diags.filter((d) => d.severity === 'error').length;

  if (diags.length === 0) {
    return (
      <EmptyState compact icon="checkCircle" title={run?.runNumber ? 'No problems' : 'Problems show up here'}>
        {run?.runNumber ? 'The last build reported no errors or warnings in your code.' : 'Compiler errors and warnings from Xcode, with a click to open them in your editor.'}
      </EmptyState>
    );
  }

  return (
    <div className="problems">
      <div className="problems__bar">
        <span className="problems__summary">
          {errors > 0 && <span className="count count--error">{plural(errors, 'error')}</span>}
          {own.length - errors > 0 && <span className="count count--warn">{plural(own.length - errors, 'warning')}</span>}
        </span>
        <span className="session-bar__spacer" />
        <Button size="sm" variant="subtle" icon="copy" onClick={() => copy(own.map(asText).join('\n\n'), plural(own.length, 'problem'))}>
          Copy all
        </Button>
      </div>
      <ul className="problems__list" aria-label="Problems">
        {groups.map((g, i) => (
          <Group key={g.file ?? '-'} g={g} root={path} defaultOpen={i < 6} />
        ))}
        {deps.length > 0 && (
          <li className="problem-group problem-group--deps">
            <button type="button" className="problem-group__head" aria-expanded={depsOpen} onClick={() => setDepsOpen((o) => !o)}>
              <Icon name={depsOpen ? 'chevronDown' : 'chevronRight'} size={12} />
              <Icon name="box" size={16} className="problem-group__file" />
              <span className="problem-group__name">{plural(deps.length, 'warning')} from dependencies</span>
              <span className="faint">Pods, Swift packages, node_modules</span>
            </button>
            {depsOpen && (
              <ul className="problem-group__items">
                {deps.map((d, i) => (
                  <DiagnosticRow key={i} d={d} root={path} />
                ))}
              </ul>
            )}
          </li>
        )}
      </ul>
    </div>
  );
}
