/**
 * The one IndexedDB database the toolkit uses, and the two calls everything
 * makes against it.
 *
 * Three things outgrow sessionStorage: the imported estate (a large inventory is
 * over a hundred megabytes), the migration portfolio (one record per
 * application, kept between visits) and the Multi-Cloud Planner's plan. They
 * share a database because a browser opens a database at one version at a
 * time: several stores in one `archtoolkit`
 * database avoids one page's open failing because another page created the
 * database at a different version.
 *
 * Every call is safe where IndexedDB is missing — tests, private windows,
 * locked-down browsers — by resolving to null rather than throwing. A caller
 * that gets null treats it as "nothing stored, and nothing will be".
 */

export const DB_NAME = 'archtoolkit';
/** 3 added the Multi-Cloud Planner's `plan` store. An upgrade only ever adds stores. */
export const VERSION = 3;

/** Every store, created together on upgrade whatever the version came before. */
export const STORES = ['estate', 'portfolio', 'plan']         ;
                                                

export function open()                              {
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
export function run   (store           , mode                    , act                                          )                    {
  return open().then(
    (db) =>
      new Promise          ((resolve) => {
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
