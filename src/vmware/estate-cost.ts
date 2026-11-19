import { isWorkload, rdmCapacityGib, vmdkProvisionedGib, vmdkUsedGib, type Inventory } from './inventory.ts';

export const COST_DRIVERS = [
  ['hostPurchase', 'Server replacement cost per host', 16000],
  ['lifeYears', 'Hardware amortization years', 5],
  ['maintenancePercent', 'Annual hardware maintenance (%)', 6],
  ['licensePerCoreYear', 'Platform licence per physical core / year', 200],
  ['storagePerTibMonth', 'Storage per provisioned TiB / month', 18],
  ['backupPerTibMonth', 'Backup and DR per provisioned TiB / month', 12],
  ['hostKw', 'Average IT power per host (kW)', 0.45],
  ['pue', 'Power usage effectiveness (PUE)', 1.5],
  ['electricityPerKwh', 'Electricity per kWh', 0.15],
  ['spacePerHostMonth', 'Facilities and space per host / month, excluding energy', 60],
  ['networkPerHostMonth', 'Network and connectivity per host / month', 40],
  ['hoursPerHostMonth', 'Operations hours per host / month', 1.5],
  ['laborPerHour', 'Fully loaded labor per hour', 95],
  ['sharedInfrastructurePurchase', 'Shared storage and network hardware purchase', 0],
  ['otherSoftwarePerMonth', 'Guest software licences and support / month', 0],
  ['otherOperatingPerMonth', 'Other operating expenses / month', 0],
] as const;

export type CostDriver = typeof COST_DRIVERS[number][0];
export type EstateRates = Record<CostDriver, number>;
export const EXAMPLE_ESTATE_RATES = Object.fromEntries(COST_DRIVERS.map(([id, , value]) => [id, value])) as EstateRates;

export type DestinationScope = 'running' | 'all';
export type DestinationStorage = 'provisioned' | 'used';

export function isDestinationVm(vm: Inventory['vms'][number], scope: DestinationScope): boolean {
  return isWorkload(vm) && (scope === 'all' || vm.powerState === 'poweredOn' || vm.powerState === 'unknown');
}

/** Cloud volume capacity comes from virtual disk capacity, not the VM's datastore footprint. */
export function destinationVirtualDisk(vm: Inventory['vms'][number], storage: DestinationStorage): { gib: number; source: string } | undefined {
  if (storage === 'used') return vm.usedGib !== undefined && Number.isFinite(vm.usedGib)
    ? { gib: vmdkUsedGib(vm), source: 'vInfo · in use' } : undefined;
  const devices = new Map<string, number>();
  for (const [index, disk] of (vm.disks ?? []).entries()) {
    if (!Number.isFinite(disk.capacityGib) || disk.capacityGib <= 0) continue;
    const id = disk.key ? 'key:' + disk.key : disk.file ? 'file:' + (disk.datastore ?? '') + '/' + disk.file : 'row:' + index;
    devices.set(id, disk.raw ? 0 : disk.capacityGib);
  }
  if (devices.size && (!vm.diskCount || devices.size >= vm.diskCount)) {
    return { gib: [...devices.values()].reduce((sum, size) => sum + size, 0), source: 'vDisk · configured disk capacities' };
  }
  if (vm.totalDiskGib !== undefined && Number.isFinite(vm.totalDiskGib) && vm.totalDiskGib > 0) {
    return { gib: Math.max(0, vm.totalDiskGib - (vm.rdmGib ?? 0)), source: 'vInfo · total disk capacity' };
  }
  return vm.provisionedGib > 0 && Number.isFinite(vm.provisionedGib)
    ? { gib: vmdkProvisionedGib(vm), source: 'vInfo · provisioned footprint (fallback)' } : undefined;
}

export function destinationVirtualDiskGib(vm: Inventory['vms'][number], storage: DestinationStorage): number | undefined {
  return destinationVirtualDisk(vm, storage)?.gib;
}

export function inventoryDestinationQuantities(vms: Inventory['vms'], scope: DestinationScope = 'all', storage: DestinationStorage = 'provisioned') {
  const workloads = vms.filter((vm) => isDestinationVm(vm, scope));
  const sum = (key: 'vcpu' | 'memoryGib') =>
    workloads.length && workloads.every((vm) => vm[key] > 0 && Number.isFinite(vm[key]))
      ? workloads.reduce((total, vm) => total + vm[key], 0) : undefined;
  const shared = rdmCapacityGib(workloads);
  const virtualDisks = workloads.map((vm) => destinationVirtualDiskGib(vm, storage));
  const disk = virtualDisks.length && virtualDisks.every((size) => size !== undefined)
    ? virtualDisks.reduce<number>((total, size) => total + size!, shared) : undefined;
  return { vcpu: sum('vcpu'), ram: sum('memoryGib'), disk, count: workloads.length, shared };
}

export function readEstateRates(value: unknown): EstateRates {
  if (!value || typeof value !== 'object') throw new Error('Expected an ArchToolKit rate file.');
  const rates = { sharedInfrastructurePurchase: 0, otherSoftwarePerMonth: 0, otherOperatingPerMonth: 0,
    ...value } as Record<string, unknown>;
  for (const [id, label] of COST_DRIVERS) {
    const amount = rates[id];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 ||
      (id === 'pue' && amount < 1) || (id === 'lifeYears' && amount === 0)) throw new Error('Check ' + label + '.');
  }
  return Object.fromEntries(COST_DRIVERS.map(([id]) => [id, rates[id]])) as EstateRates;
}

export function estimateEstateCost(inventory: Pick<Inventory, 'hosts' | 'vms'>, rates: EstateRates) {
  const hosts = inventory.hosts.length;
  const unknownCores = inventory.hosts.filter((host) => !(host.totalCores > 0)).length;
  const cores = inventory.hosts.reduce((total, host) => total + (host.totalCores > 0 ? host.totalCores : 0), 0);
  const vms = inventory.vms.filter(isWorkload);
  const tib = (vms.reduce((total, vm) => total + vmdkProvisionedGib(vm), 0) + rdmCapacityGib(vms)) / 1024;
  const storageKnown = vms.length > 0 && vms.every((vm) => vm.provisionedGib > 0);
  return { ...estimateEstateQuantities({ hosts: hosts || null, cores: hosts && !unknownCores ? cores : null,
    tib: storageKnown ? tib : null }, rates), hosts, cores, unknownCores, vms: vms.length, tib };
}

export function estimateEstateQuantities(
  { hosts, cores, tib }: { hosts: number | null; cores: number | null; tib: number | null },
  rates: EstateRates,
) {
  const capital = hosts === null ? null : hosts * rates.hostPurchase + rates.sharedInfrastructurePurchase;
  const perHost = (amount: number) => hosts === null ? null : hosts * amount;
  const rows = [
    ['Hardware amortization', capital === null ? null : capital / (rates.lifeYears * 12)],
    ['Hardware maintenance', perHost(rates.hostPurchase * rates.maintenancePercent / 1200)],
    ['Platform licensing', cores === null ? null : cores * rates.licensePerCoreYear / 12],
    ['VM storage', tib === null ? null : tib * rates.storagePerTibMonth],
    ['Backup and DR', tib === null ? null : tib * rates.backupPerTibMonth],
    ['Power and cooling', perHost(rates.hostKw * rates.pue * 730 * rates.electricityPerKwh)],
    ['Facilities and space', perHost(rates.spacePerHostMonth)],
    ['Network and connectivity', perHost(rates.networkPerHostMonth)],
    ['Operations labor', perHost(rates.hoursPerHostMonth * rates.laborPerHour)],
    ['Other software and support', rates.otherSoftwarePerMonth],
    ['Other operating expenses', rates.otherOperatingPerMonth],
  ] as const;
  const subtotal = rows.reduce((sum, [, amount]) => sum + (amount ?? 0), 0);
  const operating = rows.slice(1).reduce((sum, [, amount]) => sum + (amount ?? 0), 0);
  return { hosts, cores, tib, rows, subtotal, operating, capital, complete: rows.every(([, amount]) => amount !== null) };
}
