/**
 * SAP data (addendum A.4.4): the HANA-certified sizes per cloud, the VCF 9
 * limits, and the sources.
 *
 * `SAP_CERTIFIED` is the certified table WP-23 keeps in
 * `kit/instance-specs.ts` (`SAP_HANA_CERTIFIED`), read from each cloud's SAP
 * page on 2026-09-26 and restricted to names in the machine catalogue. It is
 * re-exported here, not copied, so the sizer (WP-23) and the placement rule
 * (WP-16) can never disagree. Each row has `{platform, type, memoryGib, vcpu,
 * use, source, verification}`; AWS, Azure and Google Cloud (GCP) rows are
 * 'V-DOC', the OCI rows 'I' ([U]: not confirmed from an Oracle page).
 *
 * Certification changes monthly: `SAP_FETCHED_AT` is shown with a reminder to
 * check SAP's certified hardware directory before ordering.
 */

import { SAP_HANA_CERTIFIED, SAP_HANA_FETCHED_AT, SPEC_SOURCES, sapHanaTypes,                                     } from '../../../kit/instance-specs.js';
                                            
import { fact,           } from './model.js';

                                                                  

export const SAP_CERTIFIED                         = SAP_HANA_CERTIFIED;
export const SAP_FETCHED_AT = SAP_HANA_FETCHED_AT;

export const SAP_SOURCES = {
  directory: SPEC_SOURCES.sapDirectory,
  aws: SPEC_SOURCES.sapAws,
  azure: 'https://learn.microsoft.com/en-us/azure/sap/workloads/certifications',
  azureStorage: SPEC_SOURCES.sapAzure,
  google: SPEC_SOURCES.sapGoogle,
  oci: SPEC_SOURCES.sapOci,
  vcf: 'https://blogs.vmware.com/cloud-foundation/2026/01/19/sap-hana-and-sap-netweaver-support-for-vsphere-in-vmware-cloud-foundation-9-0-on-intel-xeon-6-cpus-with-p-core-systems/',
  hsr: 'https://help.sap.com/docs/SAP_HANA_PLATFORM/4e9b18c116aa42fc84c7dbfd02111aba/b74e16a9e09541749a745f41246a065e.html',
  sapInstall: 'https://github.com/sap-linuxlab/community.sap_install',
  rise: 'https://www.sap.com/products/erp/rise.html',
}         ;

/** SAP HANA on vSphere in VCF 9 (SAP notes 3663150, 3703816; general VM guidance 2652670). */
export const VCF_HANA_LIMITS = Object.freeze({ memoryGib: 16384, vcpu: 240, source: SAP_SOURCES.vcf, verification: 'V-DOC'          });

/** The certified types of a platform, smallest memory first ([] for VMware, which has limits instead). */
export function certifiedTypes(platform          , use                  )                {
  return platform === 'vmware' ? [] : sapHanaTypes(platform                , use);
}

                         
                              
                                                                                               
                         
                         
                              
                                                                     
                                                                           
                          
                                                     
 

/**
 * The sizer (A.4.4): the smallest certified type with memory ≥ HANA memory
 * × 1.0 (HANA sizing is already a memory quantity; no comfort factor). On
 * VMware, a VM within the VCF 9 limits. No `type` = no certified size.
 */
export function sapFit(platform          , hanaMemoryGib        , use                  )         {
  if (platform === 'vmware') {
    const fits = hanaMemoryGib <= VCF_HANA_LIMITS.memoryGib;
    return {
      platform,
      ...(fits ? { type: `${Math.max(4, Math.min(VCF_HANA_LIMITS.vcpu, Math.ceil(hanaMemoryGib / 16)))}x${Math.ceil(hanaMemoryGib)}GiB`, memoryGib: Math.ceil(hanaMemoryGib), vcpu: Math.max(4, Math.min(VCF_HANA_LIMITS.vcpu, Math.ceil(hanaMemoryGib / 16))) } : { largest: { type: 'a VCF 9 VM', memoryGib: VCF_HANA_LIMITS.memoryGib } }),
      source: VCF_HANA_LIMITS.source,
      verification: VCF_HANA_LIMITS.verification,
    };
  }
  const list = certifiedTypes(platform, use);
  const fit = list.find((x) => x.memoryGib >= hanaMemoryGib);
  const largest = list[list.length - 1];
  if (fit) return { platform, type: fit.type, vcpu: fit.vcpu, memoryGib: fit.memoryGib, source: fit.source, verification: fit.verification };
  return {
    platform,
    ...(largest ? { largest: { type: largest.type, memoryGib: largest.memoryGib } } : {}),
    source: largest?.source ?? SAP_SOURCES.directory,
    verification: largest?.verification ?? 'I',
  };
}

/** The SAP facts the catalogue and the rules cite. */
export const SAP_FACTS                  = Object.freeze([
  fact('SAP HANA production systems must run on certified infrastructure; each cloud publishes its certified types and SAP\'s directory is the authority.', SAP_SOURCES.directory),
  fact('AWS SAP HANA certified EC2 instance types.', SAP_SOURCES.aws),
  fact('Azure SAP certifications and HANA-certified VM sizes.', SAP_SOURCES.azure),
  fact('Google Cloud (GCP) SAP HANA certified machine types; the X4 types were renamed on 2025-12-12.', SAP_SOURCES.google),
  fact('OCI SAP HANA certified shapes: not confirmed from an Oracle page.', SAP_SOURCES.oci, 'I'),
  fact('SAP HANA on vSphere in VCF 9.0 on Intel Xeon 6 P-core: up to 16 TiB and 240 vCPU per VM (SAP notes 3663150, 3703816).', SAP_SOURCES.vcf),
  fact('SAP ECC on Oracle (anyDB) on Google Cloud (GCP) is supported only on Bare Metal Solution, not Compute Engine.', 'https://docs.cloud.google.com/solutions/sap/docs/sap-on-google-cloud-bare-metal-solution', 'I'),
  fact('HANA system replication moves a same-or-newer HANA with hdbnsutil -sr_enable / -sr_register (logreplay) / -sr_takeover.', SAP_SOURCES.hsr, 'C'),
  fact('DMO with System Move and heterogeneous system copy (SWPM / R3load) are SAP tools run by SAP Basis: runbook only.', 'https://help.sap.com/docs/SLTOOLSET', 'C'),
  fact('The community.sap_install collection provides the sap_general_preconfigure, sap_hana_preconfigure and sap_netweaver_preconfigure roles.', SAP_SOURCES.sapInstall, 'C'),
]);
