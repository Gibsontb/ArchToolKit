/**
 * What every "From an application plan" blueprint shares (addendum A.4.10).
 *
 * These are the per-app items of a stack: the app context, the ingress, the
 * pattern targets (PaaS, containers, file, VDI, SAP, messaging, data
 * services, appliances), the app's monitoring and the landing zone's
 * governance. They are written like the migration blueprints and on the same
 * contract (`../migration/common.ts`, read-only here):
 *
 *   - `landing_zone_source`: `stack` reads `local.landing_zone` (the landing
 *     zone is an item of the same stack: the "included" mode); `variables`
 *     declares `var.landing_zone` of the same shape and a provider block, so
 *     the item stands alone, and in a stack with no landing zone (the
 *     "shared" mode) every item declares the identical variable and provider,
 *     which the stack keeps once;
 *   - the app's tags on every resource that takes them, from the item's own
 *     inputs (app, component, criticality, owner, cost centre), so an item
 *     works with or without the app context beside it; `atk_component` is the
 *     tag the Ansible inventory groups components by;
 *   - IPv6 alongside IPv4 wherever the service has it, driven by the landing
 *     zone's `ipv6[network]`;
 *   - no credential in a file (sensitive variables with no default, or the
 *     cloud's own managed secret), nothing that dates or signs the output,
 *     and everything created enabled.
 *
 * vSphere (VCF 9.1) has no landing-zone contract: its items take the vCenter
 * and the objects they sit in by name.
 */

import { info,              } from '../../../core/findings.js';
                                                                                               
import { str as valueOf } from '../../../kit/blueprint.js';
                                             
import {
  attrs,
  consumerPreamble,
  gcpLabel,
  hcl,
  ident,
  lzRef,
  lzSource,
  mainTf,
  q,
  rname,
  secretVariable,
  terraformBlock,
  variable,
  x,
                
} from '../migration/common.js';

/** The picker heading of every blueprint in this folder. */
export const PATTERN_GROUP = 'From an application plan';

/** The platforms a pattern blueprint is written for: the four clouds and vSphere (VCF 9.1). */
                                                   

export const CRITICALITIES = ['tier0', 'tier1', 'tier2', 'tier3']         ;
                                                           

export const CRITICALITY_OPTIONS                          = [
  { value: 'tier0', label: 'Tier 0: mission critical' },
  { value: 'tier1', label: 'Tier 1: business critical' },
  { value: 'tier2', label: 'Tier 2: business operational' },
  { value: 'tier3', label: 'Tier 3: administrative' },
];

/** The inputs every per-app blueprint takes: who the resources belong to. The planner fills them. */
export function appInputs()                   {
  return [
    { id: 'app', label: 'Application', control: 'text', default: 'shop', hint: 'Written as the atk_app tag; the name prefix of what this builds.' },
    { id: 'component', label: 'Component', control: 'text', default: '', hint: 'The app component this builds (the atk_component tag Ansible groups by); blank for the whole app.' },
    { id: 'criticality', label: 'Criticality', control: 'select', default: 'tier2', options: CRITICALITY_OPTIONS },
    { id: 'owner', label: 'Owner', control: 'text', default: '', hint: 'Written as the atk_owner tag.' },
    { id: 'cost_centre', label: 'Cost centre', control: 'text', default: '', hint: 'Written as the atk_cost_centre tag.' },
  ];
}

                          
                        
                                               
                        
                                             
                      
                             
                                      
                         
                              
 

export function appOf(values                 )          {
  const name = valueOf(values, 'app', 'app');
  const crit = valueOf(values, 'criticality', 'tier2');
  return {
    name,
    slug: rname(name).slice(0, 24).replace(/-+$/, '') || 'app',
    id: ident(name) || 'app',
    component: valueOf(values, 'component'),
    criticality: (CRITICALITIES                     ).includes(crit) ? (crit                 ) : 'tier2',
    owner: valueOf(values, 'owner'),
    costCentre: valueOf(values, 'cost_centre'),
  };
}

/**
 * The app's tags, as the cloud writes them: `tags` on AWS and Azure,
 * `labels` on Google (lowercase letters, digits, `-` and `_`),
 * `freeform_tags` on OCI. Empty values are left out, except atk_app.
 */
export function appTagMap(app         , platform                 , extra                                   = {})                         {
  const raw                         = {
    atk_app: app.name,
    atk_component: app.component,
    atk_criticality: app.criticality,
    atk_owner: app.owner,
    atk_cost_centre: app.costCentre,
    ...extra,
  };
  const out                         = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === '' && k !== 'atk_app') continue;
    out[k] = platform === 'google' ? gcpLabel(v) : v;
  }
  return out;
}

/** The tag map as an HCL expression, at `depth`. */
export const tagsExpr = (app         , platform                 , extra                                   = {}, depth = 1)         =>
  hcl(appTagMap(app, platform, extra), depth);

/** `${local.landing_zone.prefix}-<app>` (or var.), for resource names. */
export const namePrefix = (values                 , app         )         => `\${${lzRef(values)}.prefix}-${app.slug}`;

/** The terraform block and, standalone, the landing-zone variable and provider. */
export function preamble(cloud          , values                 )             {
  return [terraformBlock([cloud]), ...consumerPreamble(cloud, values)];
}

/** The `network` input: the landing-zone network the item sits in. */
export const NETWORK_INPUT                 = { id: 'network', label: 'Network', control: 'text', default: 'prod', hint: 'The landing-zone network it sits in.' };

export const TIER_OPTIONS                          = ['web', 'app', 'db', 'mgmt'].map((t) => ({ value: t, label: t }));

/** A subnet of the landing zone: `<lz>.subnet_ids["<network>/<tier>/<zone>"]`. */
export const subnetOf = (lz        , network        , tier        , zone = 'a')         => `${lz}.subnet_ids[${q(`${network}/${tier}/${zone}`)}]`;

/** Every distinct subnet id of a network's tier (one per zone on AWS; the regional one elsewhere). */
export const subnetsOf = (lz        , network        , tier        )         =>
  `distinct([for k, id in ${lz}.subnet_ids : id if startswith(k, ${q(`${network}/${tier}/`)})])`;

/** The security group (NSG, network tag) of a network's tier. */
export const securityGroupOf = (lz        , network        , tier        )         => `${lz}.security_group_ids[${q(`${network}/${tier}`)}]`;

/** Whether the network is dual-stack, as an HCL boolean expression. */
export const ipv6Of = (lz        , network        )         => `${lz}.ipv6[${q(network)}]`;

/** A blueprint's single main.tf, laid out the same way as the migration blueprints'. */
export const patternMainTf = (blocks                                , header        )         => mainTf(blocks, header);

/** A sensitive variable for a credential that has to be supplied (TF_VAR_<name>), never written. */
export const credential = (name        , description        )           => secretVariable(name, description);

export { attrs, lzRef, lzSource, variable, x };

/** A finding that says what the landing-zone contract did not give and the item assumed instead. */
export const assumed = (code        , message        , path         )          => info(code, message, path ? { path } : {});

// ---------------------------------------------------------------------------
// vSphere (VCF 9.1): the provider block every vSphere item writes the same way
// ---------------------------------------------------------------------------

export const VSPHERE_SERVER_INPUT                 = {
  id: 'vsphere_server',
  label: 'vCenter',
  control: 'text',
  default: 'wld01-vc01.example.com',
  hint: 'The workload domain\'s vCenter instance.',
};

/** The vSphere provider as `vsphere_mig_vms` writes it (the same text, so a stack keeps one), and its credentials as variables. */
export function vsphereProvider(values                 )             {
  return [
    terraformBlock(['vsphere']),
    {
      type: 'provider',
      labels: ['vsphere'],
      attributes: attrs({ vsphere_server: valueOf(values, 'vsphere_server', 'vcenter.example.com'), user: x('var.vsphere_user'), password: x('var.vsphere_password'), allow_unverified_ssl: false }),
    },
    variable('vsphere_user', 'string', 'The vCenter account Terraform signs in with (TF_VAR_vsphere_user).'),
    secretVariable('vsphere_password', 'The password of the vCenter account Terraform signs in with.'),
  ];
}

// ---------------------------------------------------------------------------
// Members: the servers behind an ingress, a transfer, a check
// ---------------------------------------------------------------------------

/** A space- or comma-separated list of words from an input. */
export const listOf = (values                 , id        , fallback = '')           =>
  valueOf(values, id, fallback)
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean);

/**
 * An Azure subnet of the landing zone's network delegated to a service (App
 * Service and Functions VNet integration, NetApp Files, Cassandra MI): a
 * service that needs a subnet of its own gets one carved from a range given
 * as an input.
 */
export function azureDelegatedSubnet(label        , lz        , network        , name        , cidr        , service        , actions                   )           {
  return {
    type: 'resource',
    labels: ['azurerm_subnet', label],
    attributes: attrs({
      name: x(name),
      resource_group_name: x(`${lz}.resource_group[${q(network)}]`),
      virtual_network_name: x(`${lz}.network_names[${q(network)}]`),
      address_prefixes: [cidr],
    }),
    blocks: [
      {
        type: 'delegation',
        attributes: attrs({ name: service.split('/').pop() ?? 'delegation' }),
        blocks: [{ type: 'service_delegation', attributes: attrs({ name: service, actions: [...actions] }), blocks: [] }],
      },
    ],
    comment: `A subnet of its own, delegated to ${service}.`,
  };
}

/** Is a text an IPv4 CIDR? */
export const isV4Cidr = (text        )          => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(text.trim());

/** Monitoring thresholds by criticality (data; the ops team tunes them). */
export const THRESHOLDS                                                                                                                                    = {
  tier0: { cpu: 75, memory: 80, disk: 80, http5xx: 1, p95ms: 500, periodMin: 1 },
  tier1: { cpu: 80, memory: 85, disk: 85, http5xx: 5, p95ms: 800, periodMin: 5 },
  tier2: { cpu: 85, memory: 90, disk: 85, http5xx: 10, p95ms: 1500, periodMin: 5 },
  tier3: { cpu: 90, memory: 95, disk: 90, http5xx: 25, p95ms: 3000, periodMin: 15 },
};
