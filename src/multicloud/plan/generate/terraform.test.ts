import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import type { Json } from '../../../editor/doc.ts';
import type { Blueprint } from '../../../kit/blueprint.ts';
import { openEnvelope, readSettings, stripSecrets } from '../../../kit/settings-file.ts';
import type { StackItem } from '../../../kit/stack.ts';
import { parseGrid, VM_COLUMN_NAMES } from '../../../terraform/blueprints/migration/common.ts';
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.ts';
import { buildStack } from '../../../terraform/stack.ts';
import { designPlan, designWorkloads } from '../design/index.ts';
import { defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../options.ts';
import type {
  App, Database, DbServiceId, ItemDecision, Method, Plan, PlanDecision, Platform, Requirements, TargetDesign, Workload,
} from '../types.ts';
import {
  classCell, computeRowName, planToStacks, REQUIRED_VERSION, REQUIRED_VERSION_WRITE_ONLY, sensitiveVariables, terraformFiles,
  type PlanTerraformEnvelope, type PlatformStack,
} from './terraform.ts';

// ---------------------------------------------------------------------------
// The mixed fixture: every platform, every kind of item
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
  // AWS: web replicated, app rebuilt, a Postgres host whose database goes to RDS.
  [workload('web01', { role: 'web', os: 'win-2022', criticality: 'tier1', disksGib: [128] }), { platform: 'aws', method: 'replicate' }],
  [workload('web02', { role: 'web', os: 'win-2022', criticality: 'tier1', disksGib: [128] }), { platform: 'aws', method: 'replicate' }],
  [workload('app01', { vcpu: 4, ramGib: 16, disksGib: [64, 100] }), { platform: 'aws', method: 'rebuild' }],
  [workload('pg01', { role: 'db', app: 'orders' }), { platform: 'aws', method: 'managed-db' }],
  [workload('dev01', { env: 'dev', os: 'ubuntu-22.04', criticality: 'tier3', app: 'tools' }), { platform: 'aws', method: 'rebuild' }],
  // Azure: two SQL Server VMs with an availability group, and a relocating VM.
  [workload('sql01', { role: 'db', os: 'win-2022', vcpu: 8, ramGib: 64, disksGib: [128, 512], app: 'sales', licence: 'byol-sa' }), { platform: 'azure', method: 'rebuild' }],
  [workload('sql02', { role: 'db', os: 'win-2022', vcpu: 8, ramGib: 64, disksGib: [128, 512], app: 'sales', licence: 'byol-sa' }), { platform: 'azure', method: 'rebuild' }],
  [workload('avs01', { app: 'legacy' }), { platform: 'azure', method: 'relocate-hcx' }],
  // Google Cloud: an app server with an upper-case name.
  [workload('GApp01', { app: 'ledger' }), { platform: 'google', method: 'rebuild' }],
  // OCI: two Oracle hosts on compute.
  [workload('ora01', { role: 'db', os: 'ol-8', vcpu: 8, ramGib: 64, disksGib: [100, 500], app: 'erp' }), { platform: 'oci', method: 'rebuild' }],
  [workload('ora02', { role: 'db', os: 'ol-8', vcpu: 8, ramGib: 64, disksGib: [100, 500], app: 'erp' }), { platform: 'oci', method: 'replicate' }],
  // VCF: one rebuilt from a template, one replicated.
  [workload('vm01', { os: 'rhel-9', app: 'intranet' }), { platform: 'vmware', method: 'rebuild' }],
  [workload('vm02', { os: 'rhel-9', app: 'intranet' }), { platform: 'vmware', method: 'replicate' }],
  // The on-premises domain controller: retained, its address is what DNS forwards to.
  [workload('dc-onprem', { role: 'ad-dc', os: 'win-2019', app: 'Active Directory', facts: { ipAddresses: ['10.0.0.10', 'fd00:10::10'] } }), null],
];

const D: readonly (readonly [Database, Placement])[] = [
  [database('orders', { hosts: ['pg01'], app: 'orders' }), { platform: 'aws', method: 'managed-db', service: 'aws-rds' }],
  [database('erpx', { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', vcpu: 16, ramGib: 128, ha: 'rac', licence: 'oracle-processor', app: 'erpx' }), { platform: 'aws', method: 'managed-db', service: 'aws-odb-exadata' }],
  [database('sales', { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', hosts: ['sql01', 'sql02'], ha: 'sql-ag', licence: 'byol-sa', app: 'sales' }), { platform: 'azure', method: 'rebuild', service: 'azure-sqlvm' }],
  [database('crm', { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', vcpu: 8, ramGib: 64, ha: 'sql-ag', licence: 'byol-sa', app: 'crm' }), { platform: 'azure', method: 'managed-db', service: 'azure-sqlmi' }],
  [database('catalog', { engine: 'mysql', edition: 'community', version: 'mysql-8.0', app: 'shop' }), { platform: 'azure', method: 'managed-db', service: 'azure-mysql-flex' }],
  [database('ledgerdb', { app: 'ledger' }), { platform: 'google', method: 'managed-db', service: 'google-alloydb' }],
  [database('billing', { engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2022', app: 'ledger', licence: 'li' }), { platform: 'google', method: 'managed-db', service: 'google-cloudsql' }],
  [database('hrg', { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', app: 'hr', licence: 'oracle-processor' }), { platform: 'google', method: 'managed-db', service: 'google-odb-adb' }],
  [database('finb', { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', app: 'fin', licence: 'oracle-processor' }), { platform: 'google', method: 'managed-db', service: 'google-odb-basedb' }],
  [database('erp', { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', hosts: ['ora01', 'ora02'], vcpu: 8, ramGib: 64, ha: 'rac', licence: 'oracle-processor', app: 'erp' }), { platform: 'oci', method: 'managed-db', service: 'oci-basedb' }],
  [database('hr', { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', app: 'hr', licence: 'oracle-processor' }), { platform: 'oci', method: 'managed-db', service: 'oci-adb' }],
  [database('web', { engine: 'mysql', version: 'mysql-8.0', app: 'shop' }), { platform: 'oci', method: 'managed-db', service: 'oci-mysql-heatwave' }],
  [database('pgo', { app: 'shop' }), { platform: 'oci', method: 'managed-db', service: 'oci-pg' }],
];

function decisionItem(id: string, kind: 'workload' | 'database', p: Placement | null): ItemDecision {
  if (!p) return { id, kind, disposition: 'retain', method: 'none', options: [], pinned: false, margin: 0, findings: [] };
  const chosen = { platform: p.platform, score: 10, hits: [], ...(p.service ? { service: p.service } : {}) };
  return { id, kind, disposition: p.method === 'relocate-hcx' ? 'relocate' : 'rehost', method: p.method, options: [chosen], chosen, pinned: false, margin: 5, findings: [] };
}

export function fixture(req: Partial<Requirements> = {}, over: Partial<Plan> = {}): { plan: Plan; decision: PlanDecision; design: TargetDesign } {
  const base = defaultRequirements();
  const plan: Plan = {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-wp6', name: 'Mixed Move', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: W.map(([w]) => w),
    databases: D.map(([d]) => d),
    apps: [app('shop', { wave: 1 }), app('sales'), app('erp'), app('ledger'), app('intranet'), app('tools', { criticality: 'tier3' })],
    edges: [],
    requirements: {
      ...base,
      allowed: ['aws', 'azure', 'google', 'oci', 'vmware'],
      maxPlatforms: 5,
      regions: { aws: { primary: 'us-east-1', dr: 'us-west-2' }, azure: { primary: 'eastus' }, google: { primary: 'us-central1' }, oci: { primary: 'us-ashburn-1' }, vmware: { primary: 'wld01-vc01.corp.example.com' } },
      sites: [{ name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.0.0.0/16', 'fd00:10::/48'], bandwidth: '1g', circuit: 'none' }],
      connection: 'vpn',
      ...req,
    },
    designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    ...over,
  };
  const items: Record<string, ItemDecision> = {};
  for (const [w, p] of W) items[w.id] = decisionItem(w.id, 'workload', p);
  for (const [d, p] of D) items[d.id] = decisionItem(d.id, 'database', p);
  const decision: PlanDecision = { engineVersion: 'test', platforms: ['aws', 'azure', 'google', 'oci', 'vmware'], subsetScores: [], items, findings: [] };
  return { plan, decision, design: designPlan(plan, decision) };
}

export const MIXED = fixture();
export const FILES = terraformFiles(MIXED.plan, MIXED.decision, MIXED.design);
const STACKS = planToStacks(MIXED.plan, MIXED.decision, MIXED.design);

const itemOf = (stack: PlatformStack | undefined, suffix: string): StackItem | undefined => stack?.items.find((i) => i.blueprintId.endsWith(suffix));
const rows = (text: unknown): string[][] => String(text ?? '').split('\n').filter(Boolean).map((l) => l.split(' | ').map((c) => c.trim()));
const envelopeOf = (folder: string): PlanTerraformEnvelope => JSON.parse(FILES.files[`terraform/${folder}/archtoolkit-terraform-settings.json`]!) as PlanTerraformEnvelope;
const optionsOf = (env: PlanTerraformEnvelope) => ({ target: env.target, stackName: env.stackName, requiredVersion: env.requiredVersion, ...(env.backend ? { backend: env.backend } : {}) });

// ---------------------------------------------------------------------------
// The file tree and the envelope
// ---------------------------------------------------------------------------

describe('generate/terraform: the file tree', () => {
  it('gives every platform in the decision its root module, with every file the design lists', () => {
    for (const p of ['aws', 'azure', 'google', 'oci', 'vmware']) {
      const folder = `terraform/${p}/`;
      for (const f of ['versions.tf', 'providers.tf', 'variables.tf', 'README.md', 'cutover.auto.tfvars.example', 'archtoolkit-terraform-settings.json']) {
        expect(Object.keys(FILES.files)).toContain(`${folder}${f}`);
      }
      expect(Object.keys(FILES.files).some((f) => f.startsWith(folder) && /\/01-.*\.tf$/.test(f))).toBe(true);
    }
    for (const p of ['aws', 'azure', 'google', 'oci']) {
      for (const f of ['outputs.tf', 'terraform.tfvars.example']) expect(Object.keys(FILES.files)).toContain(`terraform/${p}/${f}`);
      expect(FILES.files[`terraform/${p}/01-landing-zone.tf`]).toBeDefined();
    }
  });

  it('stacks the items in the design order', () => {
    const order = (p: Platform) => STACKS.perPlatform[p]!.items.map((i) => i.blueprintId);
    expect(order('aws')).toEqual([
      'aws_mig_landing_zone', 'aws_mig_identity', 'aws_mig_connectivity', 'aws_mig_compute', 'aws_mig_databases', 'aws_mig_oracle_database', 'aws_mig_backup', 'aws_mig_monitoring',
    ]);
    expect(order('azure')).toEqual([
      'azure_mig_landing_zone', 'azure_mig_identity', 'azure_mig_connectivity', 'azure_mig_compute', 'azure_mig_databases', 'azure_mig_backup', 'azure_mig_monitoring', 'azure_mig_avs',
    ]);
    expect(order('google')).toEqual([
      'google_mig_landing_zone', 'google_mig_identity', 'google_mig_connectivity', 'google_mig_compute', 'google_mig_databases', 'google_mig_oracle_database', 'google_mig_backup', 'google_mig_monitoring',
    ]);
    expect(order('oci')).toEqual(['oci_mig_landing_zone', 'oci_mig_connectivity', 'oci_mig_compute', 'oci_mig_databases', 'oci_mig_backup', 'oci_mig_monitoring']);
    expect(order('vmware')).toEqual(['vsphere_mig_vms']);
  });

  it('has exactly one landing_zone local per stack, and no stack-builder errors', () => {
    for (const p of ['aws', 'azure', 'google', 'oci']) {
      const tf = Object.entries(FILES.files).filter(([f]) => f.startsWith(`terraform/${p}/`) && f.endsWith('.tf')).map(([, t]) => t).join('\n');
      expect(tf.match(/^\s*landing_zone\s+=\s+\{/gm)?.length).toBe(1);
      expect(tf.match(/^\s*mig_vms\s+=\s+\{/gm)?.length).toBe(1);
    }
    // An aliased provider (the AWS backup's DR region) is reported separately below.
    const stackWarnings = FILES.findings.filter((f) => f.code.startsWith('tf.stack.') && f.severity !== 'info' && f.code !== 'tf.stack.provider-differs');
    expect(stackWarnings.map((f) => `${f.code} ${f.message}`)).toEqual([]);
    expect(FILES.findings.filter((f) => f.severity === 'error').map((f) => `${f.code} ${f.message}`)).toEqual([]);
  });

  it('keeps an aliased provider block (the AWS DR backup vault\'s)', () => {
    expect(FILES.findings.filter((f) => f.code === 'tf.stack.provider-differs').map((f) => f.message)).toEqual([]);
    expect(FILES.files['terraform/aws/providers.tf']).toContain('alias');
  });

  it('writes the envelope, which loads through openEnvelope for the Terraform page', () => {
    for (const p of ['aws', 'azure', 'google', 'oci', 'vmware']) {
      const text = FILES.files[`terraform/${p}/archtoolkit-terraform-settings.json`]!;
      const opened = openEnvelope(readSettings(text, 'archtoolkit-terraform-settings.json'), 'archtoolkit.terraform-generator');
      expect('ok' in opened).toBe(true);
      const env = envelopeOf(p);
      expect(env.kind).toBe('archtoolkit.terraform-generator');
      expect(env.version).toBe(1);
      expect(env.savedAt).toBe(MIXED.plan.savedAt);
      expect(env.target).toBe((p === 'vmware' ? 'vsphere' : p) as typeof env.target);
      expect(env.blueprint).toBe(env.stack[0]!.blueprintId);
      expect(env.values).toEqual(env.stack[0]!.values);
      expect(FILES.envelopes[p as Platform]).toEqual(env);
      // Nothing secret-named in it: the page's own save would strip nothing.
      expect(stripSecrets(env as unknown as Json)).toEqual(env as unknown as Json);
    }
  });

  it('rebuilds byte for byte: the envelope stack through buildStack gives the same .tf files', () => {
    for (const folder of ['aws', 'azure', 'google', 'oci', 'vmware', 'aws-dr']) {
      const env = envelopeOf(folder);
      const again = buildStack(env.stack, findTerraformBlueprint, optionsOf(env));
      const tf = Object.keys(again.files).filter((f) => f.endsWith('.tf'));
      expect(tf.length).toBeGreaterThan(0);
      for (const f of tf) expect(again.files[f]).toBe(FILES.files[`terraform/${folder}/${f}`]);
      expect(Object.keys(FILES.files).filter((f) => f.startsWith(`terraform/${folder}/`) && f.endsWith('.tf')).length).toBe(tf.length);
    }
  });

  it('is reproducible and carries no footprint', () => {
    const again = terraformFiles(MIXED.plan, MIXED.decision, MIXED.design);
    expect(again.files).toEqual(FILES.files);
    const all = Object.values(FILES.files).join('\n');
    expect(/Generated by|gibso|\\Users\\/.test(all)).toBe(false);
    expect(all.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g)?.every((d) => d.startsWith('2026-09-26T00:00')) ?? true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

describe('generate/terraform: compute rows', () => {
  it('equal the design\'s compute targets, count and names', () => {
    const workloads = designWorkloads(MIXED.plan, MIXED.design);
    for (const pd of MIXED.design.platforms) {
      const stack = STACKS.perPlatform[pd.platform]!;
      const vms = itemOf(stack, pd.platform === 'vmware' ? '_mig_vms' : '_mig_compute');
      const wanted = pd.compute
        .filter((c) => pd.platform !== 'vmware' || c.image.kind !== 'replicated')
        .map((c) => computeRowName(pd.platform, workloads.find((w) => w.id === c.workload)!.name))
        .sort();
      const got = parseGrid(String(vms?.values.vms ?? ''), pd.platform === 'vmware' ? ['Name'] : VM_COLUMN_NAMES).map((r) => r['Name']!).sort();
      expect(got).toEqual(wanted);
    }
  });

  it('never makes a compute row of a managed database\'s host', () => {
    const aws = rows(itemOf(STACKS.perPlatform.aws, '_mig_compute')?.values.vms);
    expect(aws.map((r) => r[0])).not.toContain('pg01');
    expect(MIXED.design.platforms.find((p) => p.platform === 'aws')!.compute.some((c) => c.workload === itemId('workload', 'pg01'))).toBe(false);
  });

  it('writes the method, zone letter, licence, the engine as the role of a database host, and the added domain controllers', () => {
    const aws = rows(itemOf(STACKS.perPlatform.aws, '_mig_compute')?.values.vms);
    const web01 = aws.find((r) => r[0] === 'web01')!;
    expect(web01[2]).toBe('replicated');
    expect(web01[11]).toBe('replicate');
    expect(['a', 'b', 'c']).toContain(web01[8]);
    expect(aws.find((r) => r[0] === 'app01')![11]).toBe('rebuild');
    // extend-dcs adds two domain controllers on each hyperscaler.
    expect(aws.filter((r) => r[13] === 'ad-dc').length).toBe(2);
    const azure = rows(itemOf(STACKS.perPlatform.azure, '_mig_compute')?.values.vms);
    expect(azure.find((r) => r[0] === 'sql01')![13]).toBe('sqlserver');
    const oci = rows(itemOf(STACKS.perPlatform.oci, '_mig_compute')?.values.vms);
    expect(/^VM\.Standard\.E\d\.Flex:\d+:\d+$/.test(oci.find((r) => r[0] === 'ora01')![3] ?? '')).toBe(true);
    expect(/higher:/.test(oci.find((r) => r[0] === 'ora01')![5] ?? '')).toBe(true);
    // A Compute Engine name is lowercase.
    expect(rows(itemOf(STACKS.perPlatform.google, '_mig_compute')?.values.vms).map((r) => r[0])).toContain('gapp01');
  });
});

describe('generate/terraform: databases', () => {
  it('routes RAC and Exadata to Oracle Database@, never to the databases grid', () => {
    const aws = STACKS.perPlatform.aws!;
    expect(rows(itemOf(aws, '_mig_databases')?.values.databases).map((r) => r[0])).toEqual(['orders']);
    const odb = itemOf(aws, '_mig_oracle_database')!;
    expect(odb.values.databases).toBe('erpx');
    expect(odb.values.create_databases).toBe('yes');
    expect(odb.values.exadata_shape).toBe('Exadata.X11M');
    for (const stack of Object.values(STACKS.perPlatform)) {
      for (const r of rows(itemOf(stack, '_mig_databases')?.values.databases)) expect(r[7]).not.toBe('rac');
    }
  });

  it('translates the design\'s classes into the grid\'s', () => {
    expect(classCell('azure', { classOrShape: 'BC_Gen5_8', service: 'azure-sqlmi' })).toBe('BC_Gen5_8');
    expect(classCell('oci', { classOrShape: 'ECPU-4', service: 'oci-adb' })).toBe('4');
    expect(classCell('oci', { classOrShape: 'VM.Standard.E5.Flex:4', service: 'oci-basedb' })).toBe('VM.Standard.E5.Flex:4');
    expect(classCell('oci', { classOrShape: 'PostgreSQL.VM.Standard.E5.Flex:2', service: 'oci-pg' })).toBe('PostgreSQL.VM.Standard.E5.Flex:2');
    expect(classCell('oci', { classOrShape: 'MySQL.4', service: 'oci-mysql-heatwave' })).toBe('MySQL.4');
    expect(classCell('oci', { classOrShape: 'Exadata.X11M', service: 'oci-exacs' }, { vcpu: 16 })).toBe('Exadata.X11M:8');
    expect(classCell('google', { classOrShape: 'cpu-8', service: 'google-alloydb' })).toBe('cpu-8');
    const oci = rows(itemOf(STACKS.perPlatform.oci, '_mig_databases')?.values.databases);
    expect(/^\d+$/.test(oci.find((r) => r[0] === 'hr')![5] ?? '')).toBe(true);
    // RAC on OCI Base Database: two nodes, Extreme Performance.
    const erp = oci.find((r) => r[0] === 'erp')!;
    expect(erp[7]).not.toBe('none');
    expect(erp[7]).not.toBe('standby');
    expect(erp[3]).toBe('extreme-performance');
  });

  it('writes SQL Server on Azure VMs as one row per host, and the availability group as a manual step', () => {
    const az = rows(itemOf(STACKS.perPlatform.azure, '_mig_databases')?.values.databases);
    expect(az.filter((r) => r[1] === 'azure-sqlvm').map((r) => r[0])).toEqual(['sql01', 'sql02']);
    expect(/^BC_Gen5_\d+$/.test(az.find((r) => r[0] === 'crm')![5] ?? '')).toBe(true);
    const readme = FILES.files['terraform/azure/README.md']!;
    expect(readme).toContain('availability group');
    expect(readme).toContain('mssql_ag');
    // The landing zone gets the delegated subnets the services need, and only those.
    expect(rows(itemOf(STACKS.perPlatform.azure, '_mig_landing_zone')?.values.delegations).map((r) => r[1]).sort()).toEqual(['dns-resolver', 'mysql', 'sqlmi']);
  });

  it('puts Base Database on Oracle Database@Google Cloud in the README, not Terraform', () => {
    expect(FILES.files['terraform/google/README.md']).toContain('google_oracle_database_db_system');
    expect(rows(itemOf(STACKS.perPlatform.google, '_mig_databases')?.values.databases).map((r) => r[0]).sort()).toEqual(['billing', 'ledgerdb']);
    expect(itemOf(STACKS.perPlatform.google, '_mig_oracle_database')?.values.create_databases).toBe('no');
  });

  it('needs Terraform 1.11 where a write-only password is used, else 1.7', () => {
    expect(STACKS.perPlatform.google!.requiredVersion).toBe(REQUIRED_VERSION_WRITE_ONLY);
    expect(STACKS.perPlatform.azure!.requiredVersion).toBe(REQUIRED_VERSION_WRITE_ONLY);
    expect(STACKS.perPlatform.aws!.requiredVersion).toBe(REQUIRED_VERSION);
    expect(FILES.files['terraform/google/versions.tf']).toContain('required_version = ">= 1.11.0"');
    expect(FILES.files['terraform/aws/versions.tf']).toContain('required_version = ">= 1.7.0"');
  });
});

describe('generate/terraform: omitted when empty', () => {
  it('leaves out connectivity without sites, identity without a directory, databases without databases', () => {
    const f = fixture({ sites: [], identity: { ...defaultRequirements().identity, adStrategy: 'none' } });
    const s = planToStacks(f.plan, f.decision, f.design);
    for (const stack of Object.values(s.perPlatform)) {
      expect(stack.items.some((i) => /_mig_(connectivity|identity)$/.test(i.blueprintId))).toBe(false);
    }
    const noDbs = fixture({}, { databases: [] });
    const t = planToStacks(noDbs.plan, noDbs.decision, noDbs.design);
    for (const stack of Object.values(t.perPlatform)) {
      expect(stack.items.some((i) => /_mig_(databases|oracle_database)$/.test(i.blueprintId))).toBe(false);
    }
  });

  it('asks for managed AD where it is chosen, and falls back to DCs on OCI', () => {
    const f = fixture({ identity: { ...defaultRequirements().identity, adStrategy: 'managed-ad' } });
    const s = planToStacks(f.plan, f.decision, f.design);
    expect(itemOf(s.perPlatform.aws, '_mig_identity')?.values.strategy).toBe('managed-ad');
    expect(itemOf(s.perPlatform.oci, '_mig_identity')).toBeUndefined();
    expect(rows(itemOf(s.perPlatform.azure, '_mig_landing_zone')?.values.delegations).map((r) => r[1])).toContain('aadds');
  });
});

describe('generate/terraform: the DR region', () => {
  it('gives terraform/<p>-dr/ a landing zone in the DR region, on a range that overlaps nothing', () => {
    const dr = STACKS.dr.aws!;
    expect(dr.folder).toBe('aws-dr');
    expect(dr.items.map((i) => i.blueprintId)).toEqual(['aws_mig_landing_zone']);
    expect(dr.items[0]!.values.region).toBe('us-west-2');
    expect(FILES.files['terraform/aws-dr/01-landing-zone.tf']).toBeDefined();
    expect(FILES.files['terraform/aws-dr/archtoolkit-terraform-settings.json']).toBeDefined();
    const cidr = rows(dr.items[0]!.values.networks)[0]![2]!;
    const primary = MIXED.design.platforms.flatMap((p) => p.networks.map((n) => n.cidr));
    expect(primary).not.toContain(cidr);
    // The backup item copies there.
    expect(itemOf(STACKS.perPlatform.aws, '_mig_backup')?.values.dr_region).toBe('us-west-2');
    expect(STACKS.dr.azure).toBeUndefined();
    expect(Object.keys(FILES.files).some((f) => f.startsWith('terraform/azure-dr/'))).toBe(false);
  });
});

describe('generate/terraform: README and cutover', () => {
  it('says init, the TF_VAR exports, apply and the cutover apply, and never "plan first"', () => {
    const readme = FILES.files['terraform/azure/README.md']!;
    expect(readme).toContain('terraform init');
    expect(readme).toContain('terraform apply');
    expect(readme).toContain('export TF_VAR_windows_admin_password');
    expect(readme).toContain('cutover.auto.tfvars.json');
    expect(/terraform plan/.test(Object.entries(FILES.files).filter(([f]) => f.endsWith('README.md')).map(([, t]) => t).join('\n'))).toBe(false);
    expect(sensitiveVariables(FILES.files['terraform/azure/variables.tf']!)).toContain('windows_admin_password');
  });

  it('lists the replicated VMs in cutover.auto.tfvars.example', () => {
    const ex = FILES.files['terraform/aws/cutover.auto.tfvars.example']!;
    expect(ex).toContain('cutover_instance_ids = {');
    expect(ex).toContain('# "web01" = ""');
    expect(ex).not.toContain('"app01"');
  });
});

// ---------------------------------------------------------------------------
// Addendum A.12.3: scopes, and the blueprints still to come
// ---------------------------------------------------------------------------

/** A blueprint that stands in for one not written yet. */
function stub(id: string, inputs: readonly string[]): Blueprint {
  return {
    id, label: id, description: id, emits: [],
    inputs: inputs.map((i) => ({ id: i, label: i, control: 'text' as const })),
    build: () => ({ files: { 'main.tf': `locals {\n  ${id} = true\n}\n` } }),
  };
}
const FUTURE: Readonly<Record<string, Blueprint>> = Object.fromEntries(
  [
    stub('aws_mig_replication', ['vms', 'databases', 'region', 'landing_zone_source']),
    stub('aws_mig_governance', ['frameworks', 'keys', 'landing_zone_source']),
    stub('aws_app_context', ['app', 'landing_zone_source']),
    stub('aws_app_monitoring', ['app', 'criticality']),
    stub('aws_app_three_tier', ['app', 'size']),
  ].map((b) => [b.id, b]),
);
const withFuture = (id: string): Blueprint | undefined => FUTURE[id] ?? findTerraformBlueprint(id);

describe('generate/terraform: replication, governance and app items', () => {
  it('leaves them out while their blueprints do not exist', () => {
    for (const stack of Object.values(STACKS.perPlatform)) {
      expect(stack.items.some((i) => /_mig_(replication|governance)$|_app_/.test(i.blueprintId))).toBe(false);
    }
  });

  it('adds them once the lookup has them, with only the inputs they declare', () => {
    const s = planToStacks(MIXED.plan, MIXED.decision, MIXED.design, { lookup: withFuture });
    const order = s.perPlatform.aws!.items.map((i) => i.blueprintId);
    expect(order.indexOf('aws_mig_governance')).toBe(order.indexOf('aws_mig_connectivity') + 1);
    expect(order[order.length - 1]).toBe('aws_mig_replication');
    const rep = itemOf(s.perPlatform.aws, '_mig_replication')!;
    expect(Object.keys(rep.values).sort()).toEqual(['databases', 'landing_zone_source', 'region', 'vms']);
    expect(rows(rep.values.vms).map((r) => r[0]).sort()).toEqual(['web01', 'web02']);
    expect(rows(rep.values.databases).map((r) => r[0])).toEqual(['orders']);
    // It builds.
    const built = buildStack(s.perPlatform.aws!.items, withFuture, { target: 'aws', requiredVersion: s.perPlatform.aws!.requiredVersion });
    expect(built.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('adds an app\'s context, pattern items and resource components, in that order, before backup', () => {
    const appPlans = [{
      app: itemId('app', 'shop'), status: 'planned', platform: 'aws',
      variants: {
        aws: [
          { id: 'c:shop:web', name: 'web tier', kind: 'pattern', tierPattern: 'three-tier', settings: { size: 'm' } },
          { id: 'c:shop:bucket', name: 'bucket', kind: 'resource', blueprintId: 'aws_mig_monitoring', values: { siem: 'none' } },
          { id: 'c:shop:sap', name: 'sap', kind: 'pattern', tierPattern: 'sap-hana', settings: {} },
        ],
      },
    }];
    const f = fixture({}, { appPlans } as unknown as Partial<Plan>);
    const s = planToStacks(f.plan, f.decision, f.design, { lookup: withFuture });
    const ids = s.perPlatform.aws!.items.map((i) => i.id);
    const at = (id: string) => ids.indexOf(id);
    expect(at('aws:app:shop:context')).toBeGreaterThan(at('aws:oracle-database-at'));
    expect(at('c:shop:web')).toBe(at('aws:app:shop:context') + 1);
    expect(at('c:shop:bucket')).toBe(at('c:shop:web') + 1);
    expect(at('aws:backup')).toBe(at('c:shop:bucket') + 1);
    expect(at('aws:app:shop:monitoring')).toBeGreaterThan(at('aws:monitoring'));
    expect(ids).not.toContain('c:shop:sap');
    expect(s.findings.some((x) => x.code === 'plan.tf.pattern-not-generated')).toBe(true);
    expect(s.perPlatform.aws!.items.find((i) => i.id === 'c:shop:web')!.values).toEqual({ app: 'shop', size: 'm' });
    // Without the future blueprints only the resource component (a real blueprint) goes in.
    const now = planToStacks(f.plan, f.decision, f.design);
    expect(now.perPlatform.aws!.items.map((i) => i.id).filter((i) => i.startsWith('c:') || i.includes(':app:'))).toEqual(['c:shop:bucket']);
  });
});

describe('generate/terraform: scopes', () => {
  it('landing-zone: the landing zone, identity and connectivity, no workloads', () => {
    const s = planToStacks(MIXED.plan, MIXED.decision, MIXED.design, { scope: 'landing-zone' });
    expect(s.perPlatform.aws!.items.map((i) => i.blueprintId)).toEqual(['aws_mig_landing_zone', 'aws_mig_identity', 'aws_mig_connectivity', 'aws_mig_backup']);
    expect(s.perPlatform.azure!.items.map((i) => i.blueprintId)).toEqual(['azure_mig_landing_zone', 'azure_mig_identity', 'azure_mig_connectivity', 'azure_mig_avs']);
    expect(s.perPlatform.vmware).toBeUndefined();
  });

  it('apps with a shared landing zone: no landing zone, and every consumer reads var.landing_zone', () => {
    const s = planToStacks(MIXED.plan, MIXED.decision, MIXED.design, { scope: 'apps', landingZone: 'shared', apps: ['shop'] });
    const aws = s.perPlatform.aws!;
    expect(aws.items.some((i) => /_mig_(landing_zone|identity|connectivity)$/.test(i.blueprintId))).toBe(false);
    for (const i of aws.items) if ('landing_zone_source' in i.values) expect(i.values.landing_zone_source).toBe('variables');
    expect(rows(itemOf(aws, '_mig_compute')?.values.vms).map((r) => r[12])).toEqual(['shop', 'shop', 'shop']);
    expect(s.dr.aws).toBeUndefined();
    expect(aws.manual.join('\n')).toContain('landing_zone.auto.tfvars.json');
    const built = buildStack(aws.items, findTerraformBlueprint, { target: 'aws', requiredVersion: aws.requiredVersion });
    expect(built.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(Object.values(built.files).join('\n')).toContain('variable "landing_zone"');
  });

  it('apps with the landing zone included: only the platforms the apps land on, each with its landing zone', () => {
    const s = planToStacks(MIXED.plan, MIXED.decision, MIXED.design, { scope: 'apps', landingZone: 'included', apps: [itemId('app', 'sales')] });
    expect(Object.keys(s.perPlatform)).toEqual(['azure']);
    expect(s.perPlatform.azure!.items[0]!.blueprintId).toBe('azure_mig_landing_zone');
    expect(rows(itemOf(s.perPlatform.azure, '_mig_compute')?.values.vms).map((r) => r[0])).toEqual(['sql01', 'sql02']);
    expect(rows(itemOf(s.perPlatform.azure, '_mig_databases')?.values.databases).map((r) => r[0])).toEqual(['sql01', 'sql02']);
  });

  it('environment: only that environment\'s workloads', () => {
    const s = planToStacks(MIXED.plan, MIXED.decision, MIXED.design, { scope: 'apps', environment: 'dev' });
    expect(rows(itemOf(s.perPlatform.aws, '_mig_compute')?.values.vms).map((r) => r[0])).toEqual(['dev01']);
    expect(s.perPlatform.azure?.items.some((i) => i.blueprintId === 'azure_mig_compute') ?? false).toBe(false);
  });
});
