/**
 * Minimal DOM helpers.
 *
 * There is no framework here, so this provides the two things a framework
 * mainly buys you: terse element construction, and safe text interpolation.
 * Everything goes through textContent rather than innerHTML, so imported
 * inventory data can never inject markup.
 */

export type Child = Node | string | number | null | undefined | false;

export interface ElementOptions {
  readonly class?: string;
  readonly id?: string;
  readonly text?: string | number;
  readonly html?: never;
  readonly attrs?: Record<string, string | number | boolean | null | undefined>;
  readonly dataset?: Record<string, string>;
  readonly on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
  readonly style?: Partial<CSSStyleDeclaration>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (options.class) node.className = options.class;
  if (options.id) node.id = options.id;
  if (options.text !== undefined) node.textContent = String(options.text);

  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      node.dataset[key] = value;
    }
  }

  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      if (handler) node.addEventListener(event, handler as EventListener);
    }
  }

  if (options.style) Object.assign(node.style, options.style);

  append(node, ...children);
  return node;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Node, ...children: Child[]): void {
  clear(node);
  append(node, ...children);
}

/** Query a required element, throwing a useful error when the markup drifts. */
export function must<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Required element not found: ${selector}`);
  return found;
}

export function maybe<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T | null {
  return root.querySelector<T>(selector);
}

export function allOf<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** Trigger a client-side file download without a server round trip. */
export function downloadFile(filename: string, contents: string | Uint8Array, mime = 'application/json'): void {
  const blob =
    typeof contents === 'string'
      ? new Blob([contents], { type: `${mime};charset=utf-8` })
      : new Blob([contents as Uint8Array<ArrayBuffer>], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { attrs: { href: url, download: filename } });
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next tick; revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a user-selected file as text. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsText(file);
  });
}
