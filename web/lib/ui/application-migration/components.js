/**
 * The workspace's Components tab (addendum A.2.6): what the app is made of on
 * the cloud it is shown on.
 *
 * A component is one of three kinds: a **pattern** (a tier pattern and the
 * servers and databases it carries), a **resource** (any Terraform resource of
 * the platform's provider) or a **config** (an Ansible role or module, managed
 * on the Configuration tab). The grid shows every one with what it becomes on
 * the platform and its status; each resource opens its blueprint form (the
 * Terraform page's own, through `renderBlueprintForm`).
 *
 * **Add from patterns** offers the tier patterns for a tier, ranked for this
 * app (score, reasons, and the rule that rules one out). **Add any service**
 * opens the picker over every resource type of the provider.
 */

import { el, append } from '../dom.js';
                                                        
import { findTerraformBlueprint } from '../../terraform/blueprints/index.js';
import { loadResource } from '../../terraform/schema-blueprints.js';
import { rankComponentPatterns, setTierPattern } from '../../multicloud/plan/apps/recommend.js';
import { variantFindings, leaveOut } from '../../multicloud/plan/apps/translate.js';
import { COMPONENT_KIND_OPTIONS, COMPONENT_STATUS_OPTIONS, COMPONENT_TIER_OPTIONS, TIER_PATTERN_OPTIONS, labelOf } from '../../multicloud/plan/options.js';
import { TIER_PATTERNS, isNone, tierTarget } from '../../multicloud/plan/patterns/index.js';
                                                                                                                            
import { findingsList } from '../components.js';
import {
  PLATFORM_NAME, addPatternComponent, addResourceComponent, componentFindings, componentsOn, rankForTier, referencesTo, removeComponent,
  startingValues, updateComponent,
} from './app-model.js';
import { button, buttonRow, chip, dropdown, factBadge, note, rowsTable, textInput,                         } from './kit.js';
import { componentForm, referenceOptions, resourceBlueprintFor, servicePicker } from './pickers.js';

/** Per app: which panel is open, and which component's form. Kept across redraws. */
const UI = new Map                                                                                                      ();
const uiOf = (appId        ) => {
  let s = UI.get(appId);
  if (!s) {
    s = {};
    UI.set(appId, s);
  }
  return s;
};

/** Resource types whose schema has loaded in this page (so their forms and checks are real). */
const LOADED = new Set        ();
const LOADING = new Set        ();

/** Fetch the schemas of the variant's resources in the background, redrawing once they are in. */
function loadSchemas(view         , list                         )       {
  const pending = list.filter((c)                         => c.kind === 'resource' && !LOADED.has(c.type) && !LOADING.has(c.type));
  if (pending.length === 0) return;
  for (const c of pending) LOADING.add(c.type);
  void Promise.allSettled(pending.map((c) => loadResource(c.type).then(() => LOADED.add(c.type)))).then(() => {
    for (const c of pending) LOADING.delete(c.type);
    view.redraw();
  });
}

export const terraformBlueprint = (c                   )                        => findTerraformBlueprint(c.blueprintId);

export const STATUS_TONE                                 = { ok: 'good', partial: 'warn', unresolved: 'danger', invalid: 'danger' };

/** What a component becomes on the platform, with the [U] / [C] mark when the tier pattern's facts are not verified. */
function onPlatform(c              , p          )              {
  if (c.kind === 'resource') return el('code', { text: c.type });
  if (c.kind === 'config') return el('code', { text: c.blueprintId });
  const tp = c.tierPattern ?? 'vm';
  const t = tierTarget(tp, p);
  const flagged = TIER_PATTERNS[tp].facts.find((f) => f.verification === 'I' || f.verification === 'C');
  if (isNone(t)) return el('span', {}, chip('none', 'danger'), ` ${t.none}`);
  return el('span', {}, t.service, t.noTerraform ? chip('runbook', 'warn', t.noTerraform) : null, ' ', factBadge(flagged?.verification, flagged?.source));
}

export function renderComponents(view         )              {
  const { app, platform: p } = view;
  const state = uiOf(app.id);
  const shown = componentsOn(view.plan, app.id, p);
  const list = shown.components;
  loadSchemas(view, list);
  const edit = (change                                , redraw = false) => view.edit(change, { redraw });

  const rows = list.map((c) => {
    const status = c.status ?? 'ok';
    const bp = c.kind === 'resource' ? terraformBlueprint(c) : undefined;
    const errs = c.kind === 'resource' && LOADED.has(c.type) ? componentFindings(c, bp).filter((f) => f.severity === 'error').length : 0;
    let patternCell             ;
    if (c.kind === 'pattern') {
      const ranked = rankComponentPatterns(view.plan, app.id, c.id, p);
      const options = ranked.map((r) => ({
        value: r.tierPattern,
        label: `${labelOf(TIER_PATTERN_OPTIONS, r.tierPattern)} (${r.eliminated ? `ruled out: ${r.eliminated}` : `score ${r.score}`})`,
      }));
      if (c.tierPattern && !options.some((o) => o.value === c.tierPattern)) options.push({ value: c.tierPattern, label: labelOf(TIER_PATTERN_OPTIONS, c.tierPattern) });
      patternCell = dropdown(options, c.tierPattern ?? '', (v) => edit((pl) => setTierPattern(pl, app.id, c.id, (v || undefined)                           , p), true), { blank: 'The pattern\'s default', label: `Tier pattern of ${c.name}`, control: 'component-tier-pattern' });
    } else {
      patternCell = el('code', { text: c.kind === 'resource' ? c.type : c.blueprintId });
    }
    const actions = el('div', { class: 'btn-row', style: { flexWrap: 'wrap' } },
      c.kind === 'resource' ? button('Edit', () => { state.editing = c.id; view.redraw(); }, { small: true, control: 'component-edit' }) : null,
      c.kind === 'config' ? button('Edit', () => view.go('configuration'), { small: true }) : null,
      status === 'unresolved' ? button(`Leave out on ${PLATFORM_NAME[p]}`, () => edit((pl) => {
        const ap = pl.appPlans?.find((x) => x.app === app.id);
        return ap ? { ...pl, appPlans: (pl.appPlans ?? []).map((x) => (x.app === app.id ? leaveOut(x, p, c.id) : x)) } : pl;
      }, true), { small: true, control: 'component-leave-out' }) : null,
      button('Remove', () => {
        const refs = referencesTo(list, c);
        if (refs.length > 0 && !globalThis.confirm?.(`${c.name} is referred to by ${refs.join(', ')}. Remove it anyway? Those references will need translating.`)) return;
        if (state.editing === c.id) delete state.editing;
        edit((pl) => removeComponent(pl, app.id, p, c.id), true);
      }, { small: true, control: 'component-remove' }));
    return [
      textInput(c.name, (v) => edit((pl) => updateComponent(pl, app.id, p, c.id, { name: v }), true), { label: `Name of ${c.name}` }),
      dropdown(COMPONENT_TIER_OPTIONS, c.tier, (v) => edit((pl) => updateComponent(pl, app.id, p, c.id, { tier: v                  })), { label: `Tier of ${c.name}` }),
      labelOf(COMPONENT_KIND_OPTIONS, c.kind),
      patternCell,
      c.kind === 'pattern' ? [...c.servers, ...c.databases].join(', ') || (c.servers.length + c.databases.length === 0 ? '—' : '') : c.kind === 'config' ? (c.appliesTo.join(', ') || 'all servers') : '',
      summaryOf(c),
      onPlatform(c, p),
      el('span', {},
        chip(labelOf(COMPONENT_STATUS_OPTIONS, errs > 0 ? 'invalid' : status), STATUS_TONE[errs > 0 ? 'invalid' : status] ?? 'neutral'),
        c.translatedFrom ? chip(`from ${PLATFORM_NAME[c.translatedFrom.platform]}: ${c.translatedFrom.carried} carried, ${c.translatedFrom.dropped.length} not`, c.translatedFrom.dropped.length > 0 ? 'warn' : 'neutral') : null),
      actions,
    ];
  });

  const findings = [...shown.findings, ...(view.appPlan.variants[p] ? variantFindings(view.appPlan, p) : [])];
  const root = el('div', {},
    el('section', { class: 'card', attrs: { 'data-control': 'components' } },
      el('div', { class: 'card-title' }, el('h2', { text: `Components on ${PLATFORM_NAME[p]}` })),
      note(shown.created ? `There is no ${PLATFORM_NAME[p]} variant saved yet: this is the one the first change creates (${view.appPlan.origin === 'new' ? 'from the pattern' : 'derived from the servers, or translated from another cloud'}).` : 'Each cloud keeps its own set of components; switching cloud on Target selects that cloud\'s set unchanged, or translates one.'),
      rowsTable(['Component', 'Tier', 'Kind', 'Pattern / resource type', 'Servers', 'Summary', `On ${PLATFORM_NAME[p]}`, 'Status', ''], rows, { empty: 'No components yet: add from patterns, or add any service.' }),
      buttonRow(
        button('Add from patterns', () => { state.panel = state.panel === 'patterns' ? undefined : 'patterns'; view.redraw(); }, { control: 'components-add-pattern' }),
        button('Add any service', () => { state.panel = state.panel === 'service' ? undefined : 'service'; view.redraw(); }, { primary: true, control: 'components-add-service' }),
        button('Add role or module', () => view.go('configuration'), { control: 'components-add-config' })),
      state.message ? el('p', { class: 'small', text: state.message, attrs: { role: 'status' } }) : null,
      findings.length > 0 ? findingsList(findings) : null),
  );

  if (state.panel === 'patterns') append(root, patternsPanel(view));
  if (state.panel === 'service') {
    append(root, servicePicker(p, (type) => {
      state.message = `Loading ${type}…`;
      view.redraw();
      void resourceBlueprintFor(type, findTerraformBlueprint).then((bp) => {
        LOADED.add(type);
        const r = addResourceComponent(view.current(), app.id, p, type, { values: startingValues(bp), blueprintId: bp.id });
        if (r.component) {
          state.editing = r.component.id;
          state.panel = undefined;
          state.message = `Added ${r.component.name} (${type}). Its form has every argument ${type} takes.`;
        }
        view.edit(() => r.plan, { redraw: true });
      }).catch((e         ) => {
        state.message = `${type} could not load its schema: ${String(e instanceof Error ? e.message : e)}.`;
        view.redraw();
      });
    }, () => { state.panel = undefined; view.redraw(); }));
  }
  const editing = state.editing ? list.find((c) => c.id === state.editing) : undefined;
  if (editing && editing.kind === 'resource') append(root, resourceEditor(view, editing, list, () => { delete state.editing; view.redraw(); }));
  return root;
}

function summaryOf(c              )         {
  if (c.kind === 'pattern') return Object.entries(c.settings).map(([k, v]) => `${k}=${v}`).join(', ');
  const set = Object.entries(c.values).filter(([, v]) => v !== '');
  return set.slice(0, 3).map(([k, v]) => `${k.replace(/^r\./, '')}=${v.length > 24 ? `${v.slice(0, 24)}…` : v}`).join(', ') + (set.length > 3 ? ` (+${set.length - 3})` : '');
}

function patternsPanel(view         )              {
  const { app, platform: p } = view;
  const state = uiOf(app.id);
  const tier = state.tier ?? 'app';
  const ranked = rankForTier(view.plan, app.id, tier, p);
  return el('section', { class: 'card', attrs: { 'data-control': 'pattern-picker' } },
    el('div', { class: 'card-title' }, el('h2', { text: 'Add from patterns' })),
    note(`The tier patterns for a tier of ${app.name}, ranked for this app on ${PLATFORM_NAME[p]}: the pattern's default first, then its alternatives by the pattern's preferences. A ruled-out one names the reason.`),
    el('div', { style: { maxWidth: '20rem' } }, dropdown(COMPONENT_TIER_OPTIONS, tier, (v) => { state.tier = v                 ; view.redraw(); }, { label: 'Tier', control: 'pattern-tier' })),
    rowsTable(['Tier pattern', `On ${PLATFORM_NAME[p]}`, 'Score', 'Reasons', ''], ranked.map((r) => {
      const t = tierTarget(r.tierPattern, p);
      return [
        labelOf(TIER_PATTERN_OPTIONS, r.tierPattern),
        isNone(t) ? `none: ${t.none}` : t.service,
        r.eliminated ? chip('ruled out', 'danger', r.eliminated) : String(r.score),
        el('ul', { style: { margin: '0', paddingLeft: '1.1rem' } },
          ...(r.eliminated ? [el('li', { class: 'small', text: r.eliminated })] : []),
          ...r.reasons.map((x) => el('li', { class: 'small' }, `${x.reason} `, factBadge(x.verification, x.source)))),
        r.eliminated ? '' : button('Add', () => {
          const res = addPatternComponent(view.current(), app.id, p, tier, r.tierPattern);
          state.panel = undefined;
          state.message = res.component ? `Added ${res.component.name} (${labelOf(TIER_PATTERN_OPTIONS, r.tierPattern)}).` : '';
          view.edit(() => res.plan, { redraw: true });
        }, { small: true, control: 'pattern-add' }),
      ];
    }), { empty: 'No tier pattern is offered for this tier.' }),
    buttonRow(button('Close', () => { state.panel = undefined; view.redraw(); })));
}

function resourceEditor(view         , c                   , list                         , close            )              {
  const { app, platform: p } = view;
  const bp = terraformBlueprint(c);
  const card = el('section', { class: 'card', attrs: { 'data-control': 'resource-form', 'data-type': c.type } },
    el('div', { class: 'card-title' }, el('h2', { text: `${c.name}: ${c.type}` })));
  if (!bp) {
    append(card, findingsList(componentFindings(c, undefined)), buttonRow(button('Close', close)));
    return card;
  }
  if (!LOADED.has(c.type) && bp.inputs.length === 0) {
    append(card, note(`Loading the ${c.type} schema…`), buttonRow(button('Close', close)));
    return card;
  }
  const valuesNow = ()                                   => {
    const ap = view.current().appPlans?.find((x) => x.app === app.id);
    const cur = ap?.variants[p]?.find((x) => x.id === c.id);
    return cur && cur.kind === 'resource' ? cur.values : c.values;
  };
  const fields = el('div', { attrs: { 'data-control': 'resource-fields' } });
  const drawFields = () => {
    fields.replaceChildren(...componentForm(bp, valuesNow, (id, v) => {
      view.edit((pl) => updateComponent(pl, app.id, p, c.id, { values: { ...valuesNow(), [id]: v } }));
    }, referenceOptions(list, c.id), drawFields));
  };
  drawFields();
  append(card,
    el('p', { class: 'blueprint-description', text: bp.description }),
    note('Every argument the resource takes. A field can hold a reference instead of a literal (Reference…): the landing-zone contract, local.app_tags, or another resource of this app.'),
    findingsList(componentFindings({ ...c, values: valuesNow() }, bp), 'No issues: this resource builds as it stands.'),
    fields,
    buttonRow(button('Done', close, { primary: true, control: 'resource-done' })));
  return card;
}
