/**
 * The `file` engine (addendum A.2.8.7, A.4.6): capacity = TiB × growth; the
 * throughput tier from the change rate and the users.
 *
 * Every step and range below is data, recalled and marked 'I' (verify): FSx
 * for Windows throughput capacity, Azure Files provisioned v2, Filestore tiers,
 * Azure NetApp Files / Google Cloud NetApp Volumes service levels and OCI File
 * Storage mount-target classes. The demand constants (MB/s per user, the
 * change window) are planning assumptions, flagged in the reasons.
 */

import { warning, type Finding } from '../../../core/findings.ts';
import type { Verification } from '../../../vcf/provenance.ts';
import type { AppComponent, Plan, Platform, SizingRow } from '../types.ts';
import type { SizingEngine } from './index.ts';
import { appPlanOf, isPattern, num, reason, rec, serversOf, str, type SizingPolicyExt } from './server.ts';
import { growthFactor } from './storage.ts';

interface Step { readonly id: string; readonly mbps: number; readonly minGib?: number; readonly maxGib?: number }
interface FileService { readonly service: string; readonly steps: readonly Step[]; readonly protocols: readonly ('smb' | 'nfs')[]; readonly source: string; readonly verification: Verification; readonly note?: string }

/** Per TiB service levels (NetApp): MiB/s per TiB of quota. */
export const NETAPP_LEVELS: readonly (readonly [id: string, mbpsPerTib: number])[] = [['Standard', 16], ['Premium', 64], ['Ultra', 128]];

export const FILE_SERVICES: Readonly<Record<string, FileService>> = {
  'fsx-windows': {
    service: 'aws_fsx_windows_file_system', protocols: ['smb'], verification: 'I',
    steps: [32, 64, 128, 256, 512, 1024, 2048, 4096, 12288].map((m) => ({ id: `${m}`, mbps: m, minGib: 32, maxGib: 65536 })),
    source: 'https://docs.aws.amazon.com/fsx/latest/WindowsGuide/performance.html',
  },
  'fsx-ontap': {
    service: 'aws_fsx_ontap_file_system', protocols: ['smb', 'nfs'], verification: 'I',
    steps: [128, 256, 512, 1024, 2048, 4096].map((m) => ({ id: `${m}`, mbps: m, minGib: 1024, maxGib: 196608 })),
    source: 'https://docs.aws.amazon.com/fsx/latest/ONTAPGuide/performance.html',
  },
  efs: {
    service: 'aws_efs_file_system', protocols: ['nfs'], verification: 'I',
    steps: [{ id: 'elastic', mbps: 10000 }], source: 'https://docs.aws.amazon.com/efs/latest/ug/performance.html', note: 'Elastic throughput scales with the workload.',
  },
  'azure-files-v2': {
    service: 'azurerm_storage_share', protocols: ['smb', 'nfs'], verification: 'I',
    steps: [{ id: 'provisioned-v2', mbps: 10340, minGib: 32, maxGib: 262144 }], source: 'https://learn.microsoft.com/en-us/azure/storage/files/understanding-billing',
    note: 'Provisioned v2 SSD: baseline IOPS 3,000 + 1 per GiB and throughput 100 + 0.1 MiB/s per GiB, raised independently (verify).',
  },
  filestore: {
    service: 'google_filestore_instance', protocols: ['nfs'], verification: 'I',
    steps: [
      { id: 'BASIC_HDD', mbps: 100, minGib: 1024, maxGib: 65434 }, { id: 'BASIC_SSD', mbps: 1200, minGib: 2560, maxGib: 65434 },
      { id: 'ZONAL', mbps: 2600, minGib: 1024, maxGib: 102400 }, { id: 'REGIONAL', mbps: 2600, minGib: 1024, maxGib: 102400 },
    ],
    source: 'https://docs.cloud.google.com/filestore/docs/service-tiers',
  },
  'oci-fss': {
    service: 'oci_file_storage_file_system', protocols: ['nfs'], verification: 'I',
    steps: [{ id: 'standard', mbps: 500 }, { id: 'HPMT-20', mbps: 2500 }, { id: 'HPMT-40', mbps: 5000 }, { id: 'HPMT-80', mbps: 10000 }],
    source: 'https://docs.oracle.com/en-us/iaas/Content/File/Concepts/filestorageoverview.htm', note: 'Mount-target class: standard, or a high-performance mount target (20 / 40 / 80 Gbps).',
  },
};

/** MB/s per concurrent user, and the window the daily change is copied in: planning assumptions. */
export const FILE_ASSUMPTIONS = { mbpsPerUser: 0.1, changeWindowHours: 8 } as const;

export interface FileInput {
  readonly component: string;
  readonly tib: number;
  readonly users: number;
  readonly changePctDay: number;
  readonly protocol: 'smb' | 'nfs' | 'both';
  readonly ontap: boolean;
  readonly regional: boolean;
}

function netappLevel(capGib: number, mbps: number): { id: string; quotaGib: number } {
  for (const [id, per] of NETAPP_LEVELS) if ((capGib / 1024) * per >= mbps) return { id, quotaGib: capGib };
  const [id, per] = NETAPP_LEVELS[NETAPP_LEVELS.length - 1]!;
  return { id, quotaGib: Math.ceil((mbps / per) * 1024) };
}

export function sizeFile(i: FileInput, platform: Platform, policy: SizingPolicyExt): { rows: SizingRow[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const grow = growthFactor(policy);
  const capGib = Math.ceil(i.tib * 1024 * grow);
  const perUser = policy.assumptions['file.mbpsPerUser'] ?? FILE_ASSUMPTIONS.mbpsPerUser;
  const window = policy.assumptions['file.changeWindowHours'] ?? FILE_ASSUMPTIONS.changeWindowHours;
  const changeMbps = (i.tib * 1024 * 1024 * (i.changePctDay / 100)) / (window * 3600);
  const mbps = Math.ceil(Math.max(i.users * perUser, changeMbps, 8));
  const reasons = [
    reason(`${i.tib} TiB × ${grow.toFixed(3)} growth → ${capGib} GiB.`, { assumption: grow > 1 }),
    reason(`Throughput ${mbps} MB/s: max(${i.users} users × ${perUser} MB/s, ${i.changePctDay}% daily change copied in ${window} h).`, { assumption: true }),
  ];
  const smb = i.protocol !== 'nfs';
  let key: string;
  let choice = '';
  const detail: Record<string, string | number> = { capacityGib: capGib, mbps, protocol: i.protocol };
  if (platform === 'vmware') {
    return { rows: [{ key: `file:${i.component}`, demand: { capacityGib: capGib, mbps }, choice: 'file server VMs on vSAN', detail, fits: true, reasons: [...reasons, reason('On VMware the file servers stay VMs; their volumes are sized by the storage engine.')], alternatives: [] }], findings };
  }
  if (i.ontap && platform !== 'oci') {
    key = platform === 'aws' ? 'fsx-ontap' : 'netapp';
    if (platform === 'aws') {
      const s = FILE_SERVICES['fsx-ontap']!.steps.find((x) => x.mbps >= mbps);
      choice = s ? `FSx for NetApp ONTAP ${s.id} MB/s` : '';
      detail['throughputCapacity'] = s?.mbps ?? 0;
    } else {
      const l = netappLevel(capGib, mbps);
      choice = `${platform === 'azure' ? 'Azure NetApp Files' : 'Google Cloud NetApp Volumes'} ${l.id}`;
      detail['serviceLevel'] = l.id;
      detail['quotaGib'] = l.quotaGib;
      reasons.push(reason(`${l.id}: ${NETAPP_LEVELS.find(([x]) => x === l.id)![1]} MiB/s per TiB of quota (verify).`, { source: 'https://learn.microsoft.com/en-us/azure/azure-netapp-files/azure-netapp-files-service-levels' }));
    }
    reasons.push(reason('The source is ONTAP: SnapMirror to the cloud\'s ONTAP service.'));
  } else if (platform === 'aws') {
    key = smb ? 'fsx-windows' : 'efs';
    const s = FILE_SERVICES[key]!.steps.find((x) => x.mbps >= mbps);
    choice = smb ? (s ? `FSx for Windows ${s.id} MB/s` : '') : 'EFS (elastic throughput)';
    if (smb) detail['throughputCapacity'] = s?.mbps ?? 0;
  } else if (platform === 'azure') {
    key = 'azure-files-v2';
    const iops = Math.min(102400, 3000 + capGib);
    const baseMbps = Math.min(10340, 100 + 0.1 * capGib);
    choice = 'Azure Files provisioned v2 (SSD)';
    detail['provisionedIops'] = iops;
    detail['provisionedMbps'] = Math.ceil(Math.max(baseMbps, mbps));
  } else if (platform === 'google') {
    if (smb) {
      key = 'netapp';
      const l = netappLevel(capGib, mbps);
      choice = `Google Cloud NetApp Volumes ${l.id}`;
      detail['serviceLevel'] = l.id;
      reasons.push(reason('Filestore is NFS only; SMB goes to NetApp Volumes.', { source: 'https://docs.cloud.google.com/netapp/volumes/docs/discover/overview' }));
    } else {
      key = 'filestore';
      const s = FILE_SERVICES['filestore']!.steps.filter((x) => (!i.regional || x.id === 'REGIONAL')).find((x) => x.mbps >= mbps && (x.maxGib ?? Infinity) >= capGib);
      choice = s ? `Filestore ${s.id}` : '';
      if (s) detail['sizeGib'] = Math.max(capGib, s.minGib ?? 0);
    }
  } else {
    key = 'oci-fss';
    if (smb) findings.push(warning('size.file.oci-smb', 'OCI File Storage is NFS only; SMB shares stay on Windows file-server VMs (the server engine sizes them).', { source: FILE_SERVICES['oci-fss']!.source }));
    const s = FILE_SERVICES['oci-fss']!.steps.find((x) => x.mbps >= mbps);
    choice = s ? `File Storage, ${s.id} mount target` : '';
  }
  const svc = FILE_SERVICES[key];
  if (svc) reasons.push(reason(`${svc.note ?? `Throughput steps / tiers: ${svc.steps.map((x) => x.id).join(', ')}`} (verify).`, { source: svc.source }));
  if (!choice) findings.push(warning('size.file.no-tier', `No ${platform} file tier carries ${mbps} MB/s at ${capGib} GiB; split the share.`));
  return { rows: [{ key: `file:${i.component}`, demand: { capacityGib: capGib, mbps }, choice, detail, fits: choice !== '', reasons, alternatives: [] }], findings };
}

export const fileEngine: SizingEngine<FileInput> = {
  id: 'file',
  applies: (c) => isPattern(c) && (c.tierPattern === 'file-service' || ['file-server', 'nas-gateway'].includes(c.workloadType ?? '')),
  inputs(c: AppComponent, plan: Plan): FileInput {
    const a = appPlanOf(c, plan)?.answers ?? {};
    const servers = serversOf(c, plan);
    const dataGib = servers.reduce((s, w) => s + w.disksGib.slice(1).reduce((x, g) => x + g, 0), 0);
    const tib = num(c, 'file.tib', Number(a['tib'] ?? dataGib / 1024));
    const protocol = str(c, 'file.protocol', a['protocol'] ?? 'smb');
    return {
      component: c.id,
      tib: Number.isFinite(tib) ? tib : 0,
      users: num(c, 'file.users', Number(a['users'] ?? 0)),
      changePctDay: num(c, 'file.changePctDay', Number(a['changeRate'] ?? 2)),
      protocol: protocol === 'nfs' || protocol === 'both' ? protocol : 'smb',
      ontap: str(c, 'file.ontap', a['ontap'] ?? 'no') === 'yes',
      regional: str(c, 'file.regional', 'no') === 'yes',
    };
  },
  size(input, platform, policy) {
    const r = sizeFile(input, platform, policy);
    return rec('file', platform, r.rows, r.findings);
  },
};
