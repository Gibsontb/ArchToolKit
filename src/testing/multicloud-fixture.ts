/**
 * The migration system's end-to-end fixture (WP-10, addendum A.12.3): a
 * data-centre exit with every kind of source and the specialised patterns.
 *
 * - 40 vSphere VMs, as the RVTools workbook they come in (custom attributes
 *   Application / Environment / Owner, a vDisk tab for the data disks);
 * - 6 Hyper-V VMs, 4 physical servers with 14 days of utilisation and 3 AWS
 *   instances, as the collectors' discovery files (`archtoolkit.discovery`);
 * - an ASA and a FortiGate configuration, two circuits, a legal-hold archive,
 *   subnets, contracts and assets for the data-centre exit.
 *
 * The apps: an SAP S/4HANA system (HANA 1 TiB), Exchange 2019, Citrix (300
 * users, medium), a Kubernetes platform (20 deployments), a 12 TiB file
 * server, line-of-business apps on every source, and (added by the test) one
 * new API service. Every name, address and serial is invented.
 */

import { workbook, type Cell } from './xlsx-fixture.ts';
import type { DcExit, InfraItem } from '../multicloud/plan/types.ts';
import type { K8sWorkload } from '../multicloud/plan/sizing/k8s-import.ts';

export const FIXTURE_DATE = '2026-09-26';
export const VCENTER = 'vc01.corp.example.com';

// ---------------------------------------------------------------------------
// vSphere: 40 VMs in an RVTools workbook
// ---------------------------------------------------------------------------

interface FixtureVm {
  readonly name: string;
  readonly app: string;
  readonly env?: string;
  readonly os: string;
  readonly cpu: number;
  readonly memGib: number;
  /** Boot first, GiB. */
  readonly disks: readonly number[];
  readonly ip: string;
  readonly annotation?: string;
  readonly cluster?: string;
}

const WIN22 = 'Microsoft Windows Server 2022 (64-bit)';
const WIN19 = 'Microsoft Windows Server 2019 (64-bit)';
const SLES15 = 'SUSE Linux Enterprise 15 (64-bit)';
const RHEL9 = 'Red Hat Enterprise Linux 9 (64-bit)';
const RHEL8 = 'Red Hat Enterprise Linux 8 (64-bit)';
const UBUNTU = 'Ubuntu Linux (64-bit)';

const vm = (name: string, app: string, os: string, cpu: number, memGib: number, disks: readonly number[], ip: string, over: Partial<FixtureVm> = {}): FixtureVm =>
  ({ name, app, os, cpu, memGib, disks, ip, ...over });

/** The 40 VMs, by application. */
export const VSPHERE_VMS: readonly FixtureVm[] = [
  // SAP S/4HANA: the HANA database (1 TiB), the ASCS and two application servers.
  vm('s4p-hana01', 'S4', SLES15, 64, 1024, [100, 1536, 512, 1024], '172.20.1.10', { annotation: 'SAP HANA 2.0 database for S/4HANA', cluster: 'Cluster-SAP' }),
  vm('s4p-ascs01', 'S4', SLES15, 4, 16, [100], '172.20.1.11', { annotation: 'SAP ASCS', cluster: 'Cluster-SAP' }),
  vm('s4p-pas01', 'S4', SLES15, 16, 128, [100, 200], '172.20.1.12', { annotation: 'SAP primary application server', cluster: 'Cluster-SAP' }),
  vm('s4p-aas01', 'S4', SLES15, 16, 128, [100, 200], '172.20.1.13', { annotation: 'SAP additional application server', cluster: 'Cluster-SAP' }),
  // Exchange 2019.
  vm('exch-mbx01', 'Mail', WIN19, 8, 64, [150, 2048], '172.20.2.10', { annotation: 'Exchange 2019 mailbox' }),
  vm('exch-mbx02', 'Mail', WIN19, 8, 64, [150, 2048], '172.20.2.11', { annotation: 'Exchange 2019 mailbox' }),
  // Citrix Virtual Apps and Desktops.
  vm('ctx-ddc01', 'Citrix', WIN22, 4, 16, [100], '172.20.3.10', { annotation: 'Citrix delivery controller' }),
  vm('ctx-sf01', 'Citrix', WIN22, 2, 8, [100], '172.20.3.11', { annotation: 'Citrix StoreFront' }),
  vm('ctx-vda01', 'Citrix', WIN22, 16, 64, [150], '172.20.3.21', { annotation: 'Citrix VDA session host' }),
  vm('ctx-vda02', 'Citrix', WIN22, 16, 64, [150], '172.20.3.22', { annotation: 'Citrix VDA session host' }),
  vm('ctx-vda03', 'Citrix', WIN22, 16, 64, [150], '172.20.3.23', { annotation: 'Citrix VDA session host' }),
  vm('ctx-vda04', 'Citrix', WIN22, 16, 64, [150], '172.20.3.24', { annotation: 'Citrix VDA session host' }),
  // Kubernetes: three control-plane nodes and five workers.
  ...[1, 2, 3].map((i) => vm(`k8s-cp0${i}`, 'Platform', UBUNTU, 4, 16, [100], `172.20.4.1${i}`, { annotation: 'kubeadm control plane' })),
  ...[1, 2, 3, 4, 5].map((i) => vm(`k8s-wk0${i}`, 'Platform', UBUNTU, 16, 64, [200], `172.20.4.2${i}`, { annotation: 'Kubernetes worker (kubelet, containerd)' })),
  // The 12 TiB file server.
  vm('fs01', 'Files', WIN22, 8, 32, [100, 12288], '172.20.5.10', { annotation: 'Windows file server, departmental shares' }),
  // Line-of-business apps.
  vm('crm-web01', 'CRM', WIN22, 4, 16, [100], '172.20.6.10'),
  vm('crm-web02', 'CRM', WIN22, 4, 16, [100], '172.20.6.11'),
  vm('crm-app01', 'CRM', WIN22, 8, 32, [100], '172.20.6.20'),
  vm('crm-sql01', 'CRM', WIN22, 8, 64, [100, 500], '172.20.6.30', { annotation: 'Microsoft SQL Server 2019 Enterprise' }),
  vm('shop-web01', 'Shop', RHEL9, 2, 8, [64], '172.20.7.10'),
  vm('shop-web02', 'Shop', RHEL9, 2, 8, [64], '172.20.7.11'),
  vm('shop-app01', 'Shop', RHEL9, 4, 16, [64], '172.20.7.20'),
  vm('shop-app02', 'Shop', RHEL9, 4, 16, [64], '172.20.7.21'),
  vm('shop-db01', 'Shop', RHEL9, 8, 32, [64, 400], '172.20.7.30', { annotation: 'PostgreSQL 15 primary' }),
  vm('hr-app01', 'HR', RHEL8, 4, 16, [100], '172.20.8.10'),
  vm('hr-db01', 'HR', RHEL8, 8, 64, [100, 800], '172.20.8.20', { annotation: 'Oracle Database 19c' }),
  vm('dc01', 'Directory', WIN22, 4, 8, [100], '172.20.0.10', { annotation: 'Active Directory domain controller' }),
  vm('dc02', 'Directory', WIN22, 4, 8, [100], '172.20.0.11', { annotation: 'Active Directory domain controller' }),
  vm('intra-web01', 'Intranet', RHEL9, 2, 8, [64], '172.20.9.10'),
  vm('intra-web02', 'Intranet', RHEL9, 2, 8, [64], '172.20.9.11'),
  vm('intra-app01', 'Intranet', RHEL9, 4, 16, [100], '172.20.9.20'),
  vm('batch01', 'Batch', RHEL9, 4, 16, [100], '172.20.9.30'),
  vm('batch02', 'Batch', RHEL9, 4, 16, [100], '172.20.9.31'),
  vm('batch03', 'Batch', RHEL9, 4, 16, [100], '172.20.9.32'),
];

const INFO = [
  'VM', 'Powerstate', 'Template', 'SRM Placeholder', 'Connection state', 'DNS Name', 'CPUs', 'Memory', 'Primary IP Address',
  'Folder', 'Provisioned MiB', 'In Use MiB', 'Firmware', 'Annotation', 'Application', 'Environment', 'Owner',
  'Datacenter', 'Cluster', 'Host', 'OS according to the configuration file', 'OS according to the VMware Tools', 'VM ID', 'VM UUID', 'VI SDK Server',
];
const MIB = 1024;

/** The RVTools workbook for the 40 VMs (vInfo, vCPU, vDisk). */
export async function vsphereWorkbook(): Promise<Uint8Array> {
  const info = (v: FixtureVm, i: number): Cell[] => {
    const total = v.disks.reduce((a, b) => a + b, 0) * MIB;
    const row: Record<string, Cell> = {
      VM: v.name, Powerstate: 'poweredOn', Template: 'False', 'SRM Placeholder': 'False', 'Connection state': 'connected',
      'DNS Name': `${v.name}.corp.example.com`, CPUs: v.cpu, Memory: v.memGib * MIB, 'Primary IP Address': v.ip,
      Folder: `/DC1/${v.app}`, 'Provisioned MiB': total, 'In Use MiB': Math.round(total * 0.6), Firmware: 'efi',
      Annotation: v.annotation ?? '', Application: v.app, Environment: v.env ?? 'Production', Owner: `${v.app.toLowerCase()}-team`,
      Datacenter: 'DC1', Cluster: v.cluster ?? 'Cluster01', Host: `esx0${(i % 4) + 1}.corp.example.com`,
      'OS according to the configuration file': v.os, 'OS according to the VMware Tools': v.os,
      'VM ID': `vm-${1000 + i}`, 'VM UUID': `4210aa00-0000-0000-0000-${String(i).padStart(12, '0')}`, 'VI SDK Server': VCENTER,
    };
    return INFO.map((h) => row[h] ?? '');
  };
  const ctx = (v: FixtureVm): Cell[] => [v.name, 'poweredOn', 'False', 'False'];
  const tail = (v: FixtureVm, i: number): Cell[] => [`4210aa00-0000-0000-0000-${String(i).padStart(12, '0')}`, VCENTER];
  return workbook({
    vInfo: [INFO, ...VSPHERE_VMS.map(info)],
    vCPU: [
      ['VM', 'Powerstate', 'Template', 'SRM Placeholder', 'CPUs', 'Sockets', 'Cores p/s', 'VM UUID', 'VI SDK Server'],
      ...VSPHERE_VMS.map((v, i) => [...ctx(v), v.cpu, 1, v.cpu, ...tail(v, i)]),
    ],
    vDisk: [
      ['VM', 'Powerstate', 'Template', 'SRM Placeholder', 'Disk', 'Disk Key', 'Capacity MiB', 'Raw', 'Disk Mode', 'Sharing mode', 'Thin', 'VM UUID', 'VI SDK Server'],
      ...VSPHERE_VMS.flatMap((v, i) => v.disks.map((gib, d): Cell[] => [...ctx(v), `Hard disk ${d + 1}`, 2000 + d, gib * MIB, 'False', 'persistent', 'sharingNone', 'True', ...tail(v, i)])),
    ],
  });
}

// ---------------------------------------------------------------------------
// Hyper-V, physical and AWS: the collectors' discovery files
// ---------------------------------------------------------------------------

const util14 = (cpuP95Pct: number, memP95Gib: number) => ({
  days: 14, samples: 20160, coverage: 0.97, cpuP50Pct: Math.round(cpuP95Pct / 2), cpuP95Pct, cpuP99Pct: Math.min(100, cpuP95Pct + 10), cpuMaxPct: Math.min(100, cpuP95Pct + 20),
  memP95Gib, memMaxGib: memP95Gib + 4, iopsP95: 800, mbpsP95: 40,
});

/** Six Hyper-V VMs (the collector's file). */
export const HYPERV_DISCOVERY = {
  kind: 'archtoolkit.discovery', v: 1,
  source: { platform: 'hyperv', manager: 'hv-cluster-01' },
  collectedAt: '2026-09-20',
  servers: [
    { name: 'portal-web01', app: 'Portal', env: 'prod', host: 'hv01', cluster: 'hv-cluster-01', powerState: 'Running', vcpu: 2, ramGib: 8, firmware: 'efi', disks: [{ gib: 127, usedGib: 40 }], nics: [{ ipv4: ['172.21.1.10'] }], os: { raw: 'Windows Server 2019 Datacenter' } },
    { name: 'portal-web02', app: 'Portal', env: 'prod', host: 'hv02', cluster: 'hv-cluster-01', powerState: 'Running', vcpu: 2, ramGib: 8, firmware: 'efi', disks: [{ gib: 127, usedGib: 40 }], nics: [{ ipv4: ['172.21.1.11'] }], os: { raw: 'Windows Server 2019 Datacenter' } },
    { name: 'portal-app01', app: 'Portal', env: 'prod', host: 'hv01', cluster: 'hv-cluster-01', powerState: 'Running', vcpu: 4, ramGib: 16, firmware: 'efi', disks: [{ gib: 127, usedGib: 60 }], nics: [{ ipv4: ['172.21.1.20'] }], os: { raw: 'Windows Server 2019 Datacenter' } },
    { name: 'portal-sql01', app: 'Portal', env: 'prod', host: 'hv02', cluster: 'hv-cluster-01', powerState: 'Running', vcpu: 8, ramGib: 32, firmware: 'efi', disks: [{ gib: 127, usedGib: 60 }, { gib: 500, usedGib: 300 }], nics: [{ ipv4: ['172.21.1.30'] }], os: { raw: 'Windows Server 2019 Datacenter' }, services: ['MSSQLSERVER', 'SQLSERVERAGENT'], listening: [{ port: 1433, proto: 'tcp', process: 'sqlservr' }] },
    { name: 'legacy-app01', app: 'Legacy', env: 'prod', host: 'hv03', cluster: 'hv-cluster-01', powerState: 'Running', vcpu: 2, ramGib: 8, firmware: 'bios', disks: [{ gib: 80, usedGib: 50 }], nics: [{ ipv4: ['172.21.2.10'] }], os: { raw: 'Windows Server 2016 Standard' } },
    { name: 'legacy-app02', app: 'Legacy', env: 'prod', host: 'hv03', cluster: 'hv-cluster-01', powerState: 'Running', vcpu: 2, ramGib: 8, firmware: 'bios', disks: [{ gib: 80, usedGib: 50 }], nics: [{ ipv4: ['172.21.2.11'] }], os: { raw: 'Windows Server 2016 Standard' } },
  ],
} as const;

/** Four physical servers with 14 days of utilisation (the guest collector's file). */
export const PHYSICAL_DISCOVERY = {
  kind: 'archtoolkit.discovery', v: 1,
  source: { platform: 'physical' },
  collectedAt: '2026-09-20',
  servers: [
    { name: 'bill-app01', app: 'Billing', env: 'prod', kind: 'physical', bmc: '172.22.0.11', powerState: 'on', vcpu: 32, ramGib: 256, disks: [{ gib: 480, usedGib: 120 }], nics: [{ ipv4: ['172.22.1.10'] }], os: { raw: 'Red Hat Enterprise Linux 8.9' }, utilisation: util14(18, 48) },
    { name: 'bill-app02', app: 'Billing', env: 'prod', kind: 'physical', bmc: '172.22.0.12', powerState: 'on', vcpu: 32, ramGib: 256, disks: [{ gib: 480, usedGib: 120 }], nics: [{ ipv4: ['172.22.1.11'] }], os: { raw: 'Red Hat Enterprise Linux 8.9' }, utilisation: util14(15, 44) },
    { name: 'bill-batch01', app: 'Billing', env: 'prod', kind: 'physical', bmc: '172.22.0.13', powerState: 'on', vcpu: 24, ramGib: 128, disks: [{ gib: 960, usedGib: 300 }], nics: [{ ipv4: ['172.22.1.20'] }], os: { raw: 'Red Hat Enterprise Linux 8.9' }, utilisation: util14(22, 30) },
    { name: 'bill-rpt01', app: 'Billing', env: 'prod', kind: 'physical', bmc: '172.22.0.14', powerState: 'on', vcpu: 16, ramGib: 128, disks: [{ gib: 480, usedGib: 200 }], nics: [{ ipv4: ['172.22.1.30'] }], os: { raw: 'Microsoft Windows Server 2019 Standard' }, utilisation: util14(12, 20) },
  ],
} as const;

/** Three AWS instances (the AWS collector's file). */
export const AWS_DISCOVERY = {
  kind: 'archtoolkit.discovery', v: 1,
  source: { platform: 'aws', manager: '111122223333' },
  collectedAt: '2026-09-20',
  servers: [
    { name: 'an-api01', app: 'Analytics', env: 'prod', kind: 'instance', id: 'i-0a1b2c3d4e5f60001', region: 'eu-west-1', size: 'm5.xlarge', powerState: 'running', disks: [{ gib: 100, usedGib: 30 }], nics: [{ ipv4: ['172.31.10.10'] }], os: { raw: 'Amazon Linux 2023' }, utilisation: util14(25, 6) },
    { name: 'an-worker01', app: 'Analytics', env: 'prod', kind: 'instance', id: 'i-0a1b2c3d4e5f60002', region: 'eu-west-1', size: 'm5.2xlarge', powerState: 'running', disks: [{ gib: 200, usedGib: 90 }], nics: [{ ipv4: ['172.31.10.20'] }], os: { raw: 'Amazon Linux 2023' }, utilisation: util14(40, 14) },
    { name: 'an-worker02', app: 'Analytics', env: 'prod', kind: 'instance', id: 'i-0a1b2c3d4e5f60003', region: 'eu-west-1', size: 'm5.2xlarge', powerState: 'running', disks: [{ gib: 200, usedGib: 90 }], nics: [{ ipv4: ['172.31.10.21'] }], os: { raw: 'Amazon Linux 2023' }, utilisation: util14(38, 13) },
  ],
} as const;

// ---------------------------------------------------------------------------
// The Kubernetes platform's 20 deployments
// ---------------------------------------------------------------------------

export function twentyDeployments(): K8sWorkload[] {
  const out: K8sWorkload[] = [];
  for (let i = 0; i < 20; i += 1) {
    out.push({
      name: `apps/svc-${String(i).padStart(2, '0')}`, kind: 'Deployment', replicas: 2 + (i % 3),
      cpuRequestM: 250 + (i % 4) * 250, cpuLimitM: 2000, memRequestMib: 512 + (i % 3) * 512, memLimitMib: 4096, arch: 'any', pool: 'user',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The data-centre exit: network devices with their configurations, circuits,
// subnets, the legal-hold archive, contracts and assets
// ---------------------------------------------------------------------------

export const ASA_CONFIG = `hostname dc1-edge-asa
object network SHOP-WEB
 subnet 172.20.7.0 255.255.255.240
object network SHOP-APP
 host 172.20.7.20
object network SHOP-DB
 host 172.20.7.30
object network CRM-APP
 host 172.20.6.20
object network OFFICE
 subnet 172.29.0.0 255.255.0.0
object-group service APP-PORTS tcp
 port-object eq 8443
!
access-list INSIDE remark web to app
access-list INSIDE extended permit tcp object SHOP-WEB object SHOP-APP object-group APP-PORTS
access-list INSIDE extended permit tcp object SHOP-APP object SHOP-DB eq 5432
access-list INSIDE extended permit tcp object OFFICE object CRM-APP eq https
access-list INSIDE extended deny ip any object SHOP-DB
access-group INSIDE in interface inside
`;

export const FORTIGATE_CONFIG = `config firewall address
    edit "CRM-WEB"
        set subnet 172.20.6.10 255.255.255.254
    next
    edit "CRM-APP"
        set subnet 172.20.6.20 255.255.255.255
    next
    edit "CRM-SQL"
        set subnet 172.20.6.30/32
    next
    edit "HR-APP"
        set subnet 172.20.8.10 255.255.255.255
    next
    edit "HR-DB"
        set subnet 172.20.8.20 255.255.255.255
    next
end
config firewall service custom
    edit "tcp-1433"
        set tcp-portrange 1433
    next
    edit "tcp-1521"
        set tcp-portrange 1521
    next
end
config firewall policy
    edit 1
        set name "crm-web-app"
        set srcaddr "CRM-WEB"
        set dstaddr "CRM-APP"
        set action accept
        set service "HTTPS"
    next
    edit 2
        set name "crm-app-sql"
        set srcaddr "CRM-APP"
        set dstaddr "CRM-SQL"
        set action accept
        set service "tcp-1433"
    next
    edit 3
        set name "hr-app-db"
        set srcaddr "HR-APP"
        set dstaddr "HR-DB"
        set action accept
        set service "tcp-1521"
    next
end
`;

const infra = (id: string, category: InfraItem['category'], name: string, facts: Record<string, string>, extra: Partial<InfraItem> = {}): InfraItem =>
  ({ id, category, name, disposition: 'retire', site: 'dc1', facts, ...extra });

/** The data centre around the servers. */
export function fixtureDcExit(): DcExit {
  return {
    exitDate: '2027-09-30',
    dualRunningDays: 14,
    hardwareRemovalDays: 30,
    infra: [
      infra('sn-sap', 'subnet', 'sap', { cidr: '172.20.1.0/24', vlan: '110', strategy: 're-ip' }),
      infra('sn-app', 'subnet', 'apps', { cidr: '172.20.6.0/23', vlan: '160', strategy: 're-ip' }),
      infra('sn-lob', 'subnet', 'lob', { cidr: '172.20.8.0/23', vlan: '180', strategy: 're-ip' }),
      infra('fw-asa', 'network-device', 'dc1-edge-asa', { kind: 'firewall', platform: 'cisco_asa', config: 'dc1-edge-asa.cfg' }, { vendor: 'Cisco', model: 'ASA 5555-X' }),
      infra('fw-forti', 'network-device', 'dc1-core-fgt', { kind: 'firewall', platform: 'fortios', config: 'dc1-core-fgt.conf' }, { vendor: 'Fortinet', model: 'FortiGate 600F' }),
      infra('c-mpls', 'circuit', 'mpls-dc1', {
        kind: 'mpls', provider: 'Carrier A', sites: 'dc1', contractEnd: '2027-12-31', noticeDays: '90',
        device: 'dc1-edge-asa', neighbor: '192.0.2.1', remoteAs: '64500', localAs: '65010',
      }),
      infra('c-inet', 'circuit', 'inet-dc1', {
        kind: 'internet', provider: 'ISP B', sites: 'dc1', contractEnd: '2027-10-31', noticeDays: '30',
        device: 'dc1-edge-asa', prefixes: '198.51.100.0/24', nextHop: '203.0.113.1', interface: 'outside',
      }),
      infra('dns1', 'net-service', 'dns1', { kind: 'dns' }),
      infra('ar-legal', 'archive', 'tapes-legal-2019', { media: 'tape', retentionUntil: '2032-01-01', legalHold: 'yes', obligation: 'migrate-to-archive-tier' }, { owner: 'legal', disposition: 'migrate', target: 'aws' }),
    ],
    external: [
      { id: 'bank-sftp', kind: 'partner-allowlist', party: 'Bank', direction: 'out', protocol: 'sftp', endpoint: 'sftp.bank.example', currentIps: ['203.0.113.20'], app: 'Billing', noticeDays: 30 },
    ],
    contracts: [
      { id: 'k-colo', kind: 'colocation', vendor: 'Colo Ltd', ends: '2027-12-31', noticeDays: 90 },
      { id: 'k-hw', kind: 'support', vendor: 'Server Vendor', ends: '2027-06-30', noticeDays: 60 },
    ],
    assets: [
      { id: 'as-esx01', kind: 'server', serial: 'SN-ESX01', containsData: true, sanitisation: 'purge' },
      { id: 'as-sw01', kind: 'switch', serial: 'SN-SW01', containsData: false },
    ],
  };
}
