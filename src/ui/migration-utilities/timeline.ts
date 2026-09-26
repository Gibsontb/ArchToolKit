/**
 * Timeline (`#timeline`) on Multi-Cloud Migration & Utilities (addendum A.8.4).
 *
 * 1. The wave timeline: every wave on a date axis, its planned window (from
 *    the wave plan, or "Week N"), its actual window (first replicate to last
 *    validate), the gate decisions as diamonds, the T-minus milestones of the
 *    AWS communication gates and the kit's steps, the freeze windows hatched,
 *    and the decommission-due ticks.
 * 2. The burn-down, with its target state a dropdown (cut over, validated,
 *    decommissioned): the actual line from the events, one point a day, and
 *    the ideal line from the waves' end dates.
 * 3. The cumulative flow: the count per state per day.
 * 4. Velocity and the forecast finish against the deadline.
 */

import { el, append } from '../dom.ts';
import { card, findingsList, stat, statGrid } from '../components.ts';
import type { PaneContext } from '../plan-shell.ts';
import { burnDown, cumulativeFlow, forecast, waveTimeline, waveWindows, type BurnTarget } from '../../multicloud/plan/track/metrics.ts';
import { T_MINUS, addDays } from '../../multicloud/plan/execute/waves/timeline.ts';
import type { Plan, Tracker, WavePlan } from '../../multicloud/plan/types.ts';
import type { TrackContext } from '../../multicloud/plan/track/sync.ts';
import { fill, note, rowsTable } from '../multicloud/pane-kit.ts';
import { burnDownChart, cumulativeFlowChart, renderSvg, timelineChart, type TimelineMilestone, type TimelineWave } from './charts.ts';
import { otherPlanNode, todayIso, watchTrack, type TrackView } from './track-kit.ts';

export const BURN_TARGETS: readonly { value: BurnTarget; label: string }[] = [
  { value: 'cut-over', label: 'Cut over' },
  { value: 'validated', label: 'Validated' },
  { value: 'decommissioned', label: 'Decommissioned' },
];

/**
 * A wave's T-minus milestones from its cutover day (T-0 = the planned start):
 * the hypercare end at the longest hypercare of its items, G4 at the longest
 * keep-days; the landing-zone gate only for production waves.
 */
export function waveMilestones(start: string | undefined, keepDays: number, hypercareDays: number, production: boolean): TimelineMilestone[] {
  if (!start) return [];
  return T_MINUS
    .filter((r) => !r.productionOnly || production)
    .map((r) => {
      const offset = r.id === 'aws-gate-9' ? hypercareDays : r.id === 'g4' ? keepDays : r.offset;
      const label = r.id === 'aws-gate-9' ? `T+${hypercareDays}` : r.id === 'g4' ? `T+${keepDays}` : r.label;
      return { date: addDays(start, offset, r.business), label, title: r.title, kind: r.kind };
    })
    .filter((m) => m.date !== '');
}

/** The timeline rows of a tracker and its plan's waves. */
export function timelineWaves(tracker: Tracker, ctx: TrackContext, waves: WavePlan | undefined, plan?: Pick<Plan, 'workloads'>): TimelineWave[] {
  const prod = new Set((plan?.workloads ?? []).filter((w) => w.env === 'prod').map((w) => w.id));
  const rows = waveTimeline(tracker, { keepDays: ctx.keepDays, criticality: ctx.criticality, ...(waves ? { waves } : {}) });
  const items = Object.values(tracker.items).filter((s) => !s.removed);
  return rows.map((r) => {
    const mine = items.filter((s) => s.wave === r.wave);
    const crits = mine.map((s) => ctx.criticality.get(s.item) ?? 'tier2');
    const keep = Math.max(1, ...crits.map((c) => ctx.keepDays[c]));
    const hyper = Math.max(1, ...crits.map((c) => ctx.hypercareDays[c]));
    const production = mine.some((s) => prod.has(s.item));
    return {
      wave: r.wave,
      label: r.planned?.label ?? '',
      ...(r.planned?.start ? { plannedStart: r.planned.start } : {}),
      ...(r.planned?.end ? { plannedEnd: r.planned.end } : {}),
      ...(r.actualStart ? { actualStart: r.actualStart } : {}),
      ...(r.actualEnd ? { actualEnd: r.actualEnd } : {}),
      gates: r.gates,
      decomDue: r.decomDue.map((d) => d.due),
      milestones: waveMilestones(r.planned?.start, keep, hyper, production),
    };
  });
}

export function mount(root: HTMLElement, ctx: PaneContext): void {
  let target: BurnTarget = 'cut-over';
  let current: TrackView | undefined;
  const banner = el('div');
  const timelineBox = el('div', { attrs: { 'data-control': 'wave-timeline' } });
  const burnBox = el('div', { attrs: { 'data-control': 'burn-down' } });
  const flowBox = el('div', { attrs: { 'data-control': 'cumulative-flow' } });
  const forecastBox = el('div', { attrs: { 'data-control': 'forecast' } });
  const targetSel = el('select', { attrs: { 'aria-label': 'Target state', 'data-control': 'burn-target' } }) as HTMLSelectElement;
  for (const t of BURN_TARGETS) append(targetSel, el('option', { text: t.label, attrs: { value: t.value } }));
  targetSel.addEventListener('change', () => {
    target = targetSel.value as BurnTarget;
    if (current) drawBurn(current);
  });
  append(root, el('div', { class: 'stack', style: { minWidth: '0', overflowWrap: 'anywhere' } },
    banner,
    card('Wave timeline', timelineBox),
    card('Burn-down', el('div', { class: 'field' }, el('label', { text: 'Items not yet at' }), targetSel), burnBox),
    card('Cumulative flow', flowBox),
    card('Velocity and forecast', forecastBox),
  ));

  function drawBurn(v: TrackView): void {
    const points = burnDown(v.tracker, target, v.waves, todayIso());
    fill(burnBox, renderSvg(burnDownChart(points, BURN_TARGETS.find((t) => t.value === target)?.label.toLowerCase() ?? target)),
      points.some((p) => p.ideal !== undefined) ? null : note('No ideal line: the waves have no dates yet (set a start date on Waves).'));
  }

  const draw = (v: TrackView): void => {
    current = v;
    fill(banner, otherPlanNode(v, ctx));
    const today = todayIso();
    const rows = timelineWaves(v.tracker, v.ctx, v.waves, v.plan);
    const freezes = v.waves.settings.freezes ?? [];
    const windows = waveWindows(v.waves);
    fill(timelineBox,
      renderSvg(timelineChart(rows, freezes, today)),
      windows.length && windows.every((w) => !w.start) ? note('The waves have no dates yet, so the planned bars and the T-minus milestones are not drawn: set a start date on Waves.') : null,
      rowsTable(['Wave', 'Planned', 'Actual', 'Gates', 'Decommission due'], rows.map((r) => [
        String(r.wave), r.label || '—',
        r.actualStart ? `${r.actualStart.slice(0, 10)} to ${r.actualEnd ? r.actualEnd.slice(0, 10) : 'now'}` : '—',
        r.gates.map((g) => `${g.gate} ${g.decision} ${g.at.slice(0, 10)}`).join(', ') || '—',
        r.decomDue.join(', ') || '—',
      ]), { control: 'timeline-table' }),
      freezes.length ? note(`Freeze windows: ${freezes.map((f) => `${f.from} to ${f.to}${f.reason ? ` (${f.reason})` : ''}`).join('; ')}.`) : null,
    );
    drawBurn(v);
    fill(flowBox, renderSvg(cumulativeFlowChart(cumulativeFlow(v.tracker, v.waves, today))));
    const f = forecast(v.tracker, v.ctx, today);
    fill(forecastBox,
      statGrid(
        stat({ label: 'Velocity', value: `${f.velocity}`, sub: 'items cut over a week (last four weeks)' }),
        stat({ label: 'Remaining', value: f.remaining, sub: 'items before cut-over' }),
        stat({ label: 'Forecast finish', value: f.finish ?? '—', sub: f.finish ? 'remaining ÷ velocity' : 'no velocity yet', tone: f.weeksLate ? 'warn' : 'neutral' }),
        stat({ label: 'Deadline', value: f.deadline ?? '—', sub: f.deadline ? `${f.weeksLate ?? 0} week(s) late` : 'no timeline set in the constraints', tone: f.weeksLate ? 'danger' : 'ok' }),
      ),
      findingsList(f.findings, 'The forecast meets the deadline, or there is no deadline to meet.'),
    );
  };

  watchTrack(ctx, draw);
}
