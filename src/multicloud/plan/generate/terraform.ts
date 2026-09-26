/**
 * Terraform composition: a decided, designed plan becomes one Terraform root
 * module per platform, stacked from the "From a migration plan" blueprints.
 *
 *   planToStacks   the stack items per platform (and per DR region), with
 *                  every value written in the blueprint's own input ids, grid
 *                  text included, exactly as the Terraform page saves them;
 *   terraformFiles those stacks built with `buildStack`, plus the per-platform
 *                  README, `cutover.auto.tfvars.example` and the settings
 *                  envelope the Terraform page loads.
 *
 * The same values go into the envelope, so opening a platform on the Terraform
 * page shows exactly the stack that was generated, editable; rebuilding the
 * envelope's stack through `buildStack` gives the same `.tf` files byte for
 * byte.
 *
 * Stack order per platform (base design 2.7.2, addendum A.12.3):
 *
 *   1 landing zone, 2 identity, 3 connectivity, governance,
 *   4 compute, 5 databases, 6 Oracle Database@,
 *   app context, pattern items, resource components,
 *   7 backup, 8 monitoring, app monitoring, relocate, 9 replication
 *
 * Every item is left out when it would be empty. The items whose blueprints
 * are not written yet (replication, governance, app context and monitoring,
 * patterns) are added only when the blueprint lookup returns them, so this
 * works today and picks them up when they land.
 *
 * Nothing here writes a credential, a timestamp other than the plan's own
 * `savedAt`, or anything that identifies who or what generated it.
 */

import { error, info, warning, type Finding } from '../../../core/findings.ts';
import { familyOf, overlapsAny } from '../../../core/ip.ts';
import type { Json } from '../../../editor/doc.ts';
import type { Blueprint } from '../../../kit/blueprint.ts';
import { envelope, writeSettings } from '../../../kit/settings-file.ts';
import type { BlueprintLookup, StackItem } from '../../../kit/stack.ts';
import { renderImageRef, type ImageRef as GridImageRef } from '../../../terraform/blueprints/migration/common.ts';
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.ts';
import type { CloudTarget } from '../../../terraform/providers.ts';
import type { BackendKind } from '../../../terraform/scaffold.ts';
import { buildStack } from '../../../terraform/stack.ts';
import { designWorkloads, isIaasService, licenceKeyOf, siteCidrs } from '../design/index.ts';
import { networkForEnv, networkZones } from '../design/network.ts';
import { RELOCATE_HOSTS } from '../design/relocate.ts';
import { NETWORK_BASE, overrideKey, PLATFORM_LABELS, PLATFORM_VALUES, slugName } from '../options.ts';
import type {
  App, ComputeTarget, Database, DbTarget, Env, GeneratedProject, ItemId, NetworkDesign, Plan, PlanDecision, Platform,
  PlatformDesign, StateBackend, TargetDesign, TerraformSettingsEnvelope, Workload,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StackScope = 'estate' | 'landing-zone' | 'apps';
export type LandingZoneMode = 'shared' | 'included';

export interface PlanToStacksOptions {
  /**
   * `estate` (default): everything. `landing-zone`: the landing zone,
   * identity, connectivity, governance and relocation only. `apps`: the
   * workloads, databases and app items of the selected apps.
   */
  readonly scope?: StackScope;
  /**
   * `included` (default): the stack carries its own landing zone. `shared`
   * (apps scope only): the landing zone, identity and connectivity are left
   * out and every consumer reads `var.landing_zone` instead.
   */
  readonly landingZone?: LandingZoneMode;
  /** Only the workloads (and their databases) of this environment. */
  readonly environment?: Env;
  /** Only these apps (App ids or names). */
  readonly apps?: readonly string[];
  /** Where blueprints are found; `findTerraformBlueprint` by default. Tests pass their own. */
  readonly lookup?: BlueprintLookup;
  /** The pattern blueprint id for a pattern component on a platform (default: the component's `blueprint` setting, else `<p>_app_<pattern>`). */
  readonly patternBlueprint?: (component: AppComponentLike, platform: Platform) => string | undefined;
}

/** One platform's stack: what goes to `buildStack`, and how. */
export interface PlatformStack {
  readonly platform: Platform;
  /** `terraform/<folder>/`: the platform, or `<platform>-dr`. */
  readonly folder: string;
  readonly items: StackItem[];
  readonly stackName: string;
  readonly target: CloudTarget;
  readonly requiredVersion: string;
  readonly backend?: Exclude<BackendKind, 'none'>;
  /** Steps Terraform does not do, for the README (and WP-9's runbooks). */
  readonly manual: readonly string[];
  /** A DR-region stack: its landing zone only. */
  readonly dr?: boolean;
}

export interface PlanStacks {
  readonly perPlatform: Partial<Record<Platform, PlatformStack>>;
  /** The DR-region stacks (`terraform/<p>-dr/`), where a DR region is set. */
  readonly dr: Partial<Record<Platform, PlatformStack>>;
  readonly findings: readonly Finding[];
}

/** The envelope a platform's stack is saved as: the Terraform page's, plus how it was built. */
export type PlanTerraformEnvelope = TerraformSettingsEnvelope & {
  /** `required_version` the stack was built with. */
  readonly requiredVersion: string;
  /** The backend written into versions.tf. */
  readonly backend?: Exclude<BackendKind, 'none'>;
};

/**
 * The application-plan parts this reads (addendum A.11.1), structurally: the
 * data model's `appPlans` is added by another package, so nothing here depends
 * on it being declared yet.
 */
export interface AppComponentLike {
  readonly id: string;
  readonly name: string;
  readonly kind: 'pattern' | 'resource' | 'config';
  readonly tierPattern?: string;
  readonly settings?: Readonly<Record<string, string>>;
  readonly blueprintId?: string;
  readonly values?: Readonly<Record<string, string>>;
}
export interface AppPlanLike {
  readonly app: ItemId;
  readonly status?: 'draft' | 'planned' | 'approved';
  readonly platform?: Platform;
  readonly recommendation?: { readonly platform: Platform };
  readonly variants?: Readonly<Partial<Record<Platform, readonly AppComponentLike[]>>>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The blueprint id prefix and folder per platform. */
const BP: Readonly<Record<Platform, string>> = { aws: 'aws', azure: 'azure', google: 'google', oci: 'oci', vmware: 'vsphere' };
const TARGET: Readonly<Record<Platform, CloudTarget>> = { aws: 'aws', azure: 'azure', google: 'google', oci: 'oci', vmware: 'vsphere' };
const CLOUD_NAME: Readonly<Record<Platform, string>> = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud', oci: 'OCI', vmware: 'VCF' };
const ZONE_LETTERS = ['a', 'b', 'c'] as const;
const HA_GRID = new Set(['none', 'multi-az', 'business-critical', 'zone-redundant', 'regional', 'standby']);

/** `required_version` for a stack; a write-only argument (`*_wo`) needs Terraform 1.11. */
export const REQUIRED_VERSION = '>= 1.7.0';
export const REQUIRED_VERSION_WRITE_ONLY = '>= 1.11.0';

/** A grid row: cells joined with " | ", with anything that would break the row made safe. */
function row(cells: readonly (string | number | undefined)[]): string {
  return cells.map((c) => String(c ?? '').replace(/\r?\n/g, ' ').replace(/\s\|\s/g, ' / ').trim()).join(' | ');
}
const grid = (rows: readonly (readonly (string | number | undefined)[])[]): string => rows.map(row).join('\n');

/** What a blueprint's resource-name helper (`rname`) makes of a name. */
const rname = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');

/** The compute row's Name: the workload's, made a valid Compute Engine name on Google Cloud (lowercase, a letter first). */
export function computeRowName(platform: Platform, name: string): string {
  if (platform !== 'google') return name;
  const s = rname(name).slice(0, 63).replace(/-+$/, '');
  return /^[a-z]/.test(s) ? s : `vm-${s}`.slice(0, 63);
}

/** The state backend for a platform from the Generate setting. */
export function backendFor(platform: Platform, setting: StateBackend | undefined): Exclude<BackendKind, 'none'> {
  const s = setting ?? 'platform';
  if (s !== 'platform') return s;
  return ({ aws: 's3', azure: 'azurerm', google: 'gcs', oci: 'oci', vmware: 'local' } as const)[platform];
}

/** A /prefix inside 10.0.0.0/8 that overlaps nothing in `used`, scanning second octets from `seed`. */
function freeBlock(used: readonly string[], prefix: number, seed: number): string | undefined {
  for (let i = 0; i < 256; i += 1) {
    const o = (seed + i) % 256;
    const c = `10.${o}.0.0/${prefix}`;
    if (!used.some((u) => familyOf(u.split('/')[0] ?? '') === 4 && overlapsAny(c, u))) return c;
  }
  return undefined;
}

/** Keep only the values a blueprint declares, when it declares its inputs (a lazy blueprint keeps them all). */
function declared(bp: Blueprint, values: Readonly<Record<string, string>>): Record<string, string> {
  if (bp.inputs.length === 0) return { ...values };
  const ids = new Set(bp.inputs.map((i) => i.id));
  return Object.fromEntries(Object.entries(values).filter(([k]) => ids.has(k)));
}

const appPlansOf = (plan: Plan): readonly AppPlanLike[] => (plan as Plan & { readonly appPlans?: readonly AppPlanLike[] }).appPlans ?? [];

// ---------------------------------------------------------------------------
// The per-platform context
// ---------------------------------------------------------------------------

interface Ctx {
  readonly plan: Plan;
  readonly decision: PlanDecision;
  readonly design: TargetDesign;
  readonly pd: PlatformDesign;
  readonly platform: Platform;
  readonly bp: string;
  readonly lookup: BlueprintLookup;
  readonly scope: StackScope;
  readonly shared: boolean;
  readonly findings: Finding[];
  readonly manual: string[];
  readonly workloadById: ReadonlyMap<string, Workload>;
  readonly dbById: ReadonlyMap<string, Database>;
  readonly appByName: ReadonlyMap<string, App>;
  /** Compute targets in scope, as rows. */
  readonly compute: readonly ComputeTarget[];
  /** Database targets in scope. */
  readonly databases: readonly DbTarget[];
  /** Workload id → database engine, for the hosts of an IaaS database. */
  readonly dbEngineOfHost: ReadonlyMap<string, string>;
  /** Addresses already taken: every design network, the sites, and what this run allocated. */
  readonly used: string[];
}

function inScopeWorkload(w: Workload | undefined, options: PlanToStacksOptions, apps: ReadonlySet<string> | null): boolean {
  if (!w) return true;
  if (options.environment && w.env !== options.environment) return false;
  if (apps && !apps.has(w.app) && !apps.has(slugName(w.app))) return false;
  return true;
}

function contextFor(plan: Plan, decision: PlanDecision, design: TargetDesign, pd: PlatformDesign, options: PlanToStacksOptions, used: string[], findings: Finding[]): Ctx {
  const platform = pd.platform;
  const workloads = [...designWorkloads(plan, design), ...(pd.added ?? [])];
  const workloadById = new Map(workloads.map((w) => [w.id, w]));
  const dbById = new Map(plan.databases.map((d) => [d.id, d]));
  const appByName = new Map(plan.apps.map((a) => [a.name, a]));
  const apps = options.apps && options.apps.length > 0
    ? new Set(options.apps.flatMap((a) => {
      const app = plan.apps.find((x) => x.id === a || x.name === a);
      return app ? [app.name, slugName(app.name)] : [a, slugName(a)];
    }))
    : null;

  const compute: ComputeTarget[] = [];
  for (const c of pd.compute) {
    const method = decision.items[c.workload]?.method;
    if (method === 'managed-db') {
      // The source host of a database that moves to a managed service is not rebuilt anywhere.
      findings.push(info('plan.tf.managed-db-host', `${workloadById.get(c.workload)?.name ?? c.workload}: its database moves to a managed service, so it is not a compute row.`));
      continue;
    }
    if (!inScopeWorkload(workloadById.get(c.workload), options, apps)) continue;
    compute.push(c);
  }
  const inCompute = new Set(compute.map((c) => c.workload));
  const databases = pd.databases.filter((d) => {
    const db = dbById.get(d.database);
    if (apps && db && !apps.has(db.app) && !apps.has(slugName(db.app))) return false;
    if (options.environment) {
      const host = db?.hosts.map((h) => workloads.find((w) => w.name === h)).find(Boolean);
      const env = host?.env ?? 'prod';
      if (env !== options.environment) return false;
    }
    // An IaaS database lives on its hosts: in scope when one of them is.
    if (isIaasService(d.service) && d.hosts && d.hosts.length > 0 && !d.hosts.some((h) => inCompute.has(h))) return false;
    return true;
  });
  const dbEngineOfHost = new Map<string, string>();
  for (const d of databases) {
    if (!isIaasService(d.service)) continue;
    const engine = dbById.get(d.database)?.engine;
    if (engine) for (const h of d.hosts ?? []) dbEngineOfHost.set(h, engine);
  }
  const scope = options.scope ?? 'estate';
  return {
    plan, decision, design, pd, platform,
    bp: BP[platform],
    lookup: options.lookup ?? findTerraformBlueprint,
    scope,
    shared: scope === 'apps' && options.landingZone === 'shared',
    findings,
    manual: [],
    workloadById, dbById, appByName,
    compute, databases, dbEngineOfHost,
    used,
  };
}

/** `stack`, or `variables` when the landing zone is shared from another project. */
const lzSource = (ctx: Ctx): string => (ctx.shared ? 'variables' : 'stack');

/** The network a database sits in: its first host's environment, else prod. */
function dbNetwork(ctx: Ctx, db: Database | undefined): string {
  const names = ctx.pd.networks.map((n) => n.name);
  const host = db?.hosts.map((h) => [...ctx.workloadById.values()].find((w) => w.name === h)).find(Boolean);
  const want = host ? networkForEnv(host.env) : 'prod';
  return names.includes(want) ? want : (names[0] ?? 'prod');
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function networksGrid(ctx: Ctx, networks: readonly NetworkDesign[]): string {
  return grid(networks.map((n) => [
    n.name,
    n.envs.join(' '),
    n.cidr,
    n.ipv6 ? (ctx.platform === 'azure' && n.ipv6Cidr ? n.ipv6Cidr : 'yes') : 'no',
    n.tiers.join(' '),
    String(Math.max(1, Math.min(3, networkZones(n).length || 1))),
  ]));
}

function subnetPrefix(pd: PlatformDesign): string {
  const p = pd.networks[0]?.subnets[0]?.cidr.split('/')[1];
  return p && Number(p) >= 20 && Number(p) <= 24 ? p : '22';
}

/** The compute grid's image key. */
function imageKey(t: ComputeTarget): string {
  if (t.image.kind === 'replicated') return 'replicated';
  if (t.image.kind === 'custom') return `var:${t.image.variable}`;
  const { note: _n, ...rest } = t.image as ComputeTarget['image'] & { note?: string };
  return renderImageRef(rest as GridImageRef);
}

function methodOf(ctx: Ctx, t: ComputeTarget): 'replicate' | 'rebuild' {
  if (t.method) return t.method;
  if (t.image.kind === 'replicated') return 'replicate';
  return ctx.decision.items[t.workload]?.method === 'replicate' ? 'replicate' : 'rebuild';
}

function zoneLetter(ctx: Ctx, t: ComputeTarget): string {
  const n = ctx.pd.networks.find((x) => x.name === t.network);
  const i = n ? networkZones(n).indexOf(t.zone) : -1;
  return ZONE_LETTERS[i >= 0 && i < 3 ? i : 0] ?? 'a';
}

function diskCell(ctx: Ctx, d: { gib: number; type: string }): string {
  const type = ctx.platform === 'oci' ? (d.type === 'higher-performance' ? 'higher' : d.type) : d.type;
  return `${type}:${d.gib}`;
}

function sizeCell(ctx: Ctx, t: ComputeTarget): string {
  if (ctx.platform === 'oci' && /\.Flex$/i.test(t.size)) {
    return `${t.size}:${t.ocpus ?? Math.max(1, Math.ceil(t.vcpu / 2))}:${t.ramGib}`;
  }
  return t.size;
}

function waveOf(ctx: Ctx, w: Workload | undefined): string {
  const wave = w ? ctx.appByName.get(w.app)?.wave : undefined;
  return wave === undefined ? '' : String(wave);
}

function computeRows(ctx: Ctx, rows: readonly ComputeTarget[]): string {
  return grid(rows.map((t) => {
    const w = ctx.workloadById.get(t.workload);
    const name = computeRowName(ctx.platform, w?.name ?? t.workload);
    return [
      name,
      w?.os ?? 'unknown',
      imageKey(t),
      sizeCell(ctx, t),
      (ctx.platform === 'aws' || ctx.platform === 'google') && t.coreCount !== undefined ? String(t.coreCount) : '',
      t.disks.map((d) => diskCell(ctx, d)).join(' '),
      t.network,
      t.tier,
      zoneLetter(ctx, t),
      licenceKeyOf(t, ctx.platform),
      t.backupTier,
      methodOf(ctx, t),
      w?.app ?? '',
      ctx.dbEngineOfHost.get(t.workload) ?? w?.role ?? '',
      w?.env ?? '',
      waveOf(ctx, w),
    ];
  }));
}

/** The vSphere grid: rebuilt rows cloned from templates (replicated and relocated VMs arrive through HCX). */
function vsphereRows(ctx: Ctx, rows: readonly ComputeTarget[]): string {
  return grid(rows.map((t) => {
    const w = ctx.workloadById.get(t.workload);
    return [
      w?.name ?? t.workload,
      w?.os ?? 'unknown',
      t.image.kind === 'vsphere-template' ? t.image.template : t.image.kind === 'custom' ? t.image.variable : '',
      String(t.vcpu),
      String(t.ramGib),
      t.disks.map((d) => String(d.gib)).join(' '),
      portGroup(ctx, t.network, t.tier),
      '',
      '',
      '',
      waveOf(ctx, w),
    ];
  }));
}

const portGroup = (ctx: Ctx, network: string, tier: string): string => `${ctx.pd.prefix}-${network}-${tier}`;

/** The engine cell per platform: the provider's own spelling where the blueprint wants it. */
function engineCell(ctx: Ctx, t: DbTarget, db: Database | undefined): string {
  const engine = db?.engine ?? 'postgres';
  switch (ctx.platform) {
    case 'aws': {
      if (t.service === 'aws-aurora') return engine === 'mysql' ? 'aurora-mysql' : 'aurora-postgresql';
      if (engine === 'oracle') return db?.edition === 'oracle-se2' ? 'oracle-se2' : 'oracle-ee';
      if (engine === 'sqlserver') {
        return ({ 'sql-enterprise': 'sqlserver-ee', 'sql-web': 'sqlserver-web', 'sql-express': 'sqlserver-ex' } as Record<string, string>)[db?.edition ?? ''] ?? 'sqlserver-se';
      }
      return engine;
    }
    case 'google': {
      if (/^(POSTGRES|MYSQL|SQLSERVER)_/.test(t.engineVersion)) return t.engineVersion;
      const major = /(\d+)/.exec(db?.version ?? '')?.[1] ?? '16';
      if (engine === 'mysql') return `MYSQL_${(/(\d+\.\d+)/.exec(db?.version ?? '')?.[1] ?? '8.0').replace('.', '_')}`;
      return `POSTGRES_${major}`;
    }
    default:
      return engine;
  }
}

function editionCell(ctx: Ctx, t: DbTarget, db: Database | undefined): string {
  if (ctx.platform === 'google') return 'enterprise';
  if (ctx.platform === 'oci') {
    if (db?.engine !== 'oracle') return '';
    if (t.ha === 'rac') return 'extreme-performance';
    return db.edition === 'oracle-se2' ? 'standard' : 'enterprise';
  }
  return db?.edition ?? '';
}

function versionCell(ctx: Ctx, t: DbTarget, db: Database | undefined): string {
  const id = db?.version ?? '';
  if (ctx.platform === 'azure' && (t.service === 'azure-sqldb' || t.service === 'azure-sqlmi' || t.service === 'azure-sqlvm')) return /(\d{4})/.exec(id)?.[1] ?? '';
  if (ctx.platform === 'google') return /(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? '';
  if (t.engineVersion) return t.engineVersion;
  return /(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? '';
}

/**
 * The Class cell: the design's `classOrShape` in the form the blueprint
 * reads. `ECPU-<n>` is written as `<n>`, `cpu-<n>` (AlloyDB) as is (the
 * blueprint takes the number), `Exadata.X11M` as `Exadata.X11M:<cores>` on
 * OCI; the rest (`BC_Gen5_8`, `VM.Standard.E5.Flex:<ocpus>`,
 * `PostgreSQL.VM.Standard.E5.Flex:<ocpus>`, `MySQL.<n>`, RDS classes, Cloud
 * SQL tiers, flexible-server SKUs) are already the blueprint's own.
 */
export function classCell(platform: Platform, t: Pick<DbTarget, 'classOrShape' | 'service'>, db?: Pick<Database, 'vcpu'>): string {
  const c = t.classOrShape.trim();
  const ecpu = /^ECPU-(\d+)$/i.exec(c);
  if (ecpu) return ecpu[1]!;
  if (platform === 'oci' && /^Exadata\./.test(c) && !c.includes(':')) return `${c}:${Math.max(4, Math.ceil((db?.vcpu ?? 8) / 2))}`;
  return c;
}

/** The HA cell: the grid's own values; a source pattern on IaaS reads as a standby. */
function haCell(ctx: Ctx, t: DbTarget): string {
  if (HA_GRID.has(t.ha)) return t.ha;
  if (t.ha === 'rac') return ctx.platform === 'oci' ? 'regional' : 'standby';
  return t.ha === '' ? 'none' : 'standby';
}

function licenceCell(ctx: Ctx, t: DbTarget): string {
  const m = t.licenceModel.toLowerCase();
  if (ctx.platform === 'azure') return /baseprice|ahub|ahb/.test(m) ? 'ahb' : 'li';
  return /bring|byol/.test(m) ? 'byol' : 'li';
}

function retentionOf(ctx: Ctx, tier: string): string {
  return String(ctx.pd.backup.tiers.find((b) => b.tier === tier)?.retentionDays ?? 7);
}

/** Services that go to the Oracle Database@ blueprint instead of the databases grid. */
function toOracleAt(t: DbTarget): boolean {
  if (t.service === 'aws-odb-exadata' || t.service === 'aws-odb-adb' || t.service === 'azure-odb-exadata' || t.service === 'azure-odb-adb') return true;
  if (t.service === 'google-odb-exadata' || t.service === 'google-odb-adb') return true;
  // RAC is never a databases-grid row off OCI: a RAC Base Database on Google Cloud becomes an Exadata VM cluster.
  return t.service === 'google-odb-basedb' && t.ha === 'rac';
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function item(ctx: Ctx, key: string, blueprintId: string, label: string, values: Record<string, string>): StackItem {
  return { id: `${ctx.platform}:${key}`, blueprintId, label, values };
}

/** Add an item whose blueprint may not exist yet: only when the lookup has it, values limited to its inputs. */
function optional(ctx: Ctx, key: string, blueprintId: string, label: string, values: Record<string, string>): StackItem | null {
  const bp = ctx.lookup(blueprintId);
  if (!bp) return null;
  return item(ctx, key, blueprintId, label, declared(bp, values));
}

function landingZoneItem(ctx: Ctx, pd: PlatformDesign, delegations: string): StackItem | null {
  if (ctx.platform === 'vmware' || pd.networks.length === 0) return null;
  const values: Record<string, string> = {
    prefix: pd.prefix,
    region: pd.region,
    networks: networksGrid(ctx, pd.networks),
    subnet_prefix: subnetPrefix(pd),
    site_cidrs: siteCidrs(ctx.plan).join(' '),
    bastion: pd.bastion,
    log_retention_days: String(pd.logRetentionDays),
    keys: ctx.plan.requirements.keys,
    scope: pd.scope ?? '',
  };
  if (ctx.platform === 'azure') values.delegations = delegations;
  return item(ctx, 'landing-zone', `${ctx.bp}_mig_landing_zone`, 'Landing zone', values);
}

/** The on-premises domain controllers' addresses (the plan's ad-dc rows), which DNS forwarding sends the domain to. */
function onPremDcAddresses(plan: Plan): string[] {
  const out = plan.workloads.filter((w) => w.role === 'ad-dc').flatMap((w) => w.facts?.ipAddresses ?? []).filter((a) => familyOf(a) !== null);
  return [...new Set(out)];
}

function identityItem(ctx: Ctx): StackItem | null {
  const { platform, pd, plan } = ctx;
  if (platform === 'vmware' || platform === 'oci') return null;
  const strategy = pd.identity.strategy;
  if (strategy === 'none') return null;
  const domain = plan.requirements.identity.domain?.trim() || 'corp.example.com';
  const values: Record<string, string> = { domain, network: 'prod', landing_zone_source: lzSource(ctx) };
  if (strategy === 'managed-ad') {
    values.strategy = 'managed-ad';
    if (platform === 'aws' || platform === 'azure') values.edition = 'Enterprise';
    if (platform === 'google') {
      const range = freeBlock(ctx.used, 24, 99);
      if (range) {
        values.reserved_ip_range = range;
        ctx.used.push(range);
      }
    }
  } else {
    const dcs = onPremDcAddresses(plan);
    if (dcs.length === 0) {
      ctx.findings.push(warning('plan.tf.identity-no-dc-addresses', `${PLATFORM_LABELS[platform]}: DNS forwarding to the domain controllers needs their addresses, and no ad-dc workload has one, so the identity item is left out.`, {
        remediation: 'Give the domain controllers\' addresses in the inventory (or add the Identity item on the Terraform page with them).',
      }));
      return null;
    }
    values.strategy = 'resolver-only';
    values.dns_forwarders = dcs.join(' ');
  }
  return item(ctx, 'identity', `${ctx.bp}_mig_identity`, 'Identity', values);
}

function connectivityItem(ctx: Ctx): StackItem | null {
  const { platform, pd, plan } = ctx;
  if (platform === 'vmware' || pd.connectivity.length === 0) return null;
  const rows = pd.connectivity.map((c) => {
    const site = plan.requirements.sites.find((s) => s.name === c.site);
    return [c.site, site?.vpnPeer ?? '', site?.bgpAsn ?? '', (site?.cidrs ?? []).join(' '), c.method, ''];
  });
  const values: Record<string, string> = {
    sites: grid(rows),
    cloud_asn: String(pd.connectivity[0]?.cloudAsn ?? ''),
    landing_zone_source: lzSource(ctx),
  };
  if (platform === 'aws') values.gateway = pd.networks.length >= 2 ? 'transit-gateway' : 'vpn-gateway';
  if (platform === 'azure' || platform === 'google') values.network = 'prod';
  return item(ctx, 'connectivity', `${ctx.bp}_mig_connectivity`, 'Connectivity', values);
}

function governanceItem(ctx: Ctx): StackItem | null {
  const req = ctx.plan.requirements;
  return optional(ctx, 'governance', `${ctx.bp}_mig_governance`, 'Governance', {
    prefix: ctx.pd.prefix,
    region: ctx.pd.region,
    frameworks: req.frameworks.join(' '),
    security_baseline: req.securityBaseline,
    keys: req.keys,
    sovereignty: req.sovereignty,
    residency: req.defaultResidency,
    landing_zone_source: lzSource(ctx),
  });
}

function computeItem(ctx: Ctx): StackItem | null {
  const { platform } = ctx;
  if (platform === 'vmware') {
    const rebuild = ctx.compute.filter((t) => methodOf(ctx, t) === 'rebuild');
    const replicated = ctx.compute.filter((t) => methodOf(ctx, t) === 'replicate');
    if (replicated.length > 0) {
      ctx.manual.push(`Replicated into VCF (HCX or vSphere Replication, not Terraform): ${replicated.map((t) => ctx.workloadById.get(t.workload)?.name ?? t.workload).join(', ')}.`);
    }
    if (rebuild.length === 0) return null;
    const o = (field: string): string | undefined => ctx.plan.designOverrides[overrideKey('vmware', 'lz', field)]?.trim() || undefined;
    const values: Record<string, string> = {
      vms: vsphereRows(ctx, rebuild),
      domain: ctx.plan.requirements.identity.domain?.trim() || 'corp.example.com',
      dns_servers: onPremDcAddresses(ctx.plan).join(' '),
    };
    const server = ctx.pd.region.trim();
    if (server) values.vsphere_server = server;
    for (const [field, id] of [['datacenter', 'datacenter'], ['cluster', 'cluster'], ['folder', 'folder']] as const) {
      const v = o(field);
      if (v) values[id] = v;
    }
    const datastore = o('datastore');
    const policy = o('storage-policy');
    if (datastore) values.datastore_or_policy = policy ? `${datastore} policy:${policy}` : datastore;
    if (!o('datacenter') || !o('cluster') || !datastore) {
      ctx.findings.push(warning('plan.tf.vsphere-placement', 'VCF: the datacenter, cluster or datastore is not set on the landing-zone card, so the VMs item uses its defaults; set them before applying.', {
        path: overrideKey('vmware', 'lz', 'datacenter'),
      }));
    }
    const groups = [...new Set(rebuild.map((t) => portGroup(ctx, t.network, t.tier)))];
    ctx.manual.push(`The port groups (or NSX segments) the VMs attach to must exist before apply: ${groups.join(', ')}. Build them with the Tier-1 gateway + overlay segments blueprint on the Terraform page, or name existing ones in the VMs grid.`);
    return item(ctx, 'compute', 'vsphere_mig_vms', 'VMs', values);
  }
  if (ctx.compute.length === 0) return null;
  for (const t of ctx.compute) {
    const name = ctx.workloadById.get(t.workload)?.name ?? t.workload;
    if (platform === 'google' && computeRowName(platform, name) !== name) {
      ctx.findings.push(info('plan.tf.google-vm-name', `${name} is written as ${computeRowName(platform, name)}: a Compute Engine name is lowercase letters, digits and hyphens.`));
    }
  }
  return item(ctx, 'compute', `${ctx.bp}_mig_compute`, 'Compute', { vms: computeRows(ctx, ctx.compute), landing_zone_source: lzSource(ctx) });
}

/** The databases-grid rows (managed services, and SQL Server on Azure VMs). */
function databaseRows(ctx: Ctx): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const t of ctx.databases) {
    const db = ctx.dbById.get(t.database);
    const name = db?.name ?? t.database;
    if (toOracleAt(t)) continue;
    if (t.service === 'google-odb-basedb') {
      ctx.manual.push(`${name}: Base Database on Oracle Database@Google Cloud (google_oracle_database_db_system) is not in Terraform here; create it in the console or with gcloud oracle-database, on the ODB network, before the data move.`);
      continue;
    }
    if (t.service === 'azure-sqlvm') {
      // One row per host VM: the row's name is the compute row it registers.
      for (const h of t.hosts ?? []) {
        const host = ctx.workloadById.get(h)?.name ?? h;
        if (rname(host) !== host) {
          ctx.findings.push(warning('plan.tf.sqlvm-name', `${host}: the SQL Server VM row is keyed by the VM's name, which the databases grid lower-cases; rename the workload to lowercase letters, digits and hyphens.`));
        }
        rows.push([host, t.service, 'sqlserver', db?.edition ?? '', versionCell(ctx, t, db), '', t.storageGib, haCell(ctx, t), licenceCell(ctx, t), retentionOf(ctx, t.backupTier), dbNetwork(ctx, db), db?.app ?? '']);
      }
      if (t.ha !== 'none' && (t.hosts?.length ?? 0) > 1) {
        ctx.manual.push(`${name}: the SQL Server availability group and its listener across ${(t.hosts ?? []).map((h) => ctx.workloadById.get(h)?.name ?? h).join(', ')} are built by Ansible (the mssql_ag role, playbooks/32-sqlserver-ag.yml) with the vaulted domain credentials, not by Terraform.`);
      }
      continue;
    }
    if (isIaasService(t.service)) {
      if (t.ha === 'rac' && ctx.platform !== 'oci' && ctx.platform !== 'vmware') {
        ctx.findings.push(warning('plan.tf.rac-on-vms', `${name}: Oracle RAC does not run on ${CLOUD_NAME[ctx.platform]} VMs; move it to Oracle Database@${CLOUD_NAME[ctx.platform]} (Exadata) or run it as a single instance with Data Guard.`));
      }
      continue;
    }
    if (t.service === 'azure-sqlmi' && ctx.pd.drRegion) {
      ctx.manual.push(`${name}: the SQL Managed Instance failover group to ${ctx.pd.drRegion} is not in Terraform here; create the secondary instance there and the failover group (az sql instance-failover-group create) once both exist.`);
    }
    rows.push([
      name, t.service, engineCell(ctx, t, db), editionCell(ctx, t, db), versionCell(ctx, t, db), classCell(ctx.platform, t, db),
      t.storageGib, haCell(ctx, t), licenceCell(ctx, t), retentionOf(ctx, t.backupTier), dbNetwork(ctx, db), db?.app ?? '',
    ]);
  }
  return rows;
}

function databasesItem(ctx: Ctx, rows: readonly (string | number)[][]): StackItem | null {
  if (ctx.platform === 'vmware' || rows.length === 0) return null;
  return item(ctx, 'databases', `${ctx.bp}_mig_databases`, 'Databases', { databases: grid(rows), landing_zone_source: lzSource(ctx) });
}

function oracleAtItem(ctx: Ctx): StackItem | null {
  const { platform } = ctx;
  if (platform !== 'aws' && platform !== 'azure' && platform !== 'google') return null;
  const targets = ctx.databases.filter(toOracleAt);
  if (targets.length === 0) return null;
  const dbs = targets.map((t) => ({ t, db: ctx.dbById.get(t.database) }));
  const exadata = dbs.filter(({ t }) => !t.service.endsWith('-adb'));
  const shape = dbs.map(({ t }) => t.classOrShape).find((c) => /^Exadata\./.test(c)) ?? 'Exadata.X11M';
  const cores = exadata.reduce((s, { db }) => s + Math.max(2, Math.ceil((db?.vcpu ?? 8) / 2)), 0);
  const values: Record<string, string> = {
    exadata_shape: shape,
    compute_count: '2',
    storage_count: '3',
    vm_cluster_cores: String(Math.max(4, Math.ceil(cores / 2) * 2)),
    databases: exadata.map(({ t, db }) => rname(db?.name ?? t.database)).join(' '),
    create_databases: exadata.length > 0 ? 'yes' : 'no',
    licence: dbs.some(({ t }) => /BRING/.test(t.licenceModel)) ? 'BRING_YOUR_OWN_LICENSE' : 'LICENSE_INCLUDED',
    network: dbNetwork(ctx, dbs[0]?.db),
    landing_zone_source: lzSource(ctx),
  };
  const ociRegion = ctx.plan.requirements.regions.oci?.primary?.trim();
  if (ociRegion) values.oci_region_name = ociRegion;
  else {
    ctx.findings.push(info('plan.tf.odb-oci-region', `Oracle Database@${CLOUD_NAME[platform]}: the OCI region paired with ${ctx.pd.region} is not set, so the item's default is used; set it before applying.`));
  }
  if (platform !== 'azure') {
    const cidr = freeBlock(ctx.used, 24, 60);
    if (cidr) {
      values.odb_network_cidr = cidr;
      ctx.used.push(cidr);
    }
  }
  if (platform === 'aws') {
    ctx.findings.push(info('plan.tf.odb-zone-id', `Oracle Database@AWS: check that the availability zone id in the item is one where it is offered in ${ctx.pd.region}.`));
  }
  const label = platform === 'aws' ? 'Oracle Database@AWS' : platform === 'azure' ? 'Oracle Database@Azure' : 'Oracle Database@Google Cloud';
  return item(ctx, 'oracle-database-at', `${ctx.bp}_mig_oracle_database`, label, values);
}

function backupGrid(ctx: Ctx): string {
  return grid(ctx.pd.backup.tiers.map((t) => [t.tier, t.frequency, String(t.retentionDays), t.copyToDr ? 'yes' : 'no', t.immutable ? 'yes' : 'no']));
}

function backupItem(ctx: Ctx, hasCompute: boolean, hasDatabases: boolean): StackItem | null {
  const { platform } = ctx;
  if (platform === 'vmware' || ctx.pd.backup.tiers.length === 0) return null;
  const id = `${ctx.bp}_mig_backup`;
  const bp = ctx.lookup(id);
  const scoped = !!bp?.inputs.some((i) => i.id === 'scope');
  if (ctx.scope === 'landing-zone') {
    // Azure, Google Cloud and OCI back up the compute blueprint's VMs, so without them only a scoped backup item stands.
    if (!scoped && platform !== 'aws') return null;
  } else if (platform === 'aws' ? !hasCompute && !hasDatabases : !hasCompute) {
    return null;
  }
  const values: Record<string, string> = { tiers: backupGrid(ctx), dr_region: ctx.pd.drRegion ?? '', landing_zone_source: lzSource(ctx) };
  if (scoped) values.scope = ctx.scope === 'landing-zone' ? 'landing-zone' : ctx.shared ? 'workloads' : 'landing-zone';
  return item(ctx, 'backup', id, 'Backup', values);
}

function monitoringItem(ctx: Ctx, hasCompute: boolean): StackItem | null {
  if (ctx.platform === 'vmware' || !hasCompute || ctx.plan.requirements.monitoring === 'vcf-operations') return null;
  return item(ctx, 'monitoring', `${ctx.bp}_mig_monitoring`, 'Monitoring', {
    siem: ctx.plan.requirements.siem,
    retention_days: String(ctx.pd.logRetentionDays),
    landing_zone_source: lzSource(ctx),
  });
}

const RELOCATE_BLUEPRINT: Readonly<Partial<Record<Platform, { id: string; label: string; prefix: number }>>> = {
  azure: { id: 'azure_mig_avs', label: 'Azure VMware Solution', prefix: 22 },
  google: { id: 'google_mig_gcve', label: 'Google Cloud VMware Engine', prefix: 22 },
  oci: { id: 'oci_mig_ocvs', label: 'Oracle Cloud VMware Solution', prefix: 21 },
};

function relocateItem(ctx: Ctx): StackItem | null {
  const { platform, pd } = ctx;
  if (!pd.relocate || pd.relocate.nodes <= 0) return null;
  if (platform === 'aws') {
    ctx.manual.push(`Amazon Elastic VMware Service (${pd.relocate.nodes} hosts, estimated): there is no Terraform resource for it in the AWS provider used here, so the environment is built from the runbook, then HCX moves the relocating VMs.`);
    return null;
  }
  const r = RELOCATE_BLUEPRINT[platform];
  if (!r) return null;
  const bp = ctx.lookup(r.id);
  const host = RELOCATE_HOSTS[platform].host.toLowerCase();
  const sku = bp?.inputs.find((i) => i.id === 'sku_name')?.options?.find((o) => o.value.toLowerCase() === host)?.value;
  const nodes = Math.min(16, Math.max(3, pd.relocate.nodes));
  if (nodes !== pd.relocate.nodes) {
    ctx.findings.push(info('plan.tf.relocate-nodes', `${pd.relocate.service}: the estimate of ${pd.relocate.nodes} hosts is written as ${nodes}, the range the first cluster takes; size it properly on the VCF Sizing page.`));
  }
  const values: Record<string, string> = {
    ...(sku ? { sku_name: sku } : {}),
    node_count: String(nodes),
    network: 'prod',
    landing_zone_source: lzSource(ctx),
  };
  const cidr = freeBlock(ctx.used, r.prefix, 200);
  if (cidr) {
    values.management_cidr = cidr;
    ctx.used.push(cidr);
  }
  if (platform === 'oci') {
    values.workload_hosts = '0';
    if (ctx.plan.requirements.licensing.portableVcf) {
      ctx.findings.push(info('plan.tf.ocvs-byol', 'OCVS with portable VCF: give the subscription allocation OCID in the relocate item (vcf_byol_allocation_id).'));
    }
  }
  return item(ctx, 'relocate', r.id, r.label, values);
}

function replicationItem(ctx: Ctx, rows: string): StackItem | null {
  const replicated = ctx.compute.filter((t) => methodOf(ctx, t) === 'replicate');
  const managed = ctx.databases.filter((t) => !isIaasService(t.service) && ctx.decision.items[t.database]?.method === 'managed-db');
  if (replicated.length === 0 && managed.length === 0) return null;
  return optional(ctx, 'replication', `${ctx.bp}_mig_replication`, 'Replication', {
    vms: computeRows(ctx, replicated),
    databases: rows,
    region: ctx.pd.region,
    dr_region: ctx.pd.drRegion ?? '',
    landing_zone_source: lzSource(ctx),
  });
}

/** The apps whose app items go in this platform's stack, with their components. */
function appsHere(ctx: Ctx, options: PlanToStacksOptions): { app: App; components: readonly AppComponentLike[] }[] {
  if (ctx.scope === 'landing-zone') return [];
  const wanted = options.apps && options.apps.length > 0 ? new Set(options.apps) : null;
  const plans = new Map(appPlansOf(ctx.plan).map((p) => [p.app, p]));
  const out: { app: App; components: readonly AppComponentLike[] }[] = [];
  for (const app of ctx.plan.apps) {
    if (wanted && !wanted.has(app.id) && !wanted.has(app.name)) continue;
    const ap = plans.get(app.id);
    const platform = ap?.platform ?? ap?.recommendation?.platform;
    const components = ap && platform === ctx.platform ? (ap.variants?.[ctx.platform] ?? []) : [];
    if (ctx.scope === 'estate') {
      // The estate stack carries an app's own items only once its plan is saved.
      if (!ap || ap.status === 'draft' || platform !== ctx.platform || components.length === 0) continue;
      out.push({ app, components });
      continue;
    }
    // apps scope: every selected app with something on this platform.
    const here = ctx.compute.some((t) => ctx.workloadById.get(t.workload)?.app === app.name)
      || ctx.databases.some((t) => ctx.dbById.get(t.database)?.app === app.name)
      || components.length > 0;
    if (here) out.push({ app, components });
  }
  return out;
}

function defaultPatternBlueprint(bp: string): (c: AppComponentLike) => string | undefined {
  return (c) => c.settings?.blueprint?.trim() || (c.tierPattern ? `${bp}_app_${c.tierPattern.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}` : undefined);
}

function appItems(ctx: Ctx, options: PlanToStacksOptions): { head: StackItem[]; monitoring: StackItem[] } {
  const head: StackItem[] = [];
  const monitoring: StackItem[] = [];
  const patternId = options.patternBlueprint ? (c: AppComponentLike) => options.patternBlueprint!(c, ctx.platform) : defaultPatternBlueprint(ctx.bp);
  for (const { app, components } of appsHere(ctx, options)) {
    const slug = slugName(app.name) || app.id;
    const common = { app: app.name, criticality: app.criticality, owner: app.owner ?? '', landing_zone_source: lzSource(ctx) };
    const context = optional(ctx, `app:${slug}:context`, `${ctx.bp}_app_context`, `${app.name} context`, common);
    if (context) head.push(context);
    for (const c of components.filter((x) => x.kind === 'pattern')) {
      const id = patternId(c);
      const bp = id ? ctx.lookup(id) : undefined;
      if (!id || !bp) {
        ctx.findings.push(info('plan.tf.pattern-not-generated', `${app.name}: the ${c.name} component (${c.tierPattern ?? 'pattern'}) has no Terraform blueprint on ${PLATFORM_LABELS[ctx.platform]} yet, so it is not in the stack.`));
        continue;
      }
      head.push({ id: c.id, blueprintId: id, label: `${app.name} ${c.name}`, values: declared(bp, { ...(c.settings ?? {}), ...common }) });
    }
    for (const c of components.filter((x) => x.kind === 'resource')) {
      if (!c.blueprintId || !ctx.lookup(c.blueprintId)) {
        ctx.findings.push(error('plan.tf.resource-component-unknown', `${app.name}: the ${c.name} component's blueprint ${c.blueprintId ?? '(none)'} is not one the Terraform page has, so it is not in the stack.`));
        continue;
      }
      head.push({ id: c.id, blueprintId: c.blueprintId, label: `${app.name} ${c.name}`, values: { ...(c.values ?? {}) } });
    }
    const mon = optional(ctx, `app:${slug}:monitoring`, `${ctx.bp}_app_monitoring`, `${app.name} monitoring`, common);
    if (mon) monitoring.push(mon);
  }
  return { head, monitoring };
}

/** Azure's delegated subnets: one per managed service (and directory or resolver) that needs one. */
function azureDelegations(ctx: Ctx, identity: StackItem | null, oracleAt: StackItem | null): string {
  const rows: string[][] = [];
  const add = (network: string, kind: string): void => {
    if (!rows.some((r) => r[0] === network && r[1] === kind)) rows.push([network, kind, '']);
  };
  for (const t of ctx.databases) {
    const kind = t.service === 'azure-sqlmi' ? 'sqlmi' : t.service === 'azure-pg-flex' ? 'postgres' : t.service === 'azure-mysql-flex' ? 'mysql' : undefined;
    if (kind) add(dbNetwork(ctx, ctx.dbById.get(t.database)), kind);
  }
  if (oracleAt) add(oracleAt.values.network as string, 'oracle');
  if (identity) add('prod', identity.values.strategy === 'managed-ad' ? 'aadds' : 'dns-resolver');
  return grid(rows);
}

/** Does a stack carry a write-only argument (Terraform 1.11)? Cloud SQL for SQL Server and AlloyDB passwords, Azure MySQL flexible server. */
export function needsWriteOnly(items: readonly StackItem[]): boolean {
  return items.some((i) => {
    const text = String(i.values.databases ?? '');
    if (i.blueprintId === 'google_mig_databases') return /\|\s*google-alloydb\s*\|/.test(text) || /\|\s*SQLSERVER_/i.test(text);
    if (i.blueprintId === 'azure_mig_databases') return /\|\s*azure-mysql-flex\s*\|/.test(text);
    return false;
  });
}

// ---------------------------------------------------------------------------
// The DR region
// ---------------------------------------------------------------------------

function drStack(ctx: Ctx, backend: Exclude<BackendKind, 'none'>): PlatformStack | null {
  const { pd, platform, plan } = ctx;
  if (platform === 'vmware' || !pd.drRegion || ctx.scope === 'apps') return null;
  const prod = pd.networks.find((n) => n.name === 'prod') ?? pd.networks[0];
  if (!prod) return null;
  const key = overrideKey(platform, 'network-prod-dr', 'cidr');
  const cidr = plan.designOverrides[key]?.trim() || freeBlock(ctx.used, 16, NETWORK_BASE[platform] + 100);
  if (!cidr) {
    ctx.findings.push(error('plan.tf.dr-no-range', `${PLATFORM_LABELS[platform]}: no free /16 is left in 10.0.0.0/8 for the DR network.`, { path: key }));
    return null;
  }
  ctx.used.push(cidr);
  // No IPv6 range is carried over: Azure's DR range is derived by the blueprint from the DR prefix.
  const { ipv6Cidr: _v6, ...rest } = prod;
  const drNetwork: NetworkDesign = {
    ...rest,
    envs: ['dr'],
    cidr,
    subnets: prod.subnets.filter((s) => (prod.tiers as readonly string[]).includes(s.tier)).map(({ ipv6Cidr: _s, ...s }) => s),
  };
  const drDesign: PlatformDesign = { ...pd, prefix: `${pd.prefix}-dr`, region: pd.drRegion, networks: [drNetwork] };
  const lz = landingZoneItem({ ...ctx, pd: drDesign }, drDesign, '');
  if (!lz) return null;
  return {
    platform,
    folder: `${platform}-dr`,
    items: [{ ...lz, id: `${platform}-dr:landing-zone` }],
    stackName: `${plan.name}: ${PLATFORM_LABELS[platform]} DR (${pd.drRegion})`,
    target: TARGET[platform],
    requiredVersion: REQUIRED_VERSION,
    backend,
    manual: [],
    dr: true,
  };
}

// ---------------------------------------------------------------------------
// planToStacks
// ---------------------------------------------------------------------------

/**
 * The stack items per platform in the design, and per DR region, with the
 * values the Terraform page would save for them. Nothing is built here.
 */
export function planToStacks(plan: Plan, decision: PlanDecision, design: TargetDesign, options: PlanToStacksOptions = {}): PlanStacks {
  const findings: Finding[] = [];
  const perPlatform: Partial<Record<Platform, PlatformStack>> = {};
  const dr: Partial<Record<Platform, PlatformStack>> = {};
  const scope = options.scope ?? 'estate';
  if (options.landingZone === 'shared' && scope !== 'apps') {
    findings.push(info('plan.tf.shared-lz-scope', 'A shared landing zone applies to app stacks only; this stack carries its own.'));
  }
  const used: string[] = [
    ...design.platforms.flatMap((p) => p.networks.map((n) => n.cidr)),
    ...plan.requirements.sites.flatMap((s) => s.cidrs),
  ];
  const ordered = PLATFORM_VALUES.flatMap((p) => design.platforms.filter((d) => d.platform === p));
  for (const pd of ordered) {
    const platform = pd.platform;
    const ctx = contextFor(plan, decision, design, pd, options, used, findings);
    const withLz = scope !== 'apps' || !ctx.shared;
    const withWorkloads = scope !== 'landing-zone';

    const identity = withLz ? identityItem(ctx) : null;
    const connectivity = withLz ? connectivityItem(ctx) : null;
    const governance = withLz && platform !== 'vmware' ? governanceItem(ctx) : null;
    const compute = withWorkloads ? computeItem(ctx) : null;
    const dbRows = withWorkloads ? databaseRows(ctx) : [];
    const databases = withWorkloads ? databasesItem(ctx, dbRows) : null;
    const oracleAt = withWorkloads ? oracleAtItem(ctx) : null;
    const app = withWorkloads ? appItems(ctx, options) : { head: [], monitoring: [] };
    const hasCompute = !!compute && platform !== 'vmware';
    const backup = backupItem(ctx, hasCompute, !!databases || !!oracleAt);
    const monitoring = withWorkloads ? monitoringItem(ctx, hasCompute) : null;
    const relocate = scope !== 'apps' ? relocateItem(ctx) : null;
    const replication = withWorkloads && platform !== 'vmware' ? replicationItem(ctx, grid(dbRows)) : null;
    if (scope === 'apps' && !compute && !databases && !oracleAt && app.head.length === 0 && app.monitoring.length === 0) {
      // Nothing of the selected apps lands here: no stack, not even a landing zone.
      continue;
    }
    const lz = withLz ? landingZoneItem(ctx, pd, platform === 'azure' ? azureDelegations(ctx, identity, oracleAt) : '') : null;

    const items = [lz, identity, connectivity, governance, compute, databases, oracleAt, ...app.head, backup, monitoring, ...app.monitoring, relocate, replication]
      .filter((i): i is StackItem => i !== null);
    if (items.length === 0) {
      findings.push(info('plan.tf.empty-platform', `${PLATFORM_LABELS[platform]}: nothing in this plan is built by Terraform there, so there is no stack for it.`));
      continue;
    }
    const backend = backendFor(platform, plan.generate?.backend);
    if (ctx.shared) {
      ctx.manual.push(`This stack reads the landing zone of the landing-zone project: terraform -chdir=<landing-zone project>/terraform/${platform} output -json landing_zone | jq '{landing_zone: .}' > landing_zone.auto.tfvars.json`);
    }
    perPlatform[platform] = {
      platform,
      folder: platform,
      items,
      stackName: `${plan.name}: ${PLATFORM_LABELS[platform]}`,
      target: TARGET[platform],
      requiredVersion: needsWriteOnly(items) ? REQUIRED_VERSION_WRITE_ONLY : REQUIRED_VERSION,
      backend,
      manual: ctx.manual,
    };
    const d = drStack(ctx, backend);
    if (d) dr[platform] = d;
  }
  return { perPlatform, dr, findings };
}

// ---------------------------------------------------------------------------
// terraformFiles
// ---------------------------------------------------------------------------

/** The sensitive variables a stack declares: supplied as TF_VAR_<name>, never written. */
export function sensitiveVariables(variablesTf: string): string[] {
  const out: string[] = [];
  for (const m of variablesTf.matchAll(/variable "([^"]+)" \{([\s\S]*?)\n\}/g)) {
    if (/^\s*sensitive\s*=\s*true\s*$/m.test(m[2] ?? '')) out.push(m[1]!);
  }
  return out;
}

const SIGN_IN: Readonly<Record<Platform, string>> = {
  aws: 'AWS: a profile or SSO session (`aws sso login`), or the AWS_* environment variables.',
  azure: 'Azure: `az login` (or the ARM_* environment variables for a service principal or managed identity).',
  google: 'Google Cloud (GCP): `gcloud auth application-default login`, or a workload identity.',
  oci: 'OCI: an API key profile in ~/.oci/config, or instance / resource principal authentication.',
  vmware: 'VCF: TF_VAR_vsphere_user and TF_VAR_vsphere_password for the vCenter account.',
};

function readme(stack: PlatformStack, files: Readonly<Record<string, string>>): string {
  const secrets = sensitiveVariables(files['variables.tf'] ?? '');
  const itemFiles = Object.keys(files).filter((f) => /^\d\d-.*\.tf$/.test(f)).sort();
  const compute = stack.items.some((i) => /_mig_compute$/.test(i.blueprintId));
  const lines = [
    `# ${stack.stackName}`,
    '',
    stack.dr
      ? `The landing zone in the DR region, as a root module of its own: what warm-standby and pilot-light recovery restore into, and where backup copies land. It applies as generated.`
      : `The Terraform root module for ${PLATFORM_LABELS[stack.platform]}, stacked from the migration plan. It applies as generated.`,
    '',
    '## What is in it',
    '',
    ...itemFiles.map((f, i) => `${i + 1}. \`${f}\` — ${stack.items[i]?.label ?? ''} (${stack.items[i]?.blueprintId ?? ''})`),
    '',
    '- `versions.tf`, `providers.tf`, `variables.tf`, `outputs.tf`: shared by every item.',
    ...(files['terraform.tfvars.example'] ? ['- `terraform.tfvars.example`: copy to `terraform.tfvars` and fill in the required values (no secrets go there).'] : []),
    '- `cutover.auto.tfvars.example`: the replicated VMs to adopt after cutover.',
    '- `archtoolkit-terraform-settings.json`: open it on the Terraform page to see and edit this same stack.',
    '',
    '## Before you apply',
    '',
    `- Sign in: ${SIGN_IN[stack.platform]}`,
    ...(stack.backend && stack.backend !== 'local' ? ['- State: `versions.tf` has a remote backend; fill in its CHANGE-ME values (or pass them with `terraform init -backend-config=...`).'] : []),
    ...(files['terraform.tfvars.example'] ? ['- Values: `cp terraform.tfvars.example terraform.tfvars` and fill it in.'] : []),
    '',
    '## Apply',
    '',
    '```sh',
    'terraform init',
    ...secrets.map((s) => `export TF_VAR_${s}="<from your vault>"`),
    'terraform apply',
    '```',
    '',
    ...(secrets.length > 0
      ? ['Credentials are never written into these files: each one above is a sensitive variable, read from your vault into the environment for the run.', '']
      : ['Credentials are never written into these files.', '']),
    ...(compute
      ? [
        '## After cutover',
        '',
        'Once the replication tool has launched the replicated VMs, list them in `cutover.auto.tfvars` (copy the example) — or let the cutover',
        'orchestrator write `cutover.auto.tfvars.json`, which Terraform loads the same way — and apply again:',
        '',
        '```sh',
        'terraform apply',
        '```',
        '',
        'The `import` blocks adopt them with their tags, size and backup tier. With the map empty, nothing is adopted and the apply is clean.',
        '',
      ]
      : []),
    ...(stack.manual.length > 0 ? ['## Not done by Terraform', '', ...stack.manual.map((m) => `- ${m}`), ''] : []),
  ];
  return `${lines.join('\n')}`;
}

function cutoverExample(stack: PlatformStack): string {
  const computeItem = stack.items.find((i) => /_mig_compute$/.test(i.blueprintId));
  if (!computeItem) {
    return `# ${stack.dr ? 'The DR landing zone' : 'This stack'} builds no VMs, so there is nothing to adopt after cutover.\n`;
  }
  const replicated = String(computeItem.values.vms ?? '')
    .split('\n')
    .map((l) => l.split(' | '))
    .filter((c) => (c[11] ?? '').trim() === 'replicate')
    .map((c) => (c[0] ?? '').trim());
  return [
    '# Replicated VMs to adopt after cutover: the name in the compute grid = the id the replication tool launched it as.',
    '# Copy to cutover.auto.tfvars (or let the cutover orchestrator write cutover.auto.tfvars.json), then terraform apply.',
    'cutover_instance_ids = {',
    ...(replicated.length > 0 ? replicated.map((n) => `  # "${n}" = ""`) : ['  # none: every VM in this stack is rebuilt']),
    '}',
    '',
  ].join('\n');
}

/** The Terraform page's envelope for a stack. `savedAt` is the plan's, so the file is reproducible. */
export function stackEnvelope(plan: Plan, stack: PlatformStack): PlanTerraformEnvelope {
  const first = stack.items[0];
  const body = {
    target: stack.target as TerraformSettingsEnvelope['target'],
    blueprint: first?.blueprintId ?? '',
    values: { ...((first?.values ?? {}) as Record<string, string>) },
    stackName: stack.stackName,
    stack: stack.items.map((i) => ({ id: i.id, blueprintId: i.blueprintId, label: i.label, values: { ...(i.values as Record<string, string>) } })),
    requiredVersion: stack.requiredVersion,
    ...(stack.backend ? { backend: stack.backend } : {}),
  };
  return { ...envelope('archtoolkit.terraform-generator', body as unknown as Record<string, Json>), savedAt: plan.savedAt } as unknown as PlanTerraformEnvelope;
}

/** Build one stack into its files, under `terraform/<folder>/`. */
function stackFiles(plan: Plan, stack: PlatformStack, lookup: BlueprintLookup, findings: Finding[]): { files: Record<string, string>; stack: PlatformStack } {
  let s = stack;
  let built = buildStack(s.items, lookup, { target: s.target, stackName: s.stackName, requiredVersion: s.requiredVersion, ...(s.backend ? { backend: s.backend } : {}) });
  const writeOnly = Object.entries(built.files).some(([f, t]) => f.endsWith('.tf') && /^\s*\w+_wo\s*=/m.test(t));
  if (writeOnly && s.requiredVersion !== REQUIRED_VERSION_WRITE_ONLY) {
    s = { ...s, requiredVersion: REQUIRED_VERSION_WRITE_ONLY };
    built = buildStack(s.items, lookup, { target: s.target, stackName: s.stackName, requiredVersion: s.requiredVersion, ...(s.backend ? { backend: s.backend } : {}) });
  }
  const dir = `terraform/${s.folder}`;
  for (const f of built.findings) {
    if (f.code === 'tf.stack.empty') continue;
    findings.push({ ...f, path: f.path ? `${dir}/${f.path}` : dir });
  }
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(built.files)) {
    if (name === 'README.md') continue;
    files[`${dir}/${name}`] = text;
  }
  files[`${dir}/README.md`] = readme(s, built.files);
  files[`${dir}/cutover.auto.tfvars.example`] = cutoverExample(s);
  files[`${dir}/archtoolkit-terraform-settings.json`] = writeSettings(stackEnvelope(plan, s) as unknown as Json, 'json');
  return { files, stack: s };
}

/**
 * Every platform's Terraform: `terraform/<p>/` (and `terraform/<p>-dr/` where
 * a DR region is set), the findings, and the envelopes the Terraform page
 * opens (the handoffs).
 */
export function terraformFiles(
  plan: Plan,
  decision: PlanDecision,
  design: TargetDesign,
  options: PlanToStacksOptions = {},
): { files: Record<string, string>; findings: Finding[]; envelopes: GeneratedProject['handoffs']['terraform'] } {
  const stacks = planToStacks(plan, decision, design, options);
  const lookup = options.lookup ?? findTerraformBlueprint;
  const findings: Finding[] = [...stacks.findings];
  const files: Record<string, string> = {};
  const envelopes: Partial<Record<Platform, TerraformSettingsEnvelope>> = {};
  for (const platform of PLATFORM_VALUES) {
    const stack = stacks.perPlatform[platform];
    if (stack) {
      const out = stackFiles(plan, stack, lookup, findings);
      Object.assign(files, out.files);
      envelopes[platform] = stackEnvelope(plan, out.stack);
    }
    const d = stacks.dr[platform];
    if (d) Object.assign(files, stackFiles(plan, d, lookup, findings).files);
  }
  return { files, findings, envelopes };
}
