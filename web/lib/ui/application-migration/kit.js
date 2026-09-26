/**
 * Small DOM pieces the Application Migration panes share: dropdowns from
 * option lists, buttons, tables, chips, the [U] / [C] fact badge, and the
 * plan watcher that redraws a pane when the plan changes while it is visible
 * (and not for the pane's own keystrokes, so a field keeps its focus).
 */

import { el, append, clear,            } from '../dom.js';
import { control, fillOptions } from '../blueprint-form.js';
                                                                           
                                                                                                                    
import { verificationBadge } from '../../multicloud/plan/patterns/index.js';
                                                    

                                                                                      

                          
                                                                         
                                                                  
                                                                 
                 
 

/**
 * Redraw `draw` after the plan changes (debounced), only while `root` is on
 * screen; a hidden pane is marked stale and drawn when it is shown again.
 * The pane's own edits do not redraw it unless asked.
 */
export function watchPlan(root             , ctx             , draw            , delay = 250)          {
  let own = 0;
  let stale = false;
  let timer                                           ;
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
                          
                            
                    
                                                   
                      
                            
                                  
                                                                                
                              
                                                                
                  
                                                                  
                 
                                                
                        
 

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function dropdown(options                         , value        , onChange                         , extra                                                                                  = {})                    {
  const node = el('select', { attrs: { ...(extra.control ? { 'data-control': extra.control } : {}), ...(extra.label ? { 'aria-label': extra.label } : {}) }, style: { minWidth: '7rem' } })                     ;
  fillOptions(node, extra.blank !== undefined ? [{ value: '', label: extra.blank }, ...options] : options, value);
  if (extra.blank === undefined && !options.some((o) => o.value === value) && options[0]) node.value = options[0].value;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

/** A combo (a dropdown with "Other — type a value…"), the form's own control. */
export function combo(options                         , value        , onChange                         , label        )              {
  const input                 = { id: 'v', label, control: 'combo', options, blankLabel: '(none)' };
  const node = control(input, value, () => onChange(comboValue(node)));
  node.setAttribute('aria-label', label);
  return node;
}

function comboValue(node             )         {
  const select = node.querySelector('select')                            ;
  const box = node.querySelector('input')                           ;
  if (!select) return '';
  return select.value === '__custom__' ? (box?.value ?? '').trim() : select.value;
}

export function button(text        , onClick            , extra                                                                                                                                            = {})                    {
  const node = el('button', {
    class: ['btn', extra.primary ? 'btn-primary' : '', extra.small ? 'btn-small' : ''].filter(Boolean).join(' '),
    text,
    attrs: { type: 'button', ...(extra.control ? { 'data-control': extra.control } : {}), ...(extra.disabled ? { disabled: true } : {}), ...(extra.title ? { title: extra.title } : {}) },
  })                     ;
  node.addEventListener('click', onClick);
  return node;
}

export function buttonRow(...children         )              {
  return el('div', { class: 'btn-row', style: { flexWrap: 'wrap' } }, ...children);
}

export function textInput(value        , onChange                         , extra                                                                                                                                            = {})                   {
  const node = el('input', {
    attrs: {
      type: extra.type ?? 'text',
      ...(extra.placeholder ? { placeholder: extra.placeholder } : {}),
      ...(extra.control ? { 'data-control': extra.control } : {}),
      ...(extra.label ? { 'aria-label': extra.label } : {}),
    },
    style: { minWidth: '6rem' },
  })                    ;
  node.value = value;
  node.addEventListener(extra.onInput ? 'input' : 'change', () => onChange(node.value));
  return node;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function rowsTable(headers                   , rows                               , options                                                                                               = {})              {
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

                                                          

export function chip(text        , tone       = 'neutral', title         )              {
  return el('span', { class: tone === 'neutral' ? 'badge' : `badge ${tone}`, text, attrs: title ? { title } : {} });
}

/** The [U] / [C] mark of a fact that is not verified from the vendor's own documentation; nothing for a verified one. */
export function factBadge(v                          , source         )                     {
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
export function sourceLink(url                    )                     {
  if (!url) return null;
  const first = url.split(' ; ')[0] .trim();
  let host = first;
  try {
    host = new URL(first).host;
  } catch {
    return el('span', { class: 'small muted', text: first });
  }
  return el('a', { class: 'small', text: host, attrs: { href: first, target: '_blank', rel: 'noopener noreferrer' } });
}

export function note(text        , control         )              {
  return el('p', { class: 'small muted', text, attrs: control ? { 'data-control': control } : {} });
}

export function subhead(text        )              {
  return el('h3', { text, style: { margin: 'var(--space-4) 0 var(--space-2)', fontSize: '1rem' } });
}

export function fill(node             , ...children         )       {
  clear(node);
  append(node, ...children);
}

/** A labelled inline control for filter rows. */
export function labelled(label        , node             )              {
  return el('label', { class: 'field', style: { minWidth: '9rem', flex: '1 1 10rem', margin: '0' } }, el('span', { class: 'small muted', text: label }), node);
}

export function filterRow(...children         )              {
  return el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end', marginBottom: 'var(--space-3)' } }, ...children);
}

/** Save bytes as a file. */
export function saveBytes(name        , bytes            , mime = 'application/zip')       {
  const blob = new Blob([bytes                           ], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: name } });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Today (yyyy-mm-dd) for EOL judgements: the plan's savedAt date when there is one. */
export function judgedOn(plan                       )         {
  const d = new Date(plan.savedAt);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}
