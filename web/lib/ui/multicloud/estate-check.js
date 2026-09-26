/**
 * The estate check: the detail WP-UI-C's Overview pane (`#overview`) shows
 * under the application plans (addendum A.5.1, A.5.4, A.10.10). Read-only:
 * overrides are made per app on Application Migration.
 *
 *     import { mountEstateCheck } from '../multicloud/estate-check.js';
 *     mountEstateCheck(holder, ctx);
 *
 * It shows:
 * - the placement check (`estate/check.ts` `estateCheck`): where each app
 *   lands, the platforms in use against the maximum, and the findings;
 * - the landing zones needed and their state (designed / generated / missing);
 * - the licence totals per platform;
 * - the decision tables, read-only, each row linking to its app;
 * - capacity and quotas (`estate/capacity.ts`): totals per platform and the
 *   quota grid, with the fetch-quotas script to download and its
 *   `quotas.json` to import;
 * - transfer time (`estate/transfer.ts`): volume, daily change, seed days and
 *   keep-up per app, wave or site, with the offline-seeding options.
 */

import { el, append, clear, downloadFile, readFileAsText } from '../dom.js';
import { card, findingsList, verificationBadge } from '../components.js';
                                                    
import { appSlug } from '../page-modes.js';
import { findApp } from '../../multicloud/plan/apps/components.js';
import { licenceTotals } from '../../multicloud/plan/decide/index.js';
import { checkQuotas, estateCapacity, parseQuotasJson,                  } from '../../multicloud/plan/estate/capacity.js';
import { estateCheck } from '../../multicloud/plan/estate/check.js';
import { fetchQuotasScript } from '../../multicloud/plan/estate/fetch-quotas.js';
import { deviceStatus, transferPlan,                      } from '../../multicloud/plan/estate/transfer.js';
import { DISPOSITION_OPTIONS, METHOD_OPTIONS, PLATFORM_LABELS, PLATFORM_VALUES, labelOf } from '../../multicloud/plan/options.js';
                                                      
                                                                     
import { planModel } from './plan-model.js';
import { chosenCloudOf } from './cloud-choice.js';
import { fill, note, rowsTable, subhead } from './pane-kit.js';

/** Rows of the decision table shown before "Show all". */
const DECISION_ROWS = 100;

const GROUP_BY                                                       = [
  { value: 'app', label: 'Per application' },
  { value: 'wave', label: 'Per wave' },
  { value: 'site', label: 'Per site' },
];
const SHARES = ['25', '50', '75', '100'];
const CHANGE_RATES = ['1', '2', '5', '10', '20'];
const SEED_DAYS = ['3', '7', '14', '30'];

const picker = (label        , values                                             , current        , onChange                     , control        )              => {
  const s = el('select', { attrs: { 'data-control': control, 'aria-label': label } })                     ;
  for (const v of values) {
    const o = el('option', { text: v.label, attrs: { value: v.value } })                     ;
    if (v.value === current) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return el('div', { class: 'field' }, el('label', { text: label }), s);
};

/** Mount the estate check into `root`. It follows the plan as it changes. */
export function mountEstateCheck(root             , ctx             )       {
  const body = el('div', { class: 'stack', attrs: { 'data-control': 'estate-check' }, style: { overflowWrap: 'anywhere' } });
  append(root, body);
  let actuals                = [];
  let quotaFindings            = [];
  let transfer = { groupBy: 'app'                   , site: '', share: '50', changeRate: '5', seedDays: '7' };
  let showAll = false;

  const draw = ()       => {
    clear(body);
    const plan = ctx.session.plan();
    const model = planModel(plan);
    if (model.failure) {
      append(body, card('Estate check', el('div', { class: 'tip warn' }, el('strong', { text: 'The plan could not be decided: ' }), el('span', { text: model.failure }))));
      return;
    }
    if (plan.apps.length === 0 && plan.workloads.length === 0) {
      append(body, card('Estate check', note('Nothing to check yet: the plan has no applications or servers.')));
      return;
    }
    const { decision, design } = model;
    const check = estateCheck(plan, decision);

    // ---- placement --------------------------------------------------------
    const used = [...new Set(Object.values(check.placement))];
    const lzState = (p          )         => {
      const s = plan.execution?.landingZones?.[p];
      return s === 'generated' ? 'Generated' : s === 'designed' ? 'Designed' : 'Missing';
    };
    const licences = licenceTotals(decision);
    const licenceRows = PLATFORM_VALUES.flatMap((p) => Object.entries(licences[p] ?? {}).map(([kind, n]) => [PLATFORM_LABELS[p], kind, String(n)]));
    append(body, card(
      'Estate placement check',
      note(`${used.length} platform${used.length === 1 ? '' : 's'} in use (${check.chosenPlatforms.length} by the apps' choice), against a maximum of ${plan.requirements.maxPlatforms}.`, 'placement-summary'),
      rowsTable(['Application', 'Lands on', 'How'], plan.apps.filter((a) => check.placement[a.name]).map((a) => {
        const chosen = chosenCloudOf(plan, a.id);
        return [el('a', { text: a.name, attrs: { href: `migration.html#app:${appSlug(a.id)}` } }), PLATFORM_LABELS[check.placement[a.name]            ], chosen ? 'Chosen' : 'Recommended, not chosen'];
      }), { control: 'placement' }),
      subhead('Landing zones'),
      rowsTable(['Platform', 'State'], used.map((p) => [PLATFORM_LABELS[p], lzState(p)]), { control: 'landing-zone-state' }),
      el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: 'Landing zones →', attrs: { href: '#landing-zones' } })),
      subhead('Licences'),
      licenceRows.length === 0 ? note('No licence counts: nothing placed needs a counted licence.') : rowsTable(['Platform', 'Licence', 'Count'], licenceRows, { numeric: [2] }),
      findingsList(check.findings, 'The placements agree with the estate constraints.'),
    ));

    // ---- decision tables (read-only) -----------------------------------------
    const workloadApp = new Map                ([...plan.workloads.map((w) => [w.id, w.app]         ), ...plan.databases.map((d) => [d.id, d.app]         )]);
    const names = new Map                ([...plan.workloads.map((w) => [w.id, w.name]         ), ...plan.databases.map((d) => [d.id, d.name]         )]);
    const items = Object.values(decision.items);
    const shown = showAll ? items : items.slice(0, DECISION_ROWS);
    const appLink = (id        ) => {
      const app = findApp(plan, workloadApp.get(id) ?? '');
      return app ? el('a', { text: app.name, attrs: { href: `migration.html#app:${appSlug(app.id)}` } }) : (workloadApp.get(id) || '—');
    };
    append(body, card(
      'Decision tables',
      note('Read-only here: open an application to change its placement.'),
      rowsTable(
        ['Item', 'Kind', 'Application', 'Disposition', 'Method', 'Platform', 'Service', 'Margin', 'Reasons'],
        shown.map((d) => [
          names.get(d.id) ?? d.id, d.kind === 'database' ? 'Database' : 'Server', appLink(d.id),
          labelOf(DISPOSITION_OPTIONS, d.disposition), labelOf(METHOD_OPTIONS, d.method),
          d.chosen ? PLATFORM_LABELS[d.chosen.platform] : '—', d.chosen?.service ?? '', d.margin >= 99 ? 'only option' : String(d.margin),
          (d.chosen?.hits ?? []).slice(0, 3).map((h) => h.rule).join(', '),
        ]),
        { numeric: [7], control: 'decision-table' },
      ),
      items.length > DECISION_ROWS && !showAll
        ? el('button', { class: 'btn btn-small', text: `Show all ${items.length}`, attrs: { type: 'button' }, on: { click: () => ((showAll = true), draw()) } })
        : null,
    ));

    // ---- capacity and quotas ---------------------------------------------------
    const capacity = estateCapacity(plan, decision, { design });
    const quotas = checkQuotas(capacity, actuals);
    const importBox = el('input', { attrs: { type: 'file', accept: '.json,application/json', 'data-control': 'import-quotas', 'aria-label': 'Import quotas.json' } })                    ;
    importBox.addEventListener('change', () => {
      const file = importBox.files?.[0];
      if (!file) return;
      void readFileAsText(file).then((text) => {
        const read = parseQuotasJson(text);
        actuals = read.actuals;
        quotaFindings = read.findings;
        draw();
      });
    });
    append(body, card(
      'Capacity and quotas',
      rowsTable(
        ['Platform', 'Landing zone', 'Region', 'Instances', 'vCPU', 'RAM (GiB)', 'Storage (GiB)', 'Databases', 'VMware hosts'],
        capacity.platforms.map((c) => [
          PLATFORM_LABELS[c.platform], c.landingZone, c.region, String(c.instances), String(c.vcpu), String(Math.round(c.ramGib)),
          String(Math.round(c.storage.reduce((s, x) => s + x.gib, 0))), String(c.databases.reduce((s, x) => s + x.count, 0)), String(c.vmwareHosts),
        ]),
        { numeric: [3, 4, 5, 6, 7, 8], control: 'capacity-totals' },
      ),
      subhead('Quotas'),
      note('The defaults are published figures that differ by account age and are raised on request: run the fetch-quotas script with your own credentials, then import the quotas.json it writes.'),
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn btn-small', text: 'Download fetch-quotas.sh', attrs: { type: 'button', 'data-control': 'download-fetch-quotas' },
          on: { click: () => downloadFile('fetch-quotas.sh', fetchQuotasScript(plan), 'text/x-shellscript') },
        }),
        el('label', { class: 'btn btn-small' }, 'Import quotas.json', importBox),
      ),
      actuals.length > 0 ? note(`${actuals.length} actual quota${actuals.length === 1 ? '' : 's'} imported.`) : null,
      quotas.rows.length === 0 ? note('No quota applies to the platforms in use.') : rowsTable(
        ['Platform', 'Region', 'Quota', 'Needed', 'Default', 'Actual', 'Headroom', 'Status', 'Source'],
        quotas.rows.map((r) => [
          PLATFORM_LABELS[r.platform], r.region, `${r.quota}${r.wave ? ` (wave ${r.wave})` : ''}`, `${r.needed} ${r.unit}`, r.default === undefined ? '—' : String(r.default),
          r.actual === undefined ? '—' : String(r.actual), r.headroom === undefined ? '—' : String(r.headroom),
          r.status === 'over' ? 'Over' : r.status === 'ok' ? 'OK' : 'Unknown',
          el('span', {}, el('a', { text: 'source', attrs: { href: r.source, target: '_blank', rel: 'noopener' } }), ' ', verificationBadge(r.verification)),
        ]),
        { numeric: [4, 5, 6], control: 'quota-grid' },
      ),
      findingsList([...quotaFindings, ...quotas.findings, ...capacity.findings], 'No capacity issues found.'),
    ));

    // ---- transfer time ------------------------------------------------------------
    const sites = plan.requirements.sites;
    const tp = transferPlan(plan, decision, {
      groupBy: transfer.groupBy,
      ...(transfer.site ? { site: transfer.site } : {}),
      share: Number(transfer.share) / 100,
      changeRatePct: Number(transfer.changeRate),
      seedDaysMax: Number(transfer.seedDays),
    });
    const change = (patch                          ) => {
      transfer = { ...transfer, ...patch };
      draw();
    };
    append(body, card(
      'Data transfer time',
      el('div', { class: 'two' },
        picker('Group by', GROUP_BY, transfer.groupBy, (v) => change({ groupBy: v                    }), 'transfer-group-by'),
        picker('Site the data leaves from', sites.length === 0 ? [{ value: '', label: 'No sites in the plan' }] : sites.map((s) => ({ value: s.name, label: `${s.name} (${s.bandwidth})` })), transfer.site || sites[0]?.name || '', (v) => change({ site: v }), 'transfer-site'),
        picker('Share of the link for migration', SHARES.map((v) => ({ value: v, label: `${v}%` })), transfer.share, (v) => change({ share: v }), 'transfer-share'),
        picker('Daily change (when not measured)', CHANGE_RATES.map((v) => ({ value: v, label: `${v}% a day` })), transfer.changeRate, (v) => change({ changeRate: v }), 'transfer-change'),
        picker('Longest acceptable seed', SEED_DAYS.map((v) => ({ value: v, label: `${v} days` })), transfer.seedDays, (v) => change({ seedDays: v }), 'transfer-seed-days'),
      ),
      tp.groups.length === 0 ? note('Nothing moves over the network.') : rowsTable(
        ['Group', 'Volume (GiB)', 'Daily change (GiB)', 'Link (Mbit/s)', 'For migration (Mbit/s)', 'Seed days', 'Keeps up', 'Offline seeding'],
        tp.groups.map((g) => [
          g.key, String(Math.round(g.volumeGib)), String(Math.round(g.dailyChangeGib)), String(g.linkMbps), String(Math.round(g.effectiveMbps)),
          String(Math.round(g.seedDays * 10) / 10), g.keepsUp ? 'Yes' : 'No',
          Object.entries(g.offline).flatMap(([p, list]) => (list ?? []).map((d) => `${PLATFORM_LABELS[p            ]}: ${d.name} (${deviceStatus(d)})`)).join('; ') || '—',
        ]),
        { numeric: [1, 2, 3, 4, 5], control: 'transfer-table' },
      ),
      tp.assumptions.length > 0 ? el('ul', { class: 'small muted' }, ...tp.assumptions.map((a) => el('li', { text: a }))) : null,
      el('p', { class: 'small muted' }, 'Method: ', el('a', { text: 'source', attrs: { href: tp.source, target: '_blank', rel: 'noopener' } })),
      findingsList(tp.findings, 'Every group seeds in time and keeps up.'),
    ));
  };

  draw();
  let timer                                           ;
  ctx.session.subscribe((_p      , kind) => {
    if (kind === 'saved') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(draw, kind === 'edit' ? 300 : 0);
  });
}
