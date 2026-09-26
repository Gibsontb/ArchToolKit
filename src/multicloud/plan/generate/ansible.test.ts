import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { readYaml, type YamlData } from '../../../core/yaml-read.ts';
import type { Json } from '../../../editor/doc.ts';
import { findAnsibleBlueprint } from '../../../ansible/blueprints/index.ts';
import { buildSite } from '../../../ansible/site.ts';
import type { Blueprint } from '../../../kit/blueprint.ts';
import { openEnvelope, readSettings } from '../../../kit/settings-file.ts';
import { designPlan } from '../design/index.ts';
import { defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../options.ts';
import type {
  App, AppPlan, Database, DbServiceId, InfraItem, ItemDecision, Method, Plan, PlanDecision, Platform, TargetDesign, WavePlan, Workload,
} from '../types.ts';
import { ansibleFiles, planToSite, siteEnvelope } from './ansible.ts';
import {
  DYNAMIC_FILES, DYNAMIC_PLUGINS, groupsInPattern, hostsMatching, KNOWN_VAULT_NAMES, NAME_VAR, TAG_VAR, type DynamicPlatform,
} from './inventory.ts';

// ---------------------------------------------------------------------------
// The fixture: every platform, every engine the site installs
// ---------------------------------------------------------------------------

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app: 'shop', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  };
}
function database(name: string, over: Partial<Database> = {}): Database {
  return {
    id: itemId('database', name), name, engine: 'postgres', edition: 'community', version: 'pg-16', hosts: [], vcpu: 4, ramGib: 32,
    sizeGib: 200, ha: 'none', dr: 'none', features: [], licence: 'community', app: 'shop', source: 'manual', ...over,
  };
}
const app = (name: string, over: Partial<App> = {}): App => ({
  id: itemId('app', name), name, criticality: 'tier1', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over,
});

interface Placement { readonly platform: Platform; readonly method: Method; readonly service?: DbServiceId }

const W: readonly (readonly [Workload, Placement | null])[] = [
  // AWS: Windows web replicated, a Linux web and app rebuilt, PostgreSQL and MySQL on EC2, a host whose DB goes to RDS.
  [workload('web01', { role: 'web', os: 'win-2022', facts: { ipAddresses: ['10.0.1.11', 'fd00:10::11'] } }), { platform: 'aws', method: 'replicate' }],
  [workload('web02', { role: 'web', os: 'win-2022' }), { platform: 'aws', method: 'replicate' }],
  [workload('lweb01', { role: 'web', os: 'rhel-9', licence: 'rhel-byos' }), { platform: 'aws', method: 'rebuild' }],
  [workload('app01', { vcpu: 4, ramGib: 16 }), { platform: 'aws', method: 'rebuild' }],
  [workload('lweb02', { role: 'web', os: 'rhel-9', app: 'orders' }), { platform: 'aws', method: 'rebuild' }],
  [workload('pgvm01', { role: 'db', app: 'orders' }), { platform: 'aws', method: 'rebuild' }],
  [workload('pgvm02', { role: 'db', app: 'orders' }), { platform: 'aws', method: 'rebuild' }],
  [workload('my01', { role: 'db', app: 'catalog', os: 'ubuntu-24.04' }), { platform: 'aws', method: 'rebuild' }],
  [workload('pg01', { role: 'db', app: 'orders' }), { platform: 'aws', method: 'managed-db' }],
  // Azure: two SQL Server VMs in an availability group, and a relocating VM.
  [workload('sql01', { role: 'db', os: 'win-2022', vcpu: 8, ramGib: 64, app: 'Sales App', licence: 'byol-sa' }), { platform: 'azure', method: 'rebuild' }],
  [workload('sql02', { role: 'db', os: 'win-2022', vcpu: 8, ramGib: 64, app: 'Sales App', licence: 'byol-sa' }), { platform: 'azure', method: 'rebuild' }],
  [workload('avs01', { app: 'legacy', facts: { ipAddresses: ['fe80::1', '10.9.0.5'] } }), { platform: 'azure', method: 'relocate-hcx' }],
  // Google Cloud: an app server with an upper-case name, SQL Server on Linux.
  [workload('GApp01', { app: 'ledger' }), { platform: 'google', method: 'rebuild' }],
  [workload('gsql01', { role: 'db', app: 'ledger' }), { platform: 'google', method: 'rebuild' }],
  // OCI: two Oracle hosts on compute, one rebuilt and one replicated.
  [workload('ora01', { role: 'db', os: 'ol-8', vcpu: 8, ramGib: 64, app: 'erp' }), { platform: 'oci', method: 'rebuild' }],
  [workload('ora02', { role: 'db', os: 'ol-8', vcpu: 8, ramGib: 64, app: 'erp' }), { platform: 'oci', method: 'replicate' }],
  // VCF: one rebuilt from a template, one replicated keeping its address.
  [workload('vm01', { app: 'intranet' }), { platform: 'vmware', method: 'rebuild' }],
  [workload('vm02', { app: 'intranet', facts: { ipAddresses: ['10.20.0.7'] } }), { platform: 'vmware', method: 'replicate' }],
  // The on-premises domain controller: retained; DNS and the join use its addresses.
  [workload('dc-onprem', { role: 'ad-dc', os: 'win-2019', app: 'Active Directory', facts: { ipAddresses: ['10.0.0.10', 'fd00:10::10'] } }), null],
];

const D: readonly (readonly [Database, Placement])[] = [
  [database('orders', { hosts: ['pgvm01', 'pgvm02'], app: 'orders', ha: 'pg-streaming' }), { platform: 'aws', method: 'rebuild', service: 'aws-ec2' }],
  [database('catalog', { engine: 'mysql', edition: 'community', version: 'mysql-8.0', hosts: ['my01'], app: 'catalog' }), { platform: 'aws', method: 'rebuild', service: 'aws-ec2' }],
  [database('legacyorders', { hosts: ['pg01'], app: 'orders' }), { platform: 'aws', method: 'managed-db', service: 'aws-rds' }],
  [database('sales', { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', hosts: ['sql01', 'sql02'], ha: 'sql-ag', licence: 'byol-sa', app: 'Sales App' }), { platform: 'azure', method: 'rebuild', service: 'azure-sqlvm' }],
  [database('ledgersql', { engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2019', hosts: ['gsql01'], app: 'ledger', licence: 'li' }), { platform: 'google', method: 'rebuild', service: 'google-gce' }],
  [database('erp', { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', hosts: ['ora01', 'ora02'], vcpu: 8, ramGib: 64, licence: 'oracle-processor', app: 'erp', dr: 'data-guard-remote' }), { platform: 'oci', method: 'rebuild', service: 'oci-compute' }],
];

function decisionItem(id: string, kind: 'workload' | 'database', p: Placement | null): ItemDecision {
  if (!p) return { id, kind, disposition: 'retain', method: 'none', options: [], pinned: false, margin: 0, findings: [] };
  const chosen = { platform: p.platform, score: 10, hits: [], ...(p.service ? { service: p.service } : {}) };
  return { id, kind, disposition: p.method === 'relocate-hcx' ? 'relocate' : 'rehost', method: p.method, options: [chosen], chosen, pinned: false, margin: 5, findings: [] };
}

const SHOP_PLAN: AppPlan = {
  app: itemId('app', 'shop'), origin: 'migrate', status: 'planned', platform: 'aws', answers: {}, landingZone: 'included',
  variants: {
    aws: [
      { id: 'c:shop:web', name: 'Web tier', tier: 'web', kind: 'pattern', servers: ['lweb01'], databases: [], settings: {} },
      { id: 'c:shop:ssh', name: 'SSH hardening', tier: 'web', kind: 'config', blueprintId: 'linux_harden_ssh', values: {}, appliesTo: ['c:shop:web'], order: 1 },
      { id: 'c:shop:patch', name: 'Patching', tier: 'app', kind: 'config', blueprintId: 'linux_patch', values: {}, appliesTo: ['app01'], order: 2 },
    ],
  },
};

const EDR: InfraItem = {
  id: 'i:edr', category: 'security-service', name: 'Endpoint protection', vendor: 'Example', disposition: 'migrate',
  facts: { kind: 'EDR', product: 'Example Sensor', linux_package: 'example-sensor', linux_source: 'https://repo.example.internal/sensor.rpm', windows_source: '\\\\files\\sensor.msi', service: 'example-sensor' },
};

function fixture(over: Partial<Plan> = {}): { plan: Plan; decision: PlanDecision; design: TargetDesign } {
  const base = defaultRequirements();
  const plan: Plan = {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-wp8', name: 'Mixed Move', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: W.map(([w]) => w),
    databases: D.map(([d]) => d),
    apps: [app('shop', { wave: 1 }), app('Sales App'), app('erp'), app('ledger'), app('intranet'), app('orders'), app('catalog'), app('legacy')],
    edges: [],
    requirements: {
      ...base,
      allowed: ['aws', 'azure', 'google', 'oci', 'vmware'],
      maxPlatforms: 5,
      regions: { aws: { primary: 'us-east-1' }, azure: { primary: 'eastus' }, google: { primary: 'us-central1' }, oci: { primary: 'us-ashburn-1' }, vmware: { primary: 'wld01-vc01.corp.example.com' } },
      sites: [{ name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.0.0.0/16', 'fd00:10::/48'], bandwidth: '1g', circuit: 'none' }],
      connection: 'vpn',
      siem: 'splunk',
    },
    designOverrides: { 'google:lz:scope': 'my-project' },
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    appPlans: [SHOP_PLAN],
    dcExit: { dualRunningDays: 30, hardwareRemovalDays: 30, infra: [EDR], external: [], contracts: [], assets: [] } as unknown as Plan['dcExit'],
    ...over,
  };
  const items: Record<string, ItemDecision> = {};
  for (const [w, p] of W) items[w.id] = decisionItem(w.id, 'workload', p);
  for (const [d, p] of D) items[d.id] = decisionItem(d.id, 'database', p);
  const decision: PlanDecision = { engineVersion: 'test', platforms: ['aws', 'azure', 'google', 'oci', 'vmware'], subsetScores: [], items, findings: [] };
  return { plan, decision, design: designPlan(plan, decision) };
}

const MIXED = fixture();
const OUT = ansibleFiles(MIXED.plan, MIXED.decision, MIXED.design);
const SITE = planToSite(MIXED.plan, MIXED.decision, MIXED.design);
const F = (path: string): string => OUT.files[`ansible/${path}`] ?? '';
const yaml = (path: string): YamlData | undefined => readYaml(F(path)).documents[0];
const asMap = (d: YamlData | undefined): Record<string, YamlData> => (d && typeof d === 'object' && !Array.isArray(d) ? d : {});

// ---------------------------------------------------------------------------
// A small evaluator for the Jinja the plugin configs use
// ---------------------------------------------------------------------------

/** Split at a separator outside quotes and brackets. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === "'") quote = false;
      continue;
    }
    if (c === "'") quote = true;
    else if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth -= 1;
    else if (depth === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim());
}

const strings = (text: string): string[] => [...text.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));

function lookupPath(vars: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), vars);
}

function evalCond(expr: string, vars: Record<string, unknown>): boolean {
  if (expr.trim() === 'true') return true;
  return splitTop(expr, ' or ').some((term) => splitTop(term, ' and ').every((atom) => {
    const m = /^\((\S+) \| default\(''\)\) (==|in|not in) (.+)$/.exec(atom);
    if (!m) throw new Error(`Unreadable condition: ${atom}`);
    const v = String(lookupPath(vars, m[1]!) ?? '');
    const values = strings(m[3]!);
    return m[2] === 'not in' ? !values.includes(v) : values.includes(v);
  }));
}

function evalKey(key: string, vars: Record<string, unknown>): string {
  const m = /^(\S+) \| default\(''\) \| lower \| regex_replace\('\[\^a-z0-9_\]', '_'\)$/.exec(key);
  if (!m) throw new Error(`Unreadable key: ${key}`);
  return String(lookupPath(vars, m[1]!) ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/** A host's variables as the plugin would give them. */
function pluginVars(p: DynamicPlatform, h: { name: string; tags: Readonly<Record<string, string>> }): Record<string, unknown> {
  const nameVar = NAME_VAR[p];
  const vars: Record<string, unknown> = { [TAG_VAR[p]]: { ...h.tags } };
  if (nameVar.includes('.')) (vars[TAG_VAR[p]] as Record<string, string>).Name = h.name;
  else vars[nameVar] = h.name;
  return vars;
}

/** The groups a plugin config puts a host in. */
function groupsFromConfig(p: DynamicPlatform, config: Record<string, YamlData>, h: { name: string; tags: Readonly<Record<string, string>> }): Set<string> {
  const vars = pluginVars(p, h);
  const out = new Set<string>();
  for (const k of (config.keyed_groups ?? []) as { prefix: string; key: string }[]) {
    const v = evalKey(k.key, vars);
    if (v) out.add(`${k.prefix}_${v}`);
  }
  const conditional = asMap(config[p === 'azure' ? 'conditional_groups' : 'groups']);
  for (const [g, expr] of Object.entries(conditional)) if (evalCond(String(expr), vars)) out.add(g);
  return out;
}

/** Is the host kept by the config's filters? */
function keptByConfig(p: DynamicPlatform, config: Record<string, YamlData>, h: { name: string; tags: Readonly<Record<string, string>> }): boolean {
  const vars = pluginVars(p, h);
  if (p === 'aws') return (asMap(config.filters)['tag:atk_app'] as string[]).includes(h.tags.atk_app ?? '');
  if (p === 'google') return String((config.filters as string[])[1]).includes(`"${h.tags.atk_app}"`);
  return !((config.exclude_host_filters ?? []) as string[]).some((e) => evalCond(e, vars));
}

const usedGroups = (items: readonly { values: Record<string, unknown> }[]): string[] =>
  [...new Set(items.flatMap((i) => groupsInPattern(String(i.values.hosts ?? ''))))].sort();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generate/ansible: the project layout', () => {
  it('writes the playbookDir layout: site.yml, playbooks/, roles/, inventory/ with the vars, ansible.cfg', () => {
    for (const f of ['ansible.cfg', 'site.yml', 'requirements.yml', 'README.md', 'archtoolkit-ansible-settings.json', 'inventory/hosts.yml', 'inventory/group_vars/all/vault.yml.example']) {
      expect(Object.keys(OUT.files)).toContain(`ansible/${f}`);
    }
    expect(F('ansible.cfg')).toContain('inventory = inventory');
    expect(F('ansible.cfg')).toContain('roles_path = ./roles');
    expect(F('site.yml')).toContain('import_playbook: playbooks/00-');
    expect(F('site.yml')).toContain('import_playbook: playbooks/60-validate.yml');
    expect(Object.keys(OUT.files).some((f) => /^ansible\/roles\/[a-z_]+\/tasks\/main\.yml$/.test(f))).toBe(true);
    // group_vars are beside the inventory, never at the top, and all.yml never sits beside all/ (Ansible reads only the folder).
    expect(Object.keys(OUT.files).some((f) => f.startsWith('ansible/group_vars/') || f.startsWith('ansible/host_vars/'))).toBe(false);
    expect(OUT.files['ansible/inventory/group_vars/all.yml']).toBeUndefined();
  });

  it('numbers the playbooks as the design orders them, config components after the roles', () => {
    const books = Object.keys(OUT.files).filter((f) => /^ansible\/playbooks\/\d\d-.*\.yml$/.test(f)).map((f) => f.slice('ansible/playbooks/'.length)).sort();
    const nn = books.map((b) => b.slice(0, 2));
    for (const n of ['00', '10', '11', '12', '13', '15', '20', '21', '30', '31', '32', '33', '34', '35', '40', '41', '45', '50', '60']) expect(nn).toContain(n);
    const order = SITE.items.map((i) => i.id);
    expect(order.indexOf('mig:41:nginx')).toBeLessThan(order.findIndex((id) => id.startsWith('mig:45:')));
    expect(order.findIndex((id) => id.startsWith('mig:45:'))).toBeLessThan(order.indexOf('mig:50:monitoring'));
  });

  it('parses every YAML file it writes', () => {
    for (const [path, text] of Object.entries(OUT.files)) {
      if (!/\.ya?ml(\.example)?$/.test(path)) continue;
      const r = readYaml(text);
      expect(r.documents.length).toBeGreaterThan(0);
    }
  });

  it('writes no footprint, no placeholder password and no literal credential', () => {
    for (const [path, text] of Object.entries(OUT.files)) {
      expect(/generated by|CHANGEME/i.test(text)).toBe(false);
      if (path.includes('vault.yml.example')) continue;
      expect(/^\s*(ansible_password|password):\s*(?!["']?\{\{)\S+/m.test(text)).toBe(false);
    }
  });
});

describe('generate/ansible: dynamic inventories', () => {
  const dynamic: DynamicPlatform[] = ['aws', 'azure', 'google', 'oci'];

  it('writes one plugin config per hyperscaler in the plan, named as each plugin requires', () => {
    for (const p of dynamic) {
      const doc = asMap(yaml(DYNAMIC_FILES[p].replace(/^ansible\//, '')));
      expect(doc.plugin).toBe(DYNAMIC_PLUGINS[p]);
    }
    expect(DYNAMIC_FILES.oci.endsWith('.oci.yml')).toBe(true);
    expect(DYNAMIC_FILES.aws.endsWith('aws_ec2.yml')).toBe(true);
    expect(DYNAMIC_FILES.azure.endsWith('azure_rm.yml')).toBe(true);
    expect(DYNAMIC_FILES.google.endsWith('gcp_compute.yml')).toBe(true);
    expect(F('inventory/vmware_vms.yml')).toBe('');
  });

  it('keys only on tags Terraform writes, and never filters on atk_plan', () => {
    for (const p of dynamic) {
      const text = F(DYNAMIC_FILES[p]);
      expect(text.includes('atk_plan')).toBe(false);
      expect(text.includes('atk_db ')).toBe(false);
      for (const m of text.matchAll(/(?:ec2_tags|tags|labels|freeform_tags)\.(atk_[a-z_]+)/g)) {
        expect(['atk_app', 'atk_role', 'atk_env', 'atk_os', 'atk_os_family', 'atk_wave', 'atk_backup', 'atk_phase', 'atk_component']).toContain(m[1]);
      }
    }
  });

  it('produces exactly the groups the items name, with the same hosts in them (cross-check)', () => {
    const used = usedGroups(SITE.items);
    const staticHosts = [...SITE.model.hosts.filter((h) => h.route === 'static'), ...SITE.model.sources];
    // Every group a play names comes from somewhere.
    const producible = new Set<string>(['sources']);
    for (const h of staticHosts) for (const g of h.groups) producible.add(g);
    for (const p of dynamic) {
      const config = asMap(yaml(DYNAMIC_FILES[p]));
      const here = SITE.model.hosts.filter((h) => h.route === 'dynamic' && h.platform === p);
      expect(here.length).toBeGreaterThan(0);
      for (const h of here) {
        expect(keptByConfig(p, config, h)).toBe(true);
        const got = groupsFromConfig(p, config, h);
        for (const g of got) producible.add(g);
        // The config gives the host exactly the groups the model says it is in.
        expect([...got].sort()).toEqual([...h.groups].sort());
      }
    }
    for (const g of used) expect(producible.has(g)).toBe(true);
    // Membership of every used group: the same through the configs as in the model.
    for (const g of used) {
      const viaModel = SITE.model.hosts.filter((h) => h.groups.includes(g)).map((h) => h.name).sort();
      const viaRoutes = [
        ...dynamic.flatMap((p) => {
          const config = asMap(yaml(DYNAMIC_FILES[p]));
          return SITE.model.hosts.filter((h) => h.route === 'dynamic' && h.platform === p && groupsFromConfig(p, config, h).has(g)).map((h) => h.name);
        }),
        ...SITE.model.hosts.filter((h) => h.route === 'static' && h.groups.includes(g)).map((h) => h.name),
      ].sort();
      expect(viaRoutes).toEqual(viaModel);
    }
  });

  it('puts the test launches of replicated VMs in wave_<n>_test, from the atk_phase tag', () => {
    const config = asMap(yaml(DYNAMIC_FILES.aws));
    const web01 = SITE.model.hosts.find((h) => h.name === 'web01')!;
    expect(web01.wave).toBe(1);
    const test = groupsFromConfig('aws', config, { name: 'web01', tags: { ...web01.tags, atk_phase: 'test' } });
    expect(test.has('wave_1_test')).toBe(true);
    expect(groupsFromConfig('aws', config, web01).has('wave_1_test')).toBe(false);
  });

  it('groups a MySQL host under db_mysql, not db_sqlserver (atk_db is not trusted)', () => {
    const my = SITE.model.hosts.find((h) => h.name === 'my01')!;
    expect(my.tags.atk_db).toBe('sqlserver');
    expect(my.groups).toContain('db_mysql');
    expect(my.groups.includes('db_sqlserver')).toBe(false);
  });

  it('lower-cases Google Cloud names and labels, and still gives the same group names', () => {
    const g = SITE.model.hosts.find((h) => h.workload === 'GApp01')!;
    expect(g.name).toBe('gapp01');
    expect(g.groups).toContain('app_ledger');
    const dc = SITE.model.hosts.filter((h) => h.groups.includes('role_ad_dc'));
    expect(dc.every((h) => h.groups.includes('app_active_directory'))).toBe(true);
  });

  it('filters a slice by the atk_app tag of the selected apps only', () => {
    const out = ansibleFiles(MIXED.plan, MIXED.decision, MIXED.design, { apps: ['orders'] });
    const aws = asMap(readYaml(out.files[`ansible/${DYNAMIC_FILES.aws}`]!).documents[0]);
    expect(asMap(aws.filters)['tag:atk_app']).toEqual(['orders']);
    expect(out.files[`ansible/${DYNAMIC_FILES.azure}`]).toBeUndefined();
  });
});

describe('generate/ansible: items and hosts', () => {
  it('leaves out every item whose pattern matches no host', () => {
    const everyone = [...SITE.model.hosts, ...SITE.model.sources];
    for (const i of SITE.items) expect(hostsMatching(String(i.values.hosts), everyone).length).toBeGreaterThan(0);
    const slice = planToSite(MIXED.plan, MIXED.decision, MIXED.design, { apps: ['erp'] });
    const ids = slice.items.map((i) => i.blueprintId);
    expect(ids).toContain('mig_oracle_db');
    for (const gone of ['mig_windows_baseline', 'mig_mssql_windows', 'mig_mssql_ag', 'mig_postgres_server', 'mig_mysql_server', 'install_iis', 'nginx_server', 'mig_ad_dc_promote']) {
      expect(ids.includes(gone)).toBe(false);
    }
  });

  it('never configures the source machines, and never installs a database over a replicated one', () => {
    const everyone = [...SITE.model.hosts, ...SITE.model.sources];
    for (const i of SITE.items) {
      for (const h of hostsMatching(String(i.values.hosts), everyone)) expect(h.name.startsWith('src-')).toBe(false);
    }
    const oracle = SITE.items.find((i) => i.blueprintId === 'mig_oracle_db')!;
    expect(hostsMatching(String(oracle.values.hosts), everyone).map((h) => h.name)).toEqual(['ora01']);
  });

  it('builds one domain-controller play per platform that gets DCs, in its own AD site', () => {
    const dcs = SITE.items.filter((i) => i.blueprintId === 'mig_ad_dc_promote');
    expect(dcs.length).toBeGreaterThan(0);
    for (const d of dcs) {
      expect(String(d.values.hosts)).toContain('role_ad_dc:&platform_');
      expect(String(d.values.site_name)).toContain('-');
      expect(String(d.values.dns_servers)).toContain('10.0.0.10');
    }
  });

  it('puts the configuration components on their component groups', () => {
    const ssh = SITE.items.find((i) => i.blueprintId === 'linux_harden_ssh')!;
    expect(ssh.values.hosts).toBe('comp_shop_ssh');
    expect(hostsMatching('comp_shop_ssh', SITE.model.hosts).map((h) => h.name)).toEqual(['lweb01']);
    expect(hostsMatching('comp_shop_patch', SITE.model.hosts).map((h) => h.name)).toEqual(['app01']);
    // The app's own configuration replaces the generic web server.
    const nginx = SITE.items.find((i) => i.blueprintId === 'nginx_server');
    expect(nginx === undefined || hostsMatching(String(nginx.values.hosts), SITE.model.hosts).every((h) => h.name !== 'lweb01')).toBe(true);
  });

  it('adds the source-tools play when the kit has it', () => {
    expect(SITE.items.some((i) => i.blueprintId === 'mig_source_tools')).toBe(false);
    const stub = { ...findAnsibleBlueprint('mig_vmware_tools_removal')!, id: 'mig_source_tools' } as Blueprint;
    const lookup = (id: string): Blueprint | undefined => (id === 'mig_source_tools' ? stub : findAnsibleBlueprint(id));
    const site = planToSite(MIXED.plan, MIXED.decision, MIXED.design, { lookup });
    const i = site.items.find((x) => x.blueprintId === 'mig_source_tools')!;
    expect(i.id).toBe('mig:14:source-tools');
    expect(i.values.hosts).toBe('method_replicate');
  });

  it('builds the availability group on its SQL Server VMs, skipping the listener on Azure', () => {
    const ag = SITE.items.find((i) => i.blueprintId === 'mig_mssql_ag')!;
    expect(ag.values.platform).toBe('azure');
    expect(hostsMatching(String(ag.values.hosts), SITE.model.hosts).map((h) => h.name).sort()).toEqual(['sql01', 'sql02']);
  });
});

describe('generate/ansible: vars', () => {
  it('writes host_vars for every IaaS database host, with its engine settings', () => {
    const want: Record<string, string[]> = {
      ora01: ['oracle_sid: ERP', 'oracle_version: 19c', 'oracle_dr: data-guard-remote'],
      ora02: ['oracle_sid: ERP'],
      sql01: ['mssql_edition: Enterprise', 'mssql_preinstalled: true', 'mssql_ag_name: sales'],
      sql02: ['mssql_version: \'2022\''],
      gsql01: ['mssql_edition: Standard', "mssql_version: '2019'"],
      pgvm01: ['postgres_ha: pg-streaming', 'postgres_primary: pgvm01'],
      pgvm02: ['postgres_version: \'16\''],
      my01: ['mysql_flavour: mysql', "mysql_version: '8.0'"],
    };
    for (const [host, lines] of Object.entries(want)) {
      const text = F(`inventory/host_vars/${host}.yml`);
      expect(text.length).toBeGreaterThan(0);
      for (const l of lines) expect(text).toContain(l);
    }
    expect(F('inventory/host_vars/lweb01.yml')).toContain('linux_baseline_licence: byos');
  });

  it('lists every vault_ variable the project reads in vault.yml.example, with no values', () => {
    const example = F('inventory/group_vars/all/vault.yml.example');
    const listed = new Set([...example.matchAll(/^(vault_\w+):\s*""$/gm)].map((m) => m[1]));
    const referenced = new Set<string>();
    for (const [path, text] of Object.entries(OUT.files)) {
      if (path.endsWith('vault.yml.example')) continue;
      for (const m of text.matchAll(/vault_\w+/g)) referenced.add(m[0]);
    }
    expect(referenced.size).toBeGreaterThan(5);
    for (const n of referenced) expect(listed.has(n)).toBe(true);
    for (const n of KNOWN_VAULT_NAMES) expect(listed.has(n)).toBe(true);
    for (const n of ['vault_domain_admin_user', 'vault_domain_admin_password', 'vault_oracle_pdbadmin_password', 'vault_postgres_replication_password', 'vault_cluster_witness_storage_key', 'vault_rhsm_activation_key', 'vault_suse_regcode', 'vault_splunk_uf_admin_password', 'vault_windows_local_user_password']) {
      expect(listed.has(n)).toBe(true);
    }
    expect(/^vault_\w+:\s*\S/m.test(example.replace(/: ""$/gm, ''))).toBe(false);
  });

  it('connects per OS and platform: WinRM with vault credentials, Session Manager on AWS, IAP on Google Cloud', () => {
    expect(F('inventory/group_vars/windows.yml')).toContain("ansible_password: '{{ vault_windows_admin_password }}'");
    expect(F('inventory/group_vars/bootstrap_windows.yml')).toContain('ansible_winrm_server_cert_validation: ignore');
    expect(F('inventory/group_vars/windows.yml').includes('cert_validation')).toBe(false);
    expect(F('inventory/group_vars/platform_aws.yml')).toContain('amazon.aws.aws_ssm');
    expect(F('inventory/group_vars/linux.yml')).toContain('ansible_user: ansible');
  });

  it('writes the EDR and scanner agents the plan names into group_vars', () => {
    const doc = asMap(yaml('inventory/group_vars/all/security_agents.yml'));
    const edr = doc.edr_agents as Record<string, string>[];
    expect(edr).toHaveLength(1);
    expect(edr[0]!.name).toBe('Example Sensor');
    expect(edr[0]!.linux_package).toBe('example-sensor');
    expect(doc.scanner_agents).toEqual([]);
  });

  it('lists the relocated and VCF VMs statically, with their addresses, and the sources separately', () => {
    const vm = asMap(asMap(asMap(yaml('inventory/hosts_vmware.yml')).all).hosts);
    expect(asMap(vm.vm02).ansible_host).toBe('10.20.0.7');
    expect(asMap(vm.avs01).ansible_host).toBe('10.9.0.5');
    const avs = SITE.model.hosts.find((h) => h.name === 'avs01')!;
    expect(avs.groups).toContain('platform_vmware');
    expect(avs.groups.includes('os_kind_linux')).toBe(false);
    const src = asMap(asMap(asMap(yaml('inventory/sources.yml')).all).children);
    expect(Object.keys(asMap(asMap(src.wave_1_sources).hosts))).toContain('src-web01');
  });
});

describe('generate/ansible: waves', () => {
  it('uses the wave plan for wave_<n>, wave_<n>_sources and wave_<n>_test', () => {
    const waves: WavePlan = {
      settings: DEFAULT_WAVE_SETTINGS, findings: [],
      waves: [{ n: 2, groups: ['g1'] }],
      groups: [{ id: 'g1', items: [itemId('workload', 'ora02'), itemId('workload', 'ora01')], why: 'test', wave: 2, method: 'replicate' }],
    };
    const site = planToSite(MIXED.plan, MIXED.decision, MIXED.design, { waves });
    const ora02 = site.model.hosts.find((h) => h.name === 'ora02')!;
    expect(ora02.groups).toContain('wave_2');
    expect(site.model.testWaves.oci).toEqual([2]);
    expect(site.model.sources.find((s) => s.name === 'src-ora02')!.groups).toContain('wave_2_sources');
    const out = ansibleFiles(MIXED.plan, MIXED.decision, MIXED.design, { waves });
    const oci = asMap(readYaml(out.files[`ansible/${DYNAMIC_FILES.oci}`]!).documents[0]);
    expect(Object.keys(asMap(oci.groups))).toContain('wave_2_test');
    expect(Object.keys(asMap(oci.groups))).toContain('wave_2');
  });
});

describe('generate/ansible: the envelope', () => {
  it('loads through openEnvelope as the Ansible page\'s settings, dated with the plan', () => {
    const read = readSettings(F('archtoolkit-ansible-settings.json'), 'archtoolkit-ansible-settings.json');
    const opened = openEnvelope(read as Json, 'archtoolkit.ansible-generator');
    expect('ok' in opened).toBe(true);
    expect(OUT.envelope.savedAt).toBe(MIXED.plan.savedAt);
    expect(OUT.envelope.stack.length).toBe(SITE.items.length);
    for (const s of OUT.envelope.stack) for (const v of Object.values(s.values)) expect(typeof v).toBe('string');
  });

  it('rebuilds to the same playbooks from the envelope\'s stack', () => {
    const env = siteEnvelope(MIXED.plan, SITE);
    const a = buildSite(SITE.items, findAnsibleBlueprint, { playbookDir: 'playbooks' });
    const b = buildSite(env.stack, findAnsibleBlueprint, { playbookDir: 'playbooks' });
    const books = (x: typeof a): string[] => Object.entries(x.files).filter(([f]) => f.startsWith('playbooks/')).map(([f, t]) => `${f}\n${t}`).sort();
    expect(books(b)).toEqual(books(a));
  });

  it('is reproducible: the same plan gives the same files', () => {
    const again = ansibleFiles(MIXED.plan, MIXED.decision, MIXED.design);
    expect(again.files).toEqual(OUT.files);
  });
});

