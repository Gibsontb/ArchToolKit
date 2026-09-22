/**
 * The one IndexedDB database the toolkit uses, and the two calls everything
 * makes against it.
 *
 * Two things outgrow sessionStorage: the imported estate (a large inventory is
 * over a hundred megabytes) and the migration portfolio (one record per
 * application, kept between visits). They share a database because a browser
 * opens a database at one version at a time: two stores in one `archtoolkit`
 * database avoids one page's open failing because another page created the
 * database at a different version.
 *
 * Every call is safe where IndexedDB is missing — tests, private windows,
 * locked-down browsers — by resolving to null rather than throwing. A caller
 * that gets null treats it as "nothing stored, and nothing will be".
 */

export const DB_NAME = 'archtoolkit';
export const VERSION = 2;

/** Every store, created together on upgrade whatever the version came before. */
export const STORES = ['estate', 'portfolio'] as const;
export type StoreName = (typeof STORES)[number];

export function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
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
      for (const store of STORES) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** One transaction against one store. Resolves null when the browser refuses. */
export function run<T>(store: StoreName, mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(store, mode);
          const request = act(tx.objectStore(store));
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
