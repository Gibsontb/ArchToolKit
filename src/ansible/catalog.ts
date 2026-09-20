/**
 * What each collection can actually do.
 *
 * The kit emits hand-verified tasks for the cases worth getting exactly right,
 * but an architect needs the rest too, and there are nearly four thousand
 * modules. Rather than transcribe that — which would be wrong within a release —
 * the catalog is fetched from Galaxy and consulted: it can say whether a module
 * exists, find one by name, and refuse a misremembered name before it reaches a
 * playbook, where the failure message is simply that the module was not found.
 *
 * A catalog that can go quietly stale is worse than none, so this reports its
 * own age and notices when the collection version the kit pins has moved past
 * the version the catalog was built from.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import { COLLECTIONS, collectionFor, collectionOfModule } from './collections.ts';
import { ANSIBLE_CATALOG_DATA, ANSIBLE_CATALOG_FETCHED_AT } from './catalog-data.ts';

/** Beyond this, the catalog is old enough to be worth mentioning. */
const STALE_AFTER_DAYS = 90;

export interface ModuleCatalogEntry {
  readonly collection: string;
  /** Collection version the list was taken from. */
  readonly version: string;
  /** Module names without their collection prefix. */
  readonly modules: readonly string[];
}

const cache = new Map<string, ModuleCatalogEntry>();

/** The catalogued collections. Absent ones have simply not been fetched. */
export function catalogueFor(collection: string): ModuleCatalogEntry | undefined {
  const cached = cache.get(collection);
  if (cached) return cached;

  const raw = ANSIBLE_CATALOG_DATA[collection];
  if (!raw) return undefined;

  const entry: ModuleCatalogEntry = {
    collection,
    version: raw.version,
    modules: raw.modules ? raw.modules.split(',').filter(Boolean) : [],
  };
  cache.set(collection, entry);
  return entry;
}

export function catalogued(): readonly string[] {
  return COLLECTIONS.filter((c) => ANSIBLE_CATALOG_DATA[c.name] !== undefined).map((c) => c.name);
}

/**
 * Collections the kit knows but the catalog does not hold.
 *
 * ansible.builtin is excluded rather than reported: it ships inside
 * ansible-core and is not published to Galaxy, so it can never be catalogued
 * and listing it as missing would send people to run a refresh that cannot
 * possibly fix it.
 */
export function notCatalogued(): readonly string[] {
  return COLLECTIONS.filter((c) => !c.builtin && ANSIBLE_CATALOG_DATA[c.name] === undefined).map(
    (c) => c.name,
  );
}

/** Fully qualified module names, e.g. `amazon.aws.ec2_instance`. */
export function moduleNames(collection: string): readonly string[] {
  const entry = catalogueFor(collection);
  if (!entry) return [];
  return entry.modules.map((name) => `${collection}.${name}`);
}

export type ModuleKind = 'module' | 'unknown' | 'uncatalogued' | 'not-qualified';

/**
 * Whether a module exists.
 *
 * `uncatalogued` is deliberately distinct from `unknown`: not knowing is not the
 * same as knowing it is wrong, and treating the two alike would have the kit
 * reject perfectly good modules simply because nobody had refreshed the list.
 *
 * `not-qualified` covers a short name like `copy`. Those still work, but they
 * resolve through the collections search path, which differs between control
 * nodes — so it is a different answer, not a failure.
 */
export function classifyModule(module: string): ModuleKind {
  const collection = collectionOfModule(module);
  if (!collection) return 'not-qualified';
  const entry = catalogueFor(collection);
  if (!entry) return 'uncatalogued';
  const bare = module.slice(collection.length + 1);
  return entry.modules.includes(bare) ? 'module' : 'unknown';
}

export interface ModuleHit {
  readonly collection: string;
  readonly module: string;
}

/** Find modules whose fully qualified name contains every term. */
export function searchModules(
  query: string,
  options: { readonly collections?: readonly string[]; readonly limit?: number } = {},
): readonly ModuleHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];

  const collections = options.collections ?? catalogued();
  const limit = options.limit ?? 50;
  const hits: ModuleHit[] = [];

  for (const collection of collections) {
    for (const module of moduleNames(collection)) {
      if (hits.length >= limit) return hits;
      const haystack = module.toLowerCase();
      if (terms.every((term) => haystack.includes(term))) hits.push({ collection, module });
    }
  }
  return hits;
}

/** Total catalogued modules, for reporting. */
export function catalogTotals(): { modules: number; collections: number } {
  const collections = catalogued();
  let modules = 0;
  for (const collection of collections) modules += moduleNames(collection).length;
  return { modules, collections: collections.length };
}

export function catalogAgeDays(today = new Date()): number {
  const fetched = Date.parse(`${ANSIBLE_CATALOG_FETCHED_AT}T00:00:00Z`);
  if (!Number.isFinite(fetched)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((today.getTime() - fetched) / 86_400_000));
}

/**
 * How trustworthy the catalog currently is.
 *
 * Three separate things can be wrong, and they need saying separately: it may
 * be old, it may be missing collections entirely, and the version it was built
 * from may no longer match what the kit pins into requirements.yml.
 */
export function catalogFindings(today = new Date()): readonly Finding[] {
  const findings: Finding[] = [];
  const totals = catalogTotals();
  const missing = notCatalogued();
  const age = catalogAgeDays(today);

  findings.push(
    info(
      'ansible.catalog.summary',
      `Catalog holds ${totals.modules} modules across ${totals.collections} collection(s), fetched ${ANSIBLE_CATALOG_FETCHED_AT}.`,
      { source: 'Ansible Galaxy' },
    ),
  );

  if (missing.length > 0) {
    findings.push(
      warning(
        'ansible.catalog.incomplete',
        `${missing.length} collection(s) are not in the catalog: ${missing.join(', ')}. Module names for those cannot be checked.`,
        {
          remediation: 'Run npm run ansible:update to fetch them from Galaxy.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  if (age > STALE_AFTER_DAYS) {
    findings.push(
      warning(
        'ansible.catalog.stale',
        `The catalog is ${age} days old, so modules added since then are unknown to it.`,
        { remediation: 'Run npm run ansible:update.', source: 'ArchToolKit' },
      ),
    );
  }

  for (const collection of catalogued()) {
    const entry = catalogueFor(collection);
    const info_ = collectionFor(collection);
    if (entry && info_ && entry.version !== info_.observedVersion) {
      findings.push(
        warning(
          'ansible.catalog.version-drift',
          `The ${info_.label} catalog came from ${entry.version}, but the kit records ${info_.observedVersion}. Module lists and requirements.yml disagree.`,
          { remediation: 'Run npm run ansible:update.', source: 'ArchToolKit' },
        ),
      );
    }
  }

  return findings;
}
