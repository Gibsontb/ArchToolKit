/**
 * A synthetic RVTools workbook: two vCenters, each with a cluster called
 * Cluster01 (because real ones repeat names), a management cluster, a
 * template, a pair of VMs sharing one physical RDM, custom attributes, a
 * snapshot, a mounted ISO, VMkernel adapters and port groups — enough to
 * exercise every join the importer makes. Every name is invented.
 */

import { workbook, type Cell } from './xlsx-fixture.ts';

const VC1 = 'vc01.example.com';
const VC2 = 'vc02.example.com';

/** 2026-02-10 02:11 — a small-hours capture. */
export const CAPTURED = 46063.0910532407;

const ATTRS = ['Owner', 'Last Backup'];

export const INFO_HEADER = [
  'VM', 'Powerstate', 'Template', 'SRM Placeholder', 'Connection state', 'DNS Name', 'Creation date', 'CPUs',
  'Memory', 'Active Memory', 'Primary IP Address', 'Network #1', 'Resource pool', 'Folder', 'Provisioned MiB',
  'In Use MiB', 'Cluster rule(s)', 'Cluster rule name(s)', 'Firmware', 'HW version', 'Path', 'Annotation',
  ...ATTRS, 'Datacenter', 'Cluster', 'Host', 'OS according to the configuration file',
  'OS according to the VMware Tools', 'VM ID', 'VM UUID', 'VI SDK Server',
];

type Vm = {
  name: string;
  vc: string;
  cluster: string;
  host: string;
  cpu: number;
  memMib: number;
  provMib: number;
  usedMib: number;
  power?: string;
  template?: boolean;
  os?: string;
  ip?: string;
  rule?: [string, string];
  owner?: string;
  folder?: string;
  pool?: string;
  network?: string;
};

export const VMS: Vm[] = [
  { name: 'app-01', vc: VC1, cluster: 'Cluster01', host: 'esx11.example.com', cpu: 4, memMib: 16384, provMib: 102400, usedMib: 51200, os: 'Microsoft Windows Server 2019 (64-bit)', ip: '10.1.0.11', rule: ['Anti Affinity', 'keep-apart'], owner: 'team-a', folder: '/DC1/Apps/Web', pool: '/DC1/Cluster01/Resources/Gold', network: 'pg-app' },
  { name: 'app-02', vc: VC1, cluster: 'Cluster01', host: 'esx12.example.com', cpu: 4, memMib: 16384, provMib: 102400, usedMib: 40960, os: 'Microsoft Windows Server 2019 (64-bit)', ip: '10.1.0.12', rule: ['Anti Affinity', 'keep-apart'], folder: '/DC1/Apps/Web', network: 'pg-app' },
  // Two nodes sharing one 10 TiB physical RDM: In Use counts it in both.
  { name: 'db-01', vc: VC1, cluster: 'Cluster01', host: 'esx11.example.com', cpu: 8, memMib: 65536, provMib: 10485760 + 204800, usedMib: 10485760 + 102400, os: 'Red Hat Enterprise Linux 8 (64-bit)', ip: '10.1.0.21', folder: '/DC1/Data', network: 'pg-db' },
  { name: 'db-02', vc: VC1, cluster: 'Cluster01', host: 'esx12.example.com', cpu: 8, memMib: 65536, provMib: 10485760 + 204800, usedMib: 10485760 + 102400, os: 'Red Hat Enterprise Linux 8 (64-bit)', ip: '10.1.0.22', folder: '/DC1/Data', network: 'pg-db' },
  { name: 'old-01', vc: VC1, cluster: 'Cluster01', host: 'esx11.example.com', cpu: 2, memMib: 4096, provMib: 40960, usedMib: 40960, power: 'poweredOff', os: 'Microsoft Windows Server 2008 R2 (64-bit)', folder: '/DC1/Apps' },
  { name: 'tpl-linux', vc: VC1, cluster: 'Cluster01', host: 'esx11.example.com', cpu: 2, memMib: 4096, provMib: 20480, usedMib: 20480, template: true, os: 'Red Hat Enterprise Linux 9 (64-bit)', folder: '/DC1/Templates' },
  { name: 'vcsa', vc: VC1, cluster: 'mgmt-cl01', host: 'esx01.example.com', cpu: 4, memMib: 21504, provMib: 409600, usedMib: 102400, os: 'Other 3.x or later Linux (64-bit)', ip: '10.0.0.10', folder: '/DC1/Management' },
  // The same cluster name in the other vCenter is a different cluster.
  { name: 'web-01', vc: VC2, cluster: 'Cluster01', host: 'esx21.example.com', cpu: 2, memMib: 8192, provMib: 61440, usedMib: 30720, os: 'Ubuntu Linux (64-bit)', ip: '10.2.0.11', folder: '/DC2/Web', network: 'pg-web' },
];

function info(vm: Vm, i: number): Cell[] {
  const row: Record<string, Cell> = {
    VM: vm.name,
    Powerstate: vm.power ?? 'poweredOn',
    Template: vm.template ? 'True' : 'False',
    'SRM Placeholder': 'False',
    'Connection state': 'connected',
    'DNS Name': `${vm.name}.example.com`,
    'Creation date': 45658.5,
    CPUs: vm.cpu,
    Memory: vm.memMib,
    'Active Memory': Math.round(vm.memMib / 10),
    'Primary IP Address': vm.ip ?? '',
    'Network #1': vm.network ?? '',
    'Resource pool': vm.pool ?? `/${vm.vc === VC1 ? 'DC1' : 'DC2'}/${vm.cluster}/Resources`,
    Folder: vm.folder ?? '',
    'Provisioned MiB': vm.provMib,
    'In Use MiB': vm.usedMib,
    'Cluster rule(s)': vm.rule?.[0] ?? '',
    'Cluster rule name(s)': vm.rule?.[1] ?? '',
    Firmware: 'efi',
    'HW version': '19',
    Path: `[ds-${vm.cluster}] ${vm.name}/${vm.name}.vmx`,
    Annotation: `note & <${vm.name}>`,
    Owner: vm.owner ?? '',
    'Last Backup': 'daily',
    Datacenter: vm.vc === VC1 ? 'DC1' : 'DC2',
    Cluster: vm.cluster,
    Host: vm.host,
    'OS according to the configuration file': vm.os ?? '',
    'OS according to the VMware Tools': vm.power === 'poweredOff' ? '' : (vm.os ?? ''),
    'VM ID': `vm-${100 + i}`,
    'VM UUID': `uuid-${vm.name}`,
    'VI SDK Server': vm.vc,
  };
  return INFO_HEADER.map((h) => row[h] ?? '');
}

const HOSTS: [string, string, string, string, number][] = [
  // name, vCenter, datacenter, cluster, memory MiB
  ['esx01.example.com', VC1, 'DC1', 'mgmt-cl01', 1048576],
  ['esx02.example.com', VC1, 'DC1', 'mgmt-cl01', 1048576],
  ['esx03.example.com', VC1, 'DC1', 'mgmt-cl01', 1048576],
  ['esx04.example.com', VC1, 'DC1', 'mgmt-cl01', 1048576],
  ['esx11.example.com', VC1, 'DC1', 'Cluster01', 2097152],
  ['esx12.example.com', VC1, 'DC1', 'Cluster01', 2097152],
  ['esx21.example.com', VC2, 'DC2', 'Cluster01', 524288],
];

export async function estateWorkbook(): Promise<Uint8Array> {
  const vmCtx = (vm: Vm): Cell[] => [vm.name, vm.power ?? 'poweredOn', vm.template ? 'True' : 'False', 'False'];
  const vmTail = (vm: Vm): Cell[] => [`uuid-${vm.name}`, vm.vc];
  const db = VMS.filter((v) => v.name.startsWith('db-'));

  return workbook({
    vInfo: [INFO_HEADER, ...VMS.map(info)],
    vCPU: [
      ['VM', 'Powerstate', 'Template', 'SRM Placeholder', 'CPUs', 'Sockets', 'Cores p/s', 'Hot Add', 'Limit', 'VM UUID', 'VI SDK Server'],
      ...VMS.map((vm) => [...vmCtx(vm), vm.cpu, 1, vm.cpu, 'True', -1, ...vmTail(vm)]),
    ],
    vDisk: [
      ['VM', 'Powerstate', 'Template', 'SRM Placeholder', 'Disk', 'Disk Key', 'Capacity MiB', 'Raw', 'Disk Mode', 'Sharing mode', 'Thin', 'Shared Bus', 'Path', 'Raw LUN ID', 'Raw Comp. Mode', 'VM UUID', 'VI SDK Server'],
      ...VMS.flatMap((vm) => {
        const boot: Cell[] = [...vmCtx(vm), 'Hard disk 1', 2000, 102400, 'False', 'persistent', 'sharingNone', 'True', 'noSharing', `[ds] ${vm.name}/${vm.name}.vmdk`, '', '', ...vmTail(vm)];
        if (!db.includes(vm)) return [boot];
        const data: Cell[] = [...vmCtx(vm), 'Hard disk 2', 2001, 102400, 'False', 'persistent', 'sharingNone', 'True', 'noSharing', `[ds] ${vm.name}/${vm.name}_1.vmdk`, '', '', ...vmTail(vm)];
        const rdm: Cell[] = [...vmCtx(vm), 'Hard disk 3', 2016, 10485760, 'True', 'persistent', 'sharingMultiWriter', 'False', 'physicalSharing', `[ds] ${vm.name}/${vm.name}_rdm.vmdk`, '0200000000600000000001', 'physicalMode', ...vmTail(vm)];
        return [boot, data, rdm];
      }),
    ],
    vPartition: [
      ['VM', 'Powerstate', 'Template', 'SRM Placeholder', 'Disk Key', 'Disk', 'Capacity MiB', 'Consumed MiB', 'Free MiB', 'VM UUID', 'VI SDK Server'],
      ...VMS.map((vm) => [...vmCtx(vm), 2000, vm.os?.includes('Windows') ? 'C:\\' : '/', 102000, 30000, 72000, ...vmTail(vm)]),
    ],
    vNetwork: [
      ['VM', 'Powerstate', 'Template', 'SRM Placeholder', 'NIC label', 'Adapter', 'Network', 'Switch', 'Connected', 'Mac Address', 'IPv4 Address', 'Direct Path IO', 'VM UUID', 'VI SDK Server'],
      ...VMS.filter((vm) => vm.ip).map((vm) => [...vmCtx(vm), 'Network adapter 1', vm.name === 'app-02' ? 'E1000' : 'Vmxnet3', vm.network ?? 'pg-mgmt', 'vds01', 'True', '00:50:56:00:00:01', `${vm.ip}, 169.254.1.1`, 'True', ...vmTail(vm)]),
    ],
    vCD: [
      ['VM', 'Powerstate', 'Template', 'SRM Placeholder', 'Device Node', 'Connected', 'Starts Connected', 'Device Type', 'VM UUID', 'VI SDK Server'],
      [...vmCtx(VMS[0] as Vm), 'CD/DVD drive 1', 'True', 'True', 'ISO', ...vmTail(VMS[0] as Vm)],
      [...vmCtx(VMS[1] as Vm), 'CD/DVD drive 1', 'False', 'False', 'Remote device', ...vmTail(VMS[1] as Vm)],
    ],
    vSnapshot: [
      ['VM', 'Powerstate', 'Name', 'Description', 'Date / time', 'Size MiB (total)', 'Quiesced', 'VM UUID', 'VI SDK Server'],
      [VMS[1]?.name ?? '', 'poweredOn', 'before-patch', 'patching', { date: 46000.25 }, 2048, 'False', 'uuid-app-02', VC1],
    ],
    vTools: [
      ['VM', 'Powerstate', 'Template', 'SRM Placeholder', 'Tools', 'Tools Version', 'Upgradeable', 'VM UUID', 'VI SDK Server'],
      ...VMS.map((vm) => [...vmCtx(vm), vm.name === 'web-01' ? 'toolsNotRunning' : 'toolsOk', '12352', 'No', ...vmTail(vm)]),
    ],
    vSource: [
      ['Name', 'API version', 'Version', 'Build', 'Fullname', 'Product line', 'VI SDK Server', 'VI SDK UUID'],
      ['VMware vCenter Server', '8.0.3.0', '8.0.3', '24853646', 'VMware vCenter Server 8.0.3 build-24853646', 'vpx', VC1, 'vc1-uuid'],
      ['VMware vCenter Server', '8.0.3.0', '8.0.3', '24853646', 'VMware vCenter Server 8.0.3 build-24853646', 'vpx', VC2, 'vc2-uuid'],
    ],
    vRP: [
      ['Resource Pool name', 'Resource Pool path', 'CPU level', 'CPU reservation', 'CPU limit', 'CPU expandableReservation', 'Mem level', 'Mem reservation', 'Mem limit', 'Mem expandableReservation', 'VI SDK Server'],
      ['Gold', '/DC1/Cluster01/Resources/Gold', 'high', 1000, -1, 'True', 'high', 8192, -1, 'True', VC1],
    ],
    vCluster: [
      ['Name', 'NumHosts', 'numEffectiveHosts', 'TotalCpu', 'NumCpuCores', 'TotalMemory', 'HA enabled', 'Failover Level', 'AdmissionControlEnabled', 'Isolation Response', 'DRS enabled', 'DRS default VM behavior', 'VI SDK Server'],
      ['mgmt-cl01', 4, 4, 256000, 128, 4194304, 'True', 1, 'True', 'none', 'True', 'fullyAutomated', VC1],
      ['Cluster01', 2, 2, 256000, 128, 4194304, 'True', 1, 'True', 'none', 'True', 'fullyAutomated', VC1],
      ['Cluster01', 1, 1, 64000, 32, 524288, 'False', 0, 'False', 'none', 'False', 'manual', VC2],
    ],
    vHost: [
      ['Host', 'Datacenter', 'Cluster', 'CPU Model', 'Speed', 'HT Available', 'HT Active', '# CPU', 'Cores per CPU', '# Cores', 'CPU usage %', '# Memory', 'Memory usage %', '# NICs', 'ESX Version', 'Assigned License(s)', 'DNS Servers', 'Domain', 'NTP Server(s)', 'Vendor', 'Model', 'Boot time', 'VI SDK Server'],
      ...HOSTS.map(([name, vc, dc, cluster, mem]) => [name, dc, cluster, 'Intel(R) Xeon(R) Gold 6430', 2100, 'True', 'True', 2, 32, 64, 5, mem, 40, 2, 'VMware ESXi 8.0.3 build-24280767', 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', '10.0.0.2, 10.0.0.3', 'example.com', 'ntp1.example.com, ntp2.example.com', 'ExampleCorp', 'Server X1', { date: 45900.5 }, vc]),
    ],
    vNIC: [
      ['Host', 'Datacenter', 'Cluster', 'Network Device', 'Driver', 'Speed', 'Duplex', 'MAC', 'Switch', 'VI SDK Server'],
      ...HOSTS.flatMap(([name, vc, dc, cluster]) => [
        [name, dc, cluster, 'vmnic0', 'nenic', 25000, 'True', '00:00:00:00:00:01', 'vds01', vc],
        [name, dc, cluster, 'vmnic1', 'nenic', '', 'Link is down!', '00:00:00:00:00:02', '', vc],
      ]),
    ],
    vPort: [
      ['Host', 'Datacenter', 'Cluster', 'Port Group', 'Switch', 'VLAN', 'VI SDK Server'],
      ...HOSTS.map(([name, vc, dc, cluster]) => [name, dc, cluster, 'Management Network', 'vSwitch0', 10, vc]),
    ],
    dvSwitch: [
      ['Switch', 'Datacenter', 'Name', 'Vendor', 'Version', 'Host members', 'Max MTU', 'VI SDK Server'],
      ['vds01', 'DC1', 'DVS', 'VMware, Inc.', '8.0.0', 'esx01.example.com, esx02.example.com', 9000, VC1],
    ],
    dvPort: [
      ['Port', 'Switch', 'Type', '# Ports', 'VLAN', 'Active Uplink', 'Standby Uplink', 'VI SDK Server'],
      ['pg-app', 'vds01', 'earlyBinding', 64, 110, 'Uplink 1, Uplink 2', '', VC1],
      ['pg-db', 'vds01', 'earlyBinding', 64, 120, 'Uplink 1, Uplink 2', '', VC1],
      ['pg-vmotion', 'vds01', 'earlyBinding', 64, 20, 'Uplink 1', 'Uplink 2', VC1],
      ['pg-web', 'vds02', 'earlyBinding', 64, 210, 'Uplink 1', '', VC2],
    ],
    vSC_VMK: [
      ['Host', 'Datacenter', 'Cluster', 'Port Group', 'Device', 'IP Address', 'Subnet mask', 'Gateway', 'MTU', 'VI SDK Server'],
      ...HOSTS.flatMap(([name, vc, dc, cluster], i) => [
        [name, dc, cluster, 'Management Network', 'vmk0', `10.0.0.${21 + i}`, '255.255.255.0', '10.0.0.1', 1500, vc],
        [name, dc, cluster, 'pg-vmotion', 'vmk1', `10.0.20.${21 + i}`, '255.255.255.0', '10.0.0.1', 9000, vc],
      ]),
    ],
    vDatastore: [
      ['Name', 'Type', 'Capacity MiB', 'Provisioned MiB', 'In Use MiB', 'Free MiB', '# Hosts', 'Hosts', 'VI SDK Server'],
      ['ds-mgmt-cl01', 'vsan', 16777216, 4194304, 2097152, 14680064, 4, 'esx01.example.com, esx02.example.com, esx03.example.com, esx04.example.com', VC1],
      ['ds-Cluster01', 'VMFS', 33554432, 22020096, 21000000, 12554432, 2, 'esx11.example.com, esx12.example.com', VC1],
    ],
    vLicense: [
      ['Name', 'Key', 'Cost Unit', 'Total', 'Used', 'Expiration Date', 'Features', 'VI SDK Server'],
      ['vSphere 8 Enterprise Plus', 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', 'cpuPackage', 32, 14, 'Never', 'vMotion, DRS, , ', VC1],
    ],
    vHealth: [
      ['Name', 'Message', 'Message type', 'VI SDK Server'],
      ['[ds] orphan/orphan.vmdk', 'Possibly a Zombie vmdk file! Please check.', 'Zombie', VC1],
    ],
    vFileInfo: [['Friendly Path Name'], ['This tab page is empty when GetFileInfo option is not set.']],
    vMetaData: [
      ['RVTools major version', 'RVTools version', 'xlsx creation datetime', 'Server'],
      ['4.7', '4.7.1.4', { date: CAPTURED }, VC1],
      ['4.7', '4.7.1.4', { date: CAPTURED + 0.01 }, VC2],
    ],
    'My notes': [['not', 'rvtools']],
  });
}
