/**
 * Overview (`#overview`) on Multi-Cloud Migration & Utilities (addendum A.5.1,
 * A.8.4, A.8.6).
 *
 * - Status: the RAG and its reason, the tiles, the counts per phase (P0–P9)
 *   and per strategy, and the forecast finish against the deadline.
 * - Top risks and the next gate of every wave (with its T-minus date and how
 *   many of its criteria the tracker already meets).
 * - The application plans: App | Pattern | Platform | Status | Items |
 *   Wave(s) | Paths | Downtime class | Blockers | Open, with the draft apps
 *   listed apart as not yet planned.
 * - The estate check (`mountEstateCheck`): placement, landing zones,
 *   licences, the decision tables, capacity and quotas, transfer time.
 */

import { el, append } from '../dom.js';
import { card, findingsList, stat, statGrid } from '../components.js';
                                                    
import { appSlug } from '../page-modes.js';
import {
  APP_PATTERN_OPTIONS, APP_PLAN_STATUS_OPTIONS, MIGRATION_PHASE_OPTIONS, MIGRATION_STRATEGY_OPTIONS, PLATFORM_LABELS, labelOf,
} from '../../multicloud/plan/options.js';
                                                             
import { gateStates } from '../../multicloud/plan/track/derive.js';
import { forecast, ragStatus, tiles, waveWindows } from '../../multicloud/plan/track/metrics.js';
import { topRisks, riskScore, blockersByItem } from '../../multicloud/plan/track/raid.js';
import { gateMet } from '../../multicloud/plan/track/gates.js';
import { pathLabel } from '../../multicloud/plan/execute/paths.js';
import { addDays } from '../../multicloud/plan/execute/waves/timeline.js';
import { appScope, downtimeFromDecision } from '../../multicloud/plan/governance/complexity.js';
import { mountEstateCheck } from '../multicloud/estate-check.js';
import { fill, note, rowsTable } from '../multicloud/pane-kit.js';
import { gateCriteria, otherPlanNode, todayIso, watchTrack,                } from './track-kit.js';

/** The T-minus offset (days from the wave's start) each gate is decided at. */
export const GATE_OFFSET                                                  = { G1: -5, G2: -1, G3: 1, G4: 14 };

                           
                        
                                       
                                               
                        
                       
                         
                          
 

/** Each wave's first gate without a go (G1 → G4), with its due date and criteria met. */
export function nextGates(view                                                       , today        )             {
  const starts = new Map(waveWindows(view.waves).map((w) => [w.wave, w.start]));
  const waves = [...new Set(Object.values(view.tracker.items).filter((s) => !s.removed && s.wave > 0).map((s) => s.wave))].sort((a, b) => a - b);
  const out             = [];
  for (const wave of waves) {
    const states = gateStates(view.tracker, wave);
    const gate = (['G1', 'G2', 'G3', 'G4']         ).find((g) => states[g] !== 'go');
    if (!gate) continue;
    const criteria = gateCriteria(view, wave, gate, {}, today);
    const start = starts.get(wave);
    const keep = gate === 'G4' ? Math.max(1, ...Object.values(view.tracker.items).filter((s) => s.wave === wave).map((s) => view.ctx.keepDays[view.ctx.criticality.get(s.item) ?? 'tier2'])) : GATE_OFFSET[gate];
    out.push({
      wave, gate, ...(start ? { due: addDays(start, keep) } : {}),
      met: criteria.filter((c) => c.met).length, total: criteria.length, ready: gateMet(criteria),
    });
  }
  return out;
}

/** The A.5.1 application-plan rows. */
export function appPlanRows(view                                                          )                                                                                                                                                                                    {
  const { plan, tracker } = view;
  const blockers = blockersByItem(tracker, view.ctx);
  return plan.apps.map((a) => {
    const ap = (plan.appPlans ?? []).find((x) => x.app === a.id);
    const scope = appScope(plan, a.name);
    const ids = [...scope.workloads, ...scope.databases].map((i) => i.id);
    const tracked = ids.map((id) => tracker.items[id]).filter((s)                             => !!s && !s.removed);
    const platform = ap?.platform ?? ap?.recommendation?.platform ?? scope.workloads.map((w) => view.decision.items[w.id]?.chosen?.platform).find(Boolean);
    return {
      app: a.name,
      id: a.id,
      pattern: a.pattern ? labelOf(APP_PATTERN_OPTIONS, a.pattern) : '—',
      platform: platform ? PLATFORM_LABELS[platform] : '—',
      status: ap ? labelOf(APP_PLAN_STATUS_OPTIONS, ap.status) : 'No plan',
      items: ids.length,
      waves: [...new Set(tracked.map((s) => s.wave))].sort((x, y) => x - y).join(', ') || '—',
      paths: [...new Set(tracked.map((s) => pathLabel(s.path)))].join(', ') || '—',
      downtime: downtimeFromDecision(scope, view.decision),
      blockers: ids.filter((id) => blockers.has(id)).length,
      draft: !ap || ap.status === 'draft',
    };
  });
}

const count = (rec                                  , options                                             )                     =>
  Object.entries(rec).filter(([, n]) => n > 0).map(([k, n]) => [labelOf(options, k) || k, String(n)]);

export function mount(root             , ctx             )       {
  const banner = el('div');
  const statusBox = el('div', { class: 'stack', attrs: { 'data-control': 'overview-status' } });
  const risksBox = el('div', { attrs: { 'data-control': 'overview-risks' } });
  const gatesBox = el('div', { attrs: { 'data-control': 'overview-gates' } });
  const appsBox = el('div', { class: 'stack', attrs: { 'data-control': 'overview-apps' } });
  const estate = el('div', { attrs: { 'data-control': 'overview-estate' } });
  append(root, el('div', { class: 'stack', style: { minWidth: '0', overflowWrap: 'anywhere' } },
    banner,
    card('Status', statusBox),
    el('div', { class: 'two' }, card('Top risks', risksBox), card('Next gates', gatesBox)),
    card('Application plans', appsBox),
    estate,
  ));

  const draw = (v           )       => {
    fill(banner, otherPlanNode(v, ctx));
    const today = todayIso();
    const t = tiles(v.tracker, v.ctx, today);
    const rag = ragStatus(v.tracker, v.ctx, today);
    const f = forecast(v.tracker, v.ctx, today);
    const tone = rag.rag === 'green' ? 'ok' : rag.rag === 'amber' ? 'warn' : 'danger';
    fill(statusBox,
      el('div', { class: 'btn-row', style: { alignItems: 'center' } },
        el('span', { class: `badge ${tone === 'ok' ? 'good' : tone}`, text: rag.rag.toUpperCase(), attrs: { 'data-control': 'overview-rag' } }),
        el('span', { class: 'small', text: rag.reason })),
      statGrid(
        stat({ label: 'In scope', value: t.inScope }),
        stat({ label: 'Cut over', value: t.cutOver, sub: `${Math.round(t.pct)}% complete`, fill: t.pct / 100 }),
        stat({ label: 'Validated', value: t.validated }),
        stat({ label: 'Decommissioned', value: t.decommissioned }),
        stat({ label: 'Failed / blocked', value: `${t.failed} / ${t.blocked}`, tone: t.failed || t.blocked ? 'warn' : 'neutral' }),
        stat({ label: 'Forecast finish', value: f.finish ?? '—', sub: f.deadline ? `deadline ${f.deadline}` : 'no deadline set', tone: f.weeksLate ? 'danger' : 'neutral' }),
      ),
      el('div', { class: 'two' },
        el('div', {}, el('h3', { text: 'By phase' }), rowsTable(['Phase', 'Items'], count(t.byPhase, MIGRATION_PHASE_OPTIONS), { numeric: [1], control: 'overview-phases' })),
        el('div', {}, el('h3', { text: 'By strategy' }), (() => {
          const rows = count(t.byStrategy, MIGRATION_STRATEGY_OPTIONS);
          return rows.length ? rowsTable(['Strategy', 'Items'], rows, { numeric: [1], control: 'overview-strategies' }) : note('No strategies set yet.');
        })())),
      f.findings.length ? findingsList(f.findings) : null,
      v.failure ? el('div', { class: 'tip warn', text: `The plan could not be decided: ${v.failure}` }) : null,
    );

    const risks = topRisks(v.tracker, 5);
    fill(risksBox, risks.length === 0 ? note('No open risks. Add them on RAID.') : rowsTable(['Id', 'Risk', 'Score', 'Status'], risks.map((r) => [r.id, r.risk, String(riskScore(r)), r.status]), { numeric: [2] }),
      el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: 'RAID →', attrs: { href: '#raid' } })));

    const gates = nextGates(v, today);
    fill(gatesBox, gates.length === 0 ? note('No wave is waiting on a gate.') : rowsTable(['Wave', 'Gate', 'Due', 'Criteria met', ''], gates.map((g) => [
      String(g.wave), g.gate, g.due ?? 'no dates', `${g.met} of ${g.total}${g.ready ? ' (ready)' : ''}`,
      el('a', { class: 'btn btn-small', text: 'Open', attrs: { href: `#execute:${g.wave}/${g.gate === 'G1' ? 'test' : g.gate === 'G2' ? 'cutover' : g.gate === 'G3' ? 'commit' : 'decommission'}` } }),
    ]), { control: 'overview-next-gates' }));

    const rows = appPlanRows(v);
    const planned = rows.filter((r) => !r.draft);
    const drafts = rows.filter((r) => r.draft);
    fill(appsBox,
      planned.length === 0 ? note('No application is planned yet: plan them on Application Migration.') : rowsTable(
        ['App', 'Pattern', 'Platform', 'Status', 'Items', 'Wave(s)', 'Paths', 'Downtime class', 'Blockers', 'Open'],
        planned.map((r) => [r.app, r.pattern, r.platform, r.status, String(r.items), r.waves, r.paths, r.downtime, String(r.blockers),
          el('a', { class: 'btn btn-small', text: 'Open', attrs: { href: `migration.html#app:${appSlug(r.id)}` } })]),
        { numeric: [4, 8], control: 'overview-app-plans' },
      ),
      drafts.length ? el('div', { class: 'stack' },
        el('h3', { text: `Not yet planned (${drafts.length})` }),
        el('p', { class: 'small' }, ...drafts.flatMap((r, i) => [i ? ', ' : '', el('a', { text: r.app, attrs: { href: `migration.html#app:${appSlug(r.id)}` } })]))) : null,
    );
  };

  mountEstateCheck(estate, ctx);
  watchTrack(ctx, draw);
}

