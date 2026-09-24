/**
 * ArchPad's dialogs: a promise-based modal (prompt, confirm with three
 * answers, pick from a list, small forms) built on <dialog>.
 *
 * window.prompt/confirm are avoided on purpose: WebView2 shows them with a
 * browser-looking frame, they block the event loop (autosave stops), and they
 * cannot offer "Save / Don't Save / Cancel".
 */

import { el, type Child } from '../ui/dom.ts';

export interface DialogButton<T> {
  readonly label: string;
  readonly value: T;
  readonly primary?: boolean;
  readonly danger?: boolean;
}

export interface DialogOptions<T> {
  readonly title: string;
  readonly body: Child | Child[];
  readonly buttons: readonly DialogButton<T>[];
  /** Resolved value for Escape / the close box. */
  readonly cancelValue: T;
  /** Where the dialog lives, so it inherits ArchPad's theme variables. */
  readonly host: HTMLElement;
  readonly wide?: boolean;
  /** Called before resolving with a primary button; return false to keep the dialog open. */
  readonly validate?: (value: T) => boolean;
}

export function openDialog<T>(options: DialogOptions<T>): Promise<T> {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: `ap-dialog${options.wide ? ' ap-dialog-wide' : ''}`, attrs: { 'aria-label': options.title } }) as HTMLDialogElement;
    let done = false;
    const finish = (value: T): void => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const body = el('div', { class: 'ap-dialog-body' }, ...(Array.isArray(options.body) ? options.body : [options.body]));
    const buttons = el(
      'div',
      { class: 'ap-dialog-buttons' },
      ...options.buttons.map((b) =>
        el('button', {
          class: `ap-btn${b.primary ? ' ap-btn-primary' : ''}${b.danger ? ' ap-btn-danger' : ''}`,
          text: b.label,
          attrs: { type: 'button' },
          on: {
            click: () => {
              if (options.validate && !options.validate(b.value)) return;
              finish(b.value);
            },
          },
        }),
      ),
    );
    dialog.append(
      el(
        'div',
        { class: 'ap-dialog-head' },
        el('strong', { text: options.title }),
        el('button', { class: 'ap-x', text: '×', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => finish(options.cancelValue) } }),
      ),
      body,
      buttons,
    );
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(options.cancelValue);
    });
    dialog.addEventListener('keydown', (e) => {
      // Enter in a single-line field presses the primary button.
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !e.isComposing) {
        const primary = options.buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          if (options.validate && !options.validate(primary.value)) return;
          finish(primary.value);
        }
      }
      e.stopPropagation();
    });
    options.host.appendChild(dialog);
    dialog.showModal();
    const focus = body.querySelector<HTMLElement>('input, select, textarea') ?? buttons.querySelector<HTMLElement>('.ap-btn-primary');
    focus?.focus();
    if (focus instanceof HTMLInputElement) focus.select();
  });
}

export async function promptDialog(host: HTMLElement, title: string, label: string, initial = ''): Promise<string | null> {
  const input = el('input', { class: 'ap-input', attrs: { type: 'text', spellcheck: 'false' } }) as HTMLInputElement;
  input.value = initial;
  const ok = await openDialog({
    host,
    title,
    body: [el('label', { class: 'ap-field' }, el('span', { text: label }), input)],
    buttons: [
      { label: 'OK', value: true, primary: true },
      { label: 'Cancel', value: false },
    ],
    cancelValue: false,
  });
  return ok ? input.value : null;
}

export function messageDialog(host: HTMLElement, title: string, message: Child | Child[]): Promise<void> {
  return openDialog({ host, title, body: message, buttons: [{ label: 'OK', value: undefined, primary: true }], cancelValue: undefined });
}

export function confirmDialog(host: HTMLElement, title: string, message: string, okLabel = 'OK'): Promise<boolean> {
  return openDialog({
    host,
    title,
    body: el('p', { text: message }),
    buttons: [
      { label: okLabel, value: true, primary: true },
      { label: 'Cancel', value: false },
    ],
    cancelValue: false,
  });
}

export type SaveChoice = 'save' | 'discard' | 'cancel';

/** Notepad++'s "Save file?" question. */
export function saveChangesDialog(host: HTMLElement, name: string): Promise<SaveChoice> {
  return openDialog<SaveChoice>({
    host,
    title: 'Save',
    body: el('p', { text: `Save changes to "${name}"?` }),
    buttons: [
      { label: 'Save', value: 'save', primary: true },
      { label: "Don't Save", value: 'discard', danger: true },
      { label: 'Cancel', value: 'cancel' },
    ],
    cancelValue: 'cancel',
  });
}

/** Pick one of several items; null when cancelled. */
export async function pickDialog<T>(host: HTMLElement, title: string, label: string, items: readonly { label: string; value: T }[], selected = 0): Promise<T | null> {
  const select = el('select', { class: 'ap-input', attrs: { size: Math.min(12, Math.max(4, items.length)) } }, ...items.map((it, i) => el('option', { text: it.label, attrs: { value: String(i) } }))) as HTMLSelectElement;
  select.selectedIndex = Math.max(0, Math.min(items.length - 1, selected));
  select.addEventListener('dblclick', () => (select.closest('dialog')?.querySelector('.ap-btn-primary') as HTMLButtonElement | null)?.click());
  const ok = await openDialog({
    host,
    title,
    body: [el('label', { class: 'ap-field' }, el('span', { text: label }), select)],
    buttons: [
      { label: 'OK', value: true, primary: true },
      { label: 'Cancel', value: false },
    ],
    cancelValue: false,
  });
  return ok && select.selectedIndex >= 0 ? items[select.selectedIndex]!.value : null;
}

/** A labelled row for form dialogs. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el('label', { class: 'ap-field' }, el('span', { text: label }), control, hint ? el('small', { class: 'ap-hint', text: hint }) : null);
}

export function textInput(value = '', attrs: Record<string, string | number> = {}): HTMLInputElement {
  const input = el('input', { class: 'ap-input', attrs: { type: 'text', spellcheck: 'false', ...attrs } }) as HTMLInputElement;
  input.value = value;
  return input;
}

export function checkbox(label: string, checked = false): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
  input.checked = checked;
  return { row: el('label', { class: 'ap-check' }, input, el('span', { text: label })), input };
}

export function radioGroup<T extends string>(name: string, options: readonly { label: string; value: T }[], selected: T): { row: HTMLElement; value: () => T } {
  const inputs = options.map((o) => {
    const input = el('input', { attrs: { type: 'radio', name, value: o.value } }) as HTMLInputElement;
    input.checked = o.value === selected;
    return { input, row: el('label', { class: 'ap-check' }, input, el('span', { text: o.label })) };
  });
  return {
    row: el('div', { class: 'ap-radios' }, ...inputs.map((i) => i.row)),
    value: () => (inputs.find((i) => i.input.checked)?.input.value as T | undefined) ?? selected,
  };
}

export function selectInput<T extends string>(options: readonly { label: string; value: T }[], selected: T): HTMLSelectElement {
  const select = el('select', { class: 'ap-input' }, ...options.map((o) => el('option', { text: o.label, attrs: { value: o.value } }))) as HTMLSelectElement;
  select.value = selected;
  return select;
}
