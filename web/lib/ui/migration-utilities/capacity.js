/**
 * Estate capacity (`#capacity`) on Multi-Cloud Migration & Utilities (addendum
 * A.5.4, A.10.7, A.10.10).
 *
 * - Per wave: what each wave lands on each platform (servers, databases,
 *   vCPU, RAM, storage) and how many items replicate at once.
 * - Totals per platform, landing zone and region.
 * - Quotas: the needs against the published defaults (every default marked
 *   for verification) or the actual quotas imported from `quotas.json`, which
 *   the generated `fetch-quotas.sh` writes; the migration tools' own
 *   per-wave quotas (MGN replicating servers, Azure Migrate concurrent
 *   replications).
 * - Transfer: seed days and keep-up per wave (or app, or site).
 * - Licences, and the estimate from your own rate card, always labelled so
 *   (the toolkit carries no prices).
 */

import { el, append, downloadFile } from '../dom.js';
import { card, findingsList, verificationBadge } from '../components.js';
                                                    
import { PLATFORM_LABELS, LICENCE_KIND_OPTIONS, labelOf } from '../../multicloud/plan/options.js';
                                                                         
import { checkQuotas, estateCapacity, parseQuotasJson,                  } from '../../multicloud/plan/estate/capacity.js';
import { fetchQuotasScript } from '../../multicloud/plan/estate/fetch-quotas.js';
import { estimateDesign } from '../../multicloud/plan/estate/estimate.js';
import { transferPlan, deviceStatus,                      } from '../../multicloud/plan/estate/transfer.js';
import { licenceTotals } from '../../multicloud/plan/decide/index.js';
import { loadRateCard } from '../../multicloud/plan/store.js';
                                                      
import { fill, note, rowsTable, subhead } from '../multicloud/pane-kit.js';
import { filePicker, otherPlanNode, watchTrack,                } from './track-kit.js';

                                  
                        
                               
                           
                             
                        
                          
                              
                                                                            
                               
 

const NO_REPLICATION = new Set(['rebuild', 'retire', 'deploy', 'with-db', 'with-vm', 'specialist', 'appliance-rebuild']);

/** What each wave lands on each platform, from the tracker's items and the plan's sizes. */
export function capacityByWave(view                                    )                    {
  const rows = new Map                                                                                                                                                          ();
  for (const s of Object.values(view.tracker.items)) {
    if (s.removed || s.path === 'retire') continue;
    const platform = view.ctx.platforms.get(s.item);
    const key = `${s.wave}|${platform ?? ''}`;
    const r = rows.get(key) ?? { wave: s.wave, ...(platform ? { platform } : {}), servers: 0, databases: 0, vcpu: 0, ramGib: 0, storageGib: 0, replicating: 0 };
    const z = view.ctx.size.get(s.item);
    if (s.kind === 'database') r.databases += 1;
    else r.servers += 1;
    r.vcpu += z?.vcpu ?? 0;
    r.ramGib += z?.ramGib ?? 0;
    r.storageGib += z?.storageGib ?? 0;
    if (!NO_REPLICATION.has(s.path)) r.replicating += 1;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => a.wave - b.wave || (a.platform ?? '').localeCompare(b.platform ?? ''));
}

const GROUP_BY                                                       = [
  { value: 'wave', label: 'Per wave' },
  { value: 'app', label: 'Per application' },
  { value: 'site', label: 'Per site' },
];
const SHARES = ['25', '50', '75', '100'];

const picker = (label        , values                                             , current        , control        , onChange                     )              => {
  const s = el('select', { attrs: { 'aria-label': label, 'data-control': control } })                     ;
  for (const v of values) append(s, el('option', { text: v.label, attrs: { value: v.value } }));
  s.value = current;
  s.addEventListener('change', () => onChange(s.value));
  return el('div', { class: 'field' }, el('label', { text: label }), s);
};

export function mount(root             , ctx             )       {
  let current                       ;
  let actuals                = [];
  let quotaFindings            = [];
  let ratecard                  = null;
  let groupBy                  = 'wave';
  let site = '';
  let share = '50';
  const banner = el('div');
  const wavesBox = el('div', { attrs: { 'data-control': 'capacity-waves' } });
  const totalsBox = el('div', { attrs: { 'data-control': 'capacity-totals-box' } });
  const quotasBox = el('div', { attrs: { 'data-control': 'capacity-quotas' } });
  const transferBox = el('div', { attrs: { 'data-control': 'capacity-transfer' } });
  const costBox = el('div', { attrs: { 'data-control': 'capacity-estimate' } });
  append(root, el('div', { class: 'stack', style: { minWidth: '0', overflowWrap: 'anywhere' } },
    banner,
    card('Capacity per wave', wavesBox),
    card('Totals per platform', totalsBox),
    card('Quotas', quotasBox),
    card('Data transfer', transferBox),
    card('Licences and estimate', costBox),
  ));

  const draw = (v           )       => {
    current = v;
    fill(banner, otherPlanNode(v, ctx));
    if (v.failure) {
      fill(wavesBox, el('div', { class: 'tip warn', text: `The plan could not be decided: ${v.failure}` }));
      return;
    }
    const byWave = capacityByWave(v);
    fill(wavesBox, byWave.length === 0 ? note('Nothing moves yet.') : rowsTable(
      ['Wave', 'Platform', 'Servers', 'Databases', 'vCPU', 'RAM (GiB)', 'Storage (GiB)', 'Replicating at once'],
      byWave.map((r) => [r.wave === 0 ? 'No wave' : String(r.wave), r.platform ? PLATFORM_LABELS[r.platform] : 'Not placed', String(r.servers), String(r.databases), String(r.vcpu), String(Math.round(r.ramGib)), String(Math.round(r.storageGib)), String(r.replicating)]),
      { numeric: [2, 3, 4, 5, 6, 7], control: 'capacity-per-wave' },
    ));

    let capacity;
    try {
      capacity = estateCapacity({ ...v.plan, decision: v.decision }, v.decision, { design: v.design });
    } catch (e) {
      fill(totalsBox, el('div', { class: 'tip warn', text: `Capacity could not be worked out: ${e instanceof Error ? e.message : String(e)}` }));
      return;
    }
    fill(totalsBox,
      capacity.platforms.length === 0 ? note('No platform in use yet.') : rowsTable(
        ['Platform', 'Landing zone', 'Region', 'Instances', 'vCPU', 'RAM (GiB)', 'Storage (GiB)', 'Databases', 'Kubernetes nodes', 'Public IPs', 'Load balancers', 'VMware hosts', 'Backup (GiB)'],
        capacity.platforms.map((c) => [
          PLATFORM_LABELS[c.platform], c.landingZone, c.region, String(c.instances), String(c.vcpu), String(Math.round(c.ramGib)),
          String(Math.round(c.storage.reduce((s, x) => s + x.gib, 0))), String(c.databases.reduce((s, x) => s + x.count, 0)), String(c.k8s.nodes),
          String(c.publicIps), String(c.loadBalancers), String(c.vmwareHosts), String(Math.round(c.backupGib)),
        ]),
        { numeric: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], control: 'capacity-platforms' },
      ),
      capacity.platforms.some((c) => c.replicationPerWave.length) ? el('div', {}, subhead('Replicating per wave'), rowsTable(['Platform', 'Wave', 'Replicating'],
        capacity.platforms.flatMap((c) => c.replicationPerWave.map((w) => [PLATFORM_LABELS[c.platform], w.wave, String(w.replicating)])), { numeric: [2] })) : null,
    );

    const quotas = checkQuotas(capacity, actuals);
    fill(quotasBox,
      note('The defaults differ by account age and are raised on request. Run the fetch-quotas script with your own credentials, then import the quotas.json it writes.'),
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn btn-small', text: 'Download fetch-quotas.sh', attrs: { type: 'button', 'data-control': 'capacity-fetch-quotas' },
          on: { click: () => downloadFile('fetch-quotas.sh', fetchQuotasScript(v.plan), 'text/x-shellscript') },
        }),
        filePicker('Import quotas.json…', '.json,application/json', false, 'capacity-import-quotas', (files) => {
          void files[0]?.text().then((text) => {
            const read = parseQuotasJson(text);
            actuals = read.actuals;
            quotaFindings = read.findings;
            if (current) draw(current);
          });
        })),
      actuals.length ? note(`${actuals.length} actual quota${actuals.length === 1 ? '' : 's'} imported.`) : null,
      quotas.rows.length === 0 ? note('No quota applies to the platforms in use.') : rowsTable(
        ['Platform', 'Region', 'Quota', 'Needed', 'Default', 'Actual', 'Headroom', 'Status', 'Lead time', 'Source'],
        quotas.rows.map((r) => [
          PLATFORM_LABELS[r.platform], r.region, `${r.quota}${r.wave ? ` (wave ${r.wave})` : ''}`, `${r.needed} ${r.unit}`,
          r.default === undefined ? '—' : String(r.default), r.actual === undefined ? '—' : String(r.actual), r.headroom === undefined ? '—' : String(r.headroom),
          r.status === 'over' ? 'Over' : r.status === 'ok' ? 'OK' : 'Unknown', `${r.leadDays} days`,
          el('span', {}, el('a', { text: 'source', attrs: { href: r.source, target: '_blank', rel: 'noopener' } }), ' ', verificationBadge(r.verification)),
        ]),
        { numeric: [4, 5, 6], control: 'capacity-quota-grid' },
      ),
      findingsList([...quotaFindings, ...quotas.findings, ...capacity.findings], 'No capacity issues found.'),
    );

    const sites = v.plan.requirements.sites;
    const tp = transferPlan({ ...v.plan, decision: v.decision }, v.decision, { groupBy, ...(site ? { site } : {}), share: Number(share) / 100 });
    fill(transferBox,
      el('div', { class: 'two' },
        picker('Group by', GROUP_BY, groupBy, 'capacity-transfer-group', (x) => { groupBy = x                   ; if (current) draw(current); }),
        picker('Site the data leaves from', sites.length ? sites.map((s) => ({ value: s.name, label: `${s.name} (${s.bandwidth})` })) : [{ value: '', label: 'No sites in the plan' }], site || sites[0]?.name || '', 'capacity-transfer-site', (x) => { site = x; if (current) draw(current); }),
        picker('Share of the link for migration', SHARES.map((x) => ({ value: x, label: `${x}%` })), share, 'capacity-transfer-share', (x) => { share = x; if (current) draw(current); })),
      tp.groups.length === 0 ? note('Nothing moves over the network.') : rowsTable(
        ['Group', 'Volume (GiB)', 'Daily change (GiB)', 'For migration (Mbit/s)', 'Seed days', 'Keeps up', 'Offline seeding'],
        tp.groups.map((g) => [g.key, String(Math.round(g.volumeGib)), String(Math.round(g.dailyChangeGib)), String(Math.round(g.effectiveMbps)), String(Math.round(g.seedDays * 10) / 10), g.keepsUp ? 'Yes' : 'No',
          Object.entries(g.offline).flatMap(([p, list]) => (list ?? []).map((d) => `${PLATFORM_LABELS[p            ]}: ${d.name} (${deviceStatus(d)})`)).join('; ') || '—']),
        { numeric: [1, 2, 3, 4], control: 'capacity-transfer-table' },
      ),
      el('p', { class: 'small muted' }, 'Method: ', el('a', { text: 'source', attrs: { href: tp.source, target: '_blank', rel: 'noopener' } })),
      findingsList(tp.findings, 'Every group seeds in time and keeps up.'),
    );

    const lic = licenceTotals(v.decision);
    const licRows = (Object.keys(lic)              ).flatMap((p) => Object.entries(lic[p] ?? {}).map(([k, n]) => [PLATFORM_LABELS[p], labelOf(LICENCE_KIND_OPTIONS, k), String(n)]));
    const est = estimateDesign({ ...v.plan, decision: v.decision }, v.decision, v.design, ratecard ?? undefined);
    const money = (t                                                             ) => (t ?? []).map((x) => `${x.amount.toLocaleString()} ${x.currency}`).join(' + ') || '—';
    fill(costBox,
      subhead('Licences needed'),
      licRows.length ? rowsTable(['Platform', 'Licence', 'Count'], licRows, { numeric: [2] }) : note('Nothing placed needs a counted licence.'),
      subhead('Estimate'),
      el('p', { class: 'small', text: est.label, attrs: { 'data-control': 'capacity-estimate-label' } }),
      est.available ? rowsTable(['Platform', 'Monthly (run)', 'One-time (migration)'], (Object.keys({ ...est.monthly, ...est.oneTime })              ).map((p) => [PLATFORM_LABELS[p], money(est.monthly[p]), money(est.oneTime[p])]), { control: 'capacity-estimate-table' }) : null,
      est.available && est.noRate.length ? note(`No rate for ${est.noRate.length} count${est.noRate.length === 1 ? '' : 's'} (for example ${est.noRate.slice(0, 3).map((c) => `${c.category} ${c.key}`).join(', ')}).`) : null,
      el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: 'Rate card (Waves › Governance) →', attrs: { href: '#waves:governance/ratecard' } })),
    );
  };

  void loadRateCard().catch(() => null).then((c) => {
    ratecard = c;
    if (current) draw(current);
  });
  watchTrack(ctx, draw);
}
