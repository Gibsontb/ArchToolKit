/**
 * What each provider can actually build.
 *
 * The kit emits hand-verified resources for the common cases, but an architect
 * needs the rest too, and there are roughly five thousand of them. Rather than
 * transcribe that — which would be wrong within a release — the catalog is
 * fetched from the registry and consulted: it can say whether a resource type
 * exists, find one by name, and refuse a typo before it reaches a plan.
 *
 * A catalog that can go quietly stale is worse than none, so this reports its
 * own age and notices when the provider version the kit pins has moved past the
 * version the catalog was built from.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import { PROVIDERS, providerFor, type CloudTarget } from './providers.ts';
import { CATALOG_DATA, CATALOG_FETCHED_AT } from './catalog-data.ts';

/** Beyond this, the catalog is old enough to be worth mentioning. */
const STALE_AFTER_DAYS = 90;

export interface CatalogEntry {
  readonly target: CloudTarget;
  readonly source: string;
  /** Provider version the lists were taken from. */
  readonly version: string;
  readonly resources: readonly string[];
  readonly dataSources: readonly string[];
}

function prefixFor(target: CloudTarget): string {
  return target === 'azure' ? 'azurerm_' : `${target}_`;
}

const cache = new Map<CloudTarget, CatalogEntry>();

/** The catalogued providers. Absent ones have simply not been fetched. */
export function catalogueFor(target: CloudTarget): CatalogEntry | undefined {
  const cached = cache.get(target);
  if (cached) return cached;

  const raw = CATALOG_DATA[target];
  if (!raw) return undefined;

  const split = (value: string): string[] => (value ? value.split(',').filter(Boolean) : []);
  const entry: CatalogEntry = {
    target,
    source: raw.source,
    version: raw.version,
    resources: split(raw.resources),
    dataSources: split(raw.dataSources),
  };
  cache.set(target, entry);
  return entry;
}

export function catalogued(): readonly CloudTarget[] {
  return PROVIDERS.map((p) => p.target).filter((t) => CATALOG_DATA[t] !== undefined);
}

export function notCatalogued(): readonly CloudTarget[] {
  return PROVIDERS.map((p) => p.target).filter((t) => CATALOG_DATA[t] === undefined);
}

/** Full resource type names, e.g. `aws_vpc`. */
export function resourceTypes(target: CloudTarget): readonly string[] {
  const entry = catalogueFor(target);
  if (!entry) return [];
  const prefix = prefixFor(target);
  return entry.resources.map((name) => prefix + name);
}

export function dataSourceTypes(target: CloudTarget): readonly string[] {
  const entry = catalogueFor(target);
  if (!entry) return [];
  const prefix = prefixFor(target);
  return entry.dataSources.map((name) => prefix + name);
}

export type TypeKind = 'resource' | 'data-source' | 'unknown' | 'uncatalogued';

/**
 * Whether a type exists.
 *
 * `uncatalogued` is deliberately distinct from `unknown`: not knowing is not the
 * same as knowing it is wrong, and treating the two alike would have the kit
 * reject perfectly good resources simply because nobody had refreshed the list.
 */
export function classifyType(target: CloudTarget, type: string): TypeKind {
  const entry = catalogueFor(target);
  if (!entry) return 'uncatalogued';
  const prefix = prefixFor(target);
  const bare = type.startsWith(prefix) ? type.slice(prefix.length) : type;
  if (entry.resources.includes(bare)) return 'resource';
  if (entry.dataSources.includes(bare)) return 'data-source';

  const shared = sharedDocPage(bare);
  if (shared !== undefined && entry.resources.includes(shared)) return 'resource';

  return 'unknown';
}

/**
 * The page name for a resource that does not have a page of its own.
 *
 * The catalog is built from the Registry's documentation index, one entry per
 * page, which is one entry per resource almost everywhere. Google is the
 * exception: it documents `google_project_iam_member`, `_iam_binding`,
 * `_iam_policy` and `_iam_audit_config` together on a single `google_project_iam`
 * page, and the same for every other IAM-bearing resource — around 180 of them.
 *
 * So those resources are absent from the catalog while being among the most
 * used in the provider, and without this the kit would call
 * `google_project_iam_member` a typo. Mapping the four suffixes back to the
 * shared page is what makes the lookup agree with reality.
 *
 * Returns undefined when the name is not one of those, so the caller falls
 * through to the ordinary answer.
 */
const IAM_SUFFIXES = ['_iam_member', '_iam_binding', '_iam_policy', '_iam_audit_config'];

function sharedDocPage(bare: string): string | undefined {
  for (const suffix of IAM_SUFFIXES) {
    if (bare.endsWith(suffix)) return `${bare.slice(0, -suffix.length)}_iam`;
  }
  return undefined;
}

/**
 * The catalogued names closest to one that is not in the catalog.
 *
 * Saying "azurerm_app_service_plan does not exist" is half an answer: the
 * question it leaves is what to write instead, and the catalog knows. Scoring
 * is by shared underscore-separated words, weighted toward a shared opening —
 * `app_service_plan` and `service_plan` share two of three words and the tail,
 * `postgresql_flexible_database` and `postgresql_flexible_server_database`
 * share three and the head — which is the shape provider renames take. Nothing
 * fancier is warranted: the candidates are a thousand names from one provider,
 * not free text.
 *
 * Returns nothing rather than a bad guess when no candidate shares at least
 * half the words, because a wrong suggestion in this position would be read as
 * authoritative.
 */
export function nearestTypes(
  target: CloudTarget,
  type: string,
  limit = 3,
): readonly string[] {
  const entry = catalogueFor(target);
  if (!entry) return [];

  const prefix = prefixFor(target);
  const bare = type.startsWith(prefix) ? type.slice(prefix.length) : type;
  const words = bare.split('_').filter(Boolean);
  if (words.length === 0) return [];

  const scored: { name: string; score: number }[] = [];
  for (const candidate of entry.resources) {
    const theirs = candidate.split('_').filter(Boolean);

    // Words matched one for one, so a candidate that repeats a word does not
    // score twice for it: `function_app_function` shares two words with
    // `function_app`, not three.
    const pool = [...theirs];
    let shared = 0;
    for (const word of words) {
      const at = pool.indexOf(word);
      if (at !== -1) {
        pool.splice(at, 1);
        shared += 1;
      }
    }
    if (shared * 2 < words.length) continue;

    /*
     * Overlap against the two names together, not against the shorter one.
     *
     * Scoring by shared words alone ranks `azurerm_app_service_certificate`
     * level with `azurerm_service_plan` for `azurerm_app_service_plan`, since
     * both share two. Dividing by the combined length breaks that the right
     * way: a rename usually drops or adds one word, so the true successor is
     * the candidate with the fewest words left over on either side.
     */
    const score = shared / (words.length + theirs.length - shared);
    scored.push({ name: prefix + candidate, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((s) => s.name);
}

export interface SearchHit {
  readonly target: CloudTarget;
  readonly type: string;
  readonly kind: 'resource' | 'data-source';
}

/** Find types whose name contains every term, across the catalogued providers. */
export function searchCatalog(
  query: string,
  options: { readonly targets?: readonly CloudTarget[]; readonly limit?: number } = {},
): readonly SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];

  const targets = options.targets ?? catalogued();
  const limit = options.limit ?? 50;
  const hits: SearchHit[] = [];

  for (const target of targets) {
    const push = (types: readonly string[], kind: 'resource' | 'data-source'): void => {
      for (const type of types) {
        if (hits.length >= limit) return;
        const haystack = type.toLowerCase();
        if (terms.every((term) => haystack.includes(term))) hits.push({ target, type, kind });
      }
    };
    push(resourceTypes(target), 'resource');
    push(dataSourceTypes(target), 'data-source');
  }
  return hits;
}

/** Total catalogued types, for reporting. */
export function catalogTotals(): { resources: number; dataSources: number; providers: number } {
  let resources = 0;
  let dataSources = 0;
  const targets = catalogued();
  for (const target of targets) {
    resources += resourceTypes(target).length;
    dataSources += dataSourceTypes(target).length;
  }
  return { resources, dataSources, providers: targets.length };
}

export function catalogAgeDays(today = new Date()): number {
  const fetched = Date.parse(`${CATALOG_FETCHED_AT}T00:00:00Z`);
  if (!Number.isFinite(fetched)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((today.getTime() - fetched) / 86_400_000));
}

/**
 * How trustworthy the catalog currently is.
 *
 * Three separate things can be wrong, and they need saying separately: it may be
 * old, it may be missing providers entirely, and the version it was built from
 * may no longer match what the kit pins.
 */
export function catalogFindings(today = new Date()): readonly Finding[] {
  const findings: Finding[] = [];
  const totals = catalogTotals();
  const missing = notCatalogued();
  const age = catalogAgeDays(today);

  findings.push(
    info(
      'terraform.catalog.summary',
      `Catalog holds ${totals.resources} resources and ${totals.dataSources} data sources across ${totals.providers} provider(s), fetched ${CATALOG_FETCHED_AT}.`,
      { source: 'Terraform Registry' },
    ),
  );

  if (missing.length > 0) {
    findings.push(
      warning(
        'terraform.catalog.incomplete',
        `${missing.length} provider(s) are not in the catalog: ${missing.join(', ')}. Resource names for those cannot be checked.`,
        {
          remediation: 'Run npm run catalog:update to fetch them from the registry.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  if (age > STALE_AFTER_DAYS) {
    findings.push(
      warning(
        'terraform.catalog.stale',
        `The catalog is ${age} days old, so resources added since then are unknown to it.`,
        { remediation: 'Run npm run catalog:update.', source: 'ArchToolKit' },
      ),
    );
  }

  for (const target of catalogued()) {
    const entry = catalogueFor(target);
    const provider = providerFor(target);
    if (entry && entry.version !== provider.observedVersion) {
      findings.push(
        warning(
          'terraform.catalog.version-drift',
          `The ${provider.label} catalog came from ${entry.version}, but the kit records ${provider.observedVersion}. Resource lists and version constraints disagree.`,
          { remediation: 'Run npm run catalog:update.', source: 'ArchToolKit' },
        ),
      );
    }
  }

  return findings;
}
