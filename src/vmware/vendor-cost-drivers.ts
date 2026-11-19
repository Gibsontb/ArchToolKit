export interface VendorCostDriver {
  readonly url: string;
  readonly details: string;
  readonly licence?: { readonly unit: 'sockets' | 'cores' | 'nodes' | 'vcfCores'; readonly unitLabel: string; readonly period: 'year' | 'month' };
}

const core = { unit: 'cores', unitLabel: 'physical cores', period: 'year' } as const;
const socket = { unit: 'sockets', unitLabel: 'occupied sockets', period: 'year' } as const;
const node = { unit: 'nodes', unitLabel: 'nodes', period: 'year' } as const;
export const VENDOR_COST_DRIVERS: Readonly<Record<string, VendorCostDriver>> = {
  aws: { url: 'https://docs.aws.amazon.com/pricing-calculator/latest/userguide/ec2-estimates.html', details: 'Price the regional EC2 instance and OS, EBS capacity and extra performance, snapshots, and billable data transfer. Use bundled instance pricing when CPU and RAM are included.' },
  govcloud: { url: 'https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/whatis.html', details: 'Use quotes for the GovCloud partition and chosen region. Include EC2, EBS, snapshots, transfer and any separately billed services.' },
  azure: { url: 'https://learn.microsoft.com/en-us/azure/virtual-machines/cost-optimization-plan-to-manage-costs', details: 'Price Azure VM size, region and OS; add managed disks, transactions, backup and bandwidth. Apply reservations or Hybrid Benefit only when the quote reflects your eligibility.' },
  'azure-government': { url: 'https://azure.microsoft.com/en-us/pricing/calculator/', details: 'Use a quote for Azure Government and its selected region, VM size, OS licence, managed disks and bandwidth.' },
  google: { url: 'https://cloud.google.com/products/compute/pricing', details: 'Use regional Compute Engine machine or billable vCPU and RAM rates, then add disks, snapshots, OS premiums and network transfer. Confirm committed-use eligibility.' },
  oci: { url: 'https://www.oracle.com/cloud/price-list/', details: 'For OCI Flex, use the shape’s quoted billable CPU unit and matching memory rate. Oracle lists OCPU and vCPU comparison prices; convert to a rate per vCPU before entering it here. Add block-storage capacity, performance and outbound transfer.' },
  'azure-local': { url: 'https://learn.microsoft.com/en-us/azure/azure-local/concepts/billing', details: 'Azure Local bills physical cores monthly. Add certified hardware, guest OS rights, storage, operations, and separately billed Azure services.', licence: { ...core, period: 'month' } },
  hyperv: { url: 'https://www.microsoft.com/en-us/windows-server/pricing', details: 'Use the Windows Server Standard or Datacenter core-pack quote, edition minimums and CALs. Annualize a perpetual quote before entering an annual rate.', licence: core },
  ahv: { url: 'https://www.nutanix.com/library/datasheets/nci', details: 'Nutanix NCI subscriptions are priced by physical core across the licensed cluster. Include the quoted edition, hardware, storage, and separate DR entitlements where required.', licence: core },
  openshift: { url: 'https://www.redhat.com/en/resources/self-managed-openshift-subscription-guide', details: 'OpenShift Virtualization Engine offers bare-metal node subscriptions or core-based virtual-cluster subscriptions. Use the matching quote and add separately licensed guests and storage.', licence: node },
  hpe: { url: 'https://www.hpe.com/my/en/products/software/morpheus-software/virtualization.html', details: 'VM Essentials is licensed per physical socket. HPE lists a suggested US rate of USD 600 per socket per year. Hardware, Alletra storage and implementation need their own quote.', licence: socket },
  proxmox: { url: 'https://www.proxmox.com/en/products/proxmox-virtual-environment/pricing', details: 'Subscriptions are per occupied socket per year. Add destination servers, storage, backup capacity, and operations separately.', licence: socket },
  openstack: { url: 'https://canonical.com/openstack/support', details: 'Canonical prices support per node. For Mirantis, use the supplier quote and its actual billing unit. Include control-plane and storage nodes, support coverage, and operations.', licence: node },
  olvm: { url: 'https://www.oracle.com/linux/support/', details: 'Check the Oracle Linux support tier for KVM and Virtualization Manager. Use the support quote and its physical CPU or system terms; include separate Oracle application and database licences.' },
  harvester: { url: 'https://www.suse.com/products/terms_and_conditions.pdf', details: 'Use a SUSE subscription quote that covers the planned virtualization nodes and any Rancher or storage support. Price the packed cluster hardware and operations separately.', licence: node },
  vcf: { url: 'https://knowledge.broadcom.com/external/article/313548/vmware-end-of-availability-of-perpetual-licensing-and-saas-services.html', details: 'VCF uses physical-core licensing with a 16-core minimum per occupied processor. Validate vSAN capacity entitlements and add-ons against the contract.', licence: { ...core, unit: 'vcfCores', unitLabel: 'billable VCF cores' } },
  'vmware-cloud': { url: 'https://docs.aws.amazon.com/evs/latest/userguide/plan-cost.html', details: 'Price the actual hosted VMware service by node or host, plus networking, storage and applicable licence terms. EVS also has control-plane and route-server charges.' },
};

export const PROXMOX_EUR_PER_SOCKET_YEAR = { community: 120, basic: 370, standard: 550, premium: 1100 } as const;
export const HOSTED_VMWARE_COST_SOURCES = [
  { label: 'Amazon EVS', url: 'https://docs.aws.amazon.com/evs/latest/userguide/plan-cost.html' },
  { label: 'Azure VMware Solution', url: 'https://azure.microsoft.com/en-us/pricing/details/azure-vmware/' },
  { label: 'Google Cloud VMware Engine', url: 'https://cloud.google.com/vmware-engine/pricing' },
  { label: 'Oracle Cloud VMware Solution', url: 'https://www.oracle.com/cloud/compute/vmware/faq/' },
];
