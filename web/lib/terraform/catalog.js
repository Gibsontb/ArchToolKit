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

import { info, warning,              } from '../core/findings.js';
import { PROVIDERS, providerFor,                  } from './providers.js';
import { CATALOG_DATA, CATALOG_FETCHED_AT } from './catalog-data.js';

/** Beyond this, the catalog is old enough to be worth mentioning. */
const STALE_AFTER_DAYS = 90;

                               
                               
                          
                                                    
                           
                                        
                                          
 

function prefixFor(target             )         {
  return target === 'azure' ? 'azurerm_' : `${target}_`;
}

const cache = new Map                           ();

/** The catalogued providers. Absent ones have simply not been fetched. */
export function catalogueFor(target             )                           {
  const cached = cache.get(target);
  if (cached) return cached;

  const raw = CATALOG_DATA[target];
  if (!raw) return undefined;

  const split = (value        )           => (value ? value.split(',').filter(Boolean) : []);
  const entry               = {
    target,
    source: raw.source,
    version: raw.version,
    resources: split(raw.resources),
    dataSources: split(raw.dataSources),
  };
  cache.set(target, entry);
  return entry;
}

export function catalogued()                         {
  return PROVIDERS.map((p) => p.target).filter((t) => CATALOG_DATA[t] !== undefined);
}

export function notCatalogued()                         {
  return PROVIDERS.map((p) => p.target).filter((t) => CATALOG_DATA[t] === undefined);
}

/** Full resource type names, e.g. `aws_vpc`. */
export function resourceTypes(target             )                    {
  const entry = catalogueFor(target);
  if (!entry) return [];
  const prefix = prefixFor(target);
  return entry.resources.map((name) => prefix + name);
}

export function dataSourceTypes(target             )                    {
  const entry = catalogueFor(target);
  if (!entry) return [];
  const prefix = prefixFor(target);
  return entry.dataSources.map((name) => prefix + name);
}

                                                                               

/**
 * Whether a type exists.
 *
 * `uncatalogued` is deliberately distinct from `unknown`: not knowing is not the
 * same as knowing it is wrong, and treating the two alike would have the kit
 * reject perfectly good resources simply because nobody had refreshed the list.
 */
export function classifyType(target             , type        )           {
  const entry = catalogueFor(target);
  if (!entry) return 'uncatalogued';
  const prefix = prefixFor(target);
  const bare = type.startsWith(prefix) ? type.slice(prefix.length) : type;
  if (entry.resources.includes(bare)) return 'resource';
  if (entry.dataSources.includes(bare)) return 'data-source';
  return 'unknown';
}

                            
                               
                        
                                            
 

/** Find types whose name contains every term, across the catalogued providers. */
export function searchCatalog(
  query        ,
  options                                                                         = {},
)                       {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];

  const targets = options.targets ?? catalogued();
  const limit = options.limit ?? 50;
  const hits              = [];

  for (const target of targets) {
    const push = (types                   , kind                            )       => {
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
export function catalogTotals()                                                                {
  let resources = 0;
  let dataSources = 0;
  const targets = catalogued();
  for (const target of targets) {
    resources += resourceTypes(target).length;
    dataSources += dataSourceTypes(target).length;
  }
  return { resources, dataSources, providers: targets.length };
}

export function catalogAgeDays(today = new Date())         {
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
export function catalogFindings(today = new Date())                     {
  const findings            = [];
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
