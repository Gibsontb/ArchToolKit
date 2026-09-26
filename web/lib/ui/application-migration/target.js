/**
 * The workspace's Target tab (addendum A.2.4): the developed presence of the
 * app on the one cloud chosen for it (else the recommendation).
 *
 * Choose the cloud here (or with Choose this cloud on Compare): the app's
 * component set for that cloud is selected unchanged when it has one, and
 * translated from the current one otherwise, so switching back and forth
 * never loses anything. The table shows what is stood up — each component's
 * tier pattern, service and sized shape, and its translation status — then
 * the app's ingress, the landing-zone mode, the licences and footprint, and
 * what must exist first (the landing zone, connectivity, identity, pattern
 * prerequisites), each marked exists or missing.
 */

import { el, append } from '../dom.js';
import { findingsList } from '../components.js';
import { renderBlueprintForm } from '../blueprint-form.js';
                                                             
import { appPlanOf } from '../../multicloud/plan/apps/components.js';
import { variantFindings } from '../../multicloud/plan/apps/translate.js';
import { providerTerm } from '../../multicloud/plan/methodology.js';
import {
  INGRESS_EXPOSURE_OPTIONS, INGRESS_LB_OPTIONS, INGRESS_TLS_OPTIONS, LANDING_ZONE_MODE_OPTIONS, LICENCE_KIND_OPTIONS, LICENCE_MODEL_OPTIONS,
  TIER_PATTERN_OPTIONS, YES_NO_OPTIONS, labelOf,
} from '../../multicloud/plan/options.js';
                                                                                  
import { COMPARE_PLATFORMS, PLATFORM_NAME, editAppPlan } from './app-model.js';
import { compareAll, lastSwitch, OUTCOME_TONE } from './compare.js';
import { button, buttonRow, chip, dropdown, labelled, note, rowsTable,              } from './kit.js';

const INGRESS_INPUTS                            = [
  { id: 'fqdns', label: 'Names (FQDNs)', control: 'text', placeholder: 'shop.example.com api.example.com', hint: 'space-separated' },
  { id: 'exposure', label: 'Exposure', control: 'select', options: INGRESS_EXPOSURE_OPTIONS },
  { id: 'lb', label: 'Load balancer', control: 'select', options: INGRESS_LB_OPTIONS },
  { id: 'tls', label: 'TLS', control: 'select', options: INGRESS_TLS_OPTIONS },
  { id: 'waf', label: 'Web application firewall', control: 'select', options: YES_NO_OPTIONS },
];

const DEFAULT_INGRESS             = { fqdns: [], exposure: 'internal', lb: 'none', tls: 'terminate', waf: false };

function ingressValues(i                        )                         {
  const x = i ?? DEFAULT_INGRESS;
  return { fqdns: x.fqdns.join(' '), exposure: x.exposure, lb: x.lb, tls: x.tls, waf: x.waf ? 'yes' : 'no' };
}

function ingressFrom(v                                  , prev                        )             {
  const exposure = (v.exposure || 'internal')                          ;
  // WAF defaults to yes when the app becomes public.
  const waf = v.waf ? v.waf === 'yes' : exposure === 'public';
  const next             = {
    fqdns: (v.fqdns ?? '').split(/\s+/).map((s) => s.trim()).filter(Boolean),
    exposure, lb: (v.lb || 'none')                    , tls: (v.tls || 'terminate')                     , waf,
  };
  return prev?.exposure === 'internal' && exposure === 'public' && !v.waf ? { ...next, waf: true } : next;
}

export function renderTarget(view         )              {
  const { app, appPlan: ap, rec, platform: p } = view;
  const col = compareAll(view.plan, app.id, [p]).columns[0];
  const variants = appPlanOf(view.plan, app.id)?.variants ?? {};

  let ingress = ingressValues(ap.ingress);
  const ingressForm = el('div', { class: 'two', attrs: { 'data-control': 'target-ingress' } });
  append(ingressForm, ...renderBlueprintForm({ inputs: INGRESS_INPUTS }, {
    values: () => ingress,
    set: (id, v) => {
      ingress = { ...ingress, [id]: v };
      view.edit((pl) => editAppPlan(pl, app.id, (x) => ({ ...x, ingress: ingressFrom(ingress, x.ingress) })));
    },
  }));

  const lz = dropdown(LANDING_ZONE_MODE_OPTIONS, ap.landingZone, (v) => view.edit((pl) => editAppPlan(pl, app.id, (x) => ({ ...x, landingZone: v                    }))), { control: 'target-landing-zone', label: 'Landing zone' });
  const last = lastSwitch(app.id);
  const findings = ap.variants[p] ? variantFindings(ap, p) : [];

  return el('div', {},
    el('section', { class: 'card', attrs: { 'data-control': 'target' } },
      el('div', { class: 'card-title' }, el('h2', { text: `Target: ${PLATFORM_NAME[p]}` })),
      note(`The cloud is chosen in the design's header${rec.recommended && rec.recommended !== p ? ` (the engine would recommend ${PLATFORM_NAME[rec.recommended]})` : ''}. Every cloud this application has been designed on keeps its own components, so switching back restores them exactly; a cloud it has not been on is translated from the current one.`),
      el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end' } },
        labelled(providerTerm('landing-zone', p), lz)),
      el('div', { class: 'pill-row', style: { marginTop: 'var(--space-3)' } },
        el('span', { class: 'small', text: 'Component sets kept:' }),
        ...COMPARE_PLATFORMS.filter((x) => variants[x]).map((x) => chip(PLATFORM_NAME[x], x === p ? 'good' : 'neutral'))),
      last ? el('p', { class: 'small', text: last, attrs: { role: 'status', 'data-control': 'target-message' } }) : null,
      findings.length > 0 ? findingsList(findings) : null,
      col
        ? rowsTable(['Component', 'Kind', 'Tier pattern', 'Service', 'Size / class', 'Translation'], col.components.map((k) => [
          k.name,
          k.kind,
          k.tierPattern ? labelOf(TIER_PATTERN_OPTIONS, k.tierPattern) : '',
          k.service || k.targetTypes.join(' + '),
          k.sizes.join(', '),
          el('span', {}, chip(k.outcome, OUTCOME_TONE[k.outcome] ?? 'neutral', k.reason), k.dropped.length > 0 ? el('span', { class: 'small', text: ` ${k.dropped.length} argument(s) not carried` }) : null),
        ]), { control: 'target-components', empty: 'Nothing is stood up yet: add components.' })
        : note('This cloud is not among the allowed platforms.'),
      buttonRow(button('Edit components', () => view.go('components')), button('Size it', () => view.go('sizing')))),
    col ? el('section', { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', { text: 'Stood up for this app' })),
      rowsTable(['What', 'State'], col.standUpFirst.map((s) => [
        s.what,
        s.exists ? chip('exists', 'good') : el('span', {}, chip('missing', 'warn'), ' ', /landing zone|Connectivity|Identity/.test(s.what) ? el('a', { class: 'small', text: 'Design it on Migration & Utilities', attrs: { href: 'multicloud.html#landing-zones' } }) : null),
      ]), { empty: 'Nothing has to exist first.' }),
      el('h3', { text: 'Footprint (sized)', style: { fontSize: '1rem', margin: 'var(--space-3) 0 var(--space-2)' } }),
      el('p', { class: 'small', text: [`${col.footprint.vcpu} vCPU`, `${col.footprint.ramGib} GiB RAM`, ...col.footprint.storage.map((s) => `${s.gib} GiB ${s.type}`), col.footprint.dbInstances ? `${col.footprint.dbInstances} database instance(s)` : '', col.footprint.managedServices.length ? `managed: ${col.footprint.managedServices.join(', ')}` : ''].filter(Boolean).join(' · ') }),
      col.licences.length > 0 ? el('p', { class: 'small', text: `Licences: ${col.licences.map((l) => `${l.count} ${labelOf(LICENCE_KIND_OPTIONS, l.kind)} (${labelOf(LICENCE_MODEL_OPTIONS, l.model)})`).join(', ')}` }) : null) : null,
    el('section', { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', { text: 'App ingress' })),
      note('How users reach the app: generated by the app ingress blueprint of the chosen cloud. WAF defaults to yes when public.'),
      ingressForm));
}
