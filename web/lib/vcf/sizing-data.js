/**
 * VCF 9.1.x sizing reference data.
 *
 * Every figure here carries two things:
 *  - a verification tag (see provenance.ts) for how it was checked, and
 *  - a `basis`: 'published' (Broadcom states it, `sourceUrl` points at the
 *    page or workbook), 'derived' (arithmetic on published figures, the note
 *    says how), or 'unconfirmed' (no 9.1 source found; indicative only).
 *
 * Appliance sizes come from Broadcom's release-specific VCF Planning and
 * Preparation Workbook, read from the generated `workbook-data.ts` (tools/
 * fetch-vcf-workbook.mjs). Re-running the generator for a new release updates
 * the sizing with no code change; a key that disappears fails loudly
 * (`workbookValue` throws, and sizing-workbook.test.ts lists every key used).
 * TechDocs page figures are kept only where the workbook has no table.
 *
 * Nothing unconfirmed is presented as published. Names are the VCF 9.1 names:
 * "Protection and Recovery" (not Live Recovery), "log management" (a VCF
 * management services component, not Operations for Logs).
 *
 * Research date: 2026-09-26, against VCF 9.1.0 and 9.1.1 TechDocs and workbooks.
 */

                                                    
import { atLeastVcfVersion, DEFAULT_VCF_VERSION } from './version.js';
import { WORKBOOK } from './workbook-data.js';

                            
                        
                          
                           
 

/** How a figure is known. */
                                                            

                                               
                                      
                           
                                                                             
                              
                         
                         
 

export const ZERO_FOOTPRINT            = { vcpu: 0, ramGib: 0, diskGib: 0 };

export function addFootprints(a           , b           )            {
  return {
    vcpu: a.vcpu + b.vcpu,
    ramGib: a.ramGib + b.ramGib,
    diskGib: a.diskGib + b.diskGib,
  };
}

export function subtractFootprints(a           , b           )            {
  return { vcpu: a.vcpu - b.vcpu, ramGib: a.ramGib - b.ramGib, diskGib: a.diskGib - b.diskGib };
}

export function scaleFootprint(f           , factor        )            {
  return { vcpu: f.vcpu * factor, ramGib: f.ramGib * factor, diskGib: f.diskGib * factor };
}

/** The bare numbers of a sized entry. */
export function footprintOf(e           )            {
  return { vcpu: e.vcpu, ramGib: e.ramGib, diskGib: e.diskGib };
}

/** The basis of an entry, weakest first when several are combined. */
export function weakestBasis(bases                                )        {
  const order                        = { published: 0, derived: 1, unconfirmed: 2 };
  let worst        = 'published';
  for (const b of bases) {
    const v = b ?? 'unconfirmed';
    if (order[v] > order[worst]) worst = v;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const TD = 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1';

/** Every page a figure in this file was read from. */
export const SOURCES = {
  fleetSizing: `${TD}/design/vmware-cloud-foundation-concepts/vcf-fleet-sizing-models-9-x.html`,
  fleetSizing910:
    'http://web.archive.org/web/20260609204101/https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/design/vmware-cloud-foundation-concepts/vcf-fleet-sizing-models-9-x.html',
  managementServices: `${TD}/design/vmware-cloud-foundation-concepts/vcf-management-services-models.html`,
  sddcManager911Notes: `${TD}/release-notes/vmware-cloud-foundation-9-1-1-0-release-notes/sddc-manager-9-1-1-0-release-notes.html`,
  vcfmsReducedKb: 'https://knowledge.broadcom.com/external/article/455842',
  vcfmsReducedBlog:
    'https://williamlam.com/2026/09/vcf-9-1-1-adopting-the-reduced-vcf-management-services-vcfms-footprint-after-an-upgrade.html',
  singleRack: `${TD}/design/design-library/cluster-models/single-instance-single-availability-zone.html`,
  stretched: `${TD}/design/design-library/cluster-models/single-instance-multiple-availability-zones.html`,
  storageModels: `${TD}/design/vmware-cloud-foundation-concepts/storage-models.html`,
  esxDesign: `${TD}/design/design-library/vsphere-detailed-design/esx-design.html`,
  vcenterHardware:
    'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/9-1/vcenter-installation-and-setup/deploying-the-vcenter-server-appliance/vcenter-server-appliance-requirements/vcenter-server-appliance-hardware-requirements.html',
  vcenterStorage:
    'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/9-1/vcenter-installation-and-setup/deploying-the-vcenter-server-appliance/vcenter-server-appliance-requirements/vcsa-storage-requirements.html',
  edgeVm: `${TD}/advanced-network-management/installing-nsx-edge/edge-vm-system-requirements.html`,
  licenseServer: `${TD}/licensing/license-server-overview.html`,
  licensingModel: `${TD}/licensing/licensing-overview/licensing-model.html`,
  licensingOverview: `${TD}/licensing/licensing-overview.html`,
  logManagement: `${TD}/design/design-library/vcf-operations-design/vcf-operations-for-logs-deployment-models.html`,
  operationsForNetworks: `${TD}/design/design-library/vcf-operations-design/vcf-operations-for-networks-deployment-models.html`,
  fqdnFirstInstance: `${TD}/planning-and-preparation/vcf-components-fqdns-and-ip-addresses/first-vcf-instance-fqdns-and-ip-addresses.html`,
  fqdnAdditionalInstance: `${TD}/planning-and-preparation/vcf-components-fqdns-and-ip-addresses/additional-vcf-instance-fqdns-and-ip-addresses.html`,
  autoRaid: 'https://blogs.vmware.com/cloud-foundation/2026/05/08/auto-raid-in-vsan-for-vcf-9-1/',
  effectiveCapacity: 'https://blogs.vmware.com/cloud-foundation/2026/05/11/effective-capacity-view-in-vsan-for-vcf-9-1/',
  supervisorSizes: `${TD}/vsphere-supervisor-installation-and-configuration/configuring-and-managing-a-supervisor-cluster/change-the-control-plane-size-on-a-supervisor-cluster.html`,
  supervisorModels: `${TD}/design/vmware-cloud-foundation-concepts/vsphere-supervisor-deployment-types.html`,
  hcx: `${TD}/workload-mobility/vmware-hcx-user-guide-vcf-9-0/preparing-for-hcx-installations/system-requirements-for-hcx.html`,
  protectionRecovery:
    'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/protection-and-recovery/9-1/protection-and-recovery-installation/setting-up-vmware-live-site-recovery-overview/site-recovery-manager-appliance-overview/site-recovery-manager-system-requirements.html',
  protectionRecoveryNotes:
    'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/protection-and-recovery/9-1/release-notes/protection-and-recovery-91-release-notes.html',
  avi: `${TD}/design/design-library/vcf-load-balancing-detailed-design/avi-load-balancer-detailed-design.html`,
  memoryTiering:
    'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/9-1/vsphere-resource-management/memory-tiering-over-nvme/memory-tiering-considerations-and-best-practices.html',
  vcenter911Notes: `${TD}/release-notes/vmware-cloud-foundation-9-1-1-0-release-notes/vcenter-9-1-1-0-release-notes.html`,
  operationsSizingKb: 'https://knowledge.broadcom.com/external/article/397782/vcf-operations-90-sizing-guidelines.html',
  vcfEdge: `${TD}/design/vmware-cloud-foundation-concepts/vcf-edge.html`,
  /** The workbooks, as the generator recorded them. */
  workbook910: WORKBOOK.releases['9.1']?.source ?? 'https://techdocs.broadcom.com/content/dam/broadcom/techdocs/us/en/assets/vmware-cis/vcf/vcf-9.1-planning-and-preparation-workbook.xlsx',
  workbook911: WORKBOOK.releases['9.1.1']?.source ?? 'https://techdocs.broadcom.com/content/dam/broadcom/techdocs/us/en/assets/vmware-cis/vcf/vcf-9.1.1-planning-and-preparation-workbook.xlsx',
}         ;

// ---------------------------------------------------------------------------
// Target release
// ---------------------------------------------------------------------------

/** The two 9.1 releases whose sizing differs. */
                                           

export const VCF_RELEASES                        = ['9.1.0', '9.1.1'];

export const VCF_RELEASE_LABELS                             = {
  '9.1.0': 'VCF 9.1.0.x',
  '9.1.1': 'VCF 9.1.1.x',
};

/** Which sizing release a version string ("9.1.0", "9.1.0.400", "9.1.1.0") falls in. */
export function vcfRelease(version                    )             {
  return atLeastVcfVersion(version ?? DEFAULT_VCF_VERSION, '9.1.1.0') ? '9.1.1' : '9.1.0';
}

/** 9.1.1, from `DEFAULT_VCF_VERSION`. */
export const DEFAULT_VCF_RELEASE             = vcfRelease(DEFAULT_VCF_VERSION);

/** A full four-part version for a release or a partial version string. */
export function fullVcfVersion(version                    )         {
  const v = version ?? DEFAULT_VCF_VERSION;
  const parts = v.split('.');
  while (parts.length < 4) parts.push('0');
  return parts.join('.');
}

// ---------------------------------------------------------------------------
// The Planning and Preparation Workbook
// ---------------------------------------------------------------------------

/** The workbook's own release key ("9.1" is 9.1.0). */
                                                 

export function workbookRelease(release                                 )                     {
  return release === '9.1.0' || release === '9.1' ? '9.1' : '9.1.1';
}

export const WORKBOOK_NAMES                                     = {
  '9.1': 'VCF 9.1 Planning and Preparation Workbook',
  '9.1.1': 'VCF 9.1.1 Planning and Preparation Workbook',
};
/** @deprecated Use WORKBOOK_NAMES. */
export const WORKBOOK_910 = WORKBOOK_NAMES['9.1'];
/** @deprecated Use WORKBOOK_NAMES. */
export const WORKBOOK_911 = WORKBOOK_NAMES['9.1.1'];

export function workbookUrl(release                                 )         {
  return workbookRelease(release) === '9.1' ? SOURCES.workbook910 : SOURCES.workbook911;
}

/** Source line for a workbook figure. */
export function workbookSource(release                                 , sheet = 'Static Reference Tables')                                        {
  const r = workbookRelease(release);
  return { source: `${WORKBOOK_NAMES[r]}, sheet ${sheet}`, sourceUrl: workbookUrl(r) };
}

/**
 * Tables the generator does not parse cleanly yet, read here from values taken
 * from the workbook's own cells. Each is used only while the generated table
 * lacks a numeric value; when the generator is fixed the workbook value wins.
 * Anything missing that is NOT listed here throws.
 */
export const WORKBOOK_KNOWN_GAPS                                   = {
  // 9.1 "VCFMS Worker Node Disk" is swallowed by the rows below it.
  '9.1|VCFMS Worker Node Disk|Small': 100,
  '9.1|VCFMS Worker Node Disk|Medium': 100,
  '9.1|VCFMS Worker Node Disk|Large': 100,
  // 9.1.1 "Log Managment RAM Per Replica" has no header row the generator
  // recognises, so its values land in the CPU table; see logReplicaCpuRam.
  '9.1.1|Log Managment CPU Per Replica|Small': 8,
  '9.1.1|Log Managment CPU Per Replica|Medium': 16,
  '9.1.1|Log Managment CPU Per Replica|Large': 32,
  '9.1.1|Log Managment RAM Per Replica|Small': 16,
  '9.1.1|Log Managment RAM Per Replica|Medium': 32,
  '9.1.1|Log Managment RAM Per Replica|Large': 64,
  // 9.1.1 Supervisor and VCFMS service tables use "<name> | CPU" headers and are
  // swallowed by "VCFMS Calculations".
  '9.1.1|Supervisor CPU|Tiny': 2,
  '9.1.1|Supervisor CPU|Small': 4,
  '9.1.1|Supervisor CPU|Medium': 8,
  '9.1.1|Supervisor CPU|Large': 16,
  '9.1.1|Supervisor CPU|Xlarge': 32,
  '9.1.1|Supervisor RAM|Tiny': 8,
  '9.1.1|Supervisor RAM|Small': 16,
  '9.1.1|Supervisor RAM|Medium': 24,
  '9.1.1|Supervisor RAM|Large': 32,
  '9.1.1|Supervisor RAM|Xlarge': 64,
  '9.1.1|Supervisor Disk|Tiny': 48,
  '9.1.1|Supervisor Disk|Small': 48,
  '9.1.1|Supervisor Disk|Medium': 48,
  '9.1.1|Supervisor Disk|Large': 48,
  '9.1.1|Supervisor Disk|Xlarge': 48,
  ...serviceGaps(),
};

function serviceGaps()                         {
  const t                                                            = {
    'Identity Broker CPU (VCFMS)': [1.5, 3, 5, 10],
    'Identity Broker RAM (VCFMS)': [2, 5, 5, 20],
    'Identity Broker Disk (VCFMS)': [20, 60, 60, 120],
    'Software Depot CPU': [2, 2, 3, 4],
    'Software Depot RAM': [2, 2, 3, 6],
    'Software Depot Disk': [1500, 1500, 1500, 1500],
    'Salt CPU': [0.7, 0.7, 1.5, 2.5],
    'Salt RAM': [1.5, 1.5, 2.5, 4.5],
    'Salt Raas CPU': [1.15, 1.15, 4.5, 7],
    'Salt Raas RAM': [2.6, 2.6, 6, 9],
    'Telemetry Acceptor CPU': [0.5, 0.5, 1, 1],
    'Telemetry Acceptor RAM': [2, 2, 3, 6],
    'Fleet LCM CPU': [2, 2.5, 2.5, 2.5],
    'Fleet LCM RAM': [3, 3.5, 3.5, 3.5],
    'SDDC LCM CPU': [2, 2.5, 2.5, 2.5],
    'SDDC LCM RAM': [3, 3.5, 3.5, 3.5],
  };
  const keys = ['SimpleSmall', 'High AvailabilitySmall', 'High AvailabilityMedium', 'High AvailabilityLarge'];
  const out                         = {};
  for (const [table, values] of Object.entries(t)) keys.forEach((k, i) => (out[`9.1.1|${table}|${k}`] = values[i]          ));
  return out;
}

                                 
                                       
                         
                       
                                          
                         
 

/** Every workbook value this module (and the engine) has read, for the layout test. */
export const WORKBOOK_LOOKUPS = new Map                        ();

/**
 * A number from the generated workbook tables. Throws, naming the table and
 * key, when it is missing and is not a listed known gap — a new workbook with
 * a changed layout must fail loudly rather than size on stale numbers.
 */
export function workbookValue(release                                 , table        , key        )         {
  const r = workbookRelease(release);
  const id = `${r}|${table}|${key}`;
  const raw = WORKBOOK.releases[r]?.tables[table]?.[key];
  const bad = BAD_TABLES.has(`${r}|${table}`);
  if (!bad && typeof raw === 'number' && Number.isFinite(raw)) {
    WORKBOOK_LOOKUPS.set(id, { release: r, table, key, from: 'workbook', value: raw });
    return raw;
  }
  const gap = WORKBOOK_KNOWN_GAPS[id];
  if (gap !== undefined) {
    WORKBOOK_LOOKUPS.set(id, { release: r, table, key, from: 'known-gap', value: gap });
    return gap;
  }
  throw new Error(
    `${WORKBOOK_NAMES[r]}: no numeric value for "${table}" › "${key}" in workbook-data.ts. The workbook layout may have changed; re-run npm run vcf:workbook and update sizing-data.ts.`,
  );
}

/**
 * Generated tables whose values are known to be wrong (not merely missing).
 * 9.1.1 "Log Managment CPU Per Replica" holds the RAM row (16/32/64); it is
 * trusted again once the generator also emits the RAM table.
 */
const BAD_TABLES = new Set        (
  WORKBOOK.releases['9.1.1']?.tables['Log Managment RAM Per Replica'] ? [] : ['9.1.1|Log Managment CPU Per Replica'],
);

function wbEntry(release                                 , cpu                  , ram                  , disk                  , note         )             {
  return {
    vcpu: workbookValue(release, cpu[0], cpu[1]),
    ramGib: workbookValue(release, ram[0], ram[1]),
    diskGib: workbookValue(release, disk[0], disk[1]),
    verification: 'V-DOC',
    basis: 'published',
    ...workbookSource(release),
    ...(note ? { note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * Deployment profile. VCF 9.1 offers "Simple" (single-node management
 * components) or "High Availability" at Small / Medium / Large scale. HA-Small
 * exists only from 9.1.1 (the 9.1 workbook offers HA at Medium and Large only).
 */
                                                                                 

export const DEPLOYMENT_PROFILE_LABELS                                    = {
  simple: 'Simple (non-HA)',
  'ha-small': 'High Availability — Small',
  'ha-medium': 'High Availability — Medium',
  'ha-large': 'High Availability — Large',
};

/** The profiles a release offers. [V-DOC S1b and the 9.1 workbook's size list] */
export function profilesForRelease(release            )                               {
  return release === '9.1.0' ? ['simple', 'ha-medium', 'ha-large'] : ['simple', 'ha-small', 'ha-medium', 'ha-large'];
}

export function isHaProfile(profile                   )          {
  return profile !== 'simple';
}

/** First or additional VCF instance in a fleet. */
                                                  

/** The installer's size for a profile: Simple is always Small. */
                                                       

export function profileSize(profile                   )              {
  return profile === 'ha-medium' ? 'medium' : profile === 'ha-large' ? 'large' : 'small';
}

const CAP                                                    = { small: 'Small', medium: 'Medium', large: 'Large' };

/** The workbook's "<model><size>" key, e.g. "High AvailabilityMedium". */
function modelSizeKey(profile                   )         {
  return `${isHaProfile(profile) ? 'High Availability' : 'Simple'}${CAP[profileSize(profile)]}`;
}

// ---------------------------------------------------------------------------
// Per-appliance sizing (workbook)
// ---------------------------------------------------------------------------

const REF = DEFAULT_VCF_RELEASE;

                                                                           

export const VCENTER_SIZE_ORDER                         = ['tiny', 'small', 'medium', 'large', 'xlarge'];

const VC_KEY                              = { tiny: 'Tiny', small: 'Small', medium: 'Medium', large: 'Large', xlarge: 'XLarge' };

                                                                
const VC_STORAGE_KEY                                     = { default: 'Default', large: 'Large', xlarge: 'XLarge' };

/** vCenter appliance for a release, size and storage size. [V-DOC workbook; matches S8/S9] */
export function vcenterEntry(release            , size             , storage                     = 'default')             {
  return wbEntry(release, ['vCenter Appliance CPU', VC_KEY[size]], ['vCenter Appliance RAM', VC_KEY[size]], ['vCenter Disk', `${VC_KEY[size]}${VC_STORAGE_KEY[storage]}`]);
}

/** vCenter 9.1 appliance, default storage size. */
export const VCENTER_SIZES                                  = {
  tiny: vcenterEntry(REF, 'tiny'),
  small: vcenterEntry(REF, 'small'),
  medium: vcenterEntry(REF, 'medium'),
  large: vcenterEntry(REF, 'large'),
  xlarge: vcenterEntry(REF, 'xlarge'),
};

/** vCenter disk (GB) by appliance size and storage size. */
export const VCENTER_DISK_GIB                                                          = Object.fromEntries(
  VCENTER_SIZE_ORDER.map((s) => [
    s,
    {
      default: workbookValue(REF, 'vCenter Disk', `${VC_KEY[s]}Default`),
      large: workbookValue(REF, 'vCenter Disk', `${VC_KEY[s]}Large`),
      xlarge: workbookValue(REF, 'vCenter Disk', `${VC_KEY[s]}XLarge`),
    },
  ]),
)                                                           ;

/**
 * vCenter host-count / VM-count ceilings per size. [V-DOC S8; the workbook's
 * "vCenter Size | Supported Limits" says the same, as text]
 */
export const VCENTER_CAPACITY                                                      = {
  tiny: { hosts: 10, vms: 100 },
  small: { hosts: 100, vms: 1000 },
  medium: { hosts: 400, vms: 4000 },
  large: { hosts: 1000, vms: 10000 },
  xlarge: { hosts: 2000, vms: 35000 },
};

/** The smallest vCenter that manages this many hosts and VMs, or undefined past X-Large. */
export function vcenterSizeFor(hosts        , vms        )                          {
  return VCENTER_SIZE_ORDER.find((s) => VCENTER_CAPACITY[s].hosts >= hosts && VCENTER_CAPACITY[s].vms >= vms);
}

                                                                                
const NSX_KEY                                 = { xsmall: 'Extra_Small', small: 'Small', medium: 'Medium', large: 'Large', xlarge: 'XLarge' };

export function nsxManagerEntry(release            , size                )             {
  return wbEntry(release, ['NSX-T Manager CPU', NSX_KEY[size]], ['NSX-T Manager RAM', NSX_KEY[size]], ['NSX-T Manager Disk', NSX_KEY[size]]);
}

/**
 * NSX Manager form factors. `SddcNsxtSpec.nsxtManagerSize` accepts only
 * medium | large | xlarge. [V-API] Sizes: workbook.
 */
export const NSX_MANAGER_SIZES                                     = {
  xsmall: nsxManagerEntry(REF, 'xsmall'),
  small: nsxManagerEntry(REF, 'small'),
  medium: nsxManagerEntry(REF, 'medium'),
  large: nsxManagerEntry(REF, 'large'),
  xlarge: nsxManagerEntry(REF, 'xlarge'),
};

/**
 * What an NSX Manager size manages. [V-DOC workbook "NSX Size | Supported
 * Limits": X-Small Cloud Service Manager only, Small PoC only]
 */
export const NSX_MANAGER_CAPACITY                                                                       = {
  medium: { hosts: 128, clusters: 5 },
  large: { hosts: 1024, clusters: 256 },
  xlarge: { hosts: 2048, clusters: 512 },
};

/** The smallest bring-up NSX Manager size for a domain's hosts and clusters. */
export function nsxManagerSizeFor(hosts        , clusters = 1)                             {
  return (['medium', 'large', 'xlarge']         ).find((s) => {
    const c = NSX_MANAGER_CAPACITY[s];
    return c !== undefined && c.hosts >= hosts && c.clusters >= clusters;
  });
}

/** Sizes the VCF Installer will actually accept for bring-up. [V-API] */
export const NSX_MANAGER_BRINGUP_SIZES = ['medium', 'large', 'xlarge']         ;

                                                                  
const EDGE_KEY                              = { small: 'NSX Edge Small', medium: 'NSX Edge Medium', large: 'NSX Edge Large', xlarge: 'NSX Edge XLarge' };

function edge(size             , note         )             {
  return {
    ...wbEntry(REF, ['NSX-T Edge CPU', EDGE_KEY[size]], ['NSX-T Edge RAM', EDGE_KEY[size]], ['NSX-T Edge Disk', EDGE_KEY[size]]),
    ...(note ? { note } : {}),
  };
}

/** NSX Edge VM form factors. [V-DOC workbook; matches S10] */
export const NSX_EDGE_SIZES                                  = {
  small: edge('small', 'Lab / PoC only: L7 rules are not realised on a Tier-1 gateway on a small edge (S10)'),
  medium: edge('medium'),
  large: edge('large'),
  xlarge: edge('xlarge'),
};

/** Minimum Edge nodes per centralized Edge cluster. [V-DOC] */
export const NSX_EDGE_CLUSTER_MIN_NODES = 2;
/** Maximum Edge nodes per cluster. [V-DOC] */
export const NSX_EDGE_CLUSTER_MAX_NODES = 10;
/** Edge TEP addresses per edge node (one per fast-path uplink). [derived — common 2-uplink edge design] */
export const EDGE_TEP_IPS_PER_NODE = 2;

/** SDDC Manager has a single size. [V-DOC workbook] */
export const SDDC_MANAGER             = wbEntry(REF, ['SDDC Manager', 'CPU'], ['SDDC Manager', 'RAM'], ['SDDC Manager', 'Disk']);

                                                                         
const OPS_KEY                          = { xsmall: 'Extra Small', small: 'Small', medium: 'Medium', large: 'Large', xlarge: 'Extra Large' };

const OPS_CAPACITY                                                                                 = {
  xsmall: { maxRamGib: 16, maxObjects: 700, maxMetrics: 140_000 },
  small: { maxRamGib: 32, maxObjects: 10_000, maxMetrics: 1_600_000 },
  medium: { maxRamGib: 64, maxObjects: 30_000, maxMetrics: 5_000_000 },
  large: { maxRamGib: 96, maxObjects: 44_000, maxMetrics: 8_000_000 },
  xlarge: { maxRamGib: 256, maxObjects: 100_000, maxMetrics: 20_000_000 },
};

export function opsEntry(release            , size         )             {
  return wbEntry(release, ['VCF Operations CPU', OPS_KEY[size]], ['VCF Operations RAM', OPS_KEY[size]], ['VCF Operations Disk', OPS_KEY[size]], 'Object and metric ceilings from KB 397782 (9.0)');
}

/**
 * VCF Operations node sizing. `VcfOperationsSpec.applianceSize`. vCPU, RAM and
 * disk from the workbook; object ceilings from KB 397782 (9.0).
 */
export const OPS_SIZES         
          
                                                                                                       
  = Object.fromEntries(
  (Object.keys(OPS_KEY)             ).map((s) => [s, { ...opsEntry(REF, s), ...OPS_CAPACITY[s] }]),
)                                                                                                                          ;

/** VCF Operations cluster ceilings. [V-DOC] KB 397782 (9.0) */
export const OPS_CLUSTER_LIMITS         
                                          
                                                              
  = {
  small: { maxNodes: 2, maxObjects: 12_000, maxMetrics: 2_800_000 },
  medium: { maxNodes: 8, maxObjects: 136_000, maxMetrics: 32_000_000 },
  large: { maxNodes: 16, maxObjects: 576_000, maxMetrics: 81_600_000 },
  xlarge: { maxNodes: 12, maxObjects: 1_056_000, maxMetrics: 126_000_000 },
};

                                                    

/** The workbook's key: 9.1.1 names "Standard"; the 9.1 workbook keys it by profile size ("Medium" / "Large"). */
function proxyKey(release            , size                  )         {
  if (size === 'small') return 'Small';
  return workbookRelease(release) === '9.1' ? 'Medium' : 'Standard';
}

export function opsCollectorEntry(release            , size                  )             {
  const k = proxyKey(release, size);
  return wbEntry(release, ['VCF Operations Proxy CPU', k], ['VCF Operations Proxy RAM', k], ['VCF Operations Proxy Disk', k]);
}

/**
 * VCF Operations cloud proxy: Small 4/16, Standard 8/48 (workbook = S13).
 * Object ceilings from KB 397782 (9.0).
 */
export const OPS_COLLECTOR_SIZES         
                   
                                                                           
  = {
  small: { ...opsCollectorEntry(REF, 'small'), maxObjects: 16_000, maxMetrics: 2_400_000 },
  standard: { ...opsCollectorEntry(REF, 'standard'), maxObjects: 80_000, maxMetrics: 12_000_000 },
};

                                                          
const AUTO_KEY                                 = { small: 'Small', medium: 'Medium', large: 'Large' };

export function automationNodeEntry(release            , size                )                                                {
  const e = wbEntry(release, ['VCF Automation CPU', AUTO_KEY[size]], ['VCF Automation RAM', AUTO_KEY[size]], ['VCF Automation Disk', AUTO_KEY[size]], 'Per node');
  return { ...e, perNodeVcpu: e.vcpu };
}

/** One VCF Automation node, by size. [V-DOC workbook] */
export const AUTOMATION_NODE_SIZES                                                                        = {
  small: automationNodeEntry(REF, 'small'),
  medium: automationNodeEntry(REF, 'medium'),
  large: automationNodeEntry(REF, 'large'),
};

/**
 * The Automation each profile's total contains: the profile's size, 1 node for
 * Simple and HA-Small, 3 for HA-Medium and HA-Large. [V-DOC workbook]
 *
 * S1 (TechDocs) labels HA-Small "1 × Medium", but its own HA-Small total
 * (8422 GB) only adds up with a Small node (600 GB); the workbook's Small is used.
 */
export const PROFILE_AUTOMATION                                                                                      = {
  simple: { size: 'small', nodes: 1 },
  'ha-small': { size: 'small', nodes: 1 },
  'ha-medium': { size: 'medium', nodes: 3 },
  'ha-large': { size: 'large', nodes: 3 },
};

/** The 9.1.0 workbook runs 3 Automation nodes for every HA profile, 1 for Simple. */
export function profileAutomation(release            , profile                   )                                                           {
  if (release === '9.1.0') return { size: profileSize(profile), nodes: isHaProfile(profile) ? 3 : 1 };
  return PROFILE_AUTOMATION[profile];
}

export function automationFootprint(size                , nodes        )            {
  return scaleFootprint(footprintOf(AUTOMATION_NODE_SIZES[size]), nodes);
}

/** @deprecated Per-node sizes times the node count. Use AUTOMATION_NODE_SIZES and PROFILE_AUTOMATION. */
export const AUTOMATION_SIZES                                                                                                = {
  small: { ...AUTOMATION_NODE_SIZES.small, nodes: 1 },
  medium: { ...AUTOMATION_NODE_SIZES.medium, ...automationFootprint('medium', 3), nodes: 3 },
  large: { ...AUTOMATION_NODE_SIZES.large, ...automationFootprint('large', 3), nodes: 3 },
};

/** The smallest VCF Automation node's vCPU. Use AUTOMATION_NODE_SIZES[size].perNodeVcpu per size. */
export const AUTOMATION_MIN_NODE_VCPU = AUTOMATION_NODE_SIZES.small.vcpu;

/**
 * Centralized License Server: 2 vCPU / 4 GB / 12 GB. The workbook has no table
 * for it; the figures are the literals in its Management Domain Sizing formula.
 * TechDocs (S11) says 8 GB disk; the release-specific workbook's 12 GB is used
 * (and is what makes the published S1 disk totals add up).
 */
export const LICENSE_SERVER             = {
  vcpu: 2,
  ramGib: 4,
  diskGib: 12,
  verification: 'V-DOC',
  basis: 'published',
  ...workbookSource(REF, 'Management Domain Sizing (License Server formula)'),
  note: 'TechDocs License Server Overview (S11) gives 8 GB disk',
};

/** vSphere Replication (VRMS) and Protection and Recovery appliance ("SRM") sizes. [V-DOC workbook] */
                                                   
const LIGHT                                  = { light: 'Light', standard: 'Standard' };
export const VSPHERE_REPLICATION_SIZES                                      = {
  light: wbEntry(REF, ['VRMS CPU', LIGHT.light], ['VRMS RAM', LIGHT.light], ['VRMS Disk', LIGHT.light]),
  standard: wbEntry(REF, ['VRMS CPU', LIGHT.standard], ['VRMS RAM', LIGHT.standard], ['VRMS Disk', LIGHT.standard]),
};
export const PROTECTION_RECOVERY_SIZES                                      = {
  light: wbEntry(REF, ['SRM CPU', LIGHT.light], ['SRM RAM', LIGHT.light], ['SRM Disk', LIGHT.light]),
  standard: wbEntry(REF, ['SRM CPU', LIGHT.standard], ['SRM RAM', LIGHT.standard], ['SRM Disk', LIGHT.standard]),
};

// ---------------------------------------------------------------------------
// VCF management services (VCFMS) — the workbook's own model
// ---------------------------------------------------------------------------

/** VCFMS control-plane node by profile size. [V-DOC workbook] */
export function vcfmsControlNode(release            , size             )            {
  return {
    vcpu: workbookValue(release, 'VCFMS Control Node CPU', CAP[size]),
    ramGib: workbookValue(release, 'VCFMS Control Node RAM', CAP[size]),
    diskGib: workbookValue(release, 'VCFMS Control Node Disk', CAP[size]),
  };
}

/** Kept for callers: the 9.1.1 control node per size. */
export const VCFMS_CONTROL_NODE                                 = {
  small: vcfmsControlNode('9.1.1', 'small'),
  medium: vcfmsControlNode('9.1.1', 'medium'),
  large: vcfmsControlNode('9.1.1', 'large'),
};

function instanceKey(role              )         {
  return role === 'first' ? 'First Instance' : 'Additional Instance';
}

/** 9.1.1 worker node (vCPU/RAM each) and the workers' disk in total. [V-DOC 9.1.1 workbook] */
export function vcfmsWorker911(role              , profile                   )            {
  const k = `${instanceKey(role)}${modelSizeKey(profile)}`;
  return {
    vcpu: workbookValue('9.1.1', 'VCFMS Worker Node CPU', k),
    ramGib: workbookValue('9.1.1', 'VCFMS Worker Node RAM', k),
    diskGib: workbookValue('9.1.1', 'VCFMS Worker Node Disk', k),
  };
}

export const VCFMS_WORKER_911                                                             = {
  first: {
    simple: vcfmsWorker911('first', 'simple'),
    'ha-small': vcfmsWorker911('first', 'ha-small'),
    'ha-medium': vcfmsWorker911('first', 'ha-medium'),
    'ha-large': vcfmsWorker911('first', 'ha-large'),
  },
  additional: {
    simple: vcfmsWorker911('additional', 'simple'),
    'ha-small': vcfmsWorker911('additional', 'ha-small'),
    'ha-medium': vcfmsWorker911('additional', 'ha-medium'),
    'ha-large': vcfmsWorker911('additional', 'ha-large'),
  },
};

                                                                                                                  
const SERVICE_TABLE                             = {
  identityBroker: 'Identity Broker',
  softwareDepot: 'Software Depot',
  sddcLcm: 'SDDC LCM',
  salt: 'Salt',
  saltRaas: 'Salt Raas',
  telemetry: 'Telemetry Acceptor',
  fleetLcm: 'Fleet LCM',
};

/** A 9.1.1 service that runs on the VCFMS workers. [V-DOC 9.1.1 workbook] */
export function vcfmsService911(service            , profile                   )                                                    {
  const k = modelSizeKey(profile);
  // The appliance-style Identity Broker table shares the name; the VCFMS one is kept apart.
  const base = service === 'identityBroker' ? 'Identity Broker' : SERVICE_TABLE[service];
  const suffix = service === 'identityBroker' ? ' (VCFMS)' : '';
  const hasDisk = service === 'identityBroker' || service === 'softwareDepot';
  return {
    vcpu: workbookValue('9.1.1', `${base} CPU${suffix}`, k),
    ramGib: workbookValue('9.1.1', `${base} RAM${suffix}`, k),
    diskGib: hasDisk ? workbookValue('9.1.1', `${base} Disk${suffix}`, k) : 0,
  };
}

/** Real-time metrics on the VCFMS workers (per profile), 9.1.1. [V-DOC 9.1.1 workbook, "VODAP"] */
export function realTimeMetrics911(profile                   )                                   {
  const k = modelSizeKey(profile);
  return { vcpu: workbookValue('9.1.1', 'VODAP CPU Per Replica', k), ramGib: workbookValue('9.1.1', 'VODAP RAM Per Replica', k) };
}

/** Real-time metrics disk: a literal in the workbook formula. */
export const REAL_TIME_METRICS_DISK_GIB = 205;

/** Log management per replica, vCPU and RAM (9.1.1 workbook; the 9.1 workbook sizes it as workers). */
export function logReplicaCpuRam(size                              )                                   {
  return {
    vcpu: workbookValue('9.1.1', 'Log Managment CPU Per Replica', CAP[size]),
    ramGib: workbookValue('9.1.1', 'Log Managment RAM Per Replica', CAP[size]),
  };
}

/** Log management disk per replica. [V-DOC workbook "vRLI Disk"; S13 gives a 500 GB–9 TB range] */
export function logReplicaDiskGib(release            , size                              )         {
  return workbookValue(release, 'vRLI Disk', CAP[size]);
}
export const LOG_MANAGEMENT_REPLICA_DISK_GIB = logReplicaDiskGib(REF, 'small');

/**
 * 9.1.0 worker counts, extra disk and real-time-metrics workers: literals in
 * the 9.1 workbook's formulas (no lookup table). First-instance HA counts come
 * from its "VCFMS Worker Node" table.
 */
export const VCFMS_910_FORMULA = {
  simpleFirstWorkers: 3,
  additionalWorkers: { small: 2, medium: 2, large: 3 },
  extraDisk: { first: { small: 2600, medium: 3000, large: 3702 }, additional: { small: 800, medium: 1002, large: 1200 } },
  realTimeMetricsWorkers: { small: 2, medium: 2, large: 3 },
}         ;

/** 9.1.1 headroom the workbook adds when counting workers: 20% RAM, 9% CPU. */
export const VCFMS_911_HEADROOM = { ram: 1.2, cpu: 1.09 }         ;

                            
                                          
                                
                                                  
                                     
                                                                                    
                                   
                                    
 

                              
                                
                              
                           
                                                                 
                             
                                                                     
                            
 

/** Excel's ROUNDUP(x, 0) for positive values, immune to float noise. */
function roundUp(x        )         {
  return Math.ceil(Math.round(x * 1e9) / 1e9);
}

/**
 * VCF management services as the workbook sizes them: control nodes by
 * profile, and workers — a fixed count in 9.1.0, and in 9.1.1 a count the
 * workbook computes from the services the workers carry (plus 20% RAM / 9% CPU
 * headroom) and any Day-N load (log management, real-time metrics).
 */
export function vcfmsFootprint(release            , profile                   , role               = 'first', dayN            = {})              {
  const size = profileSize(profile);
  const controlNodes = workbookValue(release, 'Deployment Size Control Node', isHaProfile(profile) ? 'High Availability' : 'Simple');
  const control = scaleFootprint(vcfmsControlNode(release, size), controlNodes);
  const logSize = dayN.logSize ?? size;
  const logReplicas = dayN.logReplicas ?? 0;

  if (release === '9.1.0') {
    const worker            = {
      vcpu: workbookValue(release, 'VCFMS Worker Node CPU', CAP[size]),
      ramGib: workbookValue(release, 'VCFMS Worker Node RAM', CAP[size]),
      diskGib: workbookValue(release, 'VCFMS Worker Node Disk', CAP[size]),
    };
    let workers =
      role === 'additional'
        ? VCFMS_910_FORMULA.additionalWorkers[size]
        : profile === 'simple'
          ? VCFMS_910_FORMULA.simpleFirstWorkers
          : workbookValue(release, 'VCFMS Worker Node', CAP[size]);
    let disk = worker.diskGib * workers + VCFMS_910_FORMULA.extraDisk[role][size];
    if (logReplicas > 0) {
      workers += logSize === 'large' ? 2 * logReplicas : logReplicas;
      disk += logReplicas * logReplicaDiskGib(release, logSize);
    }
    if (dayN.realTimeMetrics) {
      workers += VCFMS_910_FORMULA.realTimeMetricsWorkers[size];
      disk += REAL_TIME_METRICS_DISK_GIB;
    }
    const total = addFootprints(control, { vcpu: worker.vcpu * workers, ramGib: worker.ramGib * workers, diskGib: disk });
    return { controlNodes, control, workers, worker, total };
  }

  const worker = vcfmsWorker911(role, profile);
  const day0Keys                        =
    role === 'first' ? ['identityBroker', 'softwareDepot', 'sddcLcm', 'salt', 'saltRaas', 'telemetry', 'fleetLcm'] : ['sddcLcm', 'salt', 'telemetry'];
  const day0 = day0Keys.reduce(
    (a, k) => {
      const s = vcfmsService911(k, profile);
      return { vcpu: a.vcpu + s.vcpu, ramGib: a.ramGib + s.ramGib };
    },
    { vcpu: 0, ramGib: 0 },
  );
  let nCpu = 0;
  let nRam = 0;
  let nDisk = 0;
  if (logReplicas > 0) {
    const r = logReplicaCpuRam(logSize);
    nCpu += logReplicas * r.vcpu;
    nRam += logReplicas * r.ramGib;
    nDisk += logReplicas * logReplicaDiskGib(release, logSize);
  }
  if (dayN.realTimeMetrics) {
    const m = realTimeMetrics911(profile);
    nCpu += m.vcpu;
    nRam += m.ramGib;
    nDisk += REAL_TIME_METRICS_DISK_GIB;
  }
  for (const [on, key] of [
    [dayN.softwareDepot, 'softwareDepot'],
    [dayN.identityBroker, 'identityBroker'],
  ]         ) {
    if (role === 'additional' && on) {
      const s = vcfmsService911(key, profile);
      nCpu += s.vcpu;
      nRam += s.ramGib;
      nDisk += s.diskGib;
    }
  }
  const key = `${role}-${profile}`;
  const dayNOn = logReplicas > 0 || dayN.realTimeMetrics === true;
  const ramNeed = roundUp((nRam + day0.ramGib) * VCFMS_911_HEADROOM.ram);
  const cpuNeed = roundUp((nCpu + day0.vcpu) * VCFMS_911_HEADROOM.cpu);
  // The workbook's own adjustments (Static Reference Tables, VCFMS Calculations).
  const byRam = roundUp(ramNeed / worker.ramGib) + (key === 'additional-simple' || key === 'first-ha-medium' ? 0 : 1);
  const byCpu =
    roundUp(cpuNeed / worker.vcpu) +
    (key === 'additional-simple' || (!dayNOn && key === 'additional-ha-medium') || (dayNOn && key === 'first-ha-medium') ? 0 : 1);
  const workers = Math.max(byRam, byCpu);
  const total = addFootprints(control, { vcpu: worker.vcpu * workers, ramGib: worker.ramGib * workers, diskGib: worker.diskGib + nDisk });
  return { controlNodes, control, workers, worker: { vcpu: worker.vcpu, ramGib: worker.ramGib, diskGib: worker.diskGib / Math.max(1, workers) }, total };
}

function vcfmsEntry(release            , profile                   , role              )             {
  const v = vcfmsFootprint(release, profile, role);
  return {
    ...v.total,
    verification: 'V-DOC',
    basis: 'published',
    ...workbookSource(release),
    note: `${v.controlNodes} control node(s) ${v.control.vcpu / v.controlNodes}/${v.control.ramGib / v.controlNodes} + ${v.workers} worker(s) ${v.worker.vcpu}/${v.worker.ramGib}`,
  };
}

/** VCFMS footprint by release, Simple and HA (HA = HA-Medium). Use `vcfmsFootprint` for every size. */
export const VCFMS_FOOTPRINT                                                          = {
  '9.1.0': { simple: vcfmsEntry('9.1.0', 'simple', 'first'), ha: vcfmsEntry('9.1.0', 'ha-medium', 'first') },
  '9.1.1': { simple: vcfmsEntry('9.1.1', 'simple', 'first'), ha: vcfmsEntry('9.1.1', 'ha-medium', 'first') },
};

/** VCFMS in a Simple additional instance, 9.1.1. */
export const VCFMS_ADDITIONAL_INSTANCE_911             = vcfmsEntry('9.1.1', 'simple', 'additional');

/** @deprecated 9.1.0 figures; use `VCFMS_FOOTPRINT[release]` or `vcfmsFootprint`. */
export const VCF_MANAGEMENT_SERVICES = VCFMS_FOOTPRINT['9.1.0'];

/** The VCFMS worker 9.1.1 removed from Simple (3 → 2 workers of 12/24). [V-DOC both workbooks] */
export const VCFMS_910_EXTRA_WORKER            = subtractFootprints(
  { ...vcfmsFootprint('9.1.0', 'simple').total, diskGib: 0 },
  { ...vcfmsFootprint('9.1.1', 'simple').total, diskGib: 0 },
);

// ---------------------------------------------------------------------------
// The management plane, as the workbook builds it
// ---------------------------------------------------------------------------

                                 
                        
                         
                                
 

/**
 * The management plane of one instance, appliance by appliance, at the
 * profile's defaults, exactly as the workbook's Management Domain Sizing sheet
 * builds it (VCF Operations, cloud proxy, License Server and VCF Automation
 * included for a first instance; an additional instance has none of the fleet
 * components but its own cloud proxy).
 */
export function workbookManagementPlane(release            , profile                   , role               = 'first')                   {
  const size = profileSize(profile);
  const ha = isHaProfile(profile);
  const out                   = [];
  const push = (name        , nodes        , one           ) => out.push({ name, nodes, footprint: scaleFootprint(footprintOf(one), nodes) });
  push('SDDC Manager', 1, wbEntry(release, ['SDDC Manager', 'CPU'], ['SDDC Manager', 'RAM'], ['SDDC Manager', 'Disk']));
  // Management vCenter: the profile's size, Large storage (X-Large for HA-Large).
  const vcSize              = size === 'small' ? 'small' : size;
  push(`vCenter (${vcSize}, ${size === 'large' ? 'X-Large' : 'Large'} storage)`, 1, vcenterEntry(release, vcSize, size === 'large' ? 'xlarge' : 'large'));
  push(`NSX Manager ${size === 'large' ? 'large' : 'medium'}`, ha ? 3 : 1, nsxManagerEntry(release, size === 'large' ? 'large' : 'medium'));
  const v = vcfmsFootprint(release, profile, role);
  out.push({ name: 'VCF management services control nodes', nodes: v.controlNodes, footprint: v.control });
  out.push({ name: 'VCF management services worker nodes', nodes: v.workers, footprint: subtractFootprints(v.total, v.control) });
  // Cloud proxy: Small for Simple / HA-Small, Standard for HA-Medium and HA-Large.
  push(`Cloud proxy (${size === 'small' ? 'small' : 'standard'})`, 1, opsCollectorEntry(release, size === 'small' ? 'small' : 'standard'));
  if (role === 'first') {
    // VCF Operations: 1 (Simple), 2 (9.1.1 HA-Small) or 3 nodes; HA-Small uses Small in 9.1.1.
    const opsNodes = !ha ? 1 : release === '9.1.1' && profile === 'ha-small' ? 2 : 3;
    const opsSize          = !ha ? 'small' : size === 'large' ? 'large' : release === '9.1.1' && size === 'small' ? 'small' : 'medium';
    push(`VCF Operations ${opsSize}`, opsNodes, opsEntry(release, opsSize));
    push('License Server', 1, LICENSE_SERVER);
    const auto = profileAutomation(release, profile);
    push(`VCF Automation ${auto.size}`, auto.nodes, automationNodeEntry(release, auto.size));
  }
  return out;
}

export function workbookPlaneTotal(release            , profile                   , role               = 'first')            {
  return workbookManagementPlane(release, profile, role).reduce((s, c) => addFootprints(s, c.footprint), ZERO_FOOTPRINT);
}

// ---------------------------------------------------------------------------
// Fleet-level aggregate sizing
// ---------------------------------------------------------------------------

/**
 * The published 9.1.1 fleet table (TechDocs S1), kept for comparison. The
 * 9.1.1 workbook reproduces every figure except two additional-instance disk
 * totals, where S1 is 100 GB lower (Simple 4562 vs 4662, HA-Large 8321 vs 8421).
 */
export const FLEET_TECHDOCS_911                                                             = {
  first: {
    simple: { vcpu: 76, ramGib: 251, diskGib: 7448 },
    'ha-small': { vcpu: 106, ramGib: 335, diskGib: 8422 },
    'ha-medium': { vcpu: 184, ramGib: 656, diskGib: 11445 },
    'ha-large': { vcpu: 298, ramGib: 949, diskGib: 15357 },
  },
  additional: {
    simple: { vcpu: 34, ramGib: 111, diskGib: 4562 },
    'ha-small': { vcpu: 62, ramGib: 187, diskGib: 5462 },
    'ha-medium': { vcpu: 74, ramGib: 244, diskGib: 5813 },
    'ha-large': { vcpu: 120, ramGib: 353, diskGib: 8321 },
  },
};

function fleetRow(release            , profile                   , role              )             {
  const total = workbookPlaneTotal(release, profile, role);
  const s1 = release === '9.1.1' ? FLEET_TECHDOCS_911[role][profile] : undefined;
  const differs = s1 && (s1.vcpu !== total.vcpu || s1.ramGib !== total.ramGib || s1.diskGib !== total.diskGib);
  return {
    ...total,
    verification: 'V-DOC',
    basis: 'published',
    ...workbookSource(release, 'Management Domain Sizing (at the profile defaults)'),
    note: s1
      ? differs
        ? `TechDocs Fleet Sizing Models (S1) gives ${s1.vcpu} vCPU / ${s1.ramGib} GB / ${s1.diskGib} GB; the release's workbook is used`
        : 'Matches TechDocs Fleet Sizing Models (S1)'
      : 'The 9.1.0 fleet sizing page published no totals; this is the 9.1 workbook’s calculation',
  };
}

function fleetTable(release            , role              )                                                 {
  return Object.fromEntries(profilesForRelease(release).map((p) => [p, fleetRow(release, p, role)]));
}

/** First instance, 9.1.1, from the workbook (includes the fleet services and the profile's Automation). */
export const FLEET_FIRST_INSTANCE_911 = fleetTable('9.1.1', 'first')                                         ;
/** Each additional instance, 9.1.1. */
export const FLEET_ADDITIONAL_INSTANCE_911 = fleetTable('9.1.1', 'additional')                                         ;
/** 9.1.0 (no HA-Small), from the 9.1 workbook. */
export const FLEET_FIRST_INSTANCE_910                                                 = fleetTable('9.1.0', 'first');
export const FLEET_ADDITIONAL_INSTANCE_910                                                 = fleetTable('9.1.0', 'additional');

/** @deprecated The 9.1.1 table; use `fleetEntry(release, profile, role)`. */
export const FLEET_FIRST_INSTANCE = FLEET_FIRST_INSTANCE_911;
/** @deprecated The 9.1.1 table; use `fleetEntry(release, profile, role)`. */
export const FLEET_ADDITIONAL_INSTANCE = FLEET_ADDITIONAL_INSTANCE_911;

/** The fleet table row for a release, profile and instance role; undefined when the release lacks the profile. */
export function fleetEntry(release            , profile                   , role              )                         {
  if (release === '9.1.1') {
    return role === 'first' ? FLEET_FIRST_INSTANCE_911[profile] : FLEET_ADDITIONAL_INSTANCE_911[profile];
  }
  return role === 'first' ? FLEET_FIRST_INSTANCE_910[profile] : FLEET_ADDITIONAL_INSTANCE_910[profile];
}

// ---------------------------------------------------------------------------
// Host minimums
// ---------------------------------------------------------------------------

                                                                                        

/** Management domain, or a VI workload domain. */
                                                   

                              
                         
                                      
                          
                              
                         
                         
                                                                        
                                
 

function minimum(hosts        , url        , source        , note         , recommended         )              {
  return {
    hosts,
    verification: 'V-DOC',
    basis: 'published',
    source,
    sourceUrl: url,
    ...(note ? { note } : {}),
    ...(recommended ? { recommended } : {}),
  };
}

/**
 * Host minimums by domain, storage, topology and profile. [V-DOC S4, S5, S6]
 * The deployment path does not change them: a converged cluster needs what a
 * new one does.
 */
export const HOST_MINIMUMS = {
  'management-vsan-simple': minimum(3, SOURCES.singleRack, 'TechDocs: Single-Rack vSphere Cluster Model', 'On 3 hosts vSAN tolerates one failure but cannot rebuild'),
  'management-vsan-ha': minimum(4, SOURCES.singleRack, 'TechDocs: Single-Rack vSphere Cluster Model'),
  'management-external-simple': minimum(2, SOURCES.singleRack, 'TechDocs: Single-Rack vSphere Cluster Model', 'NFS v3 or VMFS on FC'),
  'management-external-ha': minimum(4, SOURCES.singleRack, 'TechDocs: Single-Rack vSphere Cluster Model', 'NFS v3 or VMFS on FC'),
  'management-vsan-stretched-simple': minimum(6, SOURCES.stretched, 'TechDocs: Stretched vSphere Cluster Model', '3 per availability zone plus a witness'),
  'management-vsan-stretched-ha': minimum(8, SOURCES.stretched, 'TechDocs: Stretched vSphere Cluster Model', '4 per availability zone plus a witness'),
  'management-external-stretched-simple': minimum(2, SOURCES.stretched, 'TechDocs: Stretched vSphere Cluster Model', 'NFS/FC stretched: 1 + 1 minimum, 2 + 2 recommended (KB 417356)', 4),
  'management-external-stretched-ha': minimum(4, SOURCES.stretched, 'TechDocs: Stretched vSphere Cluster Model', 'NFS/FC stretched; HA needs 4 hosts'),
  'workload-vsan': minimum(3, SOURCES.singleRack, 'TechDocs: Single-Rack vSphere Cluster Model'),
  'workload-external': minimum(2, SOURCES.singleRack, 'TechDocs: Single-Rack vSphere Cluster Model', 'NFS v3 or VMFS on FC'),
  'workload-vsan-stretched': minimum(6, SOURCES.stretched, 'TechDocs: Stretched vSphere Cluster Model', 'Additional management and workload-domain stretched clusters: 6'),
  'workload-external-stretched': minimum(2, SOURCES.stretched, 'TechDocs: Stretched vSphere Cluster Model', '1 + 1 minimum, 2 + 2 recommended (KB 417356)', 4),
  'workload-two-node': {
    hosts: 2,
    verification: 'C',
    basis: 'unconfirmed',
    source: 'Unconfirmed for VCF 9.1',
    note: 'No 9.1 design page lists a 2-node vSAN cluster for a workload domain',
  },
}                                               ;

/**
 * The 4-host converge-stretched minimum ("2 ESX per AZ plus a witness") the
 * toolkit used to carry. Not in the 9.1.1 release notes, S5 or the workbooks;
 * the engine follows S5 and reports this as unconfirmed.
 */
export const CONVERGE_STRETCHED_UNCONFIRMED              = {
  hosts: 4,
  verification: 'C',
  basis: 'unconfirmed',
  source: 'Unconfirmed claim: 2 ESX per AZ plus a witness (9.1.1)',
  note: 'Not in the 9.1.1 release notes or the Stretched vSphere Cluster Model (6 Simple / 8 HA)',
};

/** @deprecated Use `HOST_MINIMUMS`; kept for callers of the old keys. */
export const MGMT_HOST_MINIMUMS = {
  'greenfield-vsan-single-az': HOST_MINIMUMS['management-vsan-ha'],
  'greenfield-vsan-stretched': HOST_MINIMUMS['management-vsan-stretched-ha'],
  'greenfield-external-storage': HOST_MINIMUMS['management-external-simple'],
  'converge-vsan': HOST_MINIMUMS['management-vsan-simple'],
  'converge-external-storage': HOST_MINIMUMS['management-external-simple'],
  'converge-vsan-stretched': HOST_MINIMUMS['management-vsan-stretched-simple'],
}         ;

/** Share of cluster capacity reserved for host failures: 1/3 = 33%, 1/4 = 25%, 1/2 = 50%. [V-DOC S4] */
export function haReserveFraction(hosts        , failures        )         {
  return hosts > 0 ? Math.min(1, failures / hosts) : 1;
}

/** vSAN ESA requires at least this much RAM per host. [V-DOC S7] */
export const VSAN_ESA_MIN_HOST_RAM_GIB = 128;

/** NIC speed below which only the ESA-AF-0 ReadyNode profile is allowed. [V-DOC S6] */
export const VSAN_ESA_AF0_MAX_NIC_GBPS = 10;

/** Principal storage a NEW management domain can use besides vSAN. [V-DOC — KB 416270] */
export const GREENFIELD_EXTERNAL_STORAGE = ['nfs', 'vmfs-fc']         ;

// ---------------------------------------------------------------------------
// vSAN capacity overhead
// ---------------------------------------------------------------------------

/**
 * Cluster topology. 'two-node' is not a management-domain topology in 9.1
 * (S4, S5 list single-rack, multi-rack and stretched only); the engine flags it
 * there, and marks it unconfirmed for workload domains.
 */
                                                                    

/** Topologies offered for a management domain. */
export const MANAGEMENT_TOPOLOGIES                             = ['standard', 'stretched'];

                                             

/** Explicit vSAN OSA storage policies. ESA uses Auto-RAID in 9.1. */
                                                                                  

                               
                              
                        
                            
                       
                                                                              
                          
                        
                              
                         
 

/** Standard vSAN OSA policies. Standard vSAN rules, not re-fetched for 9.1. */
export const OSA_POLICIES                                                                                         = {
  'raid1-ftt1': { multiplier: 2.0, raid: 'RAID-1 (FTT=1)', minHosts: 3, ftt: 1 },
  'raid5-ftt1': { multiplier: 4 / 3, raid: 'RAID-5 (3+1)', minHosts: 4, ftt: 1 },
  'raid6-ftt2': { multiplier: 1.5, raid: 'RAID-6 (4+2)', minHosts: 6, ftt: 2 },
  'raid1-ftt2': { multiplier: 3.0, raid: 'RAID-1 (FTT=2)', minHosts: 5, ftt: 2 },
};

const OSA_NOTE = 'Standard vSAN OSA policy rules; not re-fetched for 9.1. Auto-RAID is ESA-only.';

/** The OSA policy the engine picks when none is given: RAID-5 from 4 hosts, RAID-1 below. */
export function defaultOsaPolicy(hostsPerSite        )            {
  return hostsPerSite >= 4 ? 'raid5-ftt1' : 'raid1-ftt1';
}

/**
 * Raw-to-usable multiplier.
 *
 * ESA (Auto-RAID, 9.1): RAID-5 2+1 at 3–5 hosts and RAID-6 4+2 from 6, both
 * 1.5x. Stretched: a site mirror on top, 3.0x; fewer than 3 hosts per site is a
 * RAID-1 site mirror with FTT=0 locally, 2.0x. Fewer than 3 hosts in a standard
 * cluster is FTT=0 at 1.0x and not a valid VCF domain cluster. [S16]
 *
 * OSA: no Auto-RAID. RAID-1 2x at 3 hosts or RAID-5 3+1 1.33x from 4, unless a
 * policy is given.
 */
export function raidOverhead(
  topology                 ,
  hostsPerSite        ,
  architecture                   = 'esa',
  osaPolicy            ,
)               {
  if (topology === 'two-node') {
    return {
      multiplier: 2.0,
      raid: 'Host mirroring (2-node)',
      minHosts: 2,
      ftt: 1,
      valid: hostsPerSite >= 2,
      basis: 'unconfirmed',
      note: '2-node vSAN is not a documented VCF 9.1 cluster model',
    };
  }

  if (architecture === 'osa') {
    if (topology === 'stretched') {
      if (hostsPerSite < 3) {
        return { multiplier: 2.0, raid: 'Site mirror + FTT=0', minHosts: 1, ftt: 0, valid: hostsPerSite >= 1, basis: 'unconfirmed', note: OSA_NOTE };
      }
      const policy = OSA_POLICIES[osaPolicy ?? defaultOsaPolicy(hostsPerSite)];
      return {
        multiplier: 2 * policy.multiplier,
        raid: `Site mirror + ${policy.raid}`,
        minHosts: policy.minHosts,
        ftt: policy.ftt,
        valid: hostsPerSite >= policy.minHosts,
        basis: 'unconfirmed',
        note: OSA_NOTE,
      };
    }
    if (hostsPerSite < 3) {
      return { multiplier: 1.0, raid: 'FTT=0 (no protection)', minHosts: 3, ftt: 0, valid: false, basis: 'unconfirmed', note: 'A vSAN cluster under 3 hosts is not a valid VCF domain cluster' };
    }
    const policy = OSA_POLICIES[osaPolicy ?? defaultOsaPolicy(hostsPerSite)];
    return {
      multiplier: policy.multiplier,
      raid: policy.raid,
      minHosts: policy.minHosts,
      ftt: policy.ftt,
      valid: hostsPerSite >= policy.minHosts,
      basis: 'unconfirmed',
      note: OSA_NOTE,
    };
  }

  const esa = { basis: 'published'         , sourceUrl: SOURCES.autoRaid };
  if (topology === 'stretched') {
    if (hostsPerSite < 3) {
      return { multiplier: 2.0, raid: 'Site mirror (RAID-1) + FTT=0', minHosts: 1, ftt: 0, valid: hostsPerSite >= 1, ...esa };
    }
    return hostsPerSite >= 6
      ? { multiplier: 3.0, raid: 'Site mirror + RAID-6', minHosts: 6, ftt: 2, valid: true, ...esa }
      : { multiplier: 3.0, raid: 'Site mirror + RAID-5', minHosts: 3, ftt: 1, valid: true, ...esa };
  }
  if (hostsPerSite < 3) {
    return { multiplier: 1.0, raid: 'FTT=0 (no protection)', minHosts: 3, ftt: 0, valid: false, ...esa, note: 'A vSAN cluster under 3 hosts is not a valid VCF domain cluster' };
  }
  return hostsPerSite >= 6
    ? { multiplier: 1.5, raid: 'RAID-6', minHosts: 6, ftt: 2, valid: true, ...esa }
    : { multiplier: 1.5, raid: 'RAID-5 (2+1)', minHosts: 3, ftt: 1, valid: true, ...esa };
}

/**
 * vSAN reserve model.
 *
 * The engine's default: one reserve, the host(s) held back for failure, and no
 * blanket slack on top (the old 25% counted the rebuild reserve twice).
 *
 * Broadcom's workbook takes a different, more conservative view, and the
 * engine offers it as `vsan.model: 'workbook'`: VM disk plus a swap file equal
 * to VM memory, times the FTT=1 overhead, times (1 + a 30% "Host and Operations
 * Reserve"), times (1 + 10% estimated growth), spread over N-1 hosts. [V-DOC
 * workbook, Management Domain Sizing defaults]
 */
export const VSAN_OPERATIONS_RESERVE_DEFAULT = 0;
export const VSAN_WORKBOOK_HOST_AND_OPERATIONS_RESERVE = 0.3;
export const VSAN_WORKBOOK_STORAGE_GROWTH = 0.1;
export const VSAN_RESERVE_NOTE =
  'Rebuild reserve = the host(s) held back for failure; no operations reserve is added unless you set one. Broadcom’s Planning and Preparation Workbook defaults to a 30% host-and-operations reserve on top of FTT overhead, plus swap and 10% growth, over N-1 hosts (choose the workbook model to follow it).';

/** Default expected dedup/compression ratio: none assumed. */
export const VSAN_DEDUP_RATIO_DEFAULT = 1.0;

/** vSAN witness appliance sizes. Not in the workbooks; unconfirmed for 9.1 (vSAN 8 community figures). */
                                                      
export const VSAN_WITNESS_SIZES                                  = {
  tiny: { vcpu: 2, ramGib: 8, diskGib: 37, verification: 'C', basis: 'unconfirmed', source: 'vSAN 8 witness appliance (community)', note: 'Up to 10 VMs' },
  medium: { vcpu: 2, ramGib: 16, diskGib: 372, verification: 'C', basis: 'unconfirmed', source: 'vSAN 8 witness appliance (community)', note: 'Up to 500 VMs' },
  large: { vcpu: 2, ramGib: 32, diskGib: 1072, verification: 'C', basis: 'unconfirmed', source: 'vSAN 8 witness appliance (community)', note: 'Over 500 VMs' },
};

/** Between availability zones. [V-DOC S5] */
export const STRETCHED_MIN_BANDWIDTH_GBPS = 10;
export const STRETCHED_MAX_RTT_MS = 5;

// ---------------------------------------------------------------------------
// Memory tiering (NVMe)
// ---------------------------------------------------------------------------

/** NVMe tier as a fraction of DRAM: default 1:1, up to 1:4. [V-DOC S22] */
export const MEMORY_TIERING_DEFAULT_RATIO = 1;
export const MEMORY_TIERING_MAX_RATIO = 4;
/** Active memory should stay within half of DRAM. [V-DOC S22] */
export const MEMORY_TIERING_MAX_ACTIVE_FRACTION = 0.5;
/** From 9.1.1, HA admission control tracks DRAM separately. [V-DOC S22b] */
export const MEMORY_TIERING_HA_VERSION = '9.1.1.0';

// ---------------------------------------------------------------------------
// Add-on management components (P2)
// ---------------------------------------------------------------------------

                                                          

/**
 * Log management (a VCFMS component in 9.1). Per-replica vCPU/RAM and ingest:
 * S13 = the 9.1.1 workbook. The workers that carry the replicas are sized by
 * `vcfmsFootprint` with the replicas as Day-N load — the workbook's model; the
 * `worker` figures here are the S13 design's, kept for reference.
 */
export const LOG_MANAGEMENT_REPLICAS         
                 
   
                                
                         
                                 
                                 
                               
                                       
                            
                                
   
  = {
  small: { replica: { ...logReplicaCpuRam('small'), diskGib: logReplicaDiskGib(REF, 'small') }, eps: 20_000, minReplicas: 1, maxReplicas: 19, worker: { vcpu: 12, ramGib: 24, diskGib: 0 }, workersPerReplica: 1, vip: { vcpu: 4, ramGib: 2, diskGib: 0 }, workerBasis: 'published' },
  medium: { replica: { ...logReplicaCpuRam('medium'), diskGib: logReplicaDiskGib(REF, 'medium') }, eps: 40_000, minReplicas: 3, maxReplicas: 19, worker: { vcpu: 24, ramGib: 48, diskGib: 0 }, workersPerReplica: 1, vip: { vcpu: 4, ramGib: 2, diskGib: 0 }, workerBasis: 'published' },
  large: { replica: { ...logReplicaCpuRam('large'), diskGib: logReplicaDiskGib(REF, 'large') }, eps: 60_000, minReplicas: 3, maxReplicas: 19, worker: { vcpu: 24, ramGib: 48, diskGib: 0 }, workersPerReplica: 2, vip: { vcpu: 6, ramGib: 4, diskGib: 0 }, workerBasis: 'published' },
};
/** Disk per replica: 575 GB in the workbook; S13's design range is 500 GB–9 TB. */
export const LOG_MANAGEMENT_DISK_PER_REPLICA_GIB = { min: LOG_MANAGEMENT_REPLICA_DISK_GIB, max: 9000 }         ;
/**
 * Addresses: 6 base plus 1 per small/medium replica or 2 per large (S13); S15
 * says 2 per additional replica. The higher figure is used.
 */
export const LOG_MANAGEMENT_BASE_IPS = 6;
export const LOG_MANAGEMENT_IPS_PER_REPLICA = 2;

/** Real-time metrics: 6 VCFMS addresses (S15). Compute: `realTimeMetrics911` / 9.1.0 workers. */
export const REAL_TIME_METRICS_IPS = 6;

/** VCF Operations for Networks sizes. XL and XXL exist from the 9.1.1 workbook. */
                                                                                  
const OPSNET_KEY_911                                  = { small: 'Small', medium: 'Medium', large: 'Large', xlarge: 'XL', xxlarge: 'XXL' };
const OPSNET_COLLECTOR_KEY_910                                  = { small: 'Small', medium: 'Medium', large: 'Large', xlarge: 'Extra Large', xxlarge: 'Extra Extra Large' };

/** VCF Operations for Networks platform node, per release. [V-DOC workbook; 100% reservation per S14] */
export function opsNetworksPlatform(release            , size                 )                         {
  const k = OPSNET_KEY_911[size];
  if (workbookRelease(release) === '9.1' && (size === 'xlarge' || size === 'xxlarge')) return undefined;
  return wbEntry(release, ['VCF Operations for networks CPU', k], ['VCF Operations for networks RAM', k], ['VCF Operations for networks DISK', k], '100% CPU and memory reservation (S14)');
}

/** VCF Operations for Networks collector, per release. [V-DOC workbook] */
export function opsNetworksCollector(release            , size                 )             {
  const k = workbookRelease(release) === '9.1' ? OPSNET_COLLECTOR_KEY_910[size] : OPSNET_KEY_911[size];
  return wbEntry(release, ['VCF Operations for networks - Collector CPU', k], ['VCF Operations for networks - Collector RAM', k], ['VCF Operations for networks - Collecter DISK', k]);
}

/**
 * Platform node sizes (9.1.1 workbook). S14 gives core ranges (Medium 8–10,
 * Large 12–15, X-Large 16–20); the workbook's figures are the bottom of each.
 */
export const OPS_NETWORKS_PLATFORM                                      = Object.fromEntries(
  (Object.keys(OPSNET_KEY_911)                     ).map((s) => [s, opsNetworksPlatform(REF, s)              ]),
)                                       ;

export const OPS_NETWORKS_COLLECTOR                                      = Object.fromEntries(
  (Object.keys(OPSNET_KEY_911)                     ).map((s) => [s, opsNetworksCollector(REF, s)]),
)                                       ;

/** A cluster is 3–15 X-Large nodes, needed above 10K VMs or 4M flows. [V-DOC S14] */
export const OPS_NETWORKS_CLUSTER = { minNodes: 3, maxNodes: 15, vmThreshold: 10_000, flowThreshold: 4_000_000 }         ;

/** Avi controller sizes. VCF 9.1 names Small / Large / X-Large (S20, workbook); 'medium' is an Avi 30.1 size only. */
                                                                        
const AVI_KEY                                             = { small: 'Small', large: 'Large', xlarge: 'X-Large' };

export const AVI_CONTROLLER_SIZES                                        = {
  small: wbEntry(REF, ['AVI Load Balancer CPU', 'Small'], ['AVI Load Balancer Ram', 'Small'], ['AVI Load Balancer Disk', 'Small']),
  medium: { vcpu: 10, ramGib: 32, diskGib: 256, verification: 'C', basis: 'unconfirmed', source: 'Avi 30.1 controller sizing', note: 'Not a VCF 9.1 Avi size (Small / Large / X-Large)' },
  large: wbEntry(REF, ['AVI Load Balancer CPU', AVI_KEY.large          ], ['AVI Load Balancer Ram', AVI_KEY.large          ], ['AVI Load Balancer Disk', AVI_KEY.large          ]),
  xlarge: wbEntry(REF, ['AVI Load Balancer CPU', 'X-Large'], ['AVI Load Balancer Ram', 'X-Large'], ['AVI Load Balancer Disk', 'X-Large']),
};

/**
 * Protection and Recovery (the 9.1 name for Live Recovery). Appliance: the
 * workbook's "SRM Standard" (8/24/800, = S19). Scale-out: S19 only (no
 * workbook table).
 */
export const PROTECTION_RECOVERY = {
  appliance: { ...PROTECTION_RECOVERY_SIZES.standard, note: 'The workbook calls it the VMware Live Recovery / SRM appliance; 9.1 name Protection and Recovery' },
  scaleOut: { vcpu: 4, ramGib: 8, diskGib: 110, verification: 'V-DOC', basis: 'published', source: 'TechDocs: Protection and Recovery 9.1 system requirements', sourceUrl: SOURCES.protectionRecovery, note: 'Disk approximately 110 GB; not in the workbook' },
  /** Scale-out appliances are used beyond this many protected VMs, or for fan-in / fan-out. */
  scaleOutAboveVms: 5000,
}                                                                                             ;

                                                                      

function hcx(vcpu        , ramGib        , diskGib        , note         )             {
  return { vcpu, ramGib, diskGib, verification: 'V-DOC', basis: 'published', source: 'TechDocs: HCX system requirements (9.1)', sourceUrl: SOURCES.hcx, ...(note ? { note } : {}) };
}

/**
 * HCX appliances per site pair. The manager (connector) is in the workbook
 * (4/12/65; S18 says 60 GB); the service appliances are S18 only. Storage
 * doubles during upgrades.
 */
export const HCX_APPLIANCES                                   = {
  manager: {
    ...wbEntry(REF, ['Cross-Cloud Mobility - HCX Conn', 'CPU'], ['Cross-Cloud Mobility - HCX Conn', 'RAM'], ['Cross-Cloud Mobility - HCX Conn', 'Disk']),
    note: 'TechDocs HCX system requirements (S18) gives 60 GB disk',
  },
  ix: hcx(8, 6, 6.5),
  ne: hcx(8, 3, 6.5),
  wanopt: hcx(16, 32, 172),
  sgw: hcx(8, 8, 17.5, 'SGW / SDR / SRG'),
};

                                                                              
const SUP_KEY                                 = { tiny: 'Tiny', small: 'Small', medium: 'Medium', large: 'Large', xlarge: 'Xlarge' };

/**
 * Supervisor control plane VM, ×1 (Simple) or ×3 (HA / three-zone). [V-DOC
 * 9.1.1 workbook; S17, S17b.] The workbook gives 48 GB disk and an X-Large
 * 32/64; S17 gives 32 GB and no X-Large.
 */
export const SUPERVISOR_CP_SIZES                                     = Object.fromEntries(
  (Object.keys(SUP_KEY)                    ).map((s) => [
    s,
    {
      ...wbEntry('9.1.1', ['Supervisor CPU', SUP_KEY[s]], ['Supervisor RAM', SUP_KEY[s]], ['Supervisor Disk', SUP_KEY[s]]),
      note: 'TechDocs (S17) gives 32 GB disk',
    },
  ]),
)                                      ;

// ---------------------------------------------------------------------------
// IP and FQDN requirements
// ---------------------------------------------------------------------------

/** VCFMS pool: 12 minimum, 30 recommended. [V-DOC S15] */
export const VCFMS_MIN_IPS = 12;
export const VCFMS_RECOMMENDED_IPS = 30;

/**
 * VCF Automation node pool. TechDocs (S15) says 5 (3 nodes + 2 buffer). The
 * workbooks (9.1 and 9.1.1) disagree with themselves: the Deploy Management
 * Domain sheet's sample range holds 5 addresses ("4 are used for active nodes,
 * and 1 is used when recreating a node during rolling upgrades"), while its IP
 * reference table lists a 6-address range. The toolkit's one rule stays
 * `automationIpCount(version)` in version.ts (5, or 6 from 9.1.0.400).
 */
export const AUTOMATION_IP_COUNT = 5;
/** The 9.1.0.400+ count, per `automationIpCount`. Unconfirmed: see above. */
export const AUTOMATION_IP_COUNT_OBSERVED = 6;

/**
 * Component FQDNs (each an address) for the first instance. [V-DOC S15]
 * Simple: vCenter, NSX node, NSX VIP, SDDC Manager, Operations, cloud proxy,
 * License Server, Automation, Automation runtime, VCFMS fleet components,
 * VCFMS instance components, VCFMS runtime, identity broker = 13.
 * HA: 3 NSX nodes, and Operations primary, replica and data = 17, or 18 with a
 * load balancer.
 */
export const FIRST_INSTANCE_FQDNS = { simple: 13, ha: 17, haWithLoadBalancer: 18 }         ;
/** Additional instance: vCenter, NSX (1 or 3 plus VIP), SDDC Manager, cloud proxy, VCFMS instance, VCFMS runtime. [V-DOC S15b] */
export const ADDITIONAL_INSTANCE_FQDNS = { simple: 6, ha: 8 }         ;

/** Per-host VMkernel addresses: management, vMotion and vSAN (or NFS). */
export const IPS_PER_HOST_BASE = 3;

/** Management + vMotion, plus a storage VMkernel for vSAN or NFS; none for VMFS on FC. */
export function hostVmkernelIps(storage                                             )         {
  return storage === 'vmfs-fc' ? 2 : 3;
}

// ---------------------------------------------------------------------------
// Licensing
// ---------------------------------------------------------------------------

/** Per-core subscription, 16 cores per physical CPU minimum. [V-DOC S12] */
export const LICENSE_MIN_CORES_PER_CPU = 16;
/** VCF Edge: 8 cores per CPU minimum. [V-DOC S12] */
export const LICENSE_MIN_CORES_PER_CPU_EDGE = 8;
/** VCF Edge: at least 8 cores per host, at most 256 cores per site, at least 10 sites. [V-DOC S24] */
export const VCF_EDGE_MIN_CORES_PER_HOST = 8;
export const VCF_EDGE_MAX_CORES_PER_SITE = 256;
export const VCF_EDGE_MIN_SITES = 10;
/** A VCF core subscription includes 1 TiB of vSAN per licensed core. [V-DOC S12b] */
export const VSAN_TIB_PER_CORE = 1;
/** Evaluation period before workloads are blocked. [V-DOC] */
export const LICENSE_EVAL_DAYS = 90;

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** `SddcNetworkSpec.networkType` enum. [V-API] */
export const NETWORK_TYPES = [
  'MANAGEMENT',
  'VM_MANAGEMENT',
  'VMOTION',
  'VSAN',
  'NFS',
  'FLEET_MANAGEMENT',
]         ;

                                                         

/** Default vDS MTU. [V-API] */
export const DEFAULT_MTU = 9000;
/** MTU bounds accepted by the installer. [C] */
export const MTU_MIN = 1280;
export const MTU_MAX = 9190;
/** NSX overlay cannot function below this. [C] */
export const NSX_OVERLAY_MIN_MTU = 1600;

/**
 * `internalClusterCidrIpv4` is restricted to exactly these three blocks and
 * must not collide with anything routable in the environment. [V-API]
 */
export const INTERNAL_CLUSTER_CIDRS_V4 = ['198.18.0.0/15', '240.0.0.0/15', '250.0.0.0/15']         ;

/**
 * Supported internal cluster CIDRs for IPv6, with the spelling variants the API
 * reference lists. `fd00::/111` is the default. [V-API]
 */
export const INTERNAL_CLUSTER_CIDRS_V6 = [
  'fd00::/111',
  'fd00::0/111',
  'fc00::/111',
  'fc00::0/111',
  'fc00::4:0/111',
  'fc00::0004:0/111',
]         ;

/** `DnsSpec.nameservers` accepts at most two entries. [V-API] */
export const MAX_NAMESERVERS = 2;

/** VLAN id bounds. */
export const VLAN_MIN = 0;
export const VLAN_MAX = 4094;

/** Every workbook-derived table, read once at load so the layout test sees every key. */
export function readAllWorkbookKeys()       {
  for (const release of VCF_RELEASES) {
    for (const p of profilesForRelease(release)) {
      for (const role of ['first', 'additional']         ) {
        workbookManagementPlane(release, p, role);
        vcfmsFootprint(release, p, role, { logReplicas: 3, logSize: profileSize(p), realTimeMetrics: true, softwareDepot: true, identityBroker: true });
      }
    }
    for (const s of VCENTER_SIZE_ORDER) for (const st of ['default', 'large', 'xlarge']         ) vcenterEntry(release, s, st);
    for (const s of Object.keys(NSX_KEY)                    ) nsxManagerEntry(release, s);
    for (const s of Object.keys(OPS_KEY)             ) opsEntry(release, s);
    for (const s of ['small', 'standard']         ) opsCollectorEntry(release, s);
    for (const s of ['small', 'medium', 'large']         ) {
      automationNodeEntry(release, s);
      logReplicaDiskGib(release, s);
    }
    for (const s of Object.keys(OPSNET_KEY_911)                     ) {
      opsNetworksPlatform(release, s);
      opsNetworksCollector(release, s);
    }
  }
}
readAllWorkbookKeys();
