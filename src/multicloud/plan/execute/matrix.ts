/**
 * Which tool moves what: the source × target matrix (addendum A.3.4).
 *
 * One cell per `SourcePlatform` × execution target: the default path, the
 * alternatives, and how far the cell is verified ([U] in the addendum is
 * 'I' here, with a note). `rebuild` is always valid and is not listed as an
 * alternative; `validPathsFor` adds it.
 *
 * The addendum gives this table to WP-15 (`sources/matrix.ts`) with WP-11a
 * consuming it "stub first". WP-15 has not landed, so the data lives here,
 * in the execution kit; when WP-15 lands, its module can re-export or
 * replace this one (the shape is `matrixCell(source, target)`).
 *
 * Pure data and lookups.
 */

import type { Method, MovePath, Platform, SourcePlatform, Verification } from '../types.ts';

/**
 * Where a server lands, as the matrix's columns: VCF on owned hardware, a
 * VMware service on a hyperscaler (Azure VMware Solution, Google Cloud
 * VMware Engine, Oracle Cloud VMware Solution, Amazon EVS), or a hyperscaler's
 * native compute.
 */
export type ExecTarget = 'vcf' | 'vmware-cloud' | 'aws' | 'azure' | 'google' | 'oci';
export const EXEC_TARGET_VALUES: readonly ExecTarget[] = Object.freeze(['vcf', 'vmware-cloud', 'aws', 'azure', 'google', 'oci']);
export const EXEC_TARGET_LABELS: Readonly<Record<ExecTarget, string>> = Object.freeze({
  vcf: 'VCF (on-premises)',
  'vmware-cloud': 'AVS / GCVE / OCVS / EVS',
  aws: 'AWS',
  azure: 'Azure',
  google: 'Google Cloud (GCP)',
  oci: 'OCI',
});

/**
 * The column an item lands in: `vmware` is VCF; a relocation (HCX) onto a
 * hyperscaler is that hyperscaler's VMware service; anything else is the
 * hyperscaler's native compute.
 */
export function execTargetOf(method: Method, platform: Platform): ExecTarget {
  if (platform === 'vmware') return 'vcf';
  if (method === 'relocate-hcx') return 'vmware-cloud';
  return platform;
}

export interface MatrixCell {
  readonly default: MovePath;
  /** Other valid paths (besides `rebuild`, which is always valid). */
  readonly alternatives: readonly MovePath[];
  readonly note?: string;
  readonly verification: Verification;
  readonly source?: string;
}

const MGN_AGENT = 'https://docs.aws.amazon.com/mgn/latest/ug/agentless-mgn.html';
const AZ_AGENT = 'https://learn.microsoft.com/en-us/azure/migrate/migrate-support-matrix-physical-migration';
const M2VM_SOURCES = 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/concepts/architecture';
const M2VM_IMAGE = 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/migrate/image_import';
const OCM_SOURCES = 'https://docs.oracle.com/en-us/iaas/Content/cloud-migration/cloud-migration-overview.htm';
const OSAM = 'https://techdocs.broadcom.com/us/en/vmware-cis/hcx/vmware-hcx/9-0/vmware-hcx-user-guide-vcf-9-0/migrating-virtual-machines-with-vmware-hcx/understanding-vmware-hcx-os-assisted-migration/supported-guest-operating-systems.html';
const CONVERTER = 'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vcenter-converter/9-0/release-notes-conv/vmware-vcenter-converter-standalone-90-release-notes.html';
const NUTANIX_MOVE = 'https://next.nutanix.com/product-updates/nutanix-move-6-3-45782';

const cell = (d: MovePath, alternatives: readonly MovePath[], verification: Verification, source?: string, note?: string): MatrixCell =>
  Object.freeze({ default: d, alternatives: Object.freeze([...alternatives]), verification, ...(source ? { source } : {}), ...(note ? { note } : {}) });

const HCX_ALL: readonly MovePath[] = ['hcx-rav', 'hcx-vmotion', 'hcx-cold'];

type Row = Readonly<Record<ExecTarget, MatrixCell>>;
const row = (r: Record<ExecTarget, MatrixCell>): Row => Object.freeze(r);

const CONVERTER_ROW_VCF = cell('vcf-converter', [], 'V-DOC', CONVERTER, 'vCenter Converter 9.0 takes a running guest as a physical machine.');
const CONVERTER_U = cell('vcf-converter', [], 'I', CONVERTER, 'Converter from a cloud VM treats it as physical; unconfirmed.');

const VSPHERE: Row = row({
  vcf: cell('hcx-bulk', [...HCX_ALL, 'xvc-vmotion', 'vcf-import'], 'V-DOC', 'https://techdocs.broadcom.com/us/en/vmware-cis/hcx/vmware-hcx/9-0.html'),
  'vmware-cloud': cell('hcx-bulk', HCX_ALL, 'V-DOC', 'https://techdocs.broadcom.com/us/en/vmware-cis/hcx/vmware-hcx/9-0.html'),
  aws: cell('aws-mgn', [], 'V-DOC', MGN_AGENT, 'Agent-based; agentless is offered for vCenter sources.'),
  azure: cell('azure-migrate', ['azure-migrate-agent'], 'V-DOC', 'https://learn.microsoft.com/en-us/azure/migrate/tutorial-migrate-vmware', 'Agentless.'),
  google: cell('gcp-m2vm', [], 'V-DOC', M2VM_SOURCES),
  oci: cell('oci-ocm', [], 'V-DOC', OCM_SOURCES, 'Agent appliance.'),
});
const HYPERV: Row = row({
  vcf: cell('hcx-osam', ['vcf-converter'], 'V-DOC', OSAM, 'vCenter Converter takes powered-off Hyper-V VMs.'),
  'vmware-cloud': cell('hcx-osam', [], 'V-DOC', OSAM),
  aws: cell('aws-mgn', [], 'V-DOC', MGN_AGENT, 'Agent-based.'),
  azure: cell('azure-migrate-hyperv', ['azure-migrate-agent'], 'V-DOC', 'https://learn.microsoft.com/en-us/azure/migrate/tutorial-migrate-hyper-v', 'Agentless: a replication provider on the host.'),
  google: cell('gcp-image-import', [], 'V-DOC', M2VM_IMAGE, 'Offline: the disks are exported and imported as images.'),
  oci: cell('rebuild', [], 'V-DOC', OCM_SOURCES, 'Oracle Cloud Migrations takes VMware and AWS sources only.'),
});
const AHV: Row = row({
  vcf: cell('vcf-converter', [], 'I', CONVERTER, 'vCenter Converter 9.0 treats a running AHV guest as physical; unconfirmed.'),
  'vmware-cloud': cell('vcf-converter', [], 'I', CONVERTER, 'As VCF; unconfirmed.'),
  aws: cell('aws-mgn', [], 'V-DOC', MGN_AGENT, `Agent-based; Nutanix Move (AHV to AWS) is an alternative outside the kit: ${NUTANIX_MOVE}`),
  azure: cell('azure-migrate-agent', [], 'I', AZ_AGENT, 'As a physical server; unconfirmed. Nutanix Move is an alternative outside the kit.'),
  google: cell('gcp-image-import', [], 'V-DOC', M2VM_IMAGE),
  oci: cell('rebuild', [], 'V-DOC', OCM_SOURCES),
});
const kvmRow = (osam: boolean, ovirt: boolean): Row => row({
  vcf: osam ? cell('hcx-osam', ['vcf-converter'], 'V-DOC', OSAM, 'OS Assisted Migration takes KVM guests.') : CONVERTER_ROW_VCF,
  'vmware-cloud': osam ? cell('hcx-osam', ['vcf-converter'], 'V-DOC', OSAM) : cell('vcf-converter', [], 'V-DOC', CONVERTER, 'OS Assisted Migration is documented for KVM only; the converter as for VCF.'),
  aws: cell('aws-mgn', [], 'V-DOC', MGN_AGENT, 'Agent-based.'),
  azure: cell('azure-migrate-agent', [], 'V-DOC', AZ_AGENT),
  google: cell('gcp-image-import', [], 'V-DOC', M2VM_IMAGE),
  oci: cell('rebuild', [], ovirt ? 'I' : 'V-DOC', OCM_SOURCES, ovirt ? 'OLVM as a Cloud Migrations source is unconfirmed.' : undefined),
});
const XEN: Row = row({
  vcf: CONVERTER_ROW_VCF,
  'vmware-cloud': cell('vcf-converter', [], 'V-DOC', CONVERTER, 'As VCF.'),
  aws: cell('aws-mgn', [], 'V-DOC', MGN_AGENT, 'Agent-based.'),
  azure: cell('azure-migrate-agent', [], 'V-DOC', AZ_AGENT),
  google: cell('gcp-image-import', [], 'V-DOC', M2VM_IMAGE),
  oci: cell('rebuild', [], 'V-DOC', OCM_SOURCES),
});
const PHYSICAL: Row = row({
  vcf: CONVERTER_ROW_VCF,
  'vmware-cloud': cell('vcf-converter', [], 'V-DOC', CONVERTER, 'As VCF.'),
  aws: cell('aws-mgn', [], 'V-DOC', MGN_AGENT, 'Agent-based.'),
  azure: cell('azure-migrate-agent', [], 'V-DOC', AZ_AGENT),
  google: cell('rebuild', [], 'V-DOC', M2VM_SOURCES, 'Migrate to Virtual Machines has no physical source; partner tools are out of scope.'),
  oci: cell('rebuild', [], 'V-DOC', OCM_SOURCES),
});
const IN_CLOUD = (name: string): MatrixCell => cell('rebuild', [], 'V-DOC', undefined, `An in-cloud move within ${name}: rebuild.`);
const AWS: Row = row({
  vcf: CONVERTER_U,
  'vmware-cloud': cell('vcf-converter', [], 'I', CONVERTER, 'As VCF; unconfirmed.'),
  aws: IN_CLOUD('AWS'),
  azure: cell('azure-migrate-agent', [], 'V-DOC', AZ_AGENT, 'Documented as a physical source.'),
  google: cell('gcp-m2vm', [], 'V-DOC', M2VM_SOURCES, 'AWS source.'),
  oci: cell('oci-ocm', [], 'V-DOC', OCM_SOURCES, 'AWS source, agentless.'),
});
const AZURE: Row = row({
  vcf: CONVERTER_U,
  'vmware-cloud': cell('vcf-converter', [], 'I', CONVERTER, 'As VCF; unconfirmed.'),
  aws: cell('aws-mgn', [], 'V-DOC', MGN_AGENT, 'Agent-based.'),
  azure: IN_CLOUD('Azure'),
  google: cell('gcp-m2vm', [], 'V-DOC', M2VM_SOURCES, 'Azure source.'),
  oci: cell('rebuild', [], 'V-DOC', OCM_SOURCES),
});
const GOOGLE: Row = row({
  vcf: CONVERTER_U,
  'vmware-cloud': cell('vcf-converter', [], 'I', CONVERTER, 'As VCF; unconfirmed.'),
  aws: cell('aws-mgn', [], 'V-DOC', MGN_AGENT, 'Agent-based.'),
  azure: cell('azure-migrate-agent', [], 'V-DOC', AZ_AGENT),
  google: IN_CLOUD('Google Cloud (GCP)'),
  oci: cell('rebuild', [], 'V-DOC', OCM_SOURCES),
});
const OCI: Row = row({
  vcf: CONVERTER_U,
  'vmware-cloud': cell('vcf-converter', [], 'I', CONVERTER, 'As VCF; unconfirmed.'),
  aws: cell('aws-mgn', [], 'V-DOC', MGN_AGENT, 'Agent-based.'),
  azure: cell('azure-migrate-agent', [], 'I', AZ_AGENT, 'OCI as a physical source is unconfirmed.'),
  google: cell('gcp-image-import', [], 'V-DOC', M2VM_IMAGE),
  oci: IN_CLOUD('OCI'),
});
const SPECIALIST_CELL = cell('specialist', [], 'V-DOC', undefined, 'No replication tool moves this platform: assessment, a target recommendation and a runbook (A.4.8).');
const SPECIALIST: Row = row({ vcf: SPECIALIST_CELL, 'vmware-cloud': SPECIALIST_CELL, aws: SPECIALIST_CELL, azure: SPECIALIST_CELL, google: SPECIALIST_CELL, oci: SPECIALIST_CELL });
const UNKNOWN_CELL = cell('rebuild', [], 'I', undefined, 'The source platform is not known: rebuild, or set the origin to get a replication path.');
const UNKNOWN: Row = row({ vcf: UNKNOWN_CELL, 'vmware-cloud': UNKNOWN_CELL, aws: UNKNOWN_CELL, azure: UNKNOWN_CELL, google: UNKNOWN_CELL, oci: UNKNOWN_CELL });

/** Every source platform × every target: exhaustive by type. */
export const SOURCE_TARGET_MATRIX: Readonly<Record<SourcePlatform, Row>> = Object.freeze({
  vsphere: VSPHERE,
  hyperv: HYPERV,
  ahv: AHV,
  kvm: kvmRow(true, false),
  proxmox: kvmRow(false, false),
  ovirt: kvmRow(false, true),
  xen: XEN,
  physical: PHYSICAL,
  aws: AWS,
  azure: AZURE,
  google: GOOGLE,
  oci: OCI,
  power: SPECIALIST,
  sparc: SPECIALIST,
  itanium: SPECIALIST,
  'pa-risc': SPECIALIST,
  mainframe: SPECIALIST,
  other: UNKNOWN,
});

/** Source platforms no replication tool takes (A.4.8). */
export const NON_X86_SOURCES: readonly SourcePlatform[] = Object.freeze(['power', 'sparc', 'itanium', 'pa-risc', 'mainframe']);

export function matrixCell(source: SourcePlatform, target: ExecTarget): MatrixCell {
  return SOURCE_TARGET_MATRIX[source][target];
}

/** The paths valid for a source and target: the default, the alternatives, and `rebuild`. */
export function validPathsFor(source: SourcePlatform, target: ExecTarget): readonly MovePath[] {
  const c = matrixCell(source, target);
  const out: MovePath[] = [c.default, ...c.alternatives];
  if (!out.includes('rebuild')) out.push('rebuild');
  return out;
}
