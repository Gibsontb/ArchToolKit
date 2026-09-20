/**
 * The Terraform Maps.
 *
 * The generator answers "build me one of these". The map answers the question
 * that comes before it: given a domain — networking, identity, data — which
 * resource is the one to reach for on this cloud, and what is the pattern
 * around it. The previous toolkit kept one of these as a standalone page per
 * cloud; here they are data, so a single page renders all four and the names in
 * them are checked against the same committed provider catalog the blueprints
 * are checked against.
 *
 * That check is why this is worth having as data rather than as prose. A map
 * that still names `azurerm_app_service_plan` two provider releases after it
 * became `azurerm_service_plan` is worse than no map: it reads as authoritative
 * and sends you to a resource that no longer exists. `mapFindings` says so on
 * the page rather than leaving you to discover it at plan time.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import { classifyType, nearestTypes } from './catalog.ts';
import type { CloudTarget } from './providers.ts';

/**
 * One line of a domain table.
 *
 * The cells are kept as a list rather than as named fields because the original
 * pages do not agree on a column set: some tables are Domain / Services /
 * Resources / Pattern, others Service / Resources / What You Decide. Flattening
 * them into one shape would mean inventing content for the columns a given
 * table never had. So the headers travel with the table, the cells travel in
 * their order, and `resources` carries the resource types named anywhere in the
 * row — which is what the catalog check reads and what the page marks up.
 */
export interface MapRow {
  readonly cells: readonly string[];
  readonly resources: readonly string[];
}

export interface MapTable {
  readonly headers: readonly string[];
  readonly rows: readonly MapRow[];
}

/** A worked example, collapsed until asked for. */
export interface MapExample {
  readonly title: string;
  readonly note?: string;
  readonly code: string;
}

/** One domain: networking, identity, compute. */
export interface MapSection {
  readonly id: string;
  readonly title: string;
  /** Short label in the corner of the heading. */
  readonly badge?: string;
  readonly tagline?: string;
  readonly tables?: readonly MapTable[];
  /** Prose, where the original used a bullet that named no resource. */
  readonly notes?: readonly string[];
  /** Starter blocks — provider pins, backend configuration. */
  readonly code?: readonly string[];
  readonly examples?: readonly MapExample[];
}

export interface CloudMap {
  /** Platform id, matching the shared target vocabulary. */
  readonly target: CloudTarget;
  readonly label: string;
  readonly title: string;
  readonly blurb: string;
  readonly sections: readonly MapSection[];
}

/** Every resource name a map claims exists, deduplicated, in the order given. */
export function resourcesIn(map: CloudMap): readonly string[] {
  const seen = new Set<string>();
  for (const section of map.sections) {
    for (const table of section.tables ?? []) {
      for (const row of table.rows) {
        for (const name of row.resources) seen.add(name);
      }
    }
  }
  return [...seen];
}

/**
 * Only names shaped like a resource are checked.
 *
 * The resource column also carries module references, attribute names and the
 * odd piece of prose in the same `<code>` styling, and calling one of those a
 * missing resource would be noise rather than a finding.
 */
const RESOURCE_SHAPED = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/**
 * Terraform's own vocabulary, which is shaped exactly like a resource type.
 *
 * The maps talk about using `for_each` and `prevent_destroy` in the same
 * `<code>` styling they use for resource names, so without this the page would
 * report that `for_each` has been removed from the provider.
 */
const LANGUAGE_WORDS = new Set([
  'for_each',
  'depends_on',
  'prevent_destroy',
  'create_before_destroy',
  'ignore_changes',
  'replace_triggered_by',
]);

/**
 * The provider prefix a target's catalog covers.
 *
 * A map may reasonably name a resource from a sibling provider — the Azure map
 * uses `azuread_group` for directory objects, which the `azurerm` catalog has
 * never heard of and never will. That is not a stale name, it is a different
 * provider, so it is left unchecked rather than reported.
 */
const CATALOGUED_PREFIX: Partial<Record<CloudTarget, string>> = {
  aws: 'aws_',
  azure: 'azurerm_',
  google: 'google_',
  oci: 'oci_',
  vsphere: 'vsphere_',
};

function isCheckable(target: CloudTarget, name: string): boolean {
  if (!RESOURCE_SHAPED.test(name)) return false;
  if (LANGUAGE_WORDS.has(name)) return false;
  const prefix = CATALOGUED_PREFIX[target];
  return prefix === undefined || name.startsWith(prefix);
}

/**
 * What to say about one name on the page.
 *
 * The page and the findings panel have to agree, and the way to guarantee that
 * is for both to come through here. Marking `azuread_group` as stale because
 * the `azurerm` catalog has never heard of it — which is what asking the
 * catalog directly does — would be wrong in exactly the place a reader is most
 * likely to trust it.
 */
export type NameStatus = 'resource' | 'data-source' | 'stale' | 'unchecked';

export function nameStatus(target: CloudTarget, name: string): NameStatus {
  if (!isCheckable(target, name)) return 'unchecked';
  const kind = classifyType(target, name);
  if (kind === 'resource') return 'resource';
  if (kind === 'data-source') return 'data-source';
  if (kind === 'uncatalogued') return 'unchecked';
  return 'stale';
}

/** How many of a map's names the catalog recognises. */
export function mapCoverage(map: CloudMap): {
  checked: number;
  known: number;
  unknown: readonly string[];
  uncatalogued: boolean;
} {
  const names = resourcesIn(map).filter((n) => isCheckable(map.target, n));
  const unknown: string[] = [];
  let known = 0;
  let uncatalogued = false;

  for (const name of names) {
    const status = nameStatus(map.target, name);
    if (status === 'unchecked') {
      uncatalogued = true;
      continue;
    }
    if (status === 'stale') unknown.push(name);
    else known += 1;
  }
  return { checked: names.length, known, unknown: unknown.sort(), uncatalogued };
}

export function mapFindings(map: CloudMap): readonly Finding[] {
  const { checked, known, unknown, uncatalogued } = mapCoverage(map);

  if (uncatalogued) {
    return [
      info(
        'terraform.map.uncatalogued',
        `No catalog is loaded for ${map.label}, so the ${checked} resource name(s) on this map were not checked.`,
      ),
    ];
  }

  if (unknown.length === 0) {
    return [
      info(
        'terraform.map.verified',
        `All ${known} resource name(s) on this map exist in the committed provider catalog.`,
      ),
    ];
  }

  /*
   * One finding per stale name, not one listing them all.
   *
   * Each carries the catalog's nearest match, because "azurerm_app_service_plan
   * does not exist" leaves open the question the reader actually has. The
   * suggestion is a suggestion — it leads with the closest name and shows the
   * runners-up — since a rename occasionally splits one resource into two and
   * no single answer is right.
   */
  return unknown.map((name) => {
    const nearest = nearestTypes(map.target, name);
    return warning(
      'terraform.map.unknown-resource',
      `${name} is not in the committed provider catalog, so it has been renamed or removed since this map was written.`,
      {
        path: name,
        remediation:
          nearest.length === 0
            ? 'Look it up in the registry and use whatever replaced it.'
            : `The closest catalogued name is ${nearest[0]}${
                nearest.length > 1 ? ` (then ${nearest.slice(1).join(', ')})` : ''
              }.`,
      },
    );
  });
}
