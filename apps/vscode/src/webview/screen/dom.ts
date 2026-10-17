/** A small element builder for the webview (no framework: the page stays light). */
type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'style') {
        if (typeof value === 'string') el.setAttribute('style', value);
        else Object.assign(el.style, value);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      else if (key in el && typeof value !== 'string') (el as unknown as Record<string, unknown>)[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** A codicon (VS Code's icon font, loaded by the page). */
export function icon(name: string, extra = ''): HTMLSpanElement {
  return h('span', { class: `codicon codicon-${name}${extra ? ` ${extra}` : ''}`, 'aria-hidden': 'true' });
}

export function button(label: string, onClick: () => void, opts: { icon?: string; primary?: boolean; title?: string; small?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: `btn${opts.primary ? ' btn--primary' : ''}${opts.small ? ' btn--small' : ''}${opts.icon && !label ? ' btn--icon' : ''}`, title: opts.title ?? (label || undefined), 'aria-label': opts.title ?? label, disabled: opts.disabled, onclick: onClick },
    opts.icon ? icon(opts.icon) : null,
    label ? h('span', null, label) : null,
  );
}
