/**
 * The sizing data reads Broadcom's Planning and Preparation Workbook through the
 * generated workbook-data.ts. These tests fail loudly when a new workbook
 * changes its layout, and pin the workbook model to the figures Broadcom
 * publishes elsewhere.
 */
import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { WORKBOOK } from './workbook-data.ts';
import {
  WORKBOOK_LOOKUPS,
  WORKBOOK_KNOWN_GAPS,
  FLEET_TECHDOCS_911,
  VCF_RELEASES,
  SOURCES,
  profilesForRelease,
  readAllWorkbookKeys,
  workbookValue,
  workbookPlaneTotal,
  vcfmsFootprint,
  fleetEntry,
  vcenterEntry,
} from './sizing-data.ts';
import { sizeDeployment } from './sizing.ts';

readAllWorkbookKeys();

describe('workbook layout', () => {
  it('has both releases, each with its TechDocs source', () => {
    expect(WORKBOOK.releases['9.1']?.source).toBe(SOURCES.workbook910);
    expect(WORKBOOK.releases['9.1.1']?.source).toBe(SOURCES.workbook911);
  });

  it('holds every key the sizing data reads, as a number, in the release that reads it', () => {
    const missing: string[] = [];
    for (const l of WORKBOOK_LOOKUPS.values()) {
      if (l.from !== 'workbook') continue;
      const v = WORKBOOK.releases[l.release]?.tables[l.table]?.[l.key];
      if (typeof v !== 'number') missing.push(`${l.release} › ${l.table} › ${l.key}`);
    }
    expect(missing).toEqual([]);
    expect(WORKBOOK_LOOKUPS.size > 300).toBe(true);
  });

  it('reads the shared appliance tables from both releases', () => {
    const shared: [string, string][] = [
      ['SDDC Manager', 'CPU'],
      ['SDDC Manager', 'Disk'],
      ['vCenter Appliance CPU', 'Small'],
      ['vCenter Disk', 'SmallLarge'],
      ['NSX-T Manager CPU', 'Medium'],
      ['NSX-T Edge RAM', 'NSX Edge Large'],
      ['VCF Automation Disk', 'Large'],
      ['VCF Operations Disk', 'Medium'],
      ['VCF Operations Proxy CPU', 'Small'],
      ['VCFMS Control Node CPU', 'Large'],
      ['Deployment Size Control Node', 'High Availability'],
      ['AVI Load Balancer CPU', 'X-Large'],
      ['SRM Disk', 'Standard'],
      ['Cross-Cloud Mobility - HCX Conn', 'Disk'],
      ['vRLI Disk', 'Small'],
    ];
    for (const release of ['9.1', '9.1.1'] as const) {
      for (const [table, key] of shared) expect(typeof WORKBOOK.releases[release]?.tables[table]?.[key]).toBe('number');
    }
  });

  it('falls back only for the listed generator gaps, and each gap agrees with the workbook once it parses', () => {
    for (const l of WORKBOOK_LOOKUPS.values()) {
      if (l.from === 'known-gap') expect(`${l.release}|${l.table}|${l.key}` in WORKBOOK_KNOWN_GAPS).toBe(true);
      if (l.from === 'workbook' && `${l.release}|${l.table}|${l.key}` in WORKBOOK_KNOWN_GAPS) {
        expect(l.value).toBe(WORKBOOK_KNOWN_GAPS[`${l.release}|${l.table}|${l.key}`]);
      }
    }
  });

  it('throws, naming the table and key, for anything else that is missing', () => {
    expect(() => workbookValue('9.1.1', 'No Such Table', 'Small')).toThrow(/No Such Table/);
    expect(() => workbookValue('9.1.0', 'VCF Automation CPU', 'Huge')).toThrow(/9\.1 Planning and Preparation Workbook/);
  });
});

describe('the workbook model against published figures', () => {
  it('reproduces every S1 (TechDocs, 9.1.1) first-instance total exactly', () => {
    for (const p of profilesForRelease('9.1.1')) {
      expect(workbookPlaneTotal('9.1.1', p, 'first')).toEqual(FLEET_TECHDOCS_911.first[p]);
    }
  });

  it('reproduces S1 additional-instance vCPU and RAM, with two 100 GB disk differences', () => {
    for (const p of profilesForRelease('9.1.1')) {
      const wb = workbookPlaneTotal('9.1.1', p, 'additional');
      const s1 = FLEET_TECHDOCS_911.additional[p];
      expect([wb.vcpu, wb.ramGib]).toEqual([s1.vcpu, s1.ramGib]);
      expect([0, 100]).toContain(wb.diskGib - s1.diskGib);
    }
  });

  it('counts VCFMS workers as the workbook does', () => {
    // 9.1.1: the workbook's own HA-Small result (3 × 10/16, 2800 GB).
    const haSmall = vcfmsFootprint('9.1.1', 'ha-small');
    expect(haSmall.workers).toBe(3);
    expect(haSmall.total.vcpu - haSmall.control.vcpu).toBe(30);
    expect(haSmall.total.ramGib - haSmall.control.ramGib).toBe(48);
    expect(vcfmsFootprint('9.1.1', 'simple').workers).toBe(2);
    expect(vcfmsFootprint('9.1.1', 'ha-large').workers).toBe(4);
    expect(vcfmsFootprint('9.1.1', 'simple', 'additional').workers).toBe(1);
    // 9.1: the workbook's HA-Medium result (3 × 24/48, 3300 GB).
    const m = vcfmsFootprint('9.1.0', 'ha-medium');
    expect(m.workers).toBe(3);
    expect(m.total.diskGib - m.control.diskGib).toBe(3300);
  });

  it('gives each release a fleet row for each of its profiles, all published from its workbook', () => {
    for (const release of VCF_RELEASES) {
      for (const p of profilesForRelease(release)) {
        for (const role of ['first', 'additional'] as const) {
          const e = fleetEntry(release, p, role);
          expect(e?.basis).toBe('published');
          expect(e?.sourceUrl).toBe(release === '9.1.0' ? SOURCES.workbook910 : SOURCES.workbook911);
        }
      }
    }
  });

  it('keeps the management vCenter on Large storage, as the workbook defaults it', () => {
    expect(vcenterEntry('9.1.1', 'small', 'large').diskGib).toBe(2084);
    expect(vcenterEntry('9.1.0', 'large', 'xlarge').diskGib).toBe(4543);
  });

  it('sizes a whole deployment from the workbook without a fallback outside the known gaps', () => {
    const r = sizeDeployment({
      path: 'greenfield',
      profile: 'ha-medium',
      instanceCount: 2,
      topology: 'standard',
      storage: 'vsan-esa',
      hostCount: 6,
      host: { cpuSockets: 2, coresPerCpu: 32, hyperthreading: true, ramGib: 1024, rawStorageGib: 30000 },
      addOns: { logManagement: { replicaSize: 'medium', replicas: 3 }, realTimeMetrics: true, operationsForNetworks: {}, avi: { size: 'large' } },
      workloadDomains: [{ hosts: 20, vms: 500, supervisor: { count: 1, size: 'small' } }],
    });
    expect(r.managementFootprint.vcpu).toBe(184);
    expect(r.verification).toBe('V-DOC');
  });
});
