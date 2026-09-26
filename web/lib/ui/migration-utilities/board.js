/**
 * Board (`#board`) on Multi-Cloud Migration & Utilities (addendum A.8.3).
 *
 * - Import status files (zip, jsonl, json; drag and drop) and watch the
 *   states change; the tracker file (Save / Load / Clear) beside it.
 * - Filters first, as dropdowns: Wave, App, Platform, Path, State, Flag, Owner.
 * - View: By workload (the item grid, paged at 200, each row opening its
 *   history, sign-offs, linked RAID, the manual transition form and Open in
 *   Execute), By wave (cards with the stacked state bar and the G1–G4 gate
 *   chips), By app.
 * - Manual transitions need a reason; they are events with `source: manual`.
 */

import { el, append, clear } from '../dom.js';
import { card } from '../components.js';
import { fileBar } from '../file-bar.js';
                                                    
                                                
import {
  ITEM_FLAG_OPTIONS, ITEM_STATE_OPTIONS, PLATFORM_LABELS, SIGN_OFF_KIND_OPTIONS, labelOf,
} from '../../multicloud/plan/options.js';
import { appRows, boardRows, filterValues, waveCards,                                                } from '../../multicloud/plan/track/board.js';
import { itemHistory } from '../../multicloud/plan/track/derive.js';
import { ragStatus } from '../../multicloud/plan/track/metrics.js';
import { manualEvent,                } from '../../multicloud/plan/track/states.js';
import { trackerEnvelope, trackerFromEnvelope } from '../../multicloud/plan/track/store.js';
import { trackerFor } from '../../multicloud/plan/track/sync.js';
import { withDerived } from '../../multicloud/plan/track/derive.js';
import { pathLabel } from '../../multicloud/plan/execute/paths.js';
                                                                                                     
import { fill, note, rowsTable, subhead } from '../multicloud/pane-kit.js';
import { renderSvg, stateBarChart } from './charts.js';
import {
  commitTracker, importStatusControl, otherPlanNode, todayIso, watchTrack, withEvent,                
} from './track-kit.js';

                                                    
export const BOARD_VIEWS                                                 = [
  { value: 'workload', label: 'By workload' },
  { value: 'wave', label: 'By wave' },
  { value: 'app', label: 'By app' },
];
export const BOARD_PAGE = 200;

/** The filter from the dropdowns' values ('' = any). */
export function filterFrom(values                                  , includeRemoved = false)              {
  const f                                                         = {};
  if (values.wave) f.wave = Number(values.wave);
  if (values.app) f.app = values.app;
  if (values.platform) f.platform = values.platform            ;
  if (values.path) f.path = values.path             ;
  if (values.state) f.state = values.state             ;
  if (values.flag) f.flag = values.flag            ;
  if (values.owner) f.owner = values.owner;
  if (includeRemoved) f.includeRemoved = true;
  return f;
}

/** A gate chip's text and tone. */
export function chipText(gate        , chip                                          )                                                      {
  return chip === 'green' ? { text: `${gate} go`, tone: 'ok' } : chip === 'red' ? { text: `${gate} no go`, tone: 'danger' } : { text: `${gate} —`, tone: 'neutral' };
}

const badge = (text        , tone                                      )              =>
  el('span', { class: tone === 'neutral' ? 'badge' : `badge ${tone === 'ok' ? 'good' : tone}`, text });

export function mount(root             , ctx             )       {
  const filters                         = { wave: '', app: '', platform: '', path: '', state: '', flag: '', owner: '' };
  let view            = 'workload';
  let includeRemoved = false;
  let page = 0;
  let selected                    ;
  let transitionNote = '';
  let current                       ;

  const banner = el('div');
  const head = el('div', { class: 'stack' });
  const filterBar = el('div', { class: 'filter-row', attrs: { 'data-control': 'board-filters' } });
  const body = el('div', { class: 'stack', attrs: { 'data-control': 'board-body' } });
  const detail = el('div', { attrs: { 'data-control': 'board-detail' } });
  append(root, el('div', { class: 'stack', style: { overflowWrap: 'anywhere', minWidth: '0' } },
    banner,
    card('Board', head, importStatusControl(() => current, ctx, 'board-import'), trackerBar()),
    card('Items', filterBar, body),
    detail,
  ));

  function trackerBar()              {
    return el('div', { style: { marginTop: 'var(--space-3)' } }, fileBar({
      noun: 'the migration tracker',
      fileName: () => 'archtoolkit-migration-tracker',
      save: () => trackerEnvelope(current?.tracker ?? trackerFor(ctx.session.plan()))                   ,
      header: () => ['ArchToolKit migration tracker (archtoolkit.migration-tracker).', 'Events carry no user, host or path.'],
      load: (value) => {
        const read = trackerFromEnvelope(value);
        if ('error' in read) throw new Error(read.error);
        void commitTracker(read.ok, ctx);
        return read.ok.planId === ctx.session.plan().id ? 'Loaded the tracker.' : 'Loaded a tracker of another plan: see the banner.';
      },
      clear: () => {
        const v = current;
        if (!v) return;
        if (globalThis.confirm && !globalThis.confirm('Start the tracker again? Every imported event, gate, sign-off and RAID entry is dropped (export it first to keep them).')) return;
        void commitTracker(withDerived(trackerFor(v.plan, v.decision, v.waves), v.ctx), ctx);
      },
    }));
  }

  const draw = (v           )       => {
    current = v;
    fill(banner, otherPlanNode(v, ctx));
    const rag = ragStatus(v.tracker, v.ctx, todayIso());
    const all = boardRows(v.tracker, v.ctx, { includeRemoved });
    fill(head,
      el('div', { class: 'btn-row', style: { alignItems: 'center' } },
        badge(rag.rag.toUpperCase(), rag.rag === 'green' ? 'ok' : rag.rag === 'amber' ? 'warn' : 'danger'),
        el('span', { class: 'small', text: rag.reason, attrs: { 'data-control': 'board-rag' } })),
      note(all.length
        ? `${all.length} tracked item${all.length === 1 ? '' : 's'}${v.stored ? '' : ' (nothing recorded yet: the tracker is saved the first time you import or record something)'}.`
        : 'Nothing is tracked yet: the plan has no workloads or databases to move.'),
      v.failure ? el('div', { class: 'tip warn', text: `The plan could not be decided: ${v.failure}` }) : null);
    drawFilters(v);
    drawBody(v);
    drawDetail(v);
  };

  function drawFilters(v           )       {
    const values = filterValues(boardRows(v.tracker, v.ctx, { includeRemoved }));
    const pick = (key        , label        , options                                             ) => {
      const s = el('select', { attrs: { 'aria-label': label, 'data-control': `board-filter-${key}` } })                     ;
      append(s, el('option', { text: `${label}: any`, attrs: { value: '' } }));
      for (const o of options) append(s, el('option', { text: o.label, attrs: { value: o.value } }));
      if (!options.some((o) => o.value === filters[key])) filters[key] = '';
      s.value = filters[key] ?? '';
      s.addEventListener('change', () => {
        filters[key] = s.value;
        page = 0;
        if (current) drawBody(current);
      });
      return s;
    };
    const viewSel = el('select', { attrs: { 'aria-label': 'View', 'data-control': 'board-view' } })                     ;
    for (const o of BOARD_VIEWS) append(viewSel, el('option', { text: o.label, attrs: { value: o.value } }));
    viewSel.value = view;
    viewSel.addEventListener('change', () => {
      view = viewSel.value             ;
      if (current) drawBody(current);
    });
    const removed = el('input', { attrs: { type: 'checkbox', 'data-control': 'board-removed' } })                    ;
    removed.checked = includeRemoved;
    removed.addEventListener('change', () => {
      includeRemoved = removed.checked;
      if (current) draw(current);
    });
    fill(filterBar,
      viewSel,
      pick('wave', 'Wave', values.waves.map((w) => ({ value: String(w), label: w === 0 ? 'No wave' : `Wave ${w}` }))),
      pick('app', 'App', values.apps.map((a) => ({ value: a, label: a }))),
      pick('platform', 'Platform', values.platforms.map((p) => ({ value: p, label: PLATFORM_LABELS[p] }))),
      pick('path', 'Path', values.paths.map((p) => ({ value: p, label: pathLabel(p) }))),
      pick('state', 'State', values.states.map((s) => ({ value: s, label: labelOf(ITEM_STATE_OPTIONS, s) }))),
      pick('flag', 'Flag', values.flags.map((f) => ({ value: f, label: labelOf(ITEM_FLAG_OPTIONS, f) }))),
      pick('owner', 'Owner', values.owners.map((o) => ({ value: o, label: o }))),
      el('label', { class: 'checkbox small' }, removed, el('span', { text: 'Show removed' })),
    );
  }

  function drawBody(v           )       {
    const filter = filterFrom(filters, includeRemoved);
    if (view === 'wave') {
      const cards = waveCards(v.tracker, v.ctx, filter);
      fill(body, cards.length === 0 ? note('No items match the filters.') : el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 18rem), 1fr))', gap: 'var(--space-3)' },
        attrs: { 'data-control': 'wave-cards' },
      }, ...cards.map(waveCardNode)));
      return;
    }
    if (view === 'app') {
      const rows = appRows(v.tracker, v.ctx, filter);
      const so = (d        ) => (d ? labelOf([{ value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }], d) : '—');
      fill(body, rows.length === 0 ? note('No items match the filters.') : rowsTable(
        ['App', 'Owner', 'Items', 'Waves', 'Lowest state', '%', 'Test sign-off', 'Cutover sign-off', 'Acceptance', 'Decom approval', 'Open issues'],
        rows.map((r) => [r.app || '—', r.owner || '—', String(r.items), r.waves.join(', '), labelOf(ITEM_STATE_OPTIONS, r.lowest), `${Math.round(r.pct)}%`, so(r.testSignOff), so(r.cutoverSignOff), so(r.acceptance), so(r.decomApproval), String(r.openIssues)]),
        { numeric: [2, 5, 10], control: 'board-apps' },
      ));
      return;
    }
    const rows = boardRows(v.tracker, v.ctx, filter);
    const pages = Math.max(1, Math.ceil(rows.length / BOARD_PAGE));
    page = Math.min(page, pages - 1);
    const shown = rows.slice(page * BOARD_PAGE, (page + 1) * BOARD_PAGE);
    const open = (r          ) => el('button', {
      class: 'btn btn-small', text: r.name, attrs: { type: 'button', 'data-control': 'board-open-item', 'data-item': r.item },
      on: {
        click: () => {
          selected = r.item;
          transitionNote = '';
          if (current) drawDetail(current);
          detail.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        },
      },
    });
    fill(body,
      rows.length === 0 ? note('No items match the filters.') : rowsTable(
        ['Name', 'Kind', 'App', 'Wave', 'Path', 'Platform', 'State', 'Flag', 'Since', 'Last event', 'Sync', 'Blocker', 'Owner'],
        shown.map((r) => [
          open(r), r.kind, r.app || '—', String(r.wave), pathLabel(r.path), r.platformLabel || '—',
          el('span', {}, r.stateLabel, r.providerState ? el('span', { class: 'small muted', text: ` (${r.providerState})` }) : null),
          r.flag || '', r.since.slice(0, 10), r.lastEvent, r.sync, r.blockers.join(' '), r.owner,
        ]),
        { numeric: [3], control: 'board-items' },
      ),
      pages > 1 ? el('div', { class: 'btn-row', style: { alignItems: 'center' } },
        el('button', { class: 'btn btn-small', text: '← Previous', attrs: { type: 'button', disabled: page === 0 }, on: { click: () => { page -= 1; if (current) drawBody(current); } } }),
        el('span', { class: 'small muted', text: `Page ${page + 1} of ${pages} · ${rows.length} items` }),
        el('button', { class: 'btn btn-small', text: 'Next →', attrs: { type: 'button', disabled: page >= pages - 1 }, on: { click: () => { page += 1; if (current) drawBody(current); } } })) : null,
    );
  }

  function waveCardNode(c          )              {
    const chips = (['G1', 'G2', 'G3', 'G4']         ).map((g) => {
      const t = chipText(g, c.gates[g]);
      return badge(t.text, t.tone);
    });
    const actual = c.actualStart ? `${c.actualStart.slice(0, 10)} to ${c.actualEnd ? c.actualEnd.slice(0, 10) : 'now'}` : 'not started';
    const node = el('section', { class: 'card', attrs: { 'data-control': 'wave-card', 'data-wave': String(c.wave) }, style: { margin: '0' } },
      el('div', { class: 'card-title' }, el('h3', { text: c.wave === 0 ? 'No wave' : `Wave ${c.wave}` })),
      el('div', { class: 'small', text: `Planned: ${c.plannedLabel || '—'}` }),
      el('div', { class: 'small', text: `Actual: ${actual}` }),
      el('div', { style: { margin: 'var(--space-2) 0' } }),
      el('div', { class: 'btn-row', attrs: { 'data-control': 'gate-chips' } }, ...chips),
      el('div', { class: 'small', text: `${c.items} item${c.items === 1 ? '' : 's'} · ${Math.round(c.pct)}% complete · ${c.blockers} blocked · ${c.failed} failed · ${c.rolledBack} rolled back` }),
      el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: 'Open in Execute →', attrs: { href: `#execute:${c.wave}/cutover` } })),
    );
    (node.children[3]               ).appendChild(renderSvg(stateBarChart(c.bar)));
    return node;
  }

  function drawDetail(v           )       {
    clear(detail);
    if (!selected) return;
    const s = v.tracker.items[selected];
    if (!s) {
      selected = undefined;
      return;
    }
    const name = v.ctx.names.get(s.item) ?? s.item;
    const app = v.ctx.apps.get(s.item) ?? '';
    const history = itemHistory(v.tracker, s.item);
    const signoffs = v.tracker.signoffs.filter((x) => x.id === app || x.id.startsWith(`${app}@`) || x.id === String(s.wave));
    const issues = v.tracker.raid.issues.filter((i) => i.blocks.some((b) => b === s.item || b.toLowerCase() === name.toLowerCase() || (app && b.toLowerCase() === app.toLowerCase())));
    const risks = v.tracker.raid.risks.filter((r) => (app && r.app === app) || r.wave === s.wave);

    const stateSel = el('select', { attrs: { 'aria-label': 'New state', 'data-control': 'transition-state' } })                     ;
    for (const o of ITEM_STATE_OPTIONS) append(stateSel, el('option', { text: o.label, attrs: { value: o.value } }));
    stateSel.value = s.state;
    const reason = el('input', { attrs: { type: 'text', placeholder: 'Why (required)', 'aria-label': 'Reason', 'data-control': 'transition-reason' }, style: { flex: '1 1 12rem', minWidth: '0' } })                    ;
    const hold = el('input', { attrs: { type: 'checkbox', 'data-control': 'transition-hold' } })                    ;
    hold.checked = s.flags.includes('on-hold');
    const clearFailed = el('input', { attrs: { type: 'checkbox', 'data-control': 'transition-clear-failed' } })                    ;
    const msg = el('div', { class: 'small', text: transitionNote, attrs: { role: 'status', 'data-control': 'transition-message' } });
    const record = () => {
      const r = manualEvent({
        planId: v.tracker.planId, item: s.item, wave: s.wave, path: s.path, state: stateSel.value             , reason: reason.value,
        at: new Date().toISOString(), ...(hold.checked !== s.flags.includes('on-hold') ? { hold: hold.checked } : {}), ...(clearFailed.checked ? { clearFailed: true } : {}),
      });
      if ('error' in r) {
        msg.textContent = r.error;
        reason.focus();
        return;
      }
      const next          = withEvent(v, r.ok);
      transitionNote = `Recorded: ${name} is now ${labelOf(ITEM_STATE_OPTIONS, next.items[s.item]?.state ?? s.state)}.`;
      void commitTracker(next, ctx);
    };

    append(detail, card(
      `${name}`,
      el('div', { class: 'small', text: `${s.kind} · ${app || 'no app'} · wave ${s.wave} · ${pathLabel(s.path)} · ${labelOf(ITEM_STATE_OPTIONS, s.state)} since ${s.since.slice(0, 10)}${s.flags.length ? ` · ${s.flags.map((f) => labelOf(ITEM_FLAG_OPTIONS, f)).join(', ')}` : ''}${s.lastError ? ` · last error: ${s.lastError}` : ''}` }),
      el('div', { class: 'btn-row' },
        el('a', { class: 'btn btn-small', text: 'Open in Execute →', attrs: { href: `#execute:${s.wave}/cutover`, 'data-control': 'open-in-execute' } }),
        el('button', { class: 'btn btn-small', text: 'Close', attrs: { type: 'button' }, on: { click: () => { selected = undefined; clear(detail); } } })),
      subhead('History'),
      history.length === 0 ? note('No events yet.') : rowsTable(['At', 'Step', 'Outcome', 'State', 'Source', 'Detail'],
        history.map((h) => [h.at.replace('T', ' ').slice(0, 19), h.step, `${h.outcome}${h.note ? ` (${h.note})` : ''}`, h.state ? labelOf(ITEM_STATE_OPTIONS, h.state) : '', h.source, h.detail ?? '']),
        { control: 'item-history' }),
      subhead('Sign-offs'),
      signoffs.length === 0 ? note('No sign-offs recorded for its app or wave.') : rowsTable(['Kind', 'For', 'Role', 'Decision', 'Date', 'Comment'],
        signoffs.map((x) => [labelOf(SIGN_OFF_KIND_OPTIONS, x.kind), x.id, x.role, x.decision, x.at.slice(0, 10), x.comment ?? ''])),
      subhead('RAID'),
      issues.length + risks.length === 0 ? note('No linked issues or risks.') : rowsTable(['Id', 'Kind', 'Text', 'Status'],
        [...issues.map((i) => [i.id, `Issue (${i.severity})`, i.issue, i.status]), ...risks.map((r) => [r.id, 'Risk', r.risk, r.status])]),
      subhead('Change the state by hand'),
      note('Moves, holds and releases made here are recorded as manual events with the reason, so the history always says why.'),
      el('div', { class: 'filter-row' }, stateSel, reason),
      el('div', { class: 'btn-row', style: { alignItems: 'center' } },
        el('label', { class: 'checkbox small' }, hold, el('span', { text: 'On hold' })),
        el('label', { class: 'checkbox small' }, clearFailed, el('span', { text: 'Clear the failed flag' })),
        el('button', { class: 'btn btn-primary btn-small', text: 'Record', attrs: { type: 'button', 'data-control': 'transition-record' }, on: { click: record } })),
      msg,
    ));
  }

  watchTrack(ctx, draw);
}
