/**
 * The workspace's Configuration tab (addendum A.2.6): the app's Ansible, in
 * order. Each item is a canned role (the migration kit's `mig_*` roles and the
 * pattern roles) or **any module** of any collection, with what it applies to
 * (one of the app's components, or every server of the app). Each opens the
 * Ansible page's own form (`renderBlueprintForm`); a module's options are
 * fetched when it is picked. The items enter the app's `site.yml` after the
 * pattern roles, in Order, with `hosts` the component's inventory group.
 */

import { el, append } from '../dom.js';
                                                        
import { ANSIBLE_BLUEPRINTS, findAnsibleBlueprint } from '../../ansible/blueprints/index.js';
import { loadModule } from '../../ansible/module-blueprints.js';
import { COMPONENT_STATUS_OPTIONS, labelOf } from '../../multicloud/plan/options.js';
                                                                                    
import { findingsList } from '../components.js';
import { PLATFORM_NAME, addConfigComponent, componentFindings, componentsOn, removeComponent, updateComponent } from './app-model.js';
import { moduleOfBlueprint } from './generate-model.js';
import { button, buttonRow, chip, dropdown, note, rowsTable, textInput,              } from './kit.js';
import { componentForm, moduleNamesOf, modulePicker } from './pickers.js';
import { STATUS_TONE } from './components.js';

/** The canned roles: the migration kit's and the patterns' Ansible blueprints. */
export function cannedRoles()                                                    {
  const seen = new Set        ();
  const out                                                    = [];
  for (const g of ANSIBLE_BLUEPRINTS) {
    for (const b of g.blueprints) {
      if (!/^(mig_|app_)/.test(b.id) || seen.has(b.id)) continue;
      seen.add(b.id);
      out.push({ value: b.id, label: b.label, group: b.id.startsWith('mig_') ? 'Migration kit' : 'Pattern roles' });
    }
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

const UI = new Map                                                                                 ();
const uiOf = (id        ) => {
  let s = UI.get(id);
  if (!s) {
    s = {};
    UI.set(id, s);
  }
  return s;
};
const LOADED = new Set        ();

export function renderConfiguration(view         )              {
  const { app, platform: p } = view;
  const state = uiOf(app.id);
  const all = componentsOn(view.plan, app.id, p).components;
  const configs = all.filter((c)                       => c.kind === 'config').sort((a, b) => a.order - b.order);
  const targets = [{ value: '', label: 'All servers of the app' }, ...all.filter((c) => c.kind === 'pattern').map((c) => ({ value: c.id, label: `Component: ${c.name}` }))];
  const roles = cannedRoles();

  const rows = configs.map((c) => {
    const bp = findAnsibleBlueprint(c.blueprintId);
    const fqcn = moduleOfBlueprint(c.blueprintId, moduleNamesOf);
    const loaded = !fqcn || LOADED.has(fqcn);
    const errs = loaded ? componentFindings(c, bp).filter((f) => f.severity === 'error').length : 0;
    return [
      textInput(String(c.order), (v) => view.edit((pl) => updateComponent(pl, app.id, p, c.id, { order: Math.max(0, Number(v) || 0) }), { redraw: true }), { type: 'number', label: `Order of ${c.name}` }),
      dropdown(targets, c.appliesTo[0] ?? '', (v) => view.edit((pl) => updateComponent(pl, app.id, p, c.id, { appliesTo: v ? [v] : [] })), { label: `Applies to, ${c.name}` }),
      fqcn ? 'Module' : 'Role',
      el('span', {}, el('code', { text: fqcn ?? c.blueprintId }), el('div', { class: 'small muted', text: bp?.label ?? '' })),
      Object.entries(c.values).filter(([, v]) => v !== '').slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', '),
      chip(labelOf(COMPONENT_STATUS_OPTIONS, errs > 0 ? 'invalid' : c.status ?? 'ok'), STATUS_TONE[errs > 0 ? 'invalid' : c.status ?? 'ok'] ?? 'neutral'),
      el('div', { class: 'btn-row', style: { flexWrap: 'wrap' } },
        button('Edit', () => { state.editing = c.id; view.redraw(); }, { small: true, control: 'config-edit' }),
        button('Remove', () => { if (state.editing === c.id) delete state.editing; view.edit((pl) => removeComponent(pl, app.id, p, c.id), { redraw: true }); }, { small: true, control: 'config-remove' })),
    ];
  });

  const roleSel = dropdown(roles, state.role ?? '', (v) => { state.role = v; }, { blank: 'Choose a role…', label: 'Role', control: 'config-role' });
  const root = el('div', {},
    el('section', { class: 'card', attrs: { 'data-control': 'configuration' } },
      el('div', { class: 'card-title' }, el('h2', { text: `Configuration on ${PLATFORM_NAME[p]}` })),
      note('Ansible for this app\'s servers, run after the pattern roles in Order. Applies to picks the component (its inventory group) or every server of the app.'),
      rowsTable(['Order', 'Applies to', 'Kind', 'Role / module', 'Summary', 'Status', ''], rows, { empty: 'No configuration yet: add a role or any module.' }),
      el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-3)' } },
        el('div', { style: { minWidth: '14rem', flex: '1 1 16rem' } }, roleSel),
        button('Add role', () => {
          const id = state.role;
          if (!id) { state.message = 'Choose a role first.'; view.redraw(); return; }
          const r = addConfigComponent(view.current(), app.id, p, id, { name: id.replace(/^(mig_|app_)/, '') });
          state.editing = r.component?.id;
          state.message = r.component ? `Added ${r.component.name}.` : '';
          view.edit(() => r.plan, { redraw: true });
        }, { control: 'config-add-role' }),
        button('Add any module', () => { state.panel = state.panel === 'module' ? undefined : 'module'; view.redraw(); }, { primary: true, control: 'config-add-module' })),
      state.message ? el('p', { class: 'small', text: state.message, attrs: { role: 'status' } }) : null));

  if (state.panel === 'module') {
    append(root, modulePicker((m) => {
      state.message = `Loading ${m.fqcn}…`;
      view.redraw();
      void loadModule(m.fqcn).then(() => {
        LOADED.add(m.fqcn);
        const r = addConfigComponent(view.current(), app.id, p, m.blueprintId, { name: m.fqcn.split('.').pop() ?? m.fqcn });
        state.editing = r.component?.id;
        state.panel = undefined;
        state.message = r.component ? `Added ${m.fqcn}. Its form has every option the module documents.` : '';
        view.edit(() => r.plan, { redraw: true });
      }).catch((e         ) => {
        state.message = `${m.fqcn} could not load its options: ${String(e instanceof Error ? e.message : e)}.`;
        view.redraw();
      });
    }, () => { state.panel = undefined; view.redraw(); }));
  }
  const editing = state.editing ? configs.find((c) => c.id === state.editing) : undefined;
  if (editing) append(root, configEditor(view, editing, all, () => { delete state.editing; view.redraw(); }));
  return root;
}

function configEditor(view         , c                 , all                         , close            )              {
  const { app, platform: p } = view;
  const bp                        = findAnsibleBlueprint(c.blueprintId);
  const fqcn = moduleOfBlueprint(c.blueprintId, moduleNamesOf);
  const card = el('section', { class: 'card', attrs: { 'data-control': 'config-form' } }, el('div', { class: 'card-title' }, el('h2', { text: `${c.name}: ${fqcn ?? c.blueprintId}` })));
  if (!bp) {
    append(card, findingsList(componentFindings(c, undefined)), buttonRow(button('Close', close)));
    return card;
  }
  if (fqcn && !LOADED.has(fqcn)) {
    append(card, note(`Loading the options of ${fqcn}…`), buttonRow(button('Close', close)));
    void loadModule(fqcn).then(() => { LOADED.add(fqcn); view.redraw(); }).catch(() => undefined);
    return card;
  }
  const valuesNow = ()                                   => {
    const cur = view.current().appPlans?.find((x) => x.app === app.id)?.variants[p]?.find((x) => x.id === c.id);
    return cur && cur.kind === 'config' ? cur.values : c.values;
  };
  const fields = el('div');
  const drawFields = () => fields.replaceChildren(...componentForm(bp, valuesNow, (id, v) => {
    view.edit((pl) => updateComponent(pl, app.id, p, c.id, { values: { ...valuesNow(), [id]: v } }));
  }, [], drawFields));
  drawFields();
  append(card,
    el('p', { class: 'blueprint-description', text: bp.description }),
    findingsList(componentFindings({ ...c, values: valuesNow() }, bp), 'No issues.'),
    fields,
    buttonRow(button('Done', close, { primary: true })));
  void all;
  return card;
}
