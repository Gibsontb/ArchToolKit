/**
 * Shared presentational components.
 *
 * These render the vocabulary the whole toolkit shares: findings, stats,
 * provenance badges. Keeping them here means a sizing result and a migration
 * assessment look like the same product.
 */

import { el, append, type Child } from './dom.ts';
import type { Finding, Severity } from '../core/findings.ts';
import { sortFindings } from '../core/findings.ts';
import { formatCount } from '../core/units.ts';
import type { Verification } from '../vcf/provenance.ts';
import { VERIFICATION_LABELS, isAuthoritative } from '../vcf/provenance.ts';

const SEVERITY_ICON: Record<Severity, string> = {
  error: '✕',
  warning: '!',
  info: 'i',
};

export function findingItem(finding: Finding): HTMLElement {
  const body = el('div', {});

  append(body, el('div', { class: 'finding-message', text: finding.message }));

  if (finding.remediation || finding.path) {
    const meta = el('div', { class: 'finding-meta' });
    if (finding.path) {
      append(meta, el('code', { text: finding.path }));
      if (finding.remediation) append(meta, ' — ');
    }
    if (finding.remediation) append(meta, finding.remediation);
    append(body, meta);
  }

  if (finding.source) {
    append(body, el('div', { class: 'finding-source', text: `Source: ${finding.source}` }));
  }

  return el(
    'div',
    { class: `finding is-${finding.severity}` },
    el('div', { class: 'finding-icon', text: SEVERITY_ICON[finding.severity] }),
    body,
  );
}

export function findingsList(findings: readonly Finding[], emptyMessage = 'No issues found.'): HTMLElement {
  if (findings.length === 0) {
    return el('div', { class: 'empty', text: emptyMessage });
  }
  const wrap = el('div', { class: 'findings' });
  for (const finding of sortFindings(findings)) append(wrap, findingItem(finding));
  return wrap;
}

export type StatTone = 'neutral' | 'ok' | 'warn' | 'danger';

export interface StatOptions {
  readonly label: string;
  readonly value: string | number;
  readonly sub?: string;
  readonly tone?: StatTone;
  /** 0-1; renders a meter beneath the value when present. */
  readonly fill?: number;
}

export function stat(options: StatOptions): HTMLElement {
  const tone = options.tone ?? 'neutral';
  const node = el(
    'div',
    { class: tone === 'neutral' ? 'stat' : `stat is-${tone}` },
    el('div', { class: 'stat-label', text: options.label }),
    el('div', {
      class: 'stat-value',
      text: typeof options.value === 'number' ? formatCount(options.value) : options.value,
    }),
  );

  if (options.sub) append(node, el('div', { class: 'stat-sub', text: options.sub }));

  if (options.fill !== undefined && Number.isFinite(options.fill)) {
    const pct = Math.max(0, Math.min(1, options.fill)) * 100;
    const fillClass =
      options.fill > 1 ? 'meter-fill is-danger' : options.fill > 0.8 ? 'meter-fill is-warn' : 'meter-fill';
    append(
      node,
      el('div', { class: 'meter' }, el('div', { class: fillClass, style: { width: `${pct}%` } })),
    );
  }

  return node;
}

export function statGrid(...stats: HTMLElement[]): HTMLElement {
  return el('div', { class: 'stat-grid' }, ...stats);
}

/**
 * Provenance badge.
 *
 * This is the toolkit's differentiator: a user can always see whether a number
 * came from Broadcom or from a blog post.
 */
export function verificationBadge(verification: Verification): HTMLElement {
  const cls = isAuthoritative(verification)
    ? 'badge badge-verified'
    : verification === 'C'
      ? 'badge badge-community'
      : 'badge badge-inferred';
  const label = isAuthoritative(verification)
    ? 'Verified'
    : verification === 'C'
      ? 'Community'
      : 'Inferred';
  return el('span', {
    class: cls,
    text: label,
    attrs: { title: VERIFICATION_LABELS[verification] },
  });
}

export interface Column<T> {
  readonly header: string;
  readonly render: (row: T) => Child;
  /** Right-align and tabular-align numeric columns. */
  readonly numeric?: boolean;
}

export function table<T>(columns: readonly Column<T>[], rows: readonly T[]): HTMLElement {
  const head = el(
    'tr',
    {},
    ...columns.map((c) => el('th', { class: c.numeric ? 'num' : undefined, text: c.header })),
  );

  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const column of columns) {
      append(tr, el('td', { class: column.numeric ? 'num' : undefined }, column.render(row)));
    }
    append(body, tr);
  }

  return el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, head), body));
}

export function card(title: string, ...children: Child[]): HTMLElement {
  return el(
    'section',
    { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: title })),
    ...children,
  );
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', { class: 'field' });
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  append(wrap, el('label', { text: label, attrs: { for: id } }), control);
  if (hint) append(wrap, el('div', { class: 'field-hint', text: hint }));
  return wrap;
}

export function numberInput(value: number, attrs: Record<string, string | number> = {}): HTMLInputElement {
  return el('input', {
    attrs: { type: 'number', value: String(value), ...attrs },
  }) as HTMLInputElement;
}

export function select<T extends string>(
  options: readonly { value: T; label: string }[],
  selected: T,
): HTMLSelectElement {
  const node = el('select') as HTMLSelectElement;
  for (const option of options) {
    const opt = el('option', { text: option.label, attrs: { value: option.value } });
    if (option.value === selected) opt.selected = true;
    node.appendChild(opt);
  }
  return node;
}

export function checkbox(label: string, checked: boolean): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
  input.checked = checked;
  const wrap = el('label', { class: 'checkbox' }, input, el('span', { text: label }));
  return { wrap, input };
}
