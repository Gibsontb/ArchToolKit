/**
 * WP-11b: the VMware and rebuild path generators (addendum A.6.3, A.6.4,
 * A.6.10): HCX (Bulk, RAV, vMotion, Cold, OSAM), Cross vCenter vMotion,
 * VCF Import, vCenter Converter and rebuild.
 *
 *   - through `createRegistry` and `executionKit`: the kit builds with no
 *     error finding, and `contractViolations` is empty on every file;
 *   - hcx.ps1 uses only Broadcom's published HCX cmdlets, never
 *     Stop-HCXMigration / Remove-HCXMigration / -UnextendNetwork;
 *   - the Mobility Group export, the underlay minimums, the RAV warning;
 *   - VCF Import generates no import automation;
 *   - rebuild copies with robocopy /COPY:DATSOU /DCOPY:DAT and
 *     rsync -aHAX --numeric-ids;
 *   - the house rules (names, no credentials, no footprints);
 *   - bash -n and the PowerShell parser (skipped when not installed).
 */

import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from '../../../../testing/expect.ts';
import { defaultExecution, defaultRequirements, DEFAULT_WAVE_SETTINGS, itemId } from '../../options.ts';
import type {
  App, ExecutionSettings, ItemDecision, Method, Plan, PlanDecision, Platform, TargetDesign, WavePlan, Workload,
} from '../../types.ts';
import { contractViolations } from '../contract.ts';
import { executionKit, type ExecutionKit } from '../kit.ts';
import { createRegistry, type PathGenerator } from '../registry.ts';
import {
  GENERATORS as HCX, HCX_CMDLETS, HCX_FORBIDDEN, HCX_MIGRATION_TYPE, HCX_UNDERLAY_MIN, mobilityGroupName, underlayProblems,
  type HcxMobilityGroups,
} from './hcx.ts';
import { dataSetsFor, GENERATORS as REBUILD } from './rebuild.ts';
import { GENERATORS as CONVERTER } from './vcf-converter.ts';
import { GENERATORS as IMPORT, VCF_IMPORT_PREREQUISITES } from './vcf-import.ts';
import { GENERATORS as XVC } from './xvc.ts';

const ALL: readonly PathGenerator[] = [...HCX, ...XVC, ...IMPORT, ...CONVERTER, ...REBUILD];

// ---------------------------------------------------------------------------
// Fixture: one item on every WP-11b path
// ---------------------------------------------------------------------------

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app: 'shop', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual',
    sourceRef: { platform: 'vsphere', manager: 'vc01.corp.example', cluster: 'cl-a', id: `vm-${name.length}${name.charCodeAt(0)}` },
    ...over,
  };
}
function app(name: string, over: Partial<App> = {}): App {
  return { id: itemId('app', name), name, criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', ...over };
}
function dec(w: Workload, platform: Platform, method: Method, over: Partial<ItemDecision> = {}): ItemDecision {
  const chosen = { platform, score: 10, hits: [] };
  return {
    id: w.id, kind: 'workload', disposition: method === 'relocate-hcx' ? 'relocate' : 'rehost', method,
    options: [chosen], chosen, pinned: false, margin: 5, findings: [], ...over,
  };
}

const WS = {
  bulk: workload('bulk01'),
  rav: workload('rav01', { criticality: 'tier0' }),
  vmotion: workload('vmo01'),
  cold: workload('cold01', { facts: { powerState: 'poweredOff' } }),
  osam: workload('kvm01', { origin: 'kvm', sourceRef: { platform: 'kvm', host: 'kvm-host1' } }),
  xvc: workload('xvc01'),
  imp: workload('imp01', { sourceRef: { platform: 'vsphere', manager: 'vc02.corp.example', cluster: 'cl-imp' } }),
  conv: workload('phys01', { origin: 'physical', os: 'win-2022', sourceRef: { platform: 'physical', host: 'phys01.corp.example' } }),
  rbw: workload('rbwin01', { os: 'win-2022', facts: { services: ['W3SVC'] } }),
  rbl: workload('rblin01', { app: 'crm', facts: { services: ['nginx'] } }),
};

function fixture(execution: Partial<ExecutionSettings> = {}): { plan: Plan; decision: PlanDecision; waves: WavePlan; design: TargetDesign } {
  const ws = Object.values(WS);
  const plan: Plan = {
    kind: 'archtoolkit.multicloud-plan', version: 1, id: 'Plan-7f3a9c21-x', name: 'VMware move', savedAt: '2026-09-26T00:00:00.000Z',
    workloads: ws, databases: [], apps: [app('shop'), app('crm')], edges: [], requirements: defaultRequirements(), designOverrides: {},
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    execution: {
      ...defaultExecution(),
      pathOverrides: { [WS.vmotion.id]: 'hcx-vmotion', [WS.xvc.id]: 'xvc-vmotion' },
      vcfImportClusters: ['cl-imp'],
      hcx: {
        sourceSite: 'onprem-dc1', destSite: 'avs-weu', extend: ['pg-web'], mappings: [{ from: 'pg-web', to: 'seg-web' }],
        container: 'Cluster-1', datastore: 'vsanDatastore', folder: 'Migrated', windowHours: 4,
      },
      dataSets: [
        { workload: 'rbwin01', source: '\\\\oldfs01\\data', target: 'D:\\data', method: 'robocopy', exclude: '*.tmp;~$*' },
        { workload: 'rblin01', source: 'oldlin01:/srv/app', target: '/srv/app', method: 'rsync' },
        { workload: 'rblin01', source: 'https://acct.blob.core.windows.net/c?sv=2024&sig=abc', target: '/srv/blob', method: 'azcopy' },
      ],
      ...execution,
    },
  };
  const decision: PlanDecision = {
    engineVersion: 'test', platforms: [], subsetScores: [], findings: [],
    items: Object.fromEntries([
      dec(WS.bulk, 'azure', 'relocate-hcx'),
      dec(WS.rav, 'azure', 'relocate-hcx'),
      dec(WS.vmotion, 'vmware', 'relocate-hcx'),
      dec(WS.cold, 'vmware', 'relocate-hcx'),
      dec(WS.osam, 'google', 'relocate-hcx'),
      dec(WS.xvc, 'vmware', 'relocate-hcx'),
      dec(WS.imp, 'vmware', 'relocate-hcx'),
      dec(WS.conv, 'vmware', 'replicate'),
      dec(WS.rbw, 'aws', 'rebuild'),
      dec(WS.rbl, 'aws', 'rebuild', { disposition: 'refactor' }),
    ].map((d) => [d.id, d])),
  };
  const waves: WavePlan = {
    settings: { ...DEFAULT_WAVE_SETTINGS, freezes: [] },
    groups: [
      { id: 'g-shop', name: 'Shop web', items: [WS.bulk.id, WS.rav.id, WS.vmotion.id, WS.cold.id, WS.osam.id], why: 'app', wave: 1, method: 'relocate-hcx' },
      { id: 'g-dc', items: [WS.xvc.id, WS.imp.id, WS.conv.id], why: 'app', wave: 1, method: 'relocate-hcx' },
      { id: 'g-crm', items: [WS.rbw.id, WS.rbl.id], why: 'app', wave: 2, method: 'rebuild' },
    ],
    waves: [{ n: 1, groups: ['g-shop', 'g-dc'], start: '2030-10-03' }, { n: 2, groups: ['g-crm'] }],
    findings: [],
  };
  const pd = (platform: Platform, prefix: string) => ({ platform, prefix, region: 'r1', compute: [], databases: [] });
  const design = { platforms: [pd('azure', 'shopaz'), pd('google', 'shopgc'), pd('vmware', 'shopvcf'), pd('aws', 'shopaws')], findings: [] } as unknown as TargetDesign;
  return { plan, decision, waves, design };
}

function kitOf(execution: Partial<ExecutionSettings> = {}): ExecutionKit {
  const { plan, decision, waves, design } = fixture(execution);
  return executionKit(plan, decision, design, waves, undefined, { registry: createRegistry(ALL) });
}
const KIT = kitOf();
const F = (p: string): string => {
  const t = KIT.files[p];
  if (t === undefined) throw new Error(`no file ${p}`);
  return t;
};
const codes = (k: ExecutionKit): string[] => k.findings.map((f) => f.code);

// ---------------------------------------------------------------------------
// Registry and kit
// ---------------------------------------------------------------------------

describe('WP-11b generators in the registry', () => {
  it('register every WP-11b path, and nothing else', () => {
    const r = createRegistry(ALL);
    const mine = ['hcx-bulk', 'hcx-rav', 'hcx-vmotion', 'hcx-cold', 'hcx-osam', 'xvc-vmotion', 'vcf-import', 'vcf-converter', 'rebuild'] as const;
    for (const p of mine) expect(r.get(p)?.owner).toBe('WP-11b');
    for (const p of mine) expect(r.missing().includes(p)).toBe(false);
    expect(ALL.flatMap((g) => g.paths).sort()).toEqual([...mine].sort());
  });
  it('every item lands on the path the fixture aims at, with its generator\'s script', () => {
    const by = new Map(KIT.manifest.items.map((i) => [i.name, i]));
    const expectPath = (name: string, path: string, script: string): void => {
      expect<string | undefined>(by.get(name)?.path).toBe(path);
      expect(by.get(name)?.script).toBe(script);
    };
    expectPath('bulk01', 'hcx-bulk', 'paths/hcx/hcx.ps1');
    expectPath('rav01', 'hcx-rav', 'paths/hcx/hcx.ps1');
    expectPath('vmo01', 'hcx-vmotion', 'paths/hcx/hcx.ps1');
    expectPath('cold01', 'hcx-cold', 'paths/hcx/hcx.ps1');
    expectPath('kvm01', 'hcx-osam', 'paths/hcx/hcx.ps1');
    expectPath('xvc01', 'xvc-vmotion', 'paths/xvc-vmotion/xvc.ps1');
    expectPath('imp01', 'vcf-import', 'paths/vcf-import/vcf-import.ps1');
    expectPath('phys01', 'vcf-converter', 'paths/vcf-converter/converter.ps1');
    expectPath('rbwin01', 'rebuild', 'paths/rebuild/rebuild.sh');
    expectPath('rblin01', 'rebuild', 'paths/rebuild/rebuild.sh');
  });
  it('builds with no error other than the refused data set, and no pending path', () => {
    const errors = KIT.findings.filter((f) => f.severity === 'error');
    expect(errors.map((f) => f.code)).toEqual(['exec.rebuild.data-set-refused']);
    expect(codes(KIT).includes('exec.path.no-generator')).toBe(false);
    expect(KIT.files['paths/pending/pending.sh']).toBeUndefined();
  });
  it('keeps the contract in every file it writes', () => {
    const bad = Object.entries(KIT.files).flatMap(([p, t]) => contractViolations(p, t));
    expect(bad).toEqual([]);
    const mine = Object.keys(KIT.files).filter((p) => p.startsWith('paths/') || p.startsWith('ansible/'));
    expect(mine.length).toBeGreaterThanOrEqual(15);
  });
  it('is reproducible', () => {
    expect(kitOf().files).toEqual(KIT.files);
  });
  it('asks the controller for VCF PowerCLI, Terraform, Ansible and ansible.windows', () => {
    const check = F('controller-check.sh');
    expect(check).toContain("check_pwsh_module 'VCF.PowerCLI'");
    expect(check).toContain("check_command 'terraform'");
    expect(check).toContain("check_command 'ansible'");
    expect(check).toContain("check_collection 'ansible.windows'");
    expect(check).toContain("check_command 'pwsh'");
  });
});

// ---------------------------------------------------------------------------
// HCX
// ---------------------------------------------------------------------------

describe('HCX', () => {
  const ps = F('paths/hcx/hcx.ps1');
  it('uses only cmdlets from Broadcom\'s VMware.VimAutomation.Hcx list', () => {
    const used = [...new Set([...ps.matchAll(/\b[A-Z][a-z]+-HCX[A-Za-z]+\b/g)].map((m) => m[0]))].sort();
    expect(used.length).toBeGreaterThanOrEqual(20);
    expect(used.filter((c) => !HCX_CMDLETS.includes(c))).toEqual([]);
    for (const c of ['New-HCXMigration', 'New-HCXMobilityGroup', 'Start-HCXMobilityGroupMigration', 'Test-HCXMobilityGroup', 'Set-HCXMigration', 'Remove-HCXNetworkExtension', 'New-HCXSentinelBundle']) {
      expect(used).toContain(c);
    }
  });
  it('never stops or removes a migration, and has no -UnextendNetwork', () => {
    for (const f of HCX_FORBIDDEN) expect(ps.includes(f)).toBe(false);
    expect(HCX_CMDLETS.includes('Stop-HCXMigration')).toBe(false);
    expect(HCX_CMDLETS.includes('Remove-HCXMigration')).toBe(false);
    expect(ps).toContain('Remove-HCXNetworkExtension -HCXNetworkExtension $ne -ConnectToLocalRouter $true');
  });
  it('maps every path to the cmdlet\'s migration type', () => {
    expect(HCX_MIGRATION_TYPE).toEqual({ 'hcx-bulk': 'Bulk', 'hcx-rav': 'RAV', 'hcx-vmotion': 'vMotion', 'hcx-cold': 'Cold', 'hcx-osam': 'OsAssistedMigration' });
    expect(ps).toContain("'hcx-osam' = 'OsAssistedMigration'");
  });
  it('creates a mobility group per wave and move group, with the settings HCX asks for', () => {
    const exp = JSON.parse(F('paths/hcx/mobility-groups.json')) as HcxMobilityGroups;
    expect(exp.kind).toBe('archtoolkit.hcx-mobility-groups');
    expect(exp.placement).toEqual({ container: 'Cluster-1', datastore: 'vsanDatastore', folder: 'Migrated', diskProvisionType: 'Thin' });
    expect(exp.networkMappings).toEqual([{ source: 'pg-web', destination: 'seg-web' }]);
    expect(exp.options.retainMac).toBe(true);
    expect(exp.groups.length).toBe(1);
    const g = exp.groups[0]!;
    expect(g.name).toBe('atk-plan7f3a-w1-g-shop');
    expect(g.switchover).toEqual({ start: '2030-10-03', windowHours: 4 });
    expect(g.migrationTypes).toEqual(['Bulk', 'OsAssistedMigration', 'RAV']);
    const via = Object.fromEntries(g.vms.map((v) => [v.name, v.viaGroup]));
    expect(via).toEqual({ bulk01: true, rav01: true, vmo01: false, cold01: false, kvm01: true });
  });
  it('names groups deterministically within 63 characters', () => {
    const long = mobilityGroupName('p', 3, 'x'.repeat(90));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toBe(mobilityGroupName('p', 3, 'x'.repeat(90)));
    expect(mobilityGroupName('Plan-7f3a9c21-x', null, 'Shop Web')).toBe('atk-plan7f3a-w0-shop-web');
  });
  it('holds Broadcom\'s underlay minimums: vMotion / RAV 150 / 250 Mbps and 0.1 %, Bulk 50 Mbps, 150 ms', () => {
    expect(HCX_UNDERLAY_MIN['hcx-rav']).toEqual({ mbps: 250, mbpsWanOpt: 150, lossPct: 0.1, latencyMs: 150, mtu: 1150 });
    expect(HCX_UNDERLAY_MIN['hcx-vmotion'].mbps).toBe(250);
    expect(HCX_UNDERLAY_MIN['hcx-bulk']).toEqual({ mbps: 50, lossPct: 1, latencyMs: 150, mtu: 1150 });
    expect(underlayProblems('hcx-rav', { mbps: 200 })).toEqual(['200 Mbps is below 250 Mbps (without WAN Optimization)']);
    expect(underlayProblems('hcx-rav', { mbps: 200, wanOpt: true })).toEqual([]);
    expect(underlayProblems('hcx-vmotion', { lossPct: 0.2, latencyMs: 151 }).length).toBe(2);
    expect(underlayProblems('hcx-bulk', { mbps: 50, lossPct: 0.5, latencyMs: 150, mtu: 1150 })).toEqual([]);
    expect(underlayProblems('hcx-bulk', { mbps: 40, mtu: 1100 }).length).toBe(2);
    const u = JSON.parse(F('paths/hcx/underlay.json')) as { paths: Record<string, { mbps: number; lossPct: number }> };
    expect(u.paths['hcx-rav']!.lossPct).toBe(0.1);
    expect(ps).toContain('ATK_HCX_UNDERLAY_LOSS_PCT');
    expect(ps).toContain('ATK_HCX_WAN_OPT');
  });
  it('raises the no-automatic-fallback warning for RAV, in the findings, the script and the README', () => {
    const fb = KIT.findings.filter((f) => f.code === 'exec.path.no-fallback');
    expect(fb.some((f) => /Replication Assisted vMotion/.test(f.message))).toBe(true);
    expect(ps).toContain('$RavWarning');
    expect(F('paths/hcx/README.md')).toContain('no retained copy to fall back to');
  });
  it('writes the AVS and GCVE enablers, and the Sentinel playbook for OS Assisted Migration', () => {
    const avs = F('paths/hcx/enable-avs.sh');
    expect(avs).toContain('atk_run az vmware addon hcx create');
    expect(avs).toContain('--offer "VMware MaaS Cloud Provider (Enterprise)"');
    expect(avs).toContain('atk_run az vmware hcx-enterprise-site create');
    expect(avs).toContain('AVS_PRIVATE_CLOUD:-shopaz-avs');
    expect(avs).toContain('atk-plan7f3a-onprem');
    const gcve = F('paths/hcx/enable-gcve.sh');
    expect(gcve).toContain('atk_run gcloud vmware private-clouds hcx activationkeys create');
    expect(gcve).toContain('GCVE_PRIVATE_CLOUD:-shopgc-gcve');
    const pb = F('ansible/hcx-sentinel.yml');
    expect(pb).toContain('linux-sentinel-installer.sh');
    expect(pb).toContain('/VERYSILENT /NORESTART');
  });
  it('leaves the enablers and the playbook out when nothing needs them', () => {
    const { plan, decision, waves, design } = fixture();
    const only = { ...decision, items: { [WS.bulk.id]: dec(WS.bulk, 'vmware', 'relocate-hcx') } };
    const kit = executionKit({ ...plan, workloads: [WS.bulk] }, only, design, waves, undefined, { registry: createRegistry(ALL) });
    expect(kit.files['paths/hcx/hcx.ps1']).toBeDefined();
    expect(kit.files['paths/hcx/enable-avs.sh']).toBeUndefined();
    expect(kit.files['paths/hcx/enable-gcve.sh']).toBeUndefined();
    expect(kit.files['ansible/hcx-sentinel.yml']).toBeUndefined();
  });
  it('reports the gaps: the gateways to extend, the unmeasured underlay, missing settings', () => {
    expect(codes(KIT)).toContain('exec.hcx.extend-gateway');
    expect(codes(KIT)).toContain('exec.hcx.underlay-unmeasured');
    const ext = JSON.parse(F('paths/hcx/network-mappings.json')) as { extend: { network: string; gateway: null }[] };
    expect(ext.extend.length).toBe(1);
    expect(ext.extend[0]!.network).toBe('pg-web');
    expect(ext.extend[0]!.gateway).toBeNull();
    const bare = kitOf({ hcx: undefined });
    expect(codes(bare)).toContain('exec.hcx.no-settings');
  });
  it('rolls Bulk back to the retained source, and moves vMotion / RAV back with a reverse migration', () => {
    expect(ps).toContain('Find-HcxRetainedSource');
    expect(ps).toContain("-Type $reverseType -Reverse");
    expect(ps).toContain('Remove-VM -VM $source -DeletePermanently');
  });
});

// ---------------------------------------------------------------------------
// Cross vCenter vMotion, VCF Import, vCenter Converter
// ---------------------------------------------------------------------------

describe('Cross vCenter vMotion', () => {
  it('moves live with Move-VM and checks the prerequisites first', () => {
    const ps = F('paths/xvc-vmotion/xvc.ps1');
    expect(ps).toContain('Move-VM @move');
    expect(ps).toContain('DiskStorageFormat');
    expect(ps).toContain('17327517');
    expect(ps).toContain('SupportedEVCMode');
    expect(ps).toContain('1.1 * [double] $Vm.UsedSpaceGB');
    const cfg = JSON.parse(F('paths/xvc-vmotion/xvc.json')) as { cluster: string; items: { name: string }[] };
    expect(cfg.cluster).toBe('Cluster-1');
    expect(cfg.items.map((i) => i.name)).toEqual(['xvc01']);
  });
});

describe('VCF Import', () => {
  it('generates the precheck, the verify and the README, and no import automation', () => {
    const files = Object.keys(KIT.files).filter((p) => p.startsWith('paths/vcf-import/')).sort();
    expect(files).toEqual(['paths/vcf-import/README.md', 'paths/vcf-import/vcf-import.ps1']);
    const ps = F('paths/vcf-import/vcf-import.ps1');
    // the only POSTs are the two logins
    const posts = [...ps.matchAll(/Invoke-AtkLogin\s+"([^"]+)"/g)].map((m) => m[1]!.replace(/^https:\/\/\$[^/]+/, ''));
    expect(posts.sort()).toEqual(['/api/session', '/v1/tokens']);
    expect(/brownfield|Import-|\/v1\/domains[^\n]*Post/i.test(ps.replace(/Import-Module[^\n]*/g, ''))).toBe(false);
    expect(ps).toContain("'/api/appliance/access/ssh'");
    expect(ps).toContain('/api/v1/node/version');
    expect(ps).toContain('/v1/domains');
    const readme = F('paths/vcf-import/README.md');
    expect(readme).toContain('Import a vCenter');
    expect(readme).toContain('no partial import');
    expect(VCF_IMPORT_PREREQUISITES.length).toBeGreaterThanOrEqual(12);
    expect(codes(KIT)).toContain('exec.vcf-import.manual');
  });
});

describe('vCenter Converter', () => {
  it('writes a job sheet per machine and automates the vCenter side', () => {
    const job = JSON.parse(F('paths/vcf-converter/jobs/atk-plan7f3a-1-phys01.json')) as { destination: { cluster: string; diskProvisioning: string }; synchronize: boolean };
    expect(job.destination.cluster).toBe('Cluster-1');
    expect(job.destination.diskProvisioning).toBe('thin');
    expect(job.synchronize).toBe(true);
    const ps = F('paths/vcf-converter/converter.ps1');
    expect(ps).toContain('-StartConnected:$false');
    expect(ps).toContain('guestToolsRunning');
    expect(codes(KIT)).toContain('exec.converter.operator-step');
  });
});

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

describe('rebuild', () => {
  it('copies with robocopy /COPY:DATSOU /DCOPY:DAT and rsync -aHAX --numeric-ids', () => {
    const pb = F('ansible/rebuild-copy.yml');
    expect(pb).toContain("'/MIR', '/COPY:DATSOU', '/DCOPY:DAT'");
    expect(pb).toContain("'-aHAX', '--numeric-ids', '--delete', '--partial'");
    expect(pb).toContain('failed_when: copy_robocopy.rc >= 8');
    const sh = F('paths/rebuild/rebuild.sh');
    expect(sh).toContain('atk_run terraform -chdir="$dir" apply -input=false -auto-approve');
    expect(sh).toContain('IN_SYNC_BYTES=1073741824');
    expect(F('paths/rebuild/README.md')).toContain('/COPY:DATSOU /DCOPY:DAT');
  });
  it('writes the data sets of the rebuilt servers, and refuses a path with a credential', () => {
    const csv = F('paths/rebuild/data-sets.csv').trim().split('\n');
    expect(csv[0]).toBe('workload,source,target,method,exclude');
    expect(csv.slice(1)).toEqual(['rblin01,oldlin01:/srv/app,/srv/app,rsync,', 'rbwin01,\\\\oldfs01\\data,D:\\data,robocopy,*.tmp;~$*']);
    const refused = KIT.findings.find((f) => f.code === 'exec.rebuild.data-set-refused');
    expect(refused?.message).toContain('credential');
    const { rows, refused: r2 } = dataSetsFor(KIT.manifest.items.filter((i) => i.path === 'rebuild'), [{ workload: 'rbwin01', source: 'a,b', target: 'c', method: 'robocopy' }]);
    expect(rows).toEqual([]);
    expect(r2[0]!.reason).toContain('comma');
  });
  it('points refactored apps at the wave hooks', () => {
    const hook = KIT.findings.find((f) => f.code === 'exec.refactor.hook');
    expect(hook?.message).toContain('crm');
    expect(hook?.message).toContain('hooks/2/');
  });
});

// ---------------------------------------------------------------------------
// House rules
// ---------------------------------------------------------------------------

describe('house rules', () => {
  const mine = Object.entries(KIT.files).filter(([p]) => p.startsWith('paths/') || p.startsWith('ansible/'));
  it('Broadcom VCF 9.1 names only: no ESXi, Aria, vRealize or Service Broker', () => {
    const bad = mine.filter(([, t]) => /\bESXi\b|\bAria\b|vRealize|Service Broker/.test(t)).map(([p]) => p);
    expect(bad).toEqual([]);
  });
  it('applies by default: --dry-run / -DryRun is opt-in and nothing asks', () => {
    for (const [p, t] of mine) {
      if (p.endsWith('.sh')) expect(/atk_init(_tool)? /.test(t)).toBe(true);
      if (p.endsWith('.ps1')) expect(t).toContain('[switch] $DryRun');
      expect(/\s--yes\b|Read-Host|-Confirm:\$true/.test(t)).toBe(false);
    }
  });
  it('no credential in any file: secrets come from Get-AtkSecret / atk_secret', () => {
    for (const [, t] of mine) expect(/(PASSWORD|password)\s*=\s*['"][^'"$]/.test(t)).toBe(false);
    for (const p of ['paths/hcx/hcx.ps1', 'paths/xvc-vmotion/xvc.ps1', 'paths/vcf-import/vcf-import.ps1']) expect(F(p)).toContain('Get-AtkSecret');
  });
});

// ---------------------------------------------------------------------------
// Syntax, with the real tools when they are installed
// ---------------------------------------------------------------------------

function tool(cmd: string, args: readonly string[], input?: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const x = e as { status?: number | null; stdout?: string; stderr?: string };
    return { status: x.status ?? 1, stdout: String(x.stdout ?? ''), stderr: String(x.stderr ?? '') };
  }
}
const BASH = tool('bash', ['-c', 'echo "$BASH_VERSION"']).stdout.trim().split('.').map(Number);
const HAS_BASH = BASH[0]! > 4 || (BASH[0] === 4 && BASH[1]! >= 4);
const HAS_PWSH = Number(tool('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major']).stdout.trim()) >= 7;

describe('syntax', () => {
  it('bash -n passes on every .sh', { skip: !HAS_BASH && 'bash 4.4+ is not installed' }, () => {
    const bad: string[] = [];
    for (const [p, t] of Object.entries(KIT.files).filter(([p]) => p.endsWith('.sh'))) {
      const r = tool('bash', ['-n'], t);
      if (r.status !== 0) bad.push(`${p}: ${r.stderr}`);
    }
    expect(bad).toEqual([]);
  });
  it('the PowerShell parser accepts every .ps1', { skip: !HAS_PWSH && 'pwsh is not installed' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'atk-vmw-'));
    try {
      const files = Object.entries(KIT.files).filter(([p]) => p.endsWith('.ps1'));
      files.forEach(([, t], i) => writeFileSync(join(dir, `f${i}.ps1`), t));
      const r = tool('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
        `$bad = @(); foreach ($f in Get-ChildItem -LiteralPath '${dir.replace(/\\/g, '/')}' -File) { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e); foreach ($x in $e) { $bad += "$($f.Name):$($x.Extent.StartLineNumber): $($x.Message)" } }; $bad -join [char]10`]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(files.length).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
