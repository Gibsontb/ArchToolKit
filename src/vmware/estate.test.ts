/**
 * The RVTools workbook, end to end: read it, import it, and everything built
 * from it — the VCF plan, the spec prefill, the move checks, the Terraform and
 * Ansible, and the wizard's answers.
 *
 * The workbook is synthetic (src/testing/estate-fixture.ts). A customer export
 * is never a fixture.
 */

import { describe, it, before } from 'node:test';
import { expect } from '../testing/expect.ts';
import { estateWorkbook, CAPTURED, VMS } from '../testing/estate-fixture.ts';
import { openXlsx, excelSerialToIso, columnIndex } from '../core/xlsx.ts';
import { importRvToolsWorkbook, detectSheet } from './rvtools.ts';
import { computeTotals, rollupByCluster, mergeInventories, type Inventory } from './inventory.ts';
import { assessMoves, assessVm } from './vm-readiness.ts';
import type { Finding } from '../core/findings.ts';
import { planEstate, sourceClusters, suggestManagementSource, hostProfiles } from '../vcf/estate-plan.ts';
import { sizeDeployment } from '../vcf/sizing.ts';
import { estateToPlan } from '../vcf/bridge.ts';
import { rightsize, LADDERS } from '../kit/rightsize.ts';
import {
  AWS_INSTANCE_TYPE_GROUPS,
  AZURE_VM_SIZE_GROUPS,
  GCP_MACHINE_TYPE_GROUPS,
  OCI_SHAPE_GROUPS,
} from '../kit/sizes-data.ts';
import { rehostFiles, vsphereLandingFiles, REHOST_EMITS, LANDING_EMITS } from '../terraform/estate.ts';
import { classifyType } from '../terraform/catalog.ts';
import { estateInventoryFiles, premigrationFiles, postmigrationFiles } from '../ansible/estate.ts';
import { answersFromEstate } from '../multicloud/estate-answers.ts';

let bytes: Uint8Array;
let inventory: Inventory;
let findings: readonly Finding[];

before(async () => {
  bytes = await estateWorkbook();
  const result = await importRvToolsWorkbook(bytes, { label: 'estate.xlsx' });
  inventory = result.inventory;
  findings = result.findings;
});

const vm = (name: string) => inventory.vms.find((v) => v.name === name);

describe('reading an .xlsx', () => {
  it('lists tabs in workbook order, whatever the sheet files are numbered', async () => {
    const wb = await openXlsx(bytes);
    expect(wb.sheets[0]).toBe('vInfo');
    expect(wb.sheets.includes('vMetaData')).toBe(true);
  });

  it('resolves shared and inline strings, entities, and dates', async () => {
    const wb = await openXlsx(bytes);
    const rows: string[][] = [];
    await wb.rows('vInfo', (cells) => {
      rows.push(cells);
    });
    const header = rows[0] ?? [];
    const first = rows[1] ?? [];
    expect(first[header.indexOf('Powerstate')]).toBe('poweredOn');
    expect(first[header.indexOf('Annotation')]).toBe('note & <app-01>');
    // A numeric cell without a date style stays a number.
    expect(first[header.indexOf('CPUs')]).toBe('4');
    const meta: string[][] = [];
    await wb.rows('vMetaData', (cells) => {
      meta.push(cells);
    });
    expect(meta[1]?.[2]).toBe(excelSerialToIso(CAPTURED));
    expect(meta[1]?.[2]?.startsWith('2026-02-10T02:11')).toBe(true);
  });

  it('stops early when asked', async () => {
    const wb = await openXlsx(bytes);
    let seen = 0;
    await wb.rows('vInfo', () => {
      seen += 1;
      return seen < 2 ? undefined : false;
    });
    expect(seen).toBe(2);
  });

  it('turns column letters into indexes', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA10')).toBe(26);
    expect(columnIndex('CW2')).toBe(100);
  });

  it('rejects something that is not a zip', async () => {
    let threw = false;
    try {
      await openXlsx(new TextEncoder().encode('VM,Powerstate\napp,on'));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('importing the workbook', () => {
  it('reads every VM, template included and marked', () => {
    expect(inventory.vms.length).toBe(VMS.length);
    expect(vm('tpl-linux')?.template).toBe(true);
    expect(computeTotals(inventory).templateCount).toBe(1);
    expect(computeTotals(inventory).vmCount).toBe(VMS.length - 1);
  });

  it('keeps clusters of the same name in different vCenters apart', () => {
    const named = rollupByCluster(inventory).filter((c) => c.name === 'Cluster01');
    expect(named.length).toBe(2);
    expect(inventory.clusters.filter((c) => c.name === 'Cluster01').length).toBe(2);
  });

  it('attaches detail tabs to their VMs', () => {
    const db = vm('db-01');
    expect(db?.disks?.length).toBe(3);
    expect(db?.partitions?.length).toBe(1);
    expect(db?.cpu?.hotAdd).toBe(true);
    expect(db?.cpu?.limitMhz).toBe(undefined);
    expect(vm('app-02')?.snapshotCount).toBe(1);
    expect(vm('app-02')?.snapshots?.[0]?.createdAt?.startsWith('2025-')).toBe(true);
    expect(vm('app-01')?.cdroms?.[0]?.connected).toBe(true);
    expect(vm('app-01')?.ipAddresses?.includes('10.1.0.11')).toBe(true);
    expect(vm('web-01')?.tools?.status).toBe('toolsNotRunning');
  });

  it('keeps custom attributes under their own names', () => {
    expect(vm('app-01')?.customAttributes?.Owner).toBe('team-a');
    expect(vm('app-01')?.customAttributes?.['Last Backup']).toBe('daily');
  });

  it('counts a shared RDM once, and not as VMDK storage', () => {
    const totals = computeTotals(inventory);
    expect(Math.round(totals.rdmGib)).toBe(10240);
    // In Use for db-01 is 10 TiB + 100 GiB; only the 100 GiB is VMDK.
    expect(vm('db-01')?.rdmGib).toBe(10240);
    expect(totals.usedStorageGib < 2000).toBe(true);
  });

  it('reads hosts with their uplinks, VMkernel adapters and settings', () => {
    const host = inventory.hosts.find((h) => h.name === 'esx01.example.com');
    expect(host?.totalCores).toBe(64);
    expect(host?.threads).toBe(128);
    expect(host?.dnsServers?.length).toBe(2);
    expect(host?.physicalNics?.[1]?.linkUp).toBe(false);
    expect(host?.vmkernelAdapters?.[0]?.gateway).toBe('10.0.0.1');
    expect(host?.bootTime?.startsWith('2025-')).toBe(true);
  });

  it('never keeps a whole licence key', () => {
    const host = inventory.hosts[0];
    expect(host?.licenseKey).toBe('…EEEEE');
    expect(inventory.licenses?.[0]?.keyTail).toBe('EEEEE');
    expect(JSON.stringify(inventory).includes('AAAAA-BBBBB')).toBe(false);
  });

  it('records where and when it was collected', () => {
    expect(inventory.source.toolVersion).toBe('RVTools 4.7.1.4');
    expect(Object.keys(inventory.source.collectedPerVcenter ?? {}).length).toBe(2);
    expect(inventory.vcenters?.length).toBe(2);
    expect(inventory.distributedSwitches?.[0]?.hostMembers?.length).toBe(2);
  });

  it('warns when the capture was taken in the small hours', () => {
    expect(findings.some((f) => f.code === 'inventory.rvtools.off-hours-capture')).toBe(true);
    expect(findings.some((f) => f.code === 'inventory.rvtools.rdm')).toBe(true);
  });

  it('leaves tabs RVTools did not write alone, and ignores the empty file tab', () => {
    expect(findings.some((f) => f.code === 'inventory.rvtools.extra-tabs')).toBe(true);
    expect(inventory.files?.length).toBe(0);
  });

  it('merges without collapsing same-named clusters from two vCenters', () => {
    const merged = mergeInventories([inventory, { ...inventory, vms: [] }]);
    expect(merged.clusters.length).toBe(inventory.clusters.length);
  });

  it('recognises every RVTools tab from its CSV header', () => {
    expect(detectSheet('Disk,Disk Key,Raw LUN ID,VM')).toBe('vDisk');
    expect(detectSheet('Port,Switch,Active Uplink,Standby Uplink,VLAN')).toBe('dvPort');
    expect(detectSheet('Host,Port Group,Device,Subnet mask,IP 6 Gateway')).toBe('vSC_VMK');
  });
});

describe('what stands in the way of moving each VM', () => {
  it('blocks a physical RDM and a shared disk, and flags a mounted ISO', () => {
    const db = assessVm(vm('db-01')!).map((f) => f.check.id);
    expect(db.includes('rdm-physical')).toBe(true);
    expect(db.includes('multi-writer')).toBe(true);
    expect(assessVm(vm('app-01')!).some((f) => f.check.id === 'cd-connected')).toBe(true);
    expect(assessVm(vm('app-02')!).some((f) => f.check.id === 'snapshots')).toBe(true);
  });

  it('keeps cloud-only checks out of a move to VCF', () => {
    const vcf = assessMoves(inventory, 'vcf');
    const cloud = assessMoves(inventory, 'cloud');
    expect(vcf.byCheck.some((c) => c.check.id === 'legacy-nic')).toBe(false);
    expect(cloud.byCheck.some((c) => c.check.id === 'legacy-nic')).toBe(true);
    expect(vcf.blocked).toBe(2);
  });
});

describe('the VCF plan from the estate', () => {
  it('suggests the management cluster, and targets the common host', () => {
    const clusters = sourceClusters(inventory);
    const mgmt = suggestManagementSource(clusters);
    expect(mgmt.endsWith('|mgmt-cl01')).toBe(true);
    expect(hostProfiles(inventory.hosts)[0]?.coresPerCpu).toBe(32);
  });

  it('converges the management cluster and gives each vCenter a workload domain', () => {
    const clusters = sourceClusters(inventory);
    const plan = planEstate(inventory, {
      host: hostProfiles(inventory.hosts)[0]!,
      managementSource: suggestManagementSource(clusters),
    });
    expect(plan.management.path).toBe('brownfield-converge');
    expect(plan.management.hostCount).toBe(4);
    expect(plan.management.storage).toBe('vsan-esa');
    expect(plan.management.host.rawStorageGib > 0).toBe(true);
    const workload = plan.domains.filter((d) => d.kind === 'workload');
    expect(workload.length).toBe(2);
    for (const d of workload) for (const c of d.clusters) expect(c.hosts >= c.minimum).toBe(true);
    expect(plan.findings.some((f) => f.code === 'estate.plan.rdm')).toBe(true);
    // The converged management cluster sizes cleanly.
    expect(sizeDeployment(plan.management).findings.some((f) => f.code === 'vcf.hosts.below-minimum')).toBe(false);
  });

  it('starts the management domain on new hosts when asked', () => {
    const plan = planEstate(inventory, { host: hostProfiles(inventory.hosts)[0]!, managementSource: 'new' });
    expect(plan.management.path).toBe('greenfield');
    expect(plan.domains.filter((d) => d.kind === 'workload').length).toBe(2);
  });

  it('splits a cluster whose demand passes the cluster maximum', () => {
    const plan = planEstate(inventory, {
      host: { cpuSockets: 1, coresPerCpu: 1, hyperthreading: false, ramGib: 16, rawStorageGib: 0 },
      cpuRatio: 1,
      maxHostsPerCluster: 8,
    });
    const parts = plan.domains.flatMap((d) => d.clusters).filter((c) => c.part);
    expect(parts.length > 1).toBe(true);
    for (const c of parts) expect(c.hosts <= 8).toBe(true);
  });

  it('takes DNS, NTP, domain, hosts and networks for the spec builder', () => {
    const key = suggestManagementSource(sourceClusters(inventory));
    const plan = estateToPlan(inventory, key);
    expect(plan.dnsServers?.join(',')).toBe('10.0.0.2,10.0.0.3');
    expect(plan.ntpServers?.length).toBe(2);
    expect(plan.domainSuffix).toBe('example.com');
    expect(plan.hosts?.map((h) => h.hostname).join(',')).toBe('esx01,esx02,esx03,esx04');
    expect(plan.management?.cidr).toBe('10.0.0.0/24');
    expect(plan.management?.vlanId).toBe(10);
    expect(plan.management?.gateway).toBe('10.0.0.1');
    expect(plan.vmotion?.cidr).toBe('10.0.20.0/24');
    expect(plan.vmotion?.vlanId).toBe(20);
    expect(plan.vmotion?.mtu).toBe(9000);
    // The host's default gateway is not in the vMotion subnet.
    expect(plan.vmotion?.gateway).toBe(undefined);
    expect(plan.pnicsPerHost).toBe(1);
  });
});

describe('right-sizing onto cloud machine types', () => {
  const catalog = (groups: Readonly<Record<string, string>>) => new Set(Object.values(groups).join(',').split(','));

  it('offers only types the providers sell', () => {
    const sets = { aws: catalog(AWS_INSTANCE_TYPE_GROUPS), azure: catalog(AZURE_VM_SIZE_GROUPS), google: catalog(GCP_MACHINE_TYPE_GROUPS) };
    for (const [cloud, ladder] of Object.entries(LADDERS)) {
      for (const t of ladder) expect(sets[cloud as keyof typeof sets].has(t.name)).toBe(true);
    }
    expect(catalog(OCI_SHAPE_GROUPS).has('VM.Standard.E5.Flex')).toBe(true);
  });

  it('picks the family by memory per vCPU, and the smallest size that fits', () => {
    expect(rightsize('aws', 4, 16)?.type).toBe('m7i.xlarge');
    expect(rightsize('aws', 4, 8)?.type).toBe('c7i.xlarge');
    expect(rightsize('aws', 8, 64)?.type).toBe('r7i.2xlarge');
    expect(rightsize('azure', 3, 12)?.type).toBe('Standard_D4s_v5');
    expect(rightsize('google', 16, 128)?.type).toBe('n2-highmem-16');
    expect(rightsize('oci', 6, 96)?.ocpus).toBe(3);
    expect(rightsize('aws', 500, 100)).toBe(null);
  });
});

describe('Terraform from the estate', () => {
  const balanced = (text: string) => {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (c === '"' && text[i - 1] !== '\\') inString = !inString;
      if (inString) continue;
      if (c === '{' || c === '[' || c === '(') depth += 1;
      if (c === '}' || c === ']' || c === ')') depth -= 1;
      if (depth < 0) return false;
    }
    return depth === 0 && !inString;
  };

  it('rehosts a cluster to each cloud, one entry per running VM', () => {
    for (const cloud of ['aws', 'azure', 'google', 'oci'] as const) {
      const out = rehostFiles(inventory, { cloud, region: '', cluster: 'Cluster01', skipBlocked: true });
      const main = out.files['main.tf'] ?? '';
      expect(balanced(main)).toBe(true);
      // app-01 and app-02 in vc01's Cluster01, web-01 in vc02's: the db pair is
      // blocked and old-01 is powered off.
      expect((out.files['rehost-plan.csv'] ?? '').trim().split('\n').length).toBe(4);
      expect(main.includes('db-01')).toBe(false);
      for (const type of REHOST_EMITS[cloud]) {
        expect(main.includes(`resource "${type}"`)).toBe(true);
        expect(classifyType(cloud, type)).toBe('resource');
      }
      expect(/password\s*=\s*"/.test(main)).toBe(false);
    }
  });

  it('names Google instances the way Google accepts', () => {
    const main = rehostFiles(inventory, { cloud: 'google', region: '', cluster: 'Cluster01' }).files['main.tf'] ?? '';
    expect(main.includes('"app-01"')).toBe(true);
    expect(/"[^"]*[A-Z_][^"]*"\s+= \{ type/.test(main)).toBe(false);
  });

  it('builds the VCF landing zone a cluster needs', () => {
    const out = vsphereLandingFiles(inventory, {
      cluster: 'Cluster01',
      datacenter: 'wld01-dc',
      targetCluster: 'wld01-cl01',
      distributedSwitch: 'wld01-vds01',
      vsphereServer: 'wld01-vc01.example.com',
    });
    const main = out.files['main.tf'] ?? '';
    expect(balanced(main)).toBe(true);
    expect(main.includes('name                            = "pg-app"')).toBe(true);
    expect(main.includes('vlan_id                         = 110')).toBe(true);
    expect(main.includes('path          = "Apps"')).toBe(true);
    expect(main.includes('${vsphere_folder.folder_apps.path}/Web')).toBe(true);
    expect(main.includes('resource "vsphere_resource_pool"')).toBe(true);
    expect(main.includes('cpu_share_level')).toBe(true);
    expect(main.includes('resource "vsphere_custom_attribute"')).toBe(true);
    expect(main.includes('resource "vsphere_compute_cluster_vm_anti_affinity_rule"')).toBe(true);
    expect(main.includes('count = var.create_drs_rules ? 1 : 0')).toBe(true);
    for (const type of LANDING_EMITS) expect(classifyType('vsphere', type)).toBe('resource');
  });

  it('says so when there is no estate', () => {
    const out = rehostFiles(null, { cloud: 'aws', region: '', cluster: '' });
    expect(out.findings.some((f) => f.code === 'estate.terraform.no-estate')).toBe(true);
  });
});

describe('Ansible from the estate', () => {
  it('writes an inventory grouped by OS, cluster and folder', () => {
    const out = estateInventoryFiles(inventory, { cluster: 'Cluster01', os: 'all' });
    const yaml = out.files['hosts.yml'] ?? '';
    expect(yaml.includes('windows:')).toBe(true);
    expect(yaml.includes('ansible_connection: winrm')).toBe(true);
    expect(yaml.includes('ansible_host: 10.1.0.11')).toBe(true);
    expect(yaml.includes('cluster_cluster01:')).toBe(true);
    expect(yaml.includes('folder_web:')).toBe(true);
    expect(yaml.includes('tpl-linux')).toBe(false);
  });

  it('removes snapshots only when told to, with a module the catalog knows', () => {
    const out = premigrationFiles(inventory, { cluster: 'Cluster01' });
    const yaml = out.files['premigration.yml'] ?? '';
    expect(yaml.includes('remove_snapshots: false')).toBe(true);
    expect(yaml.includes('when: remove_snapshots | bool')).toBe(true);
    expect(yaml.includes('folder: /DC1/vm/Apps/Web')).toBe(true);
    expect(out.findings.some((f) => f.code === 'ansible.blueprint.unknown-module')).toBe(false);
  });

  it('recreates DRS rules and custom attributes on the target', () => {
    const out = postmigrationFiles(inventory, {
      cluster: 'Cluster01',
      targetDatacenter: 'wld01-dc',
      targetCluster: 'wld01-cl01',
      carryAttributes: true,
    });
    const yaml = out.files['postmigration.yml'] ?? '';
    expect(yaml.includes('keep-apart')).toBe(true);
    expect(yaml.includes('affinity: false')).toBe(true);
    expect(yaml.includes('name: Owner')).toBe(true);
    expect(out.findings.some((f) => f.code === 'ansible.blueprint.unknown-module')).toBe(false);
    expect(out.files['requirements.yml']?.includes('community.vmware')).toBe(true);
  });
});

describe('the decision wizard from the estate', () => {
  it('answers what an inventory can know, and no more', () => {
    const { answers, facts } = answersFromEstate(inventory);
    expect(answers.initiativeType).toBe('migration');
    expect(answers.sourceEnv).toBe('onprem-vmware');
    expect(answers.criticality).toBe(undefined);
    expect(facts.cloudBlocked).toBe(2);
    expect(String(answers.description).includes('raw device mappings')).toBe(true);
  });

  it('steers towards VMware on the cloud when much of the storage is raw LUNs', () => {
    expect(answersFromEstate(inventory).answers.migrationApproach).toBe('relocate');
    expect(answersFromEstate(inventory, 'mgmt-cl01').answers.migrationApproach).toBe('rehost');
  });
});
