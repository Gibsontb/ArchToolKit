/**
 * What the Migrate panes of WP-UI-B share: redrawing when the plan changes
 * (without losing the field being typed in), simple tables, and binding a
 * settings form to the plan.
 */

import { el, append, clear,            } from '../dom.js';
                                                                 
                                                    
                                                           

/**
 * Keep a pane in step with the plan. A change made on this page (`edit`)
 * only refreshes the computed parts, after a pause, so the field being typed
 * in keeps its focus; a reload, a loaded file or a cleared plan draws the
 * pane again. `redraw` returns true when a structural change (a platform
 * appeared) needs the whole pane drawn.
 */
export function watchPlan(ctx             , draw            , refresh                      , delay = 250)       {
  let timer                                           ;
  ctx.session.subscribe((_plan, kind) => {
    if (kind === 'saved') return;
    if (timer) clearTimeout(timer);
    if (kind !== 'edit') {
      draw();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (refresh() === true) draw();
    }, delay);
  });
}

/** A plain table: headers and rows of text or nodes. */
export function rowsTable(headers                   , rows                               , options                                                                      = {})              {
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

/** A heading inside a card. */
export function subhead(text        )              {
  return el('h3', { text, style: { margin: 'var(--space-4) 0 var(--space-2)' } });
}

/** A note line. */
export function note(text        , control         )              {
  return el('p', { class: 'small muted', text, attrs: control ? { 'data-control': control } : {} });
}

/** Replace a node's children. */
export function fill(node             , ...children         )       {
  clear(node);
  append(node, ...children);
}

/**
 * A form bound to `plan.designOverrides`: each input id is an override key,
 * the value shown is the override or the default, and choosing the default
 * (or emptying a text field) removes the override.
 */
export function overridesBinding(ctx             , defaults                                  )                                               {
  return {
    values: () => {
      const o = ctx.session.plan().designOverrides;
      const out                         = {};
      for (const [id, d] of Object.entries(defaults)) out[id] = o[id] ?? d;
      return out;
    },
    set: (id, value) => {
      ctx.session.update((p      ) => {
        const next = { ...p.designOverrides };
        if (value.trim() === '' || value === defaults[id]) delete next[id];
        else next[id] = value;
        return { ...p, designOverrides: next };
      });
    },
  };
}

/** A two-column block of fields (one column on a phone). */
export function twoColumns(fields                        )              {
  return el('div', { class: 'two' }, ...fields);
}
