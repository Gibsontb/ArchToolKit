/**
 * "Clear all": one button, in the header of every page, that empties the
 * toolkit in this browser.
 *
 * The pages hand work to each other — the imported inventory feeds sizing,
 * sizing feeds the spec builder, the builder feeds the editor — so clearing
 * one page's work while the next page reloads it from the estate would not
 * be clearing anything. The button therefore takes everything: the stored
 * estate and the Multi-Cloud plan (IndexedDB), every saved page state and handoff (session and local
 * storage under `archtoolkit.`), and whatever the page is showing, by loading
 * it again fresh.
 *
 * It asks once, on the button itself: the first press arms it, the second
 * clears. It disarms itself after a few seconds.
 *
 * Every page loads this module; it mounts itself into `.app-header`.
 */

import { forgetInventory, resetEstateCache } from '../kit/estate-store.js';
import { DB_NAME, run } from '../kit/idb.js';

const PREFIX = 'archtoolkit.';

function sweep(store                     )         {
  if (!store) return 0;
  const keys           = [];
  for (let i = 0; i < store.length; i += 1) {
    const k = store.key(i);
    if (k?.startsWith(PREFIX)) keys.push(k);
  }
  for (const k of keys) store.removeItem(k);
  return keys.length;
}

function deleteDatabase()                {
  return new Promise((resolve) => {
    try {
      const idb = (globalThis                              ).indexedDB;
      if (!idb) return resolve();
      const req = idb.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
      setTimeout(resolve, 1500);
    } catch {
      resolve();
    }
  });
}

/** Empty everything the toolkit keeps in this browser. */
export async function clearEverything()                {
  let storages                          = [];
  try {
    storages = [globalThis.sessionStorage, globalThis.localStorage];
  } catch {
    // Storage blocked: nothing kept there to clear.
  }
  for (const s of storages) {
    try {
      sweep(s);
    } catch {
      // A store that refuses access holds nothing of ours.
    }
  }
  await forgetInventory();
  resetEstateCache();
  // The Multi-Cloud Planner's plan. Deleting the database below takes it too;
  // this is for when another open tab blocks that delete.
  // (The store and key are plan/store.ts's PLAN_STORE and PLAN_KEY; not imported,
  // so every page's header does not load the planner.)
  await run('plan', 'readwrite', (store) => store.delete('current'));
  await deleteDatabase();
}

export function mountClearAll(header         )                    {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-small btn-clear-all';
  button.textContent = 'Clear all';
  button.title = 'Clear every loaded file and saved piece of work, on every page, in this browser';
  button.setAttribute('data-control', 'clear-all');
  let armed                                           ;
  const disarm = () => {
    armed = undefined;
    button.classList.remove('is-armed');
    button.textContent = 'Clear all';
  };
  button.addEventListener('click', () => {
    if (!armed) {
      button.classList.add('is-armed');
      button.textContent = 'Click again to clear everything';
      armed = setTimeout(disarm, 5000);
      return;
    }
    clearTimeout(armed);
    button.disabled = true;
    button.textContent = 'Clearing…';
    void clearEverything().then(() => {
      // A fresh load, not a reload: a reload would let the browser refill form fields.
      globalThis.location.replace(globalThis.location.pathname);
    });
  });
  header.appendChild(button);
  return button;
}

const header = typeof document !== 'undefined' ? document.querySelector('.app-header') : null;
if (header && !header.querySelector('[data-control="clear-all"]')) mountClearAll(header);
