/**
 * The imported estate, kept whole, for every page.
 *
 * Import once and every tool reads the same estate: sizing fills itself in,
 * the VCF design takes its hosts and networks, the Terraform and Ansible
 * generators offer its names and build from its VMs, and the multicloud
 * decision reads its workloads. That needs the whole inventory, not just the
 * names in `estate.ts` — and a seventeen-thousand-VM estate with its disks and
 * partitions is over a hundred megabytes, far past what sessionStorage holds.
 * IndexedDB holds it.
 *
 * It lives in this browser only: nothing is sent anywhere, and "Forget this
 * estate" on any page deletes it. It outlives the tab, deliberately — someone
 * working a design over a week should not re-import every morning — which is
 * why forgetting it is always one click away and every page says whose estate
 * it is holding.
 *
 * Every call is safe to make where IndexedDB is missing (tests, locked-down
 * browsers): it resolves to "nothing stored" rather than throwing.
 */

import type { Finding } from '../core/findings.ts';
import type { Inventory } from '../vmware/inventory.ts';
import { saveEstate, clearEstate } from './estate.ts';
import { run as runStore } from './idb.ts';

const KEY = 'current';
/** The shape this module writes; bumped only when the stored estate changes. */
const VERSION = 1;

export interface StoredEstate {
  readonly version: number;
  readonly savedAt: string;
  /** The file it came from, as the person would recognise it. */
  readonly origin: string;
  readonly inventory: Inventory;
  readonly findings: readonly Finding[];
}

export interface EstateSummary {
  readonly origin: string;
  readonly savedAt: string;
  readonly vms: number;
  readonly hosts: number;
  readonly clusters: number;
  readonly vcenters: number;
}

const run = <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> => runStore('estate', mode, act);

let cached: StoredEstate | null | undefined;

/** Keep an estate for every page. Resolves false when the browser will not. */
export async function storeInventory(
  inventory: Inventory,
  findings: readonly Finding[],
  origin: string,
): Promise<boolean> {
  const entry: StoredEstate = { version: VERSION, savedAt: new Date().toISOString(), origin, inventory, findings };
  cached = entry;
  // The names go to sessionStorage as well, for the generators' dropdowns,
  // which read them synchronously while a form is being built.
  saveEstate(inventory);
  const ok = await run('readwrite', (store) => store.put(entry, KEY));
  return ok !== null;
}

/** The stored estate, or null. Read once per page and then held. */
export async function loadInventory(): Promise<StoredEstate | null> {
  if (cached !== undefined) return cached;
  const entry = await run<StoredEstate>('readonly', (store) => store.get(KEY) as IDBRequest<StoredEstate>);
  cached = entry && entry.version === VERSION ? entry : null;
  // A new tab has an empty sessionStorage; refill the names from the store.
  if (cached) saveEstate(cached.inventory);
  return cached;
}

export async function forgetInventory(): Promise<void> {
  cached = null;
  clearEstate();
  await run('readwrite', (store) => store.delete(KEY));
}

export function summarise(entry: StoredEstate): EstateSummary {
  const inv = entry.inventory;
  const vcenters = new Set([
    ...(inv.vcenters ?? []).map((v) => v.name.toLowerCase()),
    ...inv.hosts.map((h) => (h.vcenter ?? '').toLowerCase()).filter(Boolean),
  ]);
  return {
    origin: entry.origin,
    savedAt: entry.savedAt,
    vms: inv.vms.filter((v) => !v.template && !v.srmPlaceholder).length,
    hosts: inv.hosts.length,
    clusters: inv.clusters.length,
    vcenters: vcenters.size,
  };
}

/**
 * The estate as already loaded on this page, synchronously.
 *
 * Generators build their files synchronously, so they read the estate the page
 * loaded at mount rather than going back to IndexedDB. Null before a load, or
 * when nothing is stored.
 */
export function currentEstate(): StoredEstate | null {
  return cached ?? null;
}

/** Test seam: hold an estate as though a page had loaded it. */
export function setCurrentEstate(entry: StoredEstate | null): void {
  cached = entry;
}

/** Test seam: forget the per-page cache. */
export function resetEstateCache(): void {
  cached = undefined;
}
