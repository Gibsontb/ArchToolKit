import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../../../testing/expect.ts';
import { MOVE_PATH_VALUES, PLATFORM_VALUES, SOURCE_PLATFORM_VALUES, WORKLOAD_TYPE_VALUES } from '../options.ts';
import type { MovePath, Platform, SourcePlatform, Workload, WorkloadFacts } from '../types.ts';
import {
  SOURCE_TARGET_MATRIX, matrixCell, validPaths, isValidPath, type MatrixCell,
  SOURCE_ADAPTERS, SOURCE_VERBS, renderSourceAdapter, renderSourceAdapters, adapterCommand,
  PATH_ADAPTATION, SOURCE_GUEST_TOOLS, adaptationFor,
  detectType, applyDetection, DETECTORS, DETECTED_THRESHOLD, CONFIRM_THRESHOLD,
} from './index.ts';

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

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

// ---------------------------------------------------------------------------
// The source × target matrix (A.3.4)
// ---------------------------------------------------------------------------

describe('source × target matrix', () => {
  it('covers every SourcePlatform × Platform pair (type-level and at run time)', () => {
    // Type-level: this assignment does not compile if a source or a target is missing.
    const typed: Readonly<Record<SourcePlatform, Readonly<Record<Platform, MatrixCell>>>> = SOURCE_TARGET_MATRIX;
    for (const s of SOURCE_PLATFORM_VALUES) for (const t of PLATFORM_VALUES) {
      const c = typed[s][t];
      expect(c).toBeDefined();
      expect(MOVE_PATH_VALUES).toContain(c.default);
      for (const p of c.alternatives) expect(MOVE_PATH_VALUES).toContain(p);
      expect(c.sources.length).toBeGreaterThan(0);
      expect(['V-API', 'V-DOC', 'V-SPEC', 'C', 'I']).toContain(c.verification);
    }
    expect(Object.keys(SOURCE_TARGET_MATRIX).sort()).toEqual([...SOURCE_PLATFORM_VALUES].sort());
  });
  it('rebuild is always valid, and a path is never listed twice', () => {
    for (const s of SOURCE_PLATFORM_VALUES) for (const t of PLATFORM_VALUES) {
      const paths = validPaths(s, t);
      expect(paths).toContain('rebuild');
      expect(new Set(paths).size).toBe(paths.length);
    }
  });
  it('matches the design table', () => {
    const d = (s: SourcePlatform, t: Platform, onCloud = false): MovePath => matrixCell(s, t, onCloud).default;
    expect([d('vsphere', 'vmware'), d('vsphere', 'aws'), d('vsphere', 'azure'), d('vsphere', 'google'), d('vsphere', 'oci')]).toEqual(['hcx-bulk', 'aws-mgn', 'azure-migrate', 'gcp-m2vm', 'oci-ocm']);
    expect([d('hyperv', 'vmware'), d('hyperv', 'azure'), d('hyperv', 'google'), d('hyperv', 'oci')]).toEqual(['hcx-osam', 'azure-migrate-hyperv', 'gcp-image-import', 'rebuild']);
    expect([d('physical', 'vmware'), d('physical', 'aws'), d('physical', 'azure'), d('physical', 'google')]).toEqual(['vcf-converter', 'aws-mgn', 'azure-migrate-agent', 'rebuild']);
    expect([d('aws', 'aws'), d('aws', 'google'), d('aws', 'oci'), d('azure', 'google')]).toEqual(['rebuild', 'gcp-m2vm', 'oci-ocm', 'gcp-m2vm']);
    expect([d('power', 'aws'), d('mainframe', 'vmware'), d('sparc', 'oci')]).toEqual(['specialist', 'specialist', 'specialist']);
    expect(validPaths('vsphere', 'vmware', true)).toEqual(['hcx-bulk', 'hcx-rav', 'hcx-vmotion', 'hcx-cold', 'rebuild']);
    expect(isValidPath('vcf-import', 'vsphere', 'vmware')).toBe(true);
    expect(isValidPath('vcf-import', 'vsphere', 'vmware', true)).toBe(false);
    expect(isValidPath('aws-mgn', 'power', 'aws')).toBe(false);
    // Rows with no origin are vSphere.
    expect(validPaths(undefined, 'azure')[0]).toBe('azure-migrate');
  });
  it('marks the design\'s unconfirmed cells as inferred', () => {
    expect(SOURCE_TARGET_MATRIX.ahv.vmware.verification).toBe('I');
    expect(SOURCE_TARGET_MATRIX.ovirt.oci.verification).toBe('I');
    expect(SOURCE_TARGET_MATRIX.vsphere.aws.verification).toBe('V-DOC');
  });
});

// ---------------------------------------------------------------------------
// Guest adaptation (A.3.5)
// ---------------------------------------------------------------------------

describe('guest adaptation', () => {
  it('every path with data cites a source; VMware targets install VMware Tools', () => {
    for (const [path, a] of Object.entries(PATH_ADAPTATION)) {
      expect(`${path}:${a!.source !== ''}`).toBe(`${path}:true`);
    }
    for (const t of Object.values(SOURCE_GUEST_TOOLS)) expect(t!.source.length).toBeGreaterThan(0);
    const osam = adaptationFor('kvm', 'hcx-osam', 'linux');
    expect(osam.steps.map((s) => [s.action, s.packages])).toEqual([['install-target-tools', ['open-vm-tools']], ['remove-source-tools', ['qemu-guest-agent']]]);
  });
  it('MGN removes the source tools; Hyper-V daemons only on Linux; Windows Hyper-V has nothing to remove', () => {
    expect(adaptationFor('vsphere', 'aws-mgn', 'windows').steps.map((s) => s.packages)).toEqual([['VMware Tools']]);
    expect(adaptationFor('hyperv', 'aws-mgn', 'linux').steps[0]!.packages).toContain('hyperv-daemons');
    expect(adaptationFor('hyperv', 'aws-mgn', 'windows').steps).toEqual([]);
  });
  it('Azure keeps the Hyper-V daemons (it runs on Hyper-V); Google removes VMware Tools itself', () => {
    expect(adaptationFor('hyperv', 'azure-migrate-hyperv', 'linux').steps).toEqual([]);
    expect(adaptationFor('vsphere', 'gcp-m2vm', 'linux').steps).toEqual([]);
    expect(adaptationFor('xen', 'gcp-image-import', 'linux').steps[0]!.packages).toContain('xe-guest-utilities');
  });
  it('OCI needs virtio-win on Windows first; Azure Ubuntu to MGN needs a kernel switch', () => {
    const oci = adaptationFor('vsphere', 'oci-ocm', 'windows');
    expect(oci.steps[0]!.action).toBe('pre-install');
    expect(oci.findings.map((f) => f.code)).toContain('source.adaptation-unverified');
    const mgn = adaptationFor('azure', 'aws-mgn', 'linux', 'Ubuntu 22.04.4 LTS');
    expect(mgn.findings.map((f) => f.code)).toContain('source.mgn-azure-kernel');
  });
  it('moves within VMware keep the tools; rebuild changes nothing', () => {
    expect(adaptationFor('vsphere', 'hcx-bulk', 'linux').steps).toEqual([]);
    expect(adaptationFor('ahv', 'rebuild', 'windows').steps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Source adapters (A.3.3)
// ---------------------------------------------------------------------------

describe('source adapters', () => {
  it('one adapter per source platform, all verbs, the non-x86 ones as operator steps', () => {
    for (const p of SOURCE_PLATFORM_VALUES) {
      const { path, content } = renderSourceAdapter(p);
      expect(path.startsWith('source/')).toBe(true);
      expect(content.includes('@@adapter-common@@')).toBe(false);
      for (const v of SOURCE_VERBS) expect(content).toContain(v);
      expect(/dry-?run/i.test(content)).toBe(true);
      expect(/lib\/atk\.sh|lib\/Atk\.psm1/.test(content)).toBe(true);
    }
    for (const p of ['power', 'sparc', 'itanium', 'pa-risc', 'mainframe', 'other'] as const) expect(SOURCE_ADAPTERS[p].file).toBe('operator.sh');
    expect(Object.keys(renderSourceAdapters()).length).toBe(new Set(Object.values(SOURCE_ADAPTERS).map((a) => a.file)).size);
    const some = renderSourceAdapters([{ origin: 'kvm' }, {}, { origin: 'kvm' }] as Pick<Workload, 'origin'>[]);
    expect(Object.keys(some)).toEqual(['source/kvm.sh', 'source/vsphere.ps1']);
  });
  it('no credential literal and no footprint in any adapter', () => {
    for (const content of Object.values(renderSourceAdapters())) {
      expect(/Generated by|C:\\Users\\|\/home\/[a-z]/i.test(content)).toBe(false);
      expect(/(password|secret)\s*=\s*['"][A-Za-z0-9]/i.test(content)).toBe(false);
    }
  });
  it('every bash adapter passes bash -n', { skip: !hasBash }, () => {
    for (const [path, content] of Object.entries(renderSourceAdapters())) {
      if (!path.endsWith('.sh')) continue;
      const r = spawnSync('bash', ['-n'], { input: content, encoding: 'utf8' });
      expect(`${path}: ${r.stderr}`).toBe(`${path}: `);
    }
  });
  it('every PowerShell adapter parses', { skip: !hasPwsh }, () => {
    for (const [path, content] of Object.entries(renderSourceAdapters())) {
      if (path.endsWith('.ps1')) expect([path, ...psErrors(content)]).toEqual([path]);
    }
  });
  it('the orchestrator command lines', () => {
    expect(adapterCommand('kvm', 'stop', 'workload:build01', { dryRun: true })).toBe("source/kvm.sh stop --item 'workload:build01' --dry-run");
    expect(adapterCommand('vsphere', 'rename', 'app01', { newName: 'app01-old' })).toBe("pwsh -NoProfile -File source/vsphere.ps1 rename -Item 'app01' -NewName 'app01-old'");
    expect(adapterCommand('power', 'stop', 'aix01')).toBe("source/operator.sh stop --item 'aix01'");
  });

});

// ---------------------------------------------------------------------------
// Workload-type detection (A.3.7): one detector, patterns/detect.ts, re-exported
// here. The signals WP-15 brought to it are tested here; the fixture servers
// are in patterns.test.ts.
// ---------------------------------------------------------------------------

const w = (name: string, os: Workload['os'], facts: WorkloadFacts, over: Partial<Workload> = {}): Workload => ({
  id: `w:${name}`, name, app: 'a', env: 'prod', role: 'other', os, vcpu: 4, ramGib: 16, disksGib: [100], criticality: 'tier2', rpo: '4h', rto: '4h',
  licence: 'li', dependsOn: [], source: 'estate', facts, ...over,
});

describe('workload-type detection (the patterns detector, re-exported)', () => {
  it('is the same detector, with the design thresholds; every detector names a known type', () => {
    expect([DETECTED_THRESHOLD, CONFIRM_THRESHOLD]).toEqual([0.7, 0.4]);
    for (const d of DETECTORS) expect(WORKLOAD_TYPE_VALUES).toContain(d.type);
  });
  it('services that run everywhere count only with their condition: Spooler, LanmanServer, chronyd', () => {
    const win = w('srv1', 'win-2022', { services: ['Spooler', 'LanmanServer', 'W32Time'], listening: [{ port: 445, proto: 'tcp' }] });
    expect(detectType(win).outcome).toBe('generic');
    expect(detectType(win, { sharedPrinters: 3 }).candidates[0]!.type).toBe('print');
    expect(detectType(win, { shares: 40 }).type).toBe('file-server');
    const lx = w('app7', 'rhel-9', { services: ['chronyd', 'sshd'] });
    expect(detectType(lx).outcome).toBe('generic');
    expect(detectType(w('app7', 'rhel-9', { services: ['chronyd'], listening: [{ port: 123, proto: 'udp' }] })).type).toBe('ntp');
  });
  it('Windows-only types are not scored on Linux (an nginx web server is not IIS)', () => {
    const nginx = w('web-lx01', 'rhel-8', { services: ['nginx'], listening: [{ port: 443, proto: 'tcp', process: 'nginx' }] });
    expect(detectType(nginx).candidates.some((c) => c.type === 'iis-dotnet')).toBe(false);
    expect(detectType(w('web01', 'win-2022', { services: ['W3SVC'], listening: [{ port: 443, proto: 'tcp' }] })).type).toBe('iis-dotnet');
  });
  it('listening process names count as services', () => {
    const d = detectType(w('x9', 'sles-15', { listening: [{ port: 30015, proto: 'tcp', process: 'hdbindexserver' }] }));
    expect([d.type, d.confidence]).toEqual(['sap-hana', 0.9]);
  });
  it('Linux on Power and OpenVMS on Itanium are not forced to AIX / HP-UX', () => {
    expect(detectType(w('lnx-p1', 'rhel-9', { guestOsRaw: 'Red Hat Enterprise Linux 9.4 (ppc64le)' }, { origin: 'power' })).type).toBe('generic-linux');
    expect(detectType(w('vms1', 'other', { guestOsRaw: 'OpenVMS 8.4-2L3' }, { origin: 'itanium' })).type === 'hp-ux').toBe(false);
    expect(detectType(w('lpar1', 'other', {}, { origin: 'power' })).type).toBe('aix');
  });
  it('never changes a type the user set', () => {
    const set = w('hana01', 'sles-15', { software: ['SAP HANA Database'], services: ['hdbindexserver'] }, { workloadType: 'db-host', typeConfirmed: true });
    const r = applyDetection(set, detectType(set));
    expect([r.workload.workloadType, r.workload.facts?.detection?.type]).toEqual(['db-host', 'sap-hana']);
  });
});
