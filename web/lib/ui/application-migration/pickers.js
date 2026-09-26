/**
 * "Add any service" and "Add any module" (addendum A.2.6).
 *
 * The service picker lists every resource type of the platform's Terraform
 * provider(s) from the schema index alone (`resourceTypes`, `sectionOf`): no
 * schema is fetched to list them. It filters by text, by the registry's
 * section and by the equivalence map's domain, can show what each type maps to
 * on the other platforms, and sorts beta and deprecated sections last, as the
 * Terraform page does. Picking a type fetches its schema (`loadResource`) and
 * hands back the blueprint, whose form has every argument the resource takes.
 *
 * The module picker does the same over every Ansible module
 * (`moduleBlueprintsByPlatform`: grouped by platform, then heading, then
 * name), fetching a module's options only when it is picked.
 *
 * The resource and module forms are `renderBlueprintForm` — the generator
 * pages' own form — with a Reference… dropdown beside every text field that
 * offers the landing-zone contract, `local.app_tags` and the app's other
 * resources' addresses.
 */

import { el, append, clear } from '../dom.js';
import { renderBlueprintForm } from '../blueprint-form.js';
                                                                      
import { humanize, loadResource, resourceBlueprint, resourceTypes, sectionOf,                     } from '../../terraform/schema-blueprints.js';
import { DOMAIN_LABELS, EQUIVALENCE_DOMAINS, equivalents, rowOf,                        } from '../../terraform/equivalence.js';
import { loadModule, moduleBlueprintsByPlatform, NEW_PLATFORMS } from '../../ansible/module-blueprints.js';
import { addressOf } from '../../multicloud/plan/apps/translate.js';
                                                                                                
import { PLATFORM_NAME, resourceBlueprintId } from './app-model.js';
import { button, dropdown, labelled, filterRow, note, textInput } from './kit.js';

// ---------------------------------------------------------------------------
// The resource index (no schema loaded)
// ---------------------------------------------------------------------------

/** The Terraform providers a platform builds with. */
export const PROVIDERS_OF                                                        = {
  aws: ['aws'],
  azure: ['azurerm'],
  google: ['google'],
  oci: ['oci'],
  vmware: ['vsphere', 'vcf', 'nsxt', 'avi', 'vra', 'vcd'],
};

                            
                        
                                    
                           
                         
                                      
                                                       
                        
 

const INDEX = new Map                                ();

/** Every resource type of the platform's provider(s), from the index only, in rank, section, type order. */
export function resourceTypeIndex(platform          )                       {
  const cached = INDEX.get(platform);
  if (cached) return cached;
  const out              = [];
  for (const provider of PROVIDERS_OF[platform]) {
    for (const type of resourceTypes(provider)) {
      const section = sectionOf(provider, type);
      const rank = /Deprecated/.test(section) ? 2 : /Beta/.test(section) ? 1 : 0;
      const domain = rowOf(type)?.domain;
      out.push({ type, provider, section, label: humanize(type.slice(provider.length + 1)), rank, ...(domain ? { domain } : {}) });
    }
  }
  out.sort((a, b) => a.rank - b.rank || a.section.localeCompare(b.section) || a.type.localeCompare(b.type));
  INDEX.set(platform, out);
  return out;
}

                             
                         
                            
                                           
 

export function filterTypes(index                      , f            )              {
  const words = (f.text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return index.filter((e) =>
    (!f.section || e.section === f.section)
    && (!f.domain || e.domain === f.domain)
    && words.every((w) => e.type.includes(w) || e.label.toLowerCase().includes(w)));
}

/** The sections of an index, in order of first appearance. */
export function sectionsOf(index                      )           {
  return [...new Set(index.map((e) => e.section))];
}

/** What a type maps to on the other platforms, as one line. */
export function equivalentsText(type        )         {
  const eq = equivalents(type);
  return (Object.entries(eq)                                                      )
    .map(([p, v]) => `${PLATFORM_NAME[p]}: ${Array.isArray(v) ? v.join(' + ') : `none (${(v                    ).none})`}`)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// The module index
// ---------------------------------------------------------------------------

                              
                        
                               
                            
                           
                         
 

let MODULES                                    ;

/** Every Ansible module, by platform, heading and name. Blueprints stay lazy (no options fetched). */
export function moduleIndex()                         {
  if (MODULES) return MODULES;
  const out                = [];
  for (const [platform, list] of moduleBlueprintsByPlatform()) {
    for (const bp of list) out.push({ fqcn: bp.emits[0] ?? bp.id, blueprintId: bp.id, platform, heading: bp.group ?? '', label: bp.label });
  }
  MODULES = out;
  return out;
}

export const moduleNamesOf = ()           => moduleIndex().map((m) => m.fqcn);

export const MODULE_PLATFORM_LABELS                                   = {
  aws: 'AWS', azure: 'Azure', google: 'Google Cloud (GCP)', oci: 'OCI', vsphere: 'VMware vSphere', windows: 'Windows', linux: 'Linux', ...NEW_PLATFORMS,
};

export function filterModules(index                        , f                                                        )                {
  const words = (f.text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return index.filter((m) => (!f.platform || m.platform === f.platform) && words.every((w) => m.fqcn.toLowerCase().includes(w) || m.label.toLowerCase().includes(w) || m.heading.toLowerCase().includes(w)));
}

// ---------------------------------------------------------------------------
// Blueprints for picked things
// ---------------------------------------------------------------------------

/** Fetch a resource type's schema and return its blueprint (the Terraform page's own when it has it). */
export async function resourceBlueprintFor(type        , lookup                                       )                     {
  await loadResource(type);
  const id = resourceBlueprintId(type);
  return lookup(id) ?? resourceBlueprint(type, id.startsWith('res_') ? 'res' : 'vmw');
}

/** Fetch a module's options and return its blueprint. */
export async function moduleBlueprintFor(entry                                           , lookup                                       )                                 {
  await loadModule(entry.fqcn);
  return lookup(entry.blueprintId);
}

// ---------------------------------------------------------------------------
// The pickers
// ---------------------------------------------------------------------------

const SHOW = 150;

/** The "Add any service" picker for a platform. `onPick` is called with the type. */
export function servicePicker(platform          , onPick                        , onClose            )              {
  const index = resourceTypeIndex(platform);
  const sections = sectionsOf(index);
  let filter                                                                    = { text: '', section: '', domain: '' };
  let showEq = false;
  const list = el('div');
  const count = el('p', { class: 'small muted', attrs: { 'data-control': 'service-count', role: 'status' } });

  const draw = () => {
    const hits = filterTypes(index, filter);
    count.textContent = `${hits.length} of ${index.length} ${PROVIDERS_OF[platform].join(', ')} resource types${hits.length > SHOW ? `; the first ${SHOW} are listed, narrow the search for the rest` : ''}.`;
    clear(list);
    const body = el('tbody');
    for (const e of hits.slice(0, SHOW)) {
      const add = button('Add', () => onPick(e.type), { small: true, control: 'service-add' });
      add.dataset['type'] = e.type;
      append(body, el('tr', {},
        el('td', {}, el('code', { text: e.type }), el('div', { class: 'small muted', text: e.label })),
        el('td', { class: 'small', text: e.section }),
        el('td', { class: 'small', text: e.domain ? DOMAIN_LABELS[e.domain] : '' }),
        ...(showEq ? [el('td', { class: 'small', text: equivalentsText(e.type) })] : []),
        el('td', {}, add)));
    }
    append(list, el('div', { class: 'table-wrap', style: { maxHeight: '28rem', overflowY: 'auto' } },
      el('table', {}, el('thead', {}, el('tr', {}, ...['Resource type', 'Section', 'Domain', ...(showEq ? ['Equivalents'] : []), ''].map((h) => el('th', { text: h })))), body)));
  };

  const search = textInput('', (v) => { filter = { ...filter, text: v }; draw(); }, { placeholder: 'Search by type or name, e.g. sqs queue', control: 'service-search', label: 'Search resource types', onInput: true });
  const sectionSel = dropdown(sections.map((s) => ({ value: s, label: s })), '', (v) => { filter = { ...filter, section: v }; draw(); }, { blank: 'Every section', control: 'service-section', label: 'Section' });
  const domainSel = dropdown(EQUIVALENCE_DOMAINS.map((d) => ({ value: d, label: DOMAIN_LABELS[d] })), '', (v) => { filter = { ...filter, domain: v                           }; draw(); }, { blank: 'Every domain', control: 'service-domain', label: 'Domain' });
  const eqSel = dropdown([{ value: 'no', label: 'Hide equivalents' }, { value: 'yes', label: 'Show equivalents on the other platforms' }], 'no', (v) => { showEq = v === 'yes'; draw(); }, { control: 'service-equivalents', label: 'Equivalents' });
  draw();
  return el('div', { class: 'card', attrs: { 'data-control': 'service-picker' } },
    el('div', { class: 'card-title' }, el('h2', { text: `Add any service on ${PLATFORM_NAME[platform]}` })),
    note('Every resource the provider has, listed from its schema index; the form (every argument) loads when you pick one.'),
    filterRow(labelled('Search', search), labelled('Section', sectionSel), labelled('Domain', domainSel), labelled('Equivalents', eqSel)),
    count, list,
    el('div', { class: 'btn-row', style: { marginTop: 'var(--space-3)' } }, button('Close', onClose, { control: 'service-close' })));
}

/** The "Add any module" picker. `onPick` is called with the module. */
export function modulePicker(onPick                              , onClose            )              {
  const index = moduleIndex();
  const platforms = [...new Set(index.map((m) => m.platform))];
  let filter = { text: '', platform: '' };
  const list = el('div');
  const count = el('p', { class: 'small muted', attrs: { 'data-control': 'module-count', role: 'status' } });
  const draw = () => {
    const hits = filterModules(index, filter);
    count.textContent = `${hits.length} of ${index.length} Ansible modules${hits.length > SHOW ? `; the first ${SHOW} are listed, narrow the search for the rest` : ''}.`;
    clear(list);
    const body = el('tbody');
    for (const m of hits.slice(0, SHOW)) {
      const add = button('Add', () => onPick(m), { small: true, control: 'module-add' });
      add.dataset['module'] = m.fqcn;
      append(body, el('tr', {},
        el('td', {}, el('code', { text: m.fqcn }), el('div', { class: 'small muted', text: m.label })),
        el('td', { class: 'small', text: MODULE_PLATFORM_LABELS[m.platform] ?? m.platform }),
        el('td', { class: 'small', text: m.heading }),
        el('td', {}, add)));
    }
    append(list, el('div', { class: 'table-wrap', style: { maxHeight: '28rem', overflowY: 'auto' } },
      el('table', {}, el('thead', {}, el('tr', {}, ...['Module', 'Platform', 'Heading', ''].map((h) => el('th', { text: h })))), body)));
  };
  const search = textInput('', (v) => { filter = { ...filter, text: v }; draw(); }, { placeholder: 'Search, e.g. win_feature or postgresql', control: 'module-search', label: 'Search modules', onInput: true });
  const platformSel = dropdown(platforms.map((p) => ({ value: p, label: MODULE_PLATFORM_LABELS[p] ?? p })), '', (v) => { filter = { ...filter, platform: v }; draw(); }, { blank: 'Every platform', control: 'module-platform', label: 'Platform' });
  draw();
  return el('div', { class: 'card', attrs: { 'data-control': 'module-picker' } },
    el('div', { class: 'card-title' }, el('h2', { text: 'Add any module' })),
    note('Every Ansible module of every collection the toolkit indexes; its options load when you pick one.'),
    filterRow(labelled('Search', search), labelled('Platform', platformSel)),
    count, list,
    el('div', { class: 'btn-row', style: { marginTop: 'var(--space-3)' } }, button('Close', onClose, { control: 'module-close' })));
}

// ---------------------------------------------------------------------------
// References and the form
// ---------------------------------------------------------------------------

/** What the Reference… dropdown offers: the landing-zone contract, the app tags, and the other resources' addresses. */
export function referenceOptions(components                         , self                    )                 {
  const lz = 'Landing zone (local.landing_zone; var.landing_zone when shared)';
  const out                 = [];
  for (const tier of ['web', 'app', 'db']) {
    for (const zone of ['a', 'b', 'c']) out.push({ value: `local.landing_zone.subnet_ids["prod/${tier}/${zone}"]`, label: `subnet prod/${tier}/${zone}`, group: lz });
  }
  for (const tier of ['web', 'app', 'db']) out.push({ value: `local.landing_zone.security_group_ids["prod/${tier}"]`, label: `security group prod/${tier}`, group: lz });
  out.push(
    { value: 'local.landing_zone.kms_key_id', label: 'kms_key_id', group: lz },
    { value: 'local.landing_zone.log_destination', label: 'log_destination', group: lz },
    { value: 'local.landing_zone.zones', label: 'zones', group: lz },
    { value: 'local.app_tags', label: 'local.app_tags (the atk_* tags, owner, cost centre)', group: 'App' },
  );
  for (const c of components) {
    if (c.kind !== 'resource' || c.id === self) continue;
    const address = addressOf(c                     );
    for (const attr of ['id', 'arn', 'name']) out.push({ value: `${address}.${attr}`, label: `${address}.${attr}`, group: 'This app\'s resources' });
  }
  return out;
}

/** A blueprint's form bound to a component's values; every change goes to `set`. */
export function componentForm(bp           , values                                        , set                                     , references                         , rerender            )                {
  return renderBlueprintForm(bp, {
    values: values,
    set,
    rerender,
    reference: references.length === 0 ? undefined : (put) => {
      const sel = dropdown(references, '', (v) => {
        if (v) put(v);
        sel.value = '';
      }, { blank: 'Reference…', label: 'Insert a reference' });
      sel.classList.add('ref-picker');
      return sel;
    },
  });
}
