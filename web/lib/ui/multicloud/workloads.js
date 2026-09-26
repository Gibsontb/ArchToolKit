/**
 * Servers (`#servers`, also `#workloads`) on Application Migration: every
 * server from every source in one " | " grid (base Screen 2 plus the
 * addendum's columns, A.3.6, A.3.7, A.10.9, A.10.16):
 *
 * Name | App | Source | Type | Type check | Env | Role | OS | vCPU | RAM GiB |
 * Basis | Disks GiB | IP addresses | IP strategy | Rename | Upgrade |
 * Criticality | RPO | RTO | Licence | Residency | Disposition | Depends on | Pin
 *
 * Every closed column is a dropdown from options.ts. Type check shows a
 * detection's confidence ("? 85%") until Confirmed is picked; picking a Type
 * confirms it too. IP addresses take IPv4 and IPv6. Filters and paging come
 * first (a 5,000-server estate), then the bulk edit bar, Regroup (the app
 * grouping rules from Sources) and Confirm detected types. Below the grid: the
 * types waiting for a person with their evidence, one server's detail, and
 * the Servers checks.
 */

import { el, append, clear } from '../dom.js';
import { card, field, findingsList, stat, statGrid, verificationBadge } from '../components.js';
                                                    
import { warning,              } from '../../core/findings.js';
import { familyOf } from '../../core/ip.js';
import { loadInventory } from '../../kit/estate-store.js';
import { intakeFromCsv, toCsv } from '../../multicloud/plan/intake/csv.js';
import { mergeRows } from '../../multicloud/plan/intake/merge.js';
import { validateScreen } from '../../multicloud/plan/intake/validate.js';
import { COMFORT_FACTOR, COMFORT_SOURCE } from '../../multicloud/plan/intake/sources/sizing-basis.js';
import { detectWorkloads } from '../../multicloud/plan/patterns/detect.js';
import { osKind } from '../../multicloud/plan/os.js';
import { OS_OPTIONS, SIZING_BASIS_OPTIONS, SOURCE_PLATFORM_OPTIONS, WORKLOAD_TYPE_OPTIONS, labelOf } from '../../multicloud/plan/options.js';
                                                                             
import {
  DETECTED_AT, WORKLOAD_GRID, afterWorkloadEdit, confirmTypes, newWorkload, originOf, renameProblem, typesToConfirm,
} from './grid-model.js';
import { planGrid, whenShown } from './grid.js';
import { intakeSettings, regroupPlan, subjectsFromInventory } from './sources-model.js';

const note = (text        ) => el('p', { class: 'small muted', text });

/** Findings the grid adds to the plan's own checks: rename and address problems. */
export function serverGridFindings(rows                     )            {
  const out            = [];
  rows.forEach((w, i) => {
    const problem = w.rename ? renameProblem(w.rename, osKind(w.os) === 'windows') : undefined;
    if (problem) out.push(warning('plan.workloads.rename-invalid', `${w.name}: ${problem}`, { path: `workloads[${i}].rename` }));
    if (w.rename && rows.some((o, j) => j !== i && (o.rename ?? o.name).toLowerCase() === w.rename .toLowerCase())) {
      out.push(warning('plan.workloads.rename-duplicate', `${w.name}: the new name “${w.rename}” is another server’s name.`, { path: `workloads[${i}].rename` }));
    }
  });
  const keepIp = rows.filter((w) => w.ipStrategy?.startsWith('keep-ip') && (w.facts?.ipAddresses ?? []).length === 0);
  if (keepIp.length > 0) {
    out.push(warning('plan.workloads.keep-ip-no-address', `${keepIp.length} server(s) keep their IP but have no address in the plan: ${keepIp.slice(0, 5).map((w) => w.name).join(', ')}${keepIp.length > 5 ? ' …' : ''}.`, {
      remediation: 'Type the addresses (IPv4 and IPv6) in the IP addresses column, or import the estate with guest IPs.',
    }));
  }
  return out;
}

export function mount(root             , ctx             )       {
  const session = ctx.session;
  let sideTimer                                           ;
  const typeSlot = el('div');
  const detailSlot = el('div');
  const checksSlot = el('div');
  const statsSlot = el('div');

  const grid = planGrid          ({
    id: 'servers',
    noun: 'server',
    columns: WORKLOAD_GRID,
    read: () => session.plan().workloads,
    write: (rows) => session.update((p) => ({ ...p, workloads: rows })),
    create: (rows) => newWorkload(rows),
    after: afterWorkloadEdit,
    filterKeys: ['app', 'origin', 'workloadType', 'env', 'role', 'os', 'basis', 'disposition'],
    pageSize: 100,
    csv: {
      fileName: 'servers.csv',
      export: (rows) => toCsv('workloads', rows),
      import: (text, rows) => {
        const r = intakeFromCsv({ kind: 'workloads', text });
        return { rows: mergeRows(rows, r.workloads, intakeSettings(session.plan()).mergeMode), findings: r.findings };
      },
    },
    actions: [
      {
        label: 'Regroup the apps',
        title: 'Run the app grouping rules (Sources) over the filtered servers; an App you typed is kept',
        run: (indices) => {
          void loadInventory().then((estate) => {
            const r = regroupPlan(session.plan(), subjectsFromInventory(estate?.inventory), indices);
            session.update(() => r.plan, { immediate: true });
            grid.render();
            showSide([`${r.changed} server(s) moved to another application.`], r.findings);
          });
        },
      },
      {
        label: 'Confirm the detected types',
        title: 'Confirm every filtered server whose type was detected (“? 70%” or more); “unknown — confirm” rows stay for you',
        run: (indices) => {
          const rows = session.plan().workloads;
          const wanted = indices.filter((i) => (rows[i]?.facts?.detection?.confidence ?? 1) >= DETECTED_AT);
          const r = confirmTypes(rows, wanted);
          session.update((p) => ({ ...p, workloads: r.rows }), { immediate: true });
          grid.render();
          showSide([`${r.changed} type(s) confirmed.`]);
        },
      },
      {
        label: 'Detect the types again',
        title: 'Run type detection over the filtered servers; a type you set or confirmed is kept',
        run: (indices) => {
          const rows = [...session.plan().workloads];
          const picked = indices.map((i) => rows[i]).filter((w)                => !!w);
          const d = detectWorkloads(picked);
          const byId = new Map(d.workloads.map((w) => [w.id, w]));
          session.update((p) => ({ ...p, workloads: p.workloads.map((w) => byId.get(w.id) ?? w) }), { immediate: true });
          grid.render();
          showSide([`${picked.length} server(s) detected.`], d.findings);
        },
      },
    ],
    onChange: () => scheduleSide(),
  });

  const sideMessages = el('div');
  function showSide(lines                   , findings                     = [])       {
    clear(sideMessages);
    append(sideMessages, ...lines.map((l) => el('p', { class: 'small', text: l })));
    if (findings.length > 0) append(sideMessages, findingsList(findings));
  }

  append(root,
    card('Servers',
      note('Every server from every source. Dropdowns hold the closed sets; filters and pages come first, then “Set … on the filtered rows”. Type check shows how sure the detection is (“? 85%”) until you pick Confirmed; picking a Type confirms it too. IP addresses take IPv4 and IPv6, space separated.'),
      statsSlot,
      grid.root,
      sideMessages),
    card('Types to confirm', typeSlot),
    card('One server', detailSlot),
    card('Checks', checksSlot));

  // ---- the side panels ----------------------------------------------------------
  function scheduleSide()       {
    if (sideTimer) clearTimeout(sideTimer);
    sideTimer = setTimeout(renderSide, 300);
  }

  function renderStats(rows                     )       {
    const byBasis = new Map                ();
    const unconfirmed = typesToConfirm(rows).length;
    for (const w of rows) byBasis.set(w.basis ?? '', (byBasis.get(w.basis ?? '') ?? 0) + 1);
    const sources = new Set(rows.map(originOf).filter(Boolean));
    const v6 = rows.filter((w) => (w.facts?.ipAddresses ?? []).some((a) => familyOf(a) === 6)).length;
    clear(statsSlot);
    append(statsSlot, statGrid(
      stat({ label: 'Servers', value: rows.length, sub: `${sources.size} source platform${sources.size === 1 ? '' : 's'}` }),
      stat({ label: 'Types to confirm', value: unconfirmed, tone: unconfirmed > 0 ? 'warn' : 'ok' }),
      stat({ label: 'Sized from utilisation', value: byBasis.get('utilisation') ?? 0, sub: `${byBasis.get('allocated') ?? 0} allocated` }),
      stat({ label: 'With IPv6', value: v6 }),
    ));
  }

  function renderTypes(rows                     )       {
    clear(typeSlot);
    const list = typesToConfirm(rows);
    append(typeSlot,
      el('p', { class: 'small' }, verificationBadge('I'),
        ' Detection weighs installed software and services, listening ports, the name and the OS (A.3.7); it is an inference, so nothing is taken as the type until you confirm it. At 70% or more the type is filled in with “?”; from 40% it stays unknown and lists the candidates.'));
    if (list.length === 0) {
      append(typeSlot, el('div', { class: 'empty', text: 'Every detected type is confirmed.' }));
      return;
    }
    const shown = list.slice(0, 25);
    const body = el('tbody');
    for (const { index, workload: w } of shown) {
      const d = w.facts?.detection;
      const typeSel = el('select', { attrs: { 'aria-label': `Type of ${w.name}` } })                     ;
      for (const o of WORKLOAD_TYPE_OPTIONS) append(typeSel, el('option', { text: o.label, attrs: { value: o.value } }));
      typeSel.value = w.workloadType ?? 'unknown';
      const confirm = el('button', {
        class: 'btn btn-small', text: 'Confirm', attrs: { type: 'button', 'data-control': 'type-confirm' },
        on: {
          click: () => {
            const t = typeSel.value                ;
            if (t === 'unknown') return;
            const r = confirmTypes(session.plan().workloads, [index], t);
            session.update((p) => ({ ...p, workloads: r.rows }), { immediate: true });
            grid.render();
          },
        },
      });
      append(body, el('tr', {},
        el('td', { text: w.name }),
        el('td', {}, typeSel),
        el('td', { class: 'num', text: d ? `${Math.round(d.confidence * 100)}%` : '—' }),
        el('td', { class: 'small', text: d?.evidence.join('; ') || '—' }),
        el('td', {}, confirm)));
    }
    append(typeSlot,
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ...['Server', 'Type', 'Confidence', 'Evidence', ''].map((h) => el('th', { text: h })))),
        body)),
      list.length > shown.length ? note(`The first ${shown.length} of ${list.length}; filter the grid by Type and use “Confirm the detected types” for the rest.`) : null);
  }

  // One server's detail: what the sources said about it.
  const pickInput = el('input', { attrs: { type: 'text', list: 'servers-names', placeholder: 'Server name…', 'data-control': 'server-detail-pick' } })                    ;
  const names = el('datalist', { attrs: { id: 'servers-names' } });
  const detailBody = el('div');
  pickInput.addEventListener('change', () => renderDetail());
  append(detailSlot, field('Server', pickInput, 'The facts the sources gave: nameplate, utilisation, addresses, software, ports, readiness.'), names, detailBody);

  function renderDetail()       {
    const rows = session.plan().workloads;
    clear(names);
    for (const w of rows.slice(0, 2000)) append(names, el('option', { attrs: { value: w.name } }));
    clear(detailBody);
    const w = rows.find((x) => x.name.toLowerCase() === pickInput.value.trim().toLowerCase());
    if (!w) return;
    const f = w.facts ?? {};
    const u = f.utilisation;
    const ref = w.sourceRef;
    const facts                     = [
      ['Source', `${labelOf(SOURCE_PLATFORM_OPTIONS, originOf(w)) || '—'}${ref?.manager ? ` · ${ref.manager}` : ''}${ref?.host ? ` · host ${ref.host}` : ''}${ref?.cluster ? ` · ${ref.cluster}` : ''}${ref?.region ? ` · ${ref.region}` : ''}${ref?.bmc ? ` · BMC ${ref.bmc}` : ''}`],
      ['OS as reported', f.guestOsRaw ?? '—'],
      ['OS', labelOf(OS_OPTIONS, w.os)],
      ['Nameplate', f.nameplate ? `${f.nameplate.cores} vCPU · ${f.nameplate.ramGib} GiB · disks ${f.nameplate.disksGib.join(' ') || '—'} GiB` : `${w.vcpu} vCPU · ${w.ramGib} GiB (as configured)`],
      ['Basis', `${labelOf(SIZING_BASIS_OPTIONS, w.basis ?? 'allocated')}${w.basis === 'utilisation' ? ` (× ${COMFORT_FACTOR} comfort factor)` : ''}`],
      ['Utilisation', u ? `${u.days} day(s), ${Math.round(u.coverage * 100)}% coverage · CPU p95 ${u.cpuP95Pct ?? '—'}% (max ${u.cpuMaxPct ?? '—'}%) · memory p95 ${u.memP95Gib ?? '—'} GiB · IOPS p95 ${u.iopsP95 ?? '—'} · ${u.mbpsP95 ?? '—'} MB/s` : 'none'],
      ['Disks used', f.disksUsedGib ? `${f.disksUsedGib.join(' ')} GiB` : '—'],
      ['IPv4', (f.ipAddresses ?? []).filter((a) => familyOf(a) === 4).join(' ') || '—'],
      ['IPv6', (f.ipAddresses ?? []).filter((a) => familyOf(a) === 6).join(' ') || '—'],
      ['Firmware', f.firmware ?? '—'],
      ['Power', f.powerState ?? '—'],
      ['Software', (f.software ?? []).slice(0, 30).join(', ') || '—'],
      ['Services', (f.services ?? []).slice(0, 30).join(', ') || '—'],
      ['Listening', (f.listening ?? []).map((l) => `${l.port}/${l.proto}${l.process ? ` (${l.process})` : ''}`).join(', ') || '—'],
      ['Readiness', (f.readiness ?? []).map((r) => `${r.id} (${r.severity})`).join(', ') || '—'],
      ['Detection', f.detection ? `${labelOf(WORKLOAD_TYPE_OPTIONS, f.detection.type)} at ${Math.round(f.detection.confidence * 100)}%: ${f.detection.evidence.join('; ') || 'no evidence'}` : '—'],
      ['Edited cells', (w.edited ?? []).join(', ') || 'none'],
    ];
    append(detailBody,
      el('div', { class: 'fact-grid' }, ...facts.map(([k, v]) => el('div', { class: 'fact' }, el('div', { class: 'fact-label', text: k }), el('div', { class: 'fact-value', text: v })))),
      w.basis === 'utilisation'
        ? el('p', { class: 'small' }, verificationBadge('V-DOC'), ' The utilisation basis is p95 × 1.3 (Azure Migrate’s performance-based sizing). ', el('a', { text: 'Source', attrs: { href: COMFORT_SOURCE, target: '_blank', rel: 'noopener' } }))
        : null);
  }

  function renderSide()       {
    const plan = session.plan();
    renderStats(plan.workloads);
    renderTypes(plan.workloads);
    renderDetail();
    clear(checksSlot);
    append(checksSlot, findingsList([...validateScreen(plan, 'workloads'), ...serverGridFindings(plan.workloads)], 'No problems in the servers.'));
  }
  renderSide();

  // Changes from elsewhere (another pane, the other page, a loaded file) rebuild the grid.
  const rebuild = whenShown(root, () => {
    grid.render();
    renderSide();
  });
  session.subscribe((_plan, kind) => {
    // Its own edits (and the save that follows them) leave the grid as it is: the cursor stays in the cell.
    if (kind === 'saved' || grid.busy()) return;
    rebuild();
  });
}
