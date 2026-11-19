import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estateWorkbook } from '../testing/estate-fixture.ts';
import { importRvToolsWorkbook } from './rvtools.ts';
import { destinationVirtualDiskGib, inventoryDestinationQuantities } from './estate-cost.ts';
import { isWorkload, rdmCapacityGib } from './inventory.ts';
import { cloudReferenceCost } from './cloud-reference-cost.ts';

test('default migration scope can exclude powered-off VMs and charges a shared RDM once', async () => {
  const { inventory } = await importRvToolsWorkbook(await estateWorkbook());
  const all = inventoryDestinationQuantities(inventory.vms, 'all');
  const running = inventoryDestinationQuantities(inventory.vms, 'running');
  const workloads = inventory.vms.filter(isWorkload);
  assert.ok(all.count > running.count);
  assert.ok((all.vcpu ?? 0) > (running.vcpu ?? 0));
  assert.equal(all.disk, workloads.reduce((sum, vm) => sum + (destinationVirtualDiskGib(vm, 'provisioned') ?? 0), rdmCapacityGib(workloads)));
  assert.ok((all.disk ?? Infinity) < workloads.reduce((sum, vm) => sum + vm.provisionedGib, 0));
});

test('uses configured virtual disks once instead of pricing the datastore footprint', () => {
  const disk = { label: 'Disk 1', key: '2000', capacityGib: 64, raw: false };
  assert.equal(destinationVirtualDiskGib({
    name: 'vm', powerState: 'poweredOn', vcpu: 2, memoryGib: 8, provisionedGib: 400,
    diskCount: 1, disks: [disk, disk],
  }, 'provisioned'), 64);
});

test('reproduces the prior AWS estimate from the entered capacities', () => {
  const price = cloudReferenceCost('aws', 110766, 566969.3281, 44554638.19, 730);
  assert.equal(price?.compute?.toFixed(2), '4966651.31');
  assert.equal(price?.storage?.toFixed(2), '3564371.06');
  assert.equal(price?.total?.toFixed(2), '8531022.37');
});
