import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../../../../testing/expect.ts';
import { INTAKE_ADAPTERS, intakeAdapter } from '../index.ts';
import { COLLECTOR_COMMON_SH } from './collector-scripts.ts';
import { DEFAULT_GROUPING, UNASSIGNED_APP, groupApp, regroup, tierOf, validNameRegex } from '../grouping.ts';
import type { Workload } from '../../types.ts';
import {
  COLLECTORS, collectorBundle, collectorFiles, renderCollector,
  parseDiscovery, intakeFromDiscovery, discoveryFlowsCsv, DISCOVERY_ADAPTER,
  parseAzureMigrateCsv, intakeFromAzureMigrate, parseMigrationCenter, intakeFromMigrationCenter,
  parseAwsImportCsv, parseAhvCsv, intakeFromAhvCsv, parsePerfCsv, applyPerf,
  parseAzureDependencyCsv, proposeEdges, parseMgnImportCsv, parseCmfIntakeCsv,
  applySizingBasis, COMFORT_FACTOR, confidenceBand, defaultBasis,
  readTable, mapHeader, num, sizeGib, percentile, utilisationFromSeries, SOURCE_INTAKE_ADAPTERS,
} from './index.ts';

const ON = '2026-09-26';
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
const hasJq = hasBash && spawnSync('bash', ['-c', 'command -v jq']).status === 0;

/** The PowerShell parser's errors for a script text ([] when it parses). */
function psErrors(text: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'atk-ps-'));
  try {
    const file = join(dir, 'script.ps1');
    writeFileSync(file, text);
    const r = spawnSync('pwsh', ['-NoProfile', '-Command',
      `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);$e|%{ "$($_.Extent.StartLineNumber): $($_.Message)" }`], { encoding: 'utf8' });
    return r.stdout.split(/\r?\n/).filter((l: string) => l.trim() !== '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const envelope = (platform: string, manager: string, servers: object[]) => JSON.stringify({ kind: 'archtoolkit.discovery', v: 1, source: { platform, manager }, collectedAt: '2026-09-20', servers });

// ---------------------------------------------------------------------------
// One sample per collector, in the exact shape each writes
// ---------------------------------------------------------------------------

const SAMPLES: Record<string, string> = {
  'collect-hyperv.ps1': envelope('hyperv', 'hv-cluster-01', [{
    name: 'crm-app01', id: '5c1b7f0e-8a4e-4c43-9a55-0f7a3c1d2e11', host: 'hv03', kind: 'vm', powerState: 'Running', vcpu: 4, ramGib: 16, firmware: 'efi',
    disks: [{ gib: 127, usedGib: 61.2 }, { gib: 200, usedGib: 20 }], nics: [{ mac: '00155D010203', network: 'vSwitch-Prod', ipv4: ['10.1.2.3'], ipv6: ['2001:db8::3'] }],
    os: { raw: 'Windows Server 2019 Datacenter', version: '10.0.17763' }, cluster: 'hv-cluster-01', annotation: 'CRM application tier',
    tags: { generation: '2', version: '10.0', dynamicMemory: 'True' },
  }]),
  'collect-scvmm.ps1': envelope('hyperv', 'vmm01.corp.example', [{
    name: 'hr-web01', id: '0f3c', host: 'hv11.corp.example', kind: 'vm', powerState: 'Running', vcpu: 2, ramGib: 8, firmware: 'efi',
    disks: [{ gib: 80, usedGib: 31.5 }], nics: [{ mac: '00:15:5D:0A:0B:0C', network: 'Prod', ipv4: ['10.2.0.10'], ipv6: [] }],
    os: { raw: 'Windows Server 2022 Standard', version: '10.0.20348' }, tags: { tag: 'hr', Application: 'HR' }, cluster: 'HVCL02',
  }]),
  'collect-ahv.sh': envelope('ahv', 'pc01.corp.example', [{
    name: 'erp-db01', id: '2b3c4d5e-0000-4000-8000-000000000001', host: 'a1b2', cluster: 'c3d4', kind: 'vm', powerState: 'ON', vcpu: 8, ramGib: 64, firmware: 'bios',
    disks: [{ gib: 100 }, { gib: 500 }], nics: [{ mac: '50:6b:8d:01:02:03', ipv4: ['10.3.0.21'] }], annotation: 'ERP Oracle database',
    tags: { App: 'ERP', Environment: 'Production' },
  }]),
  'collect-libvirt.sh': envelope('kvm', 'kvm01.corp.example', [{
    name: 'build01', id: '6d1e0c2a-5b7f-4f9e-a1c3-0e2d4f6a8b01', host: 'kvm01.corp.example', kind: 'vm', powerState: 'running', vcpu: 4, ramGib: 8, firmware: 'efi',
    disks: [{ gib: 40, usedGib: 12.3 }], nics: [{ mac: '52:54:00:12:34:56', ipv4: ['192.168.122.15'], ipv6: [] }], os: { raw: 'Rocky Linux 9.4 (Blue Onyx)', version: '9.4' },
  }]),
  'collect-proxmox.sh': envelope('proxmox', 'pve-cluster', [{
    name: 'git01', id: '101', host: 'pve1', cluster: 'pve-cluster', kind: 'vm', powerState: 'running', vcpu: 2, ramGib: 4, firmware: 'bios',
    disks: [{ name: 'scsi0', gib: 32 }], nics: [{ mac: 'BC:24:11:AA:BB:CC', ipv4: ['10.4.0.5'], ipv6: [] }], os: { raw: 'Debian GNU/Linux 12 (bookworm)', version: '12' }, tags: { git: 'tag' },
  }, {
    name: 'cache01', id: '102', host: 'pve2', cluster: 'pve-cluster', kind: 'lxc', powerState: 'running', vcpu: 1, ramGib: 1, firmware: 'bios',
    disks: [{ name: 'rootfs', gib: 8 }], nics: [{ mac: 'BC:24:11:AA:BB:CD', ipv4: ['10.4.0.6'], ipv6: [] }], os: { raw: 'debian' },
  }]),
  'collect-ovirt.sh': envelope('ovirt', 'engine.corp.example', [{
    name: 'app-olvm01', id: '8f2d0c3e-2c1d-4b3a-9e8f-7a6b5c4d3e2f', host: 'olvm-host1', cluster: 'Default', kind: 'vm', powerState: 'up', vcpu: 4, ramGib: 16, firmware: 'efi',
    disks: [{ gib: 60, usedGib: 22.4 }], nics: [{ mac: '56:6f:1a:2b:3c:4d', ipv4: ['10.5.0.9'], ipv6: [] }], os: { raw: 'Oracle Linux Server 8.9' },
  }]),
  'collect-xen.sh': envelope('xen', 'pool-a', [{
    name: 'ctx-vda01', id: 'b5f0e7c2-4d3a-4a1b-9c8d-7e6f5a4b3c2d', cluster: 'pool-a', host: 'xs01', kind: 'vm', powerState: 'running', vcpu: 4, ramGib: 16, firmware: 'bios',
    disks: [{ gib: 100, usedGib: 55 }], nics: [{ mac: 'aa:bb:cc:00:11:22', ipv4: ['10.6.0.40'], ipv6: [] }], os: { raw: 'Microsoft Windows Server 2019 Standard' },
  }]),
  'collect-windows.ps1': JSON.stringify({
    kind: 'archtoolkit.discovery', v: 1, source: { platform: 'physical' }, collectedAt: '2026-09-20',
    servers: [{
      name: 'SAPHANA01', kind: 'physical', powerState: 'poweredOn', vcpu: 32, ramGib: 512, firmware: 'efi',
      disks: [{ name: 'C:', gib: 200, usedGib: 80.5 }, { name: 'D:', gib: 2048, usedGib: 900 }],
      nics: [{ mac: '00-50-56-AA-BB-CC', ipv4: ['10.7.0.10'], ipv6: [] }], os: { raw: 'Microsoft Windows Server 2019 Datacenter', version: '10.0.17763' },
      software: ['SAP HANA Database 2.0', 'Microsoft Visual C++ 2019 X64 Minimum Runtime'], services: ['hdbindexserver', 'W32Time'],
      listening: [{ port: 30015, proto: 'tcp', process: 'hdbindexserver' }, { port: 3389, proto: 'tcp', process: 'svchost' }],
      connections: [{ remote: '10.7.0.20', port: 1433, proto: 'tcp', count: 12, process: 'hdbxsengine' }],
      shares: 1, printers: 0, sessions: 0,
      utilisation: { days: 14, samples: 20160, coverage: 0.97, cpuP50Pct: 12, cpuP95Pct: 31, cpuP99Pct: 55, cpuMaxPct: 88, memP95Gib: 300, memMaxGib: 420, iopsP95: 740, iopsMax: 2100, mbpsP95: 38 },
    }],
  }),
  'collect-linux.sh': JSON.stringify({
    kind: 'archtoolkit.discovery', v: 1, source: { platform: 'physical' }, collectedAt: '2026-09-20',
    servers: [{
      name: 'web-lx01', kind: 'physical', powerState: 'poweredOn', vcpu: 16, ramGib: 64, firmware: 'bios',
      disks: [{ name: 'sda', gib: 480, usedGib: 120.4 }], nics: [{ name: 'eno1', mac: '3c:ec:ef:00:11:22', ipv4: ['10.8.0.5'], ipv6: ['2001:db8:8::5'] }],
      os: { raw: 'Red Hat Enterprise Linux 8.10 (Ootpa)', version: '8.10' },
      software: ['nginx 1.20.1', 'openssl 3.0.7'], services: ['nginx', 'sshd', 'chronyd'],
      listening: [{ port: 443, proto: 'tcp', process: 'nginx' }, { port: 22, proto: 'tcp', process: 'sshd' }],
      connections: [{ remote: '10.8.0.30', port: 8080, proto: 'tcp', count: 144, process: 'nginx' }],
      shares: 0, printers: 0, sessions: 1,
      utilisation: { days: 14, samples: 20000, coverage: 0.99, cpuP50Pct: 8, cpuP95Pct: 20, cpuP99Pct: 35, cpuMaxPct: 70, memP95Gib: 10, memMaxGib: 14, iopsP95: 150, iopsMax: 600, mbpsP95: 5 },
    }],
  }),
  'collect-aws.sh': envelope('aws', '123456789012', [{
    name: 'crm-api01', id: 'i-0abc1234def567890', region: 'eu-west-1', cluster: 'eu-west-1a', kind: 'instance', powerState: 'running', size: 'm5.xlarge', vcpu: 4, firmware: 'bios',
    disks: [{ name: '/dev/xvda', gib: 50 }, { name: '/dev/sdf', gib: 200 }], nics: [{ mac: '0a:1b:2c:3d:4e:5f', ipv4: ['172.31.10.20'], ipv6: [] }],
    os: { raw: 'Canonical, Ubuntu, 22.04 LTS, amd64 jammy image' }, tags: { Name: 'crm-api01', app: 'CRM' },
  }]),
  'collect-azure.sh': envelope('azure', '00000000-1111-2222-3333-444444444444', [{
    name: 'hr-sql01', id: '/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/rg-hr/providers/Microsoft.Compute/virtualMachines/hr-sql01',
    region: 'westeurope', cluster: 'rg-hr', kind: 'instance', powerState: 'VM running', size: 'Standard_E8s_v5', firmware: 'efi',
    disks: [{ gib: 128 }, { gib: 1024 }], nics: [{ mac: '00-0D-3A-00-00-01', ipv4: ['10.20.1.4'], ipv6: [] }], os: { raw: 'sql2019-ws2019 enterprise Windows' }, tags: { application: 'HR' },
  }]),
  'collect-gcp.sh': envelope('google', 'acme-prod', [{
    name: 'bi-worker-1', id: '1234567890123456789', region: 'europe-west2', cluster: 'europe-west2-a', kind: 'instance', powerState: 'RUNNING', size: 'n2-standard-8', firmware: 'efi',
    disks: [{ gib: 100 }], nics: [{ ipv4: ['10.30.0.7'], ipv6: [] }], os: { raw: 'rhel-9-server' }, tags: { app: 'bi' },
  }, {
    name: 'bi-custom-1', id: '1234567890123456790', region: 'europe-west2', cluster: 'europe-west2-a', kind: 'instance', powerState: 'TERMINATED', size: 'n2-custom-6-24576', firmware: 'bios',
    disks: [{ gib: 50 }], nics: [{ ipv4: ['10.30.0.8'], ipv6: [] }], os: { raw: 'debian-12-bookworm' }, tags: { app: 'bi' },
  }]),
  'collect-oci.sh': envelope('oci', 'ocid1.compartment.oc1..aaaa', [{
    name: 'fin-app01', id: 'ocid1.instance.oc1.uk-london-1.abcd', region: 'uk-london-1', cluster: 'Uocm:LHR-AD-1', kind: 'instance', powerState: 'RUNNING',
    size: 'VM.Standard.E5.Flex', vcpu: 4, ramGib: 32, firmware: 'efi', disks: [{ gib: 100 }, { gib: 500 }],
    nics: [{ mac: '02:00:17:00:00:01', ipv4: ['10.40.0.3'], ipv6: ['2603:c020::3'] }], os: { raw: 'Oracle Linux 9' }, tags: { 'Finance.CostCentre': 'F100' },
  }]),
  'collect-k8s.sh': JSON.stringify({ kind: 'archtoolkit.discovery', v: 1, source: { platform: 'vsphere' }, collectedAt: '2026-09-20', servers: [{
    name: 'k8s-worker-1', kind: 'vm', powerState: 'poweredOn', vcpu: 8, ramGib: 31.4,
    nics: [{ ipv4: ['10.50.0.11'], ipv6: [] }], os: { raw: 'Ubuntu 22.04.4 LTS' },
    software: ['kubelet v1.30.2', 'containerd://1.7.13'], services: ['kubelet'], listening: [{ port: 10250, proto: 'tcp', process: 'kubelet' }],
    tags: { 'node-role.kubernetes.io/worker': '' },
  }] }),
};

describe('collectors: text and bundle', () => {
  it('has one sample per discovery collector', () => {
    for (const c of COLLECTORS) expect(Object.keys(SAMPLES)).toContain(c.file);
  });
  it('renders every collector with no footprint and no credential literal', () => {
    for (const c of COLLECTORS) {
      const { content } = renderCollector(c.id);
      expect(content.includes('@@common@@')).toBe(false);
      expect(/Generated by|C:\\Users\\|\/home\/[a-z]/i.test(content)).toBe(false);
      expect(/password\s*=\s*['"][^'"$]/i.test(content)).toBe(false);
      if (c.language === 'bash' && c.id !== 'linux') expect(content).toContain('secret()');
    }
    expect(COLLECTOR_COMMON_SH).toContain('ATK_VAULT_CMD');
  });
  it('every bash collector passes bash -n', { skip: !hasBash }, () => {
    for (const c of COLLECTORS.filter((x) => x.language === 'bash')) {
      const r = spawnSync('bash', ['-n'], { input: renderCollector(c.id).content, encoding: 'utf8' });
      expect(`${c.file}: ${r.stderr}`).toBe(`${c.file}: `);
    }
  });
  it('every PowerShell collector parses', { skip: !hasPwsh }, () => {
    for (const c of COLLECTORS.filter((x) => x.language === 'powershell')) expect([c.file, ...psErrors(renderCollector(c.id).content)]).toEqual([c.file]);
  });
  it('the bundle is reproducible and carries discover.yml and a README', async () => {
    const files = collectorFiles();
    expect(Object.keys(files)).toContain('discover.yml');
    expect(files['README.md']).toContain('ATK_VAULT_CMD');
    expect(files['discover.yml']).toContain('ansible.builtin.script');
    const a = await collectorBundle();
    const b = await collectorBundle();
    expect(a.length === b.length && a.every((v, i) => v === b[i])).toBe(true);
  });
});

describe('discovery.ts: every collector sample parses', () => {
  for (const [file, text] of Object.entries(SAMPLES)) {
    it(file, () => {
      const p = parseDiscovery(text);
      expect(p.findings.filter((f) => f.severity === 'error')).toEqual([]);
      expect(p.servers.length).toBeGreaterThan(0);
      for (const s of p.servers) {
        expect(s.vcpu).toBeGreaterThan(0);
        expect(s.memoryGib).toBeGreaterThan(0);
        // Prism Central's VM list does not report the guest OS (it needs the guest tools): unknown, with a finding.
        if (file !== 'collect-ahv.sh') expect(s.os === 'unknown').toBe(false);
        expect(s.sourceRef?.platform).toBe(s.origin);
      }
    });
  }
  it('maps the fields: sizes, used GiB, IPs of both families, firmware, sourceRef', () => {
    const [s] = parseDiscovery(SAMPLES['collect-hyperv.ps1']!).servers;
    expect(s!.disksGib).toEqual([127, 200]);
    expect(s!.facts?.disksUsedGib).toEqual([61.2, 20]);
    expect(s!.facts?.ipAddresses).toEqual(['10.1.2.3', '2001:db8::3']);
    expect(s!.facts?.firmware).toBe('efi');
    expect(s!.facts?.powerState).toBe('poweredOn');
    expect(s!.os).toBe('win-2019');
    expect(s!.sourceRef).toEqual({ platform: 'hyperv', manager: 'hv-cluster-01', id: '5c1b7f0e-8a4e-4c43-9a55-0f7a3c1d2e11', host: 'hv03', cluster: 'hv-cluster-01' });
  });
  it('fills cloud sizes from the catalogue, and Google custom types from their name', () => {
    const aws = parseDiscovery(SAMPLES['collect-aws.sh']!).servers[0]!;
    expect([aws.vcpu, aws.memoryGib]).toEqual([4, 16]);
    const azure = parseDiscovery(SAMPLES['collect-azure.sh']!).servers[0]!;
    expect([azure.vcpu, azure.memoryGib]).toEqual([8, 64]);
    const [n2, custom] = parseDiscovery(SAMPLES['collect-gcp.sh']!).servers;
    expect([n2!.vcpu, n2!.memoryGib]).toEqual([8, 32]);
    expect([custom!.vcpu, custom!.memoryGib]).toEqual([6, 24]);
    expect(custom!.facts?.powerState).toBe('poweredOff');
  });
  it('an unknown cloud size is a finding, not a guess', () => {
    const p = parseDiscovery(envelope('aws', 'a', [{ name: 'x', size: 'zz9.huge', disks: [], nics: [] }]));
    expect(p.findings.map((f) => f.code)).toContain('plan.sources.discovery.unknown-size');
    expect(p.servers[0]!.vcpu).toBe(0);
  });
  it('flags LXC containers as containers-pattern candidates', () => {
    const p = parseDiscovery(SAMPLES['collect-proxmox.sh']!);
    expect(p.findings.map((f) => f.code)).toContain('plan.sources.lxc');
  });
  it('rejects the wrong kind, bad JSON and an unknown platform with errors', () => {
    expect(parseDiscovery('{').findings[0]!.code).toBe('plan.sources.discovery.json');
    expect(parseDiscovery('{"kind":"x"}').findings[0]!.code).toBe('plan.sources.discovery.kind');
    expect(parseDiscovery(envelope('vax', 'm', [])).findings.map((f) => f.code)).toContain('plan.sources.discovery.platform');
  });
  it('rows: origin, sourceRef, basis, detection; the physical server is sized from utilisation', () => {
    const r = intakeFromDiscovery([SAMPLES['collect-linux.sh']!, SAMPLES['collect-hyperv.ps1']!], { on: ON });
    const web = r.workloads.find((w) => w.name === 'web-lx01')!;
    expect(web.origin).toBe('physical');
    expect(web.basis).toBe('utilisation');
    expect(web.facts?.nameplate).toEqual({ cores: 16, ramGib: 64, disksGib: [480] });
    expect(web.vcpu).toBe(Math.max(2, Math.ceil(16 * 0.2 * COMFORT_FACTOR)));
    expect(web.ramGib).toBe(Math.ceil(10 * COMFORT_FACTOR));
    const crm = r.workloads.find((w) => w.name === 'crm-app01')!;
    expect(crm.origin).toBe('hyperv');
    expect(crm.basis).toBe('allocated');
    expect(crm.vcpu).toBe(4);
    expect(crm.sourceRef?.host).toBe('hv03');
  });
  it('the SAP HANA host is detected, sized from p99 and keeps its memory nameplate', () => {
    const r = intakeFromDiscovery([SAMPLES['collect-windows.ps1']!], { on: ON });
    const hana = r.workloads[0]!;
    expect(hana.workloadType).toBe('sap-hana');
    expect(hana.typeConfirmed).toBe(false);
    expect(hana.facts?.detection?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(hana.vcpu).toBe(Math.ceil(32 * 0.55 * COMFORT_FACTOR));
    // Peak memory × 1.3 (546) is above the nameplate; the nameplate is only a floor.
    expect(hana.ramGib).toBe(Math.max(512, Math.ceil(420 * COMFORT_FACTOR)));
    expect(r.findings.map((f) => f.code)).toContain('size.peak-basis');
  });
  it('groups servers into apps by tag, and flags the unassigned', () => {
    const r = intakeFromDiscovery([SAMPLES['collect-aws.sh']!, SAMPLES['collect-libvirt.sh']!], { on: ON });
    expect(r.workloads.find((w) => w.name === 'crm-api01')!.app).toBe('CRM');
    expect(r.workloads.find((w) => w.name === 'build01')!.app).toBe(UNASSIGNED_APP);
    expect(r.findings.map((f) => f.code)).toContain('plan.sources.unassigned');
  });
  it('infers a database from the services it runs', () => {
    const text = envelope('physical', '', [{ name: 'lx-db7', vcpu: 8, ramGib: 32, disks: [{ gib: 200 }], nics: [], os: { raw: 'Ubuntu 22.04.4 LTS' }, services: ['postgresql@15-main'], listening: [{ port: 5432, proto: 'tcp', process: 'postgres' }] }]);
    const r = intakeFromDiscovery([text], { on: ON });
    expect(r.databases.map((d) => d.engine)).toEqual(['postgres']);
    expect(r.workloads[0]!.role).toBe('db');
  });
  it('writes flows.csv lines from the connections', () => {
    const csv = discoveryFlowsCsv([parseDiscovery(SAMPLES['collect-linux.sh']!)]);
    expect(csv.split('\n')[1]).toBe('10.8.0.5,10.8.0.30,8080,tcp,144,2026-09-20,2026-09-20,');
  });
  it('is registered as an intake adapter, with the provider formats', () => {
    expect(INTAKE_ADAPTERS.map((a) => a.id).slice(3)).toEqual(SOURCE_INTAKE_ADAPTERS.map((a) => a.id));
    expect(SOURCE_INTAKE_ADAPTERS.map((a) => a.id)).toEqual(['discovery', 'azure-migrate-csv', 'migration-center-csv', 'aws-import-csv', 'ahv-csv', 'mgn-import-csv', 'cmf-intake-csv']);
    expect(intakeAdapter('discovery')).toBe(DISCOVERY_ADAPTER as never);
  });
});

describe('collectors run against mocks', () => {
  it('collect-hyperv.ps1 output parses through discovery.ts', { skip: !hasPwsh }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'atk-hv-'));
    try {
      writeFileSync(join(dir, 'collect-hyperv.ps1'), renderCollector('hyperv').content);
      const mocks = `
        function global:Get-VM { param($ComputerName) @([pscustomobject]@{ Name = 'crm-app01'; VMId = [guid]'5c1b7f0e-8a4e-4c43-9a55-0f7a3c1d2e11'; State = 'Running'; ProcessorCount = 4; MemoryStartup = 8GB; MemoryAssigned = 12GB; DynamicMemoryEnabled = $true; Generation = 2; Version = '10.0'; Notes = 'CRM tier' }) }
        function global:Get-VMHardDiskDrive { param($VM) @([pscustomobject]@{ Path = 'D:\\VMs\\crm-app01.vhdx' }) }
        function global:Get-VHD { param($ComputerName, $Path) [pscustomobject]@{ Size = 127GB; FileSize = 61GB } }
        function global:Get-VMNetworkAdapter { param($VM) @([pscustomobject]@{ MacAddress = '00155D010203'; SwitchName = 'vSwitch'; IPAddresses = @('10.1.2.3', 'fe80::1', '2001:db8::3') }) }
        function global:Get-CimInstance { throw 'no CIM in the test' }
        & '${join(dir, 'collect-hyperv.ps1')}' -ComputerName hv03 -OutFile '${join(dir, 'out.json')}'`;
      const r = spawnSync('pwsh', ['-NoProfile', '-Command', mocks], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      const p = parseDiscovery(readFileSync(join(dir, 'out.json'), 'utf8'));
      expect(p.findings.filter((f) => f.severity !== 'info')).toEqual([]);
      const s = p.servers[0]!;
      expect([s.name, s.vcpu, s.memoryGib, s.disksGib[0], s.facts?.firmware]).toEqual(['crm-app01', 4, 12, 127, 'efi']);
      expect(s.facts?.ipAddresses).toEqual(['10.1.2.3', '2001:db8::3']);
      expect(s.sourceRef?.host).toBe('hv03');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('collect-libvirt.sh output parses through discovery.ts', { skip: !hasJq }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'atk-kvm-'));
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'virsh'), `#!/usr/bin/env bash
case "$1" in
  hostname) echo kvm01.corp.example ;;
  list) echo build01; echo ;;
  dominfo) printf 'Id:             3\\nName:           build01\\nUUID:           6d1e0c2a-5b7f-4f9e-a1c3-0e2d4f6a8b01\\nState:          running\\nCPU(s):         4\\nMax memory:     8388608 KiB\\n' ;;
  dumpxml) echo "<domain><os firmware='efi'/><description>CI builder</description></domain>" ;;
  domblklist) printf ' Type   Device   Target   Source\\n------------------------------------\\n file   disk     vda      /var/lib/libvirt/images/build01.qcow2\\n file   cdrom    sda      -\\n' ;;
  domblkinfo) printf 'Capacity:       42949672960\\nAllocation:     13207024640\\nPhysical:       13207024640\\n' ;;
  domiflist) printf ' Interface   Type      Source    Model    MAC\\n-------------------------------------------------------\\n vnet0       network   default   virtio   52:54:00:12:34:56\\n' ;;
  domifaddr) printf ' Name       MAC address          Protocol     Address\\n-------------------------------------------------------------------------------\\n eth0       52:54:00:12:34:56    ipv4         192.168.122.15/24\\n -          -                    ipv6         2001:db8:122::15/64\\n' ;;
  guestinfo) printf 'os.pretty-name      : Rocky Linux 9.4 (Blue Onyx)\\nos.version-id       : 9.4\\n' ;;
esac
`);
      chmodSync(join(dir, 'bin', 'virsh'), 0o755);
      writeFileSync(join(dir, 'collect-libvirt.sh'), renderCollector('libvirt').content);
      const r = spawnSync('bash', [join(dir, 'collect-libvirt.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } });
      expect(r.status).toBe(0);
      const s = parseDiscovery(r.stdout).servers[0]!;
      expect([s.name, s.vcpu, s.memoryGib, s.disksGib, s.facts?.firmware, s.os]).toEqual(['build01', 4, 8, [40], 'efi', 'rocky-9']);
      expect(s.facts?.ipAddresses).toEqual(['192.168.122.15', '2001:db8:122::15']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Provider import formats
// ---------------------------------------------------------------------------

const AZURE_MIGRATE_CSV = [
  'Server name,IP address,Cores,Memory (In MB),OS name,OS version,OS architecture,Server type,Hypervisor,Number of disks,Storage in use (In GB),Disk 1 size (In GB),Disk 1 read ops (operations per second),Disk 1 write ops (operations per second),Disk 1 read throughput (MB per second),Disk 1 write throughput (MB per second),Disk 2 size (In GB),Disk 2 read ops (operations per second),Disk 2 write ops (operations per second),CPU utilization percentage,Memory utilization percentage,Network In throughput,Network Out throughput,Boot Type,Network adapters',
  'fin-db01,10.9.0.10,8,65536,Microsoft Windows Server 2019 Datacenter,10.0.17763,x64,Physical,,2,700,500,120,80,10,5,500,40,30,35,62,2,3,UEFI,2',
  'fin-app01,10.9.0.11;10.9.0.12,4,16384,Red Hat Enterprise Linux 8.9,8.9,x64,Virtual,VMware,1,40,100,20,10,1,1,,,,18,45,1,1,BIOS,1',
  ',10.9.0.99,2,4096,Windows,,,,,,,,,,,,,,,,,,,,',
].join('\n');

describe('Azure Migrate CSV', () => {
  it('imports nameplate and utilisation', () => {
    const p = parseAzureMigrateCsv(AZURE_MIGRATE_CSV, { utilDays: 30 });
    expect(p.servers.map((s) => s.name)).toEqual(['fin-db01', 'fin-app01']);
    const db = p.servers[0]!;
    expect([db.vcpu, db.memoryGib, db.disksGib, db.os, db.origin]).toEqual([8, 64, [500, 500], 'win-2019', 'physical']);
    expect(db.facts?.firmware).toBe('efi');
    expect(db.facts?.utilisation).toEqual({ days: 30, samples: 1, coverage: 1, cpuP95Pct: 35, memP95Gib: 39.7, iopsP95: 270, mbpsP95: 15, netMbpsP95: 40 });
    const app = p.servers[1]!;
    expect([app.origin, app.os, app.facts?.ipAddresses]).toEqual(['vsphere', 'rhel-8', ['10.9.0.11', '10.9.0.12']]);
    expect(p.findings.map((f) => f.code)).toContain('plan.sources.azure-migrate.row');
  });
  it('is read by header: the same file with its columns reversed gives the same servers', () => {
    const rows = AZURE_MIGRATE_CSV.split('\n').map((l) => l.split(',').reverse().join(','));
    const a = parseAzureMigrateCsv(AZURE_MIGRATE_CSV, { utilDays: 30 }).servers;
    const b = parseAzureMigrateCsv(rows.join('\n'), { utilDays: 30 }).servers;
    expect(b).toEqual(a);
  });
  it('a missing mandatory column is an error naming it', () => {
    const p = parseAzureMigrateCsv('Server name,Cores,OS name\nx,2,Windows');
    expect(p.findings.map((f) => f.message).join(' ')).toContain('Memory (In MB)');
    expect(p.servers).toEqual([]);
  });
  it('rows: the physical server is sized from utilisation once the window is known; without a window it stays at nameplate', () => {
    const sized = intakeFromAzureMigrate([AZURE_MIGRATE_CSV], { utilDays: 30, on: ON });
    const db = sized.workloads.find((w) => w.name === 'fin-db01')!;
    expect(db.basis).toBe('utilisation');
    expect(db.ramGib).toBe(64); // a database host keeps its memory nameplate
    const unsized = intakeFromAzureMigrate([AZURE_MIGRATE_CSV], { on: ON });
    const db2 = unsized.workloads.find((w) => w.name === 'fin-db01')!;
    expect([db2.basis, db2.vcpu]).toEqual(['allocated', 8]);
    expect(db2.facts?.utilisation?.cpuP95Pct).toBe(35);
    expect(unsized.findings.map((f) => f.code)).toContain('size.low-coverage');
  });
});

const MC_VM = [
  'MachineId,MachineName,PrimaryIPAddress,PrimaryMACAddress,PublicIPAddress,IpAddressListSemiColonDelimited,TotalDiskAllocatedGiB,TotalDiskUsedGiB,MachineTypeLabel,AllocatedProcessorCoreCount,MemoryGiB,HostingLocation,OsType,OsName,OsVersion,MachineStatus,ProvisioningState,CreateDate,IsPhysical,Source',
  'vm-001,shop-web01,10.60.0.4,00:50:56:01:02:03,,10.60.0.4;fd00::4,120,48,,4,16,dc-london,Linux,Ubuntu,22.04,Running,Provisioned,2021-03-04,false,VMware vCenter',
  'vm-002,shop-db01,10.60.0.5,00:50:56:01:02:04,,,,,,8,64,dc-london,Windows,Microsoft Windows Server 2022 Standard,10.0.20348,Running,Provisioned,2020-01-01,true,Manual',
].join('\n');
const MC_DISK = ['MachineId,DiskLabel,SizeInGib,UsedInGib,StorageTypeLabel', 'vm-002,C:,200,90,SSD', 'vm-002,E:,1000,400,SSD'].join('\n');
const MC_TAG = ['MachineId,Key,Value', 'vm-001,app,shop', 'vm-002,app,shop', 'vm-002,env,prod'].join('\n');
function mcPerf(): string {
  const lines = ['MachineId,TimeStamp,CpuUtilizationPercentage,MemoryUtilizationPercentage,UtilizedMemoryBytes,DiskReadOperationsPerSec,DiskWriteOperationsPerSec,NetworkBytesPerSecSent,NetworkBytesPerSecReceived'];
  const start = Date.parse('2026-09-06T00:00:00Z');
  for (let i = 0; i < 14 * 24; i++) { // hourly for 14 days
    const t = new Date(start + i * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const cpu = 10 + (i % 24 === 14 ? 50 : i % 10); // a daily peak
    lines.push(`vm-002,${t},${cpu},50,${(20 + (i % 5)) * 2 ** 30},${100 + i % 50},${50},${1_000_000},${2_000_000}`);
  }
  return lines.join('\n');
}

describe('Google Migration Center tables', () => {
  it('imports nameplate, disks, tags and utilisation percentiles', () => {
    const p = parseMigrationCenter({ vmInfo: MC_VM, diskInfo: MC_DISK, tagInfo: MC_TAG, perfInfo: mcPerf() });
    expect(p.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    const [web, db] = p.servers;
    expect([web!.vcpu, web!.memoryGib, web!.disksGib, web!.origin, web!.facts?.ipAddresses]).toEqual([4, 16, [120], 'vsphere', ['10.60.0.4', 'fd00::4']]);
    expect([db!.disksGib, db!.facts?.disksUsedGib, db!.origin, db!.os]).toEqual([[200, 1000], [90, 400], 'physical', 'win-2022']);
    expect(db!.tags).toEqual({ app: 'shop', env: 'prod' });
    const u = db!.facts!.utilisation!;
    expect([u.samples, u.coverage, u.days]).toEqual([336, 1, 14]);
    // 14 daily peaks of 60% in 336 hourly samples sit above the 95th percentile (19%) but inside the 99th.
    expect(u.cpuMaxPct).toBe(60);
    expect(u.cpuP95Pct).toBe(19);
    expect(u.cpuP99Pct).toBe(60);
    expect(u.memP95Gib).toBe(24);
    expect(u.netMbpsP95).toBe(24);
  });
  it('rows: the physical server is sized from its percentiles', () => {
    const r = intakeFromMigrationCenter({ vmInfo: MC_VM, diskInfo: MC_DISK, tagInfo: MC_TAG, perfInfo: mcPerf() }, { on: ON });
    const db = r.workloads.find((w) => w.name === 'shop-db01')!;
    expect(db.app).toBe('shop');
    expect(db.basis).toBe('utilisation');
    // A database host by role sizes from p99 (A.3.6).
    expect(db.role).toBe('db');
    expect(db.vcpu).toBe(Math.ceil(8 * 0.6 * COMFORT_FACTOR));
  });
  it('tags without MachineId cannot be tied to machines (a finding)', () => {
    const p = parseMigrationCenter({ vmInfo: MC_VM, tagInfo: 'Key,Value\napp,shop' });
    expect(p.findings.map((f) => f.code)).toContain('plan.sources.migration-center.tag-machine');
  });
});

describe('AWS Migration Hub import template', () => {
  const CSV = [
    'ExternalId,SMBiosId,IPAddress,MACAddress,HostName,VMware.MoRefId,VMware.VCenterId,CPU.NumberOfProcessors,CPU.NumberOfCores,CPU.NumberOfLogicalCores,OS.Name,OS.Version,VMware.VMName,RAM.TotalSizeInMB,RAM.UsedSizeInMB.Avg,RAM.UsedSizeInMB.Max,CPU.UsagePct.Avg,CPU.UsagePct.Max,DiskReadsOpsPerSecond.Max,DiskWritesOpsPerSecond.Max,Applications,ApplicationWave,Tags,ServerId',
    'srv-1,,10.70.0.1,,pay-app01,vm-1001,vc01,2,8,16,Red Hat Enterprise Linux,9.2,pay-app01,32768,12000,20480,15,60,300,200,"Payments,Ledger",Wave 2,"owner:finance, tier:1",',
    'srv-2,,10.70.0.2,,,,,1,2,2,Windows Server 2016,,,8192,,,,,,,,,,',
  ].join('\n');
  it('maps by header: logical cores, memory, maxima, apps, waves, tags', () => {
    const p = parseAwsImportCsv(CSV);
    const [a, b] = p.servers;
    expect([a!.name, a!.vcpu, a!.memoryGib, a!.app, a!.origin, a!.os]).toEqual(['pay-app01', 16, 32, 'Payments', 'vsphere', 'rhel-9']);
    expect(a!.facts?.utilisation).toEqual({ days: 0, samples: 1, coverage: 0, cpuMaxPct: 60, memMaxGib: 20, iopsMax: 500 });
    expect(a!.tags).toEqual({ owner: 'finance', tier: '1' });
    expect(p.waves).toEqual({ 'pay-app01': 'Wave 2' });
    expect([b!.name, b!.os, b!.origin]).toEqual(['srv-2', 'win-2016', 'other']);
    expect(p.findings.map((f) => f.code)).toEqual(expect_codes(['plan.sources.aws-import.no-disks', 'plan.sources.aws-import.multi-app', 'plan.sources.aws-import.waves']));
  });
});
function expect_codes(c: string[]): string[] { return c; }

describe('Nutanix Prism Central export', () => {
  const CSV = [
    'VM Name,Host,IP Addresses,Cores,Memory Capacity,Storage,CPU Usage,Memory Usage,Controller Read IOPS,Controller Write IOPS,Controller IO Bandwidth,Power State,Cluster,Categories',
    'erp-app02,ahv-node-3,"10.3.0.30, 10.3.0.31",4,16 GiB,61.2 GiB / 127 GiB,12.5%,40%,20,30,4 MBps,On,prod-cl1,"App: ERP, Environment: Production"',
  ].join('\n');
  it('reads sizes with units, usage and categories', () => {
    const p = parseAhvCsv(CSV);
    const s = p.servers[0]!;
    expect([s.vcpu, s.memoryGib, s.disksGib, s.facts?.disksUsedGib, s.facts?.powerState]).toEqual([4, 16, [127], [61.2], 'poweredOn']);
    expect(s.facts?.utilisation).toEqual({ days: 0, samples: 1, coverage: 0, cpuP95Pct: 12.5, memP95Gib: 6.4, iopsP95: 50, mbpsP95: 4 });
    expect(s.tags).toEqual({ App: 'ERP', Environment: 'Production' });
    const r = intakeFromAhvCsv([CSV], { on: ON });
    expect(r.workloads[0]!.app).toBe('ERP');
    expect(r.workloads[0]!.origin).toBe('ahv');
  });
});

describe('performance CSV', () => {
  it('adds percentiles to matching rows by name or IP, and re-applies the basis', () => {
    const lines = ['host,timestamp,cpu %,mem_gib,iops'];
    for (let i = 0; i < 5 * 288; i++) lines.push(`10.8.0.5,${1_790_000_000 + i * 300},${i % 100 === 0 ? 90 : 20},${6 + (i % 3)},${100}`);
    const perf = parsePerfCsv(lines.join('\n'));
    const w = { ...intakeFromDiscovery([SAMPLES['collect-linux.sh']!], { on: ON }).workloads[0]!, facts: { ...intakeFromDiscovery([SAMPLES['collect-linux.sh']!], { on: ON }).workloads[0]!.facts, utilisation: undefined } } as Workload;
    const r = applyPerf([w], perf);
    const u = r.workloads[0]!.facts!.utilisation!;
    expect([u.days, u.samples, u.coverage, u.cpuP95Pct, u.memMaxGib]).toEqual([5, 1440, 1, 20, 8]);
    expect(r.workloads[0]!.basis).toBe('utilisation');
  });
});

describe('Azure Migrate dependency export', () => {
  const CSV = [
    'Timeslot,Source server name,Source application,Source process,Destination server name,Destination IP,Destination application,Destination process,Destination port',
    '2026-09-10 00:00,shop-web01,nginx,nginx,shop-db01,10.60.0.5,sqlservr,sqlservr,1433',
    '2026-09-10 06:00,shop-web01,nginx,nginx,shop-db01,10.60.0.5,sqlservr,sqlservr,1433',
    '2026-09-10 06:00,shop-web01,postfix,master,,52.1.2.3,,,25',
  ].join('\n');
  it('aggregates per connection and proposes edges by port class', () => {
    const p = parseAzureDependencyCsv(CSV);
    expect(p.dependencies.map((d) => [d.source, d.destination, d.port, d.slots])).toEqual([['shop-web01', 'shop-db01', 1433, 2], ['shop-web01', '52.1.2.3', 25, 1]]);
    const rows = intakeFromMigrationCenter({ vmInfo: MC_VM }, { on: ON }).workloads;
    const e = proposeEdges(p.dependencies, rows);
    expect(e.edges).toEqual([{ from: 'shop-web01', to: 'shop-db01', port: 1433, kind: 'sync', observations: 2, process: 'sqlservr' }]);
    expect(e.external.map((x) => x.destination)).toEqual(['52.1.2.3']);
  });
});

describe('tier 2: MGN import sheet and Cloud Migration Factory intake form', () => {
  it('MGN: servers, apps, waves and tags by header; sizes from the target type', () => {
    const csv = ['mgn:account-id,mgn:region,mgn:app:name,mgn:wave:name,mgn:server:user-provided-id,mgn:server:platform,mgn:server:fqdn-for-action-framework,mgn:server:tag:owner,mgn:launch:instance-type',
      '123456789012,eu-west-1,Payments,Wave 3,pay-app02,LINUX,pay-app02.corp.example,finance,m6i.large'].join('\n');
    const p = parseMgnImportCsv(csv, 'vsphere');
    expect([p.servers[0]!.name, p.servers[0]!.app, p.servers[0]!.vcpu, p.servers[0]!.memoryGib, p.servers[0]!.tags]).toEqual(['pay-app02', 'Payments', 2, 8, { owner: 'finance' }]);
    expect(p.waves).toEqual({ 'pay-app02': 'Wave 3' });
  });
  it('CMF: wave, app, environment and strategy', () => {
    const csv = ['wave_name,app_name,aws_accountid,aws_region,server_name,server_os_family,server_os_version,server_fqdn,server_tier,server_environment,r_type,subnet_IDs,securitygroup_IDs,subnet_IDs_test,securitygroup_IDs_test,instanceType,tenancy',
      'Wave1,Ledger,123456789012,eu-west-1,ledger-db01,windows,Microsoft Windows Server 2019 Datacenter,ledger-db01.corp.example,db,prod,Rehost,subnet-1,sg-1,subnet-2,sg-2,r6i.2xlarge,Shared'].join('\n');
    const p = parseCmfIntakeCsv(csv);
    expect([p.servers[0]!.os, p.servers[0]!.env, p.servers[0]!.vcpu, p.servers[0]!.memoryGib]).toEqual(['win-2019', 'prod', 8, 64]);
    expect(p.strategies).toEqual({ 'ledger-db01': 'rehost' });
  });
});

// ---------------------------------------------------------------------------
// Sizing basis (A.3.6)
// ---------------------------------------------------------------------------

const row = (over: Partial<Workload>): Workload => ({
  id: 'workload:x', name: 'x', app: 'a', env: 'prod', role: 'app', os: 'rhel-9', vcpu: 16, ramGib: 64, disksGib: [100], criticality: 'tier2',
  rpo: '4h', rto: '4h', licence: 'rhel-byos', dependsOn: [], source: 'estate', origin: 'physical', ...over,
});

describe('sizing basis', () => {
  const util = { days: 14, samples: 20160, coverage: 0.97, cpuP95Pct: 25, cpuP99Pct: 50, cpuMaxPct: 90, memP95Gib: 20, memMaxGib: 40 };
  it('utilisation: max(2, ceil(cores × p95 × 1.3)) and max(2, ceil(mem p95 × 1.3))', () => {
    const r = applySizingBasis(row({ facts: { utilisation: util } }));
    expect([r.workload.basis, r.workload.vcpu, r.workload.ramGib]).toEqual(['utilisation', Math.ceil(16 * 0.25 * 1.3), Math.ceil(20 * 1.3)]);
    expect(applySizingBasis(row({ vcpu: 2, facts: { utilisation: { ...util, cpuP95Pct: 1, memP95Gib: 0.5 } } })).workload.vcpu).toBe(2);
    expect(applySizingBasis(row({ facts: { utilisation: { ...util, memP95Gib: 0.5 } } })).workload.ramGib).toBe(2);
  });
  it('falls back to nameplate under 60% coverage or 3 days, with the coverage in the finding', () => {
    for (const u of [{ ...util, coverage: 0.5 }, { ...util, days: 2 }]) {
      const r = applySizingBasis(row({ facts: { utilisation: u } }));
      expect([r.workload.basis, r.workload.vcpu, r.workload.ramGib]).toEqual(['allocated', 16, 64]);
      expect(r.findings[0]!.code).toBe('size.low-coverage');
    }
    expect(applySizingBasis(row({ facts: { utilisation: { ...util, coverage: 0.5 } } })).findings[0]!.message).toContain('50% coverage');
  });
  it('uses p99 (or max) for SAP and database types, and keeps their memory nameplate', () => {
    const db = applySizingBasis(row({ workloadType: 'db-host', facts: { utilisation: util } }));
    expect([db.workload.vcpu, db.workload.ramGib]).toEqual([Math.ceil(16 * 0.5 * 1.3), 64]);
    expect(db.findings.map((f) => f.code)).toContain('size.peak-basis');
    const sap = applySizingBasis(row({ workloadType: 'sap-netweaver', facts: { utilisation: { ...util, cpuP99Pct: undefined } } }));
    expect([sap.workload.vcpu, sap.workload.ramGib]).toEqual([Math.ceil(16 * 0.9 * 1.3), Math.ceil(40 * 1.3)]);
  });
  it('VMs default to allocated; physical and metered cloud sources to utilisation; edited cells are kept', () => {
    expect(defaultBasis('vsphere', util)).toBe('allocated');
    expect(defaultBasis('physical', util)).toBe('utilisation');
    expect(defaultBasis('aws', util)).toBe('utilisation');
    expect(defaultBasis('physical', undefined)).toBe('allocated');
    const kept = row({ vcpu: 3, edited: ['vcpu'], facts: { utilisation: util } });
    expect(applySizingBasis(kept).workload).toBe(kept);
  });
  it('confidence bands follow Azure Migrate (0–20% = 1 … 81–100% = 5)', () => {
    expect([0.1, 0.3, 0.55, 0.8, 0.97].map(confidenceBand)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Grouping and the shared table reader
// ---------------------------------------------------------------------------

describe('grouping rules', () => {
  it('the first rule that yields a name wins, in the default order', () => {
    expect(groupApp({ name: 'crm-web01', attributes: { Application: 'CRM' }, tags: { app: 'X' } })).toEqual({ app: 'CRM', rule: 'attribute' });
    expect(groupApp({ name: 'crm-web01', tags: { app: 'X' } })).toEqual({ app: 'X', rule: 'attribute' });
    expect(groupApp({ name: 'crm-web01', folder: '/DC/vm/Finance/CRM' })).toEqual({ app: 'CRM', rule: 'folder-leaf' });
    expect(groupApp({ name: 'crm-web01' })).toEqual({ app: 'crm', tier: 'web', rule: 'name-regex' });
    expect(groupApp({ name: 'x1' })).toBeUndefined();
    expect(DEFAULT_GROUPING.map((r) => r.rule)).toEqual(['attribute', 'cloud-tag', 'folder-leaf', 'name-regex']);
  });
  it('re-group keeps edited apps and sends the rest to Unassigned with one finding', () => {
    const rows = [row({ id: 'workload:a', name: 'pay-app01', app: '' }), row({ id: 'workload:b', name: 'zz9', app: 'Kept', edited: ['app'] }), row({ id: 'workload:c', name: 'q', app: '' })];
    const r = regroup(rows, []);
    expect(r.workloads.map((w) => w.app)).toEqual(['pay', 'Kept', UNASSIGNED_APP]);
    expect(r.tiers).toEqual({ 'workload:a': 'app' });
    expect(r.findings.map((f) => f.code)).toEqual(['plan.sources.unassigned']);
  });
  it('tiers from the regex group, else the role; regexes need an app group', () => {
    expect([tierOf('app', 'db'), tierOf('messaging'), tierOf('ad-dc'), tierOf('appliance')]).toEqual(['data', 'integration', 'infra', 'edge']);
    expect([validNameRegex('^(?<app>[a-z]+)-'), validNameRegex('^([a-z]+)-'), validNameRegex('(')]).toEqual([true, false, false]);
  });
});

describe('table reader', () => {
  it('reads quoted fields, semicolon and tab files, and maps headers by alias', () => {
    const t = readTable('Name;Memory (MB)\r\n"a;b";"1,024"\r\n\r\nc;2048\n');
    expect(t.rows).toEqual([['a;b', '1,024'], ['c', '2048']]);
    const m = mapHeader(t.header, { name: ['Server name', 'Name'], mem: ['MEMORY_MB'] }, ['name'], 'x', 'file');
    expect(m.index).toEqual({ name: 0, mem: 1 });
    expect(readTable('a\tb\n1\t2').rows).toEqual([['1', '2']]);
  });
  it('reads numbers with separators and units, and capacities in GiB', () => {
    expect([num('1,024'), num('31%'), num('16 GB'), num('0,5'), num(''), num('n/a')]).toEqual([1024, 31, 16, 0.5, undefined, undefined]);
    expect([sizeGib('16 GiB'), sizeGib('1 TiB'), sizeGib('500 GB'), sizeGib('2048 MiB'), sizeGib('40')]).toEqual([16, 1024, 465.7, 2, 40]);
  });
  it('percentiles are nearest-rank; coverage counts the gaps', () => {
    expect([percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), percentile([5], 50), percentile([], 50)]).toEqual([10, 5, undefined]);
    const at = Array.from({ length: 100 }, (_, i) => i * 60_000).filter((t) => t < 30 * 60_000 || t >= 50 * 60_000);
    expect(utilisationFromSeries({ at, cpuPct: at.map(() => 10) })!.coverage).toBe(0.8);
  });
});
