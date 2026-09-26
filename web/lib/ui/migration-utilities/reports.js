/**
 * Reports (`#reports`) on Multi-Cloud Migration & Utilities (addendum A.8.6,
 * A.10.13).
 *
 * - The tiles (in scope, cut over, validated, accepted, decommissioned;
 *   failed, blocked, rolled back; % complete by count and by vCPU; moved;
 *   hosts freed; licences reclaimed; retained and retired) and the % by wave
 *   table.
 * - The burn-down and the cumulative flow, drawn from the events.
 * - The downloads, named with the plan slug and the report date picked here
 *   and nothing else: the weekly status report, the executive summary (md,
 *   html to print, .doc), the wave report, the estate capacity (md, csv,
 *   xlsx), the evidence pack (zip) and the tracker exports (CSV, the tracker
 *   file and the latest gate files).
 */

import { el, append, downloadFile } from '../dom.js';
import { card, stat, statGrid } from '../components.js';
                                                    
import { zip } from '../../kit/archive.js';
import { burnDown, cumulativeFlow, tiles, waveTable,                 } from '../../multicloud/plan/track/metrics.js';
import { exportFiles } from '../../multicloud/plan/track/export.js';
import {
  DOC_MIME, DOC_NOTE, capacityReport, evidencePack, executiveSummary, reportFileName, statusReport, waveReport,                    
} from '../../multicloud/plan/governance/reports.js';
import { waveViews } from '../../multicloud/plan/governance/comms.js';
import { loadAuditEntries, loadChangeRecords, loadRateCard } from '../../multicloud/plan/store.js';
                                                                                         
import { fill, note, rowsTable } from '../multicloud/pane-kit.js';
import { burnDownChart, cumulativeFlowChart, renderSvg } from './charts.js';
import { BURN_TARGETS } from './timeline.js';
import { otherPlanNode, todayIso, watchTrack,                } from './track-kit.js';

                               
                               
                                         
                                             
 

/** The report context of a view: the decided plan, the tracker (when stored), the waves, the report date and the stored extras. */
export function reportContext(view           , date        , extras               = {})                {
  const plan = { ...view.plan, decision: view.decision };
  return {
    plan,
    date,
    ...(view.stored ? { tracker: view.tracker } : {}),
    waves: waveViews(plan, view.waves),
    design: view.design,
    ...(extras.ratecard ? { ratecard: extras.ratecard } : {}),
    ...(extras.audit ? { audit: extras.audit } : {}),
    ...(extras.changes ? { changes: extras.changes } : {}),
  };
}

/** Readable yyyy-mm-dd, or today. */
export function reportDateOf(text        )         {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : todayIso();
}

export function mount(root             , ctx             )       {
  let current                       ;
  let extras               = {};
  let target             = 'cut-over';
  const dateBox = el('input', { attrs: { type: 'date', 'aria-label': 'Report date', 'data-control': 'report-date' } })                    ;
  dateBox.value = todayIso();
  const banner = el('div');
  const tilesBox = el('div', { attrs: { 'data-control': 'report-tiles' } });
  const wavesBox = el('div');
  const burnBox = el('div', { attrs: { 'data-control': 'report-burn-down' } });
  const flowBox = el('div', { attrs: { 'data-control': 'report-cumulative-flow' } });
  const downloads = el('div', { class: 'stack', attrs: { 'data-control': 'report-downloads' } });
  const status = el('div', { class: 'small', attrs: { role: 'status', 'data-control': 'report-message' } });
  const targetSel = el('select', { attrs: { 'aria-label': 'Burn-down target', 'data-control': 'report-burn-target' } })                     ;
  for (const t of BURN_TARGETS) append(targetSel, el('option', { text: t.label, attrs: { value: t.value } }));
  targetSel.addEventListener('change', () => {
    target = targetSel.value              ;
    if (current) drawCharts(current);
  });
  dateBox.addEventListener('change', () => { if (current) draw(current); });
  append(root, el('div', { class: 'stack', style: { minWidth: '0', overflowWrap: 'anywhere' } },
    banner,
    card('Report date', el('div', { class: 'field' }, el('label', { text: 'Report date (the only date in the files)' }), dateBox)),
    card('Progress', tilesBox, wavesBox),
    card('Burn-down', el('div', { class: 'field' }, el('label', { text: 'Items not yet at' }), targetSel), burnBox),
    card('Cumulative flow', flowBox),
    card('Downloads', downloads, status),
  ));

  function drawCharts(v           )       {
    const today = todayIso();
    fill(burnBox, renderSvg(burnDownChart(burnDown(v.tracker, target, v.waves, today), BURN_TARGETS.find((t) => t.value === target)?.label.toLowerCase() ?? target)));
    fill(flowBox, renderSvg(cumulativeFlowChart(cumulativeFlow(v.tracker, v.waves, today))));
  }

  const button = (label        , control        , run                            , title         ) => el('button', {
    class: 'btn btn-small', text: label, attrs: { type: 'button', 'data-control': control, ...(title ? { title } : {}) },
    on: {
      click: () => {
        status.textContent = '';
        void Promise.resolve()
          .then(run)
          .catch((e         ) => { status.textContent = `Could not build it: ${e instanceof Error ? e.message : String(e)}`; });
      },
    },
  });

  const draw = (v           )       => {
    current = v;
    fill(banner, otherPlanNode(v, ctx));
    const date = reportDateOf(dateBox.value);
    const t = tiles(v.tracker, v.ctx, date);
    fill(tilesBox,
      statGrid(
        stat({ label: 'In scope', value: t.inScope }),
        stat({ label: 'Cut over', value: t.cutOver, sub: `${Math.round(t.pct)}% complete · ${Math.round(t.pctByVcpu)}% by vCPU`, fill: t.pct / 100 }),
        stat({ label: 'Validated', value: t.validated }),
        stat({ label: 'Accepted', value: t.accepted }),
        stat({ label: 'Decommissioned', value: t.decommissioned }),
        stat({ label: 'Failed', value: t.failed, tone: t.failed ? 'danger' : 'neutral' }),
        stat({ label: 'Blocked', value: t.blocked, tone: t.blocked ? 'warn' : 'neutral' }),
        stat({ label: 'Rolled back', value: t.rolledBack, tone: t.rolledBack ? 'warn' : 'neutral' }),
        stat({ label: 'Moved', value: `${t.moved.vcpu} vCPU`, sub: `${Math.round(t.moved.ramGib)} GiB RAM · ${Math.round(t.moved.storageGib)} GiB storage` }),
        stat({ label: 'Source hosts freed', value: t.hostsFreed }),
        stat({ label: 'Licences reclaimed', value: t.licencesReclaimed }),
        stat({ label: 'Retained / retired', value: `${t.retained} / ${t.retired}` }),
      ));
    const rows = waveTable(v.tracker, v.waves, date);
    fill(wavesBox, rows.length === 0 ? note('No waves yet.') : rowsTable(
      ['Wave', 'Items', 'Planned end', 'Cut over', 'Validated', 'Decommissioned', '%', 'Forecast end', 'On track'],
      rows.map((r) => [String(r.wave), String(r.items), r.plannedEnd ?? '—', String(r.cutOver), String(r.validated), String(r.decommissioned), `${Math.round(r.pct)}%`, r.forecastEnd ?? '—', r.onTrack === undefined ? '—' : r.onTrack ? 'Yes' : 'No']),
      { numeric: [1, 3, 4, 5, 6], control: 'report-waves' },
    ));
    drawCharts(v);

    const rctx = () => reportContext(v, reportDateOf(dateBox.value), extras);
    const waves = waveViews(v.plan, v.waves);
    const waveSel = el('select', { attrs: { 'aria-label': 'Wave', 'data-control': 'report-wave' } })                     ;
    for (const w of waves) append(waveSel, el('option', { text: `Wave ${w.n}`, attrs: { value: String(w.n) } }));
    const md = 'text/markdown';
    fill(downloads,
      v.stored ? null : note('Nothing is recorded in the tracker yet, so the reports show the plan only.'),
      el('div', { class: 'btn-row' },
        el('strong', { class: 'small', text: 'Status report' }),
        button('Status report (.md)', 'report-status', () => {
          const c = rctx();
          downloadFile(reportFileName(c, 'status-report', 'md'), statusReport(c), md);
        })),
      el('div', { class: 'btn-row' },
        el('strong', { class: 'small', text: 'Executive summary' }),
        button('.md', 'report-exec-md', () => { const c = rctx(); downloadFile(reportFileName(c, 'executive-summary', 'md'), executiveSummary(c).markdown, md); }),
        button('.html (print to PDF)', 'report-exec-html', () => { const c = rctx(); downloadFile(reportFileName(c, 'executive-summary', 'html'), executiveSummary(c).html, 'text/html'); }),
        button('.doc', 'report-exec-doc', () => { const c = rctx(); downloadFile(reportFileName(c, 'executive-summary', 'doc'), executiveSummary(c).doc, DOC_MIME); }, DOC_NOTE)),
      el('div', { class: 'btn-row' },
        el('strong', { class: 'small', text: 'Wave report' }),
        waves.length ? waveSel : el('span', { class: 'small muted', text: 'no waves yet' }),
        waves.length ? button('.md', 'report-wave-md', () => { const c = rctx(); const n = Number(waveSel.value); downloadFile(reportFileName(c, `wave-${n}-report`, 'md'), waveReport(c, n).markdown, md); }) : null,
        waves.length ? button('.html', 'report-wave-html', () => { const c = rctx(); const n = Number(waveSel.value); downloadFile(reportFileName(c, `wave-${n}-report`, 'html'), waveReport(c, n).html, 'text/html'); }) : null),
      el('div', { class: 'btn-row' },
        el('strong', { class: 'small', text: 'Estate capacity' }),
        button('.md', 'report-capacity-md', async () => { const c = rctx(); downloadFile(reportFileName(c, 'estate-capacity', 'md'), (await capacityReport(c)).markdown, md); }),
        button('.csv', 'report-capacity-csv', async () => { const c = rctx(); downloadFile(reportFileName(c, 'estate-capacity', 'csv'), (await capacityReport(c)).csv, 'text/csv'); }),
        button('.xlsx', 'report-capacity-xlsx', async () => { const c = rctx(); downloadFile(reportFileName(c, 'estate-capacity', 'xlsx'), (await capacityReport(c)).xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); })),
      el('div', { class: 'btn-row' },
        el('strong', { class: 'small', text: 'Evidence pack' }),
        button('Evidence pack (.zip)', 'report-evidence', async () => {
          const c = rctx();
          const pack = await evidencePack(c);
          downloadFile(reportFileName(c, 'evidence-pack', 'zip'), pack.bytes, 'application/zip');
          status.textContent = `Evidence pack: ${Object.keys(pack.files).length} files.`;
        })),
      el('div', { class: 'btn-row' },
        el('strong', { class: 'small', text: 'Tracker exports' }),
        button('Items, waves, events, RAID, gates (.zip)', 'report-tracker-zip', async () => {
          const d = reportDateOf(dateBox.value);
          const files = exportFiles(v.tracker, v.ctx, d);
          const bytes = await zip(files, new Date(v.plan.savedAt));
          const c = rctx();
          downloadFile(reportFileName(c, 'tracker-exports', 'zip'), bytes, 'application/zip');
          status.textContent = `Tracker exports: ${Object.keys(files).length} files.`;
        })),
    );
  };

  void Promise.all([loadRateCard().catch(() => null), loadAuditEntries().catch(() => []), loadChangeRecords().catch(() => [])]).then(([ratecard, audit, changes]) => {
    extras = { ...(ratecard ? { ratecard } : {}), audit, changes };
  });
  watchTrack(ctx, draw);
}
