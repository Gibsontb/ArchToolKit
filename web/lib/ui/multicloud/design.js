/**
 * Landing zones (`#landing-zones`, `#landing-zones:<cloud>`) on Multi-Cloud
 * Migration & Utilities (addendum A.5.2, A.10.15).
 *
 * One cloud at a time. The pane opens on the cloud dropdown (cloud-choice.ts),
 * with the clouds the plan's applications already use and their app counts
 * next to it; with no cloud chosen and none in use it shows only that. For the
 * chosen cloud it shows its landing zone under the provider's own name:
 * - the build state: the first application on the cloud builds it, the later
 *   ones reuse it (shared), or it is designed here (shared from the start);
 * - the mode: **shared** (this page's landing zone, which app stacks read
 *   through `var.landing_zone`) or **included**; kept in
 *   `plan.execution.landingZones`;
 * - the settings (region, name prefix, account / subscription / project /
 *   compartment, networks, subnet size, zones, bastion, log retention) and
 *   the carved subnets (`designPlan`, or `designPlatform` for a cloud no
 *   application uses yet);
 * - connectivity back to the data centre in the provider's terms (Direct
 *   Connect, ExpressRoute, Cloud Interconnect, FastConnect, HCX + NSX), the
 *   cross-cloud connectors, identity, backup and DR;
 * - governance: tag enforcement and the required tags, the security baseline
 *   policies, and budgets; the findings;
 * - Generate landing zone (<cloud>), which downloads `terraform/<p>/` in
 *   landing-zone scope and marks the landing zone generated.
 * Below: the Connectivity (sites) and Identity cards and the compliance
 * settings, which every cloud shares.
 */

import { el, append, clear, downloadFile } from '../dom.js';
import { card, findingsList } from '../components.js';
import { renderBlueprintForm } from '../blueprint-form.js';
                                                    
                                                                                            
                                                      
import { zip } from '../../kit/archive.js';
import { foundationPlansFor, landingZoneSettings } from '../../multicloud/plan/design/index.js';
import { terraformFiles } from '../../multicloud/plan/generate/terraform.js';
import {
  BASTION_OPTIONS, CONNECTION_OPTIONS, DEFAULT_LANDING_ZONE, FRAMEWORK_OPTIONS, KEY_MANAGEMENT_OPTIONS, LANDING_ZONE_MODE_OPTIONS,
  LOG_RETENTION_OPTIONS, NETWORK_BASE, PLATFORM_LABELS, SECURITY_BASELINE_OPTIONS, SUBNET_PREFIX_OPTIONS, ZONE_COUNT_OPTIONS,
  AD_STRATEGY_OPTIONS, CLOUD_SIGN_IN_OPTIONS, DNS_STRATEGY_OPTIONS, defaultExecution, overrideKey, slugName,
} from '../../multicloud/plan/options.js';
                                                                                                                                 
import { planModel, platformDesignFor } from './plan-model.js';
import { appConnectors, placedOn } from '../../multicloud/plan/apps/connectors.js';
import { appPlanOf } from '../../multicloud/plan/apps/components.js';
import { designAnswers } from '../../multicloud/plan/apps/design.js';
import {
  CLOUD_NAMES, DC_LINK_NAMES, LANDING_ZONE_NAMES, cloudPicker, cloudUsage, isCloud, landingZoneBuild, landingZoneBuildText, onCloudChange,
  rememberCloud, resolveCloud, viewerCloud,               
} from './cloud-choice.js';
import { fill, note, rowsTable, subhead, twoColumns, watchPlan } from './pane-kit.js';
import { projectDate } from './project.js';

// ---------------------------------------------------------------------------
// The settings, as blueprint inputs
// ---------------------------------------------------------------------------

const SCOPE_LABEL                                     = {
  aws: 'AWS account id',
  azure: 'Subscription id',
  google: 'Project id',
  oci: 'Compartment OCID',
  vmware: 'vSphere folder',
};
const REGION_LABEL                                     = {
  aws: 'Region', azure: 'Region', google: 'Region', oci: 'Region', vmware: 'vCenter (FQDN)',
};
const POLICY_ENGINE                                     = {
  aws: 'AWS Organizations tag policy and AWS Config managed rules',
  azure: 'Azure Policy: the built-in "require a tag" / "inherit a tag" and the framework initiatives',
  google: 'Google Cloud organization policies (where the organization is in scope)',
  oci: 'OCI tag defaults, Cloud Guard targets and security zones',
  vmware: 'vCenter tags and VCF Operations compliance (no Terraform governance item)',
};

const YES_NO                          = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
export const TAG_MODE_OPTIONS                          = [
  { value: 'enforce', label: 'Enforce: deny resources without the required tags' },
  { value: 'inherit', label: 'Default: inherit the tags from the scope, do not deny' },
  { value: 'off', label: 'Off' },
];
export const BASELINE_POLICY_OPTIONS                          = [
  { value: 'on', label: 'On: the baseline and the frameworks\' policy sets' },
  { value: 'off', label: 'Off' },
];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'JPY', 'NZD', 'SEK', 'SGD', 'INR'];
const ALERTS = ['50', '75', '80', '90', '100', '110'];
export const DEFAULT_TAGS = ['owner |  | yes', 'cost-centre |  | yes', 'environment |  | yes', 'application |  | yes', 'data-classification | internal | no'].join('\n');

/** The governance card's override keys for a platform. */
export const governanceKey = (p          , field                                               )         => overrideKey(p, 'governance', field);

const opts = (list                                             )                 => list.map((o) => ({ value: o.value, label: o.label }));

/** The landing-zone card's inputs for one platform, with their defaults. */
export function landingZoneInputs(plan      , pd                )                                                                 {
  const p = pd.platform;
  const lz = (field        ) => overrideKey(p, 'lz', field);
  const net = (name        , field        ) => overrideKey(p, `network-${name}`, field);
  const defaultPrefix = `${slugName(plan.name) || 'plan'}-${{ aws: 'aws', azure: 'az', google: 'gcp', oci: 'oci', vmware: 'vcf' }[p]}`;
  const inputs                   = [
    { id: `${p}:region:primary`, label: REGION_LABEL[p], control: 'text', placeholder: pd.region, hint: p === 'vmware' ? 'The workload domain vCenter' : 'Primary region' },
    ...(p === 'vmware' ? [] : [{ id: `${p}:region:dr`, label: 'DR region', control: 'text'         , placeholder: 'None', hint: 'Blank: no DR region' }]),
    { id: lz('prefix'), label: 'Name prefix', control: 'text', placeholder: defaultPrefix, hint: `Blank: ${defaultPrefix}` },
    { id: lz('scope'), label: SCOPE_LABEL[p], control: 'text', placeholder: 'Blank: a variable', hint: 'Blank: asked for as a variable' },
  ];
  const defaults                         = {
    [`${p}:region:primary`]: '', [`${p}:region:dr`]: '', [lz('prefix')]: '', [lz('scope')]: '',
  };
  if (p === 'vmware') {
    for (const [field, label] of [['datacenter', 'Datacenter'], ['cluster', 'Cluster'], ['datastore', 'Datastore'], ['storage-policy', 'vSAN storage policy'], ['folder', 'VM folder']]         ) {
      inputs.push({ id: lz(field), label, control: 'text', hint: 'Blank: the generated default' });
      defaults[lz(field)] = '';
    }
  }
  inputs.push(
    { id: lz('subnet-size'), label: 'Subnet size per tier', control: 'select', options: opts(SUBNET_PREFIX_OPTIONS) },
    { id: lz('zones-prod'), label: 'Zones (production)', control: 'select', options: opts(ZONE_COUNT_OPTIONS) },
    { id: lz('zones-nonprod'), label: 'Zones (non-production)', control: 'select', options: opts(ZONE_COUNT_OPTIONS) },
  );
  defaults[lz('subnet-size')] = DEFAULT_LANDING_ZONE.subnetPrefix;
  defaults[lz('zones-prod')] = String(DEFAULT_LANDING_ZONE.zonesProd);
  defaults[lz('zones-nonprod')] = String(DEFAULT_LANDING_ZONE.zonesNonprod);
  if (p !== 'vmware') {
    inputs.push(
      { id: lz('bastion'), label: 'Bastion', control: 'select', options: opts(BASTION_OPTIONS) },
      { id: lz('log-retention'), label: 'Log retention', control: 'select', options: opts(LOG_RETENTION_OPTIONS), hint: 'Flow logs and central logging are always on' },
    );
    defaults[lz('bastion')] = DEFAULT_LANDING_ZONE.bastion;
    defaults[lz('log-retention')] = String(DEFAULT_LANDING_ZONE.logRetentionDays);
  }
  const names = pd.networks.length > 0 ? pd.networks.map((n) => n.name) : ['prod'];
  names.forEach((name) => {
    const base = NETWORK_BASE[p] + (name === 'nonprod' ? 1 : 0);
    inputs.push(
      { id: net(name, 'cidr'), label: `${name === 'prod' ? 'Production' : 'Non-production'} network (IPv4)`, control: 'text', placeholder: `10.${base}.0.0/16`, hint: `Blank: 10.${base}.0.0/16` },
      { id: net(name, 'ipv6'), label: `${name === 'prod' ? 'Production' : 'Non-production'} network: IPv6 (dual stack)`, control: 'select', options: YES_NO },
    );
    defaults[net(name, 'cidr')] = '';
    defaults[net(name, 'ipv6')] = 'yes';
  });
  return { inputs, defaults };
}

/** The per-platform governance card's inputs. */
export function governanceInputs(p          )                                                                 {
  return {
    inputs: [
      { id: governanceKey(p, 'tags-mode'), label: 'Tag enforcement', control: 'select', options: TAG_MODE_OPTIONS },
      {
        id: governanceKey(p, 'tags'), label: 'Tags', control: 'textarea', hint: 'Tag | Default value | Required',
        options: YES_NO.map((o) => ({ ...o, group: 'Required' })),
        help: 'Every resource carries these. A default value is applied where the platform can default a tag.',
      },
      { id: governanceKey(p, 'baseline'), label: 'Security baseline policies', control: 'select', options: BASELINE_POLICY_OPTIONS },
      {
        id: governanceKey(p, 'budgets'), label: 'Budgets', control: 'textarea', hint: 'Scope | Monthly amount | Currency | Alert at %',
        options: [...CURRENCIES.map((c) => ({ value: c, label: c, group: 'Currency' })), ...ALERTS.map((a) => ({ value: a, label: `${a}%`, group: 'Alert at %' }))],
        help: 'Your own amounts; a scope is the landing zone, an environment or an application.',
      },
    ],
    defaults: { [governanceKey(p, 'tags-mode')]: 'enforce', [governanceKey(p, 'tags')]: DEFAULT_TAGS, [governanceKey(p, 'baseline')]: 'on', [governanceKey(p, 'budgets')]: '' },
  };
}

/** The estate-wide governance inputs (these are requirements, shared by every platform). */
const ESTATE_GOVERNANCE                            = [
  { id: 'frameworks', label: 'Compliance frameworks', control: 'checklist', options: opts(FRAMEWORK_OPTIONS), hint: 'Select the policy sets' },
  { id: 'securityBaseline', label: 'Security baseline', control: 'select', options: opts(SECURITY_BASELINE_OPTIONS) },
  { id: 'keys', label: 'Key management', control: 'select', options: opts(KEY_MANAGEMENT_OPTIONS) },
];

/** The landing-zone mode of a platform: shared when it is designed here. */
export function landingZoneMode(plan      , p          )                        {
  return plan.execution?.landingZones?.[p] ? 'shared' : 'included';
}

/** A plan with a platform's landing-zone mode set. */
export function withLandingZoneMode(plan      , p          , mode                       )       {
  const execution = plan.execution ?? defaultExecution();
  const landingZones = { ...execution.landingZones };
  if (mode === 'shared') landingZones[p] = landingZones[p] ?? 'designed';
  else delete landingZones[p];
  return { ...plan, execution: { ...execution, landingZones } };
}

/** A plan with one landing-zone card value set (the regions, the mode, or an override). */
export function withLandingZoneValue(plan      , id        , value        , defaults                                  )       {
  const region = /^(aws|azure|google|oci|vmware):region:(primary|dr)$/.exec(id);
  if (region) {
    const p = region[1]            ;
    const current = plan.requirements.regions[p] ?? { primary: '' };
    const next = region[2] === 'primary' ? { ...current, primary: value.trim() } : { primary: current.primary, ...(value.trim() ? { dr: value.trim() } : {}) };
    return { ...plan, requirements: { ...plan.requirements, regions: { ...plan.requirements.regions, [p]: next } } };
  }
  const mode = /^(aws|azure|google|oci|vmware):lz-mode$/.exec(id);
  if (mode) return withLandingZoneMode(plan, mode[1]            , value === 'shared' ? 'shared' : 'included');
  const overrides = { ...plan.designOverrides };
  if (value.trim() === '' || value === defaults[id]) delete overrides[id];
  else overrides[id] = value;
  return { ...plan, designOverrides: overrides };
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export function mount(root             , ctx             )       {
  const top = el('div', { class: 'stack' });
  const cards = el('div', { class: 'stack', attrs: { 'data-control': 'landing-zones' } });
  append(root, el('div', { class: 'stack', style: { minWidth: '0' } }, top, cards));
  /** The parts of the cloud's card that follow the plan without redrawing the form. */
  let refreshers                 = [];
  let drawn = '';

  const chosen = ()                       => {
    const plan = ctx.session.plan();
    return resolveCloud(ctx.arg(), viewerCloud(), cloudUsage(plan, planModel(plan).decision));
  };
  const shape = (plan      , cloud                      )         => `${cloud ?? ''}|${cloud ? platformDesignFor(plan, cloud)?.inPlan ?? 'x' : ''}`;

  const draw = ()       => {
    refreshers = [];
    clear(top);
    clear(cards);
    const plan = ctx.session.plan();
    const model = planModel(plan);
    const usage = cloudUsage(plan, model.decision);
    const cloud = chosen();
    drawn = shape(plan, cloud);
    append(top, intro(plan, cloud, usage, model.failure, (next) => {
      // Keep the address in step (`#landing-zones:<cloud>`) without re-routing the page.
      if (globalThis.location && globalThis.history) {
        const url = new URL(globalThis.location.href);
        url.hash = next ? `landing-zones:${next}` : 'landing-zones';
        globalThis.history.replaceState(null, '', url.toString());
      }
      draw();
    }));
    if (!cloud) return;
    const pd = platformDesignFor(plan, cloud);
    if (!pd) {
      append(cards, card(LANDING_ZONE_NAMES[cloud], el('div', { class: 'tip warn', text: `The ${CLOUD_NAMES[cloud]} landing zone could not be designed${model.failure ? `: ${model.failure}` : '.'}` })));
      return;
    }
    append(cards, platformCard(ctx, pd.design, (r) => refreshers.push(r)));
    append(cards, estateFoundations(ctx, cloud));
    append(cards, estateGovernance(ctx));
  };
  const refresh = ()          => {
    const plan = ctx.session.plan();
    if (shape(plan, chosen()) !== drawn) return true;
    for (const r of refreshers) r();
    return false;
  };
  draw();
  watchPlan(ctx, draw, refresh);
  ctx.onArg(() => {
    const a = ctx.arg().split('/')[0] ?? '';
    if (isCloud(a) && a !== viewerCloud()) rememberCloud(a);
    else draw();
  });
  onCloudChange(() => {
    if (shape(ctx.session.plan(), chosen()) !== drawn) draw();
  });
}

function intro(plan      , cloud                      , usage                     , failure                    , onChange                                       )              {
  return card(
    cloud ? `Landing zone: ${CLOUD_NAMES[cloud]}` : 'Landing zones',
    cloudPicker({
      cloud, usage, onChange, control: 'lz-cloud',
      prompt: 'Choose the cloud to design its landing zone. One cloud at a time.',
    }),
    failure ? el('div', { class: 'tip warn' }, el('strong', { text: 'The plan could not be decided: ' }), el('span', { text: failure })) : null,
    cloud
      ? note(`${LANDING_ZONE_NAMES[cloud]}: its networks, connectivity back to the data centre (${DC_LINK_NAMES[cloud]}), identity, backup and governance. The first application on ${CLOUD_NAMES[cloud]} builds it; the later ones reuse it (shared).`)
      : null,
    cloud && plan.apps.length === 0
      ? el('div', { class: 'small muted', attrs: { 'data-control': 'no-apps' } }, 'No applications yet: the landing zone can be designed on its own. ', el('a', { text: 'Open Application Migration →', attrs: { href: 'migration.html#applications' } }))
      : null,
  );
}

const belongsTo = (f         , p          )          => (f.path ?? '').startsWith(`${p}:`) || f.message.startsWith(`${p} `) || f.message.startsWith(`${p}:`) || f.message.startsWith(PLATFORM_LABELS[p]);

/** How a site connects to the cloud, in the provider's own terms. */
export function connectionText(p          , method        )         {
  if (method === 'vpn') return p === 'vmware' ? 'NSX IPsec VPN (IPsec + BGP)' : 'Site-to-site VPN (IPsec + BGP)';
  if (method === 'circuit') return DC_LINK_NAMES[p];
  if (method === 'circuit-with-vpn-backup') return `${DC_LINK_NAMES[p]}, with a VPN backup`;
  return CONNECTION_OPTIONS.find((o) => o.value === method)?.label ?? method;
}

/** The Connectivity and Identity cards (the sites and the directory every landing zone uses), under the chosen cloud's link. */
function estateFoundations(ctx             , cloud          )              {
  const holder = el('div', { class: 'stack', attrs: { 'data-control': 'estate-foundations' } });
  const head = note(`Connectivity back to the data centre on ${CLOUD_NAMES[cloud]}: ${DC_LINK_NAMES[cloud]}. The sites and the directory below are the same for every cloud.`, 'lz-dc-link');
  void import('./requirements.js').then((mod) => {
    const m = mod                                      ;
    const connectivity = m['mountConnectivity'];
    const identity = m['mountIdentity'];
    if (typeof connectivity === 'function' && typeof identity === 'function') {
      clear(holder);
      const c = el('div', { attrs: { 'data-control': 'connectivity-card' } });
      const i = el('div', { attrs: { 'data-control': 'identity-card' } });
      append(holder, head, c, i);
      (connectivity                                                 )(c, ctx);
      (identity                                                 )(i, ctx);
      return;
    }
    fill(holder, head, foundationsSummary(ctx.session.plan(), cloud));
  }, () => fill(holder, head, foundationsSummary(ctx.session.plan(), cloud)));
  return holder;
}

/** Read-only Connectivity and Identity, when the editable cards cannot load. */
function foundationsSummary(plan      , cloud          )              {
  const req = plan.requirements;
  const label = (list                                             , v        ) => list.find((o) => o.value === v)?.label ?? v;
  return card(
    'Connectivity and identity',
    subhead('Sites'),
    req.sites.length === 0
      ? note('No sites: the landing zone has no connection back to the data centre.')
      : rowsTable(['Site', 'VPN peer', 'BGP ASN', 'CIDRs', 'Bandwidth', 'Circuit'], req.sites.map((s) => [s.name, s.vpnPeer ?? '', s.bgpAsn ?? '', s.cidrs.join(' '), s.bandwidth, s.circuit])),
    note(`Connection: ${connectionText(cloud, req.connection)}.`),
    subhead('Identity'),
    rowsTable(['Setting', 'Value'], [
      ['Active Directory', label(AD_STRATEGY_OPTIONS, req.identity.adStrategy)],
      ['Domain', req.identity.domain ?? ''],
      ['Cloud sign-in', label(CLOUD_SIGN_IN_OPTIONS, req.identity.cloudSignIn)],
      ['DNS', label(DNS_STRATEGY_OPTIONS, req.identity.dns)],
    ]),
  );
}

/** Frameworks, baseline and key management: requirements every landing zone follows. */
function estateGovernance(ctx             )              {
  const values = ()                  => {
    const r = ctx.session.plan().requirements;
    return { frameworks: r.frameworks.join(', '), securityBaseline: r.securityBaseline, keys: r.keys };
  };
  const set = (id        , v        )       => {
    ctx.session.update((p) => {
      const req = p.requirements;
      if (id === 'frameworks') return { ...p, requirements: { ...req, frameworks: v.split(',').map((x) => x.trim()).filter(Boolean)                } };
      if (id === 'securityBaseline') return { ...p, requirements: { ...req, securityBaseline: v                     } };
      if (id === 'keys') return { ...p, requirements: { ...req, keys: v                  } };
      return p;
    });
  };
  return card(
    'Compliance: the same on every cloud',
    note('The frameworks select the policy sets the landing zone assigns; the baseline and key management apply everywhere.'),
    ...renderBlueprintForm({ inputs: ESTATE_GOVERNANCE }, { values, set }),
  );
}

/**
 * The cross-cloud connectors the application designs (Application Migration's
 * decision wizard) put on this platform.
 */
function crossCloudRows(plan      , p          )              {
  const rows             = [];
  for (const app of plan.apps) {
    if (placedOn(appPlanOf(plan, app.id)) !== p) continue;
    for (const c of appConnectors(plan, app.id, p, designAnswers(plan, app.id).answers)) {
      if (c.purpose !== 'dependency') continue;
      rows.push([app.name, `${c.peer ?? ''} (${CLOUD_NAMES[c.there            ] ?? c.there})`, c.option.name, c.build.generated ? `${app.name}'s stack (${p === 'vmware' ? 'vsphere' : p}_app_connector)` : `Not generated: ${c.build.reason ?? ''}`]);
    }
  }
  return el('div', { attrs: { 'data-control': `lz-connectors-${p}` } },
    rows.length === 0 ? note('No application on this cloud depends on one on another cloud.') : rowsTable(['Application', 'Peer (cloud)', 'Connector', 'Built by'], rows));
}

function platformCard(ctx             , pd                , onRefresh                         )              {
  const p = pd.platform;
  const plan = ctx.session.plan();
  const lz = landingZoneInputs(plan, pd);
  const gov = governanceInputs(p);
  const defaults = { ...lz.defaults, ...gov.defaults };
  const values = ()                  => {
    const current = ctx.session.plan();
    const out                         = {};
    for (const [id, d] of Object.entries(defaults)) out[id] = current.designOverrides[id] ?? d;
    out[`${p}:region:primary`] = current.requirements.regions[p]?.primary ?? '';
    out[`${p}:region:dr`] = current.requirements.regions[p]?.dr ?? '';
    out[`${p}:lz-mode`] = landingZoneMode(current, p);
    return out;
  };
  const binding = { values, set: (id        , v        ) => ctx.session.update((cur) => withLandingZoneValue(cur, id, v, defaults)) };
  const modeInput                 = {
    id: `${p}:lz-mode`, label: 'Landing-zone mode', control: 'select', options: opts(LANDING_ZONE_MODE_OPTIONS),
    help: 'Shared: this landing zone is built once, and every app stack on the cloud reads it (var.landing_zone). Included: the first application on the cloud builds it in its own project, and the later ones reuse it.',
  };

  const state = el('p', { class: 'small', attrs: { 'data-control': `lz-state-${p}` }, style: { overflowWrap: 'anywhere' } });
  const subnets = el('div', { attrs: { 'data-control': `subnets-${p}` } });
  const foundation = el('div');
  const placement = el('div');
  const findings = el('div', { style: { overflowWrap: 'anywhere', wordBreak: 'break-word' } });
  const generated = el('div', { attrs: { 'data-control': `lz-generated-${p}` }, style: { overflowWrap: 'anywhere', wordBreak: 'break-word' } });

  const refresh = ()       => {
    const cur = ctx.session.plan();
    const model = planModel(cur);
    const one = platformDesignFor(cur, p);
    const d = one?.design ?? pd;
    state.textContent = landingZoneBuildText(landingZoneBuild(cur, p, model.decision), p);
    const rows = d.networks.flatMap((n) => n.subnets.map((s) => [n.name, s.tier, s.zone || '—', s.cidr, s.ipv6Cidr ?? (n.ipv6 ? 'allocated by the platform' : '')]));
    fill(subnets, rows.length === 0 ? note('No networks are carved for this cloud (see the findings).') : rowsTable(['Network', 'Tier', 'Zone', 'IPv4', 'IPv6'], rows));
    const fps = foundationPlansFor(d, p, cur);
    fill(foundation, fps.length === 0 ? null : note(`Foundation: ${fps.map((f) => `${f.name} (${f.cidr}${f.ipv6 ? ', dual stack' : ''}, ${f.subnets.length} subnets)`).join('; ')}. Region ${d.region}${d.drRegion ? `, DR ${d.drRegion}` : ''}.`));
    fill(
      placement,
      subhead(`Connectivity back to the data centre (${DC_LINK_NAMES[p]})`),
      d.connectivity.length === 0
        ? note('No site connects to this cloud yet: add the sites under Hybrid connectivity below.')
        : rowsTable(['Site', 'Connection', 'BGP ASN (cloud side)'], d.connectivity.map((c) => [c.site, connectionText(p, c.method), String(c.cloudAsn)])),
      subhead('Cross-cloud connectors (from the application designs)'),
      crossCloudRows(cur, p),
      subhead('Identity'),
      note(`${AD_STRATEGY_OPTIONS.find((o) => o.value === d.identity.strategy)?.label ?? d.identity.strategy}${d.identity.dcNames.length ? `: ${d.identity.dcNames.join(', ')}` : ''}.`),
      subhead('Backup and DR'),
      rowsTable(['Tier', 'Frequency', 'Retention (days)', 'Copy to DR', 'Immutable'], d.backup.tiers.map((t) => [t.tier, t.frequency, String(t.retentionDays), t.copyToDr ? 'Yes' : 'No', t.immutable ? 'Yes' : 'No'])),
      d.relocate ? el('div', {}, subhead('Relocate target'), note(`${d.relocate.service}: ${d.relocate.nodes} hosts (a naive sum; size it in VCF Sizing).`), el('a', { class: 'btn btn-small', text: 'Open VCF Sizing →', attrs: { href: 'vcf-sizing.html' } })) : null,
    );
    const mine = [...landingZoneSettings(cur, p).findings, ...(one?.findings ?? []), ...model.design.findings.filter((f) => belongsTo(f, p))];
    const seen = new Set        ();
    fill(findings, mine.length === 0 ? null : el('div', {}, subhead('Findings'), findingsList(mine.filter((f) => {
      const k = `${f.code}|${f.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }))));
  };
  refresh();
  onRefresh(refresh);

  const generate = el('button', {
    class: 'btn btn-primary',
    text: `Generate landing zone (${CLOUD_NAMES[p]})`,
    attrs: { type: 'button', 'data-control': `generate-lz-${p}` },
    on: {
      click: () => {
        void (async () => {
          const cur = ctx.session.plan();
          const model = planModel(cur);
          const d = platformDesignFor(cur, p)?.design;
          if (!d) return;
          const tf = terraformFiles({ ...cur, decision: model.decision }, model.decision, { platforms: [d], findings: [] }, { scope: 'landing-zone' });
          const folder = `${slugName(cur.name) || 'plan'}-landing-zone-${p}`;
          const files = Object.fromEntries(Object.entries(tf.files).map(([k, v]) => [`${folder}/${k}`, v]));
          if (Object.keys(files).length === 0) {
            fill(generated, findingsList([...tf.findings, { code: 'lz.nothing', severity: 'warning', message: 'Nothing to generate for this cloud.' }]));
            return;
          }
          downloadFile(`${folder}.zip`, await zip(files, projectDate(cur)), 'application/zip');
          const errors = tf.findings.filter((f) => f.severity === 'error').length;
          fill(generated, note(`${Object.keys(files).length} files in ${folder}.zip${errors ? `, with ${errors} error finding${errors === 1 ? '' : 's'}` : ''}.`), tf.findings.length ? findingsList(tf.findings) : null);
          ctx.session.update((x) => {
            const execution = x.execution ?? defaultExecution();
            return { ...x, execution: { ...execution, landingZones: { ...execution.landingZones, [p]: 'generated' } } };
          }, { immediate: true });
        })();
      },
    },
  });

  return el(
    'section',
    { class: 'card', attrs: { 'data-platform': p }, style: { minWidth: '0' } },
    el('div', { class: 'card-title' }, el('h2', { text: LANDING_ZONE_NAMES[p] })),
    state,
    ...renderBlueprintForm({ inputs: [modeInput] }, binding),
    subhead('Settings'),
    twoColumns(renderBlueprintForm({ inputs: lz.inputs }, binding)),
    foundation,
    subhead('Networks and subnets'),
    subnets,
    placement,
    subhead('Governance'),
    note(`Enforced with ${POLICY_ENGINE[p]}.`),
    ...renderBlueprintForm({ inputs: gov.inputs }, binding),
    findings,
    el('div', { class: 'btn-row', style: { marginTop: 'var(--space-4)' } }, generate),
    generated,
  );
}
