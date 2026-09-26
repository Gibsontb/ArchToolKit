/**
 * The service equivalence map: one job, five platforms, with the attributes
 * that carry between them.
 *
 * The Terraform Maps (map.ts, map-data.ts, map-aws.ts) say which resource does
 * a job *within* one cloud; their rows do not line up across clouds. The
 * capability matrix (multicloud/services.ts) lines up, but only 21 capabilities
 * deep and with one type per platform and no attributes. This file is the
 * aligned version the migration planner needs to switch an application from
 * one platform to another without guessing:
 *
 *  - every row names the resource types that do the job on each platform
 *    (`primary`), the sub-resources that fold into it (`supporting`, AWS's
 *    split S3 bucket settings for example), and other types that do the same
 *    job on that platform (`alternatives`, the Windows VM beside the Linux one);
 *  - a platform with no equivalent says so, with a reason (`none`). A cell is
 *    never simply left out: the tests fail on that;
 *  - `attributes` line up the arguments by concept (size, name, tags, subnet,
 *    encryption key …) with the transform that turns one platform's value into
 *    another's (see apps/translate.ts).
 *
 * Every type named in a row is checked against the committed provider catalog
 * (catalog-data.ts) and every attribute path against the provider schema, by
 * equivalence.test.ts. Anything a map or a migration blueprint names that is
 * not in a row is in `UNMAPPED`, with a reason, so "not aligned" is a
 * statement rather than an oversight.
 *
 * The labels are indicative, as in services.ts: product names change. The
 * resource types are what is checked, and what logic reads.
 */

import type { Platform } from '../multicloud/platforms.ts';
import { EQUIVALENCE_ROWS, MODULE_EQUIVALENCE, UNMAPPED } from './equivalence-data.ts';

// ------------------------------------------------------------------ types ---

export type EquivalenceDomain =
  | 'network'
  | 'identity'
  | 'compute'
  | 'containers'
  | 'serverless'
  | 'storage'
  | 'database'
  | 'integration'
  | 'security'
  | 'observability'
  | 'dns'
  | 'lb'
  | 'backup'
  | 'vmware';

export const EQUIVALENCE_DOMAINS: readonly EquivalenceDomain[] = [
  'network', 'identity', 'compute', 'containers', 'serverless', 'storage', 'database',
  'integration', 'security', 'observability', 'dns', 'lb', 'backup', 'vmware',
];

export const DOMAIN_LABELS: Readonly<Record<EquivalenceDomain, string>> = {
  network: 'Networking',
  identity: 'Identity and resource containers',
  compute: 'Compute',
  containers: 'Containers',
  serverless: 'Serverless and PaaS',
  storage: 'Storage',
  database: 'Databases',
  integration: 'Integration and messaging',
  security: 'Security and keys',
  observability: 'Observability',
  dns: 'DNS',
  lb: 'Load balancing and edge',
  backup: 'Backup',
  vmware: 'VMware platforms',
};

/**
 * How one platform's value relates to the concept's platform-neutral form.
 * Each platform entry of an `AttributeMap` names its own transform; carrying a
 * value is "source to neutral, neutral to target".
 *
 *  - same            the value as it is
 *  - first           a list on one side, a single value on the other (first item)
 *  - bool            true / false
 *  - enabled-string  "Enabled" / "Disabled" for true / false
 *  - gib             a size in GiB (a number)
 *  - mib-to-gib      a size held in MiB, neutral in GiB
 *  - rightsize       a machine size; neutral is {vCPU, GiB}, re-fitted with rightsizeFor
 *  - db-class        a database instance class; neutral is {vCPU, GiB}
 *  - db-version      an engine version; neutral is the major version
 *  - tags-to-labels  key=value lines; Google's labels are lower-cased
 *  - lz-subnet / lz-sg / lz-kms  a landing-zone contract reference, platform-neutral by contract
 *  - region / zone   a region / an availability zone or domain
 *  - ha-mode         high availability on or off
 *  - retention       a retention period; neutral is days
 */
export type TransformId =
  | 'same'
  | 'first'
  | 'bool'
  | 'enabled-string'
  | 'gib'
  | 'mib-to-gib'
  | 'rightsize'
  | 'db-class'
  | 'db-version'
  | 'tags-to-labels'
  | 'lz-subnet'
  | 'lz-sg'
  | 'lz-kms'
  | 'region'
  | 'zone'
  | 'ha-mode'
  | 'retention';

/**
 * A condition on a component's values that routes a type shared by several
 * rows to the right one: `aws_db_instance` is PostgreSQL, MySQL, SQL Server or
 * Oracle by its `engine`. `key` is a values key (`r.<path>` or `b.<path>`),
 * `pattern` a regular expression over the value.
 */
export interface TypeMatch {
  readonly key: string;
  readonly pattern: string;
}

export interface PlatformCell {
  /** The types that do the job; what a translation to this platform creates. */
  readonly primary: readonly string[];
  /** Sub-resources that fold into the primary by concept. */
  readonly supporting?: readonly string[];
  /** Other types doing the same job here: read when translating from them. */
  readonly alternatives?: readonly { readonly type: string; readonly os?: 'windows' | 'linux' }[];
  /** Per type: the condition under which the type belongs to this row. */
  readonly match?: Readonly<Record<string, TypeMatch>>;
  /** "No equivalent", with the reason. Set instead of `primary` (which is then []). */
  readonly none?: string;
  /** A caveat worth showing beside the cell. */
  readonly note?: string;
}

export interface AttributeTarget {
  readonly type: string;
  /** Dotted argument path in the type's schema: `root_block_device.volume_size`. */
  readonly path: string;
  readonly transform?: TransformId;
  /**
   * For `rightsize` / `db-class`: the arguments that hold the size alongside
   * `path` on a platform that sizes by numbers (OCI Flex OCPUs and memory,
   * vSphere CPUs and MiB).
   */
  readonly companions?: {
    readonly ocpus?: string;
    readonly cpu?: string;
    readonly memoryGib?: string;
    readonly memoryMib?: string;
  };
}

export interface AttributeMap {
  /** 'name', 'tags', 'size', 'subnet', 'encryption.key', 'engine.version', 'storage.gib', 'ha' … */
  readonly concept: string;
  readonly per: Readonly<Partial<Record<Platform, AttributeTarget>>>;
}

export interface EquivalenceRow {
  /** 'compute.vm', 'storage.object', 'db.postgres.managed', 'lb.l7' … */
  readonly id: string;
  readonly domain: EquivalenceDomain;
  readonly label: string;
  readonly per: Readonly<Partial<Record<Platform, PlatformCell>>>;
  readonly attributes: readonly AttributeMap[];
  /** The Terraform Map section, per cloud, that explains the job. */
  readonly mapSection?: Readonly<Partial<Record<Platform, string>>>;
  /** Where the alignment comes from, and how far it is verified. */
  readonly source: string;
}

export interface UnmappedEntry {
  readonly type: string;
  readonly reason: string;
}

/** A cloud-specific Ansible module and its counterparts. */
export interface ModuleRow {
  readonly id: string;
  readonly label: string;
  readonly per: Readonly<Partial<Record<Platform, { readonly module: string } | { readonly none: string }>>>;
  /** Concept → option name per platform, for options whose names differ. */
  readonly options: Readonly<Record<string, Readonly<Partial<Record<Platform, string>>>>>;
  readonly source: string;
}

export { EQUIVALENCE_ROWS, MODULE_EQUIVALENCE, UNMAPPED };

// -------------------------------------------------------------- platforms ---

export const EQUIVALENCE_PLATFORMS: readonly Platform[] = ['aws', 'azure', 'google', 'oci', 'vmware'];

const VMWARE_PREFIXES = ['vsphere_', 'vcf_', 'nsxt_', 'avi_', 'vra_', 'vcd_'];

/** The platform a resource type belongs to, from its provider prefix. */
export function platformOfType(type: string): Platform | undefined {
  if (type.startsWith('aws_')) return 'aws';
  if (type.startsWith('azurerm_') || type.startsWith('azuread_')) return 'azure';
  if (type.startsWith('google_')) return 'google';
  if (type.startsWith('oci_')) return 'oci';
  if (VMWARE_PREFIXES.some((p) => type.startsWith(p))) return 'vmware';
  return undefined;
}

/**
 * The Terraform page's per-resource blueprint id: `res_<type>` for the four
 * clouds (blueprints/index.ts), `vmw_<type>` for the VMware providers.
 */
export function blueprintIdFor(type: string): string {
  return platformOfType(type) === 'vmware' ? `vmw_${type}` : `res_${type}`;
}

// ---------------------------------------------------------------- lookups ---

export type TypeRole = 'primary' | 'supporting' | 'alternative';

/** What part a type plays in a row's cell for its platform, if any. */
export function roleIn(row: EquivalenceRow, type: string): TypeRole | undefined {
  for (const cell of Object.values(row.per)) {
    if (!cell) continue;
    if (cell.primary.includes(type)) return 'primary';
    if (cell.alternatives?.some((a) => a.type === type)) return 'alternative';
    if (cell.supporting?.includes(type)) return 'supporting';
  }
  return undefined;
}

/** The cell that names a type, and the platform it is on. */
export function cellOf(row: EquivalenceRow, type: string): { readonly platform: Platform; readonly cell: PlatformCell } | undefined {
  for (const platform of EQUIVALENCE_PLATFORMS) {
    const cell = row.per[platform];
    if (!cell) continue;
    if (cell.primary.includes(type) || cell.supporting?.includes(type) || cell.alternatives?.some((a) => a.type === type)) {
      return { platform, cell };
    }
  }
  return undefined;
}

let INDEX: Map<string, EquivalenceRow[]> | undefined;

function index(): Map<string, EquivalenceRow[]> {
  if (INDEX) return INDEX;
  INDEX = new Map();
  for (const row of EQUIVALENCE_ROWS) {
    for (const cell of Object.values(row.per)) {
      if (!cell) continue;
      const types = [...cell.primary, ...(cell.alternatives ?? []).map((a) => a.type), ...(cell.supporting ?? [])];
      for (const type of new Set(types)) {
        const list = INDEX.get(type) ?? [];
        if (!list.includes(row)) list.push(row);
        INDEX.set(type, list);
      }
    }
  }
  return INDEX;
}

/** Every row that names a type, in any role. */
export function rowsNaming(type: string): readonly EquivalenceRow[] {
  return index().get(type) ?? [];
}

function matches(m: TypeMatch, values: Readonly<Record<string, string>> | undefined): boolean {
  const v = values?.[m.key];
  if (v === undefined || String(v).trim() === '') return false;
  return new RegExp(m.pattern, 'i').test(String(v).trim());
}

/**
 * The row a type belongs to.
 *
 * A type in several rows (`aws_db_instance` is PostgreSQL, MySQL, SQL Server
 * or Oracle) is routed by the rows' `match` conditions over its values; with
 * no values or no condition met, it falls back to the one row that names it
 * without a condition. A type named as primary or alternative anywhere wins
 * over the rows it only supports.
 */
export function rowOf(type: string, values?: Readonly<Record<string, string>>): EquivalenceRow | undefined {
  const rows = rowsNaming(type);
  if (rows.length === 0) return undefined;
  const conditioned = rows.filter((r) => cellOf(r, type)?.cell.match?.[type] !== undefined);
  const hit = conditioned.find((r) => matches(cellOf(r, type)!.cell.match![type]!, values));
  if (hit) return hit;
  const plain = rows.filter((r) => cellOf(r, type)?.cell.match?.[type] === undefined);
  const owning = plain.find((r) => roleIn(r, type) !== 'supporting');
  return owning ?? plain[0] ?? conditioned[0];
}

/**
 * What a type becomes on every platform: the primary types, or the reason
 * there is none. The type's own platform lists its own row's primaries.
 */
export function equivalents(
  type: string,
  values?: Readonly<Record<string, string>>,
): Readonly<Partial<Record<Platform, readonly string[] | { readonly none: string }>>> {
  const row = rowOf(type, values);
  const out: Partial<Record<Platform, readonly string[] | { readonly none: string }>> = {};
  if (!row) {
    const reason = unmappedReason(type) ?? 'not in the equivalence map';
    for (const p of EQUIVALENCE_PLATFORMS) if (p !== platformOfType(type)) out[p] = { none: reason };
    return out;
  }
  for (const p of EQUIVALENCE_PLATFORMS) {
    const cell = row.per[p];
    if (!cell) continue;
    out[p] = cell.none !== undefined ? { none: cell.none } : cell.primary;
  }
  return out;
}

/** The reason a type is deliberately not aligned, when it is listed as such. */
export function unmappedReason(type: string): string | undefined {
  return UNMAPPED.find((u) => u.type === type)?.reason;
}

export function rowById(id: string): EquivalenceRow | undefined {
  return EQUIVALENCE_ROWS.find((r) => r.id === id);
}

export function rowsInDomain(domain: EquivalenceDomain): readonly EquivalenceRow[] {
  return EQUIVALENCE_ROWS.filter((r) => r.domain === domain);
}

/**
 * The same-domain rows that do have something on a platform: what "Add any
 * service" offers in place of a component with no equivalent there.
 */
export function nearestRows(row: EquivalenceRow, platform: Platform): readonly EquivalenceRow[] {
  return rowsInDomain(row.domain).filter((r) => r !== row && (r.per[platform]?.primary.length ?? 0) > 0);
}

/** The attribute map entry for one argument of one type, if the row carries it. */
export function attributeFor(
  row: EquivalenceRow,
  platform: Platform,
  type: string,
  path: string,
): { readonly map: AttributeMap; readonly role: 'path' | keyof NonNullable<AttributeTarget['companions']> } | undefined {
  for (const map of row.attributes) {
    const t = map.per[platform];
    if (!t || t.type !== type) continue;
    if (t.path === path) return { map, role: 'path' };
    for (const [role, p] of Object.entries(t.companions ?? {})) {
      if (p === path) return { map, role: role as keyof NonNullable<AttributeTarget['companions']> };
    }
  }
  return undefined;
}

/** Every resource type any row names, deduplicated. */
export function typesInRows(): readonly string[] {
  return [...index().keys()];
}

// ---------------------------------------------------------------- modules ---

/**
 * Collections whose modules act on the guest OS, not on a cloud: they carry
 * over a platform switch unchanged.
 */
export const NEUTRAL_COLLECTIONS: readonly string[] = [
  'ansible.builtin',
  'ansible.windows',
  'ansible.posix',
  'ansible.utils',
  'community.general',
  'community.windows',
  'community.crypto',
  'community.mysql',
  'community.postgresql',
  'microsoft.ad',
];

/** The collections whose modules belong to one platform. */
export const PLATFORM_COLLECTIONS: Readonly<Record<string, Platform>> = {
  'amazon.aws': 'aws',
  'community.aws': 'aws',
  'azure.azcollection': 'azure',
  'google.cloud': 'google',
  'oracle.oci': 'oci',
  'community.vmware': 'vmware',
  'vmware.vmware': 'vmware',
  'vmware.vmware_rest': 'vmware',
};

export function collectionOfModule(fqcn: string): string {
  return fqcn.split('.').slice(0, 2).join('.');
}

export function isNeutralModule(fqcn: string): boolean {
  return NEUTRAL_COLLECTIONS.includes(collectionOfModule(fqcn));
}

export function platformOfModule(fqcn: string): Platform | undefined {
  return PLATFORM_COLLECTIONS[collectionOfModule(fqcn)];
}

export function moduleRowOf(fqcn: string): ModuleRow | undefined {
  return MODULE_EQUIVALENCE.find((m) => Object.values(m.per).some((c) => c && 'module' in c && c.module === fqcn));
}

/** The module blueprint id the Ansible page uses: `mod_<fqcn with dots as underscores>`. */
export function moduleBlueprintId(fqcn: string): string {
  return `mod_${fqcn.replace(/\./g, '_')}`;
}

/**
 * The module a `mod_*` blueprint id names, where it can be told: the id
 * flattens dots to underscores, so it is resolved against the known
 * collections (and the equivalence rows) rather than guessed.
 */
export function moduleFromBlueprintId(id: string): string | undefined {
  if (!id.startsWith('mod_')) return undefined;
  for (const row of MODULE_EQUIVALENCE) {
    for (const cell of Object.values(row.per)) {
      if (cell && 'module' in cell && moduleBlueprintId(cell.module) === id) return cell.module;
    }
  }
  const rest = id.slice(4);
  const collections = [...NEUTRAL_COLLECTIONS, ...Object.keys(PLATFORM_COLLECTIONS)].sort((a, b) => b.length - a.length);
  for (const c of collections) {
    const flat = `${c.replace(/\./g, '_')}_`;
    if (rest.startsWith(flat)) return `${c}.${rest.slice(flat.length)}`;
  }
  return undefined;
}

// --------------------------------------------------------------- coverage ---

export interface EquivalenceCoverage {
  readonly rows: number;
  readonly byDomain: Readonly<Record<EquivalenceDomain, number>>;
  readonly types: number;
  readonly unmapped: number;
  /** Per platform: the rows it has no equivalent for. */
  readonly gaps: Readonly<Record<Platform, readonly string[]>>;
  readonly modules: number;
}

export function equivalenceCoverage(): EquivalenceCoverage {
  const byDomain = Object.fromEntries(EQUIVALENCE_DOMAINS.map((d) => [d, rowsInDomain(d).length])) as Record<EquivalenceDomain, number>;
  const gaps = Object.fromEntries(
    EQUIVALENCE_PLATFORMS.map((p) => [p, EQUIVALENCE_ROWS.filter((r) => r.per[p]?.none !== undefined).map((r) => r.id)]),
  ) as Record<Platform, string[]>;
  return {
    rows: EQUIVALENCE_ROWS.length,
    byDomain,
    types: typesInRows().length,
    unmapped: UNMAPPED.length,
    gaps,
    modules: MODULE_EQUIVALENCE.length,
  };
}
