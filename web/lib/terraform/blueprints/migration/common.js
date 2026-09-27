/**
 * What every "From a migration plan" blueprint shares.
 *
 * The migration blueprints are written to be stacked: a landing zone, then
 * identity, connectivity, compute, databases, backup and monitoring, each its
 * own item in one root module. Stacking puts them all in one namespace, so they
 * meet through two named locals rather than through inputs someone has to wire:
 *
 *   local.landing_zone   written by `<cloud>_mig_landing_zone`: the networks,
 *                        subnets, security groups, key and log destination
 *   local.mig_vms        written by `<cloud>_mig_compute`: every VM it builds
 *
 * Each consumer asks where its landing zone comes from (`landing_zone_source`):
 * `stack` reads `local.landing_zone`, `variables` declares `var.landing_zone`
 * with the same shape, so the blueprint also works on its own.
 *
 * The grids are the other contract. The planner writes each blueprint's grid as
 * plain " | " text in the blueprint's own input ids, which is also what the
 * Terraform page shows and edits, so the columns here are fixed: see section
 * 2.7.3 of the design. Nothing here imports src/multicloud — the kit stays
 * independent and the grid formats are the interface.
 *
 * House rules kept here, once: no credential is ever written into a file (a
 * sensitive variable with no default, or the cloud's own managed secret);
 * IPv6 alongside IPv4 wherever the cloud supports it; nothing identifies the
 * generator or the time it ran; and whatever is created is created enabled.
 */

import { error, info, warning,              } from '../../../core/findings.js';
import { familyOf } from '../../../core/ip.js';
                                                                                                          
import { str as valueOf } from '../../../kit/blueprint.js';
import {
  bool as hBool,
  num as hNum,
  raw,
  renderFile,
  str as hStr,
  strings as hStrings,
                    
                
                
} from '../../hcl.js';
import { providerFor,                  } from '../../providers.js';
import { topLevelBlocks } from '../../stack.js';

export const MIGRATION_GROUP = 'From a migration plan';

                                                          

export const TIERS = ['web', 'app', 'db', 'mgmt']         ;
                                          

/** Zone letters, in the order zones are used: the contract's subnet keys end in one. */
export const ZONE_LETTERS = ['a', 'b', 'c']         ;

export const YES_NO                          = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

export const opts = (values                   , group         )                 =>
  values.map((v) => (group ? { value: v, label: v, group } : { value: v, label: v }));

// ---------------------------------------------------------------------------
// HCL shorthands over hcl.ts
// ---------------------------------------------------------------------------

/** A value as written in a blueprint: a JS scalar or list, or an HCL value. */
                                                                                              

/** An expression, unquoted: `aws_vpc.prod.id`, `var.x`, `each.value.size`. */
export const x = raw;

function toValue(v                                )           {
  if (typeof v === 'string') return hStr(v);
  if (typeof v === 'number') return hNum(v);
  if (typeof v === 'boolean') return hBool(v);
  if (Array.isArray(v)) return hStrings(v                     );
  return v            ;
}

/** Attributes in insertion order; `undefined` and `null` are left out. */
export function attrs(o                               )                 {
  const out                 = [];
  for (const [name, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    out.push({ name, value: toValue(v) });
  }
  return out;
}

/** A nested block. */
export function blk(type        , o                                = {}, blocks                      = [], labels                    )           {
  return { type, ...(labels ? { labels } : {}), attributes: attrs(o), blocks };
}

export function res(type        , name        , o                               , blocks                      = [], comment         )           {
  return { type: 'resource', labels: [type, name], attributes: attrs(o), blocks, ...(comment ? { comment } : {}) };
}

export function dat(type        , name        , o                               , blocks                      = [], comment         )           {
  return { type: 'data', labels: [type, name], attributes: attrs(o), blocks, ...(comment ? { comment } : {}) };
}

export function output(name        , value        , description         , sensitive = false)           {
  return {
    type: 'output',
    labels: [name],
    attributes: attrs({ value: x(value), description, sensitive: sensitive ? true : undefined }),
  };
}

/** `lifecycle { ignore_changes = [...] }`. */
export function ignoreChanges(names                   )           {
  return blk('lifecycle', { ignore_changes: x(`[${names.join(', ')}]`) });
}

/** An HCL string literal for use inside a raw expression. */
export const q = (s        )         =>
  JSON.stringify(s)
    // Functions, not '$${': a replacement string reads `$$` as one `$`.
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{');

/**
 * An object literal whose values are expressions, one key per line.
 * `depth` is the indent of the attribute it is assigned to (1 = a resource's own).
 */
export function hobj(entries                                  , depth = 1)         {
  const keys = Object.keys(entries);
  if (keys.length === 0) return '{}';
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  const key = (k        ) => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : q(k));
  return `{\n${keys.map((k) => `${pad}${key(k)} = ${entries[k]}`).join('\n')}\n${close}}`;
}

/** An object literal of string values. */
export function hstrmap(entries                                  , depth = 1)         {
  return hobj(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, q(v)])), depth);
}

/** A list of expressions. */
export const hlist = (items                   )         => `[${items.join(', ')}]`;

/** A Terraform identifier from anything. */
export function ident(...parts                   )         {
  const s = parts
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  return /^[a-z_]/.test(s) ? s : `n_${s}`;
}

/** A cloud resource name: lowercase, hyphenated. */
export function rname(...parts                   )         {
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// ---------------------------------------------------------------------------
// Variables, the terraform block, providers
// ---------------------------------------------------------------------------

export function variable(name        , type        , description        , o                                                                = {})           {
  return {
    type: 'variable',
    labels: [name],
    attributes: [
      { name: 'type', value: raw(type) },
      { name: 'description', value: hStr(description) },
      ...(o.default !== undefined ? [{ name: 'default', value: raw(o.default) }] : []),
      ...(o.sensitive ? [{ name: 'sensitive', value: hBool(true) }] : []),
      ...(o.nullable === false ? [{ name: 'nullable', value: hBool(false) }] : []),
    ],
  };
}

/** A credential: sensitive, no default, supplied as TF_VAR_<name> and never written. */
export function secretVariable(name        , description        )           {
  return variable(name, 'string', `${description} Sensitive: set TF_VAR_${name} in the environment; it is never written to a file.`, { sensitive: true });
}

/** The provider names a cloud's blueprints need. */
const LOCAL_NAME                              = { aws: 'aws', azure: 'azurerm', google: 'google', oci: 'oci', vsphere: 'vsphere', vcf: 'vcf' };

/**
 * The `terraform` block, with each provider pinned to the catalog's version.
 * `>= 1.7.0` because the compute blueprints adopt replicated VMs with a
 * `for_each` on an `import` block; a stack writes its own required_version.
 */
export function terraformBlock(targets                        )           {
  const entries = [...new Set(targets)].map((t) => {
    const p = providerFor(t);
    return { name: LOCAL_NAME[t], value: raw(`{\n      source  = ${q(p.source)}\n      version = ${q(p.version)}\n    }`) };
  });
  return {
    type: 'terraform',
    attributes: [{ name: 'required_version', value: hStr('>= 1.7.0') }],
    blocks: [{ type: 'required_providers', attributes: entries }],
  };
}

// ---------------------------------------------------------------------------
// The landing-zone contract
// ---------------------------------------------------------------------------

                                                      

export const LANDING_ZONE_SOURCE                 = {
  id: 'landing_zone_source',
  label: 'Landing zone',
  // A dropdown of the two answers. Not a closed `select`: the kit's
  // every-option checks build each select answer as a root module on its own,
  // and `stack` is by definition not one (it reads the landing zone's local).
  control: 'combo',
  default: 'variables',
  options: [
    { value: 'stack', label: 'From the landing zone in this stack' },
    { value: 'variables', label: 'Declare variables (standalone use)' },
  ],
  hint: 'In a stack with a landing zone, read local.landing_zone; on its own, declare var.landing_zone.',
};

export const lzSource = (values                 )                    =>
  valueOf(values, 'landing_zone_source', 'variables') === 'stack' ? 'stack' : 'variables';

/** `local.landing_zone` or `var.landing_zone`, to read the contract through. */
export const lzRef = (values                 )         => (lzSource(values) === 'stack' ? 'local.landing_zone' : 'var.landing_zone');

/** The keys every landing zone writes, with their types. */
const LZ_COMMON                                         = [
  ['prefix', 'string'],
  ['region', 'string'],
  ['network_ids', 'map(string)'],
  ['subnet_ids', 'map(string)'],
  ['security_group_ids', 'map(string)'],
  ['kms_key_id', 'string'],
  ['log_destination', 'string'],
  ['resource_group', 'map(string)'],
  ['zones', 'list(string)'],
  ['mgmt_cidrs', 'list(string)'],
  ['ipv6', 'map(bool)'],
];

/**
 * What each cloud adds to the contract. These are what its consumers need and
 * cannot find any other way: the instance profile on AWS, the location and
 * identity on Azure, the project and service account on Google, the
 * compartment and DRG on OCI.
 */
export const LZ_EXTRAS                                                                     = {
  aws: [
    ['instance_profile', 'string'],
    ['route_table_ids', 'map(string)'],
    ['zone_subnet_ids', 'map(list(string))'],
    ['network_cidrs', 'map(list(string))'],
  ],
  azure: [
    ['location', 'string'],
    ['subscription_id', 'string'],
    ['network_names', 'map(string)'],
    ['identity_id', 'string'],
  ],
  google: [
    ['project', 'string'],
    ['network_names', 'map(string)'],
    ['service_account', 'string'],
  ],
  oci: [
    ['compartment_id', 'string'],
    ['drg_id', 'string'],
    ['vault_id', 'string'],
  ],
};

export const landingZoneKeys = (cloud          )           => [...LZ_COMMON, ...LZ_EXTRAS[cloud]].map(([k]) => k);

/** `variable "landing_zone"`: the contract's shape, for a blueprint used on its own. */
export function landingZoneVariable(cloud          )           {
  const fields = [...LZ_COMMON, ...LZ_EXTRAS[cloud]].map(([k, t]) => `    ${k} = ${t}`).join('\n');
  return variable(
    'landing_zone',
    `object({\n${fields}\n  })`,
    'The landing zone this builds in: the output of the landing zone blueprint (its landing_zone output), or the same shape by hand.',
  );
}

/** `locals { landing_zone = {...} }`: written once per stack, by the landing zone. */
export function landingZoneLocal(cloud          , entries                                  )           {
  const missing = landingZoneKeys(cloud).filter((k) => entries[k] === undefined);
  if (missing.length > 0) throw new Error(`landing_zone local is missing ${missing.join(', ')}`);
  const ordered = Object.fromEntries(landingZoneKeys(cloud).map((k) => [k, entries[k]          ]));
  return {
    type: 'locals',
    comment: 'The landing-zone contract: every other migration blueprint in this stack reads\nlocal.landing_zone, so there is one of it per stack.',
    attributes: [{ name: 'landing_zone', value: raw(hobj(ordered, 1)) }],
  };
}

/**
 * What a consumer blueprint writes around its own resources: the landing-zone
 * variable when it stands alone, and the provider block (in a stack, the
 * landing zone's provider block is the one).
 */
export function consumerPreamble(cloud          , values                 )             {
  if (lzSource(values) === 'stack') return [];
  return [landingZoneVariable(cloud), consumerProvider(cloud)];
}

/** The provider block a consumer writes on its own, configured from var.landing_zone. */
export function consumerProvider(cloud          )           {
  switch (cloud) {
    case 'aws':
      return { type: 'provider', labels: ['aws'], attributes: attrs({ region: x('var.landing_zone.region') }) };
    case 'azure':
      return { type: 'provider', labels: ['azurerm'], attributes: attrs({ subscription_id: x('var.landing_zone.subscription_id') }), blocks: [blk('features')] };
    case 'google':
      return { type: 'provider', labels: ['google'], attributes: attrs({ project: x('var.landing_zone.project'), region: x('var.landing_zone.region') }) };
    case 'oci':
      return { type: 'provider', labels: ['oci'], attributes: attrs({ region: x('var.landing_zone.region') }) };
    default:
      throw new Error(`no provider for ${String(cloud)}`);
  }
}

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

                             
                        
                                             
                                                        
 

/**
 * A grid input: a textarea of " | " rows whose hint names the columns, with
 * each column's dropdown given as options grouped under the column's name.
 * The Terraform page draws it as a table (src/ui/multi-editors.ts tableShape).
 */
export function gridInput(
  id        ,
  label        ,
  columns                       ,
  rows                                ,
  help         ,
)                 {
  // A value is offered once per input (the page keys options by value), so a
  // value two columns share - yes/no - is offered in the first of them only;
  // the other column still takes it typed.
  const options                 = [];
  const seen = new Set        ();
  for (const c of columns) {
    for (const o of c.options ?? []) {
      const option = typeof o === 'string' ? { value: o, label: o, group: c.name } : { ...o, group: c.name };
      if (seen.has(option.value)) continue;
      seen.add(option.value);
      options.push(option);
    }
  }
  return {
    id,
    label,
    control: 'textarea',
    hint: columns.map((c) => c.name).join(' | '),
    default: rows.map((r) => r.join(' | ')).join('\n'),
    options,
    ...(help ? { help } : {}),
  };
}

/** One grid row, keyed by column name; every column present, trimmed. */
                                                       

/**
 * The rows of a grid. Cells split on a pipe with space either side (or at an
 * edge), as the page writes them; blank lines and `#` comments are skipped.
 */
export function parseGrid(text        , columns                   )            {
  const rows            = [];
  for (const raw0 of String(text ?? '').split(/\r?\n/)) {
    const line = raw0.trim();
    if (line === '' || line.startsWith('#')) continue;
    const cells = ` ${line} `.split(/(?<=\s)\|(?=\s)/).map((c) => c.trim());
    const row                         = {};
    columns.forEach((c, i) => {
      row[c] = cells[i] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

/** Space- or comma-separated words. */
export const words = (text        )           =>
  String(text ?? '')
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean);

export const yes = (text                    )          => /^(y|yes|true|1)$/i.test(String(text ?? '').trim());

/** A positive whole number from a cell, or the fallback. */
export function cellNumber(text                    , fallback        )         {
  const n = Number(String(text ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Report grid rows whose names repeat: a map key has to be unique. */
export function uniqueNames(rows                    , column        , input        , findings           )            {
  const seen = new Set        ();
  const out            = [];
  for (const r of rows) {
    const name = r[column] ?? '';
    if (name === '') {
      findings.push(warning('tf.mig.unnamed-row', `A row of ${input} has no ${column}, so it was left out.`, { path: input }));
      continue;
    }
    if (seen.has(name)) {
      findings.push(warning('tf.mig.duplicate-row', `${name} appears twice in ${input}; the second was left out.`, { path: input }));
      continue;
    }
    seen.add(name);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Networks and subnets: the landing zone's two grids, built exactly as given
// ---------------------------------------------------------------------------

/**
 * The networks grid: one row per network the user built. Nothing is carved
 * from it: the subnets are the subnets grid's rows. `Existing ID` marks a
 * network that exists already (a hub), which new networks attach to and
 * which is never built.
 */
export const NETWORK_COLUMNS                        = [
  { name: 'Network' },
  { name: 'Environments' },
  { name: 'IPv4 CIDR' },
  { name: 'IPv6', options: ['yes', 'no'] },
  { name: 'Role', options: ['hub', 'spoke', 'shared-services', 'inspection', 'egress'] },
  { name: 'Existing ID' },
];

/** No network by default: the landing zone builds only what the user gives. */
export const DEFAULT_NETWORKS                                 = [];

/**
 * The subnets grid: one row per subnet, exactly as built. Purpose is a tier
 * (web, app, db, mgmt, container) or one of the cloud's platform subnets
 * (GatewaySubnet, tgw-attachment, proxy-only, public …). Zone is the zone
 * name on AWS (or an OCI availability domain), `regional` elsewhere.
 */
export const SUBNET_COLUMNS                        = [
  { name: 'Network' },
  { name: 'Subnet' },
  { name: 'Purpose' },
  { name: 'Zone' },
  { name: 'IPv4 CIDR' },
  { name: 'IPv6', options: ['yes', 'no'] },
];

export const DEFAULT_SUBNETS                                 = [];

                              
                        
                      
                                   
                        
                         
                                                                                                          
                             
                        
                                                                        
                               
                                                                               
                                  
                                                                 
                         
 

const v4ToInt = (a        )         => a.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const intToV4 = (n        )         => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

const v4Range = (cidr        )                          => {
  const [base = '', p = ''] = cidr.split('/');
  if (familyOf(base) !== 4 || !/^\d+$/.test(p)) return null;
  const size = 2 ** (32 - Number(p));
  const start = v4ToInt(base) - (v4ToInt(base) % size);
  return [start, start + size];
};
function cidrOverlap(a        , b        )          {
  const x = v4Range(a);
  const y = v4Range(b);
  return !!x && !!y && x[0] < y[1] && y[0] < x[1];
}
function cidrInside(inner        , outer        )          {
  const x = v4Range(inner);
  const y = v4Range(outer);
  return !!x && !!y && x[0] >= y[0] && x[1] <= y[1];
}

export function parseNetworks(text        , findings           )                {
  const rows = uniqueNames(parseGrid(text, NETWORK_COLUMNS.map((c) => c.name)), 'Network', 'networks', findings);
  const out                = [];
  for (const r of rows) {
    const name = rname(r['Network'] ?? '');
    const cidr = r['IPv4 CIDR'] ?? '';
    if (familyOf(cidr) !== 4 || !cidr.includes('/')) {
      findings.push(error('tf.mig.network-cidr', `Network ${name}: "${cidr}" is not an IPv4 CIDR.`, { path: 'networks' }));
      continue;
    }
    const v6cell = r['IPv6'] ?? '';
    const v6cidr = familyOf(v6cell) === 6 && v6cell.includes('/') ? v6cell : undefined;
    const existingId = (r['Existing ID'] ?? '').trim();
    out.push({
      name,
      id: ident(name),
      envs: words(r['Environments'] ?? ''),
      cidr,
      ipv6: v6cidr !== undefined || yes(v6cell),
      ...(v6cidr ? { ipv6Cidr: v6cidr } : {}),
      role: (r['Role'] ?? '').trim() || 'spoke',
      ...(existingId ? { existingId } : {}),
      tiers: [],
      zones: 1,
    });
  }
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (cidrOverlap(out[i] .cidr, out[j] .cidr)) {
        findings.push(error('tf.mig.network-overlap', `Networks ${out[i] .name} (${out[i] .cidr}) and ${out[j] .name} (${out[j] .cidr}) overlap.`, { path: 'networks' }));
      }
    }
  }
  if (out.filter((n) => !n.existingId).length === 0 && !findings.some((f) => f.severity === 'error')) {
    findings.push(error('tf.mig.no-networks', 'The networks grid has no network to build: add the networks and their subnets (nothing is built by default).', { path: 'networks' }));
  }
  return out;
}

/**
 * `count` subnets of `/prefix`, carved in order from the start of `cidr`, then
 * (when asked) extra blocks of other sizes after them, each aligned to its size.
 * Returns null when they do not fit. (Used for the ODB and OCVS ranges the
 * user gives; never for the landing zone's subnets.)
 */
export function carve(cidr        , sizes                   )                  {
  const [base = '', p = '0'] = cidr.split('/');
  const prefix = Number(p);
  const start = v4ToInt(base) - (v4ToInt(base) % 2 ** (32 - prefix));
  const end = start + 2 ** (32 - prefix);
  let at = start;
  const out           = [];
  for (const size of sizes) {
    if (size < prefix || size > 30) return null;
    const block = 2 ** (32 - size);
    if (at % block !== 0) at += block - (at % block);
    if (at + block > end) return null;
    out.push(`${intToV4(at)}/${size}`);
    at += block;
  }
  return out;
}

/**
 * A stable ULA /48 for an Azure network that asked for IPv6 without giving a
 * range: fd + 40 bits of a hash of the prefix and network, so the same plan
 * always gets the same range (RFC 4193 wants them random-looking, not random).
 */
export function ulaFor(seed        )         {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of seed) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch.charCodeAt(0), 0x5bd1e995) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 10);
  return `fd${hex.slice(0, 2)}:${hex.slice(2, 6)}:${hex.slice(6, 10)}::/48`;
}

                             
                                
                                                                                  
                               
                                                                                                         
                         
                                                                                       
                           
                        
                           
                         
                                                                                             
                         
                                                        
                         
 

/**
 * The subnets grid, against the networks: every row exactly as given, and
 * nothing more. A row is an error when its network is unknown or exists
 * already, its CIDR is not IPv4, lies outside its network or overlaps
 * another row; on a zonal cloud (AWS) it needs its zone, on a regional one
 * (Azure, Google) it must not have one (OCI takes an availability domain).
 * Each network's `tiers` and `zones` are set from its subnets (the array is
 * updated in place).
 */
export function parseSubnets(text        , networks               , zonal         , findings           , cloud           )               {
  const rows = parseGrid(text, SUBNET_COLUMNS.map((c) => c.name));
  const out               = [];
  for (const r of rows) {
    const net = networks.find((n) => n.name === rname(r['Network'] ?? ''));
    const short = (r['Subnet'] ?? '').trim();
    const tier = (r['Purpose'] ?? '').trim();
    const cidr = (r['IPv4 CIDR'] ?? '').trim();
    const zoneCell = (r['Zone'] ?? '').trim();
    const zone = zoneCell === '' || zoneCell === 'regional' ? undefined : zoneCell;
    const where = `Subnet ${short || '(no name)'}`;
    if (!net) {
      findings.push(error('tf.mig.subnet-network', `${where}: there is no network called ${r['Network'] ?? ''}.`, { path: 'subnets' }));
      continue;
    }
    if (net.existingId) {
      findings.push(error('tf.mig.subnet-existing-network', `${where}: ${net.name} exists already (${net.existingId}); its subnets are not built here.`, { path: 'subnets' }));
      continue;
    }
    if (!short || !tier) {
      findings.push(error('tf.mig.subnet-row', `${where} in ${net.name}: a subnet needs its name and purpose.`, { path: 'subnets' }));
      continue;
    }
    if (familyOf(cidr) !== 4 || !cidr.includes('/')) {
      findings.push(error('tf.mig.subnet-cidr', `${where} in ${net.name}: "${cidr}" is not an IPv4 CIDR.`, { path: 'subnets' }));
      continue;
    }
    if (!cidrInside(cidr, net.cidr)) {
      findings.push(error('tf.mig.subnet-outside', `${where}: ${cidr} is outside its network ${net.name} (${net.cidr}).`, { path: 'subnets' }));
      continue;
    }
    const clash = out.find((o) => o.network.name === net.name && cidrOverlap(o.cidr, cidr));
    if (clash) {
      findings.push(error('tf.mig.subnet-overlap', `${where}: ${cidr} overlaps ${clash.short} (${clash.cidr}) in ${net.name}.`, { path: 'subnets' }));
      continue;
    }
    if (out.some((o) => o.network.name === net.name && o.short === short)) {
      findings.push(error('tf.mig.subnet-duplicate', `${where}: ${net.name} already has a subnet called ${short}.`, { path: 'subnets' }));
      continue;
    }
    if (zonal && !zone) {
      findings.push(error('tf.mig.subnet-zonal', `${where} in ${net.name}: AWS subnets are zonal; give its Availability Zone.`, { path: 'subnets' }));
      continue;
    }
    if (!zonal && zone && cloud !== 'oci') {
      findings.push(error('tf.mig.subnet-regional', `${where} in ${net.name}: subnets here are regional; "${zone}" cannot be a subnet's zone.`, { path: 'subnets' }));
      continue;
    }
    const v6 = yes(r['IPv6'] ?? '');
    if (v6 && !net.ipv6) {
      findings.push(error('tf.mig.subnet-ipv6', `${where}: IPv6 is on, but ${net.name} is IPv4 only.`, { path: 'subnets' }));
      continue;
    }
    const letter = zone ? (zonal ? zone.slice(-1).toLowerCase() : undefined) : undefined;
    out.push({ network: net, tier, ...(zone ? { zone } : {}), ...(letter ? { letter } : {}), cidr, ipv6: v6, short, label: ident(net.id, short) });
  }
  // Each network's tiers and zone count, from its subnets.
  for (let i = 0; i < networks.length; i++) {
    const n = networks[i] ;
    const mine = out.filter((s) => s.network.name === n.name);
    const tiers = TIERS.filter((t) => mine.some((s) => s.tier === t));
    const zones = new Set(mine.map((s) => s.zone).filter(Boolean)).size || 1;
    const next              = { ...n, tiers, zones };
    networks[i] = next;
    for (let j = 0; j < out.length; j++) if (out[j] .network.name === n.name) out[j] = { ...out[j] , network: next };
  }
  return out;
}

/**
 * The contract's subnet keys for one subnet: `<network>/<purpose>/<zone
 * letter>` (a regional subnet is keyed for every zone letter), then
 * `<network>/<purpose>` and `<network>/<name>`; the first subnet wins a key.
 */
export function subnetKeys(s            )           {
  const n = s.network.name;
  const keys = s.letter ? [`${n}/${s.tier}/${s.letter}`] : ZONE_LETTERS.map((z) => `${n}/${s.tier}/${z}`);
  return [...keys, `${n}/${s.tier}`, `${n}/${s.short}`];
}

/** Key → subnet for a landing zone's subnets (the first subnet wins each key). */
export function subnetKeyMap(subnets                       )                          {
  const out = new Map                    ();
  for (const s of subnets) for (const k of subnetKeys(s)) if (!out.has(k)) out.set(k, s);
  return out;
}

/** One subnet per zone of a network, the first of each zone in the order given (or all regional ones): what endpoints and attachments sit in. */
export function onePerZone(subnets                       , prefer         )               {
  const preferred = prefer ? subnets.filter((s) => s.tier === prefer) : [];
  const pool = preferred.length > 0 ? preferred : subnets.filter((s) => (TIERS                     ).includes(s.tier));
  const list = pool.length > 0 ? pool : subnets;
  const seen = new Set        ();
  const out               = [];
  for (const s of list) {
    const z = s.zone ?? '';
    if (seen.has(z)) continue;
    seen.add(z);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reworking what emitFoundation writes
// ---------------------------------------------------------------------------

                                   
                                                                      
                                                                       
                                                       
                                                                        
 

const escapeRe = (v        ) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One network's foundation, renamed so several sit in one module: `this`
 * becomes the network's id and every other label gains it as a prefix
 * (`aws_subnet.web_a` → `aws_subnet.prod_web_a`). Declarations and references
 * move together. Outputs and variables are dropped: the landing zone writes
 * its own, and the contract local, instead. The emitters are not changed.
 */
export function reworkFoundation(mainTf        , networkId        , rework                   = {})         {
  const blocks = topLevelBlocks(mainTf).filter((b) => b.kind === 'resource' || b.kind === 'data');
  const renames = new Map                ();
  for (const b of blocks) {
    const [type = '', label = ''] = b.labels;
    renames.set(`${b.kind}:${type}:${label}`, label === 'this' ? networkId : `${networkId}_${label}`);
  }
  const kept = blocks.filter((b) => !(rework.drop?.(b.kind, b.labels) ?? false));
  const out           = [];
  for (const b of kept) {
    // Only the block itself, without the file header carried in front of the first.
    const at = b.text.search(new RegExp(`^${b.kind}\\b`, 'm'));
    const comment = b.text.slice(0, at).split('\n').filter((l) => /^\s*#/.test(l) && !/network foundation for/.test(l)).join('\n');
    let text = (comment ? `${comment}\n` : '') + b.text.slice(at);
    for (const [key, to] of renames) {
      const [kind, type, from] = key.split(':')                            ;
      const head = kind === 'data' ? 'data' : 'resource';
      text = text.replace(new RegExp(`${head}\\s+"${escapeRe(type)}"\\s+"${escapeRe(from)}"`, 'g'), `${head} "${type}" "${to}"`);
      const prefix = kind === 'data' ? `data\\.${escapeRe(type)}` : `(?<![\\w.])${escapeRe(type)}`;
      text = text.replace(new RegExp(`${prefix}\\.${escapeRe(from)}\\b`, 'g'), `${kind === 'data' ? `data.${type}` : type}.${to}`);
    }
    const [type = '', label = ''] = b.labels;
    if (rework.edit) text = rework.edit(type, renames.get(`${b.kind}:${type}:${label}`) ?? label, text);
    out.push(text.trim());
  }
  return out.join('\n\n');
}

/** Insert lines just before the closing brace of a block's text. */
export function insertBeforeClose(text        , lines        )         {
  const end = text.lastIndexOf('}');
  return `${text.slice(0, end).replace(/\s*$/, '\n')}${lines}\n}`;
}

// ---------------------------------------------------------------------------
// Operating systems and images
// ---------------------------------------------------------------------------

/**
 * The operating systems a migration plan names, in the planner's spelling.
 * A copy of the planner's OsId union rather than an import of it, so the kit
 * does not depend on src/multicloud; the grid text is the contract.
 */
export const OS_IDS                    = [
  'win-2008r2', 'win-2012', 'win-2012r2', 'win-2016', 'win-2019', 'win-2022', 'win-2025',
  'rhel-6', 'rhel-7', 'rhel-8', 'rhel-9', 'rhel-10',
  'centos-6', 'centos-7', 'centos-8', 'centos-stream-9', 'centos-stream-10',
  'rocky-8', 'rocky-9', 'rocky-10', 'alma-8', 'alma-9', 'alma-10',
  'ol-6', 'ol-7', 'ol-8', 'ol-9', 'ol-10',
  'sles-11', 'sles-12', 'sles-15', 'sles-16',
  'ubuntu-16.04', 'ubuntu-18.04', 'ubuntu-20.04', 'ubuntu-22.04', 'ubuntu-24.04',
  'debian-9', 'debian-10', 'debian-11', 'debian-12', 'debian-13',
  'linux-other', 'windows-client', 'other', 'unknown',
];

export const OS_OPTIONS                          = OS_IDS.map((id) => ({
  value: id,
  label: id,
  group: 'OS',
}));

                                         
export const osKind = (os        )         => (/^win/i.test(os.trim()) ? 'windows' : 'linux');

/** The package-manager family, written as the atk_os_family tag Ansible groups on. */
export function osFamily(os        )                                                   {
  const id = os.trim().toLowerCase();
  if (id.startsWith('win')) return 'windows';
  if (/^(rhel|centos|rocky|alma|ol)-/.test(id)) return 'rhel';
  if (id.startsWith('sles')) return 'suse';
  if (/^(ubuntu|debian)-/.test(id)) return 'debian';
  return 'other';
}

/**
 * Where a VM's image comes from, as the grid writes it:
 *
 *   ssm:/aws/service/…          an AWS public SSM parameter
 *   ami:<owner>:<name pattern>  the newest AMI matching, from that owner
 *   mkt:<pub>:<offer>:<sku>     an Azure Marketplace image
 *   family:<project>/<family>   the newest Google image in a family
 *   oci:<os>:<version>          the newest OCI platform image
 *   template:<name>             a vSphere template
 *   var:<name>                  an image id you supply, as a variable
 *   replicated                  none: the replication tool brings the disks
 */
                      
                                                            
                                                                                             
                                                                                                                    
                                                                                      
                                                                                                 
                                                                    
                                                          
                                    

export function parseImageRef(key        )                  {
  const k = String(key ?? '').trim();
  if (k === '') return null;
  if (/^replicated$/i.test(k)) return { kind: 'replicated' };
  const colon = k.indexOf(':');
  if (colon === -1) return null;
  const scheme = k.slice(0, colon).toLowerCase();
  const rest = k.slice(colon + 1);
  const parts = rest.split(':');
  switch (scheme) {
    case 'ssm':
      return rest.startsWith('/') ? { kind: 'aws-ssm', parameter: rest } : null;
    case 'ami':
      return parts.length >= 2 && parts[0] ? { kind: 'aws-ami-filter', owner: parts[0], namePattern: parts.slice(1).join(':') } : null;
    case 'mkt':
      return parts.length === 3 && parts.every(Boolean) ? { kind: 'azure-marketplace', publisher: parts[0] , offer: parts[1] , sku: parts[2]  } : null;
    case 'family': {
      const slash = rest.indexOf('/');
      return slash > 0 ? { kind: 'gcp-family', project: rest.slice(0, slash), family: rest.slice(slash + 1) } : null;
    }
    case 'oci':
      return parts.length >= 2 && parts[0] ? { kind: 'oci-platform', operatingSystem: parts[0], version: parts.slice(1).join(':') } : null;
    case 'template':
      return rest ? { kind: 'vsphere-template', template: rest } : null;
    case 'var':
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(rest) ? { kind: 'custom', variable: rest } : null;
    default:
      return null;
  }
}

export function renderImageRef(ref          )         {
  switch (ref.kind) {
    case 'aws-ssm':
      return `ssm:${ref.parameter}`;
    case 'aws-ami-filter':
      return `ami:${ref.owner}:${ref.namePattern}`;
    case 'azure-marketplace':
      return `mkt:${ref.publisher}:${ref.offer}:${ref.sku}`;
    case 'gcp-family':
      return `family:${ref.project}/${ref.family}`;
    case 'oci-platform':
      return `oci:${ref.operatingSystem}:${ref.version}`;
    case 'vsphere-template':
      return `template:${ref.template}`;
    case 'custom':
      return `var:${ref.variable}`;
    case 'replicated':
      return 'replicated';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// The compute grid
// ---------------------------------------------------------------------------

export const LICENCES = ['li', 'ahb', 'dedicated-host', 'byol-image', 'rhel-byos', 'sles-byos']         ;
export const BACKUP_TIERS = ['gold', 'silver', 'bronze']         ;
export const METHODS = ['rebuild', 'replicate']         ;

export const VM_COLUMN_NAMES = ['Name', 'OS', 'Image', 'Size', 'Cores', 'Disks', 'Network', 'Tier', 'Zone', 'Licence', 'Backup', 'Method', 'App', 'Role', 'Env', 'Wave', 'Component']         ;

/**
 * The plan id every VM of a stack is tagged with (atk_plan), so a dynamic
 * inventory finds this plan's VMs and no one else's. Lower case letters,
 * digits and `-`, which every cloud accepts as a tag or label value.
 */
export const PLAN_ID_INPUT                 = {
  id: 'plan_id',
  label: 'Plan id (atk_plan tag)',
  control: 'text',
  default: '',
  hint: 'Written as the atk_plan tag on every VM, for the Ansible dynamic inventory; the migration plan fills it in.',
};

/** A plan id as the atk_plan tag carries it: lower case a-z, 0-9 and `-`, 63 at most. */
export const planTagValue = (id        )         => id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

export function vmColumns(sizes                                    , diskTypes                   )               {
  return [
    { name: 'Name' },
    { name: 'OS', options: OS_IDS },
    { name: 'Image' },
    { name: 'Size', options: sizes },
    { name: 'Cores' },
    { name: 'Disks', options: diskTypes.map((t) => `${t}:100`) },
    { name: 'Network' },
    { name: 'Tier', options: [...TIERS] },
    { name: 'Zone', options: [...ZONE_LETTERS] },
    { name: 'Licence', options: [...LICENCES] },
    { name: 'Backup', options: [...BACKUP_TIERS] },
    { name: 'Method', options: [...METHODS] },
    { name: 'App' },
    { name: 'Role' },
    { name: 'Env' },
    { name: 'Wave' },
    { name: 'Component' },
  ];
}

                         
                        
                       
 

                         
                        
                       
                      
                        
                          
                                  
                            
                        
                          
                        
                                   
                           
                        
                            
                        
                             
                           
                          
                                           
                       
                        
                       
                        
                                                                             
                             
                                                                                         
                        
                                                                   
                      
 

/**
 * The database engine a compute row's Role names, as the atk_db tag carries
 * it: oracle, sqlserver, postgres, mysql, mariadb, db2, mongodb, sybase-ase,
 * informix, sap-hana, redis, cassandra, elasticsearch; `db` for a database
 * host of no named engine; empty for anything else. The engines whose name
 * contains another's are tested first (mysql and postgresql both contain
 * "sql"; mariadb is not mysql).
 */
export function dbTagOf(role        )         {
  const r = role.trim().toLowerCase();
  if (r === '') return '';
  if (/oracle/.test(r)) return 'oracle';
  if (/maria/.test(r)) return 'mariadb';
  if (/mysql/.test(r)) return 'mysql';
  if (/postgres|pgsql|^pg(\d|$|[ _-])/.test(r)) return 'postgres';
  if (/mssql|sql[ _-]?server|^sql(\d|$|[ _-])/.test(r)) return 'sqlserver';
  if (/db2/.test(r)) return 'db2';
  if (/mongo/.test(r)) return 'mongodb';
  if (/sybase|^ase$/.test(r)) return 'sybase-ase';
  if (/informix/.test(r)) return 'informix';
  if (/hana/.test(r)) return 'sap-hana';
  if (/redis/.test(r)) return 'redis';
  if (/cassandra/.test(r)) return 'cassandra';
  if (/elastic/.test(r)) return 'elasticsearch';
  return r === 'db' ? 'db' : '';
}

/** "gp3:100 gp3:200" → disks; the first is the boot disk. */
export function parseDisks(text        , fallbackType        )           {
  return words(text).map((w) => {
    const [a = '', b = ''] = w.split(':');
    if (b === '') return { type: fallbackType, gib: cellNumber(a, 64) };
    return { type: a || fallbackType, gib: cellNumber(b, 64) };
  });
}

const zoneIndex = (z        )         => {
  const t = z.trim().toLowerCase();
  const letter = ZONE_LETTERS.indexOf(t                                 );
  if (letter >= 0) return letter;
  const n = Number(t.replace(/^.*?(\d)$/, '$1'));
  return Number.isFinite(n) && n >= 1 && n <= 3 ? n - 1 : 0;
};

export function parseVms(text        , fallbackDisk        , findings           , planId = '')           {
  const plan = planTagValue(planId);
  const rows = uniqueNames(parseGrid(text, VM_COLUMN_NAMES), 'Name', 'vms', findings);
  return rows.map((r) => {
    const os = r['OS'] || 'unknown';
    const disks = parseDisks(r['Disks'] ?? '', fallbackDisk);
    const method = /^replicat/i.test(r['Method'] ?? '') ? 'replicate' : 'rebuild';
    const imageKey = r['Image'] ?? '';
    const image = parseImageRef(imageKey);
    if (method === 'rebuild' && (!image || image.kind === 'replicated')) {
      findings.push(
        warning('tf.mig.vm-no-image', `${r['Name']}: rebuild needs an image, and "${imageKey}" is not one this reads; it is built from var.image_${ident(r['Name'] ?? 'vm')}.`, {
          path: 'vms',
          remediation: 'Give an image key: ssm:, ami:, mkt:, family:, oci: or var:.',
        }),
      );
    }
    const role = (r['Role'] ?? '').toLowerCase();
    const zi = zoneIndex(r['Zone'] ?? 'a');
    const cores = Number(r['Cores']);
    return {
      name: r['Name']          ,
      key: r['Name']          ,
      os,
      kind: osKind(os),
      family: osFamily(os),
      image: method === 'rebuild' && (!image || image.kind === 'replicated') ? { kind: 'custom', variable: `image_${ident(r['Name'] ?? 'vm')}` } : image,
      imageKey,
      size: r['Size'] ?? '',
      ...(Number.isFinite(cores) && cores > 0 ? { cores: Math.floor(cores) } : {}),
      boot: disks[0] ?? { type: fallbackDisk, gib: 64 },
      data: disks.slice(1),
      network: rname(r['Network'] || 'prod'),
      tier: (r['Tier'] || 'app').toLowerCase(),
      zone: ZONE_LETTERS[zi]          ,
      zoneIndex: zi,
      licence: (r['Licence'] || 'li').toLowerCase(),
      backup: (r['Backup'] || 'silver').toLowerCase(),
      method,
      app: r['App'] ?? '',
      role,
      env: r['Env'] ?? '',
      wave: r['Wave'] ?? '',
      component: r['Component'] ?? '',
      plan,
      db: dbTagOf(role),
    };
  });
}

/**
 * The tags Ansible's dynamic inventories key on, and backup selects by. Every
 * compute target carries them; keys are the same on every cloud (lowercase,
 * so GCP labels accept them too). atk_plan scopes the inventory to one plan,
 * atk_method says replicated or rebuilt, atk_component the app component the
 * VM serves.
 */
export function migTags(vm        )                         {
  return {
    atk_plan: vm.plan,
    atk_method: vm.method,
    atk_component: vm.component,
    atk_app: vm.app,
    atk_role: vm.role,
    atk_env: vm.env,
    atk_os: vm.os,
    atk_os_family: vm.family,
    atk_wave: vm.wave,
    atk_backup: vm.backup,
    atk_db: vm.db,
  };
}

/** A label value Google accepts: lowercase letters, digits, `-` and `_`, 63 at most. */
export const gcpLabel = (v        )         => v.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 63);

/** A tag value as an Ansible group name: lower case, a-z 0-9 _ (the dynamic inventories apply the same filters). */
const safeGroupExpr = (v        )         => `lower(replace(${v}, "/[^a-zA-Z0-9_]/", "_"))`;

/**
 * The static route to Ansible: `output "ansible_inventory"`, an inventory in
 * the YAML plugin's shape (JSON is YAML), with every VM Terraform built or
 * adopted, its address, and the groups the tags give it, named as the dynamic
 * inventories name them (platform_, os_kind_, method_, role_, os_,
 * os_family_, env_, app_, wave_, backup_, db_):
 *
 *   terraform output -json ansible_inventory > ../../ansible/inventory/terraform_<p>.json
 *
 * (in a stack the output is prefixed with the item's name: compute_ansible_inventory).
 *
 * `hostsExpr` is a map expression: VM name → an object with ansible_host
 * (and any other host variables). Groups no tag carries (availability groups,
 * app components, plan waves) come from the Ansible project's own inventory.
 */
export function ansibleInventoryOutput(platform        , hostsExpr        )             {
  const tagGroup = (tag        , prefix        )         => `v.tags.${tag} == "" ? "" : "${prefix}_\${${safeGroupExpr(`v.tags.${tag}`)}}"`;
  const groups = [
    'v.kind',
    `"platform_${platform}"`,
    '"os_kind_${v.kind}"',
    'v.kind == "windows" ? "bootstrap_windows" : ""',
    '"method_${v.method}"',
    tagGroup('atk_role', 'role'),
    tagGroup('atk_os', 'os'),
    tagGroup('atk_os_family', 'os_family'),
    tagGroup('atk_env', 'env'),
    tagGroup('atk_app', 'app'),
    tagGroup('atk_wave', 'wave'),
    tagGroup('atk_backup', 'backup'),
    'contains(["oracle", "sqlserver", "postgres"], v.tags.atk_db) ? "db_${v.tags.atk_db}" : ""',
    'contains(["mysql", "mariadb"], v.tags.atk_db) ? "db_mysql" : ""',
  ];
  const groupsExpr = `{ for k, v in local.mig_vms : k => compact([\n    ${groups.join(',\n    ')},\n  ]) if contains(keys(local.mig_ansible_hosts), k) }`;
  return [
    {
      type: 'locals',
      comment: 'The Ansible groups of each VM that exists, from its tags (the static route; the dynamic inventories read the same tags).',
      attributes: [
        { name: 'mig_ansible_hosts', value: x(hostsExpr) },
        { name: 'mig_ansible_groups', value: x(groupsExpr) },
      ],
    },
    output(
      'ansible_inventory',
      '{ all = { hosts = local.mig_ansible_hosts, children = { for g in distinct(flatten(values(local.mig_ansible_groups))) : g => { hosts = { for k, gs in local.mig_ansible_groups : k => {} if contains(gs, g) } } } } }',
      'An Ansible inventory of the VMs Terraform built or adopted, with their addresses and tag groups, for running without the dynamic inventory plugin: terraform output -json <this output> > inventory/terraform_<platform>.json',
    ),
  ];
}

/** One entry of `local.mig_vms`: everything a VM's resources and the backup and monitoring blueprints read. */
export function vmLocalEntry(vm        , extra                                  )         {
  const tags = migTags(vm);
  const fields                         = {
    name: q(vm.name),
    os: q(vm.os),
    kind: q(vm.kind),
    size: q(vm.size),
    network: q(vm.network),
    tier: q(vm.tier),
    zone: q(vm.zone),
    zone_index: String(vm.zoneIndex),
    backup: q(vm.backup),
    method: q(vm.method),
    ...extra,
    tags: hstrmap(tags, 3),
  };
  return hobj(fields, 2);
}

// ---------------------------------------------------------------------------
// Bootstrap (no secrets): the ansible user on Linux, WinRM over HTTPS on Windows
// ---------------------------------------------------------------------------

/**
 * cloud-init for a Linux VM: hostname, an `ansible` user with the SSH key
 * (sudo without a password, key only), and python3 so Ansible can run.
 * `__HOST__` is replaced per VM; `sshKeyExpr` is an expression (a variable).
 */
export function cloudInit(sshKeyExpr        )         {
  return [
    '<<-EOT',
    '    #cloud-config',
    '    hostname: __HOST__',
    '    users:',
    '      - default',
    '      - name: ansible',
    '        shell: /bin/bash',
    '        sudo: "ALL=(ALL) NOPASSWD:ALL"',
    '        lock_passwd: true',
    '        ssh_authorized_keys:',
    `          - \${${sshKeyExpr}}`,
    '    package_update: false',
    '    packages:',
    '      - python3',
    '  EOT',
  ].join('\n');
}

/**
 * PowerShell for a Windows VM: a WinRM HTTPS listener on a self-signed
 * certificate, and 5986 opened only from the management ranges. No account
 * and no password: Ansible's first credential comes from the vault.
 * `mgmtCidrsExpr` is a list expression.
 */
export function winrmBootstrap(mgmtCidrsExpr        , wrap                                               = 'none')         {
  const body = [
    "$ErrorActionPreference = 'Stop'",
    "$cert = New-SelfSignedCertificate -DnsName $env:COMPUTERNAME -CertStoreLocation 'Cert:\\LocalMachine\\My' -NotAfter (Get-Date).AddYears(3)",
    "Get-ChildItem WSMan:\\localhost\\Listener | Where-Object { $_.Keys -contains 'Transport=HTTPS' } | Remove-Item -Recurse -Force",
    "New-Item -Path WSMan:\\localhost\\Listener -Transport HTTPS -Address * -CertificateThumbPrint $cert.Thumbprint -Force | Out-Null",
    "Set-Item -Path WSMan:\\localhost\\Service\\Auth\\Basic -Value $false",
    "Get-NetFirewallRule -Name 'atk-winrm-https' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
    `New-NetFirewallRule -Name 'atk-winrm-https' -DisplayName 'WinRM HTTPS from management' -Direction Inbound -Protocol TCP -LocalPort 5986 -RemoteAddress @('\${join("','", ${mgmtCidrsExpr})}') -Action Allow | Out-Null`,
    "Restart-Service WinRM",
  ];
  const lines = wrap === 'powershell-tags' ? ['<powershell>', ...body, '</powershell>'] : wrap === 'ps1-sysnative' ? ['#ps1_sysnative', ...body] : body;
  return ['<<-EOT', ...lines.map((l) => `    ${l}`), '  EOT'].join('\n');
}

/** A per-VM replace of `__HOST__`, for user data read out of a local. */
export const withHost = (expr        , host = 'each.key')         => `replace(${expr}, "__HOST__", ${host})`;

// ---------------------------------------------------------------------------
// Databases, backup
// ---------------------------------------------------------------------------

export const DB_COLUMN_NAMES = ['Name', 'Service', 'Engine', 'Edition', 'Version', 'Class', 'Storage GiB', 'HA', 'Licence', 'Backup days', 'Network', 'App']         ;

export const HA_OPTIONS = ['none', 'multi-az', 'business-critical', 'zone-redundant', 'regional', 'standby']         ;

export function dbColumns(services                   , engines                   , classes                                    , licences                   )               {
  return [
    { name: 'Name' },
    { name: 'Service', options: services },
    { name: 'Engine', options: engines },
    { name: 'Edition' },
    { name: 'Version' },
    { name: 'Class', options: classes },
    { name: 'Storage GiB' },
    { name: 'HA', options: [...HA_OPTIONS] },
    { name: 'Licence', options: licences },
    { name: 'Backup days' },
    { name: 'Network' },
    { name: 'App' },
  ];
}

                         
                        
                      
                           
                          
                           
                           
                       
                           
                      
                           
                              
                           
                       
 

export function parseDbs(text        , findings           )           {
  const rows = uniqueNames(parseGrid(text, DB_COLUMN_NAMES), 'Name', 'databases', findings);
  return rows.map((r) => ({
    name: rname(r['Name'] ?? ''),
    id: ident(r['Name'] ?? 'db'),
    service: (r['Service'] ?? '').toLowerCase(),
    engine: (r['Engine'] ?? '').toLowerCase(),
    edition: (r['Edition'] ?? '').toLowerCase(),
    version: r['Version'] ?? '',
    cls: r['Class'] ?? '',
    storage: cellNumber(r['Storage GiB'], 100),
    ha: (r['HA'] || 'none').toLowerCase(),
    licence: (r['Licence'] || 'li').toLowerCase(),
    backupDays: cellNumber(r['Backup days'], 7),
    network: rname(r['Network'] || 'prod'),
    app: r['App'] ?? '',
  }));
}

export const BACKUP_COLUMN_NAMES = ['Tier', 'Frequency', 'Retention days', 'Copy to DR region', 'Immutable']         ;
export const BACKUP_COLUMNS                        = [
  { name: 'Tier', options: [...BACKUP_TIERS] },
  { name: 'Frequency', options: ['1h', '4h', '12h', '24h'] },
  { name: 'Retention days' },
  { name: 'Copy to DR region', options: ['yes', 'no'] },
  { name: 'Immutable', options: ['yes', 'no'] },
];
export const DEFAULT_BACKUP_TIERS                                 = [
  ['gold', '4h', '35', 'yes', 'yes'],
  ['silver', '12h', '14', 'no', 'no'],
  ['bronze', '24h', '7', 'no', 'no'],
];

                                 
                        
                         
                             
                         
                              
 

export function parseBackupTiers(text        , findings           )                   {
  const rows = uniqueNames(parseGrid(text, BACKUP_COLUMN_NAMES), 'Tier', 'tiers', findings);
  return rows.map((r) => {
    const f = /^(\d+)\s*h?$/i.exec(r['Frequency'] ?? '');
    const hours = f ? Number(f[1]) : 24;
    return {
      tier: rname(r['Tier'] ?? 'tier'),
      hours: [1, 2, 4, 6, 8, 12, 24].includes(hours) ? hours : 24,
      retention: cellNumber(r['Retention days'], 7),
      copy: yes(r['Copy to DR region']),
      immutable: yes(r['Immutable']),
    };
  });
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

export const SITE_COLUMN_NAMES = ['Site', 'VPN peer address', 'BGP ASN', 'On-prem CIDRs', 'Method', 'Circuit id or service key']         ;
export const SITE_COLUMNS                        = [
  { name: 'Site' },
  { name: 'VPN peer address' },
  { name: 'BGP ASN' },
  { name: 'On-prem CIDRs' },
  { name: 'Method', options: ['vpn', 'circuit', 'circuit-with-vpn-backup'] },
  { name: 'Circuit id or service key' },
];
export const DEFAULT_SITES                                 = [['dc1', '203.0.113.10', '65010', '10.0.0.0/16 fd00:10::/48', 'vpn', '']];

                           
                        
                      
                        
                       
                                    
                                                                 
                           
                        
                                
 

export function parseSites(text        , findings           )             {
  const rows = uniqueNames(parseGrid(text, SITE_COLUMN_NAMES), 'Site', 'sites', findings);
  return rows.map((r) => {
    const m = (r['Method'] ?? 'vpn').toLowerCase();
    const method = m === 'circuit' || m === 'circuit-with-vpn-backup' ? m : 'vpn';
    const peer = r['VPN peer address'] ?? '';
    const vpn = method !== 'circuit';
    if (vpn && familyOf(peer) === null) {
      findings.push(error('tf.mig.site-peer', `Site ${r['Site']}: "${peer}" is not an IP address, and a VPN needs the on-premises peer's.`, { path: 'sites' }));
    }
    const cidrs = words(r['On-prem CIDRs'] ?? '').filter((c) => {
      const ok = familyOf(c) !== null && c.includes('/');
      if (!ok) findings.push(warning('tf.mig.site-cidr', `Site ${r['Site']}: "${c}" is not a CIDR and was left out.`, { path: 'sites' }));
      return ok;
    });
    const circuit = r['Circuit id or service key'] ?? '';
    const usesCircuit = method !== 'vpn';
    if (usesCircuit && circuit === '') {
      findings.push(
        info('tf.mig.circuit-variable', `Site ${r['Site']}: no circuit id or service key was given, so it is a variable. The provider issues it when the circuit is ordered; it cannot be created offline.`, { path: 'sites' }),
      );
    }
    return {
      name: rname(r['Site'] ?? ''),
      id: ident(r['Site'] ?? 'site'),
      peer,
      asn: cellNumber(r['BGP ASN'], 65000),
      cidrs,
      method,
      circuit,
      vpn,
      usesCircuit,
    };
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** A blueprint's single main.tf (the kit's layout pass splits it into the root-module files). */
export function mainTf(blocks                                , header        )         {
  // Some pieces (a reworked foundation) arrive as text; the rest as blocks.
  const parts           = [];
  let pending             = [];
  const flush = () => {
    if (pending.length > 0) parts.push(renderFile(pending).trimEnd());
    pending = [];
  };
  for (const b of blocks) {
    if (typeof b === 'string') {
      flush();
      if (b.trim()) parts.push(b.trim());
    } else pending.push(b);
  }
  flush();
  // An empty block reads as `features {}`, the way the azurerm documentation (and every reader) writes it.
  const body = parts.join('\n\n').replace(/^(\s*)features \{\n\s*\}/gm, '$1features {}');
  return `${header.split('\n').map((l) => `# ${l}`.trimEnd()).join('\n')}\n\n${body}\n`;
}

/** The finding every Oracle Database@ blueprint carries. */
export function oracleRegionFinding(cloud        , region        )          {
  return info(
    'tf.mig.odb-regions',
    `Oracle Database@${cloud} is available only in specific regions; check ${region} against https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm before applying.`,
    { source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm' },
  );
}

// ---------------------------------------------------------------------------
// The landing zone's own inputs, the same on every cloud
// ---------------------------------------------------------------------------

export const SCOPE_LABEL                           = {
  aws: 'AWS account id',
  azure: 'Azure subscription id',
  google: 'Google Cloud project id',
  oci: 'Parent compartment OCID',
};

export function landingZoneInputs(cloud          , regions                   , defaultRegion        )                   {
  return [
    { id: 'prefix', label: 'Name prefix', control: 'text', default: 'mig', hint: 'Lowercase; every resource name starts with it.' },
    {
      id: 'region',
      label: 'Region',
      control: 'select',
      default: regions.includes(defaultRegion) ? defaultRegion : regions[0],
      options: opts(regions),
    },
    gridInput('networks', 'Networks', NETWORK_COLUMNS, DEFAULT_NETWORKS, 'One row per network, as your network team assigned it. Role: hub, spoke, shared-services, inspection or egress. Existing ID: a network that exists already (the hub), which the new ones attach to; it is not built. IPv6 yes makes the network dual-stack.'),
    gridInput('subnets', 'Subnets', SUBNET_COLUMNS, DEFAULT_SUBNETS, cloud === 'aws'
      ? 'One row per subnet, built exactly as given. Purpose: web, app, db, mgmt, container, tgw-attachment, public, firewall or endpoints. Zone: the Availability Zone (AWS subnets are zonal).'
      : cloud === 'azure'
        ? 'One row per subnet, built exactly as given. Purpose: web, app, db, mgmt, container, GatewaySubnet, AzureFirewallSubnet, AzureFirewallManagementSubnet, AzureBastionSubnet, private-endpoints, or a delegation (sqlmi, postgres, mysql, dns-resolver, aadds, oracle, functions, webapp). Zone: regional.'
        : cloud === 'google'
          ? 'One row per subnet, built exactly as given. Purpose: web, app, db, mgmt, container, proxy-only or psc. Zone: regional.'
          : 'One row per subnet, built exactly as given. Purpose: web, app, db, mgmt, container, public, firewall or lb. Zone: regional, or AD-1/2/3 for an availability-domain-specific subnet.'),
    { id: 'site_cidrs', label: 'On-premises ranges', control: 'text', default: '', hint: 'Space-separated, either family. Management and WinRM are allowed from these only.' },
    {
      id: 'bastion',
      label: 'Administrative access',
      control: 'select',
      default: 'cloud-native',
      options: [
        { value: 'cloud-native', label: cloud === 'aws' ? 'Session Manager (no bastion host)' : cloud === 'google' ? 'Identity-Aware Proxy' : 'The cloud bastion service' },
        { value: 'jump-vm', label: 'A jump VM in the mgmt tier (a compute row)' },
        { value: 'none', label: 'None: from on-premises only' },
      ],
    },
    {
      id: 'log_retention_days',
      label: 'Log retention (days)',
      control: 'select',
      default: '365',
      options: opts(['30', '90', '180', '365', '400', '731', '2557']),
    },
    {
      id: 'keys',
      label: 'Encryption keys',
      control: 'select',
      default: 'customer-managed',
      options: [
        { value: 'provider-managed', label: 'Provider-managed keys' },
        { value: 'customer-managed', label: 'Customer-managed keys' },
        { value: 'hsm', label: 'Customer-managed, HSM-backed' },
      ],
    },
    { id: 'scope', label: SCOPE_LABEL[cloud], control: 'text', default: '', hint: 'Blank: a variable you supply at apply time.' },
  ];
}

                                  
                          
                          
                                                                   
                                            
                                                                   
                                            
                                    
                                          
                                     
                                     
                                                        
                             
                                                                 
                         
                          
                            
 

export function parseLandingZone(values                 , defaultRegion        , findings           , cloud          )                  {
  const all = parseNetworks(valueOf(values, 'networks'), findings);
  const subnets = parseSubnets(valueOf(values, 'subnets'), all, cloud === 'aws', findings, cloud);
  const networks = all.filter((n) => !n.existingId);
  const existing = all.filter((n) => !!n.existingId);
  for (const n of networks) {
    if (!subnets.some((s) => s.network.name === n.name)) {
      findings.push(error('tf.mig.network-no-subnets', `Network ${n.name} has no subnet rows: add the subnets it needs.`, { path: 'subnets' }));
    }
  }
  const site = words(valueOf(values, 'site_cidrs'));
  const siteV4 = site.filter((c) => familyOf(c) === 4);
  const siteV6 = site.filter((c) => familyOf(c) === 6);
  for (const c of site.filter((s) => familyOf(s) === null)) {
    findings.push(warning('tf.mig.site-cidr', `"${c}" in the on-premises ranges is not an address or CIDR, and was left out.`, { path: 'site_cidrs' }));
  }
  const anyV6 = networks.some((n) => n.ipv6);
  if (siteV6.length > 0 && !anyV6) {
    findings.push(info('tf.mig.site-ipv6-unused', 'IPv6 on-premises ranges were given but no network is dual-stack, so no IPv6 rule was written.', { path: 'site_cidrs' }));
  }
  const bastion = valueOf(values, 'bastion', 'cloud-native');
  const keys = valueOf(values, 'keys', 'customer-managed');
  return {
    prefix: rname(valueOf(values, 'prefix', 'mig')) || 'mig',
    region: valueOf(values, 'region', defaultRegion),
    networks,
    existing,
    subnets,
    siteV4,
    siteV6,
    bastion: bastion === 'jump-vm' || bastion === 'none' ? bastion : 'cloud-native',
    retention: Number(valueOf(values, 'log_retention_days', '365')) || 365,
    keys: keys === 'provider-managed' || keys === 'hsm' ? keys : 'customer-managed',
    scope: valueOf(values, 'scope'),
    anyV6,
    maxZones: Math.max(1, ...networks.map((n) => n.zones)),
  };
}

/** Management sources on-premises for a network: IPv4 always, IPv6 only on a dual-stack network. */
export const siteSources = (lz                 , network             )           => [...lz.siteV4, ...(network.ipv6 ? lz.siteV6 : [])];

/** Database engine ports, opened from the app and mgmt tiers to the db tier. */
export const DB_PORTS                    = [1433, 1521, 5432, 3306];

/** A consistent description on every blueprint. */
export const landingZoneNote =
  'Writes local.landing_zone, which the identity, connectivity, compute, database, backup and monitoring blueprints in the same stack read.';

// ---------------------------------------------------------------------------
// Structured values: policies, tags, maps
// ---------------------------------------------------------------------------

/** An expression inside a structured value, written as is. */
export class Expr {
           text        ;
  constructor(text        ) {
    this.text = text;
  }
}
export const e = (text        )       => new Expr(text);

/**
 * A JS value as an HCL expression: strings quoted, `e(...)` written as is,
 * arrays and objects laid out one entry per line when they do not fit on one.
 * `depth` is the indent of the attribute it is assigned to.
 */
export function hcl(v         , depth = 1)         {
  if (v instanceof Expr) return v.text;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return q(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map((i) => hcl(i, depth + 1));
    const one = `[${items.join(', ')}]`;
    if (!one.includes('\n') && one.length + depth * 2 < 100) return one;
    return `[\n${items.map((i) => `${'  '.repeat(depth + 1)}${i},`).join('\n')}\n${'  '.repeat(depth)}]`;
  }
  const entries = Object.entries(v                           ).filter(([, val]) => val !== undefined);
  return hobj(Object.fromEntries(entries.map(([k, val]) => [k, hcl(val, depth + 1)])), depth);
}

/** `jsonencode({...})` of a policy document or any structured value. */
export const jsonencode = (v         , depth = 1)         => `jsonencode(${hcl(v, depth)})`;

/** The SSH public key the compute blueprints put on every Linux VM: one declaration, the same text everywhere. */
export function sshKeyVariable(name        )           {
  return variable(name, 'string', 'SSH public key for the ansible user on every Linux VM (and the Oracle VM clusters). A public key, not a secret.');
}

/** `var.cutover_instance_ids`: the replicated VMs to adopt, filled after cutover. Empty applies cleanly. */
export function cutoverVariable(what        )           {
  return variable(
    'cutover_instance_ids',
    'map(string)',
    `Replicated VMs to adopt after cutover: name (as in the grid) to ${what}. Fill cutover.auto.tfvars once the replication tool has launched them, and apply again. Empty adopts nothing.`,
    { default: '{}' },
  );
}

// ---------------------------------------------------------------------------
// Inputs and pieces shared by the same blueprint on several clouds
// ---------------------------------------------------------------------------

/** Oracle Database@AWS / @Azure / @Google Cloud: the same questions everywhere. */
export function odbInputs(cloud                            )                      {
  return [
    { id: 'exadata_shape', label: 'Exadata shape', control: 'select', default: 'Exadata.X11M', options: opts(['Exadata.X11M', 'Exadata.X9M']) },
    { id: 'compute_count', label: 'Database servers', control: 'number', default: 2, min: 2, max: 32 },
    { id: 'storage_count', label: 'Storage servers', control: 'number', default: 3, min: 3, max: 64 },
    { id: 'vm_cluster_cores', label: 'VM cluster cores (OCPUs)', control: 'number', default: 16, min: 4 },
    { id: 'databases', label: 'Databases', control: 'text', default: 'erp crm', hint: 'Names, space-separated. The container databases created in the VM cluster.' },
    ...(cloud !== 'azure' ? [{ id: 'odb_network_cidr', label: 'ODB network range', control: 'text'         , default: '', hint: 'Client and backup subnets are carved from it.' }] : []),
    { id: 'admin_password_var', label: 'Admin password variable', control: 'text', default: 'odb_admin_password', hint: 'A sensitive variable, set as TF_VAR_… and never written.' },
    { id: 'create_databases', label: 'Create databases through OCI', control: 'select', default: 'yes', options: YES_NO },
    { id: 'licence', label: 'Licence', control: 'select', default: 'BRING_YOUR_OWN_LICENSE', options: [{ value: 'BRING_YOUR_OWN_LICENSE', label: 'Bring your own licence' }, { value: 'LICENSE_INCLUDED', label: 'Licence included' }] },
    { id: 'network', label: 'Network', control: 'text', default: 'prod', hint: 'The landing-zone network it is reached from.' },
    { id: 'oci_region_name', label: 'OCI region', control: 'text', default: 'us-ashburn-1', hint: 'The OCI region paired with this cloud region, for the database homes.' },
    LANDING_ZONE_SOURCE,
  ];
}

/**
 * Database homes and databases inside a VM cluster, created through OCI
 * (they are not resources of the cloud that hosts the Exadata).
 */
export function odbOciDatabases(values                 , vmClusterOcid        , depends        )             {
  if (valueOf(values, 'create_databases', 'yes') !== 'yes') return [];
  const names = words(valueOf(values, 'databases', 'erp')).map((n) => n.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()).filter(Boolean);
  if (names.length === 0) return [];
  const pw = ident(valueOf(values, 'admin_password_var', 'odb_admin_password'));
  return [
    {
      type: 'provider',
      labels: ['oci'],
      comment: 'The database homes and databases in the VM cluster are OCI resources: sign in to the OCI tenancy linked to this subscription.',
      attributes: attrs({ region: valueOf(values, 'oci_region_name', 'us-ashburn-1') }),
    },
    res('oci_database_db_home', 'odb', {
      vm_cluster_id: x(vmClusterOcid),
      source: 'VM_CLUSTER_NEW',
      db_version: '19.0.0.0',
      display_name: 'dbhome19',
      depends_on: x(`[${depends}]`),
    }),
    res('oci_database_database', 'odb', {
      for_each: x(`toset(${hcl(names)})`),
      db_home_id: x('oci_database_db_home.odb.id'),
      source: 'NONE',
    }, [
      blk('database', {
        db_name: x('each.key'),
        admin_password: x(`var.${pw}`),
        character_set: 'AL32UTF8',
        ncharacter_set: 'AL16UTF16',
        db_workload: 'OLTP',
      }),
    ]),
  ];
}


export function backupInputs()                      {
  return [
    gridInput('tiers', 'Backup tiers', BACKUP_COLUMNS, DEFAULT_BACKUP_TIERS, 'One row per tier. VMs and databases are selected by their atk_backup tag.'),
    { id: 'dr_region', label: 'DR region', control: 'text', default: '', blankLabel: 'No copies to another region', hint: 'Blank: no copies to another region.' },
    LANDING_ZONE_SOURCE,
  ];
}


export function monitoringInputs()                      {
  return [
    { id: 'siem', label: 'SIEM', control: 'select', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'splunk', label: 'Splunk' }, { value: 'sentinel', label: 'Microsoft Sentinel' }, { value: 'google-secops', label: 'Google SecOps' }, { value: 'qradar', label: 'IBM QRadar' }] },
    { id: 'retention_days', label: 'Log retention (days)', control: 'select', default: '90', options: opts(['30', '90', '180', '365', '731']) },
  ];
}


// ---------------------------------------------------------------------------
// The compute contract, as backup and monitoring read it
// ---------------------------------------------------------------------------

/**
 * The VMs a backup or monitoring blueprint acts on, name → { id, backup, kind
 * (, volumes) }.
 *
 * In a stack it is read from the compute blueprint's locals: `local.mig_vms`
 * (every VM in the grid) joined to `local.mig_vm_ids` (the ones that exist:
 * built, or adopted after cutover), and on OCI `local.mig_vm_volumes` (boot
 * and block volume ids). On its own the blueprint declares `var.mig_vms` of
 * the same shape, empty by default.
 */
export function vmSource(values                 , withVolumes = false)                                       {
  if (lzSource(values) === 'stack') {
    return {
      blocks: [],
      expr: `{ for k, v in local.mig_vms : k => { id = local.mig_vm_ids[k], backup = v.backup, kind = v.kind${withVolumes ? ', volumes = local.mig_vm_volumes[k]' : ''} } if contains(keys(local.mig_vm_ids), k) }`,
    };
  }
  return {
    blocks: [
      variable(
        'mig_vms',
        `map(object({\n    id     = string\n    backup = string\n    kind   = string${withVolumes ? '\n    volumes = list(string)' : ''}\n  }))`,
        `The VMs to act on, by name: id, backup tier (gold/silver/bronze), kind (linux/windows)${withVolumes ? ' and the ids of their boot and block volumes' : ''}. The compute blueprint's vms output has them.`,
        { default: '{}' },
      ),
    ],
    expr: 'var.mig_vms',
  };
}
