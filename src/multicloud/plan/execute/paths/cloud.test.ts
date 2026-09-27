/**
 * WP-11c: the cloud server paths (aws-mgn, azure-migrate*, gcp-m2vm,
 * gcp-image-import, oci-ocm), through `createRegistry` and `executionKit`,
 * with the contract checked on every file.
 *
 * `bash -n` and the PowerShell parser run over the scripts when bash and
 * pwsh are on the machine (skipped otherwise, as terraform validate is).
 */

import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { expect } from '../../../../testing/expect.ts';
import { LICENCE_HANDLING_TEXT, type LicenceHandlingKey } from '../../design/compute.ts';
import { defaultExecution, defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../../options.ts';
import type {
  App, ComputeTarget, ExecutionSettings, ItemDecision, NetworkDesign, Plan, PlanDecision, Platform, PlatformDesign, SourcePlatform, TargetDesign,
  Workload, WavePlan,
} from '../../types.ts';
import { contractViolations } from '../contract.ts';
import { executionKit, type ExecutionKit } from '../kit.ts';
import { createRegistry } from '../registry.ts';
import { AWS_MGN_GENERATOR, CMF_INTAKE_COLUMNS, GENERATORS as MGN, MGN_IMPORT_COLUMNS, MGN_SCRIPT } from './aws-mgn.ts';
import { AZMIGRATE_SCRIPT, GENERATORS as AZURE } from './azure-migrate.ts';
import { csvText } from './cloud-shared.ts';
import { GCP_M2VM_GENERATOR, GENERATORS as GCP, IMAGE_IMPORT_SCRIPT, M2VM_BULK_MAX_ROWS, M2VM_SCRIPT } from './gcp-m2vm.ts';
import { GENERATORS as OCI, OCM_SCRIPT, OCM_TARGET_ASSET_COLUMNS } from './oci-ocm.ts';

// ---------------------------------------------------------------------------
// Fixtures of the provider operations (A.6.5 sources)
// ---------------------------------------------------------------------------

/** AWS Transform MGN API operations as CLI verbs: https://docs.aws.amazon.com/mgn/latest/APIReference/API_Operations.html */
const MGN_OPERATIONS = new Set([
  'archive-application', 'archive-wave', 'associate-applications', 'associate-source-servers', 'change-server-life-cycle-state',
  'create-application', 'create-connector', 'create-launch-configuration-template', 'create-replication-configuration-template', 'create-wave',
  'delete-application', 'delete-connector', 'delete-job', 'delete-launch-configuration-template', 'delete-replication-configuration-template',
  'delete-source-server', 'delete-vcenter-client', 'delete-wave', 'describe-job-log-items', 'describe-jobs', 'describe-launch-configuration-templates',
  'describe-replication-configuration-templates', 'describe-source-servers', 'describe-vcenter-clients', 'disassociate-applications',
  'disassociate-source-servers', 'disconnect-from-service', 'finalize-cutover', 'get-launch-configuration', 'get-replication-configuration',
  'initialize-service', 'list-applications', 'list-connectors', 'list-export-errors', 'list-exports', 'list-import-errors', 'list-imports',
  'list-managed-accounts', 'list-source-server-actions', 'list-tags-for-resource', 'list-template-actions', 'list-waves', 'mark-as-archived',
  'pause-replication', 'put-source-server-action', 'put-template-action', 'remove-source-server-action', 'remove-template-action',
  'resume-replication', 'retry-data-replication', 'start-cutover', 'start-export', 'start-import', 'start-replication', 'start-test',
  'stop-replication', 'tag-resource', 'terminate-target-instances', 'unarchive-application', 'unarchive-wave', 'untag-resource',
  'update-application', 'update-connector', 'update-launch-configuration', 'update-launch-configuration-template', 'update-replication-configuration',
  'update-replication-configuration-template', 'update-source-server', 'update-source-server-replication-type', 'update-wave',
]);
/** The EC2 and STS operations the MGN path uses beside it (launch templates, instances, the agent-install role). */
const EC2_OPERATIONS = new Set(['create-launch-template-version', 'describe-launch-template-versions', 'describe-launch-templates', 'modify-launch-template', 'describe-instances', 'stop-instances']);
const STS_OPERATIONS = new Set(['assume-role', 'get-caller-identity']);

// ---------------------------------------------------------------------------
// A plan with a server on every WP-11c path
// ---------------------------------------------------------------------------

const REGION: Readonly<Record<Exclude<Platform, 'vmware'>, string>> = { aws: 'us-east-1', azure: 'westeurope', google: 'europe-west2', oci: 'uk-london-1' };
const ZONES: Readonly<Record<Exclude<Platform, 'vmware'>, readonly string[]>> = {
  aws: ['us-east-1a', 'us-east-1b'], azure: ['1', '2'], google: ['europe-west2-a', 'europe-west2-b'], oci: ['AD-1', 'AD-2'],
};
const SIZE: Readonly<Record<Exclude<Platform, 'vmware'>, string>> = { aws: 'm7i.large', azure: 'Standard_D4s_v5', google: 'n2-standard-4', oci: 'VM.Standard.E5.Flex:2:32' };
const DISK: Readonly<Record<Exclude<Platform, 'vmware'>, string>> = { aws: 'gp3', azure: 'Premium_LRS', google: 'pd-balanced', oci: 'balanced' };

type Cloud = Exclude<Platform, 'vmware'>;
interface Server {
  readonly name: string;
  readonly cloud: Cloud;
  readonly origin?: SourcePlatform;
  readonly os?: Workload['os'];
  readonly licence?: LicenceHandlingKey;
  readonly wave: number;
  readonly efi?: boolean;
  readonly sourceId?: string;
}

const SERVERS: readonly Server[] = [
  { name: 'web01', cloud: 'aws', os: 'win-2022', licence: 'byol-image', wave: 1 },
  { name: 'app01', cloud: 'aws', wave: 1 },
  { name: 'az-web01', cloud: 'azure', os: 'win-2022', licence: 'ahb', wave: 1, efi: true },
  { name: 'az-hv01', cloud: 'azure', origin: 'hyperv', wave: 2 },
  { name: 'az-phys01', cloud: 'azure', origin: 'physical', wave: 2 },
  { name: 'gc-app01', cloud: 'google', wave: 1, sourceId: 'vm-1042' },
  { name: 'gc-ec2', cloud: 'google', origin: 'aws', wave: 2, sourceId: 'i-0abc1234' },
  { name: 'gc-kvm01', cloud: 'google', origin: 'kvm', wave: 2 },
  { name: 'oc-app01', cloud: 'oci', wave: 1 },
  { name: 'oc-win01', cloud: 'oci', os: 'win-2019', wave: 2 },
];

function network(name: string, envs: NetworkDesign['envs'], ipv6: boolean, zones: readonly string[]): NetworkDesign {
  const tiers = ['web', 'app', 'db', 'mgmt'] as const;
  return { name, envs, cidr: name === 'prod' ? '10.40.0.0/16' : '10.41.0.0/16', ipv6, tiers: [...tiers], subnets: zones.flatMap((zone) => tiers.map((tier) => ({ id: `${tier}-${zone}`, name: `${tier}-${zone}`, tier, zone, cidr: '10.40.0.0/24', usable: 251 }))) };
}

function fixture(servers: readonly Server[] = SERVERS, execution: Partial<ExecutionSettings> = {}): { plan: Plan; decision: PlanDecision; design: TargetDesign; waves: WavePlan } {
  const workloads: Workload[] = servers.map((s) => ({
    id: itemId('workload', s.name), name: s.name, app: 'shop', env: 'prod', role: 'app', os: s.os ?? 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual',
    ...(s.origin ? { origin: s.origin } : {}),
    sourceRef: { platform: s.origin ?? 'vsphere', ...(s.sourceId ? { id: s.sourceId } : {}), ...(s.origin === 'aws' ? { region: 'us-east-1' } : {}) },
    ...(s.efi ? { facts: { firmware: 'efi' as const } } : {}),
  }));
  const app: App = { id: itemId('app', 'shop'), name: 'shop', criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none' };
  const plan: Plan = {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'Plan-7f3a9c21-x', name: 'Shop move', savedAt: '2026-09-26T00:00:00.000Z',
    workloads, databases: [], apps: [app], edges: [], requirements: defaultRequirements(), designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] }, execution: { ...defaultExecution(), ...execution },
  };
  const items: ItemDecision[] = servers.map((s) => {
    const chosen = { platform: s.cloud as Platform, score: 10, hits: [] };
    return { id: itemId('workload', s.name), kind: 'workload', disposition: 'rehost', method: 'replicate', options: [chosen], chosen, pinned: false, margin: 5, findings: [] };
  });
  const decision: PlanDecision = { engineVersion: 'test', platforms: [], subsetScores: [], items: Object.fromEntries(items.map((i) => [i.id, i])), findings: [] };
  const clouds = [...new Set(servers.map((s) => s.cloud))];
  const platforms: PlatformDesign[] = clouds.map((cloud) => {
    const zones = ZONES[cloud];
    const compute: ComputeTarget[] = servers.filter((s) => s.cloud === cloud).map((s, i) => ({
      workload: itemId('workload', s.name), size: SIZE[cloud], vcpu: 2, ramGib: 8, image: { kind: 'replicated', note: 'replicated' },
      disks: [{ gib: 64, type: DISK[cloud] }], network: 'prod', tier: 'app', zone: zones[i % zones.length]!,
      licenceHandling: LICENCE_HANDLING_TEXT[s.licence ?? 'li'][cloud], backupTier: 'silver', method: 'replicate',
    }));
    return {
      platform: cloud, prefix: 'mig', region: REGION[cloud], networks: [network('prod', ['prod'], true, zones), network('nonprod', ['dev', 'test'], false, zones)],
      bastion: 'cloud-native', logRetentionDays: 90, compute, databases: [], connectivity: [], identity: { strategy: 'none', dcNames: [] },
      backup: { tiers: [] }, overrides: {},
    };
  });
  const byWave = (w: number) => servers.filter((s) => s.wave === w).map((s) => itemId('workload', s.name));
  const waves: WavePlan = {
    settings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    groups: [{ id: 'g1', items: byWave(1), why: 'app', wave: 1, method: 'replicate' }, { id: 'g2', items: byWave(2), why: 'app', wave: 2, method: 'replicate' }],
    waves: [{ n: 1, groups: ['g1'] }, { n: 2, groups: ['g2'] }],
    findings: [],
  };
  return { plan, decision, design: { platforms, findings: [] }, waves };
}

const has = (cmd: string, args: readonly string[]): boolean => {
  try { execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); return true; } catch { return false; }
};
const HAS_BASH = has('bash', ['--version']);
const HAS_PWSH = has('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);

const REGISTRY = () => createRegistry([...MGN, ...AZURE, ...GCP, ...OCI]);
export function kitOf(servers?: readonly Server[], execution?: Partial<ExecutionSettings>): ExecutionKit {
  const { plan, decision, design, waves } = fixture(servers, execution);
  return executionKit(plan, decision, design, waves, undefined, { registry: REGISTRY() });
}
const KIT = kitOf();
const file = (k: ExecutionKit, f: string): string => {
  const t = k.files[f];
  if (t === undefined) throw new Error(`no ${f} in the kit (has ${Object.keys(k.files).join(', ')})`);
  return t;
};
/** `actual` has every key of `want` with its value. */
function expectHas(actual: unknown, want: Record<string, unknown>): void {
  const a = (actual ?? {}) as Record<string, unknown>;
  expect(Object.fromEntries(Object.keys(want).map((k) => [k, a[k]]))).toEqual(want);
}
/** A verb function's body in a generated bash script. */
function shVerb(text: string, verb: string): string {
  const start = text.indexOf(`verb_${verb.replace(/-/g, '_')}() {`);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end);
}
function psVerb(text: string, verb: string): string {
  const start = text.indexOf(`  '${verb}' = {`);
  const next = text.indexOf("\n  '", start + 5);
  return text.slice(start, next < 0 ? undefined : next);
}

// ---------------------------------------------------------------------------

describe('WP-11c: the generators and the registry', () => {
  it('registers every WP-11c path, and nothing else', () => {
    const r = REGISTRY();
    for (const p of ['aws-mgn', 'azure-migrate', 'azure-migrate-hyperv', 'azure-migrate-agent', 'gcp-m2vm', 'gcp-image-import', 'oci-ocm'] as const) {
      expect([p, r.get(p)?.owner]).toEqual([p, 'WP-11c']);
    }
    expect(GCP_M2VM_GENERATOR.entry('gcp-image-import')).toBe(IMAGE_IMPORT_SCRIPT);
    expect(GCP_M2VM_GENERATOR.entry('gcp-m2vm')).toBe(M2VM_SCRIPT);
  });

  it('gives every server its path and script, with no error and no pending generator', () => {
    const byName = new Map(KIT.manifest.items.map((i) => [i.name, i]));
    const want: Record<string, [string, string]> = {
      web01: ['aws-mgn', MGN_SCRIPT], 'az-web01': ['azure-migrate', AZMIGRATE_SCRIPT], 'az-hv01': ['azure-migrate-hyperv', AZMIGRATE_SCRIPT],
      'az-phys01': ['azure-migrate-agent', AZMIGRATE_SCRIPT], 'gc-app01': ['gcp-m2vm', M2VM_SCRIPT], 'gc-ec2': ['gcp-m2vm', M2VM_SCRIPT],
      'gc-kvm01': ['gcp-image-import', IMAGE_IMPORT_SCRIPT], 'oc-app01': ['oci-ocm', OCM_SCRIPT],
    };
    for (const [name, [path, script]] of Object.entries(want)) expect([name, byName.get(name)?.path, byName.get(name)?.script]).toEqual([name, path, script]);
    expect(KIT.findings.filter((f) => f.severity === 'error').map((f) => f.message)).toEqual([]);
    expect(KIT.findings.filter((f) => f.code === 'exec.path.no-generator')).toEqual([]);
  });

  it('keeps the contract in every file, and is reproducible', () => {
    const violations = Object.entries(KIT.files).flatMap(([p, t]) => contractViolations(p, t));
    expect(violations).toEqual([]);
    expect(kitOf().files).toEqual(KIT.files);
  });

  it('raises the no-automatic-fallback warnings for AWS Transform MGN and Migrate to Virtual Machines', () => {
    const fallback = KIT.findings.filter((f) => f.code === 'exec.path.no-fallback').map((f) => f.message).join(' ');
    expect(fallback).toContain('AWS Transform MGN has no failback');
    expect(fallback).toContain('Migrate to Virtual Machines rollback is not automated');
    expect(file(KIT, 'paths/aws-mgn/README.md')).toContain('No automatic fallback');
    expect(file(KIT, 'paths/gcp-m2vm/README.md')).toContain('No automatic fallback');
    expect(shVerb(file(KIT, MGN_SCRIPT), 'rollback')).toContain('no reverse replication');
    expect(shVerb(file(KIT, M2VM_SCRIPT), 'rollback')).toContain('no automatic fallback');
  });

  it('puts every tool the paths need into controller-check.sh', () => {
    const check = file(KIT, 'controller-check.sh');
    for (const c of ["check_command 'aws'", "check_command 'gcloud'", "check_command 'oci'", "check_command 'curl'", "check_command 'sha256sum'", "check_pwsh_module 'Az.Migrate'", "check_collection 'ansible.windows'"]) {
      expect([c, check.includes(c)]).toEqual([c, true]);
    }
  });

  it('has bash scripts bash accepts and PowerShell scripts the parser accepts (when the tools are here)', { skip: HAS_BASH || HAS_PWSH ? false : 'neither bash nor pwsh is installed' }, () => {
    const scripts = Object.entries(KIT.files).filter(([f]) => f.startsWith('paths/') && (f.endsWith('.sh') || f.endsWith('.ps1')));
    for (const [f, text] of scripts) {
      if (f.endsWith('.sh') && HAS_BASH) {
        let err = '';
        try { execFileSync('bash', ['-n'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { err = String((e as { stderr?: string }).stderr ?? e); }
        expect([f, err]).toEqual([f, '']);
      }
      if (f.endsWith('.ps1') && HAS_PWSH) {
        const cmd = '$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref] $null, [ref] $e); $e | ForEach-Object { $_.Message }';
        const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', cmd], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        expect([f, out.trim()]).toEqual([f, '']);
      }
    }
  });
});

describe('WP-11c: AWS Transform MGN', () => {
  const mgn = file(KIT, MGN_SCRIPT);

  it('uses only MGN, EC2 and STS operations from the API references', () => {
    const verbs = [...mgn.matchAll(/\baws\s+([a-z0-9]+)\s+([a-z]+-[a-z0-9-]+)/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(verbs.length > 20).toBe(true);
    for (const [svc, verb] of verbs) {
      const known = svc === 'mgn' ? MGN_OPERATIONS : svc === 'ec2' ? EC2_OPERATIONS : svc === 'sts' ? STS_OPERATIONS : new Set<string>();
      expect([svc, verb, known.has(verb)]).toEqual([svc, verb, true]);
    }
  });

  it('switches the default launch-template version: test for the test launch, cutover after it', () => {
    expect(shVerb(mgn, 'test')).toContain('mgn_use_version "$r" "$sid" test');
    expect(shVerb(mgn, 'test-cleanup')).toContain('mgn_use_version "$r" "$sid" cutover');
    expect(shVerb(mgn, 'cutover')).toContain('mgn_use_version "$r" "$sid" cutover');
    expect(mgn).toContain('aws ec2 modify-launch-template --region "$r" --launch-template-id "$lt" --default-version "$ver"');
    expect(mgn.indexOf('mgn_use_version "$r" "$sid" test') < mgn.indexOf('aws mgn start-test')).toBe(true);
  });

  it('writes a test and a cutover launch per server: the test network, IPv6 where the network has it, IMDSv2', () => {
    const item = KIT.manifest.items.find((i) => i.name === 'web01')!;
    const test = JSON.parse(file(KIT, `paths/aws-mgn/launch/${item.resource}.test.json`));
    const cut = JSON.parse(file(KIT, `paths/aws-mgn/launch/${item.resource}.cutover.json`));
    expect(test.NetworkInterfaces[0].SubnetId).toBe('@subnet nonprod/app/a');
    expect(cut.NetworkInterfaces[0].SubnetId).toBe('@subnet prod/app/a');
    expect(cut.NetworkInterfaces[0].Ipv6AddressCount).toBe(1);
    expect(test.NetworkInterfaces[0].Ipv6AddressCount).toBeUndefined();
    expect(cut.MetadataOptions.HttpTokens).toBe('required');
    expect(cut.InstanceType).toBe('m7i.large');
    const servers = JSON.parse(file(KIT, 'paths/aws-mgn/servers.json'));
    expect(servers[item.id]).toEqual({ name: 'web01', platform: 'WINDOWS', osByol: true, file: item.resource });
  });

  it('writes the replication template with the settings, and no ids it cannot know', () => {
    const t = JSON.parse(file(KIT, 'paths/aws-mgn/replication-template.json'));
    expectHas(t, { dataPlaneRouting: 'PRIVATE_IP', createPublicIP: false, defaultLargeStagingDiskType: 'GP3', internetProtocol: 'IPV6', replicationServerInstanceType: 't3.small', stagingAreaSubnetId: '@staging_subnet' });
    const agentless = kitOf(SERVERS, { mgn: { replication: 'agentless', serverType: 'm5.large', bandwidthMbps: 200, ip: 'IPV4' } });
    expectHas(JSON.parse(file(agentless, 'paths/aws-mgn/replication-template.json')), { bandwidthThrottling: 200, internetProtocol: 'IPV4', replicationServerInstanceType: 'm5.large' });
    expect(agentless.files['ansible/mgn-agent.yml']).toBeUndefined();
  });

  it('installs the agent with credentials in the environment, never as flags, and checks its hash', () => {
    const play = file(KIT, 'ansible/mgn-agent.yml');
    expect(play).toContain('AWS_SESSION_TOKEN: "{{ lookup(\'ansible.builtin.env\', \'ATK_MGN_ST\') }}"');
    expect(play).toContain('checksum: "sha512:');
    expect(play).toContain('no_log: true');
    expect(/--aws-access-key-id|--aws-secret-access-key/.test(play + mgn)).toBe(false);
    expect(mgn).toContain('aws sts assume-role --role-arn "$role"');
  });

  it('exports the MGN import file and the Cloud Migration Factory intake form, one row per server', () => {
    const imp = file(KIT, 'paths/aws-mgn/mgn-import.csv').trim().split('\n');
    expect(imp[0]).toBe(MGN_IMPORT_COLUMNS.join(','));
    expect(imp.length).toBe(3);
    expect(imp[1]!.split(',').length).toBe(MGN_IMPORT_COLUMNS.length);
    const cmf = file(KIT, 'paths/aws-mgn/cmf-intake.csv').trim().split('\n');
    expect(cmf[0]).toBe(CMF_INTAKE_COLUMNS.join(','));
    for (const c of ['wave_name', 'app_name', 'aws_accountid', 'aws_region', 'server_name', 'server_os_family', 'server_os_version', 'server_fqdn', 'server_tier', 'server_environment', 'r_type', 'subnet_IDs', 'securitygroup_IDs', 'subnet_IDs_test', 'securitygroup_IDs_test', 'instanceType', 'tenancy']) {
      expect([c, CMF_INTAKE_COLUMNS.includes(c)]).toEqual([c, true]);
    }
    expect(cmf.some((l) => l.includes('Rehost') && l.includes('@subnet nonprod/app/'))).toBe(true);
  });

  it('uses the current name, AWS Transform MGN', () => {
    expect(mgn).toContain('AWS Transform MGN (formerly AWS Application Migration Service)');
    expect(file(KIT, 'paths/aws-mgn/README.md')).toContain('# AWS Transform MGN');
    expect(KIT.findings.some((f) => f.code === 'exec.path.tool-renamed' && f.message.includes('AWS Transform MGN'))).toBe(true);
  });
});

describe('WP-11c: Azure Migrate', () => {
  const ps = file(KIT, AZMIGRATE_SCRIPT);

  it('serves the three Azure Migrate paths from one PowerShell script', () => {
    expect(ps).toContain("Initialize-Atk -Path @('azure-migrate', 'azure-migrate-hyperv', 'azure-migrate-agent')");
    const servers = JSON.parse(file(KIT, 'paths/azure-migrate/servers.json'));
    const byName = Object.fromEntries(Object.values(servers as Record<string, { name: string; sourceType: string; licenseType: string; securityType: string; zone: string }>).map((s) => [s.name, s]));
    expectHas(byName['az-web01'], { sourceType: 'VMware', licenseType: 'WindowsServer', securityType: 'TrustedLaunch', zone: '1' });
    expect(byName['az-hv01']?.sourceType).toBe('HyperV');
    expect(byName['az-phys01']?.sourceType).toBe('Physical');
  });

  it('cuts over with -TurnOffSourceServer (agent: performShutdown), and tests into the test network', () => {
    const cut = psVerb(ps, 'cutover');
    expect(cut).toContain('Start-AzMigrateServerMigration -TargetObjectID $r.Id -TurnOffSourceServer');
    expect(cut).toContain("performShutdown = 'true'");
    expect(psVerb(ps, 'test')).toContain('Start-AzMigrateTestMigration -TargetObjectID $r.Id -TestNetworkID $lz.network_ids[$s.testNetwork]');
    expect(psVerb(ps, 'finalize')).toContain('Remove-AzMigrateServerReplication -TargetObjectID $r.Id');
  });

  it('installs the Mobility service for the agent path, with the passphrase from the vault', () => {
    const play = file(KIT, 'ansible/azure-mobility.yml');
    expect(play).toContain('vault_azure_migrate_passphrase');
    expect(play).toContain('UnifiedAgentConfigurator');
    expect(play).toContain('no_log: true');
    expect(KIT.findings.some((f) => f.code === 'exec.azmigrate.portal-step')).toBe(true);
  });

  it('writes no azurerm_migrate_* and no az migrate call', () => {
    const all = Object.values(KIT.files).join('\n');
    expect(/azurerm_migrate_/.test(all)).toBe(false);
    expect(/\baz migrate\s/.test(ps)).toBe(false);
  });
});

describe('WP-11c: Google Cloud (GCP) Migrate to Virtual Machines and image import', () => {
  const m2vm = file(KIT, M2VM_SCRIPT);

  it('calls the VM Migration REST API, never a gcloud migrating-vms group', () => {
    expect(m2vm).toContain('https://vmmigration.googleapis.com/v1');
    expect(/gcloud\s+migration\s+vms\s+migrating-vms/.test(m2vm)).toBe(false);
    expect(m2vm).toContain(':startMigration');
    expect(m2vm).toContain('/cloneJobs?cloneJobId=');
    expect(m2vm).toContain('/cutoverJobs?cutoverJobId=');
    expect(m2vm).toContain(':finalizeMigration');
    expect(/google_vm_migration_/.test(Object.values(KIT.files).join('\n'))).toBe(false);
  });

  it('keeps the access token and the source credentials out of the process list', () => {
    expect(m2vm).toContain("-H @<(printf 'Authorization: Bearer %s\\n' \"$(m2vm_token)\")");
    expect(m2vm).toContain('password: env.M2VM_SECRET');
    expect(/Authorization: Bearer \$\(/.test(m2vm.replace(/printf 'Authorization: Bearer %s\\n'/g, ''))).toBe(false);
  });

  it('writes the cutover and test targets, the AWS source by its region, and the image import', () => {
    const items = new Map(KIT.manifest.items.map((i) => [i.name, i]));
    const app = items.get('gc-app01')!;
    const t = JSON.parse(file(KIT, `paths/gcp-m2vm/targets/${app.resource}.json`));
    const test = JSON.parse(file(KIT, `paths/gcp-m2vm/targets/${app.resource}.test.json`));
    expectHas(t, { vmName: 'gc-app01', machineType: 'n2-standard-4', zone: 'europe-west2-a', diskType: 'COMPUTE_ENGINE_DISK_TYPE_BALANCED' });
    expect(test.vmName).toBe('gc-app01-test');
    expect(test.networkInterfaces[0].subnetwork).toBe('@subnet nonprod/app/a');
    const servers = JSON.parse(file(KIT, 'paths/gcp-m2vm/servers.json'));
    expectHas(servers[items.get('gc-ec2')!.id], { sourceKind: 'aws', sourceVmId: 'i-0abc1234', source: 'atk-plan7f3a-aws-us-east-1' });
    expectHas(servers[app.id], { sourceKind: 'vmware', source: 'atk-plan7f3a-vc', sourceVmId: 'vm-1042' });
    const img = file(KIT, IMAGE_IMPORT_SCRIPT);
    expect(img).toContain('gcloud migration vms image-imports create');
    expect(KIT.findings.some((f) => f.code === 'exec.m2vm.image-import-outage')).toBe(true);
  });

  it('splits the bulk file at 100 rows', () => {
    const many: Server[] = Array.from({ length: M2VM_BULK_MAX_ROWS + 1 }, (_, i) => ({ name: `gvm${String(i).padStart(3, '0')}`, cloud: 'google', wave: 1 }));
    const k = kitOf(many);
    const first = file(k, 'paths/gcp-m2vm/m2vm-bulk-1.csv').trim().split('\n');
    const second = file(k, 'paths/gcp-m2vm/m2vm-bulk-2.csv').trim().split('\n');
    expect([first.length - 1, second.length - 1]).toEqual([M2VM_BULK_MAX_ROWS, 1]);
    expect(first[0]!.startsWith('Source name,Region,Source VM ID,Source VM Display name')).toBe(true);
  });
});

describe('WP-11c: Oracle Cloud Migrations', () => {
  const ocm = file(KIT, OCM_SCRIPT);

  it('maps the inventory to OCIDs for Terraform, then drives replication and the plans', () => {
    expect(ocm).toContain('ocm-assets.auto.tfvars.json');
    expect(ocm).toContain('oci cloud-bridge inventory asset list');
    expect(ocm).toContain('oci cloud-migrations migration start-migration-replication');
    expect(ocm).toContain('oci cloud-migrations migration-plan execute');
    expect(/oci_database_migration\b(?!_)/.test(Object.values(KIT.files).join('\n'))).toBe(false);
  });

  it('exports the target assets per server and plan, and installs VirtIO on Windows first', () => {
    const rows = file(KIT, 'paths/oci-ocm/target-assets.csv').trim().split('\n');
    expect(rows[0]).toBe(OCM_TARGET_ASSET_COLUMNS.join(','));
    expect(rows.length - 1).toBe(4);
    expect(rows.some((r) => r.includes(',test,oc-app01,VM.Standard.E5.Flex,2,32,nonprod/app/'))).toBe(true);
    expect(file(KIT, 'ansible/ocm-agent.yml')).toContain('ansible.windows.win_package');
    expect(shVerb(ocm, 'prepare')).toContain('ansible/ocm-agent.yml');
  });
});

describe('WP-11c: the shared pieces', () => {
  it('quotes CSV cells only when it has to', () => {
    expect(csvText(['a', 'b'], [['x,y', 'say "hi"'], [1, true]])).toBe('a,b\n"x,y","say ""hi"""\n1,true\n');
  });
  it('the AWS generator writes nothing for an empty design, and says so', () => {
    const { plan, decision, waves } = fixture([{ name: 'lost', cloud: 'aws', wave: 1 }]);
    const k = executionKit(plan, decision, { platforms: [], findings: [] }, waves, undefined, { registry: createRegistry([AWS_MGN_GENERATOR]) });
    expect(k.findings.some((f) => f.code === 'exec.mgn.no-design')).toBe(true);
    expect(JSON.parse(file(k, 'paths/aws-mgn/servers.json'))).toEqual({});
    expect(k.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});
