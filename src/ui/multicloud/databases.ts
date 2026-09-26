/**
 * Databases (`#databases`) on Application Migration: one row per database
 * instance (base Screen 3, with the A.4.9 engines):
 *
 * Name | Check | Engine | Edition | Version | Hosts | vCPU | RAM GiB | Size GiB |
 * HA | DR | Features | Licence | App | Pin service
 *
 * Engine, edition, version, HA, DR, licence and pin service are dropdowns from
 * options.ts; a new engine brings an edition and version that belong to it.
 * A database suggested from a server's name or software shows “? Suggested”
 * in Check until it is confirmed (or any cell is edited). Features take the
 * closed list's tokens, space separated.
 *
 * Below the grid, the database catalogue (db-catalog.ts with the A.4.9 rows
 * of db-catalog-extra.ts): for one database, or an engine and edition, every
 * service on every platform that runs it, what HA it carries, the licence
 * models, the features it cannot carry, IPv6, and how far the row is
 * verified.
 */

import { el, append, clear } from '../dom.ts';
import { card, field, findingsList, select, stat, statGrid, verificationBadge } from '../components.ts';
import type { PaneContext } from '../plan-shell.ts';
import { DB_VERSIONS, isVersionEol, serviceLicences, servicesFor, unsupportedOn } from '../../multicloud/plan/db-catalog.ts';
import { intakeFromCsv, toCsv } from '../../multicloud/plan/intake/csv.ts';
import { applyDbHostRoles, mergeRows } from '../../multicloud/plan/intake/merge.ts';
import { validateScreen } from '../../multicloud/plan/intake/validate.ts';
import {
  DB_EDITION_OPTIONS, DB_ENGINE_OPTIONS, DB_HA_OPTIONS, DB_VERSION_OPTIONS, EDITIONS_BY_ENGINE, PLATFORM_LABELS, labelOf,
} from '../../multicloud/plan/options.ts';
import type { Database, DbEdition, DbEngine } from '../../multicloud/plan/types.ts';
import { DATABASE_GRID, afterDatabaseEdit, newDatabase } from './grid-model.ts';
import { planGrid, whenShown } from './grid.ts';
import { intakeSettings } from './sources-model.ts';

const note = (text: string) => el('p', { class: 'small muted', text });

export function mount(root: HTMLElement, ctx: PaneContext): void {
  const session = ctx.session;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const statsSlot = el('div');
  const checksSlot = el('div');
  const catalogueSlot = el('div');

  const grid = planGrid<Database>({
    id: 'databases',
    noun: 'database',
    columns: DATABASE_GRID,
    read: () => session.plan().databases,
    // A server named as a host is marked role db on Servers (unless its role was edited).
    write: (rows) => session.update((p) => ({ ...p, databases: rows, workloads: applyDbHostRoles(p.workloads, rows) })),
    create: (rows) => newDatabase(rows),
    after: afterDatabaseEdit,
    filterKeys: ['inferred', 'engine', 'version', 'app', 'pinService'],
    pageSize: 100,
    csv: {
      fileName: 'databases.csv',
      export: (rows) => toCsv('databases', rows),
      import: (text, rows) => {
        const r = intakeFromCsv({ kind: 'databases', text, workloads: session.plan().workloads });
        return { rows: mergeRows(rows, r.databases, intakeSettings(session.plan()).mergeMode), findings: r.findings };
      },
    },
    actions: [
      {
        label: 'Confirm the suggested databases',
        title: 'Mark every filtered “? Suggested” row as confirmed',
        run: (indices) => {
          const set = new Set(indices);
          session.update((p) => ({ ...p, databases: p.databases.map((d, i) => (set.has(i) && d.inferred ? { ...d, inferred: false } : d)) }), { immediate: true });
          grid.render();
        },
      },
    ],
    onChange: () => schedule(),
  });

  append(root,
    card('Databases',
      note('One row per database instance (not per schema). Hosts are the servers it runs on today (two or more means clustered). Features, space separated: ssis ssrs ssas clr-unsafe linked-servers cross-db-queries agent-jobs filestream dtc service-broker partitioning advanced-security diagnostics-pack tuning-pack in-memory apex ords spatial.'),
      statsSlot,
      grid.root),
    card('Database catalogue', catalogueSlot),
    card('Checks', checksSlot));

  // ---- the catalogue ------------------------------------------------------------
  const pick = el('input', { attrs: { type: 'text', list: 'databases-names', placeholder: 'A database in the plan…', 'data-control': 'db-catalogue-pick' } }) as HTMLInputElement;
  const names = el('datalist', { attrs: { id: 'databases-names' } });
  const engineSel = select(DB_ENGINE_OPTIONS, 'sqlserver');
  engineSel.setAttribute('data-control', 'db-catalogue-engine');
  const editionSel = select([{ value: '', label: 'Any edition' }, ...DB_EDITION_OPTIONS], '');
  const table = el('div');
  const fillEditions = () => {
    const allowed = EDITIONS_BY_ENGINE[engineSel.value as DbEngine] ?? [];
    const keep = editionSel.value;
    clear(editionSel);
    append(editionSel, el('option', { text: 'Any edition', attrs: { value: '' } }));
    for (const e of allowed) append(editionSel, el('option', { text: labelOf(DB_EDITION_OPTIONS, e), attrs: { value: e } }));
    editionSel.value = allowed.includes(keep as DbEdition) ? keep : '';
  };
  pick.addEventListener('change', () => {
    const d = session.plan().databases.find((x) => x.name.toLowerCase() === pick.value.trim().toLowerCase());
    if (d) {
      engineSel.value = d.engine;
      fillEditions();
      editionSel.value = d.edition;
    }
    renderCatalogue();
  });
  engineSel.addEventListener('change', () => {
    fillEditions();
    renderCatalogue();
  });
  editionSel.addEventListener('change', renderCatalogue);
  append(catalogueSlot,
    note('Where a database can go: every service on every platform that runs its engine and edition. Each row says how far it is verified (Verified = the provider’s own documentation; Community or Inferred = check before relying on it).'),
    el('div', { class: 'field-grid' }, field('Database', pick), field('Engine', engineSel), field('Edition', editionSel)),
    names,
    table);
  fillEditions();

  function renderCatalogue(): void {
    const plan = session.plan();
    clear(names);
    for (const d of plan.databases.slice(0, 2000)) append(names, el('option', { attrs: { value: d.name } }));
    const db = plan.databases.find((x) => x.name.toLowerCase() === pick.value.trim().toLowerCase());
    const engine = engineSel.value as DbEngine;
    const edition = (editionSel.value || undefined) as DbEdition | undefined;
    const services = servicesFor(engine, undefined, edition);
    clear(table);
    if (db) {
      const v = DB_VERSIONS[db.version];
      const eol = isVersionEol(db.version, new Date().toISOString().slice(0, 10));
      append(table, el('p', { class: 'small' },
        v ? verificationBadge(v.verification) : null, ' ',
        `${db.name}: ${labelOf(DB_VERSION_OPTIONS, db.version)}${v?.endOfSupport ? `, support ends ${v.endOfSupport}` : ''}${v?.endOfExtendedSupport ? ` (extended ${v.endOfExtendedSupport})` : ''}${eol ? ' — past support' : ''}.`,
        v?.source ? el('span', {}, ' ', el('a', { text: 'Source', attrs: { href: v.source.split(' ; ')[0] ?? v.source, target: '_blank', rel: 'noopener' } })) : null));
    }
    if (services.length === 0) {
      append(table, el('div', { class: 'empty', text: 'No catalogued service runs this engine and edition; it goes on a VM.' }));
      return;
    }
    const body = el('tbody');
    for (const s of services) {
      const gaps = db ? unsupportedOn(s.id, db.features) : [];
      const haOk = db ? s.ha.includes(db.ha) : true;
      append(body, el('tr', {},
        el('td', { text: PLATFORM_LABELS[s.platform] }),
        el('td', { text: s.label }),
        el('td', { text: s.managed ? 'Managed' : 'VM (you run it)' }),
        el('td', { class: 'small', text: s.ha.map((h) => labelOf(DB_HA_OPTIONS, h)).join(', '), style: db && !haOk ? { color: 'var(--warn)' } : {} }),
        el('td', { text: serviceLicences(s.id, engine).map((l) => (l === 'li' ? 'Licence included' : 'BYOL')).join(', ') }),
        el('td', { class: 'small', text: db ? (gaps.length > 0 ? `Not carried: ${gaps.join(', ')}` : 'All carried') : s.unsupportedFeatures.join(', ') || '—', style: gaps.length > 0 ? { color: 'var(--warn)' } : {} }),
        el('td', { class: 'num', text: s.maxStorageGib ? `${s.maxStorageGib.toLocaleString('en')} GiB` : '—' }),
        el('td', { text: s.ipv6 ? 'Dual-stack' : 'IPv4' }),
        el('td', {}, verificationBadge(s.verification), ' ', el('a', { text: 'Source', attrs: { href: s.source.split(' ; ')[0] ?? s.source, target: '_blank', rel: 'noopener', title: s.source } }))));
    }
    append(table, el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['Platform', 'Service', 'Kind', 'HA it carries', 'Licence', db ? 'Features' : 'Features it cannot carry', 'Max size', 'IPv6', 'Verified'].map((h) => el('th', { text: h })))),
      body)));
  }

  // ---- stats and checks ------------------------------------------------------------
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(renderSide, 300);
  }
  function renderSide(): void {
    const plan = session.plan();
    const rows = plan.databases;
    const engines = new Set(rows.map((d) => d.engine));
    const suggested = rows.filter((d) => d.inferred).length;
    const size = rows.reduce((s, d) => s + d.sizeGib, 0);
    clear(statsSlot);
    append(statsSlot, statGrid(
      stat({ label: 'Databases', value: rows.length, sub: `${engines.size} engine${engines.size === 1 ? '' : 's'}` }),
      stat({ label: 'Suggested, to confirm', value: suggested, tone: suggested > 0 ? 'warn' : 'ok' }),
      stat({ label: 'Data', value: `${Math.round(size)} GiB` }),
    ));
    clear(checksSlot);
    append(checksSlot, findingsList(validateScreen(plan, 'databases'), 'No problems in the databases.'));
    renderCatalogue();
  }
  renderSide();

  const rebuild = whenShown(root, () => {
    grid.render();
    renderSide();
  });
  session.subscribe((_plan, kind) => {
    if (kind === 'saved' || grid.busy()) return;
    rebuild();
  });
}
