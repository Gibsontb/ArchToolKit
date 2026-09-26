/**
 * Small DOM pieces the Application Migration panes share: dropdowns from
 * option lists, buttons, tables, chips, the [U] / [C] fact badge, and the
 * plan watcher that redraws a pane when the plan changes while it is visible
 * (and not for the pane's own keystrokes, so a field keeps its focus).
 */

import { el, append, clear, type Child } from '../dom.ts';
import { control, fillOptions } from '../blueprint-form.ts';
import type { BlueprintInput, SelectOption } from '../../kit/blueprint.ts';
import type { App, AppPlan, AppRecommendation, Plan, Platform, Verification } from '../../multicloud/plan/types.ts';
import { verificationBadge } from '../../multicloud/plan/patterns/index.ts';
import type { PaneContext } from '../plan-shell.ts';

export type EditOptions = { readonly immediate?: boolean; readonly redraw?: boolean };

export interface Watcher {
  /** Change the plan; the pane is not redrawn unless `redraw` is set. */
  edit(change: (plan: Plan) => Plan, options?: EditOptions): void;
  /** Draw now (when visible) or at the next time it is shown. */
  redraw(): void;
}

/**
 * Redraw `draw` after the plan changes (debounced), only while `root` is on
 * screen; a hidden pane is marked stale and drawn when it is shown again.
 * The pane's own edits do not redraw it unless asked.
 */
export function watchPlan(root: HTMLElement, ctx: PaneContext, draw: () => void, delay = 250): Watcher {
  let own = 0;
  let stale = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => root.isConnected && root.offsetParent !== null;
  const run = () => {
    timer = undefined;
    if (!visible()) {
      stale = true;
      return;
    }
    stale = false;
    draw();
  };
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, delay);
  };
  ctx.session.subscribe((_plan, kind) => {
    if (kind === 'saved') return;
    if (own > 0 && kind === 'edit') return;
    schedule();
  });
  const check = () => {
    if (stale && visible()) run();
  };
  globalThis.addEventListener?.('hashchange', () => setTimeout(check, 0));
  globalThis.document?.addEventListener('click', () => setTimeout(check, 0), true);
  return {
    edit(change, options) {
      own += 1;
      try {
        ctx.session.update(change, options?.immediate ? { immediate: true } : undefined);
      } finally {
        own -= 1;
      }
      if (options?.redraw) run();
    },
    redraw: run,
  };
}

/** What a workspace tab is handed. */
export interface AppView {
  readonly ctx: PaneContext;
  readonly app: App;
  /** The plan as it was when the tab was drawn. */
  readonly plan: Plan;
  readonly appPlan: AppPlan;
  readonly rec: AppRecommendation;
  /** The platform the app is shown on (its choice, else its recommendation). */
  readonly platform: Platform;
  /** The plan as it is now (after edits made since drawing). */
  current(): Plan;
  edit(change: (plan: Plan) => Plan, options?: EditOptions): void;
  redraw(): void;
  /** Open another workspace tab of this app. */
  go(tab: string): void;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function dropdown(options: readonly SelectOption[], value: string, onChange: (value: string) => void, extra: { readonly blank?: string; readonly control?: string; readonly label?: string } = {}): HTMLSelectElement {
  const node = el('select', { attrs: { ...(extra.control ? { 'data-control': extra.control } : {}), ...(extra.label ? { 'aria-label': extra.label } : {}) }, style: { minWidth: '7rem' } }) as HTMLSelectElement;
  fillOptions(node, extra.blank !== undefined ? [{ value: '', label: extra.blank }, ...options] : options, value);
  if (extra.blank === undefined && !options.some((o) => o.value === value) && options[0]) node.value = options[0].value;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

/** A combo (a dropdown with "Other — type a value…"), the form's own control. */
export function combo(options: readonly SelectOption[], value: string, onChange: (value: string) => void, label: string): HTMLElement {
  const input: BlueprintInput = { id: 'v', label, control: 'combo', options, blankLabel: '(none)' };
  const node = control(input, value, () => onChange(comboValue(node)));
  node.setAttribute('aria-label', label);
  return node;
}

function comboValue(node: HTMLElement): string {
  const select = node.querySelector('select') as HTMLSelectElement | null;
  const box = node.querySelector('input') as HTMLInputElement | null;
  if (!select) return '';
  return select.value === '__custom__' ? (box?.value ?? '').trim() : select.value;
}

export function button(text: string, onClick: () => void, extra: { readonly primary?: boolean; readonly small?: boolean; readonly control?: string; readonly disabled?: boolean; readonly title?: string } = {}): HTMLButtonElement {
  const node = el('button', {
    class: ['btn', extra.primary ? 'btn-primary' : '', extra.small ? 'btn-small' : ''].filter(Boolean).join(' '),
    text,
    attrs: { type: 'button', ...(extra.control ? { 'data-control': extra.control } : {}), ...(extra.disabled ? { disabled: true } : {}), ...(extra.title ? { title: extra.title } : {}) },
  }) as HTMLButtonElement;
  node.addEventListener('click', onClick);
  return node;
}

export function buttonRow(...children: Child[]): HTMLElement {
  return el('div', { class: 'btn-row', style: { flexWrap: 'wrap' } }, ...children);
}

export function textInput(value: string, onChange: (value: string) => void, extra: { readonly placeholder?: string; readonly control?: string; readonly label?: string; readonly type?: string; readonly onInput?: boolean } = {}): HTMLInputElement {
  const node = el('input', {
    attrs: {
      type: extra.type ?? 'text',
      ...(extra.placeholder ? { placeholder: extra.placeholder } : {}),
      ...(extra.control ? { 'data-control': extra.control } : {}),
      ...(extra.label ? { 'aria-label': extra.label } : {}),
    },
    style: { minWidth: '6rem' },
  }) as HTMLInputElement;
  node.value = value;
  node.addEventListener(extra.onInput ? 'input' : 'change', () => onChange(node.value));
  return node;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function rowsTable(headers: readonly string[], rows: readonly (readonly Child[])[], options: { readonly numeric?: readonly number[]; readonly control?: string; readonly empty?: string } = {}): HTMLElement {
  if (rows.length === 0 && options.empty) return el('div', { class: 'empty', text: options.empty, attrs: options.control ? { 'data-control': options.control } : {} });
  const numeric = new Set(options.numeric ?? []);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    row.forEach((cell, i) => append(tr, el('td', { class: numeric.has(i) ? 'num' : undefined }, cell)));
    append(body, tr);
  }
  return el(
    'div',
    { class: 'table-wrap', attrs: options.control ? { 'data-control': options.control } : {} },
    el('table', {}, el('thead', {}, el('tr', {}, ...headers.map((h, i) => el('th', { class: numeric.has(i) ? 'num' : undefined, text: h })))), body),
  );
}

export type Tone = 'good' | 'warn' | 'danger' | 'neutral';

export function chip(text: string, tone: Tone = 'neutral', title?: string): HTMLElement {
  return el('span', { class: tone === 'neutral' ? 'badge' : `badge ${tone}`, text, attrs: title ? { title } : {} });
}

/** The [U] / [C] mark of a fact that is not verified from the vendor's own documentation; nothing for a verified one. */
export function factBadge(v: Verification | undefined, source?: string): HTMLElement | null {
  if (!v) return null;
  const mark = verificationBadge(v);
  if (!mark) return null;
  return el('span', {
    class: mark === '[U]' ? 'badge danger' : 'badge warn',
    text: mark,
    attrs: { title: `${mark === '[U]' ? 'Unverified (inferred)' : 'Community source'}${source ? `: ${source}` : ''}`, 'data-control': 'fact-badge' },
  });
}

/** A source link, shortened to its host. */
export function sourceLink(url: string | undefined): HTMLElement | null {
  if (!url) return null;
  const first = url.split(' ; ')[0]!.trim();
  let host = first;
  try {
    host = new URL(first).host;
  } catch {
    return el('span', { class: 'small muted', text: first });
  }
  return el('a', { class: 'small', text: host, attrs: { href: first, target: '_blank', rel: 'noopener noreferrer' } });
}

export function note(text: string, control?: string): HTMLElement {
  return el('p', { class: 'small muted', text, attrs: control ? { 'data-control': control } : {} });
}

export function subhead(text: string): HTMLElement {
  return el('h3', { text, style: { margin: 'var(--space-4) 0 var(--space-2)', fontSize: '1rem' } });
}

export function fill(node: HTMLElement, ...children: Child[]): void {
  clear(node);
  append(node, ...children);
}

/** A labelled inline control for filter rows. */
export function labelled(label: string, node: HTMLElement): HTMLElement {
  return el('label', { class: 'field', style: { minWidth: '9rem', flex: '1 1 10rem', margin: '0' } }, el('span', { class: 'small muted', text: label }), node);
}

export function filterRow(...children: Child[]): HTMLElement {
  return el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end', marginBottom: 'var(--space-3)' } }, ...children);
}

/** Save bytes as a file. */
export function saveBytes(name: string, bytes: Uint8Array, mime = 'application/zip'): void {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: name } });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Today (yyyy-mm-dd) for EOL judgements: the plan's savedAt date when there is one. */
export function judgedOn(plan: Pick<Plan, 'savedAt'>): string {
  const d = new Date(plan.savedAt);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}
