import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AppDialog, AppDialogAnswer, MacFolder } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { Button, IconButton } from '../../ui/Button';
import { Spinner } from '../../ui/Feedback';
import { Icon, type IconName } from '../../ui/Icon';

/** A dialog command for the engine (the window pane adds the request id). */
export type AppDialogCommand =
  | { type: 'dialog-answer'; dialog: number; answer: AppDialogAnswer }
  | { type: 'dialog-list'; path: string; hidden?: boolean }
  | { type: 'dialog-mkdir'; path: string };

export type AppDialogRequest = (command: AppDialogCommand) => Promise<unknown>;

const errorText = (err: unknown) => tidy((err as Error)?.message ?? String(err)) ?? '';

/**
 * The app's dialogs over its window. While the app is in the background on
 * the Mac they stay off the Mac's screen (so nobody working there is
 * interrupted) and are answered here instead.
 */
export function AppDialogLayer({ dialogs, request }: { dialogs: AppDialog[]; request: AppDialogRequest }) {
  const dialog = dialogs[0];
  if (!dialog) return null;
  const answer = (a: AppDialogAnswer) => request({ type: 'dialog-answer', dialog: dialog.id, answer: a }).then(() => undefined);
  return (
    <div className={`appdlg-layer${dialog.window !== null ? ' is-sheet' : ''}`}>
      {dialog.kind === 'message' ? (
        <MessageBox key={dialog.id} dialog={dialog} answer={answer} more={dialogs.length - 1} />
      ) : (
        <FilePanel key={dialog.id} dialog={dialog} answer={answer} request={request} more={dialogs.length - 1} />
      )}
    </div>
  );
}

function Note({ dialog, more }: { dialog: AppDialog; more: number }) {
  return (
    <span className="appdlg__note">
      {dialog.blocking ? t.appDialog.waits : t.appDialog.shownHere}
      {more > 0 && <span className="faint"> · {t.appDialog.more(more)}</span>}
    </span>
  );
}

const TYPE_ICONS: Record<string, IconName> = { warning: 'warning', error: 'errorCircle', question: 'question', info: 'info', none: 'info' };

function MessageBox({ dialog, answer, more }: { dialog: Extract<AppDialog, { kind: 'message' }>; answer: (a: AppDialogAnswer) => Promise<void>; more: number }) {
  const buttons = dialog.buttons.length ? dialog.buttons : [t.appDialog.ok];
  const [checked, setChecked] = useState(dialog.checkboxChecked);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = (response: number) => {
    if (busy !== null) return;
    setBusy(response);
    setError(null);
    answer({ kind: 'message', response, checkboxChecked: checked }).catch((err) => {
      setBusy(null);
      setError(errorText(err));
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      choose(dialog.cancelId);
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      choose(dialog.defaultId);
    }
  };
  const messageId = `appdlg-msg-${dialog.id}`;
  return (
    <div className="appdlg" role="alertdialog" aria-modal="true" aria-labelledby={messageId} aria-describedby={dialog.detail ? `${messageId}-detail` : undefined} onKeyDown={onKeyDown}>
      <div className="appdlg__body">
        <span className={`appdlg__icon appdlg__icon--${dialog.type}`} aria-hidden="true">
          <Icon name={TYPE_ICONS[dialog.type] ?? 'info'} size={20} filled />
        </span>
        <div className="appdlg__text">
          <p id={messageId} className="appdlg__message">{dialog.message || dialog.title || t.appDialog.message}</p>
          {dialog.title && dialog.message && <p className="appdlg__title">{dialog.title}</p>}
          {dialog.detail && <p id={`${messageId}-detail`} className="appdlg__detail">{dialog.detail}</p>}
          {dialog.checkboxLabel && (
            <label className="appdlg__check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              {dialog.checkboxLabel}
            </label>
          )}
        </div>
      </div>
      {error && <p className="appdlg__error" role="alert">{error}</p>}
      <div className="appdlg__foot">
        <Note dialog={dialog} more={more} />
        {/* The first button on the right, as on a Mac. */}
        <div className="appdlg__buttons">
          {buttons.map((label, i) => (
            <Button key={i} size="sm" variant={i === dialog.defaultId ? 'accent' : 'standard'} autoFocus={i === dialog.defaultId} busy={busy === i} disabled={busy !== null && busy !== i} onClick={() => choose(i)}>
              {label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp|svg|ico|icns)$/i;
const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;
const sizeText = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const dateText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function FilePanel({ dialog, answer, request, more }: { dialog: Extract<AppDialog, { kind: 'open' | 'save' }>; answer: (a: AppDialogAnswer) => Promise<void>; request: AppDialogRequest; more: number }) {
  const save = dialog.kind === 'save';
  const props = useMemo(() => new Set(dialog.properties), [dialog.properties]);
  const multi = !save && props.has('multiSelections');
  const pickDirs = !save && props.has('openDirectory');
  const pickFiles = save || props.has('openFile') || !pickDirs;
  const [folder, setFolder] = useState<MacFolder | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState(0);
  const [hidden, setHidden] = useState(props.has('showHiddenFiles'));
  const [name, setName] = useState('');
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState('');
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const extensions = useMemo(() => {
    const f = dialog.filters[filter];
    return f && f.extensions.length && !f.extensions.includes('*') ? f.extensions.map((x) => x.toLowerCase()) : null;
  }, [dialog.filters, filter]);
  const fits = (entry: MacFolder['entries'][number]) => {
    if (entry.dir) return true;
    if (!pickFiles) return false;
    return !extensions || extensions.includes((entry.name.split('.').pop() ?? '').toLowerCase());
  };

  const open = async (target: string, select?: string, showHidden = hidden) => {
    setLoading(true);
    try {
      const next = (await request({ type: 'dialog-list', path: target, hidden: showHidden })) as MacFolder;
      setFolder(next);
      setPath(next.path);
      setSelected(select ? [select] : []);
      setReplace(false);
      setError(null);
      return next;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setLoading(false);
    }
  };

  // Saving: the suggested name in its folder. Opening: the suggested folder, else the project's.
  useEffect(() => {
    void (async () => {
      const first = await open(dialog.defaultPath || dialog.project || '~');
      if (!first) {
        await open('~');
        return;
      }
      if (save && dialog.defaultPath && first.path !== dialog.defaultPath.replace(/\/+$/, '')) setName(baseName(dialog.defaultPath));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for this dialog
  }, []);
  useEffect(() => {
    if (save) nameRef.current?.focus();
    else listRef.current?.focus();
  }, [save]);

  const finish = (paths: string[]) => {
    if (busy) return;
    setBusy(true);
    answer({ kind: 'files', paths }).catch((err) => {
      setBusy(false);
      setError(errorText(err));
    });
  };

  const confirm = () => {
    if (!folder) return;
    if (save) {
      let file = name.trim();
      if (!file) return setError(t.appDialog.nameNeeded);
      if (file.includes('/')) return setError(t.appDialog.noSlash);
      if (extensions && !/\.[^.]+$/.test(file)) file = `${file}.${extensions[0]}`;
      if (folder.entries.some((e) => e.name === file) && !replace) {
        setReplace(true);
        setError(t.appDialog.exists(file));
        return;
      }
      return finish([joinPath(folder.path, file)]);
    }
    const picks = selected.map((n) => folder.entries.find((e) => e.name === n)).filter((e): e is NonNullable<typeof e> => Boolean(e));
    if (picks.length === 1 && picks[0]!.dir && !pickDirs) return void open(joinPath(folder.path, picks[0]!.name));
    if (picks.length === 0) return pickDirs ? finish([folder.path]) : setError(t.appDialog.pickFirst);
    finish(picks.filter((e) => fits(e) && (pickDirs || !e.dir)).map((e) => joinPath(folder.path, e.name)));
  };

  const makeFolder = async () => {
    const folderName = newFolder?.trim().replace(/\//g, ':');
    if (!folderName || !folder) return;
    try {
      await request({ type: 'dialog-mkdir', path: joinPath(folder.path, folderName) });
      setNewFolder(null);
      await open(folder.path, folderName);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const pick = (entry: MacFolder['entries'][number], add: boolean) => {
    if (save && !entry.dir) {
      setName(entry.name);
      setReplace(false);
      return;
    }
    if (!fits(entry)) return;
    setSelected((current) => (multi && add ? (current.includes(entry.name) ? current.filter((n) => n !== entry.name) : [...current, entry.name]) : [entry.name]));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (newFolder !== null) setNewFolder(null);
      else finish([]);
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !(e.target as HTMLElement).dataset.ownEnter) {
      e.preventDefault();
      confirm();
    }
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!folder || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const names = folder.entries.filter(fits).map((x) => x.name);
    const at = names.indexOf(selected[selected.length - 1] ?? '');
    const next = names[Math.max(0, Math.min(names.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) setSelected([next]);
  };

  const heading = dialog.title || (save ? t.appDialog.save : pickDirs && !props.has('openFile') ? t.appDialog.chooseFolder : t.appDialog.open);
  const confirmLabel = replace ? t.appDialog.replace : dialog.buttonLabel || (save ? t.appDialog.save : t.appDialog.open);
  return (
    <div className="appdlg appdlg--files" role="dialog" aria-modal="true" aria-label={heading} onKeyDown={onKeyDown}>
      <div className="appdlg__head">
        <span className="appdlg__heading">{heading}</span>
        {dialog.message && <span className="appdlg__sub">{dialog.message}</span>}
      </div>
      {save && (
        <label className="appdlg__name">
          <span>{dialog.nameFieldLabel || t.appDialog.saveAs}</span>
          <span className="input input--compact">
            <input
              ref={nameRef}
              value={name}
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value);
                setReplace(false);
              }}
            />
          </span>
        </label>
      )}
      <div className="appdlg__browser">
        <nav className="appdlg__places" aria-label={t.appDialog.places}>
          {folder?.places.map((p) => (
            <button key={p.path} type="button" className={`appdlg__place${p.path === folder.path ? ' is-on' : ''}`} onClick={() => void open(p.path)}>
              <Icon name={p.name === 'Home' ? 'home' : p.name === 'Mac' ? 'mac' : p.name === 'Project' ? 'code' : 'folderOpen'} size={14} />
              <span className="truncate">{t.appDialog.place[p.name] ?? p.name}</span>
            </button>
          ))}
        </nav>
        <div className="appdlg__main">
          <div className="appdlg__pathbar">
            <IconButton icon="arrowUp" size="sm" label={t.appDialog.up} disabled={!folder?.parent} onClick={() => folder?.parent && void open(folder.parent)} />
            <span className="input input--compact appdlg__path">
              <input
                value={path}
                aria-label={t.appDialog.folderOnMac}
                spellCheck={false}
                data-own-enter="true"
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void open(path);
                  }
                }}
              />
            </span>
          </div>
          <div ref={listRef} className="appdlg__list" role="listbox" aria-label={t.appDialog.files} aria-multiselectable={multi || undefined} aria-busy={loading || undefined} data-folder={folder?.path} tabIndex={0} onKeyDown={onListKey}>
            {loading && !folder ? (
              <div className="appdlg__empty">
                <Spinner size={16} /> {t.appDialog.loading}
              </div>
            ) : folder && folder.entries.length === 0 ? (
              <div className="appdlg__empty">{t.appDialog.empty}</div>
            ) : (
              folder?.entries.map((entry) => {
                const on = selected.includes(entry.name);
                return (
                  <div
                    key={entry.name}
                    role="option"
                    aria-selected={on}
                    aria-disabled={!fits(entry) && !(save && !entry.dir)}
                    className={`appdlg__row${on ? ' is-selected' : ''}${fits(entry) ? '' : ' is-off'}`}
                    onClick={(e) => pick(entry, e.ctrlKey || e.metaKey)}
                    onDoubleClick={() => {
                      if (entry.dir) void open(joinPath(folder.path, entry.name));
                      else if (fits(entry)) {
                        setSelected([entry.name]);
                        finish([joinPath(folder.path, entry.name)]);
                      }
                    }}
                  >
                    <Icon name={entry.dir ? 'folderOpen' : IMAGE.test(entry.name) ? 'image' : 'document'} size={16} className="appdlg__row-icon" />
                    <span className="appdlg__row-name truncate">{entry.name}</span>
                    <span className="appdlg__row-meta tabular">{entry.dir ? '' : sizeText(entry.size)}</span>
                    <span className="appdlg__row-meta tabular">{entry.modified ? dateText.format(entry.modified) : ''}</span>
                  </div>
                );
              })
            )}
            {folder?.truncated && <div className="appdlg__empty">{t.appDialog.truncated}</div>}
          </div>
        </div>
      </div>
      <div className="appdlg__opts">
        {dialog.filters.length > 1 && (
          <select
            className="appdlg__select"
            aria-label={t.appDialog.fileType}
            value={String(filter)}
            onChange={(e) => {
              setFilter(Number(e.target.value));
              setSelected([]);
            }}
          >
            {dialog.filters.map((f, i) => (
              <option key={i} value={String(i)}>
                {f.name || (f.extensions.includes('*') ? t.appDialog.allFiles : f.extensions.join(', '))}
              </option>
            ))}
          </select>
        )}
        <label className="appdlg__check">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => {
              setHidden(e.target.checked);
              if (folder) void open(folder.path, undefined, e.target.checked);
            }}
          />
          {t.appDialog.showHidden}
        </label>
        {(save || props.has('createDirectory')) &&
          (newFolder === null ? (
            <Button size="sm" variant="subtle" icon="folderAdd" onClick={() => setNewFolder(t.appDialog.untitledFolder)}>
              {t.appDialog.newFolder}
            </Button>
          ) : (
            <span className="appdlg__newfolder">
              <span className="input input--compact">
                <input
                  autoFocus
                  value={newFolder}
                  aria-label={t.appDialog.newFolderName}
                  data-own-enter="true"
                  onChange={(e) => setNewFolder(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void makeFolder();
                    }
                  }}
                />
              </span>
              <Button size="sm" onClick={() => void makeFolder()}>
                {t.appDialog.create}
              </Button>
            </span>
          ))}
      </div>
      {error && <p className="appdlg__error" role="alert">{error}</p>}
      <div className="appdlg__foot">
        <Note dialog={dialog} more={more} />
        <div className="appdlg__buttons">
          <Button size="sm" variant="accent" busy={busy} onClick={confirm} disabled={!folder}>
            {confirmLabel}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => finish([])}>
            {t.appDialog.cancel}
          </Button>
        </div>
      </div>
    </div>
  );
}
