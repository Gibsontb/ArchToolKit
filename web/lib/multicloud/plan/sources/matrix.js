/**
 * Which tool moves what: source platform × target platform → the valid move
 * paths, the default first (addendum A.3.4). `rebuild` is always valid.
 *
 * The matrix is typed `Record<SourcePlatform, Record<Platform, MatrixCell>>`,
 * so a new source platform or target platform does not compile until every
 * pair has a cell. The vmware column is VCF on premises; `onCloud` holds the
 * VMware-on-cloud targets (AVS, GCVE, OCVS, EVS) where they differ.
 *
 * Every cell cites its source; cells the design marks [U] carry
 * verification 'I' (inferred / unconfirmed) and say so.
 */

                                                                                    

                          
                          
                             
                                                                                                          
                                             
 

                                             
                                                                                                 
                             
                         
                                      
                                      
 

const S = {
  mgnAgentless: 'https://docs.aws.amazon.com/mgn/latest/ug/agentless-mgn.html',
  mgnOs: 'https://docs.aws.amazon.com/mgn/latest/ug/Supported-Operating-Systems.html',
  azPhysical: 'https://learn.microsoft.com/en-us/azure/migrate/migrate-support-matrix-physical-migration',
  azHyperV: 'https://learn.microsoft.com/en-us/azure/migrate/tutorial-migrate-hyper-v',
  azVmware: 'https://learn.microsoft.com/en-us/azure/migrate/tutorial-migrate-vmware',
  m2vm: 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/concepts/architecture',
  imageImport: 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/migrate/image_import',
  ocm: 'https://docs.oracle.com/en-us/iaas/Content/cloud-migration/cloud-migration-overview.htm',
  osam: 'https://techdocs.broadcom.com/us/en/vmware-cis/hcx/vmware-hcx/9-0/vmware-hcx-user-guide-vcf-9-0/migrating-virtual-machines-with-vmware-hcx/understanding-vmware-hcx-os-assisted-migration/supported-guest-operating-systems.html',
  converter: 'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vcenter-converter/9-0/release-notes-conv/vmware-vcenter-converter-standalone-90-release-notes.html',
  hcx: 'https://techdocs.broadcom.com/us/en/vmware-cis/hcx/vmware-hcx/9-0/vmware-hcx-user-guide-vcf-9-0.html',
  nutanixMove: 'https://next.nutanix.com/product-updates/nutanix-move-6-3-45782',
  design: 'addendum A.3.4',
}         ;

const withRebuild = (list                     )             => [...list.filter((p) => p !== 'rebuild'), 'rebuild'];
function cell(def          , alts                     , sources                   , verification               = 'V-DOC', extra                                       = {})             {
  return {
    default: def,
    alternatives: def === 'rebuild' ? alts.filter((p) => p !== 'rebuild') : withRebuild(alts),
    ...(extra.onCloud ? { onCloud: extra.onCloud } : {}),
    ...(extra.note ? { note: extra.note } : {}),
    verification,
    sources,
  };
}
const set = (def          , alts                      = [])          => ({ default: def, alternatives: def === 'rebuild' ? alts : withRebuild(alts) });

const INCLOUD = 'Same cloud: an in-cloud move is a rebuild (or the provider\'s own resize / region copy), not a migration tool.';
const SPECIALIST = 'Non-x86 and mainframe: no replication tool; a specialist path (partner or manual) with the assessment and runbook only (A.4.8).';
const specialistRow = ()                               => {
  const c = cell('specialist', ['rebuild'], [S.design], 'V-DOC', { note: SPECIALIST });
  return { vmware: c, aws: c, azure: c, google: c, oci: c };
};

export const SOURCE_TARGET_MATRIX                                                                           = Object.freeze({
  vsphere: {
    vmware: cell('hcx-bulk', ['hcx-rav', 'hcx-vmotion', 'hcx-cold', 'xvc-vmotion', 'vcf-import'], [S.hcx], 'V-DOC', { onCloud: set('hcx-bulk', ['hcx-rav', 'hcx-vmotion', 'hcx-cold']) }),
    aws: cell('aws-mgn', [], [S.mgnAgentless], 'V-DOC', { note: 'AWS Transform MGN: agent-based, or agentless for vCenter sources.' }),
    azure: cell('azure-migrate', ['azure-migrate-agent'], [S.azVmware]),
    google: cell('gcp-m2vm', ['gcp-image-import'], [S.m2vm]),
    oci: cell('oci-ocm', [], [S.ocm], 'V-DOC', { note: 'Oracle Cloud Migrations uses an agent appliance for VMware sources.' }),
  },
  hyperv: {
    vmware: cell('hcx-osam', ['vcf-converter'], [S.osam, S.converter], 'V-DOC', { onCloud: set('hcx-osam'), note: 'vCenter Converter takes powered-off Hyper-V VMs.' }),
    aws: cell('aws-mgn', [], [S.mgnOs]),
    azure: cell('azure-migrate-hyperv', ['azure-migrate-agent'], [S.azHyperV], 'V-DOC', { note: 'Agentless, with the replication provider on each Hyper-V host.' }),
    google: cell('gcp-image-import', [], [S.imageImport, S.m2vm], 'V-DOC', { note: 'Offline: Migrate to VMs has no Hyper-V source; the disks are exported and imported.' }),
    oci: cell('rebuild', [], [S.ocm], 'V-DOC', { note: 'Oracle Cloud Migrations takes VMware and AWS sources only.' }),
  },
  ahv: {
    vmware: cell('vcf-converter', [], [S.converter], 'I', { note: 'vCenter Converter 9.0 treats a running AHV guest as a physical machine [U].' }),
    aws: cell('aws-mgn', [], [S.mgnOs, S.nutanixMove], 'V-DOC', { note: 'Nutanix Move (AHV → AWS) is the vendor alternative.' }),
    azure: cell('azure-migrate-agent', [], [S.azPhysical], 'I', { note: 'Agent-based, treated as a physical server [U].' }),
    google: cell('gcp-image-import', [], [S.imageImport]),
    oci: cell('rebuild', [], [S.ocm]),
  },
  kvm: {
    vmware: cell('hcx-osam', ['vcf-converter'], [S.osam, S.converter], 'V-DOC', { onCloud: set('hcx-osam', ['vcf-converter']) }),
    aws: cell('aws-mgn', [], [S.mgnOs]),
    azure: cell('azure-migrate-agent', [], [S.azPhysical]),
    google: cell('gcp-image-import', [], [S.imageImport]),
    oci: cell('rebuild', [], [S.ocm]),
  },
  proxmox: {
    vmware: cell('vcf-converter', [], [S.converter], 'I', { note: 'HCX OS Assisted Migration lists KVM, not Proxmox by name; vCenter Converter treats the guest as physical [U].' }),
    aws: cell('aws-mgn', [], [S.mgnOs]),
    azure: cell('azure-migrate-agent', [], [S.azPhysical], 'I', { note: 'Agent-based as a physical server (Proxmox is KVM-based) [U].' }),
    google: cell('gcp-image-import', [], [S.imageImport]),
    oci: cell('rebuild', [], [S.ocm]),
  },
  ovirt: {
    vmware: cell('vcf-converter', [], [S.converter], 'I', { note: 'vCenter Converter treats the guest as physical [U].' }),
    aws: cell('aws-mgn', [], [S.mgnOs]),
    azure: cell('azure-migrate-agent', [], [S.azPhysical], 'I', { note: 'Agent-based as a physical server (oVirt is KVM-based) [U].' }),
    google: cell('gcp-image-import', [], [S.imageImport]),
    oci: cell('rebuild', [], [S.ocm], 'I', { note: 'OLVM as an Oracle Cloud Migrations source is unconfirmed [U].' }),
  },
  xen: {
    vmware: cell('vcf-converter', [], [S.converter], 'I', { note: 'vCenter Converter treats the guest as physical [U].' }),
    aws: cell('aws-mgn', [], [S.mgnOs]),
    azure: cell('azure-migrate-agent', [], [S.azPhysical]),
    google: cell('gcp-image-import', [], [S.imageImport]),
    oci: cell('rebuild', [], [S.ocm]),
  },
  physical: {
    vmware: cell('vcf-converter', [], [S.converter]),
    aws: cell('aws-mgn', [], [S.mgnOs]),
    azure: cell('azure-migrate-agent', [], [S.azPhysical]),
    google: cell('rebuild', [], [S.m2vm], 'V-DOC', { note: 'Migrate to VMs has no physical source; partner tools are out of scope.' }),
    oci: cell('rebuild', [], [S.ocm]),
  },
  aws: {
    vmware: cell('vcf-converter', [], [S.converter], 'I', { note: 'An EC2 instance as a physical source for vCenter Converter [U].' }),
    aws: cell('rebuild', [], [S.design], 'V-DOC', { note: INCLOUD }),
    azure: cell('azure-migrate-agent', [], [S.azPhysical], 'V-DOC', { note: 'Documented "as physical".' }),
    google: cell('gcp-m2vm', [], [S.m2vm]),
    oci: cell('oci-ocm', [], [S.ocm], 'V-DOC', { note: 'Oracle Cloud Migrations: AWS EC2 source, agentless.' }),
  },
  azure: {
    vmware: cell('vcf-converter', [], [S.converter], 'I', { note: 'An Azure VM as a physical source for vCenter Converter [U].' }),
    aws: cell('aws-mgn', [], [S.mgnOs]),
    azure: cell('rebuild', [], [S.design], 'V-DOC', { note: INCLOUD }),
    google: cell('gcp-m2vm', [], [S.m2vm]),
    oci: cell('rebuild', [], [S.ocm]),
  },
  google: {
    vmware: cell('vcf-converter', [], [S.converter], 'I', { note: 'A Compute Engine instance as a physical source for vCenter Converter [U].' }),
    aws: cell('aws-mgn', [], [S.mgnOs]),
    azure: cell('azure-migrate-agent', [], [S.azPhysical]),
    google: cell('rebuild', [], [S.design], 'V-DOC', { note: INCLOUD }),
    oci: cell('rebuild', [], [S.ocm]),
  },
  oci: {
    vmware: cell('vcf-converter', [], [S.converter], 'I', { note: 'An OCI instance as a physical source for vCenter Converter [U].' }),
    aws: cell('aws-mgn', [], [S.mgnOs]),
    azure: cell('azure-migrate-agent', [], [S.azPhysical], 'I', { note: 'OCI instances are not listed by name [U].' }),
    google: cell('gcp-image-import', [], [S.imageImport]),
    oci: cell('rebuild', [], [S.design], 'V-DOC', { note: INCLOUD }),
  },
  power: specialistRow(),
  sparc: specialistRow(),
  itanium: specialistRow(),
  'pa-risc': specialistRow(),
  mainframe: specialistRow(),
  other: {
    vmware: cell('rebuild', ['vcf-converter'], [S.design], 'I', { note: 'Unknown source: rebuild unless the guest can be treated as physical.' }),
    aws: cell('rebuild', ['aws-mgn'], [S.design], 'I', { note: 'Unknown source: MGN\'s agent works where the OS is supported.' }),
    azure: cell('rebuild', ['azure-migrate-agent'], [S.design], 'I'),
    google: cell('rebuild', [], [S.design], 'I'),
    oci: cell('rebuild', [], [S.design], 'I'),
  },
});

/** The cell for a pair; `onCloud` selects the VMware-on-cloud column for vmware targets. */
export function matrixCell(source                            , target          , onCloud = false)                                                       {
  const c = SOURCE_TARGET_MATRIX[source ?? 'vsphere'][target];
  const s = onCloud && target === 'vmware' && c.onCloud ? c.onCloud : c;
  return { ...c, default: s.default, alternatives: s.alternatives, paths: [s.default, ...s.alternatives] };
}

/** Every valid path for a pair, the default first. */
export function validPaths(source                            , target          , onCloud = false)                      {
  return matrixCell(source, target, onCloud).paths;
}

/** True when the path is valid for the pair (pattern paths such as sap-hsr are the pattern engine's, not this matrix's). */
export function isValidPath(path          , source                            , target          , onCloud = false)          {
  return validPaths(source, target, onCloud).includes(path);
}
