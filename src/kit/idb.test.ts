import { describe, it, after } from 'node:test';
import { expect } from '../testing/expect.ts';
import { DB_NAME, STORES, VERSION, open, run } from './idb.ts';

/**
 * A small IndexedDB stand-in: enough of open / upgrade / transaction to prove
 * the upgrade keeps what an older version stored. Node has no IndexedDB and
 * the toolkit takes no dependencies, so fake-indexeddb is not available.
 */
interface FakeDb {
  version: number;
  stores: Map<string, Map<IDBValidKey, unknown>>;
}

function installFakeIdb(existing?: FakeDb): { dbs: Map<string, FakeDb>; upgrades: number[] } {
  const dbs = new Map<string, FakeDb>();
  if (existing) dbs.set(DB_NAME, existing);
  const upgrades: number[] = [];

  const connection = (db: FakeDb) => ({
    objectStoreNames: { contains: (n: string) => db.stores.has(n) },
    createObjectStore: (n: string) => {
      db.stores.set(n, new Map());
      return {};
    },
    close: () => undefined,
    transaction: (name: string) => {
      const data = db.stores.get(name);
      if (!data) throw new Error(`NotFoundError: ${name}`);
      const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown } = {
        objectStore: () => {
          const req = (result: unknown) => {
            const r = { result };
            setTimeout(() => tx.oncomplete?.(), 0);
            return r;
          };
          return {
            get: (k: IDBValidKey) => req(data.get(k)),
            put: (v: unknown, k: IDBValidKey) => {
              data.set(k, v);
              return req(k);
            },
            delete: (k: IDBValidKey) => {
              data.delete(k);
              return req(undefined);
            },
          };
        },
      };
      return tx;
    },
  });

  const factory = {
    open: (name: string, version: number) => {
      const request: {
        result?: unknown;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
      } = {};
      setTimeout(() => {
        let db = dbs.get(name);
        if (!db) {
          db = { version: 0, stores: new Map() };
          dbs.set(name, db);
        }
        request.result = connection(db);
        if (version > db.version) {
          upgrades.push(db.version);
          request.onupgradeneeded?.();
          db.version = version;
        }
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true });
  return { dbs, upgrades };
}

function removeFakeIdb(): void {
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true });
}

describe('kit/idb: the one database', () => {
  after(removeFakeIdb);

  it('is at version 3, with the planner store beside the estate and the portfolio', () => {
    expect(VERSION).toBe(3);
    expect([...STORES]).toEqual(['estate', 'portfolio', 'plan']);
  });

  it('upgrades a version-2 database by adding the plan store, keeping estate and portfolio', async () => {
    const v2: FakeDb = {
      version: 2,
      stores: new Map<string, Map<IDBValidKey, unknown>>([
        ['estate', new Map<IDBValidKey, unknown>([['current', { origin: 'rvtools.xlsx' }]])],
        ['portfolio', new Map<IDBValidKey, unknown>([['apps', [{ name: 'Payroll' }]]])],
      ]),
    };
    const { upgrades } = installFakeIdb(v2);

    const estate = await run<{ origin: string }>('estate', 'readonly', (s) => s.get('current') as IDBRequest<{ origin: string }>);
    expect(upgrades).toEqual([2]);
    expect(estate?.origin).toBe('rvtools.xlsx');
    const portfolio = await run<{ name: string }[]>('portfolio', 'readonly', (s) => s.get('apps') as IDBRequest<{ name: string }[]>);
    expect(portfolio?.[0]?.name).toBe('Payroll');
    expect([...v2.stores.keys()].sort()).toEqual(['estate', 'plan', 'portfolio']);
    expect(v2.version).toBe(3);
  });

  it('creates every store on a first open', async () => {
    const { dbs } = installFakeIdb();
    const db = await open();
    expect(db).not.toBeNull();
    expect([...(dbs.get(DB_NAME)?.stores.keys() ?? [])]).toEqual([...STORES]);
  });

  it('writes, reads and deletes in the plan store', async () => {
    installFakeIdb();
    await run('plan', 'readwrite', (s) => s.put({ name: 'Migration plan' }, 'current'));
    const got = await run<{ name: string }>('plan', 'readonly', (s) => s.get('current') as IDBRequest<{ name: string }>);
    expect(got?.name).toBe('Migration plan');
    await run('plan', 'readwrite', (s) => s.delete('current'));
    expect(await run('plan', 'readonly', (s) => s.get('current'))).toBeNull();
  });

  it('resolves null where IndexedDB is missing', async () => {
    removeFakeIdb();
    expect(await open()).toBeNull();
    expect(await run('plan', 'readonly', (s) => s.get('current'))).toBeNull();
  });
});
