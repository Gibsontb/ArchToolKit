/**
 * "Import the old portfolio": the retired Migration page's applications, into
 * the plan (addendum A.1.5).
 *
 * The old page's portfolio is still in this browser (IndexedDB store
 * `portfolio`, which nothing here ever deletes), and its file contract
 * `archtoolkit.migration-portfolio` v1 (and the CSV) still imports. Either
 * way the entries go through WP-2's portfolio adapter and are merged into the
 * plan by name, so an app already in the plan keeps what was typed into it.
 *
 * The Sources pane puts this first; it lives here so the pane's owner can
 * reuse it as it is.
 */

import { el, append, clear, readFileAsText } from './dom.ts';
import { findingsList } from './components.ts';
import type { Finding } from '../core/findings.ts';
import { importCsv, importJson, loadPortfolio } from '../migration/portfolio.ts';
import type { PortfolioEntry } from '../migration/types.ts';
import { intakeFromPortfolio } from '../multicloud/plan/intake/from-portfolio.ts';
import { mergeIntake } from '../multicloud/plan/intake/merge.ts';
import type { Plan } from '../multicloud/plan/types.ts';
import type { PlanSession } from './plan-sync.ts';

/** The plan with the portfolio's apps merged in (by name; edited cells kept). */
export function planWithPortfolio(plan: Plan, entries: readonly PortfolioEntry[]): { plan: Plan; findings: readonly Finding[]; added: number } {
  const result = intakeFromPortfolio(entries);
  const merged = mergeIntake(plan, result, 'merge');
  return { plan: { ...plan, ...merged }, findings: result.findings, added: merged.apps.length - plan.apps.length };
}

/** A portfolio file (the old page's JSON export, or its CSV) as entries. */
export function portfolioFromFile(text: string, name: string): { entries: readonly PortfolioEntry[]; findings: readonly Finding[] } {
  const csv = /\.csv$/i.test(name) || (!/^\s*[[{]/.test(text) && text.includes(','));
  return csv ? importCsv(text) : importJson(text);
}

export function portfolioImportCard(session: PlanSession): HTMLElement {
  const out = el('div', { attrs: { 'data-control': 'portfolio-result' } });
  const apply = (entries: readonly PortfolioEntry[], extra: readonly Finding[]) => {
    const { plan, findings, added } = planWithPortfolio(session.plan(), entries);
    session.update(() => plan, { immediate: true });
    clear(out);
    append(
      out,
      el('p', { class: 'small', text: `${entries.length} portfolio entr${entries.length === 1 ? 'y' : 'ies'} read; ${added} new application${added === 1 ? '' : 's'} added to the plan.` }),
      findingsList([...extra, ...findings], 'Nothing to report.'),
    );
  };

  const picker = el('input', { attrs: { type: 'file', accept: '.json,.csv,application/json,text/csv', hidden: 'hidden', 'data-control': 'portfolio-file' } }) as HTMLInputElement;
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    void readFileAsText(file).then((text) => {
      try {
        const read = portfolioFromFile(text, file.name);
        apply(read.entries, read.findings);
      } catch (error) {
        clear(out);
        append(out, el('p', { class: 'small', text: `Not imported — ${(error as Error).message}` }));
      }
    });
  });

  return el(
    'div',
    { class: 'stack' },
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary',
        text: 'Import the old portfolio',
        attrs: { type: 'button', 'data-control': 'portfolio-import', title: 'The applications the retired Migration page kept in this browser' },
        on: { click: () => void loadPortfolio().then((entries) => apply(entries, [])) },
      }),
      el('button', {
        class: 'btn',
        text: 'Import a portfolio file…',
        attrs: { type: 'button', title: 'A portfolio exported from the retired Migration page (JSON or CSV)' },
        on: { click: () => picker.click() },
      }),
      picker,
    ),
    out,
  );
}
