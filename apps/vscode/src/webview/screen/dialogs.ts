/**
 * An Electron app's dialogs over its window (CapMac Studio's AppDialog.tsx,
 * without React). While the app is in the background on the Mac, its message
 * boxes and file pickers stay off the Mac's screen and are answered here.
 */
import type { AppDialog, AppDialogAnswer, MacFolder } from '../../../../desktop/src/shared/contract';
import { t, tidy } from '../../../../desktop/src/shared/i18n/index';
import { button, h, icon } from './dom';

export type DialogCommand =
  | { type: 'dialog-answer'; dialog: number; answer: AppDialogAnswer }
  | { type: 'dialog-list'; path: string; hidden?: boolean }
  | { type: 'dialog-mkdir'; path: string };

export type DialogRequest = (command: DialogCommand) => Promise<unknown>;

const errorText = (err: unknown) => tidy((err as Error)?.message ?? String(err)) ?? '';
const IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp|svg|ico|icns)$/i;
const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;
const sizeText = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const dateText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const TYPE_ICONS: Record<string, string> = { warning: 'warning', error: 'error', question: 'question', info: 'info', none: 'info' };

/** Shows the first waiting dialog in `layer`; call again whenever the list changes. */
export class DialogLayer {
  private shown: number | null = null;

  constructor(private readonly layer: HTMLElement, private readonly request: DialogRequest) {}

  update(dialogs: AppDialog[]): void {
    const dialog = dialogs[0];
    if (!dialog) {
      this.shown = null;
      this.layer.replaceChildren();
      this.layer.hidden = true;
      return;
    }
    if (this.shown === dialog.id) {
      this.layer.querySelector('.dlg__more')?.replaceChildren(dialogs.length > 1 ? ` · ${t.appDialog.more(dialogs.length - 1)}` : '');
      return;
    }
    this.shown = dialog.id;
    this.layer.hidden = false;
    this.layer.classList.toggle('is-sheet', dialog.window !== null);
    const answer = (a: AppDialogAnswer) => this.request({ type: 'dialog-answer', dialog: dialog.id, answer: a }).then(() => undefined);
    this.layer.replaceChildren(dialog.kind === 'message' ? messageBox(dialog, answer, dialogs.length - 1) : filePanel(dialog, answer, this.request, dialogs.length - 1));
    (this.layer.querySelector('[data-autofocus]') as HTMLElement | null)?.focus();
  }

  clear(): void {
    this.update([]);
  }
}

function note(dialog: AppDialog, more: number): HTMLElement {
  return h('span', { class: 'dlg__note' }, dialog.blocking ? t.appDialog.waits : t.appDialog.shownHere, h('span', { class: 'dlg__more faint' }, more > 0 ? ` · ${t.appDialog.more(more)}` : ''));
}

function messageBox(dialog: Extract<AppDialog, { kind: 'message' }>, answer: (a: AppDialogAnswer) => Promise<void>, more: number): HTMLElement {
  const labels = dialog.buttons.length ? dialog.buttons : [t.appDialog.ok];
  let checked = dialog.checkboxChecked;
  let busy = false;
  const error = h('p', { class: 'dlg__error', role: 'alert', hidden: true });
  const buttons = labels.map((label, i) => {
    const b = button(label, () => choose(i), { primary: i === dialog.defaultId, small: true });
    if (i === dialog.defaultId) b.dataset.autofocus = 'true';
    return b;
  });
  const choose = (response: number) => {
    if (busy) return;
    busy = true;
    buttons.forEach((b, i) => (b.disabled = i !== response));
    error.hidden = true;
    answer({ kind: 'message', response, checkboxChecked: checked }).catch((err) => {
      busy = false;
      buttons.forEach((b) => (b.disabled = false));
      error.textContent = errorText(err);
      error.hidden = false;
    });
  };
  const box = h(
    'div',
    { class: 'dlg', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': dialog.message || dialog.title || t.appDialog.message },
    h(
      'div',
      { class: 'dlg__body' },
      h('span', { class: `dlg__icon dlg__icon--${dialog.type}` }, icon(TYPE_ICONS[dialog.type] ?? 'info')),
      h(
        'div',
        { class: 'dlg__text' },
        h('p', { class: 'dlg__message' }, dialog.message || dialog.title || t.appDialog.message),
        dialog.title && dialog.message ? h('p', { class: 'dlg__title' }, dialog.title) : null,
        dialog.detail ? h('p', { class: 'dlg__detail' }, dialog.detail) : null,
        dialog.checkboxLabel
          ? h('label', { class: 'dlg__check' }, h('input', { type: 'checkbox', checked, onchange: (e: Event) => (checked = (e.target as HTMLInputElement).checked) }), dialog.checkboxLabel)
          : null,
      ),
    ),
    error,
    // The first button on the right, as on a Mac.
    h('div', { class: 'dlg__foot' }, note(dialog, more), h('div', { class: 'dlg__buttons' }, ...buttons)),
  );
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      choose(dialog.cancelId);
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      choose(dialog.defaultId);
    }
  });
  return box;
}

function filePanel(dialog: Extract<AppDialog, { kind: 'open' | 'save' }>, answer: (a: AppDialogAnswer) => Promise<void>, request: DialogRequest, more: number): HTMLElement {
  const save = dialog.kind === 'save';
  const props = new Set(dialog.properties);
  const multi = !save && props.has('multiSelections');
  const pickDirs = !save && props.has('openDirectory');
  const pickFiles = save || props.has('openFile') || !pickDirs;
  let folder: MacFolder | null = null;
  let selected: string[] = [];
  let filter = 0;
  let hidden = props.has('showHiddenFiles');
  let replace = false;
  let busy = false;

  const extensions = () => {
    const f = dialog.filters[filter];
    return f && f.extensions.length && !f.extensions.includes('*') ? f.extensions.map((x) => x.toLowerCase()) : null;
  };
  const fits = (entry: MacFolder['entries'][number]) => {
    if (entry.dir) return true;
    if (!pickFiles) return false;
    const ext = extensions();
    return !ext || ext.includes((entry.name.split('.').pop() ?? '').toLowerCase());
  };

  const error = h('p', { class: 'dlg__error', role: 'alert', hidden: true });
  const showError = (text: string | null) => {
    error.textContent = text ?? '';
    error.hidden = !text;
  };
  const nameInput = h('input', { class: 'input', spellcheck: false, oninput: () => setReplace(false) });
  const pathInput = h('input', { class: 'input', 'aria-label': t.appDialog.folderOnMac, spellcheck: false });
  pathInput.dataset.ownEnter = 'true';
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void open(pathInput.value);
    }
  });
  const up = button('', () => folder?.parent && void open(folder.parent), { icon: 'arrow-up', title: t.appDialog.up, small: true });
  const places = h('nav', { class: 'dlg__places', 'aria-label': t.appDialog.places });
  const list = h('div', { class: 'dlg__list', role: 'listbox', 'aria-label': t.appDialog.files, tabindex: '0' });
  if (multi) list.setAttribute('aria-multiselectable', 'true');
  const confirmButton = button(dialog.buttonLabel || (save ? t.appDialog.save : t.appDialog.open), () => confirm(), { primary: true, small: true });
  const setReplace = (on: boolean) => {
    replace = on;
    confirmButton.querySelector('span')!.textContent = on ? t.appDialog.replace : dialog.buttonLabel || (save ? t.appDialog.save : t.appDialog.open);
  };

  const renderList = () => {
    if (!folder) {
      list.replaceChildren(h('div', { class: 'dlg__empty' }, t.appDialog.loading));
      return;
    }
    const current = folder;
    places.replaceChildren(
      ...current.places.map((p) =>
        h('button', { type: 'button', class: `dlg__place${p.path === current.path ? ' is-on' : ''}`, onclick: () => void open(p.path) }, icon(p.name === 'Home' ? 'home' : p.name === 'Project' ? 'code' : 'folder'), h('span', { class: 'truncate' }, t.appDialog.place[p.name] ?? p.name)),
      ),
    );
    up.disabled = !current.parent;
    if (!current.entries.length) {
      list.replaceChildren(h('div', { class: 'dlg__empty' }, t.appDialog.empty));
      return;
    }
    list.replaceChildren(
      ...current.entries.map((entry) => {
        const on = selected.includes(entry.name);
        const row = h(
          'div',
          { class: `dlg__row${on ? ' is-selected' : ''}${fits(entry) ? '' : ' is-off'}`, role: 'option', 'aria-selected': String(on) },
          icon(entry.dir ? 'folder' : IMAGE.test(entry.name) ? 'file-media' : 'file'),
          h('span', { class: 'dlg__row-name truncate' }, entry.name),
          h('span', { class: 'dlg__row-meta' }, entry.dir ? '' : sizeText(entry.size)),
          h('span', { class: 'dlg__row-meta' }, entry.modified ? dateText.format(entry.modified) : ''),
        );
        row.addEventListener('click', (e) => pick(entry, e.ctrlKey || e.metaKey));
        row.addEventListener('dblclick', () => {
          if (entry.dir) void open(joinPath(current.path, entry.name));
          else if (fits(entry)) finish([joinPath(current.path, entry.name)]);
        });
        return row;
      }),
      ...(current.truncated ? [h('div', { class: 'dlg__empty' }, t.appDialog.truncated)] : []),
    );
  };

  const open = async (target: string, select?: string, showHidden = hidden): Promise<MacFolder | null> => {
    try {
      const next = (await request({ type: 'dialog-list', path: target, hidden: showHidden })) as MacFolder;
      folder = next;
      pathInput.value = next.path;
      selected = select ? [select] : [];
      setReplace(false);
      showError(null);
      renderList();
      return next;
    } catch (err) {
      showError(errorText(err));
      return null;
    }
  };

  const finish = (paths: string[]) => {
    if (busy) return;
    busy = true;
    answer({ kind: 'files', paths }).catch((err) => {
      busy = false;
      showError(errorText(err));
    });
  };

  const confirm = () => {
    const current = folder;
    if (!current) return;
    if (save) {
      let file = nameInput.value.trim();
      if (!file) return showError(t.appDialog.nameNeeded);
      if (file.includes('/')) return showError(t.appDialog.noSlash);
      const ext = extensions();
      if (ext && !/\.[^.]+$/.test(file)) file = `${file}.${ext[0]}`;
      if (current.entries.some((e) => e.name === file) && !replace) {
        setReplace(true);
        return showError(t.appDialog.exists(file));
      }
      return finish([joinPath(current.path, file)]);
    }
    const picks = selected.map((n) => current.entries.find((e) => e.name === n)).filter((e): e is NonNullable<typeof e> => Boolean(e));
    if (picks.length === 1 && picks[0]!.dir && !pickDirs) return void open(joinPath(current.path, picks[0]!.name));
    if (picks.length === 0) return pickDirs ? finish([current.path]) : showError(t.appDialog.pickFirst);
    finish(picks.filter((e) => fits(e) && (pickDirs || !e.dir)).map((e) => joinPath(current.path, e.name)));
  };

  const pick = (entry: MacFolder['entries'][number], add: boolean) => {
    if (save && !entry.dir) {
      nameInput.value = entry.name;
      setReplace(false);
      return;
    }
    if (!fits(entry)) return;
    selected = multi && add ? (selected.includes(entry.name) ? selected.filter((n) => n !== entry.name) : [...selected, entry.name]) : [entry.name];
    renderList();
  };

  list.addEventListener('keydown', (e) => {
    if (!folder || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const names = folder.entries.filter(fits).map((x) => x.name);
    const at = names.indexOf(selected[selected.length - 1] ?? '');
    const next = names[Math.max(0, Math.min(names.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      selected = [next];
      renderList();
    }
  });

  const filterSelect = dialog.filters.length > 1
    ? h(
        'select',
        {
          class: 'dlg__select',
          'aria-label': t.appDialog.fileType,
          onchange: (e: Event) => {
            filter = Number((e.target as HTMLSelectElement).value);
            selected = [];
            renderList();
          },
        },
        ...dialog.filters.map((f, i) => h('option', { value: String(i) }, f.name || (f.extensions.includes('*') ? t.appDialog.allFiles : f.extensions.join(', ')))),
      )
    : null;
  const hiddenBox = h('input', {
    type: 'checkbox',
    checked: hidden,
    onchange: (e: Event) => {
      hidden = (e.target as HTMLInputElement).checked;
      if (folder) void open(folder.path, undefined, hidden);
    },
  });
  // New folder: a button that turns into a name field (no browser prompts in a webview).
  const newFolderSlot = h('span', { class: 'dlg__newfolder' });
  const showNewFolderButton = () => newFolderSlot.replaceChildren(button(t.appDialog.newFolder, showNewFolderField, { icon: 'new-folder', small: true }));
  const showNewFolderField = () => {
    const field = h('input', { class: 'input', value: t.appDialog.untitledFolder, 'aria-label': t.appDialog.newFolderName });
    field.dataset.ownEnter = 'true';
    const create = async () => {
      const name = field.value.trim().replace(/\//g, ':');
      if (!name || !folder) return;
      try {
        await request({ type: 'dialog-mkdir', path: joinPath(folder.path, name) });
        showNewFolderButton();
        await open(folder.path, name);
      } catch (err) {
        showError(errorText(err));
      }
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void create();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        showNewFolderButton();
      }
    });
    newFolderSlot.replaceChildren(field, button(t.appDialog.create, () => void create(), { small: true }));
    field.select();
    field.focus();
  };
  if (save || props.has('createDirectory')) showNewFolderButton();
  const newFolderButton = save || props.has('createDirectory') ? newFolderSlot : null;

  const heading = dialog.title || (save ? t.appDialog.save : pickDirs && !props.has('openFile') ? t.appDialog.chooseFolder : t.appDialog.open);
  const panel = h(
    'div',
    { class: 'dlg dlg--files', role: 'dialog', 'aria-modal': 'true', 'aria-label': heading },
    h('div', { class: 'dlg__head' }, h('span', { class: 'dlg__heading' }, heading), dialog.message ? h('span', { class: 'dlg__sub' }, dialog.message) : null),
    save ? h('label', { class: 'dlg__name' }, h('span', null, dialog.nameFieldLabel || t.appDialog.saveAs), nameInput) : null,
    h('div', { class: 'dlg__browser' }, places, h('div', { class: 'dlg__main' }, h('div', { class: 'dlg__pathbar' }, up, pathInput), list)),
    h('div', { class: 'dlg__opts' }, filterSelect, h('label', { class: 'dlg__check' }, hiddenBox, t.appDialog.showHidden), newFolderButton),
    error,
    h('div', { class: 'dlg__foot' }, note(dialog, more), h('div', { class: 'dlg__buttons' }, confirmButton, button(t.appDialog.cancel, () => finish([]), { small: true }))),
  );
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish([]);
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !(e.target as HTMLElement).dataset.ownEnter) {
      e.preventDefault();
      confirm();
    }
  });
  (save ? nameInput : list).dataset.autofocus = 'true';
  renderList();
  // Saving: the suggested name in its folder. Opening: the suggested folder, else the project's.
  void (async () => {
    const first = await open(dialog.defaultPath || dialog.project || '~');
    if (!first) {
      await open('~');
      return;
    }
    if (save && dialog.defaultPath && first.path !== dialog.defaultPath.replace(/\/+$/, '')) nameInput.value = baseName(dialog.defaultPath);
  })();
  return panel;
}
