/**
 * Applications (`#applications`) on Application Migration (addendum A.2.2):
 * the application catalogue.
 *
 * One row per app: kind, pattern, owner, criticality, servers, databases,
 * sources, the engine's recommended cloud, the chosen cloud (blank follows the
 * recommendation), the margin, the status and the complexity score. Owner,
 * Kind, Pattern and Chosen are edited in the grid (dropdowns for the closed
 * sets). Filters come first; the selected rows can be placed on their
 * recommendation in one go, or saved as planned. **New application** starts a
 * greenfield service; the **Dependency map** shows the app-to-app edges, a
 * synchronous edge that crosses platforms in red.
 */

import { el, append } from '../dom.ts';
import type { PaneContext } from '../plan-shell.ts';
import { appDatabases, appWorkloads } from '../../multicloud/plan/apps/components.ts';
import { chooseAppPlatform, clearAppPlatform, saveAppPlans } from '../../multicloud/plan/apps/recommend.ts';
import { APP_KIND_OPTIONS, APP_PATTERN_OPTIONS, APP_PLAN_STATUS_OPTIONS, APP_ORIGIN_OPTIONS, CRITICALITY_OPTIONS, labelOf } from '../../multicloud/plan/options.ts';
import type { AppRecommendation, Plan, Platform } from '../../multicloud/plan/types.ts';
import {
  PLATFORM_CHOICES, PLATFORM_NAME, appHash, catalogueRows, filterCatalogue, recommendationsOf, setAppField, shownPlatform, useRecommendation,
  type CatalogueFilter, type CatalogueRow,
} from './app-model.ts';
import { button, buttonRow, chip, dropdown, fill, filterRow, judgedOn, labelled, note, rowsTable, textInput, watchPlan } from './kit.ts';
import { newAppCard } from './new-app.ts';

/** App-to-app edges: from the servers' and databases' edges, by app. */
export function appDependencyRows(plan: Plan, recs: Readonly<Record<string, AppRecommendation>>): { from: string; to: string; kind: 'sync' | 'async'; crosses: boolean }[] {
  const appOf = new Map<string, string>();
  for (const a of plan.apps) {
    appOf.set(a.name, a.name);
    for (const w of appWorkloads(plan, a)) appOf.set(w.name, a.name);
    for (const d of appDatabases(plan, a)) appOf.set(d.name, a.name);
  }
  const platformOf = (name: string): Platform | undefined => {
    const a = plan.apps.find((x) => x.name === name);
    return a ? shownPlatform(plan, a.id, recs[a.id]) : undefined;
  };
  const seen = new Map<string, { from: string; to: string; kind: 'sync' | 'async'; crosses: boolean }>();
  const add = (fromItem: string, toItem: string, kind: 'sync' | 'async') => {
    const from = appOf.get(fromItem);
    const to = appOf.get(toItem);
    if (!from || !to || from === to) return;
    const key = `${from}\u0000${to}`;
    const prev = seen.get(key);
    const crosses = platformOf(from) !== platformOf(to);
    seen.set(key, { from, to, kind: prev?.kind === 'sync' || kind === 'sync' ? 'sync' : 'async', crosses });
  };
  for (const e of plan.edges) add(e.from, e.to, e.kind);
  for (const w of plan.workloads) for (const d of w.dependsOn) if (!d.startsWith('site:')) add(w.name, d, 'sync');
  return [...seen.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

export function mount(root: HTMLElement, ctx: PaneContext): void {
  let filter: CatalogueFilter = { text: '', platform: '', status: '', kind: '', origin: '' };
  const selected = new Set<string>();
  let showNew = false;
  let showMap = false;
  let recs: Record<string, AppRecommendation> = {};
  let recsFor: Plan | undefined;
  const message = el('p', { class: 'small', attrs: { role: 'status', 'data-control': 'catalogue-message' } });

  const newSlot = el('div');
  const listSlot = el('div');
  const mapSlot = el('div');
  append(root, newSlot, listSlot, mapSlot);

  const recsOf = (plan: Plan) => {
    if (recsFor !== plan) {
      recs = recommendationsOf(plan);
      recsFor = plan;
    }
    return recs;
  };

  const draw = () => {
    const plan = ctx.session.plan();
    const newMode = (plan.mode ?? 'migrate') === 'new';
    fill(newSlot, showNew || (newMode && plan.apps.length === 0)
      ? newAppCard(() => ctx.session.plan(), (next, appId) => {
        ctx.session.update(() => next, { immediate: true });
        showNew = false;
        const app = next.apps.find((a) => a.id === appId);
        if (app) ctx.go(appHash(app, 'step-1'));
      }, plan.apps.length > 0 ? () => { showNew = false; draw(); } : undefined)
      : null);
    drawList(plan);
    drawMap(plan);
  };

  const watcher = watchPlan(root, ctx, draw);

  function drawList(plan: Plan): void {
    const r = recsOf(plan);
    const all = catalogueRows(plan, r, judgedOn(plan));
    const rows = filterCatalogue(all, filter);
    for (const id of [...selected]) if (!all.some((x) => x.id === id)) selected.delete(id);

    const search = textInput(filter.text ?? '', (v) => { filter = { ...filter, text: v }; drawList(ctx.session.plan()); }, { placeholder: 'Name, owner or pattern', control: 'catalogue-search', label: 'Search applications' });
    const platformSel = dropdown(PLATFORM_CHOICES, filter.platform ?? '', (v) => { filter = { ...filter, platform: v as Platform | '' }; drawList(ctx.session.plan()); }, { blank: 'Any cloud', control: 'catalogue-platform', label: 'Cloud' });
    const statusSel = dropdown(APP_PLAN_STATUS_OPTIONS, filter.status ?? '', (v) => { filter = { ...filter, status: v as CatalogueFilter['status'] }; drawList(ctx.session.plan()); }, { blank: 'Any status', control: 'catalogue-status', label: 'Status' });
    const kindSel = dropdown(APP_KIND_OPTIONS, filter.kind ?? '', (v) => { filter = { ...filter, kind: v }; drawList(ctx.session.plan()); }, { blank: 'Any kind', control: 'catalogue-kind', label: 'Kind' });
    const originSel = dropdown(APP_ORIGIN_OPTIONS, filter.origin ?? '', (v) => { filter = { ...filter, origin: v as CatalogueFilter['origin'] }; drawList(ctx.session.plan()); }, { blank: 'Migrating and new', control: 'catalogue-origin', label: 'Origin' });

    const tick = (row: CatalogueRow) => {
      const box = el('input', { attrs: { type: 'checkbox', 'aria-label': `Select ${row.name}`, 'data-control': 'catalogue-select' } }) as HTMLInputElement;
      box.checked = selected.has(row.id);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(row.id);
        else selected.delete(row.id);
        counter.textContent = `${selected.size} selected`;
      });
      return box;
    };
    const all_ = el('input', { attrs: { type: 'checkbox', 'aria-label': 'Select every row shown', 'data-control': 'catalogue-select-all' } }) as HTMLInputElement;
    all_.checked = rows.length > 0 && rows.every((x) => selected.has(x.id));
    all_.addEventListener('change', () => {
      for (const x of rows) (all_.checked ? selected.add(x.id) : selected.delete(x.id));
      drawList(ctx.session.plan());
    });
    const counter = el('span', { class: 'small muted', text: `${selected.size} selected` });

    const edit = (id: string, field: 'owner' | 'kind' | 'pattern' | 'criticality') => (v: string) => watcher.edit((p) => setAppField(p, id, field, v));
    const table = rowsTable(
      ['', 'App', 'Kind', 'Pattern', 'Owner', 'Criticality', 'Servers', 'DBs', 'Sources', 'Recommended', 'Chosen', 'Margin', 'Status', 'Complexity'],
      rows.map((row) => [
        tick(row),
        el('a', { text: row.name, attrs: { href: `#${appHash({ id: row.id })}`, 'data-control': 'catalogue-open' } }),
        dropdown(APP_KIND_OPTIONS, row.kind, edit(row.id, 'kind'), { label: `Kind of ${row.name}` }),
        dropdown(APP_PATTERN_OPTIONS, row.pattern, edit(row.id, 'pattern'), { label: `Pattern of ${row.name}` }),
        textInput(row.owner, edit(row.id, 'owner'), { label: `Owner of ${row.name}`, placeholder: 'owner' }),
        dropdown(CRITICALITY_OPTIONS, row.criticality, edit(row.id, 'criticality'), { label: `Criticality of ${row.name}` }),
        row.origin === 'new' ? chip('new', 'good') : String(row.servers),
        String(row.databases),
        row.sources,
        row.recommended ? el('span', {}, PLATFORM_NAME[row.recommended], row.tooClose ? chip('too close', 'warn', 'The runner-up is within 2 points per item') : null) : chip('none eligible', 'danger'),
        dropdown(PLATFORM_CHOICES, row.chosen ?? '', (v) => {
          watcher.edit((p) => (v ? chooseAppPlatform(p, row.id, v as Platform).plan : clearAppPlatform(p, row.id)), { redraw: true });
        }, { blank: 'Follow the recommendation', control: 'catalogue-chosen', label: `Chosen cloud of ${row.name}` }),
        row.margin >= 99 ? 'only eligible' : String(row.margin),
        chip(labelOf(APP_PLAN_STATUS_OPTIONS, row.status), row.status === 'draft' ? 'neutral' : 'good'),
        chip(`${row.complexity.score} ${row.complexity.band}`, row.complexity.band === 'High' ? 'danger' : row.complexity.band === 'Medium' ? 'warn' : 'good'),
      ]),
      { control: 'catalogue', numeric: [6, 7, 11], empty: all.length === 0 ? 'No applications yet: bring servers in on Sources (they are grouped into applications), or start a New application.' : 'No application matches the filters.' },
    );

    const bulkUse = button('Use the recommendation for the selected', () => {
      const ids = [...selected];
      if (ids.length === 0) { message.textContent = 'Select one or more applications first.'; return; }
      const res = useRecommendation(ctx.session.plan(), ids, recsOf(ctx.session.plan()));
      watcher.edit(() => res.plan, { redraw: true });
      message.textContent = `Placed ${res.placed.length} application(s) on their recommended cloud.${res.skipped.length > 0 ? ` No eligible cloud for: ${res.skipped.join(', ')}.` : ''}`;
    }, { control: 'catalogue-use-recommendation' });
    const bulkSave = button('Save the selected as planned', () => {
      const ids = [...selected];
      if (ids.length === 0) { message.textContent = 'Select one or more applications first.'; return; }
      watcher.edit((p) => saveAppPlans(p, ids, recsOf(p), new Date().toISOString()), { immediate: true, redraw: true });
      message.textContent = `Saved ${ids.length} application plan(s) as planned.`;
    }, { control: 'catalogue-save-planned' });
    const newBtn = button('New application', () => { showNew = true; draw(); newSlot.scrollIntoView?.({ block: 'start' }); }, { primary: true, control: 'catalogue-new' });
    const mapBtn = button(showMap ? 'Hide the dependency map' : 'Dependency map', () => { showMap = !showMap; draw(); }, { control: 'catalogue-map' });

    fill(listSlot, el('section', { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', { text: 'Applications' })),
      note('Every application, its recommended cloud and the one chosen for it. Open one to design its target presence, size it, compare the clouds and generate it.'),
      filterRow(labelled('Search', search), labelled('Cloud', platformSel), labelled('Status', statusSel), labelled('Kind', kindSel), labelled('Origin', originSel)),
      buttonRow(el('label', { class: 'checkbox' }, all_, el('span', { text: 'All shown' })), counter, bulkUse, bulkSave, newBtn, mapBtn),
      message,
      table,
      note(`${rows.length} of ${all.length} application(s) shown.`)));
  }

  function drawMap(plan: Plan): void {
    if (!showMap) { fill(mapSlot); return; }
    const deps = appDependencyRows(plan, recsOf(plan));
    fill(mapSlot, el('section', { class: 'card', attrs: { 'data-control': 'dependency-map' } },
      el('div', { class: 'card-title' }, el('h2', { text: 'Dependency map' })),
      note('Edges between applications, from the servers\' dependencies and the imported flows. A synchronous edge that crosses platforms is shown in red.'),
      rowsTable(['From app', 'To app', 'Kind', 'Crosses platforms'], deps.map((d) => [
        d.from, d.to, d.kind === 'sync' ? 'Synchronous' : 'Asynchronous',
        d.crosses ? chip(d.kind === 'sync' ? 'yes: synchronous across clouds' : 'yes', d.kind === 'sync' ? 'danger' : 'warn') : 'no',
      ]), { empty: 'No edges between applications.' })));
  }

  draw();
}
