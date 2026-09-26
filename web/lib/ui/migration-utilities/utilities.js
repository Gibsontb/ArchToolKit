/**
 * Utilities (`#utilities`, `#utilities:<utility-id>`) on Multi-Cloud Migration
 * & Utilities (addendum A.9, with the lead's naming: the day-2 area is
 * Utilities).
 *
 * - One cloud at a time: the cloud dropdown first (multicloud/cloud-choice.ts,
 *   shared with Landing zones, Estate capacity and the Execute settings);
 *   nothing shows until a cloud is chosen, and nothing defaults to one.
 * - The catalogue, by category, for the chosen cloud; Deploy a new service
 *   (A.9.3) is one of the utilities.
 * - A utility's form, drawn from its inputs with `renderBlueprintForm`, on
 *   the chosen cloud (its platform input is the dropdown above), dropdowns wherever the set is closed, and the inputs fed
 *   from the plan (its servers and the tracker's cut-over targets, apps, new
 *   apps, components, clusters, databases, DNS zones and load balancers).
 * - Generate: the change bundle (`change-<yyyymmdd>-<utility>-<target>/`), its
 *   files and findings, the plan update where the utility makes one, and the
 *   download (blocked while there is an error). Downloading records the
 *   change in the utility log.
 * - The utility log: `Id | Utility | Target | Summary | Generated | Applied |
 *   Rolled back | CR`, with the CR number editable and the scripts' status
 *   events imported to fill Applied and Rolled back.
 */

import { el, append, clear, downloadFile } from '../dom.js';
import { card, findingsList } from '../components.js';
import { renderBlueprintForm } from '../blueprint-form.js';
                                                    
                                                              
import { zip } from '../../kit/archive.js';
import { PLATFORM_LABELS } from '../../multicloud/plan/options.js';
                                                                                            
import {
  CHANGE_LOG_COLUMNS, buildChangeBundle, changeState, defaultUtilityValues, describePlanOp, findUtility, importUtilityEvents,
  loadUtilityLog, recordUtilityRun, setUtilityCr, utilitiesByCategory, utilityInputs,
                                                                                
} from '../../multicloud/change/index.js';
import { planModel } from '../multicloud/plan-model.js';
import { fill, note, rowsTable, subhead } from '../multicloud/pane-kit.js';
import { CLOUD_NAMES, cloudPicker, cloudUsage, isCloud, onCloudChange, rememberCloud, resolveCloud, viewerCloud } from '../multicloud/cloud-choice.js';
import { filePicker, todayIso, trackerRecord } from './track-kit.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The platform label the utilities use (VCF 9.1 for VMware; Google Cloud (GCP)). */
export function platformName(p          )         {
  return p === 'vmware' ? 'VMware Cloud Foundation (VCF 9.1)' : p === 'google' ? 'Google Cloud (GCP)' : PLATFORM_LABELS[p];
}

/** The catalogue by category, keeping only the utilities a platform supports ('' = all). */
export function catalogue(platform               )                                                  {
  return utilitiesByCategory()
    .map((g) => ({ label: g.label, utilities: g.utilities.filter((u) => !platform || u.platforms.includes(platform)) }))
    .filter((g) => g.utilities.length > 0);
}

/** The inputs the form draws for a utility, as the values stand (plan-fed options filled). */
export function formInputs(u               , values                 , ctx                )                 {
  return utilityInputs(u, values, ctx);
}

/** The context a utility is built in: the plan with its decision, the tracker of the same plan, the change date. */
export function utilityContext(plan      , tracker                , date        )                 {
  const decided = plan.decision ? plan : { ...plan, decision: planModel(plan).decision };
  return { plan: decided, ...(tracker && tracker.planId === plan.id ? { tracker } : {}), date, now: `${date}T00:00:00.000Z` };
}

/** The plan to save after a utility's plan update: the update, without the decision the context added. */
export function planAfter(original      , bundle                            )                   {
  if (!bundle.plan) return undefined;
  const { decision: _d, ...rest } = bundle.plan;
  return original.decision ? { ...rest, decision: original.decision } : (rest        );
}

/** The log's rows for the grid. */
export function logRows(records                         )             {
  return [...records].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.id.localeCompare(b.id)).map((r) => [
    r.id, findUtility(r.utility)?.label ?? r.utility, r.target, r.summary, r.generatedAt.slice(0, 10), r.appliedAt?.slice(0, 10) ?? '', r.rolledBackAt?.slice(0, 10) ?? '', r.cr ?? '',
  ]);
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

const RISK_TEXT = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' }         ;

export function mount(root             , ctx             )       {
  const valuesById = new Map                                ();
  let bundle                          ;
  let bundleFor = '';
  let tracker                 = null;
  let date = todayIso();

  const main = el('div', { class: 'stack', style: { minWidth: '0', overflowWrap: 'anywhere' } });
  const logBox = el('div', { class: 'stack', attrs: { 'data-control': 'utility-log' } });
  append(root, el('div', { class: 'stack', style: { minWidth: '0' } }, main, card('Utility log', logBox)));

  /** The chosen cloud (never a default). */
  const cloudNow = ()                       => {
    const plan = ctx.session.plan();
    return resolveCloud('', viewerCloud(), cloudUsage(plan, planModel(plan).decision));
  };
  const picker = (prompt        ) => {
    const plan = ctx.session.plan();
    return cloudPicker({ cloud: cloudNow(), usage: cloudUsage(plan, planModel(plan).decision), control: 'utilities-platform', onChange: () => undefined, prompt });
  };

  const route = () => {
    const id = ctx.arg().split('/')[0] ?? '';
    const u = id ? findUtility(id) : undefined;
    if (u) drawUtility(u);
    else drawCatalogue(id);
  };

  // ---- catalogue -----------------------------------------------------------------
  function drawCatalogue(unknown        )       {
    const cloud = cloudNow();
    const groups = cloud ? catalogue(cloud) : [];
    const deploy = findUtility('deploy-service');
    fill(main,
      card(cloud ? `Utilities: ${CLOUD_NAMES[cloud]}` : 'Utilities',
        note('Small day-2 changes without a migration: each is a form that produces a change bundle of Terraform and / or Ansible against the landing zone, with apply.sh (applies by default; --dry-run to preview), rollback.sh and a status event.'),
        unknown ? el('div', { class: 'tip warn', text: `There is no utility “${unknown}”.` }) : null,
        picker('Choose the cloud to change. One cloud at a time.'),
        cloud && deploy && deploy.platforms.includes(cloud)
          ? el('div', { class: 'tip' }, el('strong', { text: `${deploy.label}. ` }), deploy.description, ' ', el('a', { class: 'btn btn-small', text: 'Open →', attrs: { href: `#utilities:${deploy.id}`, 'data-control': 'utility-open-deploy' } }))
          : null),
      ...groups.map((g) => card(g.label, el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 16rem), 1fr))', gap: 'var(--space-3)' },
        attrs: { 'data-control': 'utility-category' },
      }, ...g.utilities.map((u) => el('a', {
        class: 'card', attrs: { href: `#utilities:${u.id}`, 'data-control': 'utility-card', 'data-utility': u.id },
        style: { margin: '0', display: 'block', textDecoration: 'none', color: 'inherit' },
      },
      el('strong', { text: u.label }),
      el('div', { class: 'small', text: u.description }),
      el('div', { class: 'small muted', text: `${RISK_TEXT[u.risk]} · ${u.reversible ? 'reversible' : 'compensating rollback'}` }))))))
    );
  }

  // ---- one utility ------------------------------------------------------------------
  function drawUtility(u               )       {
    if (bundleFor !== u.id) {
      bundle = undefined;
      bundleFor = u.id;
    }
    // `#utilities:<id>/<k=v&…>` presets (the decision wizard's "Change a running service" opens a utility for its app, server and cloud).
    // A preset cloud becomes the page's cloud.
    const presets = new URLSearchParams(ctx.arg().split('/').slice(1).join('/'));
    const presetCloud = presets.get('platform');
    if (!valuesById.has(u.id) && isCloud(presetCloud) && presetCloud !== viewerCloud()) rememberCloud(presetCloud, false);
    const cloud = cloudNow();
    const back = el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: '← All utilities', attrs: { href: '#utilities', 'data-control': 'utilities-back' } }));
    if (!cloud || !u.platforms.includes(cloud)) {
      fill(main, back, card(u.label,
        el('p', { text: u.description }),
        picker(`Choose the cloud to change. ${u.label} runs on ${u.platforms.map(platformName).join(', ')}.`),
        cloud ? el('div', { class: 'tip warn', attrs: { 'data-control': 'utility-not-on-cloud' }, text: `${u.label} is not available on ${CLOUD_NAMES[cloud]}. It runs on ${u.platforms.map(platformName).join(', ')}.` }) : null));
      return;
    }
    const values = valuesById.get(u.id) ?? defaultUtilityValues(u, cloud);
    if (!valuesById.has(u.id)) {
      for (const [k, v] of presets) {
        if (k !== 'platform' && u.inputs.some((i) => i.id === k)) values[k] = v;
      }
    }
    if (values.platform !== cloud) values.platform = cloud;
    valuesById.set(u.id, values);
    const uctx = () => utilityContext(ctx.session.plan(), tracker, date);
    const form = el('div', { class: 'stack', attrs: { 'data-control': 'utility-form', 'data-utility': u.id } });
    const renderForm = () => {
      // The platform is the cloud chosen above: the form does not ask again.
      fill(form, ...renderBlueprintForm({ inputs: formInputs(u, values, uctx()).filter((i) => i.id !== 'platform') }, {
        values: () => values,
        set: (id, value) => {
          values[id] = value;
          if (id === 'platform' || u.optionsFor) renderSoon();
        },
        rerender: () => renderForm(),
      }));
    };
    let timer                                           ;
    const renderSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const active = document.activeElement                      ;
        const id = active?.closest('[data-input]')?.getAttribute('data-input');
        renderForm();
        if (id) (form.querySelector(`[data-input="${id}"] input, [data-input="${id}"] select, [data-input="${id}"]`)                      )?.focus?.();
      }, 400);
    };
    renderForm();
    const dateBox = el('input', { attrs: { type: 'date', 'aria-label': 'Change date', 'data-control': 'utility-date' } })                    ;
    dateBox.value = date;
    dateBox.addEventListener('change', () => { if (/^\d{4}-\d{2}-\d{2}$/.test(dateBox.value)) date = dateBox.value; });
    const result = el('div', { class: 'stack', attrs: { 'data-control': 'utility-result' } });
    const generate = () => {
      try {
        bundle = buildChangeBundle(u, values, uctx());
      } catch (e) {
        fill(result, el('div', { class: 'tip warn', text: `The bundle could not be built: ${e instanceof Error ? e.message : String(e)}` }));
        return;
      }
      drawResult(result);
    };
    fill(main,
      back,
      card(u.label,
        el('p', { text: u.description }),
        picker(''),
        note(`${RISK_TEXT[u.risk]}. Rollback: ${u.rollback}${u.reversible ? '' : ' (compensating: the README says how)'}.`),
        form,
        el('div', { class: 'field' }, el('label', { text: 'Change date (names the bundle; nothing else is dated)' }), dateBox),
        el('div', { class: 'btn-row' }, el('button', { class: 'btn btn-primary', text: 'Generate the change bundle', attrs: { type: 'button', 'data-control': 'utility-generate' }, on: { click: generate } }))),
      result,
    );
    if (bundle) drawResult(result);
  }

  function drawResult(box             )       {
    const b = bundle;
    if (!b) return clear(box);
    const names = Object.keys(b.files);
    const preview = el('div');
    const show = (name        ) => fill(preview, el('pre', { class: 'code', text: b.files[name] ?? '', attrs: { 'data-control': 'utility-file-text' }, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%', margin: '0' } }));
    const pick = el('select', { attrs: { 'aria-label': 'File', 'data-control': 'utility-file' } })                     ;
    for (const n of names) append(pick, el('option', { text: n.slice(b.folder.length + 1), attrs: { value: n } }));
    const first = names.find((n) => n.endsWith('/README.md')) ?? names[0] ?? '';
    pick.value = first;
    pick.addEventListener('change', () => show(pick.value));
    show(first);
    const msg = el('div', { class: 'small', attrs: { role: 'status', 'data-control': 'utility-message' } });
    const original = ctx.session.plan();
    const after = planAfter(original, b);
    fill(box, card(`Bundle: ${b.folder}`,
      el('div', { class: 'small', attrs: { 'data-control': 'utility-summary' }, text: `${b.summary} · ${platformName(b.platform)} · target ${b.target} · route ${b.route} · ${names.length} files` }),
      findingsList(b.findings, 'No findings.'),
      b.planOps.length ? el('div', { class: 'stack' },
        subhead('Plan update'),
        el('ul', { class: 'small' }, ...b.planOps.map((op) => el('li', { text: describePlanOp(op) }))),
        after ? el('div', { class: 'btn-row' }, el('button', {
          class: 'btn btn-small', text: 'Apply the plan update', attrs: { type: 'button', 'data-control': 'utility-apply-plan' },
          on: { click: () => { ctx.session.update(() => after); msg.textContent = 'The plan is updated; the app stack regenerates from it.'; } },
        })) : null) : null,
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn btn-primary', text: 'Download the bundle (.zip)', attrs: { type: 'button', 'data-control': 'utility-download', disabled: b.blocked, title: b.blocked ? 'Fix the errors first' : '' },
          on: {
            click: () => {
              void zip(b.files                          , new Date(`${date}T00:00:00Z`)).then(async (bytes) => {
                downloadFile(`${b.folder}.zip`, bytes, 'application/zip');
                await recordUtilityRun(b).catch(() => false);
                msg.textContent = `Downloaded ${b.folder}.zip and recorded ${b.id} in the utility log.`;
                void drawLog();
              });
            },
          },
        })),
      b.blocked ? note('The download is blocked until the errors above are fixed.') : null,
      msg,
      el('div', { class: 'field' }, el('label', { text: 'Files' }), pick),
      preview,
    ));
  }

  // ---- the log ---------------------------------------------------------------------
  async function drawLog()                {
    const records = await loadUtilityLog().catch(() => []                           );
    const msg = el('div', { class: 'small', attrs: { role: 'status', 'data-control': 'utility-log-message' } });
    const rows = logRows(records).map((r) => {
      const id = r[0]          ;
      const cr = el('input', { attrs: { type: 'text', placeholder: 'CHG…', 'aria-label': `CR for ${id}`, 'data-control': 'utility-log-cr', 'data-change': id }, style: { width: '8rem' } })                    ;
      cr.value = r[7] ?? '';
      cr.addEventListener('change', () => void setUtilityCr(id, cr.value).then(() => { msg.textContent = `CR for ${id} saved.`; }));
      const rec = records.find((x) => x.id === id);
      return [...r.slice(0, 7), cr, rec ? changeState(rec) : ''];
    });
    fill(logBox,
      note('Import the bundles’ status/events.jsonl to fill Applied and Rolled back. A change can also get a change request on Waves › Governance.'),
      el('div', { class: 'btn-row' },
        filePicker('Import status events (.jsonl, .json)…', '.jsonl,.json,application/json', true, 'utility-log-import', (files) => {
          void Promise.all(files.map((f) => f.text())).then(async (texts) => {
            let applied = 0;
            let rolledBack = 0;
            let unknown = 0;
            let rejected = 0;
            for (const t of texts) {
              const r = await importUtilityEvents(t);
              applied += r.applied;
              rolledBack += r.rolledBack;
              unknown += r.unknown;
              rejected += r.rejected;
            }
            await drawLog();
            logBox.querySelector('[data-control="utility-log-message"]') .textContent = `${applied} applied, ${rolledBack} rolled back; ${unknown} for changes not in the log; ${rejected} lines rejected.`;
          });
        }),
        el('button', {
          class: 'btn btn-small', text: 'Export the log (.csv)', attrs: { type: 'button', 'data-control': 'utility-log-csv' },
          on: {
            click: () => {
              const q = (t        ) => (/[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
              downloadFile('utility-log.csv', `${[CHANGE_LOG_COLUMNS.join(','), ...logRows(records).map((r) => r.map(q).join(','))].join('\n')}\n`, 'text/csv');
            },
          },
        })),
      msg,
      rows.length === 0 ? note('No changes yet: generate and download a bundle.') : rowsTable([...CHANGE_LOG_COLUMNS, 'State'], rows, { control: 'utility-log-table' }),
    );
  }

  ctx.onArg(route);
  onCloudChange(() => {
    bundle = undefined;
    route();
  });
  void trackerRecord().then((t) => {
    tracker = t;
  });
  route();
  void drawLog();
}
