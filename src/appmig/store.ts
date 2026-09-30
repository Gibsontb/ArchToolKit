/**
 * Where Application Migration keeps its applications: the `apps` store of the
 * toolkit's one IndexedDB database, one record per application, keyed by id.
 * It stays in this browser until the application is deleted or Clear all.
 */

import { run } from '../kit/idb.ts';
import { normalizeApp, type AppRecord } from './model.ts';

export async function listApps(): Promise<AppRecord[]> {
  const all = await run<AppRecord[]>('apps', 'readonly', (store) => store.getAll() as IDBRequest<AppRecord[]>);
  return (all ?? []).map(normalizeApp).sort((a, b) => a.identity.name.localeCompare(b.identity.name, undefined, { sensitivity: 'base' }));
}

export async function saveApp(app: AppRecord): Promise<boolean> {
  const done = await run('apps', 'readwrite', (store) => store.put(app, app.id));
  return done !== null;
}

export async function deleteApp(id: string): Promise<void> {
  await run('apps', 'readwrite', (store) => store.delete(id));
}
