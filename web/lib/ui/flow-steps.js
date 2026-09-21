/**
 * The VCF path, in order: what is there, what it must become, the document
 * that builds it.
 *
 * Inventory, sizing and the spec builder are three pages but one job, and the
 * estate carries from each to the next on its own. This strip at the top of
 * all three says so — where you are, what comes next, and one click to it.
 */

import { el } from './dom.js';

                                                       

const STEPS                                                                         = [
  { id: 'inventory', label: 'VMware inventory', href: 'inventory.html', hint: 'Import the RVTools export' },
  { id: 'sizing', label: 'VCF sizing', href: 'vcf-sizing.html', hint: 'Plan the domains and hosts' },
  { id: 'spec', label: 'VCF spec builder', href: 'vcf-spec.html', hint: 'Write the bring-up document' },
];

export function mountFlowSteps(root             , current          )       {
  const index = STEPS.findIndex((s) => s.id === current);
  const next = STEPS[index + 1];
  const strip = el(
    'nav',
    { class: 'flow-steps', attrs: { 'aria-label': 'VCF path' } },
    el(
      'ol',
      {},
      ...STEPS.map((step, i) =>
        el(
          'li',
          { class: i === index ? 'is-current' : i < index ? 'is-done' : '' },
          el(
            'a',
            { attrs: { href: step.href, ...(i === index ? { 'aria-current': 'step' } : {}) } },
            el('span', { class: 'flow-number', text: String(i + 1) }),
            el('span', { class: 'flow-label', text: step.label }),
            el('span', { class: 'flow-hint', text: step.hint }),
          ),
        ),
      ),
    ),
    next ? el('a', { class: 'btn btn-primary btn-small flow-next', text: `Next: ${next.label} →`, attrs: { href: next.href } }) : null,
  );
  root.prepend(strip);
}
