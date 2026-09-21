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

                                                   
                                                        
import { saveEstate, clearEstate } from './estate.js';

const DB_NAME = 'archtoolkit';
const STORE = 'estate';
const KEY = 'current';
const VERSION = 1;

                               
                           
                           
                                                                 
                          
                                
                                        
 

                                
                          
                           
                       
                         
                            
                            
 

function open()                              {
  return new Promise((resolve) => {
    let request                  ;
    try {
      const idb = (globalThis                              ).indexedDB;
      if (!idb) {
        resolve(null);
        return;
      }
      request = idb.open(DB_NAME, VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function run   (mode                    , act                                          )                    {
  return open().then(
    (db) =>
      new Promise          ((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const request = act(tx.objectStore(STORE));
          tx.oncomplete = () => {
            db.close();
            resolve(request.result ?? null);
          };
          tx.onerror = () => {
            db.close();
            resolve(null);
          };
          tx.onabort = () => {
            db.close();
            resolve(null);
          };
        } catch {
          db.close();
          resolve(null);
        }
      }),
  );
}

let cached                                 ;

/** Keep an estate for every page. Resolves false when the browser will not. */
export async function storeInventory(
  inventory           ,
  findings                    ,
  origin        ,
)                   {
  const entry               = { version: VERSION, savedAt: new Date().toISOString(), origin, inventory, findings };
  cached = entry;
  // The names go to sessionStorage as well, for the generators' dropdowns,
  // which read them synchronously while a form is being built.
  saveEstate(inventory);
  const ok = await run('readwrite', (store) => store.put(entry, KEY));
  return ok !== null;
}

/** The stored estate, or null. Read once per page and then held. */
export async function loadInventory()                               {
  if (cached !== undefined) return cached;
  const entry = await run              ('readonly', (store) => store.get(KEY)                            );
  cached = entry && entry.version === VERSION ? entry : null;
  // A new tab has an empty sessionStorage; refill the names from the store.
  if (cached) saveEstate(cached.inventory);
  return cached;
}

export async function forgetInventory()                {
  cached = null;
  clearEstate();
  await run('readwrite', (store) => store.delete(KEY));
}

export function summarise(entry              )                {
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
export function currentEstate()                      {
  return cached ?? null;
}

/** Test seam: hold an estate as though a page had loaded it. */
export function setCurrentEstate(entry                     )       {
  cached = entry;
}

/** Test seam: forget the per-page cache. */
export function resetEstateCache()       {
  cached = undefined;
}
