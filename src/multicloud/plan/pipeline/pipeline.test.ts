/**
 * WP-24: golden images, pipelines, state stores and environments.
 *
 * Run: node --experimental-strip-types --no-warnings --test src/multicloud/plan/pipeline/pipeline.test.ts
 *
 * When Packer, Terraform or bash is on the PATH, the generated files are also
 * checked with them (packer fmt / validate -syntax-only, terraform fmt,
 * bash -n); otherwise those checks are skipped.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { designPlan } from '../design/index.ts';
import { ansibleFiles } from '../generate/ansible.ts';
import { planToStacks, type PlatformStack } from '../generate/terraform.ts';
import { defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../options.ts';
import type {
  App, Database, DbServiceId, Env, ItemDecision, Method, Plan, PlanDecision, Platform, TargetDesign, Workload,
} from '../types.ts';
import { backendBootstrapFiles, backendConfig, fmtAlign, STATE_VARIABLES } from './backend-bootstrap.ts';
import { azureDevOpsFiles } from './ci-azdo.ts';
import { ciModel, type CiOptions } from './ci-common.ts';
import { githubActionsFiles } from './ci-github.ts';
import { gitlabCiFiles } from './ci-gitlab.ts';
import {
  environmentDeployStacks, environmentFiles, environmentStack, environmentStacks, estateDeployStacks, isNonprod, promotionOrder,
  scaleComputeSize, scaleDbClass, stateKey, type EnvironmentOptions,
} from './environments.ts';
import { goldenImagesFor, imageVariable, packerFiles, PACKER_BUILDER, withGoldenImages } from './packer.ts';
import { withUserNetworks } from '../../../testing/network-rows.ts';

// ---------------------------------------------------------------------------
// The fixture: every platform, rebuilt and replicated rows, managed databases
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
  [workload('web01', { role: 'web', os: 'win-2022', disksGib: [128] }), { platform: 'aws', method: 'replicate' }],
  [workload('app01', { vcpu: 8, ramGib: 32, disksGib: [64, 100] }), { platform: 'aws', method: 'rebuild' }],
  [workload('app02', { os: 'ubuntu-22.04', vcpu: 4, ramGib: 16 }), { platform: 'aws', method: 'rebuild' }],
  [workload('pg01', { role: 'db', app: 'orders' }), { platform: 'aws', method: 'managed-db' }],
  [workload('win01', { os: 'win-2022', vcpu: 8, ramGib: 32 }), { platform: 'azure', method: 'rebuild' }],
  [workload('lin01', { os: 'rhel-9', vcpu: 8, ramGib: 32 }), { platform: 'azure', method: 'rebuild' }],
  [workload('gapp01', { vcpu: 8, ramGib: 32, app: 'ledger' }), { platform: 'google', method: 'rebuild' }],
  [workload('ora01', { role: 'db', os: 'ol-8', vcpu: 8, ramGib: 64, disksGib: [100, 500], app: 'erp' }), { platform: 'oci', method: 'rebuild' }],
  [workload('vm01', { os: 'rhel-9', vcpu: 4, ramGib: 16, app: 'intranet' }), { platform: 'vmware', method: 'rebuild' }],
];
const D: readonly (readonly [Database, Placement])[] = [
  [database('orders', { hosts: ['pg01'], app: 'orders', vcpu: 8, ramGib: 64 }), { platform: 'aws', method: 'managed-db', service: 'aws-rds' }],
  [database('crm', { engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', vcpu: 8, ramGib: 64, ha: 'sql-ag', licence: 'byol-sa', app: 'crm' }), { platform: 'azure', method: 'managed-db', service: 'azure-sqlmi' }],
  [database('billing', { engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2022', vcpu: 8, ramGib: 32, app: 'ledger', licence: 'li', ha: 'sql-ag' }), { platform: 'google', method: 'managed-db', service: 'google-cloudsql' }],
  [database('web', { engine: 'mysql', version: 'mysql-8.0', app: 'shop' }), { platform: 'oci', method: 'managed-db', service: 'oci-mysql-heatwave' }],
];

function decisionItem(id: string, kind: 'workload' | 'database', p: Placement | null): ItemDecision {
  if (!p) return { id, kind, disposition: 'retain', method: 'none', options: [], pinned: false, margin: 0, findings: [] };
  const chosen = { platform: p.platform, score: 10, hits: [], ...(p.service ? { service: p.service } : {}) };
  return { id, kind, disposition: 'rehost', method: p.method, options: [chosen], chosen, pinned: false, margin: 5, findings: [] };
}

function fixture(): { plan: Plan; decision: PlanDecision; design: TargetDesign } {
  const base = defaultRequirements();
  const plan: Plan = withUserNetworks({
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'plan-wp24', name: 'Build Test', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: W.map(([w]) => w),
    databases: D.map(([d]) => d),
    apps: [app('shop'), app('orders'), app('crm'), app('ledger'), app('erp'), app('intranet')],
    edges: [],
    requirements: {
      ...base,
      allowed: ['aws', 'azure', 'google', 'oci', 'vmware'],
      maxPlatforms: 5,
      regions: { aws: { primary: 'eu-west-2' }, azure: { primary: 'uksouth' }, google: { primary: 'europe-west2' }, oci: { primary: 'uk-london-1' }, vmware: { primary: 'wld01-vc01.corp.example.com' } },
      sites: [{ name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['10.0.0.0/16', 'fd00:10::/48'], bandwidth: '1g', circuit: 'none' }],
      connection: 'vpn',
    },
    designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
  }, ['aws', 'azure', 'google', 'oci', 'vmware'], { allPlatformSubnets: true });
  const items: Record<string, ItemDecision> = {};
  for (const [w, p] of W) items[w.id] = decisionItem(w.id, 'workload', p);
  for (const [d, p] of D) items[d.id] = decisionItem(d.id, 'database', p);
  const decision: PlanDecision = { engineVersion: 'test', platforms: ['aws', 'azure', 'google', 'oci', 'vmware'], subsetScores: [], items, findings: [] };
  return { plan, decision, design: designPlan(plan, decision) };
}

const { plan, decision, design } = fixture();
const ESTATE = planToStacks(plan, decision, design);
const APPS = planToStacks(plan, decision, design, { scope: 'apps', landingZone: 'shared' });
const ENV_OPTIONS: EnvironmentOptions = { environments: ['dev', 'test', 'prod'], nonprodPct: 25 };
const ENVS = environmentStacks(APPS, ENV_OPTIONS, design);
const DEPLOY = [...estateDeployStacks(ESTATE), ...environmentDeployStacks(ENVS.stacks)];
const PACKER = packerFiles(plan, design, Object.values(ESTATE.perPlatform) as PlatformStack[]);
const ANSIBLE = ansibleFiles(plan, decision, design);
const BOOTSTRAP = backendBootstrapFiles(plan, design, DEPLOY);
const ENV_FILES = environmentFiles(plan, ENVS.stacks, ENV_OPTIONS);
const PROJECT: Record<string, string> = { ...ANSIBLE.files, ...ENV_FILES.files, ...PACKER.files, ...BOOTSTRAP.files };
const CI: CiOptions = { planId: plan.id, stacks: DEPLOY, images: PACKER.images, files: PROJECT };
const GITHUB = githubActionsFiles(CI);
const GITLAB = gitlabCiFiles(CI);
const AZDO = azureDevOpsFiles(CI);

const rows = (text: unknown): string[][] => String(text ?? '').split('\n').filter(Boolean).map((l) => l.split(' | '));
const stackOf = (platform: Platform, env: Env) => ENVS.stacks.find((s) => s.platform === platform && s.env === env)!;
const itemBy = (s: PlatformStack, suffix: string) => s.items.find((i) => i.blueprintId.endsWith(suffix));
const everything = (files: Readonly<Record<string, string>>): string => Object.values(files).join('\n');

/** Credential-shaped text that must never appear in a generated file. */
const CREDENTIAL = /(aws_secret_access_key|secret_key\s*=\s*"|client_secret\s*[:=]\s*["']?[A-Za-z0-9]|password\s*=\s*"[^"$]|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16})/;
/** Footprints: who or when generated it. */
const FOOTPRINT = /(Generated by|generated on|timestamp\(\)|gibso|E:\\Repos|C:\\Users)/i;

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

describe('build/environments: per-environment stacks', () => {
  it('generates one stack per platform and environment, in promotion order', () => {
    expect(promotionOrder(['prod', 'dr', 'dev', 'test'])).toEqual(['dev', 'test', 'prod']);
    expect(ENVS.stacks.map((s) => `${s.platform}/${s.env}`).filter((s) => s.startsWith('aws/'))).toEqual(['aws/dev', 'aws/test', 'aws/prod']);
    expect(Object.keys(ENV_FILES.files)).toContain('apps/aws/dev/versions.tf');
    expect(Object.keys(ENV_FILES.files)).toContain('apps/google/prod/archtoolkit-terraform-settings.json');
    expect(ENV_FILES.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('keeps prod byte for byte', () => {
    for (const p of ['aws', 'azure', 'google', 'oci', 'vmware'] as const) {
      expect(stackOf(p, 'prod').items).toEqual(APPS.perPlatform[p]!.items);
    }
  });

  it('with an account per environment, differs from prod only in the size and HA cells', () => {
    const SIZE_HA: Readonly<Record<string, readonly number[]>> = { vms: [3, 4], databases: [5, 7] };
    const VSPHERE: readonly number[] = [3, 4];
    for (const p of ['aws', 'azure', 'google', 'oci', 'vmware'] as const) {
      const prod = APPS.perPlatform[p]!;
      const dev = environmentStack(prod, 'dev', { ...ENV_OPTIONS, isolation: 'account' });
      expect(dev.items.map((i) => i.id)).toEqual(prod.items.map((i) => i.id));
      let changed = 0;
      prod.items.forEach((pi, n) => {
        const di = dev.items[n]!;
        for (const key of Object.keys(pi.values)) {
          const allowed = di.blueprintId === 'vsphere_mig_vms' && key === 'vms' ? VSPHERE : SIZE_HA[key];
          if (!allowed) {
            expect(`${pi.blueprintId}.${key}=${String(di.values[key])}`).toBe(`${pi.blueprintId}.${key}=${String(pi.values[key])}`);
            continue;
          }
          const a = rows(pi.values[key]);
          const b = rows(di.values[key]);
          expect(b.length).toBe(a.length);
          a.forEach((r, i) => r.forEach((cell, c) => {
            if (b[i]![c] !== cell) changed += 1;
            if (!allowed.includes(c)) expect(`${key}[${i}][${c}]=${b[i]![c]}`).toBe(`${key}[${i}][${c}]=${cell}`);
          }));
        }
      });
      expect(changed).toBeGreaterThan(0);
    }
  });

  it('in a shared landing zone, also gives each nonprod row its name, environment and network', () => {
    const vms = rows(itemBy(stackOf('aws', 'dev'), '_mig_compute')!.values.vms);
    const app01 = vms.find((r) => r[0] === 'app01-dev')!;
    expect(app01[6]).toBe('nonprod');
    expect(app01[14]).toBe('dev');
    const dbs = rows(itemBy(stackOf('aws', 'test'), '_mig_databases')!.values.databases);
    expect(dbs[0]![0]).toBe('orders-test');
    expect(dbs[0]![10]).toBe('nonprod');
  });

  it('scales nonprod to the relative size, within the published catalogue', () => {
    const vms = rows(itemBy(stackOf('aws', 'dev'), '_mig_compute')!.values.vms);
    const prodVms = rows(itemBy(stackOf('aws', 'prod'), '_mig_compute')!.values.vms);
    const size = (rs: string[][], n: string) => rs.find((r) => r[0]!.startsWith(n))![3];
    expect(size(prodVms, 'app01')).toBe('m7i.2xlarge');
    expect(size(vms, 'app01')).toBe('m7i.large');
    expect(scaleComputeSize('aws', 'm7i.2xlarge', 50)).toBe('m7i.xlarge');
    expect(scaleComputeSize('aws', 'm7i.2xlarge', 100)).toBe('m7i.2xlarge');
    expect(scaleComputeSize('aws', 'm7i.metal-24xl', 25)).toBe('m7i.metal-24xl');
    expect(scaleComputeSize('azure', 'Standard_D8s_v5', 50)).toBe('Standard_D4s_v5');
    expect(scaleComputeSize('azure', 'Standard_E8-4ds_v5', 25)).toBe('Standard_E8-4ds_v5');
    expect(scaleComputeSize('google', 'n2-standard-8', 25)).toBe('n2-standard-2');
    expect(scaleComputeSize('oci', 'VM.Standard.E5.Flex:4:64', 25)).toBe('VM.Standard.E5.Flex:1:16');
  });

  it('relaxes the prod-only rules in nonprod: no HA, no Business Critical tier', () => {
    const dbs = rows(itemBy(stackOf('azure', 'dev'), '_mig_databases')!.values.databases);
    const crm = dbs.find((r) => r[0] === 'crm-dev')!;
    expect(crm[7]).toBe('none');
    expect(crm[5]!.startsWith('GP_Gen5_')).toBe(true);
    // SQL Managed Instance starts at 4 vCores.
    expect(scaleDbClass('azure', 'BC_Gen5_8', 25, true, 'azure-sqlmi')).toBe('GP_Gen5_4');
    expect(scaleDbClass('azure', 'BC_Gen5_8', 25, true, 'azure-sqldb')).toBe('GP_Gen5_2');
    expect(scaleDbClass('azure', 'BC_Gen5_8', 100, false)).toBe('BC_Gen5_8');
    expect(scaleDbClass('aws', 'db.r7i.2xlarge', 25, true)).toBe('db.r7i.large');
    expect(scaleDbClass('google', 'db-custom-8-32768', 25, true)).toBe('db-custom-2-8192');
    expect(scaleDbClass('oci', 'MySQL.8', 25, true)).toBe('MySQL.2');
    for (const env of ['dev', 'test'] as const) {
      for (const p of ['aws', 'azure', 'google', 'oci'] as const) {
        const d = itemBy(stackOf(p, env), '_mig_databases');
        if (d) for (const r of rows(d.values.databases)) expect(r[7]).toBe('none');
      }
    }
    expect(isNonprod('preprod')).toBe(true);
    expect(isNonprod('dr')).toBe(false);
  });

  it('keys each stack\'s state by plan, platform, environment and stack', () => {
    expect(stateKey('plan-wp24', { platform: 'aws', env: 'dev', name: 'apps' })).toBe('plan-wp24/aws/dev/apps.tfstate');
    expect(DEPLOY.find((d) => d.dir === 'apps/azure/test')).toEqual({ platform: 'azure', env: 'test', dir: 'apps/azure/test', name: 'apps', backend: 'azurerm' });
  });
});

// ---------------------------------------------------------------------------
// State stores
// ---------------------------------------------------------------------------

describe('build/backend-bootstrap: the state stores', () => {
  it('bootstraps each store the stacks use', () => {
    for (const p of ['aws', 'azure', 'google', 'oci']) {
      for (const f of ['versions.tf', 'main.tf', 'variables.tf', 'outputs.tf', 'README.md']) expect(Object.keys(BOOTSTRAP.files)).toContain(`backend-bootstrap/${p}/${f}`);
    }
    expect(Object.keys(BOOTSTRAP.files).some((f) => f.startsWith('backend-bootstrap/vmware/'))).toBe(false);
    expect(BOOTSTRAP.findings.map((f) => f.code)).toContain('plan.build.state-local');
  });

  it('uses S3 native locking (use_lockfile = true), versioning, KMS and a public-access block, and no DynamoDB table', () => {
    const aws = BOOTSTRAP.files['backend-bootstrap/aws/main.tf']!;
    expect(aws).toContain('aws_s3_bucket_versioning');
    expect(aws).toContain('aws_kms_key');
    expect(aws).toContain('aws_s3_bucket_public_access_block');
    expect(aws).toContain('aws:SecureTransport');
    const tf = Object.entries(BOOTSTRAP.files).filter(([f]) => f.endsWith('.tf')).map(([, t]) => t).join('\n');
    expect(/dynamodb/i.test(tf)).toBe(false);
    expect(BOOTSTRAP.files['backend-bootstrap/aws/versions.tf']).toContain('required_version = ">= 1.10.0"');
    const cfg = backendConfig({ platform: 'aws', env: 'prod', dir: 'x', name: 'apps', backend: 's3' }, 'plan-wp24', (n) => `\${${n}}`);
    expect(cfg.use_lockfile).toBe('true');
    expect(cfg.key).toBe('plan-wp24/aws/prod/apps.tfstate');
    expect(GITHUB.files['ci/scripts/terraform.sh']).toContain('-backend-config="use_lockfile=true"');
  });

  it('keeps Azure state Entra-only, Google Cloud state versioned and never public, OCI state private and versioned', () => {
    const az = BOOTSTRAP.files['backend-bootstrap/azure/main.tf']!;
    expect(/shared_access_key_enabled\s+= false/);
    expect(backendConfig({ platform: 'azure', env: 'dev', dir: 'x', name: 'apps', backend: 'azurerm' }, 'p', (n) => n).use_azuread_auth).toBe('true');
    const gcs = BOOTSTRAP.files['backend-bootstrap/google/main.tf']!;
    expect(/public_access_prevention\s+= "enforced"/.test(gcs)).toBe(true);
    expect(gcs).toContain('versioning');
    const oci = BOOTSTRAP.files['backend-bootstrap/oci/main.tf']!;
    expect(/access_type\s+= "NoPublicAccess"/.test(oci)).toBe(true);
    expect(/versioning\s+= "Enabled"/.test(oci)).toBe(true);
    for (const k of Object.keys(STATE_VARIABLES) as (keyof typeof STATE_VARIABLES)[]) expect(STATE_VARIABLES[k].every((v) => !v.secret)).toBe(true);
  });

  it('aligns attributes the way terraform fmt does', () => {
    expect(fmtAlign('x {\n  value       = {\n    a = 1\n  }\n  description = "d"\n}')).toBe('x {\n  value = {\n    a = 1\n  }\n  description = "d"\n}');
  });
});

// ---------------------------------------------------------------------------
// Golden images
// ---------------------------------------------------------------------------

describe('build/packer: golden images', () => {
  it('writes one template per OS and platform over the rebuilt rows', () => {
    const files = PACKER.images.map((i) => i.file);
    for (const f of ['rhel-9-aws', 'ubuntu-22.04-aws', 'win-2022-azure', 'rhel-9-azure', 'rhel-9-google', 'ol-8-oci', 'rhel-9-vmware']) expect(files).toContain(`images/${f}.pkr.hcl`);
    // web01 is replicated: no Windows image on AWS.
    expect(files).not.toContain('images/win-2022-aws.pkr.hcl');
    for (const img of PACKER.images) {
      const t = PACKER.files[img.file]!;
      expect(t).toContain('required_plugins {');
      expect(t).toContain(`source "${PACKER_BUILDER[img.platform]}"`);
      expect(t).toContain('post-processor "manifest"');
      expect(t).toContain(`variable = "${imageVariable(img.os)}"`);
    }
  });

  it('starts from the base image the stack names', () => {
    expect(PACKER.files['images/rhel-9-aws.pkr.hcl']).toContain('owners      = ["309956199498"]');
    expect(PACKER.files['images/ubuntu-22.04-aws.pkr.hcl']).toContain('data "amazon-parameterstore" "base"');
    expect(/source_image_family\s+= "rhel-9"/.test(PACKER.files['images/rhel-9-google.pkr.hcl']!)).toBe(true);
    expect(/operating_system\s+= "Oracle Linux"/.test(PACKER.files['images/ol-8-oci.pkr.hcl']!)).toBe(true);
    expect(/image_offer\s+= "WindowsServer"/.test(PACKER.files['images/win-2022-azure.pkr.hcl']!)).toBe(true);
  });

  it('reuses the baseline roles: the same role files the Ansible site writes, through the ansible provisioner', () => {
    for (const img of PACKER.images) {
      const t = PACKER.files[img.file]!;
      expect(t).toContain('provisioner "ansible"');
      const playbook = /playbook_file\s+= "\$\{path\.root\}\/(ansible\/playbooks\/[^"]+)"/.exec(t)![1]!;
      expect(PACKER.files[`images/${playbook}`]).toBeDefined();
      expect(PACKER.files[`images/${playbook}`]).toContain(`role: ${img.kind}_baseline`);
      expect(t).toContain('ANSIBLE_ROLES_PATH=${path.root}/ansible/roles');
    }
    for (const role of ['linux_baseline', 'windows_baseline']) {
      for (const f of ['tasks/main.yml', 'defaults/main.yml']) {
        const site = ANSIBLE.files[`ansible/roles/${role}/${f}`];
        expect(site).toBeDefined();
        expect(PACKER.files[`images/ansible/roles/${role}/${f}`]).toBe(site);
      }
    }
    expect(PACKER.files['images/ansible/playbooks/11-windows-baseline.yml']).toContain('mig_windows_baseline_domain_join: false');
  });

  it('generalises each image the way its platform documents', () => {
    expect(PACKER.files['images/rhel-9-azure.pkr.hcl']).toContain('waagent -force -deprovision+user');
    expect(PACKER.files['images/win-2022-azure.pkr.hcl']).toContain('Sysprep.exe /oobe /generalize');
    expect(PACKER.files['images/rhel-9-aws.pkr.hcl']).toContain('cloud-init clean');
    expect(/http_tokens\s+= "required"/.test(PACKER.files['images/rhel-9-aws.pkr.hcl']!)).toBe(true);
  });

  it('holds no credential and no footprint; versions come from image_version, not the clock', () => {
    const all = everything(PACKER.files);
    expect(CREDENTIAL.test(all)).toBe(false);
    expect(FOOTPRINT.test(all)).toBe(false);
    const vs = PACKER.files['images/rhel-9-vmware.pkr.hcl']!;
    expect(/default\s+= env\("VSPHERE_PASSWORD"\)/.test(vs)).toBe(true);
    expect(/sensitive\s+= true/.test(vs)).toBe(true);
    expect(all).toContain('${var.image_version}');
  });

  it('switches the rebuilt rows to the golden images, and only those', () => {
    const aws = ESTATE.perPlatform.aws!;
    const golden = withGoldenImages(aws, PACKER.images);
    const vms = rows(golden.items.find((i) => i.blueprintId === 'aws_mig_compute')!.values.vms);
    expect(vms.find((r) => r[0] === 'app01')![2]).toBe('var:image_rhel_9');
    expect(vms.find((r) => r[0] === 'app02')![2]).toBe('var:image_ubuntu_22_04');
    expect(vms.find((r) => r[0] === 'web01')![2]).toBe('replicated');
    const again = goldenImagesFor([golden]).images;
    expect(again.map((i) => i.os)).toContain('rhel-9');
    expect(again.map((i) => i.os)).not.toContain('win-2022');
    // Rows already on their golden image still build it from the published base, never from itself.
    expect(again.find((i) => i.os === 'rhel-9')!.base.kind).toBe('aws-ami-filter');
  });
});

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

describe('build/ci: GitHub Actions, Azure DevOps, GitLab CI', () => {
  const gh = GITHUB.files['.github/workflows/infra.yml']!;
  const gl = GITLAB.files['.gitlab-ci.yml']!;
  const az = AZDO.files['azure-pipelines.yml']!;

  it('GitHub: plans on pull requests, applies on main behind each environment, in promotion order', () => {
    expect(gh).toContain("if: github.event_name == 'pull_request'");
    expect(gh).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    const order = [...gh.matchAll(/^ {2}apply-([a-z]+):$/gm)].map((m) => m[1]);
    expect(order).toEqual(['dev', 'test', 'prod']);
    for (const env of ['dev', 'test', 'prod']) expect(gh).toContain(`    environment: ${env}`);
    expect(gh).toContain('    needs: configure-dev');
    expect(GITHUB.files['.github/workflows/images.yml']).toContain('bash ci/scripts/packer.sh validate');
  });

  it('GitHub: OIDC for AWS, Azure and Google Cloud, with no stored cloud keys', () => {
    expect(gh).toContain('id-token: write');
    expect(gh).toContain('aws-actions/configure-aws-credentials@');
    expect(gh).toContain('role-to-assume: ${{ vars.AWS_ROLE_ARN }}');
    expect(gh).toContain('azure/login@');
    expect(gh).toContain('client-id: ${{ vars.AZURE_CLIENT_ID }}');
    expect(gh).toContain('google-github-actions/auth@');
    expect(gh).toContain('workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}');
    const secrets = [...gh.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]!);
    for (const s of secrets) expect(/^(AWS_|AZURE_|ARM_|GCP_|GOOGLE_)/.test(s)).toBe(false);
    expect(secrets).toContain('OCI_API_PRIVATE_KEY');
    expect(ciModel(CI).findings.map((f) => f.code)).toContain('plan.build.ci-oci-auth');
  });

  it('GitLab: id_tokens for the three clouds, protected environments per stage', () => {
    expect(gl).toContain('id_tokens:');
    expect(gl).toContain('aud: sts.amazonaws.com');
    expect(gl).toContain('aud: api://AzureADTokenExchange');
    expect(gl).toContain('aud: https://iam.googleapis.com/${GCP_WORKLOAD_IDENTITY_PROVIDER}');
    expect(/environment:\n {4}name: prod/.test(gl)).toBe(true);
    expect(gl).toContain('$CI_COMMIT_BRANCH == "main"');
    const stages = /stages:\n((?: {2}- .+\n)+)/.exec(gl)![1]!.split('\n').filter(Boolean).map((s) => s.replace('  - ', ''));
    expect(stages.indexOf('deploy-dev')).toBeLessThan(stages.indexOf('deploy-test'));
    expect(stages.indexOf('deploy-test')).toBeLessThan(stages.indexOf('deploy-prod'));
    // A saved plan holds secret values: it is never kept as an artifact.
    expect(gl).not.toContain('tfplan');
  });

  it('Azure DevOps: deployment jobs on environments, workload identity federation', () => {
    expect(az).toContain('- deployment: apply_aws_dev_apps');
    expect(az).toContain('environment: prod');
    expect(az).toContain('AzureCLI@2');
    expect(az).toContain('addSpnToEnvironment: true');
    expect(az).toContain('SYSTEM_OIDCREQUESTURI');
    expect(az).toContain("eq(variables['Build.SourceBranch'], 'refs/heads/main')");
    expect(/- stage: deploy_test\n.*\n {4}dependsOn: deploy_dev/.test(az)).toBe(true);
  });

  it('writes no credential and no footprint in any pipeline file', () => {
    for (const out of [GITHUB, GITLAB, AZDO]) {
      const all = everything(out.files);
      expect(CREDENTIAL.test(all)).toBe(false);
      expect(FOOTPRINT.test(all)).toBe(false);
    }
    expect(CREDENTIAL.test(everything(BOOTSTRAP.files))).toBe(false);
  });

  it('keeps the vault password and SSH key on tmpfs, and the OCI key in a 0600 file for the run', () => {
    const ansible = GITHUB.files['ci/scripts/ansible.sh']!;
    expect(ansible).toContain('/dev/shm');
    expect(ansible).toContain('ANSIBLE_VAULT_PASSWORD_FILE');
    const auth = GITHUB.files['ci/scripts/cloud-auth.sh']!;
    expect(auth).toContain('umask 077');
    expect(auth).toContain('trap');
  });
});

// ---------------------------------------------------------------------------
// The real tools, when they are installed
// ---------------------------------------------------------------------------

/** Runs a tool; its exit status and output (execFileSync throws on a non-zero exit). */
function run(cmd: string, args: readonly string[], options: { cwd?: string; input?: string } = {}): { status: number; out: string } {
  try {
    return { status: 0, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}` };
  }
}
const has = (cmd: string, args: readonly string[]): boolean => run(cmd, args).status === 0;

function writeTree(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'atk-wp24-'));
  for (const [p, t] of Object.entries(files)) {
    const f = join(dir, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, t);
  }
  return dir;
}

describe('build: checked with the real tools when present', () => {
  it('bash -n passes on every script', { skip: !has('bash', ['-c', 'exit 0']) }, () => {
    for (const [path, body] of Object.entries({ ...GITHUB.files, ...GITLAB.files, ...AZDO.files })) {
      if (!path.endsWith('.sh')) continue;
      const r = run('bash', ['-n'], { input: body });
      expect(`${path}: ${r.status} ${r.out}`).toBe(`${path}: 0 `);
    }
  });

  it('packer fmt -check and validate -syntax-only pass on every template', { skip: !has('packer', ['version']) }, () => {
    const dir = writeTree(PACKER.files);
    try {
      for (const img of PACKER.images) {
        const fmt = run('packer', ['fmt', '-check', img.file], { cwd: dir });
        expect(`${img.file}: fmt ${fmt.status} ${fmt.out}`).toBe(`${img.file}: fmt 0 `);
        const v = run('packer', ['validate', '-syntax-only', img.file], { cwd: dir });
        expect(`${img.file}: validate ${v.status}`).toBe(`${img.file}: validate 0`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terraform fmt -check passes on the state bootstraps', { skip: !has('terraform', ['version']) }, () => {
    const dir = writeTree(BOOTSTRAP.files);
    try {
      const r = run('terraform', ['fmt', '-check', '-recursive'], { cwd: dir });
      expect(`${r.status} ${r.out}`).toBe('0 ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
