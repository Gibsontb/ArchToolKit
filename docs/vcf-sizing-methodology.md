# VCF sizing methodology

The VCF sizing page defaults to the Broadcom Planning and Preparation Workbook storage method. Appliance footprints use the selected release's cached official lookup tables. The shipped workbook snapshot is dated 2026-09-27. Source workbook links and the snapshot date appear under **Formulas & sources** and in downloaded JSON and Markdown reports.

## Capacity calculation

- CPU uses physical cores after the selected host failure reserve. SMT does not double physical capacity. The selected vCPU-to-core ratio is a planning assumption.
- Memory uses allocated workload RAM plus appliance RAM after the failure reserve and selected utilization ceiling. RVTools active memory is shown separately because a snapshot cannot establish historical peaks.
- The vSAN workbook method includes VM swap, RAID overhead, a 30% host-and-operations allowance, 10% storage growth, and surviving-host raw disk capacity. Workload fitting and its final storage result use the same swap allowance.
- Estate storage growth greater than the workbook's built-in 10% replaces that allowance. It is not compounded on top of it. CPU and memory use the selected estate growth independently.
- An explicitly selected raw-capacity model retains editable operations reserve. It does not apply the workbook's fixed allowances. Deduplication defaults to 1:1.
- Final host count must satisfy CPU, memory, storage, cluster minimums and the selected resilience policy together. External array capacity and performance require a separate array design.

Target disk capacity is **raw GiB per host**. Broadcom's effective usable capacity already accounts for protection and reserves and must not be entered as raw capacity. Imported VM disk consumption also needs confirmation of its logical versus protected physical accounting.

## Assumptions and limits

The workload defaults of 4:1 CPU, 90% memory use, 20% growth and N+1 are editable site assumptions. They are not presented as universal Broadcom requirements. Unconfirmed component entries retain their evidence status.

Operations object and metric ceilings from KB 397782 are 9.0 guidance. Current 9.1 configuration maximums must be checked before deployment. Reduced 9.1.1 Management Services appliance sizes require verification for upgraded estates. Hardware compatibility, ReadyNode qualification, measured peak demand, IOPS, latency and throughput remain design inputs that RVTools alone cannot establish.

## Primary sources

- [Broadcom planning and preparation workbooks](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/planning-and-preparation.html)
- [Broadcom vSAN Design Guide](https://www.vmware.com/docs/vmware-vsan-design-guide)
- [Auto-RAID in vSAN for VCF 9.1](https://blogs.vmware.com/cloud-foundation/2026/05/08/auto-raid-in-vsan-for-vcf-9-1/)
- [Effective capacity accounting in vSAN 9.1](https://blogs.vmware.com/cloud-foundation/2026/05/11/effective-capacity-view-in-vsan-for-vcf-9-1/)
- [Operations sizing guidance](https://knowledge.broadcom.com/external/article/324340/)
- [Management Services footprint after upgrade](https://knowledge.broadcom.com/external/article/455842/)

The official workbook endpoints could not be refreshed during this update. The application continues to use its dated cached tables, rather than claiming a new vendor validation.
