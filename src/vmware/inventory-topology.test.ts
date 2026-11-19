import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Inventory } from './inventory.ts';
import { inventoryTopology, inventoryTopologyOverview } from './inventory-topology.ts';

const inventory: Inventory = {
  source: { kind: 'manual', importedAt: '' },
  hosts: ['vc-a', 'vc-b'].map(vcenter => ({
    name: 'host-01', vcenter, cluster: 'Cluster01', cpuSockets: 1,
    coresPerSocket: 8, totalCores: 8, memoryGib: 64,
    standardSwitches: [{ name: 'vSwitch0' }],
  })),
  vms: ['vc-a', 'vc-b'].map(vcenter => ({
    name: 'app-01', uuid: 'repeated-uuid', host: 'host-01', vcenter,
    cluster: 'Cluster01', powerState: 'poweredOn', vcpu: 2,
    memoryGib: 4, provisionedGib: 20,
    nics: [{ label: 'NIC 1', network: 'LAN', switchName: 'vSwitch0', connected: true }],
  })),
  networks: [], clusters: [], datastores: [],
};

test('All vCenters includes every center and scoped cluster in the estate overview', () => {
  const graph = inventoryTopologyOverview(inventory);
  assert.equal(graph.vcenters, 2);
  assert.equal(graph.clusters, 2);
  assert.equal(graph.total, 2);
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'vCenter').map(node => node.label).sort(), ['vc-a', 'vc-b']);
  assert.equal(new Set(graph.nodes.map(node => node.id)).size, graph.nodes.length);
  const ids = new Set(graph.nodes.map(node => node.id));
  assert(graph.edges.every(edge => ids.has(edge.from) && ids.has(edge.to)));
});

test('selecting a vCenter then returning to All vCenters restores the complete scope', () => {
  assert.equal(inventoryTopologyOverview(inventory, 'vc-a').total, 1);
  assert.equal(inventoryTopologyOverview(inventory).total, 2);
});

test('cluster expansion shows hosts from the correct vCenter when names repeat', () => {
  const graph = inventoryTopologyOverview(inventory, 'vc-b', JSON.stringify(['vc-b', 'Cluster01']));
  assert.equal(graph.total, 1);
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'Host').map(node => node.hostIndex), [1]);
  assert.equal(graph.nodes.filter(node => node.kind === 'Switch').length, 1);
  assert.equal(inventoryTopology(inventory, 1).nodes.filter(node => node.kind === 'VM NIC').length, 1);
});

test('an empty or unmatched estate returns an empty graph', () => {
  assert.equal(inventoryTopologyOverview(inventory, 'missing').nodes.length, 0);
  assert.equal(inventoryTopologyOverview({ ...inventory, hosts: [] }).total, 0);
});

test('All includes vCenters without hosts and distinguishes standalone host groups from clusters', () => {
  const graph = inventoryTopologyOverview({
    ...inventory,
    vcenters: [{ name: 'vc-a' }, { name: 'vc-b' }, { name: 'vc-empty' }],
    hosts: [...inventory.hosts, { ...inventory.hosts[0]!, name: 'standalone', cluster: '' }],
  });
  assert.equal(graph.vcenters, 3);
  assert.equal(graph.clusters, 2);
  assert.equal(graph.hostGroups, 3);
  assert.equal(graph.total, 3);
  assert.equal(graph.nodes.find(node => node.kind === 'vCenter' && node.label === 'vc-empty')?.detail, '0 hosts · 0 VM entries');
});
