/**
 * Shared presentational components.
 *
 * These render the vocabulary the whole toolkit shares: findings, stats,
 * provenance badges. Keeping them here means a sizing result and a migration
 * assessment look like the same product.
 */

import { el, append,            } from './dom.js';
                                                             
import { sortFindings } from '../core/findings.js';
import { formatCount } from '../core/units.js';
                                                         
import { VERIFICATION_LABELS, isAuthoritative } from '../vcf/provenance.js';

const SEVERITY_ICON                           = {
  error: '✕',
  warning: '!',
  info: 'i',
};

export function findingItem(finding         )              {
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

export function findingsList(findings                    , emptyMessage = 'No issues found.')              {
  if (findings.length === 0) {
    return el('div', { class: 'empty', text: emptyMessage });
  }
  const wrap = el('div', { class: 'findings' });
  for (const finding of sortFindings(findings)) append(wrap, findingItem(finding));
  return wrap;
}

                                                            

                              
                         
                                  
                        
                           
                                                             
                         
 

export function stat(options             )              {
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

export function statGrid(...stats               )              {
  return el('div', { class: 'stat-grid' }, ...stats);
}

/**
 * Provenance badge.
 *
 * This is the toolkit's differentiator: a user can always see whether a number
 * came from Broadcom or from a blog post.
 */
export function verificationBadge(verification              )              {
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

                            
                          
                                     
                                                       
                             
 

export function table   (columns                      , rows              )              {
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

export function card(title        , ...children         )              {
  return el(
    'section',
    { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: title })),
    ...children,
  );
}

export function field(label        , control             , hint         )              {
  const wrap = el('div', { class: 'field' });
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  append(wrap, el('label', { text: label, attrs: { for: id } }), control);
  if (hint) append(wrap, el('div', { class: 'field-hint', text: hint }));
  return wrap;
}

export function numberInput(value        , attrs                                  = {})                   {
  return el('input', {
    attrs: { type: 'number', value: String(value), ...attrs },
  })                    ;
}

export function select                  (
  options                                        ,
  selected   ,
)                    {
  const node = el('select')                     ;
  for (const option of options) {
    const opt = el('option', { text: option.label, attrs: { value: option.value } });
    if (option.value === selected) opt.selected = true;
    node.appendChild(opt);
  }
  return node;
}

export function checkbox(label        , checked         )                                                 {
  const input = el('input', { attrs: { type: 'checkbox' } })                    ;
  input.checked = checked;
  const wrap = el('label', { class: 'checkbox' }, input, el('span', { text: label }));
  return { wrap, input };
}
