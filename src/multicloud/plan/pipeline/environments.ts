/**
 * Environments (addendum A.10.11): an app stack generated once per
 * environment, `apps/<p>/<env>/`, from the same app plan.
 *
 * The environments differ only in their size and HA values:
 *
 *   - the compute grid's Size (and Cores) and the vSphere grid's vCPU / RAM;
 *   - the databases grid's Class and HA;
 *
 * scaled to the plan's relative nonprod size (10 / 25 / 50 / 100 %), with the
 * prod-only rules relaxed in nonprod (no HA, no Business Critical tier). Every
 * other value of every item is the prod stack's, byte for byte.
 *
 * Where the environments share one landing zone (the default, as the base
 * design has it: prod and nonprod networks in one account, subscription or
 * project), two environments cannot create two VMs or databases of the same
 * name, so `isolation: 'shared'` also gives each nonprod row its identity: the
 * name gets `-<env>`, the Env column is the environment, and the Network
 * column is the nonprod network. `isolation: 'account'` (an account,
 * subscription or project per environment, selected by the pipeline's
 * credentials) leaves those alone, so the stacks differ in size / HA only.
 *
 * Promotion is the pipeline's dev → test → preprod → prod on one commit; the
 * state of each environment's stack is its own key
 * (`<plan>/<platform>/<env>/<stack>.tfstate`).
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import type { Json } from '../../../editor/doc.ts';
import { AWS_DB_INSTANCE_CLASS_GROUPS, AWS_INSTANCE_TYPE_GROUPS, AZURE_VM_SIZE_GROUPS, GCP_MACHINE_TYPE_GROUPS } from '../../../kit/sizes-data.ts';
import { writeSettings } from '../../../kit/settings-file.ts';
import type { BlueprintLookup, StackItem } from '../../../kit/stack.ts';
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.ts';
import type { BackendKind } from '../../../terraform/scaffold.ts';
import { buildStack } from '../../../terraform/stack.ts';
import { NETWORK_ENVS } from '../design/network.ts';
import { PLATFORM_LABELS, PLATFORM_VALUES, slugName } from '../options.ts';
import type { Env, NonprodPct, Plan, Platform, TargetDesign } from '../types.ts';
import { stackEnvelope, type PlanStacks, type PlatformStack } from '../generate/terraform.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How the environments are kept apart. */
export type EnvIsolation = 'shared' | 'account';

export interface EnvironmentOptions {
  /** The environments to generate (Governance / LoadProfile `environments`); `dr` is the DR-region stack's, not an app environment. */
  readonly environments: readonly Env[];
  /** Nonprod size relative to prod. */
  readonly nonprodPct: NonprodPct;
  /** Default `shared`: one landing zone, prod and nonprod networks. */
  readonly isolation?: EnvIsolation;
  /** The network nonprod rows land in (shared isolation). Default `nonprod`. */
  readonly nonprodNetwork?: string;
}

/**
 * A stack the pipeline deploys: where it is, which platform and environment it
 * belongs to, and the name its state key carries.
 */
export interface DeployStack {
  readonly platform: Platform;
  readonly env: Env;
  /** The folder in the project, e.g. `apps/aws/dev` or `terraform/aws`. */
  readonly dir: string;
  /** The stack's name in the state key: `apps`, `estate`, `dr` … */
  readonly name: string;
  readonly backend: Exclude<BackendKind, 'none'>;
}

/** One environment's stack. */
export interface EnvironmentStack extends PlatformStack {
  readonly env: Env;
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/** The promotion order. `dr` is not an app environment (the DR region has its own stack). */
export const PROMOTION_ORDER: readonly Env[] = ['dev', 'test', 'preprod', 'prod'];

/** Prod-sized, prod-HA environments: the prod network's (`prod`, `dr`). */
export const isNonprod = (env: Env): boolean => !NETWORK_ENVS.prod.includes(env);

/** The environments in promotion order, `dr` left out, each once. */
export function promotionOrder(envs: readonly Env[]): Env[] {
  return PROMOTION_ORDER.filter((e) => envs.includes(e));
}

/** The state key of a stack: `<plan>/<platform>/<env>/<stack>.tfstate`. */
export function stateKey(planId: string, stack: Pick<DeployStack, 'platform' | 'env' | 'name'>): string {
  return `${planSlug(planId)}/${stack.platform}/${stack.env}/${stack.name}.tfstate`;
}

/** The plan id as it goes into a state key, a bucket name or a CI variable: a-z, 0-9 and `-`. */
export const planSlug = (id: string): string => slugName(id).replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';

// ---------------------------------------------------------------------------
// Size scaling
// ---------------------------------------------------------------------------

const setOf = (groups: Readonly<Record<string, string>>): ReadonlySet<string> => new Set(Object.values(groups).flatMap((v) => v.split(',')));
const AWS_TYPES = setOf(AWS_INSTANCE_TYPE_GROUPS);
const AWS_DB_CLASSES = setOf(AWS_DB_INSTANCE_CLASS_GROUPS);
const AZURE_SIZES = setOf(AZURE_VM_SIZE_GROUPS);
const GCP_TYPES = setOf(GCP_MACHINE_TYPE_GROUPS);

/** The target vCPU for a nonprod copy: the share of prod, never below `floor`. */
const scaled = (n: number, pct: number, floor: number): number => Math.max(floor, Math.ceil((n * pct) / 100));

/** vCPU of an AWS size suffix (`large` 2, `xlarge` 4, `8xlarge` 32); undefined for metal and the burstable small sizes. */
function awsSuffixVcpu(suffix: string): number | undefined {
  if (suffix === 'large') return 2;
  if (suffix === 'xlarge') return 4;
  const m = /^(\d+)xlarge$/.exec(suffix);
  return m ? Number(m[1]) * 4 : undefined;
}

/** The smallest size in `family` with at least `target` vCPU and no more than the original. */
function awsScale(prefix: string, size: string, pct: number, known: ReadonlySet<string>): string {
  const m = new RegExp(`^(${prefix.replace(/\./g, '\\.')}[a-z0-9-]+)\\.([a-z0-9]+)$`).exec(size);
  if (!m) return size;
  const family = m[1]!;
  const vcpu = awsSuffixVcpu(m[2]!);
  if (vcpu === undefined) return size;
  const target = scaled(vcpu, pct, 2);
  const options = [...known]
    .filter((t) => t.startsWith(`${family}.`))
    .map((t) => ({ t, v: awsSuffixVcpu(t.slice(family.length + 1)) }))
    .filter((o): o is { t: string; v: number } => o.v !== undefined && o.v >= target && o.v <= vcpu)
    .sort((a, b) => a.v - b.v);
  return options[0]?.t ?? size;
}

/** The same series with the smallest count ≥ target that exists in `known`. */
function seriesScale(size: string, re: RegExp, build: (n: number) => string, known: ReadonlySet<string>, pct: number): string {
  const m = re.exec(size);
  if (!m) return size;
  const n = Number(m[1]);
  const target = scaled(n, pct, 2);
  for (let c = target; c <= n; c += 1) {
    const name = build(c);
    if (known.has(name)) return name;
  }
  return size;
}

/**
 * A compute size scaled to `pct` of prod, in the same family, from the
 * published catalogue (so a size the provider does not sell never comes out).
 * A size that cannot be scaled (bare metal, constrained Azure sizes, an
 * unknown family) is kept.
 */
export function scaleComputeSize(platform: Platform, size: string, pct: number): string {
  if (pct >= 100) return size;
  const s = size.trim();
  switch (platform) {
    case 'aws':
      return awsScale('', s, pct, AWS_TYPES);
    case 'azure': {
      // Standard_D8s_v5, Standard_E16ds_v5; a constrained size (Standard_E8-4ds_v5) is a licence choice and is kept.
      const m = /^Standard_([A-Z]+)(\d+)([a-z]*)_(v\d+)$/.exec(s);
      if (!m) return s;
      const [, letters, , suffix, gen] = m;
      return seriesScale(s, /^Standard_[A-Z]+(\d+)/, (n) => `Standard_${letters}${n}${suffix}_${gen}`, AZURE_SIZES, pct);
    }
    case 'google': {
      const m = /^([a-z0-9]+-[a-z]+)-(\d+)$/.exec(s);
      if (!m) return s;
      return seriesScale(s, /-(\d+)$/, (n) => `${m[1]}-${n}`, GCP_TYPES, pct);
    }
    case 'oci': {
      // <shape>:<ocpus>:<GB> for a Flex shape.
      const m = /^(.+\.Flex):(\d+):(\d+)$/i.exec(s);
      if (!m) return s;
      const ocpus = Number(m[2]);
      const gb = Number(m[3]);
      const o = scaled(ocpus, pct, 1);
      const g = Math.min(o * 64, Math.max(o, Math.ceil((gb * o) / ocpus)));
      return `${m[1]}:${o}:${g}`;
    }
    default:
      return s;
  }
}

/** vCore counts: SQL Database (General Purpose / Business Critical Gen5) and SQL Managed Instance (the azurerm provider's validation). */
const AZURE_SQLDB_VCORES = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80, 128];
const AZURE_SQLMI_VCORES = [4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 56, 64, 80, 96, 128];

/**
 * A database class scaled to `pct` of prod; with `relaxHa`, Azure's Business
 * Critical tier becomes General Purpose (a prod-only rule). Unknown forms are
 * kept.
 */
export function scaleDbClass(platform: Platform, cls: string, pct: number, relaxHa: boolean, service = ''): string {
  const c = cls.trim();
  if (c === '') return c;
  if (platform === 'azure') {
    const gen = /^(GP|BC)_Gen5_(\d+)$/.exec(c);
    if (gen) {
      const tier = relaxHa ? 'GP' : gen[1]!;
      const n = Number(gen[2]);
      const ladder = service === 'azure-sqlmi' ? AZURE_SQLMI_VCORES : AZURE_SQLDB_VCORES;
      const v = pct >= 100 ? n : (ladder.find((x) => x >= scaled(n, pct, 2) && x <= n) ?? n);
      return `${tier}_Gen5_${v}`;
    }
    const flex = /^(GP|MO|B)_(Standard_[A-Za-z0-9_]+)$/.exec(c);
    if (flex) return `${flex[1]}_${scaleComputeSize('azure', flex[2]!, pct)}`;
    return c;
  }
  if (pct >= 100) return c;
  switch (platform) {
    case 'aws':
      return awsScale('db.', c, pct, AWS_DB_CLASSES);
    case 'google': {
      const custom = /^db-custom-(\d+)-(\d+)$/.exec(c);
      if (custom) {
        const cpu = Number(custom[1]);
        const mib = Number(custom[2]);
        // Cloud SQL custom tiers: 1 or an even vCPU count; memory a multiple of 256 MiB, 0.9–6.5 GiB per vCPU.
        let v = scaled(cpu, pct, 1);
        if (v > 1 && v % 2 === 1) v += 1;
        v = Math.min(v, cpu);
        const perCpu = mib / cpu;
        const m = Math.max(Math.ceil((v * 0.9 * 1024) / 256) * 256, Math.round((perCpu * v) / 256) * 256);
        return `db-custom-${v}-${Math.min(m, Math.floor((v * 6.5 * 1024) / 256) * 256)}`;
      }
      const cpuN = /^cpu-(\d+)$/.exec(c);
      if (cpuN) return `cpu-${[2, 4, 8, 16, 32, 64, 96, 128].find((x) => x >= scaled(Number(cpuN[1]), pct, 2)) ?? cpuN[1]}`;
      return c;
    }
    case 'oci': {
      if (/^\d+$/.test(c)) return String(scaled(Number(c), pct, 2)); // Autonomous ECPUs
      const mysql = /^MySQL\.(\d+)$/.exec(c);
      if (mysql) return `MySQL.${[2, 4, 8, 16, 32, 48, 64, 96, 128, 256].find((x) => x >= scaled(Number(mysql[1]), pct, 2)) ?? mysql[1]}`;
      const pg = /^(PostgreSQL\..+\.Flex):(\d+):(\d+)$/.exec(c);
      if (pg) {
        const o = scaled(Number(pg[2]), pct, 1);
        return `${pg[1]}:${o}:${Math.max(16, Math.ceil((Number(pg[3]) * o) / Number(pg[2])))}`;
      }
      const flex = /^(VM\..+\.Flex):(\d+)$/.exec(c);
      if (flex) return `${flex[1]}:${scaled(Number(flex[2]), pct, 1)}`;
      return c; // Exadata shapes are kept.
    }
    default:
      return c;
  }
}

// ---------------------------------------------------------------------------
// The per-environment copy of a stack
// ---------------------------------------------------------------------------

// Column positions, from the grid contract (terraform/blueprints/migration/common.ts).
const VM = { name: 0, os: 1, size: 3, cores: 4, network: 6, env: 14 } as const;
const DB = { name: 0, service: 1, cls: 5, ha: 7, network: 10 } as const;
const VS = { name: 0, vcpu: 3, ram: 4, portGroup: 6 } as const;

const rowsOf = (text: unknown): string[][] => String(text ?? '').split('\n').filter((l) => l.trim() !== '').map((l) => l.split(' | '));
const gridOf = (rows: readonly string[][]): string => rows.map((r) => r.join(' | ')).join('\n');

interface CopyContext {
  readonly platform: Platform;
  readonly env: Env;
  readonly pct: number;
  readonly nonprod: boolean;
  readonly identity: boolean;
  readonly network: string;
  readonly findings: Finding[];
  readonly renamed: Map<string, string>;
}

function rename(ctx: CopyContext, name: string): string {
  if (!ctx.identity) return name;
  const next = `${name.trim()}-${ctx.env}`;
  ctx.renamed.set(name.trim(), next);
  return next;
}

function computeGrid(ctx: CopyContext, text: unknown): string {
  return gridOf(rowsOf(text).map((r) => {
    const out = [...r];
    const size = (r[VM.size] ?? '').trim();
    const next = scaleComputeSize(ctx.platform, size, ctx.pct);
    if (ctx.nonprod && (r[11] ?? '').trim() === 'replicate') {
      ctx.findings.push(info('plan.build.env-replicated-row', `${PLATFORM_LABELS[ctx.platform]} ${ctx.env}: ${(r[VM.name] ?? '').trim()} is replicated in prod, so its ${ctx.env} copy is adopted only after a cutover; set its method to rebuild for a ${ctx.env} VM built from the image.`));
    }
    if (ctx.pct < 100 && next === size && size !== '') {
      ctx.findings.push(info('plan.build.env-size-kept', `${PLATFORM_LABELS[ctx.platform]} ${ctx.env}: ${(r[VM.name] ?? '').trim()} keeps ${size}; no smaller size of that family is published.`));
    }
    out[VM.size] = next;
    const cores = Number((r[VM.cores] ?? '').trim());
    if (next !== size && Number.isFinite(cores) && cores > 0) out[VM.cores] = String(scaled(cores, ctx.pct, 1));
    if (ctx.identity) {
      const os = (r[VM.os] ?? '').trim();
      const name = rename(ctx, (r[VM.name] ?? '').trim());
      out[VM.name] = name;
      if (os.startsWith('win-') && name.length > 15 && (r[VM.name] ?? '').trim().length <= 15) {
        ctx.findings.push(warning('plan.build.env-windows-name', `${name}: a Windows computer name is 15 characters at most; shorten the workload name, or give each environment its own account (isolation: account).`));
      }
      out[VM.network] = ctx.network;
      out[VM.env] = ctx.env;
    }
    return out;
  }));
}

function databaseGrid(ctx: CopyContext, text: unknown): string {
  return gridOf(rowsOf(text).map((r) => {
    const out = [...r];
    const service = (r[DB.service] ?? '').trim();
    out[DB.cls] = scaleDbClass(ctx.platform, r[DB.cls] ?? '', ctx.pct, ctx.nonprod, service);
    if (ctx.nonprod) out[DB.ha] = 'none';
    if (ctx.identity) {
      // An SQL Server VM row is keyed by its host's compute row: the same new name.
      const name = (r[DB.name] ?? '').trim();
      out[DB.name] = service === 'azure-sqlvm' ? (ctx.renamed.get(name) ?? rename(ctx, name)) : `${name}-${ctx.env}`;
      out[DB.network] = ctx.network;
    }
    return out;
  }));
}

function vsphereGrid(ctx: CopyContext, text: unknown): string {
  return gridOf(rowsOf(text).map((r) => {
    const out = [...r];
    const vcpu = Number((r[VS.vcpu] ?? '').trim());
    const ram = Number((r[VS.ram] ?? '').trim());
    if (ctx.pct < 100 && vcpu > 0) out[VS.vcpu] = String(scaled(vcpu, ctx.pct, 1));
    if (ctx.pct < 100 && ram > 0) out[VS.ram] = String(scaled(ram, ctx.pct, 2));
    if (ctx.identity) {
      out[VS.name] = rename(ctx, (r[VS.name] ?? '').trim());
      out[VS.portGroup] = (r[VS.portGroup] ?? '').replace(/-prod-/, `-${ctx.network}-`);
    }
    return out;
  }));
}

/** The item as it is in `env`: only its size / HA values (and, in a shared landing zone, its rows' identity) changed. */
function itemFor(ctx: CopyContext, item: StackItem): StackItem {
  const id = item.blueprintId;
  const values = { ...item.values } as Record<string, unknown>;
  if (/_mig_compute$/.test(id) && values.vms !== undefined) values.vms = computeGrid(ctx, values.vms);
  else if (id === 'vsphere_mig_vms' && values.vms !== undefined) values.vms = vsphereGrid(ctx, values.vms);
  if (/_mig_databases$/.test(id) && values.databases !== undefined) values.databases = databaseGrid(ctx, values.databases);
  return { ...item, values: values as StackItem['values'] };
}

/**
 * One environment's copy of a prod app stack. For `prod` (and `dr`) the items
 * are the prod stack's unchanged.
 */
export function environmentStack(stack: PlatformStack, env: Env, options: EnvironmentOptions, findings: Finding[] = []): EnvironmentStack {
  const nonprod = isNonprod(env);
  const ctx: CopyContext = {
    platform: stack.platform,
    env,
    pct: nonprod ? options.nonprodPct : 100,
    nonprod,
    identity: nonprod && (options.isolation ?? 'shared') === 'shared',
    network: options.nonprodNetwork ?? 'nonprod',
    findings,
    renamed: new Map(),
  };
  // Compute first, so a databases row keyed by a VM takes the VM's new name.
  const compute = stack.items.map((i) => (/_mig_compute$|^vsphere_mig_vms$/.test(i.blueprintId) ? itemFor(ctx, i) : i));
  const items = compute.map((i) => (/_mig_compute$|^vsphere_mig_vms$/.test(i.blueprintId) ? i : itemFor(ctx, i)));
  return {
    ...stack,
    env,
    folder: `${stack.platform}/${env}`,
    items,
    stackName: `${stack.stackName} (${env})`,
  };
}

/**
 * Every environment of every platform's app stack. `stacks` is `planToStacks`
 * with `scope: 'apps'` (and normally `landingZone: 'shared'`); its DR-region
 * stacks are not environments and are left out.
 */
export function environmentStacks(
  stacks: PlanStacks,
  options: EnvironmentOptions,
  design?: TargetDesign,
): { stacks: EnvironmentStack[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const out: EnvironmentStack[] = [];
  const envs = promotionOrder(options.environments);
  if (options.environments.includes('dr')) {
    findings.push(info('plan.build.env-dr', 'dr is not an app environment: the DR region has its own landing-zone stack (terraform/<p>-dr/).'));
  }
  if (envs.length === 0) {
    findings.push(warning('plan.build.env-none', 'No app environment is selected, so no per-environment stack is generated.'));
    return { stacks: out, findings };
  }
  const shared = (options.isolation ?? 'shared') === 'shared';
  for (const platform of PLATFORM_VALUES) {
    const stack = stacks.perPlatform[platform];
    if (!stack) continue;
    if (shared && design && platform !== 'vmware' && envs.some(isNonprod)) {
      const pd = design.platforms.find((p) => p.platform === platform);
      const net = options.nonprodNetwork ?? 'nonprod';
      if (pd && !pd.networks.some((n) => n.name === net)) {
        findings.push(warning('plan.build.env-no-nonprod-network', `${PLATFORM_LABELS[platform]}: the shared landing zone has no ${net} network for the nonprod environments; add one on the design screen (or give each environment its own account).`));
      }
    }
    for (const env of envs) out.push(environmentStack(stack, env, options, findings));
  }
  return { stacks: out, findings: dedupe(findings) };
}

function dedupe(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.code}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** What the pipeline deploys for the environment stacks. */
export function environmentDeployStacks(stacks: readonly EnvironmentStack[]): DeployStack[] {
  return stacks.map((s) => ({ platform: s.platform, env: s.env, dir: `apps/${s.folder}`, name: 'apps', backend: s.backend ?? 'local' }));
}

/** What the pipeline deploys for the estate stacks (`terraform/<p>/` as prod, `terraform/<p>-dr/` as dr). */
export function estateDeployStacks(stacks: PlanStacks, name = 'estate'): DeployStack[] {
  const out: DeployStack[] = [];
  for (const platform of PLATFORM_VALUES) {
    const s = stacks.perPlatform[platform];
    if (s) out.push({ platform, env: 'prod', dir: `terraform/${s.folder}`, name, backend: s.backend ?? 'local' });
    const d = stacks.dr[platform];
    if (d) out.push({ platform, env: 'dr', dir: `terraform/${d.folder}`, name: `${name}-dr`, backend: d.backend ?? 'local' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function readme(stack: EnvironmentStack, options: EnvironmentOptions): string {
  const nonprod = isNonprod(stack.env);
  return [
    `# ${stack.stackName}`,
    '',
    `The ${stack.env} copy of the ${PLATFORM_LABELS[stack.platform]} app stack. It applies as generated.`,
    '',
    nonprod
      ? `It is the prod stack with its sizes at ${options.nonprodPct}% and the prod-only rules relaxed (no database HA, General Purpose instead of Business Critical).${(options.isolation ?? 'shared') === 'shared' ? ` It shares the landing zone, so its VMs and databases are named \`<name>-${stack.env}\` and sit in the ${options.nonprodNetwork ?? 'nonprod'} network.` : ''}`
      : 'It is the prod stack, unchanged.',
    '',
    `State: \`<plan>/${stack.platform}/${stack.env}/apps.tfstate\` in the platform's state store (backend-bootstrap/${stack.platform}/); the pipeline passes it with \`-backend-config\`.`,
    '',
    '- `archtoolkit-terraform-settings.json`: open it on the Terraform page to see and edit this same stack.',
    '',
  ].join('\n');
}

/**
 * The environment stacks built into files, under `apps/<p>/<env>/`, with the
 * Terraform page's envelope beside each.
 */
export function environmentFiles(
  plan: Plan,
  stacks: readonly EnvironmentStack[],
  options: EnvironmentOptions,
  lookup: BlueprintLookup = findTerraformBlueprint,
): { files: Record<string, string>; findings: Finding[] } {
  const files: Record<string, string> = {};
  const findings: Finding[] = [];
  for (const s of stacks) {
    const dir = `apps/${s.folder}`;
    const built = buildStack(s.items, lookup, { target: s.target, stackName: s.stackName, requiredVersion: s.requiredVersion, ...(s.backend ? { backend: s.backend } : {}) });
    for (const f of built.findings) {
      if (f.code === 'tf.stack.empty') continue;
      findings.push({ ...f, path: f.path ? `${dir}/${f.path}` : dir });
    }
    for (const [name, text] of Object.entries(built.files)) {
      if (name === 'README.md') continue;
      files[`${dir}/${name}`] = text;
    }
    files[`${dir}/README.md`] = readme(s, options);
    files[`${dir}/archtoolkit-terraform-settings.json`] = writeSettings(stackEnvelope(plan, s) as unknown as Json, 'json');
  }
  return { files, findings: dedupe(findings) };
}
