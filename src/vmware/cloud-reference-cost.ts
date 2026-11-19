const bundledCompute = (vcpu: number, memory: number, hourly: number) => (cpu: number, ram: number) => ({
  hourly: Math.max(cpu / vcpu, ram / memory) * hourly,
  basis: `max(vCPU ÷ ${vcpu}, RAM GiB ÷ ${memory}) × USD ${hourly}/hour × billable hours`,
});
const capacity = (rate: number) => (gib: number) => ({
  monthly: gib * rate, basis: `Provisioned GiB × USD ${rate}/GiB-month`,
});

/** Published examples and retail snapshots. All rates below are USD. */
const rates = {
  aws: {
    label: 'US East (N. Virginia) · EC2 m5.large Linux equivalent and gp3 capacity example',
    computeUrl: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode-concepts.html',
    storageUrl: 'https://aws.amazon.com/ebs/pricing/',
    compute: bundledCompute(2, 8, 0.096),
    disk: capacity(0.08),
  },
  azure: {
    label: 'East US · D2s v5 Linux equivalent and Premium SSD P10 LRS',
    computeUrl: 'https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20%27eastus%27%20and%20armSkuName%20eq%20%27Standard_D2s_v5%27',
    storageUrl: 'https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20%27eastus%27%20and%20productName%20eq%20%27Premium%20SSD%20Managed%20Disks%27%20and%20skuName%20eq%20%27P10%20LRS%27',
    compute: bundledCompute(2, 8, 0.096),
    disk: (gib: number) => ({ monthly: Math.ceil(gib / 128) * 19.71, basis: 'Round up (provisioned GiB ÷ 128) × USD 19.71/disk-month' }),
  },
  google: {
    label: 'Iowa · N2 standard equivalent and balanced Persistent Disk',
    computeUrl: 'https://cloud.google.com/products/compute/pricing/general-purpose?hl=en',
    storageUrl: 'https://cloud.google.com/compute/disks-image-pricing',
    compute: bundledCompute(64, 256, 3.107776),
    disk: (gib: number) => ({ monthly: gib * 730 * 0.000136986, basis: 'Provisioned GiB × 730 hours × USD 0.000136986/GiB-hour' }),
  },
  oci: {
    label: 'OCI public price list · E5 Flex and block-volume capacity',
    computeUrl: 'https://www.oracle.com/ba/a/ocom/docs/corporate/pricing/oracle-paas-and-iaas-global-price-list.pdf',
    storageUrl: 'https://www.oracle.com/cloud/price-list/',
    compute: (cpu: number, ram: number) => ({ hourly: cpu / 2 * 0.03 + ram * 1.073741824 * 0.002,
      basis: '(vCPU ÷ 2 × USD 0.03/OCPU-hour + RAM GiB × 1.073741824 × USD 0.002/GB-hour) × billable hours' }),
    disk: (gib: number) => ({ monthly: gib * 1.073741824 * 0.0255, basis: 'Provisioned GiB × 1.073741824 × USD 0.0255/GB-month' }),
  },
} satisfies Record<string, {
  label: string; computeUrl: string; storageUrl: string;
  compute(cpu: number, ram: number): { hourly: number; basis: string };
  disk(gib: number): { monthly: number; basis: string };
}>;

export function cloudReferenceCost(
  provider: string, cpu: number | null, ram: number | null, disk: number | null, hours: number | null,
) {
  if (!Object.hasOwn(rates, provider)) return null;
  const profile = rates[provider as keyof typeof rates];
  const computeLine = cpu === null || ram === null || hours === null ? null : profile.compute(cpu, ram);
  const storageLine = disk === null ? null : profile.disk(disk);
  const compute = computeLine && hours !== null ? computeLine.hourly * hours : null;
  const storage = storageLine?.monthly ?? null;
  return { label: profile.label, computeUrl: profile.computeUrl, storageUrl: profile.storageUrl, compute, storage,
    computeBasis: computeLine?.basis, storageBasis: storageLine?.basis,
    total: compute === null || storage === null ? null : compute + storage };
}
