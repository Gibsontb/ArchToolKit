/**
 * What survives a reload or a restart: open tabs with their unsaved text,
 * recent files, settings and saved macros.
 *
 * The session goes to IndexedDB because it can hold file handles (so a
 * restored tab can still save back to its file in the browser) and far more
 * text than localStorage. A handle-free copy also goes to localStorage on
 * the way out: IndexedDB writes are asynchronous and can be cut short when a
 * window closes, localStorage writes cannot. On load the newer copy wins.
 * Every access is wrapped: private windows and locked-down WebView2 profiles
 * throw on storage, and ArchPad must still start.
 */

                                                

                             
                      
                        
                         
                            
                                 
                             
                              
                    
                            
                                   
                        
                                                                                     
                              
                                                                   
                               
                           
                             
                          
                        
                                        
 

                              
                
                           
                                       
                                 
                                
 

                             
                        
                         
                            
 

const DB_NAME = 'archpad';
const STORE = 'kv';
const LS_SESSION = 'archpad.session.v1';
const LS_RECENT = 'archpad.recent.v1';

let dbPromise                                     = null;

function db()                              {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idbGet   (key        )                         {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result                 );
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function idbPut(key        , value         )                   {
  const d = await db();
  if (!d) return false;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      // A handle that cannot be cloned (or any other DataCloneError) lands here.
      resolve(false);
    }
  });
}

function lsGet   (key        )                {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw)     ) : undefined;
  } catch {
    return undefined;
  }
}

function lsSet(key        , value         )          {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function withoutHandles(data             )              {
  return { ...data, docs: data.docs.map(({ handle: _h, ...rest }) => rest) };
}

/** Save the session. `sync` also writes the localStorage copy now (use it when the window is going away). */
export async function saveSession(data             , sync = false)                {
  if (sync) {
    const light = withoutHandles(data);
    // localStorage is ~5 MB per origin; do not let a huge file evict everything else.
    const json = JSON.stringify(light);
    if (json.length < 2_500_000) lsSet(LS_SESSION, light);
  }
  const ok = await idbPut('session', data);
  if (!ok) {
    // Handles that refuse to clone should not cost the text: retry without them.
    const retried = await idbPut('session', withoutHandles(data));
    if (!retried && !sync) {
      const light = withoutHandles(data);
      if (JSON.stringify(light).length < 2_500_000) lsSet(LS_SESSION, light);
    }
  }
}

export async function loadSession()                              {
  const fromDb = await idbGet             ('session');
  const fromLs = lsGet             (LS_SESSION);
  const valid = (s                         )                   => !!s && s.v === 1 && Array.isArray(s.docs);
  if (valid(fromDb) && valid(fromLs)) return fromLs.savedAt > fromDb.savedAt ? fromLs : fromDb;
  if (valid(fromDb)) return fromDb;
  if (valid(fromLs)) return fromLs;
  return null;
}

export async function loadRecent()                        {
  const fromDb = await idbGet              ('recent');
  if (Array.isArray(fromDb)) return fromDb;
  const fromLs = lsGet              (LS_RECENT);
  return Array.isArray(fromLs) ? fromLs : [];
}

export async function saveRecent(list                       )                {
  lsSet(
    LS_RECENT,
    list.map(({ handle: _h, ...rest }) => rest),
  );
  if (!(await idbPut('recent', list))) await idbPut('recent', list.map(({ handle: _h, ...rest }) => rest));
}

/** Small synchronous settings (preferences, macros). */
export function loadJson   (key        , fallback   )    {
  const v = lsGet   (key);
  return v === undefined ? fallback : v;
}

export function saveJson(key        , value         )       {
  lsSet(key, value);
}
