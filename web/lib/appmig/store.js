/**
 * Where Application Migration keeps its applications: the `apps` store of the
 * toolkit's one IndexedDB database, one record per application, keyed by id.
 * It stays in this browser until the application is deleted or Clear all.
 */

import { run } from '../kit/idb.js';
import { normalizeApp,                } from './model.js';

export async function listApps()                       {
  const all = await run             ('apps', 'readonly', (store) => store.getAll()                           );
  return (all ?? []).map(normalizeApp).sort((a, b) => a.identity.name.localeCompare(b.identity.name, undefined, { sensitivity: 'base' }));
}

export async function saveApp(app           )                   {
  const done = await run('apps', 'readwrite', (store) => store.put(app, app.id));
  return done !== null;
}

export async function deleteApp(id        )                {
  await run('apps', 'readwrite', (store) => store.delete(id));
}
