import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estateWorkbook } from '../testing/estate-fixture.ts';
import { importRvToolsWorkbook } from '../vmware/rvtools.ts';
import { commonHostProfile, planEstate, sourceClusters } from './estate-plan.ts';
import { addressCapacityChecks, reviewEstateSizing } from './estate-sizing-review.ts';

test('estate review follows source scope and retains vCenter identity', async () => {
  const { inventory } = await importRvToolsWorkbook(await estateWorkbook());
  const cluster = sourceClusters(inventory).find(value => value.name === 'Cluster01')!;
  const host = commonHostProfile(inventory.hosts)!;
  const plan = planEstate(inventory, { selected: [cluster.key], managementSource: 'new', host });
  const review = reviewEstateSizing(inventory,plan);
  assert.equal(review.totals.hostCount,cluster.hostCount);
  assert.equal(review.totals.vcenterCount,1);
  assert.equal(review.sourceClusters.length,1);
  assert(review.networks.every(value => value.key===cluster.key));
  assert(review.subnets.every(value => value.clusterKeys.includes(cluster.key)));
});

test('address demand is combined when roles share the same canonical CIDR', () => {
  const result = addressCapacityChecks([
    {role:'Management',cidr:'10.0.0.1/26',required:40},
    {role:'Services',cidr:'10.0.0.0/26',required:30},
  ]);
  assert.equal(result[0]!.combined,70);
  assert.equal(result[0]!.capacity,62);
  assert(result.every(value=>value.status==='Address range too small'));
});

test('missing or invalid subnets remain unresolved and capacity is not free-address inventory', () => {
  const result = addressCapacityChecks([
    {role:'Missing',cidr:'',required:4},
    {role:'Invalid',cidr:'not-a-cidr',required:4},
    {role:'Valid',cidr:'10.0.0.0/24',required:4},
  ]);
  assert.equal(result[0]!.capacity,undefined);
  assert.equal(result[0]!.status,'Subnet not selected');
  assert.equal(result[1]!.status,'Invalid IPv4 CIDR');
  assert.equal(result[2]!.capacity,254);
  assert.match(result[2]!.status,/availability unverified/);
});
