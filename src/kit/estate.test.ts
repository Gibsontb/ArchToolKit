import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { estateOptionsFor, saveEstate, loadEstate, clearEstate } from './estate.ts';
import { emptyInventory } from '../vmware/inventory.ts';
import type { Inventory } from '../vmware/inventory.ts';

/** sessionStorage does not exist under node:test, so this stands in for it. */
function fakeStorage(): void {
  const data = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  };
}

const estate: Inventory = {
  ...emptyInventory({ kind: 'rvtools', label: 'vcenter-prod.court.local' }),
  clusters: [
    { name: 'Compute-Cluster', datacenter: 'Court-DC1' },
    { name: 'Mgmt-Cluster', datacenter: 'Court-DC1' },
    { name: 'Edge-Cluster', datacenter: 'Court-DC2' },
  ],
  datastores: [
    { name: 'vsanDatastore', type: 'vsan', capacityGib: 40960, freeGib: 18000 },
    { name: 'nfs-archive', type: 'NFS', capacityGib: 10240, freeGib: 4000 },
  ],
  networks: [{ name: 'VM Network' }, { name: 'dvpg-prod-100' }],
  hosts: [
    { name: 'esx01.court.local', cpuSockets: 2, coresPerSocket: 24, totalCores: 48, memoryGib: 768, datacenter: 'Court-DC1' },
    { name: 'esx02.court.local', cpuSockets: 2, coresPerSocket: 24, totalCores: 48, memoryGib: 768, datacenter: 'Court-DC1' },
  ],
  vms: [
    { name: 'app01', powerState: 'poweredOn', vcpu: 4, memoryGib: 16, provisionedGib: 100 },
    { name: 'rhel9-golden-template', powerState: 'poweredOff', vcpu: 2, memoryGib: 4, provisionedGib: 40 },
  ],
};

describe('kit/estate: offering what the inventory already knows', () => {
  it('offers nothing before an inventory has been imported', () => {
    fakeStorage();
    clearEstate();
    expect(estateOptionsFor('vsphere', 'datastore_name')).toBeNull();
  });

  it('keeps only the names, not the estate', () => {
    fakeStorage();
    saveEstate(estate);
    const saved = loadEstate();
    expect(saved?.clusters).toEqual(['Compute-Cluster', 'Edge-Cluster', 'Mgmt-Cluster']);
    // No capacities, no power states, nothing but the names the dropdowns need.
    expect(JSON.stringify(saved)).not.toContain('40960');
  });

  it('answers the blueprints’ various spellings of the same thing', () => {
    fakeStorage();
    saveEstate(estate);
    for (const id of ['datastore', 'datastore_name']) {
      expect(estateOptionsFor('vsphere', id)?.values).toEqual(['nfs-archive', 'vsanDatastore']);
    }
    for (const id of ['cluster', 'cluster_name']) {
      expect(estateOptionsFor('vsphere', id)?.values).toContain('Compute-Cluster');
    }
    for (const id of ['datacenter', 'datacenter_name']) {
      expect(estateOptionsFor('vsphere', id)?.values).toEqual(['Court-DC1', 'Court-DC2']);
    }
    for (const id of ['vm_network', 'network_label']) {
      expect(estateOptionsFor('vsphere', id)?.values).toContain('dvpg-prod-100');
    }
  });

  it('guesses at templates but still offers every VM behind them', () => {
    fakeStorage();
    saveEstate(estate);
    // vSphere exports rarely mark templates, so the guess is a guess.
    expect(estateOptionsFor('vsphere', 'template_name')?.values).toEqual(['rhel9-golden-template']);
    expect(estateOptionsFor('vsphere', 'vm_name')?.values).toContain('app01');
  });

  it('says where the suggestions came from', () => {
    fakeStorage();
    saveEstate(estate);
    expect(estateOptionsFor('vsphere', 'cluster')?.origin).toBe('vcenter-prod.court.local');
  });

  it('offers nothing for a cloud, whose names it cannot know', () => {
    fakeStorage();
    saveEstate(estate);
    expect(estateOptionsFor('aws', 'subnet_id')).toBeNull();
    expect(estateOptionsFor('azure', 'resource_group')).toBeNull();
  });

  it('offers nothing for a field the estate has no answer for', () => {
    fakeStorage();
    saveEstate(estate);
    expect(estateOptionsFor('vsphere', 'vcenter_password')).toBeNull();
    expect(estateOptionsFor('vsphere', 'annotation')).toBeNull();
  });

  it('survives storage being unavailable, as it is in a private window', () => {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = undefined;
    // The expect shim's `not` deliberately has no toThrow, so this says it the
    // plain way: if saving threw, the test fails here rather than silently.
    saveEstate(estate);
    expect(loadEstate()).toBeNull();
    expect(estateOptionsFor('vsphere', 'cluster')).toBeNull();
  });
});
