/**
 * The Ansible inventory for a decided, designed plan (base design 2.7.4 and
 * addendum A.12.3): who the hosts are, which groups they are in, and how
 * Ansible finds them.
 *
 * One model, `inventoryModel`, says for every target host which groups it
 * belongs to. Everything else is written from it, so the routes cannot drift:
 *
 *   inventory/aws_ec2.yml  azure_rm.yml  gcp_compute.yml  migration.oci.yml
 *        the dynamic inventory plugin configs, one per hyperscaler in the
 *        plan. Their `keyed_groups` read only the tags the migration compute
 *        blueprints really write (atk_app, atk_role, atk_env, atk_os,
 *        atk_os_family, atk_wave, atk_backup, plus Name); what no tag says
 *        (replicated or rebuilt, availability group, app component) is a
 *        `groups:` expression over the host names the plan knows.
 *   inventory/hosts.yml   the group skeleton, no hosts: every group a play
 *        names or group_vars configure, so the project runs with any route.
 *   inventory/hosts_vmware.yml  VCF targets and relocated VMs, static, with
 *        `ansible_host` from the estate's addresses (`hostAddress`).
 *   inventory/sources.yml the source machines, for the freeze and cutover
 *        steps (`--limit wave_<n>_sources`), never in a target group.
 *   inventory/group_vars/  connection settings per OS and platform, per-engine
 *        defaults, the EDR / scanner agents, and all/vault.yml.example.
 *   inventory/host_vars/<host>.yml  engine settings per IaaS database host.
 *
 * Group names are made safe the same way everywhere: lower case, anything
 * but a-z, 0-9 and _ becomes _. The dynamic configs apply the same filters to
 * the tag values, so `Active Directory` on AWS and `active-directory` as a
 * Google Cloud label both give `app_active_directory`.
 *
 * Nothing here writes a credential or a value that identifies who generated
 * it; credentials are vault variables, named in vault.yml.example with no value.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { familyOf } from '../../../core/ip.ts';
import { hostAddress } from '../../../ansible/estate.ts';
import { renderYaml, type YamlValue } from '../../../ansible/yaml.ts';
import type { InventoryVm } from '../../../vmware/inventory.ts';
import { designWorkloads, isIaasService } from '../design/index.ts';
import { PLATFORM_LABELS, PLATFORM_VALUES, slugName } from '../options.ts';
import type {
  App, ComputeTarget, Database, DbTarget, InfraItem, ItemId, Plan, PlanDecision, Platform, PlatformDesign, TargetDesign,
  WavePlan, Workload,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The hyperscalers, which get a dynamic inventory plugin config. */
export type DynamicPlatform = Exclude<Platform, 'vmware'>;
export const DYNAMIC_PLATFORMS: readonly DynamicPlatform[] = ['aws', 'azure', 'google', 'oci'];
const isDynamic = (p: Platform): p is DynamicPlatform => p !== 'vmware';

/** A group name Ansible accepts without a warning: lower case, a-z 0-9 _. */
export function safeGroup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/** The same transformation, as the Jinja filters a keyed group applies to a tag value. */
const SAFE_FILTERS = "| lower | regex_replace('[^a-z0-9_]', '_')";

/** A label value Google accepts (what the Google compute blueprint writes): lower case, a-z 0-9 - _, 63 at most. */
const gcpLabel = (v: string): string => v.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 63);

/** The inventory name of a VM on a platform: the compute row's Name (Google Cloud lower-cases it). */
export function inventoryName(platform: Platform, name: string): string {
  if (platform !== 'google') return name;
  const s = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 63).replace(/-+$/, '');
  return /^[a-z]/.test(s) ? s : `vm-${s}`.slice(0, 63);
}

/** The file each dynamic plugin config is written to; each plugin checks the suffix. */
export const DYNAMIC_FILES: Readonly<Record<DynamicPlatform, string>> = {
  aws: 'inventory/aws_ec2.yml',
  azure: 'inventory/azure_rm.yml',
  google: 'inventory/gcp_compute.yml',
  // oracle.oci.oci reads only files ending .oci.yml / .oci.yaml.
  oci: 'inventory/migration.oci.yml',
};
export const DYNAMIC_PLUGINS: Readonly<Record<DynamicPlatform, string>> = {
  aws: 'amazon.aws.aws_ec2',
  azure: 'azure.azcollection.azure_rm',
  google: 'google.cloud.gcp_compute',
  oci: 'oracle.oci.oci',
};
/** Where each plugin puts a host's tags, and its name, in the host's variables. */
export const TAG_VAR: Readonly<Record<DynamicPlatform, string>> = { aws: 'ec2_tags', azure: 'tags', google: 'labels', oci: 'freeform_tags' };
export const NAME_VAR: Readonly<Record<DynamicPlatform, string>> = { aws: 'ec2_tags.Name', azure: 'name', google: 'name', oci: 'display_name' };

/**
 * The tags the migration compute blueprints write on every VM
 * (terraform/blueprints/migration/common.ts `migTags`), and the group prefix
 * each keys. `atk_db` is written too, but it reads "sqlserver" for a MySQL
 * host (its pattern tests /sql/ first), so the db_<engine> groups are keyed
 * on `atk_role`, which holds the engine for a database host, instead.
 */
export const KEYED_TAGS: readonly (readonly [tag: string, prefix: string])[] = [
  ['atk_role', 'role'],
  ['atk_os', 'os'],
  ['atk_os_family', 'os_family'],
  ['atk_env', 'env'],
  ['atk_app', 'app'],
  ['atk_wave', 'wave'],
  ['atk_backup', 'backup'],
];

/** The engine groups, from the atk_role value a database host carries. */
const ENGINE_GROUPS: readonly (readonly [group: string, roles: readonly string[]])[] = [
  ['db_oracle', ['oracle']],
  ['db_sqlserver', ['sqlserver']],
  ['db_postgres', ['postgres']],
  ['db_mysql', ['mysql', 'mariadb']],
];

const LINUX_FAMILIES = ['rhel', 'suse', 'debian', 'other'];

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export type HostRoute = 'dynamic' | 'static';
export type HostMethod = 'replicate' | 'rebuild' | 'relocate';

export interface InventoryHost {
  /** inventory_hostname, as the plugin (or the static file) names it. */
  readonly name: string;
  /** The workload's name in the plan. */
  readonly workload: string;
  readonly id: ItemId;
  readonly platform: Platform;
  readonly route: HostRoute;
  readonly method: HostMethod;
  readonly kind: 'windows' | 'linux';
  readonly app: string;
  readonly wave?: number;
  /** The atk_* tags as Terraform writes them on this platform (Google Cloud: label values). */
  readonly tags: Readonly<Record<string, string>>;
  readonly address?: string;
  /** Every group the host is in, sorted. */
  readonly groups: readonly string[];
}

/** An app component's group: the hosts a config item runs on. */
export interface ComponentGroup {
  readonly group: string;
  readonly app: string;
  /** Host names in it. */
  readonly members: readonly string[];
  /** Component ids whose `atk_component` tag also puts a host in it (the app stacks write that tag). */
  readonly componentIds: readonly string[];
}

export interface IaasDbHost {
  readonly host: InventoryHost;
  readonly db: Database;
  readonly target: DbTarget;
}

export interface AvailabilityGroup {
  readonly group: string;
  readonly db: Database;
  readonly platform: Platform;
  readonly hosts: readonly InventoryHost[];
}

export interface InventoryModel {
  /** Target hosts, in design order. */
  readonly hosts: readonly InventoryHost[];
  /** Source machines (`src-<name>`), for the freeze and cutover steps. */
  readonly sources: readonly InventoryHost[];
  /** Platforms with at least one target host, in the design's order. */
  readonly platforms: readonly Platform[];
  readonly dbHosts: readonly IaasDbHost[];
  readonly ags: readonly AvailabilityGroup[];
  readonly components: readonly ComponentGroup[];
  /** The apps in scope (names). */
  readonly apps: readonly string[];
  /** Waves with replicated hyperscaler hosts, for the wave_<n>_test groups. */
  readonly testWaves: Readonly<Partial<Record<DynamicPlatform, readonly number[]>>>;
  /** Whether wave groups come from a wave plan (then they are also name expressions). */
  readonly wavesFromPlan: boolean;
  readonly findings: readonly Finding[];
}

export interface PlanInventoryOptions {
  /** Only these apps (App ids or names): the app slice. */
  readonly apps?: readonly string[];
  /** The wave plan (WP-9 `planWaves`); without it a host's wave is its App's pinned wave. */
  readonly waves?: WavePlan;
}

/** The compute row's Role, as Terraform writes it: the engine for an IaaS database host, else the workload's role. */
function roleTag(w: Workload | undefined, engine: string | undefined): string {
  return (engine ?? w?.role ?? '').toLowerCase();
}

/** Terraform's atk_db value for a Role (reproduced as written, with its MySQL quirk). */
function dbTag(role: string): string {
  if (/oracle/.test(role)) return 'oracle';
  if (/sql|mssql/.test(role)) return 'sqlserver';
  if (/postgres|pg/.test(role)) return 'postgres';
  if (/mysql|maria/.test(role)) return 'mysql';
  return role === 'db' ? 'db' : '';
}

function osFamily(os: string): 'windows' | 'rhel' | 'suse' | 'debian' | 'other' {
  const id = os.trim().toLowerCase();
  if (id.startsWith('win')) return 'windows';
  if (/^(rhel|centos|rocky|alma|ol)-/.test(id)) return 'rhel';
  if (id.startsWith('sles')) return 'suse';
  if (/^(ubuntu|debian)-/.test(id)) return 'debian';
  return 'other';
}

/** The address Ansible reaches a machine on, from the estate's addresses. */
function addressOf(w: Workload | undefined): string | undefined {
  const ips = w?.facts?.ipAddresses;
  if (!ips || ips.length === 0) return undefined;
  return hostAddress({ name: w!.name, ipAddresses: [...ips] } as unknown as InventoryVm);
}

interface AppPlanView {
  readonly app: ItemId;
  readonly status?: string;
  readonly platform?: Platform;
  readonly recommendation?: { readonly platform: Platform };
  readonly variants?: Readonly<Partial<Record<Platform, readonly {
    readonly id: string; readonly name: string; readonly kind: string;
    readonly servers?: readonly string[]; readonly databases?: readonly string[]; readonly appliesTo?: readonly string[];
  }[]>>>;
}
const appPlansOf = (plan: Plan): readonly AppPlanView[] => (plan.appPlans ?? []) as readonly AppPlanView[];

/** The component slug of a component id `c:<app-slug>:<slug>`. */
export function componentSlug(id: string, name: string): string {
  const last = id.split(':').pop() ?? '';
  return safeGroup(last || slugName(name) || 'component');
}

/** The group a component's hosts are in: `comp_<app>_<component>`. */
export function componentGroup(app: string, id: string, name: string): string {
  return `comp_${safeGroup(slugName(app) || app)}_${componentSlug(id, name)}`;
}

/**
 * Every target host and source machine, with its groups. Compute targets
 * whose database moves to a managed service are left out, as Terraform leaves
 * them out.
 */
export function inventoryModel(plan: Plan, decision: PlanDecision, design: TargetDesign, options: PlanInventoryOptions = {}): InventoryModel {
  const findings: Finding[] = [];
  const workloads = [...designWorkloads(plan, design), ...design.platforms.flatMap((pd) => pd.added ?? [])];
  const byId = new Map<string, Workload>();
  for (const w of workloads) if (!byId.has(w.id)) byId.set(w.id, w);
  const byName = new Map(workloads.map((w) => [w.name, w]));
  const dbById = new Map(plan.databases.map((d) => [d.id, d]));
  const appByName = new Map<string, App>(plan.apps.map((a) => [a.name, a]));

  // The slice.
  const wanted = options.apps && options.apps.length > 0
    ? new Set(options.apps.flatMap((a) => {
      const app = plan.apps.find((x) => x.id === a || x.name === a);
      return app ? [app.name] : [a];
    }))
    : null;
  const inScope = (app: string | undefined): boolean => !wanted || (app !== undefined && wanted.has(app));

  // Waves.
  const waveOfItem = new Map<string, number>();
  for (const g of options.waves?.groups ?? []) for (const id of g.items) waveOfItem.set(id, g.wave);
  const waveOf = (w: Workload): number | undefined => {
    if (options.waves) return waveOfItem.get(w.id) ?? appByName.get(w.app)?.wave;
    return appByName.get(w.app)?.wave;
  };

  // Apps with a saved plan: their web hosts are configured by the app's own items, not the generic web server.
  const planned = new Set<string>();
  for (const ap of appPlansOf(plan)) {
    if (ap.status === 'draft') continue;
    const app = plan.apps.find((a) => a.id === ap.app);
    const platform = ap.platform ?? ap.recommendation?.platform;
    if (app && platform && (ap.variants?.[platform]?.length ?? 0) > 0) planned.add(app.name);
  }

  interface Draft {
    name: string; w: Workload | undefined; id: ItemId; platform: Platform; route: HostRoute; method: HostMethod;
    kind: 'windows' | 'linux'; app: string; wave?: number; tags: Record<string, string>; address?: string; groups: Set<string>;
  }
  const drafts: Draft[] = [];
  const dbHostsRaw: { draft: Draft; db: Database; target: DbTarget }[] = [];

  for (const pd of design.platforms) {
    const platform = pd.platform;
    // IaaS databases on this platform: which host carries which engine.
    const engineOfHost = new Map<string, { db: Database; target: DbTarget }>();
    for (const t of pd.databases) {
      if (!isIaasService(t.service)) continue;
      const db = dbById.get(t.database);
      if (!db) continue;
      for (const h of t.hosts ?? []) engineOfHost.set(h, { db, target: t });
    }
    for (const c of pd.compute) {
      const d = decision.items[c.workload];
      if (d?.method === 'managed-db') continue;
      const w = byId.get(c.workload);
      if (!inScope(w?.app)) continue;
      const onDb = engineOfHost.get(c.workload);
      const method: HostMethod = methodOf(c, d?.method);
      const os = w?.os ?? 'unknown';
      const family = osFamily(os);
      const kind = family === 'windows' ? 'windows' : 'linux';
      const role = roleTag(w, onDb?.db.engine);
      const wave = w ? waveOf(w) : undefined;
      const raw: Record<string, string> = {
        atk_app: w?.app ?? '',
        atk_role: role,
        atk_env: w?.env ?? '',
        atk_os: os,
        atk_os_family: family,
        atk_wave: w ? (appByName.get(w.app)?.wave === undefined ? '' : String(appByName.get(w.app)!.wave)) : '',
        atk_backup: c.backupTier,
        atk_db: dbTag(role),
      };
      const tags = platform === 'google' ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, gcpLabel(v)])) : raw;
      const draft: Draft = {
        name: inventoryName(platform, w?.name ?? c.workload),
        w, id: c.workload, platform,
        route: isDynamic(platform) ? 'dynamic' : 'static',
        method, kind, app: w?.app ?? '', ...(wave !== undefined ? { wave } : {}), tags,
        ...(platform === 'vmware' && addressOf(w) ? { address: addressOf(w)! } : {}),
        groups: new Set(),
      };
      drafts.push(draft);
      if (onDb) dbHostsRaw.push({ draft, ...onDb });
    }
  }

  // Relocated (HCX / vMotion) VMs: still vSphere VMs, on the platform's VMware service, with their addresses.
  const platformsInDesign = new Set(design.platforms.map((p) => p.platform));
  for (const w of plan.workloads) {
    const d = decision.items[w.id];
    if (d?.method !== 'relocate-hcx' || !d.chosen || !platformsInDesign.has(d.chosen.platform) || !inScope(w.app)) continue;
    const family = osFamily(w.os);
    const wave = waveOf(w);
    const address = addressOf(w);
    drafts.push({
      name: w.name, w, id: w.id, platform: d.chosen.platform, route: 'static', method: 'relocate',
      kind: family === 'windows' ? 'windows' : 'linux', app: w.app, ...(wave !== undefined ? { wave } : {}),
      tags: { atk_app: w.app, atk_role: w.role, atk_env: w.env, atk_os: w.os, atk_os_family: family, atk_wave: '', atk_backup: '', atk_db: '' },
      ...(address ? { address } : {}),
      groups: new Set(),
    });
  }

  // Duplicate inventory names would merge two machines into one host.
  const seen = new Map<string, Draft>();
  for (const d of drafts) {
    const other = seen.get(d.name);
    if (other) {
      findings.push(warning('plan.ansible.duplicate-host', `${d.name} is the inventory name of two targets (${other.platform} and ${d.platform}); Ansible would treat them as one host.`, {
        remediation: 'Rename one of the workloads.',
      }));
    }
    seen.set(d.name, d);
  }

  // Groups every host gets from its own facts.
  for (const d of drafts) {
    const g = d.groups;
    g.add(d.kind);
    g.add(`method_${d.method}`);
    if (d.method === 'relocate') g.add('platform_vmware');
    else {
      g.add(`platform_${d.platform}`);
      g.add(`os_kind_${d.kind}`);
      if (d.kind === 'windows') g.add('bootstrap_windows');
    }
    for (const [tag, prefix] of KEYED_TAGS) {
      const v = d.tags[tag] ?? '';
      if (tag === 'atk_wave') continue;
      if (v !== '') g.add(`${prefix}_${safeGroup(v)}`);
    }
    if (d.tags.atk_wave) g.add(`wave_${safeGroup(d.tags.atk_wave)}`);
    if (d.wave !== undefined) g.add(`wave_${d.wave}`);
    for (const [group, roles] of ENGINE_GROUPS) if (roles.includes(d.tags.atk_role ?? '')) g.add(group);
    if (planned.has(d.app)) g.add('app_planned');
  }

  // Availability groups: the SQL Server VMs of a database with ha sql-ag.
  const ags: AvailabilityGroup[] = [];
  const agNames = new Set<string>();
  const byDb = new Map<string, { db: Database; target: DbTarget; drafts: Draft[] }>();
  for (const r of dbHostsRaw) {
    const e = byDb.get(r.db.id) ?? { db: r.db, target: r.target, drafts: [] };
    e.drafts.push(r.draft);
    byDb.set(r.db.id, e);
  }
  for (const { db, drafts: hs } of byDb.values()) {
    if (db.engine !== 'sqlserver') continue;
    if (db.ha === 'sql-fci') {
      findings.push(warning('plan.ansible.sql-fci', `${db.name}: a failover cluster instance needs shared storage and a clustered SQL Server setup, which the site does not automate; its hosts get a standalone install.`, {
        remediation: 'Build the FCI by hand on the shared disks Terraform creates, or move to an availability group.',
      }));
      continue;
    }
    if (db.ha !== 'sql-ag') continue;
    if (hs.length < 2) {
      findings.push(warning('plan.ansible.ag-one-host', `${db.name} is an availability group with ${hs.length} host on the target; it needs two or more, so no AG is built.`));
      continue;
    }
    if (hs.some((h) => h.kind !== 'windows')) {
      findings.push(warning('plan.ansible.ag-linux', `${db.name}: an availability group on Linux needs Pacemaker, which is out of scope; a contained AG (CLUSTER_TYPE = NONE) is the alternative.`));
      continue;
    }
    let group = `ag_${safeGroup(slugName(db.name) || db.id)}`;
    while (agNames.has(group)) group = `${group}_x`;
    agNames.add(group);
    for (const h of hs) {
      h.groups.add('db_sqlserver_ag');
      h.groups.add(group);
    }
    ags.push({ group, db, platform: hs[0]!.platform, hosts: [] });
  }

  // App components (addendum A.2.6): the hosts a config item applies to.
  const components: ComponentGroup[] = [];
  const draftByWorkload = new Map<string, Draft>();
  for (const d of drafts) if (d.w) draftByWorkload.set(d.w.name, d);
  for (const ap of appPlansOf(plan)) {
    if (ap.status === 'draft') continue;
    const app = plan.apps.find((a) => a.id === ap.app);
    const platform = ap.platform ?? ap.recommendation?.platform;
    if (!app || !platform || !inScope(app.name)) continue;
    const comps = ap.variants?.[platform] ?? [];
    const appHosts = drafts.filter((d) => d.app === app.name);
    const serversOf = (c: (typeof comps)[number]): Draft[] => {
      const names = new Set<string>(c.servers ?? []);
      for (const dbName of c.databases ?? []) for (const h of plan.databases.find((x) => x.name === dbName)?.hosts ?? []) names.add(h);
      return [...names].map((n) => draftByWorkload.get(n)).filter((x): x is Draft => !!x);
    };
    for (const c of comps.filter((x) => x.kind === 'pattern')) {
      const group = componentGroup(app.name, c.id, c.name);
      const members = serversOf(c);
      for (const m of members) m.groups.add(group);
      components.push({ group, app: app.name, members: members.map((m) => m.name), componentIds: [c.id] });
    }
    for (const c of comps.filter((x) => x.kind === 'config')) {
      const group = componentGroup(app.name, c.id, c.name);
      const members = new Set<Draft>();
      const ids: string[] = [];
      const applies = c.appliesTo ?? [];
      if (applies.length === 0) for (const h of appHosts) members.add(h);
      for (const ref of applies) {
        const comp = comps.find((x) => x.id === ref);
        if (comp) {
          ids.push(comp.id);
          for (const m of serversOf(comp)) members.add(m);
          continue;
        }
        const host = draftByWorkload.get(ref);
        if (host) members.add(host);
        else findings.push(warning('plan.ansible.component-unknown-target', `${app.name}: the ${c.name} configuration applies to ${ref}, which is neither a component nor a server of the app on the target.`));
      }
      for (const m of members) m.groups.add(group);
      components.push({ group, app: app.name, members: [...members].map((m) => m.name), componentIds: ids });
    }
  }

  const hosts: InventoryHost[] = drafts.map((d) => ({
    name: d.name, workload: d.w?.name ?? d.id, id: d.id, platform: d.platform, route: d.route, method: d.method, kind: d.kind, app: d.app,
    ...(d.wave !== undefined ? { wave: d.wave } : {}), tags: d.tags, ...(d.address ? { address: d.address } : {}),
    groups: [...d.groups].sort(),
  }));
  const hostOf = new Map(drafts.map((d, i) => [d, hosts[i]!]));
  const dbHosts: IaasDbHost[] = dbHostsRaw.map((r) => ({ host: hostOf.get(r.draft)!, db: r.db, target: r.target }));
  const agsOut = ags.map((a) => ({ ...a, hosts: hosts.filter((h) => h.groups.includes(a.group)) }));

  // Static hosts without an address.
  for (const h of hosts) {
    if (h.route === 'static' && !h.address) {
      findings.push(info('plan.ansible.static-no-address', `${h.name} (${h.method === 'relocate' ? 'relocated' : 'VCF'}) has no known address; inventory/hosts_vmware.yml lists it by name, so DNS must resolve it, or add ansible_host.`, {
        path: 'ansible/inventory/hosts_vmware.yml',
      }));
    }
  }

  // Source machines: every moved workload of the plan, by its current address, never in a target group.
  const sources: InventoryHost[] = [];
  for (const h of hosts) {
    const w = byName.get(h.workload);
    if (!w || !plan.workloads.some((x) => x.id === w.id)) continue;
    const address = addressOf(w);
    const groups = ['sources', `sources_${h.kind}`, ...(h.wave !== undefined ? [`wave_${h.wave}_sources`] : [])].sort();
    sources.push({ ...h, name: `src-${w.name}`, route: 'static', ...(address ? { address } : {}), groups });
  }
  const noAddress = sources.filter((s) => !s.address);
  if (noAddress.length > 0) {
    findings.push(info('plan.ansible.source-no-address', `${noAddress.length} source machine${noAddress.length === 1 ? ' has' : 's have'} no address in the estate (${noAddress.slice(0, 5).map((s) => s.workload).join(', ')}${noAddress.length > 5 ? ', …' : ''}); inventory/sources.yml then connects by the workload name.`, {
      path: 'ansible/inventory/sources.yml',
    }));
  }
  const unwaved = sources.filter((s) => s.wave === undefined).length;
  if (unwaved > 0 && sources.length > 0) {
    findings.push(info('plan.ansible.no-wave', `${unwaved} host${unwaved === 1 ? ' has' : 's have'} no wave yet, so ${unwaved === 1 ? 'it is' : 'they are'} in no wave_<n> group; plan the waves (or pin the app's wave) to run the site a wave at a time.`));
  }

  // wave_<n>_test: the test launches of replicated VMs carry atk_phase=test.
  const testWaves: Partial<Record<DynamicPlatform, number[]>> = {};
  for (const h of hosts) {
    if (h.route !== 'dynamic' || h.method !== 'replicate' || h.wave === undefined) continue;
    const p = h.platform as DynamicPlatform;
    const list = testWaves[p] ?? [];
    if (!list.includes(h.wave)) list.push(h.wave);
    testWaves[p] = list.sort((a, b) => a - b);
  }

  const platforms = PLATFORM_VALUES.filter((p) => hosts.some((h) => h.platform === p || (p === 'vmware' && h.groups.includes('platform_vmware'))));
  return {
    hosts, sources, platforms, dbHosts, ags: agsOut, components,
    apps: [...new Set(hosts.map((h) => h.app).filter(Boolean))].sort(),
    testWaves, wavesFromPlan: !!options.waves, findings,
  };
}

function methodOf(c: ComputeTarget, method: string | undefined): HostMethod {
  if (c.method) return c.method;
  if (c.image.kind === 'replicated') return 'replicate';
  return method === 'replicate' ? 'replicate' : 'rebuild';
}

// ---------------------------------------------------------------------------
// Host patterns
// ---------------------------------------------------------------------------

/**
 * The hosts a pattern selects, as Ansible reads one: `a:b` is the union,
 * `&c` intersects, `!d` removes; `all` is every host given.
 */
export function hostsMatching<T extends { readonly name: string; readonly groups: readonly string[] }>(pattern: string, hosts: readonly T[]): T[] {
  const terms = pattern.split(/[:,]/).map((t) => t.trim()).filter(Boolean);
  const inGroup = (g: string): T[] => (g === 'all' ? [...hosts] : hosts.filter((h) => h.name === g || h.groups.includes(g)));
  let out = new Set<T>();
  for (const t of terms.filter((x) => !/^[&!]/.test(x))) for (const h of inGroup(t)) out.add(h);
  for (const t of terms.filter((x) => x.startsWith('&'))) {
    const keep = new Set(inGroup(t.slice(1)));
    out = new Set([...out].filter((h) => keep.has(h)));
  }
  for (const t of terms.filter((x) => x.startsWith('!'))) {
    const drop = new Set(inGroup(t.slice(1)));
    out = new Set([...out].filter((h) => !drop.has(h)));
  }
  return [...out];
}

/** Group names a pattern refers to. */
export function groupsInPattern(pattern: string): string[] {
  return pattern
    .split(/[:,]/)
    .map((p) => p.trim().replace(/^[!&]/, ''))
    .filter((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) && p !== 'all' && p !== 'localhost' && p !== 'ungrouped');
}

// ---------------------------------------------------------------------------
// Dynamic inventory plugin configs
// ---------------------------------------------------------------------------

/** A condition a `groups:` entry tests: a tag or the host name against values, and / or of those. */
export type Cond =
  | { readonly op: 'true' }
  | { readonly op: 'in'; readonly on: 'name' | 'tag'; readonly tag?: string; readonly values: readonly string[] }
  | { readonly op: 'and' | 'or'; readonly of: readonly Cond[] };

const jstr = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The Jinja for a condition, on one plugin's host variables. Or binds loosest; no or is nested in an and. */
export function renderCond(cond: Cond, platform: DynamicPlatform): string {
  switch (cond.op) {
    case 'true':
      return 'true';
    case 'in': {
      const v = cond.on === 'name' ? NAME_VAR[platform] : `${TAG_VAR[platform]}.${cond.tag}`;
      const vals = cond.values.map((x) => (platform === 'google' && cond.on === 'tag' ? gcpLabel(x) : x));
      return vals.length === 1 ? `(${v} | default('')) == ${jstr(vals[0]!)}` : `(${v} | default('')) in [${vals.map(jstr).join(', ')}]`;
    }
    case 'and':
      return cond.of.map((c) => renderCond(c, platform)).join(' and ');
    case 'or':
      return cond.of.map((c) => renderCond(c, platform)).join(' or ');
  }
}

const tagIn = (tag: string, values: readonly string[]): Cond => ({ op: 'in', on: 'tag', tag, values });
const nameIn = (values: readonly string[]): Cond => ({ op: 'in', on: 'name', values });

/**
 * The `groups:` a platform's config adds, as conditions: every group the
 * model puts a dynamic host in that no keyed group gives it.
 */
export function conditionalGroups(model: InventoryModel, platform: DynamicPlatform): Record<string, Cond> {
  const here = model.hosts.filter((h) => h.route === 'dynamic' && h.platform === platform);
  const out: Record<string, Cond> = { [`platform_${platform}`]: { op: 'true' } };
  const has = (g: string): boolean => here.some((h) => h.groups.includes(g));
  const names = (g: string): string[] => here.filter((h) => h.groups.includes(g)).map((h) => h.name);
  if (has('linux')) {
    out.linux = tagIn('atk_os_family', LINUX_FAMILIES);
    out.os_kind_linux = tagIn('atk_os_family', LINUX_FAMILIES);
  }
  if (has('windows')) {
    out.windows = tagIn('atk_os_family', ['windows']);
    out.os_kind_windows = tagIn('atk_os_family', ['windows']);
    out.bootstrap_windows = tagIn('atk_os_family', ['windows']);
  }
  for (const [group, roles] of ENGINE_GROUPS) if (has(group)) out[group] = tagIn('atk_role', roles);
  for (const m of ['replicate', 'rebuild'] as const) if (has(`method_${m}`)) out[`method_${m}`] = nameIn(names(`method_${m}`));
  if (has('db_sqlserver_ag')) out.db_sqlserver_ag = nameIn(names('db_sqlserver_ag'));
  for (const ag of model.ags) if (has(ag.group)) out[ag.group] = nameIn(names(ag.group));
  if (has('app_planned')) out.app_planned = nameIn(names('app_planned'));
  for (const c of model.components) {
    if (!has(c.group)) continue;
    const members = names(c.group);
    out[c.group] = c.componentIds.length > 0
      ? { op: 'or', of: [nameIn(members), tagIn('atk_component', c.componentIds)] }
      : nameIn(members);
  }
  if (model.wavesFromPlan) {
    const waves = [...new Set(here.map((h) => h.wave).filter((w): w is number => w !== undefined))].sort((a, b) => a - b);
    for (const n of waves) out[`wave_${n}`] = nameIn(names(`wave_${n}`));
  }
  for (const n of model.testWaves[platform] ?? []) {
    out[`wave_${n}_test`] = { op: 'and', of: [tagIn('atk_phase', ['test']), tagIn('atk_wave', [String(n)])] };
  }
  return out;
}

/** The keyed groups every config carries, on the plugin's tag variable. */
export function keyedGroups(platform: DynamicPlatform): { prefix: string; key: string }[] {
  return KEYED_TAGS.map(([tag, prefix]) => ({ prefix, key: `${TAG_VAR[platform]}.${tag} | default('') ${SAFE_FILTERS}` }));
}

const notIn = (v: string, values: readonly string[]): string => `(${v} | default('')) not in [${values.map(jstr).join(', ')}]`;

/** One hyperscaler's dynamic inventory plugin config. */
export function dynamicInventory(model: InventoryModel, pd: PlatformDesign, findings: Finding[] = []): { path: string; text: string } {
  const platform = pd.platform as DynamicPlatform;
  const here = model.hosts.filter((h) => h.route === 'dynamic' && h.platform === platform);
  const apps = [...new Set(here.map((h) => h.tags.atk_app ?? h.app))].filter(Boolean).sort();
  const groups = conditionalGroups(model, platform);
  const conditional = Object.fromEntries(Object.entries(groups).map(([g, c]) => [g, renderCond(c, platform)]));
  const keyed = keyedGroups(platform) as unknown as YamlValue;
  const doc: Record<string, YamlValue> = { plugin: DYNAMIC_PLUGINS[platform] };
  const header: string[] = [];
  const appNote = 'Only this plan\'s VMs: the ones whose atk_app tag names one of its apps.';

  if (platform === 'aws') {
    header.push(`${PLATFORM_LABELS.aws}: the EC2 instances the migration compute stack built or adopted.`, appNote,
      'Credentials: the environment, a profile or the instance role, never this file.');
    doc.regions = [pd.region];
    doc.filters = { 'tag:atk_app': apps, 'instance-state-name': ['running'] };
    doc.hostnames = ['tag:Name', 'private-ip-address'];
    doc.compose = {
      ansible_host: 'private_ip_address',
      // The Session Manager connection (group_vars/platform_aws.yml) addresses an instance by its id.
      ansible_aws_ssm_instance_id: 'instance_id',
    };
    doc.keyed_groups = keyed;
    doc.groups = conditional;
  } else if (platform === 'azure') {
    header.push(`${PLATFORM_LABELS.azure}: the VMs the migration compute stack built or adopted.`, appNote,
      'Credentials: az login, a managed identity or AZURE_* environment variables, never this file.');
    doc.auth_source = 'auto';
    doc.include_vm_resource_groups = ['*'];
    doc.plain_host_names = true;
    doc.hostnames = ['name', 'default'];
    doc.exclude_host_filters = [notIn('tags.atk_app', apps)];
    doc.hostvar_expressions = { ansible_host: '(private_ipv4_addresses + ansible_all_ipv6_addresses) | first' };
    doc.keyed_groups = keyed;
    doc.conditional_groups = conditional;
  } else if (platform === 'google') {
    header.push(`${PLATFORM_LABELS.google}: the Compute Engine instances the migration compute stack built or adopted.`,
      'Only this plan\'s VMs: the ones whose atk_app label names one of its apps (labels are lower case).',
      'Credentials: Application Default Credentials (gcloud auth application-default login), never this file.');
    if (pd.scope?.trim()) doc.projects = [pd.scope.trim()];
    else {
      doc.projects = [];
      findings.push(warning('plan.ansible.gcp-no-project', 'Google Cloud (GCP): no project is set on the landing-zone card, so inventory/gcp_compute.yml lists none; the dynamic inventory finds no hosts until one is added.', {
        path: 'ansible/inventory/gcp_compute.yml',
        remediation: 'Set the project on the Google Cloud landing-zone card and generate again, or add it under projects:.',
      }));
    }
    doc.auth_kind = 'application';
    doc.filters = [
      'status = RUNNING',
      apps.length === 1 ? `labels.atk_app = "${gcpLabel(apps[0]!)}"` : apps.map((a) => `(labels.atk_app = "${gcpLabel(a)}")`).join(' OR '),
    ];
    doc.hostnames = ['name', 'private_ip'];
    doc.compose = { ansible_host: 'networkInterfaces[0].networkIP' };
    doc.keyed_groups = keyed;
    doc.groups = conditional;
  } else {
    header.push(`${PLATFORM_LABELS.oci}: the compute instances the migration compute stack built or adopted.`, appNote,
      'Credentials: ~/.oci/config or instance principals, never this file.');
    doc.regions = [pd.region];
    if (pd.scope?.trim()) doc.compartments = [{ compartment_ocid: pd.scope.trim(), fetch_hosts_from_subcompartments: true }];
    doc.fetch_compute_hosts = true;
    doc.primary_vnic_only = true;
    doc.enable_ipv6 = true;
    doc.hostname_format_preferences = ['display_name', 'private_ip'];
    doc.exclude_host_filters = [notIn('freeform_tags.atk_app', apps)];
    doc.compose = { ansible_host: 'private_ip' };
    doc.keyed_groups = keyed;
    doc.groups = conditional;
  }
  header.push(
    '',
    'Groups: role_, os_, os_family_, env_, app_, wave_ and backup_ from the atk_* tags',
    'Terraform writes; the rest (platform, OS kind, engine, method, availability',
    'group, app component, wave test launches) from the expressions under groups.',
  );
  return { path: DYNAMIC_FILES[platform], text: renderYaml(doc, { header: header.join('\n') }) };
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

/** A static YAML inventory: the hosts with their address under all, and each group's members. */
function staticInventory(hosts: readonly InventoryHost[], header: string): string {
  const all: Record<string, YamlValue> = {};
  for (const h of hosts) all[h.name] = h.address ? { ansible_host: h.address } : {};
  const children: Record<string, YamlValue> = {};
  const groups = [...new Set(hosts.flatMap((h) => h.groups))].sort();
  for (const g of groups) {
    children[g] = { hosts: Object.fromEntries(hosts.filter((h) => h.groups.includes(g)).map((h) => [h.name, {}])) };
  }
  return renderYaml({ all: { hosts: all, children } }, { header });
}

/** VCF targets and relocated VMs. */
export function vmwareInventory(model: InventoryModel): string | undefined {
  const hosts = model.hosts.filter((h) => h.route === 'static');
  if (hosts.length === 0) return undefined;
  return staticInventory(hosts, [
    'VMs on VMware: VCF targets and the VMs relocated with HCX or vMotion (they keep',
    'their addresses). The addresses are the estate\'s; a VM without one is',
    'reached by its name.',
  ].join('\n'));
}

/** The source machines, for the freeze and cutover plays. */
export function sourcesInventory(model: InventoryModel): string | undefined {
  if (model.sources.length === 0) return undefined;
  return staticInventory(model.sources, [
    'The source machines, by their current addresses, for the steps that run on',
    'them before cutover (freeze, final sync): --limit wave_<n>_sources.',
    'They are in no target group, so site.yml never configures them.',
  ].join('\n'));
}

/** Every group the project uses, for the skeleton: the ones the plays name, and the ones the model and group_vars use. */
export function skeletonInventory(groups: readonly string[]): string {
  const sorted = [...new Set(groups)].filter((g) => /^[a-z_][a-z0-9_]*$/.test(g) && g !== 'all').sort();
  const lines = [
    '---',
    '# The groups the playbooks run against and group_vars configure, with no',
    '# hosts. The hosts come from the other files here: the dynamic inventory',
    '# configs, hosts_vmware.yml and sources.yml.',
    '',
    'all:',
  ];
  if (sorted.length === 0) lines.push('  children: {}');
  else {
    lines.push('  children:');
    for (const g of sorted) lines.push(`    ${g}: {}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// group_vars and host_vars
// ---------------------------------------------------------------------------

export interface SecurityAgent {
  readonly name: string;
  readonly linux_package: string;
  readonly linux_source: string;
  readonly windows_package: string;
  readonly windows_source: string;
  readonly service: string;
}

/**
 * EDR and vulnerability-scanner agents from the plan's security services
 * (`dcExit.infra`, category security-service): what the user named, as data.
 * Kind comes from facts.kind (edr / vuln-scanning), the package and install
 * sources from facts.linux_package, linux_source, windows_package,
 * windows_source (or package / source for both), the service from
 * facts.service.
 */
export function securityAgents(plan: Plan): { edr: SecurityAgent[]; scanner: SecurityAgent[] } {
  const edr: SecurityAgent[] = [];
  const scanner: SecurityAgent[] = [];
  const infra: readonly InfraItem[] = plan.dcExit?.infra ?? [];
  for (const item of infra) {
    if (item.category !== 'security-service' || item.disposition === 'retire' || item.disposition === 'n/a') continue;
    const f = item.facts ?? {};
    const kind = (f.kind ?? '').toLowerCase();
    const isEdr = /edr|endpoint/.test(kind);
    const isScanner = /scan|vuln/.test(kind);
    if (!isEdr && !isScanner) continue;
    const agent: SecurityAgent = {
      name: (f.product || [item.vendor, item.model].filter(Boolean).join(' ') || item.name).trim(),
      linux_package: (f.linux_package ?? f.package ?? '').trim(),
      linux_source: (f.linux_source ?? f.source ?? '').trim(),
      windows_package: (f.windows_package ?? f.package ?? '').trim(),
      windows_source: (f.windows_source ?? f.source ?? '').trim(),
      service: (f.service ?? '').trim(),
    };
    (isEdr ? edr : scanner).push(agent);
  }
  return { edr, scanner };
}

/** Version of an engine as the roles take it. */
export function roleVersion(db: Database, findings: Finding[]): string {
  const v = db.version;
  const note = (to: string): string => {
    findings.push(info('plan.ansible.db-version', `${db.name}: ${v} is installed as ${to} on the target (the version the role installs nearest to it); the data moves with the database method.`));
    return to;
  };
  switch (db.engine) {
    case 'oracle':
      if (v === 'oracle-19c') return '19c';
      if (v === 'oracle-26ai') return '26ai';
      if (v === 'oracle-21c') return note('26ai');
      return note('19c');
    case 'sqlserver': {
      const m = /^sql-(\d{4})$/.exec(v);
      const year = m ? Number(m[1]) : 2022;
      if ([2016, 2017, 2019, 2022, 2025].includes(year)) return String(year);
      return note(year < 2016 ? '2016' : '2022');
    }
    case 'postgres': {
      const m = /^pg-(\d+)$/.exec(v);
      const n = m ? Number(m[1]) : 16;
      if (n >= 13 && n <= 17) return String(n);
      return note(n < 13 ? '13' : '17');
    }
    case 'mysql':
      if (v === 'mysql-8.4' || v === 'mysql-8.0') return v.slice(6);
      return note('8.0');
    default:
      return '';
  }
}

/** A SID Oracle accepts: a letter first, letters and digits, 8 at most. */
export function oracleSid(name: string): string {
  const s = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const sid = /^[A-Z]/.test(s) ? s : `DB${s}`;
  return sid.slice(0, 8) || 'ORCL';
}

const MSSQL_EDITION: Readonly<Record<string, string>> = {
  'sql-enterprise': 'Enterprise',
  'sql-standard': 'Standard',
  'sql-web': 'Standard',
  'sql-express': 'Express',
  'sql-developer': 'Developer',
};

/** Does the target image carry SQL Server already (the Azure SQL VM image, an AWS or Google SQL LI image)? */
function sqlPreinstalled(target: DbTarget, image: ComputeTarget['image'] | undefined): boolean {
  if (target.service === 'azure-sqlvm') return true;
  return !!image && image.kind !== 'replicated' && /sql/i.test(JSON.stringify(image));
}

/** Per-host variables: host name → a header line and the variables. */
export type HostVarsMap = Map<string, { header: string[]; vars: Record<string, YamlValue> }>;

const ENGINE_PORTS: Readonly<Record<string, readonly number[]>> = {
  oracle: [1521],
  sqlserver: [1433],
  postgres: [5432],
  mysql: [3306],
  mariadb: [3306],
};

/** host_vars for each IaaS database host: the engine's settings for that host, and its port opened. */
export function hostVarsFor(model: InventoryModel, design: TargetDesign, findings: Finding[], into: HostVarsMap = new Map()): HostVarsMap {
  const imageOf = new Map<string, ComputeTarget['image']>();
  for (const pd of design.platforms) for (const c of pd.compute) imageOf.set(c.workload, c.image);
  const done = new Set<string>();
  for (const { host, db, target } of model.dbHosts) {
    if (done.has(host.name)) continue;
    const vars: Record<string, YamlValue> = {};
    const version = roleVersion(db, findings);
    const hostsOfDb = model.dbHosts.filter((x) => x.db.id === db.id).map((x) => x.host);
    const primary = hostsOfDb[0]!;
    switch (db.engine) {
      case 'oracle':
        vars.oracle_version = version;
        vars.oracle_edition = db.edition === 'oracle-se2' ? 'se2' : 'ee';
        vars.oracle_sid = oracleSid(db.name);
        vars.oracle_backup_tier = target.backupTier;
        if (db.dr === 'data-guard-remote' || db.dr === 'active-data-guard') vars.oracle_dr = 'data-guard-remote';
        if (db.ha === 'rac' || db.ha === 'rac-one-node') {
          findings.push(warning('plan.ansible.oracle-rac', `${db.name} is RAC on the source; on ${PLATFORM_LABELS[host.platform]} VMs it is installed single-instance on each host (RAC needs shared storage and Grid Infrastructure, which the site does not build).`));
        }
        break;
      case 'sqlserver': {
        vars.mssql_version = version;
        vars.mssql_edition = MSSQL_EDITION[db.edition] ?? 'Enterprise';
        vars.mssql_instance_name = 'MSSQLSERVER';
        if (host.kind === 'windows') {
          vars.mssql_backup_tier = target.backupTier;
          vars.mssql_preinstalled = sqlPreinstalled(target, imageOf.get(host.id));
        }
        const ag = model.ags.find((a) => a.db.id === db.id);
        if (ag) {
          vars.mssql_ag_name = safeGroup(slugName(db.name) || 'ag').slice(0, 15);
          vars.mssql_ag_database = db.name;
        }
        break;
      }
      case 'postgres':
        vars.postgres_version = version;
        vars.postgres_backup_tier = target.backupTier;
        if (db.ha === 'pg-streaming' && hostsOfDb.length > 1) {
          vars.postgres_ha = 'pg-streaming';
          vars.postgres_primary = primary.name;
        }
        break;
      case 'mysql':
      case 'mariadb':
        vars.mysql_flavour = db.engine === 'mariadb' ? 'mariadb' : 'mysql';
        if (db.engine === 'mysql') vars.mysql_version = version;
        if (db.ha === 'mysql-group-replication' && hostsOfDb.length > 2) vars.mysql_ha = 'group-replication';
        break;
      default:
        findings.push(info('plan.ansible.engine-not-automated', `${db.name} (${db.engine}) on ${host.name}: the site installs no ${db.engine}; its host gets the baseline only.`));
        continue;
    }
    done.add(host.name);
    const ports = [...(ENGINE_PORTS[db.engine] ?? []), ...(model.ags.some((a) => a.db.id === db.id) ? [5022] : [])];
    if (host.kind === 'linux') vars.linux_baseline_allowed_tcp_ports = [22, ...ports];
    else vars.windows_baseline_allowed_tcp_ports = [5986, ...ports];
    const entry = into.get(host.name) ?? { header: [], vars: {} };
    entry.header.push(`${db.name} (${db.engine}${db.ha !== 'none' ? `, ${db.ha}` : ''}), from the plan.`);
    Object.assign(entry.vars, vars);
    into.set(host.name, entry);
  }
  return into;
}

/** The host_vars files. */
export function renderHostVars(map: HostVarsMap): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, { header, vars }] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
    files[`inventory/host_vars/${name}.yml`] = renderYaml(vars, {
      header: [`${name}: ${header.join(' ')}`, "These override the playbooks' answers for this host only."].join('\n'),
    });
  }
  return files;
}

/** Descriptions for vault.yml.example; any other vault_ name gets a generic line. */
const VAULT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  vault_windows_admin_user: 'local administrator Ansible connects as before the domain join',
  vault_windows_admin_password: 'password of vault_windows_admin_user',
  vault_domain_join_user: 'AD account that joins computers to the domain',
  vault_domain_join_password: 'password of vault_domain_join_user',
  vault_domain_admin_user: 'AD account allowed to promote domain controllers (Domain Admins)',
  vault_domain_admin_password: 'password of vault_domain_admin_user',
  vault_dsrm_password: 'Directory Services Restore Mode password for new domain controllers',
  vault_oracle_sys_password: 'Oracle SYS password',
  vault_oracle_system_password: 'Oracle SYSTEM password',
  vault_oracle_pdbadmin_password: 'Oracle PDB admin password',
  vault_mssql_sa_password: 'SQL Server sa password',
  vault_mssql_service_password: 'SQL Server service account password (domain accounts only; not used with gMSA)',
  vault_cluster_witness_storage_key: 'Azure storage account key for the cluster cloud witness',
  vault_postgres_password: 'PostgreSQL admin role password',
  vault_postgres_replication_password: 'PostgreSQL replication role password',
  vault_mysql_root_password: 'MySQL root password',
  vault_rhsm_activation_key: 'Red Hat activation key (BYOS registration)',
  vault_suse_regcode: 'SUSE Customer Center registration code (BYOS)',
  vault_splunk_uf_admin_password: 'Splunk Universal Forwarder admin password',
  vault_windows_local_user_password: 'password for the local user the Windows local-user playbook creates',
  vault_source_windows_user: 'account Ansible connects to the Windows source machines as',
  vault_source_windows_password: 'password of vault_source_windows_user',
};

/** Always listed, whether or not this site reads them: the design's and the kit's credential names. */
export const KNOWN_VAULT_NAMES: readonly string[] = Object.keys(VAULT_DESCRIPTIONS).filter((n) => !n.startsWith('vault_source_'));

/** Every vault_ name in a set of files. */
export function vaultNamesIn(files: Readonly<Record<string, string>>): string[] {
  const names = new Set<string>();
  for (const text of Object.values(files)) for (const m of text.matchAll(/\bvault_\w+/g)) names.add(m[0]);
  return [...names].sort();
}

/** group_vars/all/vault.yml.example: every name, empty. */
export function vaultExample(names: readonly string[]): string {
  const all = [...new Set([...names, ...KNOWN_VAULT_NAMES])].sort();
  const lines = [
    '# Every secret this project reads, with no values. Copy it to vault.yml in',
    '# this folder, fill it in, and encrypt it:',
    '#   ansible-vault encrypt inventory/group_vars/all/vault.yml',
    '# then run with --ask-vault-pass or ANSIBLE_VAULT_PASSWORD_FILE.',
    '# Ansible ignores this .example file; it reads vault.yml.',
    '---',
  ];
  for (const n of all) lines.push(`# ${VAULT_DESCRIPTIONS[n] ?? 'a secret a playbook here reads'}`, `${n}: ""`);
  return `${lines.join('\n')}\n`;
}

/** The addresses of the domain controllers the plan keeps (retained on premises), both families. */
export function onPremDcAddresses(plan: Plan, decision: PlanDecision): string[] {
  const out: string[] = [];
  for (const w of plan.workloads) {
    if (w.role !== 'ad-dc') continue;
    const d = decision.items[w.id];
    if (d && d.method !== 'none') continue;
    for (const ip of w.facts?.ipAddresses ?? []) {
      const fam = familyOf(ip.trim());
      if ((fam === 4 || fam === 6) && !/^fe[89ab]/i.test(ip.trim()) && !out.includes(ip.trim())) out.push(ip.trim());
    }
  }
  return out;
}

export interface GroupVarsInput {
  readonly plan: Plan;
  readonly design: TargetDesign;
  readonly model: InventoryModel;
}

/** inventory/group_vars/*: connection settings, per-engine defaults, the security agents. */
export function groupVars({ plan, design, model }: GroupVarsInput, findings: Finding[]): Record<string, string> {
  const files: Record<string, string> = {};
  const put = (group: string, header: string, vars: Record<string, YamlValue>): void => {
    files[`inventory/group_vars/${group}.yml`] = renderYaml(vars, { header });
  };
  const hasGroup = (g: string): boolean => model.hosts.some((h) => h.groups.includes(g));

  if (hasGroup('linux')) {
    put('linux', [
      'Linux targets: the ansible user cloud-init creates (key only, sudo).',
      "A new VM's host key is accepted the first time and checked from then on.",
    ].join('\n'), {
      ansible_user: 'ansible',
      ansible_become: true,
      ansible_ssh_extra_args: '-o StrictHostKeyChecking=accept-new',
    });
  }
  if (hasGroup('windows')) {
    put('windows', [
      'Windows targets: WinRM over HTTPS (5986), which the Terraform bootstrap opens',
      'from the management ranges only. NTLM with the local administrator until the',
      'domain join; the join play can switch to Kerberos after it.',
    ].join('\n'), {
      ansible_connection: 'winrm',
      ansible_port: 5986,
      ansible_winrm_transport: 'ntlm',
      ansible_user: '{{ vault_windows_admin_user }}',
      ansible_password: '{{ vault_windows_admin_password }}',
    });
  }
  if (hasGroup('bootstrap_windows')) {
    put('bootstrap_windows', [
      'Why this file exists: the Terraform bootstrap gives each Windows VM a',
      'self-signed WinRM certificate, which no CA vouches for until AD CS (or',
      'your PKI) issues one. Until then the certificate cannot be validated.',
      'Delete this file once the hosts have CA-issued certificates; WinRM then',
      'validates them as usual.',
    ].join('\n'), {
      ansible_winrm_server_cert_validation: 'ignore',
    });
    findings.push(warning('plan.ansible.winrm-cert-ignore', 'Windows hosts start with self-signed WinRM certificates, so group_vars/bootstrap_windows.yml turns certificate validation off for them.', {
      path: 'ansible/inventory/group_vars/bootstrap_windows.yml',
      remediation: 'Issue certificates from AD CS or your PKI, then delete that file.',
    }));
  }

  for (const pd of design.platforms) {
    const p = pd.platform;
    if (!hasGroup(`platform_${p}`) || p === 'vmware') continue;
    const vars: Record<string, YamlValue> = {};
    const header: string[] = [];
    if (p === 'aws') {
      header.push(
        'AWS: Linux hosts are reached through Session Manager, which needs no inbound',
        'port. The bucket is the landing zone\'s log bucket; export its name first:',
        '  export ATK_AWS_SSM_BUCKET=$(terraform -chdir=../terraform/aws output -raw landing-zone_log_destination | sed \'s/^arn:aws:s3::://\')',
        'Windows hosts use WinRM (group_vars/windows.yml wins over this file).',
      );
      vars.ansible_connection = 'amazon.aws.aws_ssm';
      vars.ansible_aws_ssm_region = pd.region;
      vars.ansible_aws_ssm_bucket_name = "{{ lookup('ansible.builtin.env', 'ATK_AWS_SSM_BUCKET') }}";
    } else if (p === 'google' && pd.bastion === 'cloud-native') {
      header.push('Google Cloud (GCP): SSH goes through Identity-Aware Proxy TCP forwarding; no public address is needed.');
      vars.ansible_ssh_common_args = "-o ProxyCommand='gcloud compute start-iap-tunnel {{ inventory_hostname }} %p --listen-on-stdin --zone={{ zone | basename }} --project={{ project }}'";
    } else if (pd.bastion === 'jump-vm') {
      header.push(`${PLATFORM_LABELS[p]}: SSH through the jump VM; set atk_jump_host to its address (user@host).`);
      vars.atk_jump_host = '';
      vars.ansible_ssh_common_args = '-o ProxyJump={{ atk_jump_host }}';
      findings.push(warning('plan.ansible.jump-host', `${PLATFORM_LABELS[p]}: the landing zone has a jump VM; set atk_jump_host in group_vars/platform_${p}.yml before running.`, {
        path: `ansible/inventory/group_vars/platform_${p}.yml`,
      }));
    } else if (pd.bastion === 'cloud-native') {
      findings.push(info('plan.ansible.bastion-reach', `${PLATFORM_LABELS[p]}: the managed bastion does not proxy Ansible's SSH or WinRM, so run Ansible from where the private addresses are reachable (a VM in the management subnet, or over the VPN or circuit).`));
    }
    if (Object.keys(vars).length > 0) put(`platform_${p}`, header.join('\n'), vars);
  }

  // Per-engine defaults.
  const engineDefaults: Record<string, Record<string, YamlValue>> = {};
  const scratch: Finding[] = [];
  for (const { db } of model.dbHosts) {
    const group = db.engine === 'mariadb' ? 'db_mysql' : `db_${db.engine}`;
    if (engineDefaults[group] || !['db_oracle', 'db_sqlserver', 'db_postgres', 'db_mysql'].includes(group)) continue;
    const v = roleVersion(db, scratch);
    if (group === 'db_oracle') {
      engineDefaults[group] = { oracle_version: v, oracle_media_url: '' };
    } else if (group === 'db_sqlserver') {
      engineDefaults[group] = { mssql_version: v, mssql_media_path: '', mssql_port: 1433 };
    } else if (group === 'db_postgres') {
      engineDefaults[group] = { postgres_version: v, postgres_port: 5432 };
    } else {
      engineDefaults[group] = { mysql_port: 3306 };
    }
  }
  for (const [group, vars] of Object.entries(engineDefaults)) {
    put(group, `Defaults for every ${group.slice(3)} host; host_vars/<host>.yml overrides them per host.`, vars);
  }
  if (engineDefaults.db_oracle) {
    findings.push(warning('plan.ansible.oracle-media', 'Oracle media needs a licence acceptance, so it is never downloaded for you: set oracle_media_url in group_vars/db_oracle.yml to your internal repository.', {
      path: 'ansible/inventory/group_vars/db_oracle.yml',
    }));
  }
  if (engineDefaults.db_sqlserver && model.dbHosts.some((d) => d.db.engine === 'sqlserver' && d.host.kind === 'windows')) {
    findings.push(info('plan.ansible.mssql-media', 'SQL Server on Windows installs from your media: set mssql_media_path in group_vars/db_sqlserver.yml (a UNC path or URL); hosts on a SQL Server image skip the install.', {
      path: 'ansible/inventory/group_vars/db_sqlserver.yml',
    }));
  }

  // Source machines.
  if (model.sources.some((s) => s.kind === 'linux')) {
    put('sources_linux', 'Linux source machines: the account Ansible uses on premises (key only, sudo).', { ansible_user: 'ansible', ansible_become: true });
  }
  if (model.sources.some((s) => s.kind === 'windows')) {
    put('sources_windows', 'Windows source machines: WinRM over HTTPS with the account in the vault. Their certificates are validated.', {
      ansible_connection: 'winrm',
      ansible_port: 5986,
      ansible_winrm_transport: 'ntlm',
      ansible_user: '{{ vault_source_windows_user }}',
      ansible_password: '{{ vault_source_windows_password }}',
    });
  }

  // EDR and vulnerability-scanner agents.
  const agents = securityAgents(plan);
  files['inventory/group_vars/all/security_agents.yml'] = renderYaml({ edr_agents: agents.edr as unknown as YamlValue, scanner_agents: agents.scanner as unknown as YamlValue }, {
    header: [
      'EDR and vulnerability-scanner agents to put on every migrated host, from the',
      'plan\'s security services: the package names and install sources you named.',
      'Each entry: name, linux_package, linux_source, windows_package,',
      'windows_source, service.',
    ].join('\n'),
  });
  const missing = [...agents.edr, ...agents.scanner].filter((a) => !a.linux_source && !a.windows_source && !a.linux_package && !a.windows_package);
  for (const a of missing) {
    findings.push(warning('plan.ansible.agent-no-source', `${a.name}: no package or install source is named, so it cannot be installed on the migrated hosts.`, {
      remediation: 'Add linux_package / linux_source / windows_source to the security service\'s row.',
    }));
  }
  if (agents.edr.length + agents.scanner.length > 0) {
    findings.push(info('plan.ansible.agents-listed', `${agents.edr.length} EDR and ${agents.scanner.length} scanner agent${agents.edr.length + agents.scanner.length === 1 ? ' is' : 's are'} listed in group_vars/all/security_agents.yml for the post-migration agent play.`, {
      path: 'ansible/inventory/group_vars/all/security_agents.yml',
    }));
  }
  return files;
}
