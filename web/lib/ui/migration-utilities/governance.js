/**
 * Governance (`#waves:governance[/<section>]`) on Multi-Cloud Migration &
 * Utilities (addendum A.10.2–A.10.8, A.10.18): a sub-view of Waves.
 *
 * - RACI: the one editor of `plan.governance.raci`, a " | " grid with an
 *   R / A / C / I dropdown per role (exactly one A per activity is checked),
 *   CSV in and out, and the settings beside it (change-request system,
 *   notice sender and helpdesk text, CI/CD).
 * - Sign-offs: every sign-off the plan needs and its state, recorded by
 *   role (the RACI decides who may sign), and the printable sheets.
 * - Communications: each wave's notices rendered from the plan; nothing is
 *   sent; mark each as sent.
 * - Change requests: one per wave and per utility change, with the
 *   ServiceNow import CSV and the Table API script; record the CR number
 *   and status (G1 checks it).
 * - CMDB: new CIs, retired CIs, relationships and the asset register.
 * - Licences: the reclaim ledger.
 * - Rate card: your own rates (the toolkit carries none), CSV in and out, a
 *   template of the keys the plan needs.
 * - Audit: the audit trail of plan changes, filtered, as CSV.
 */

import { el, append, downloadFile } from '../dom.js';
import { card, findingsList } from '../components.js';
                                                    
import { zip } from '../../kit/archive.js';
                                                      
import {
  CICD_OPTIONS, CR_STATUS_OPTIONS, CR_SYSTEM_OPTIONS, LICENCE_RECLAIM_STATUS_OPTIONS, PLATFORM_OPTIONS, RACI_CELL_OPTIONS, RACI_PHASE_OPTIONS,
  RATE_CATEGORY_OPTIONS, RECLAIMED_LICENCE_OPTIONS, SIGN_OFF_DECISION_OPTIONS, SIGN_OFF_KIND_OPTIONS, defaultGovernance, labelOf,
} from '../../multicloud/plan/options.js';
             
                                                                                                                                          
                                                   
                                        
import { RACI_ROLES, defaultRaci, parseRaciCsv, raciCsv, raciFiles, raciRoleLabel, validateRaci } from '../../multicloud/plan/governance/raci.js';
import { recordSignOff, signOffFiles, whoCanSign } from '../../multicloud/plan/governance/signoffs.js';
import { COMMS_TEMPLATES, commsFiles, renderNotice, waveOfApps, waveViews,                      } from '../../multicloud/plan/governance/comms.js';
import { changeRequestFiles, changeRequests, changeRequestsCsv } from '../../multicloud/plan/governance/changes.js';
import { cmdbFiles } from '../../multicloud/plan/governance/cmdb.js';
import { LEDGER_COLUMNS, ledgerCsv, reclaimLedger } from '../../multicloud/plan/governance/licences.js';
import { emptyRateCard, parseRateCard, rateCardCsv, rateCardTemplate } from '../../multicloud/plan/governance/ratecard.js';
import { auditCsv, filterAudit } from '../../multicloud/plan/governance/audit.js';
import { signOffId } from '../../multicloud/plan/track/gates.js';
import { newRunId } from '../../multicloud/plan/track/states.js';
import { loadAuditEntries, loadChangeRecords, loadRateCard, saveRateCard } from '../../multicloud/plan/store.js';
                                                              
import { planGrid,               } from '../multicloud/grid.js';
import { fill, note, rowsTable, subhead } from '../multicloud/pane-kit.js';
import { computedColumn, numberColumn, selectColumn, textColumn } from './raid.js';
import { commitTracker, otherPlanNode, todayIso, watchTrack, waveEvent, withEvent,                } from './track-kit.js';

export const SECTIONS = [
  { id: 'raci', label: 'RACI' },
  { id: 'signoffs', label: 'Sign-offs' },
  { id: 'comms', label: 'Communications' },
  { id: 'crs', label: 'Change requests' },
  { id: 'cmdb', label: 'CMDB' },
  { id: 'licences', label: 'Licences' },
  { id: 'ratecard', label: 'Rate card' },
  { id: 'audit', label: 'Audit' },
]         ;
                                                      

/** `governance/<section>` → the section (RACI by default). */
export function sectionOf(arg        )          {
  const s = arg.split('/')[1] ?? '';
  return (SECTIONS.find((x) => x.id === s)?.id ?? 'raci')           ;
}

// ---------------------------------------------------------------------------
// RACI as grid rows (pure)
// ---------------------------------------------------------------------------

                                                                                                                                                                         

export const toGridRows = (rows                    )                => rows.map((r, i) => ({ id: `r${i}`, ...r }));
export const fromGridRows = (rows                        )            => rows.map(({ activity, phase, cells }) => ({ activity, phase, cells }));

const RACI_CHOICES = RACI_CELL_OPTIONS.map((o) => ({ value: o.value, label: o.value }));

/** Activity | Phase | one R/A/C/I dropdown per role. */
export function raciColumns()                                     {
  return [
    textColumn             ('activity', 'Activity'),
    selectColumn             ('phase', 'Phase', RACI_PHASE_OPTIONS),
    ...RACI_ROLES.map((role)                          => ({
      key: role,
      label: raciRoleLabel(role),
      options: [{ value: '', label: '—' }, ...RACI_CHOICES],
      get: (r) => r.cells[role] ?? '',
      set: (r, text) => {
        const t = text.trim().toUpperCase();
        if (t && !['R', 'A', 'C', 'I'].includes(t)) return { error: `${raciRoleLabel(role)}: “${text.trim()}” is not R, A, C or I.` };
        const cells = { ...r.cells }                              ;
        if (t) cells[role] = t            ;
        else delete cells[role];
        return { patch: { cells } };
      },
    })),
  ];
}

/** The RACI the plan uses: its own, or the default until it is edited. */
export function raciOf(plan      )                                    {
  const own = plan.governance?.raci ?? [];
  return own.length ? { rows: [...own], own: true } : { rows: defaultRaci(plan), own: false };
}

// ---------------------------------------------------------------------------
// Sign-offs needed (pure; ids as the gates read them)
// ---------------------------------------------------------------------------

                                                                                                                                                                                              

/**
 * Every sign-off the plan needs, with the ids the gate engine reads: the app
 * name (plan and design approval), `<app>@wave-<n>` (test passed, accepted),
 * the wave number (go, decommission approval) and 'dc' (lights-out).
 */
export function neededSignOffs(plan                             , tracker                           , appWave                                  )                  {
  const state = (kind             , id        )                         => {
    const last = tracker.signoffs.filter((s) => s.kind === kind && s.id === id).sort((a, b) => a.at.localeCompare(b.at)).pop();
    return last ? last.decision : 'missing';
  };
  const out                  = [];
  for (const a of [...plan.apps].sort((x, y) => x.name.localeCompare(y.name))) {
    out.push({ kind: 'plan-approved', scope: 'app', id: a.name, label: a.name, state: state('plan-approved', a.name) });
    out.push({ kind: 'design-approved', scope: 'app', id: a.name, label: a.name, state: state('design-approved', a.name) });
    const w = appWave[a.name];
    if (w !== undefined) {
      for (const kind of ['test-passed', 'accepted']         ) {
        const id = signOffId(a.name, w);
        out.push({ kind, scope: 'app', id, label: `${a.name}, wave ${w}`, state: state(kind, id) });
      }
    }
  }
  for (const w of [...new Set(Object.values(appWave))].sort((x, y) => x - y)) {
    for (const kind of ['go', 'decom-approved']         ) out.push({ kind, scope: 'wave', id: String(w), label: `Wave ${w}`, state: state(kind, String(w)) });
  }
  if (plan.mode === 'dc-exit') out.push({ kind: 'lights-out', scope: 'dc', id: 'dc', label: 'The data centre', state: state('lights-out', 'dc') });
  return out;
}

/** A CR row (upsert by id). */
export function upsertCr(crs                      , cr           )              {
  const i = crs.findIndex((c) => c.id === cr.id);
  return i < 0 ? [...crs, cr] : crs.map((c, j) => (j === i ? cr : c));
}

/** The rate card as grid rows. */
                                                                    
export const RATE_PLATFORM_OPTIONS = [...PLATFORM_OPTIONS.map((o) => ({ value: o.value, label: o.value === 'google' ? 'Google Cloud (GCP)' : o.label })), { value: 'on-prem', label: 'On-premises (run-rate exited)' }];
export function rateColumns()                                     {
  return [
    selectColumn             ('platform', 'Platform', RATE_PLATFORM_OPTIONS),
    textColumn             ('region', 'Region'),
    selectColumn             ('category', 'Category', RATE_CATEGORY_OPTIONS),
    textColumn             ('key', 'Key'),
    textColumn             ('unit', 'Unit'),
    numberColumn             ('rate', 'Rate', false, true),
    textColumn             ('currency', 'Currency'),
    textColumn             ('source', 'Source'),
    computedColumn             ('label', 'Shown as', (r) => `estimate from your rates (source: ${r.source || 'not given'})`),
  ];
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

const selectOf = (label        , options                                             , value        , control        , onChange                      = () => undefined)                    => {
  const s = el('select', { attrs: { 'aria-label': label, 'data-control': control } })                     ;
  for (const o of options) append(s, el('option', { text: o.label, attrs: { value: o.value } }));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
};
const field = (label        , control             )              => el('div', { class: 'field' }, el('label', { text: label }), control);
const btn = (label        , control        , run            )              => el('button', { class: 'btn btn-small', text: label, attrs: { type: 'button', 'data-control': control }, on: { click: run } });
const zipDownload = (name        , files                        , when        ) => void zip(files, new Date(when)).then((b) => downloadFile(name, b, 'application/zip'));

export function mount(root             , ctx             )       {
  let section          = sectionOf(ctx.arg());
  let current                       ;
  let raciGrid                      ;
  let lastRaci                                ;
  let rateGrid                      ;
  let ratecard           = emptyRateCard();
  let audit                        = [];
  let auditArea = '';
  let commsWave = '';
  let commsTemplate                  = 't-14-announce';

  const tabs = el('div', { class: 'btn-row', attrs: { role: 'tablist', 'aria-label': 'Governance', 'data-control': 'governance-sections' } });
  const banner = el('div');
  const body = el('div', { class: 'stack', style: { minWidth: '0', overflowWrap: 'anywhere' } });
  append(root, el('div', { class: 'stack', style: { minWidth: '0' } },
    card('Governance', note('RACI, sign-offs, communications, change requests, the CMDB, licences, your rate card and the audit trail.'), tabs,
      el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: '← Waves', attrs: { href: '#waves' } }))),
    banner, body));

  ctx.onArg((arg) => {
    if (!arg.startsWith('governance')) return;
    section = sectionOf(arg);
    raciGrid = undefined;
    rateGrid = undefined;
    if (current) draw(current);
  });

  const drawTabs = () => fill(tabs, ...SECTIONS.map((s) => el('a', {
    class: `btn btn-small${s.id === section ? ' btn-primary' : ''}`, text: s.label,
    attrs: { href: `#waves:governance/${s.id}`, role: 'tab', 'aria-selected': s.id === section ? 'true' : 'false', 'data-section': s.id },
  })));

  const updateGov = (change                               ) => ctx.session.update((p) => ({ ...p, governance: change(p.governance ?? defaultGovernance()) }));

  const draw = (v           )       => {
    current = v;
    drawTabs();
    fill(banner, otherPlanNode(v, ctx));
    switch (section) {
      case 'raci': return drawRaci(v);
      case 'signoffs': return drawSignOffs(v);
      case 'comms': return drawComms(v);
      case 'crs': return drawCrs(v);
      case 'cmdb': return drawCmdb(v);
      case 'licences': return drawLicences(v);
      case 'ratecard': return drawRateCard();
      default: return drawAudit();
    }
  };

  // ---- RACI ------------------------------------------------------------------------
  const raciFindings = el('div', { attrs: { 'data-control': 'raci-findings' } });
  function drawRaci(v           )       {
    const { own } = raciOf(v.plan);
    const gov = v.plan.governance ?? defaultGovernance();
    if (!raciGrid || !body.contains(raciGrid.root)) {
      raciGrid = planGrid             ({
        id: 'raci', noun: 'activity', columns: raciColumns(),
        read: () => toGridRows(raciOf(ctx.session.plan()).rows),
        write: (rows) => {
          const raci = fromGridRows(rows);
          lastRaci = raci;
          updateGov((g) => ({ ...g, raci }));
        },
        create: () => ({ id: `r${Date.now()}`, activity: '', phase: 'migrate', cells: {} }),
        filterKeys: ['phase'], bulkKeys: ['phase', ...RACI_ROLES], pageSize: 100,
        csv: {
          fileName: 'raci.csv',
          export: (rows) => raciCsv(fromGridRows(rows)),
          import: (text) => {
            const r = parseRaciCsv(text);
            return { rows: toGridRows(r.rows), findings: r.findings };
          },
        },
        onChange: () => fill(raciFindings, findingsList(validateRaci(raciOf(ctx.session.plan()).rows), 'Every activity has exactly one A.')),
      });
      fill(body,
        card('RACI',
          note('R responsible · A accountable (exactly one per activity) · C consulted · I informed. Roles, not people: the roles are the sign-off roles.'),
          own ? null : el('div', { class: 'tip', text: 'Showing the default RACI for the platforms in use; your first edit keeps it in the plan.' }),
          raciGrid.root, raciFindings,
          el('div', { class: 'btn-row' },
            btn('Download raci.md and raci.csv (.zip)', 'raci-download', () => zipDownload('raci.zip', raciFiles(raciOf(ctx.session.plan()).rows), v.plan.savedAt)),
            btn('Reset to the default', 'raci-reset', () => {
              if (globalThis.confirm && !globalThis.confirm('Put the RACI back to the default? Your edits are lost.')) return;
              updateGov((g) => ({ ...g, raci: defaultRaci(ctx.session.plan()) }));
              raciGrid = undefined;
              if (current) drawRaci(current);
            }))),
        card('Settings', settingsForm(gov)),
      );
    } else if (!raciGrid.busy() && v.plan.governance?.raci !== lastRaci) {
      raciGrid.render();
    }
    fill(raciFindings, findingsList(validateRaci(raciOf(v.plan).rows), 'Every activity has exactly one A.'));
  }

  function settingsForm(gov            )              {
    const text = (label        , value        , control        , set                     ) => {
      const i = el('input', { attrs: { type: 'text', 'data-control': control, 'aria-label': label } })                    ;
      i.value = value;
      i.addEventListener('input', () => set(i.value));
      return field(label, i);
    };
    return el('div', { class: 'two', attrs: { 'data-control': 'governance-settings' } },
      field('Change-request system', selectOf('Change-request system', CR_SYSTEM_OPTIONS, gov.cr.system, 'gov-cr-system', (x) => updateGov((g) => ({ ...g, cr: { ...g.cr, system: x                               } })))),
      field('A change request per wave', selectOf('A change request per wave', [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], gov.cr.perWave ? 'yes' : 'no', 'gov-cr-per-wave', (x) => updateGov((g) => ({ ...g, cr: { ...g.cr, perWave: x === 'yes' } })))),
      text('Notices signed by', gov.comms.sender ?? '', 'gov-comms-sender', (x) => updateGov((g) => ({ ...g, comms: { ...g.comms, sender: x } }))),
      text('Helpdesk text in the notices', gov.comms.helpdesk ?? '', 'gov-comms-helpdesk', (x) => updateGov((g) => ({ ...g, comms: { ...g.comms, helpdesk: x } }))),
      field('CI/CD for the app stacks', selectOf('CI/CD', CICD_OPTIONS, gov.cicd, 'gov-cicd', (x) => updateGov((g) => ({ ...g, cicd: x                       })))),
    );
  }

  // ---- sign-offs ------------------------------------------------------------------
  function drawSignOffs(v           )       {
    const raci = raciOf(v.plan).rows;
    const appWave = waveOfApps(waveViews(v.plan, v.waves));
    const needed = neededSignOffs(v.plan, v.tracker, appWave);
    const kinds = [...new Set(needed.map((n) => n.kind))];
    let kind              = kinds[0] ?? 'plan-approved';
    const form = el('div', { class: 'filter-row', attrs: { 'data-control': 'signoff-form' } });
    const msg = el('div', { class: 'small', attrs: { role: 'status', 'data-control': 'signoff-message' } });
    const drawForm = () => {
      const targets = needed.filter((n) => n.kind === kind);
      const roles = whoCanSign(raci, kind);
      const target = selectOf('For', targets.map((t) => ({ value: t.id, label: t.label })), targets[0]?.id ?? '', 'signoff-for');
      const role = selectOf('Role', roles.map((r) => ({ value: r, label: raciRoleLabel(r) })), roles[0] ?? '', 'signoff-role');
      const decision = selectOf('Decision', SIGN_OFF_DECISION_OPTIONS, 'approved', 'signoff-decision');
      const comment = el('input', { attrs: { type: 'text', placeholder: 'Comment (optional)', 'aria-label': 'Comment', 'data-control': 'signoff-comment' }, style: { flex: '1 1 10rem', minWidth: '0' } })                    ;
      fill(form,
        selectOf('Kind', kinds.map((k) => ({ value: k, label: labelOf(SIGN_OFF_KIND_OPTIONS, k) })), kind, 'signoff-kind', (k) => { kind = k               ; drawForm(); }),
        target, role, decision, comment,
        btn('Record', 'signoff-record', () => {
          const t = targets.find((x) => x.id === target.value);
          if (!t) return;
          const r = recordSignOff(v.tracker, raci, { scope: t.scope, id: t.id, kind, role: role.value            , decision: decision.value                   , at: new Date().toISOString(), ...(comment.value.trim() ? { comment: comment.value.trim() } : {}) });
          if (r.findings.some((f) => f.severity === 'error')) {
            msg.textContent = r.findings.map((f) => f.message).join(' ');
            return;
          }
          void commitTracker(r.tracker, ctx);
        }),
      );
      if (roles.length === 0) append(form, note('No role is R or A for this sign-off in the RACI.'));
    };
    drawForm();
    fill(body, card('Sign-offs',
      note('A sign-off records the role only; write a name in the comment if you want one. The RACI decides which roles may sign.'),
      form, msg,
      needed.length === 0 ? note('No sign-offs needed yet: the plan has no apps.') : rowsTable(['Sign-off', 'For', 'State'], needed.map((n) => [
        labelOf(SIGN_OFF_KIND_OPTIONS, n.kind), n.label,
        el('span', { class: `badge ${n.state === 'approved' ? 'good' : n.state === 'rejected' ? 'danger' : ''}`, text: n.state === 'missing' ? 'Not yet' : labelOf(SIGN_OFF_DECISION_OPTIONS, n.state) }),
      ]), { control: 'signoff-needed' }),
      el('div', { class: 'btn-row' }, btn('Download the sign-off sheets (.zip)', 'signoff-sheets', () => zipDownload('signoff-sheets.zip', signOffFiles(v.plan, raci, v.tracker, appWave), v.plan.savedAt))),
    ));
  }

  // ---- communications ----------------------------------------------------------------
  function drawComms(v           )       {
    const views = waveViews(v.plan, v.waves);
    if (views.length === 0) {
      fill(body, card('Communications', note('No waves yet: plan the waves first.')));
      return;
    }
    if (!views.some((w) => String(w.n) === commsWave)) commsWave = String(views[0]?.n ?? '');
    const wave = views.find((w) => String(w.n) === commsWave) ?? views[0] ;
    const raci = raciOf(v.plan).rows;
    const cctx = { plan: v.plan, wave, raci, ...(v.plan.execution ? { execution: v.plan.execution } : {}), ...(v.plan.governance ? { governance: v.plan.governance } : {}) };
    const templates = COMMS_TEMPLATES.filter((t) => t.id !== 'partner-ip-change' && (t.id !== 'dc-exit-milestone' || v.plan.mode === 'dc-exit'));
    if (!templates.some((t) => t.id === commsTemplate)) commsTemplate = templates[0] .id;
    const n = renderNotice(commsTemplate, cctx);
    const sent = v.tracker.notices.filter((x) => x.wave === wave.n);
    fill(body, card('Communications',
      note('Nothing is sent from here. Send each notice yourself, then mark it as sent: G1 checks the T−14 and T−2 notices.'),
      el('div', { class: 'filter-row' },
        selectOf('Wave', views.map((w) => ({ value: String(w.n), label: `Wave ${w.n}${w.name ? ` (${w.name})` : ''}` })), commsWave, 'comms-wave', (x) => { commsWave = x; drawComms(v); }),
        selectOf('Notice', templates.map((t) => ({ value: t.id, label: `${t.title} — ${t.when}` })), commsTemplate, 'comms-template', (x) => { commsTemplate = x                   ; drawComms(v); })),
      el('pre', { class: 'code', text: n.text, attrs: { 'data-control': 'comms-preview' }, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }),
      el('div', { class: 'btn-row' },
        btn('Download this notice (.md)', 'comms-download', () => downloadFile(`wave-${wave.n}-${commsTemplate}.md`, n.markdown, 'text/markdown')),
        btn(`Download every notice of wave ${wave.n} (.zip)`, 'comms-download-all', () => zipDownload(`wave-${wave.n}-notices.zip`, commsFiles(cctx), v.plan.savedAt)),
        sent.some((x) => x.template === commsTemplate) ? el('span', { class: 'badge good', text: 'Sent' }) : btn('Mark as sent', 'comms-mark-sent', () => {
          const at = new Date().toISOString();
          const t          = { ...v.tracker, notices: [...v.tracker.notices, { template: commsTemplate, wave: wave.n, sentAt: at }] };
          const e = { ...waveEvent(v.tracker.planId, wave.n, `Notice sent: ${commsTemplate}`, { template: commsTemplate }, at, newRunId()), step: 'notice'          };
          void commitTracker(withEvent({ tracker: t, ctx: v.ctx }, e), ctx);
        })),
      subhead('Sent'),
      sent.length === 0 ? note('None recorded for this wave.') : rowsTable(['Notice', 'Sent'], sent.map((x) => [COMMS_TEMPLATES.find((t) => t.id === x.template)?.title ?? x.template, x.sentAt.slice(0, 10)])),
    ));
  }

  // ---- change requests ---------------------------------------------------------------
  function drawCrs(v           )       {
    const views = waveViews(v.plan, v.waves);
    const box = el('div');
    fill(body, card('Change requests', note('One per wave and one per utility change. The CSV uses ServiceNow change_request import field names; create-change-requests.sh uses the Table API and is idempotent by correlation_id. Record the number and status here: G1 checks it.'), box));
    void loadChangeRecords().catch(() => []).then((changes) => {
      const drafts = changeRequests({ ...v.plan, decision: v.decision }, views, { on: todayIso(), ...(v.plan.execution ? { execution: v.plan.execution } : {}), changeRecords: changes });
      const rows = drafts.map((d) => {
        const cr = v.tracker.crs.find((c) => c.id === d.id);
        const number = el('input', { attrs: { type: 'text', placeholder: 'CHG…', 'aria-label': `CR number for ${d.id}`, 'data-control': 'cr-number', 'data-cr': d.id }, style: { width: '8rem' } })                    ;
        number.value = cr?.number ?? '';
        const status = selectOf(`Status of ${d.id}`, CR_STATUS_OPTIONS, cr?.status ?? 'draft', 'cr-status');
        const save = () => {
          const next            = { id: d.id, status: status.value            , ...(number.value.trim() ? { number: number.value.trim() } : {}) };
          void commitTracker({ ...v.tracker, crs: upsertCr(v.tracker.crs, next) }, ctx);
        };
        number.addEventListener('change', save);
        status.addEventListener('change', save);
        return [d.id, d.record.short_description, d.riskBand, d.record.start_date || '—', number, status];
      });
      fill(box,
        drafts.length === 0 ? note('No waves or utility changes yet.') : rowsTable(['Id', 'Summary', 'Risk', 'Start', 'CR number', 'Status'], rows, { control: 'cr-table' }),
        el('div', { class: 'btn-row' },
          btn('change-requests.csv', 'cr-csv', () => downloadFile('change-requests.csv', changeRequestsCsv(drafts), 'text/csv')),
          btn('Every CR, the CSV and the script (.zip)', 'cr-zip', () => zipDownload('change-requests.zip', changeRequestFiles(drafts), v.plan.savedAt))),
      );
    });
  }

  // ---- CMDB ------------------------------------------------------------------------
  function drawCmdb(v           )       {
    const c = cmdbFiles({ ...v.plan, decision: v.decision }, { design: v.design, tracker: v.tracker, script: true });
    const lines = (t        ) => Math.max(0, t.trim().split('\n').length - 1);
    fill(body, card('CMDB and asset register',
      note('New CIs, the source CIs retired at decommission, the app relationships and the asset register. update-cmdb.sh writes them through the ServiceNow Table API (verify the CI class names on your instance).'),
      rowsTable(['File', 'Rows'], Object.entries(c.files).filter(([p]) => p.endsWith('.csv')).map(([p, t]) => [p.replace('governance/cmdb/', ''), String(lines(t))]), { numeric: [1], control: 'cmdb-files' }),
      el('div', { class: 'btn-row' }, btn('Download the CMDB files (.zip)', 'cmdb-zip', () => zipDownload('cmdb.zip', c.files, v.plan.savedAt))),
      findingsList(c.findings, 'The asset register is complete.'),
    ));
  }

  // ---- licences --------------------------------------------------------------------
  function drawLicences(v           )       {
    const ledger = reclaimLedger({ ...v.plan, decision: v.decision }, v.tracker);
    const save = (row                , patch                         ) => {
      const key = (r                ) => `${r.licence}|${r.source}`;
      const next = { ...row, ...patch }                  ;
      const rows = ledger.map((r) => (key(r) === key(row) ? next : r));
      void commitTracker({ ...v.tracker, licences: rows }, ctx);
    };
    fill(body, card('Licence reclaim ledger',
      note('Filled from the decommissions: Windows and SQL cores, Oracle processors when a cluster empties, RHEL and SLES subscriptions, VCF cores and third-party licences. Record where each went.'),
      ledger.length === 0 ? note('Nothing decommissioned yet, so nothing is freed.') : rowsTable([...LEDGER_COLUMNS], ledger.map((r) => {
        const to = el('input', { attrs: { type: 'text', 'aria-label': 'Reassigned to', 'data-control': 'licence-reassigned' }, style: { width: '10rem' } })                    ;
        to.value = r.reassignedTo ?? '';
        to.addEventListener('change', () => save(r, to.value.trim() ? { reassignedTo: to.value.trim() } : { reassignedTo: undefined }));
        const st = selectOf('Status', LICENCE_RECLAIM_STATUS_OPTIONS, r.status, 'licence-status', (x) => save(r, { status: x                         }));
        return [labelOf(RECLAIMED_LICENCE_OPTIONS, r.licence), String(r.count), r.source, r.freedOn, to, st];
      }), { control: 'licence-ledger' }),
      el('div', { class: 'btn-row' }, btn('licence-ledger.csv', 'licence-csv', () => downloadFile('licence-ledger.csv', ledgerCsv(ledger), 'text/csv'))),
    ));
  }

  // ---- rate card -------------------------------------------------------------------
  const rateFindings = el('div');
  function drawRateCard()       {
    if (rateGrid && body.contains(rateGrid.root)) {
      if (!rateGrid.busy()) rateGrid.render();
      return;
    }
    const toRows = (card          )                => card.rows.map((r, i) => ({ ...r, id: `rate${i}` }));
    const store = (rows                        ) => {
      ratecard = { ...ratecard, rows: rows.map(({ id: _id, ...r }) => r           ) };
      void saveRateCard(ratecard);
    };
    rateGrid = planGrid             ({
      id: 'ratecard', noun: 'rate', columns: rateColumns(),
      read: () => toRows(ratecard),
      write: (rows) => store(rows),
      create: () => ({ id: `rate${Date.now()}`, platform: 'aws', region: '', category: 'compute', key: '', unit: 'hour', rate: 0, currency: 'USD', source: '' }),
      filterKeys: ['platform', 'category'], bulkKeys: ['platform', 'region', 'category', 'unit', 'currency', 'source'], pageSize: 100,
      csv: {
        fileName: 'ratecard.csv',
        export: (rows) => rateCardCsv({ rows: rows.map(({ id: _id, ...r }) => r           ) }),
        import: (text) => {
          const r = parseRateCard(text);
          fill(rateFindings, findingsList(r.findings             , ''));
          return { rows: toRows(r.card), findings: r.findings };
        },
      },
    });
    const v = current;
    fill(body, card('Rate card (your rates)',
      note('The toolkit carries no prices. Enter or import your own; every figure made from them is labelled “estimate from your rates (source: …)”. Rows for platform “On-premises” are the run-rate being exited.'),
      rateGrid.root, rateFindings,
      v ? el('div', { class: 'btn-row' }, btn('Template of the keys this plan needs (.csv)', 'ratecard-template', () => downloadFile('ratecard-template.csv', rateCardTemplate({ ...v.plan, decision: v.decision }, v.design), 'text/csv'))) : null,
    ));
  }

  // ---- audit -----------------------------------------------------------------------
  function drawAudit()       {
    const areas = [...new Set(audit.map((a) => a.area))].sort();
    const shown = filterAudit(audit, auditArea ? { area: auditArea } : {});
    fill(body, card('Audit trail',
      note('Changes to the plan, as both pages record them: when, which page, what and to what. No user or machine is recorded.'),
      el('div', { class: 'filter-row' }, selectOf('Area', [{ value: '', label: 'Area: any' }, ...areas.map((a) => ({ value: a, label: a }))], auditArea, 'audit-area', (x) => { auditArea = x; drawAudit(); })),
      shown.length === 0 ? note('No entries.') : rowsTable(['At', 'Page', 'Area', 'Action', 'Targets', 'Summary', 'Role'],
        [...shown].reverse().slice(0, 200).map((e) => [e.at.replace('T', ' ').slice(0, 19), e.page, e.area, e.action, e.targets.join(' '), e.summary, e.role ? raciRoleLabel(e.role) : '']), { control: 'audit-table' }),
      shown.length > 200 ? note(`Showing the latest 200 of ${shown.length}; the CSV has them all.`) : null,
      el('div', { class: 'btn-row' }, btn('audit.csv', 'audit-csv', () => downloadFile('audit.csv', auditCsv(shown), 'text/csv'))),
    ));
  }

  void Promise.all([loadRateCard().catch(() => null), loadAuditEntries().catch(() => [])]).then(([c, a]) => {
    ratecard = c ?? emptyRateCard();
    audit = a;
    rateGrid = undefined;
    if (current && (section === 'ratecard' || section === 'audit')) draw(current);
  });
  watchTrack(ctx, draw);
}
