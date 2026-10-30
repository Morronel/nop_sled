// Minimal DOM helpers. No framework: screens rebuild their DOM from state.

export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Text with `backtick` spans rendered as <code>. */
export function rich(text: string): Child[] {
  return text.split(/(`[^`]+`)/).map((part) => (part.startsWith('`') && part.endsWith('`') ? h('code', null, part.slice(1, -1)) : part));
}

export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

export function button(label: Child, onclick: () => void, cls = '', extra: Props = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn ${cls}`.trim(), onclick, ...extra }, label);
}
