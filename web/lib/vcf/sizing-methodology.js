import { WORKBOOK } from './workbook-data.js';
import { SOURCES } from './sizing-data.js';

/** Evidence shipped with the offline calculator, not a claim of live validation. */
export const SIZING_METHODOLOGY = {
  workbookSnapshot: WORKBOOK.fetchedAt,
  workbookPage: WORKBOOK.page,
  releases: Object.fromEntries(Object.entries(WORKBOOK.releases).map(([release, data]) => [release, data.source])),
  rules: [
    { name: 'Management appliances', formula: 'Sum the selected release, deployment profile and instance-role appliance footprints, then add workload-domain management and optional services.', basis: 'Broadcom release workbook tables', source: WORKBOOK.page },
    { name: 'CPU capacity', formula: 'Usable physical cores = (hosts − reserved failures) × sockets × cores/socket. CPU demand ÷ usable cores must fit the selected vCPU:pCPU ratio. SMT threads are not physical cores.', basis: 'Derived capacity arithmetic; target ratio is a site assumption', source: SOURCES.esxDesign },
    { name: 'Memory capacity', formula: 'Usable RAM = (hosts − reserved failures) × RAM/host. Allocated VM RAM plus appliances must fit the selected utilization ceiling. A single active-memory snapshot is not a peak measurement.', basis: 'Derived capacity arithmetic; utilization ceiling is a site assumption', source: SOURCES.esxDesign },
    { name: 'vSAN workbook method', formula: 'Raw required = (logical disks + VM swap) × RAID multiplier × 1.30 × 1.10 ÷ assumed data reduction. Compare with raw disk capacity of surviving hosts. Estate storage growth replaces the built-in 10% only when greater.', basis: 'Workbook planning formula; workload-cluster application is derived', source: WORKBOOK.page },
    { name: 'vSAN raw-capacity method', formula: 'Raw required = logical disks × RAID multiplier ÷ data reduction ÷ (1 − operations reserve). Compare with raw capacity after the selected failure reserve.', basis: 'Derived planning model; reserve and reduction are explicit assumptions', source: SOURCES.autoRaid },
    { name: 'Capacity units and accounting', formula: 'Host disk inputs are raw GiB. VM disk demand is logical capacity. Do not put effective usable capacity into a raw-capacity field or apply protection overhead to already protected physical usage.', basis: 'Broadcom capacity-accounting guidance', source: 'https://blogs.vmware.com/cloud-foundation/2026/05/11/effective-capacity-view-in-vsan-for-vcf-9-1/' },
    { name: 'Host count and resilience', formula: 'Choose the smallest supported cluster satisfying CPU, memory, storage, deployment minimums and failure policy together. A stretched design reserves an availability zone when enabled.', basis: 'Published cluster minimums with derived constraint fitting', source: SOURCES.singleRack },
    { name: 'Final design validation', formula: 'Validate hardware and devices against compatibility and ReadyNode profiles; measure peak CPU, memory, IOPS, latency and network throughput. Capacity fitting alone does not validate performance.', basis: 'Broadcom design guidance', source: 'https://www.vmware.com/docs/vmware-vsan-design-guide' },
  ],
  limitations: [
    'Cached official workbook figures were captured on ' + WORKBOOK.fetchedAt + '. They are not a live vendor validation.',
    '4:1 workload CPU, 90% RAM use, 20% estate growth and N+1 are editable planning defaults, not universal Broadcom requirements.',
    'Operations object and metric ceilings retained from KB 397782 apply to 9.0. Validate 9.1 limits through the current configuration maximums and KB 324340.',
    'Reduced 9.1.1 Management Services footprints describe new deployments. An upgraded estate must verify its actual appliance sizes against KB 455842.',
    'Entries marked unconfirmed retain that status and require release-specific verification. Imported inventory cannot establish compatibility or measured peak performance.',
  ],
}         ;
