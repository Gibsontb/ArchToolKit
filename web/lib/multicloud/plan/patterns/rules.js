/**
 * The pattern rules (addendum A.4.3): ordinary `ItemRule`s, passed to
 * `decidePlan(plan, { extraRules: PATTERN_RULES })`, so they show in the
 * reasons like any other rule.
 *
 * Three structural rules apply to every app:
 * - `app.chosen-platform` eliminates the other platforms for every item of an
 *   app whose `AppPlan.platform` is set ("The application is placed on <p> by
 *   choice"); an item pinned elsewhere keeps its pin (the pin wins);
 * - `app.tier-pattern` restricts a component's items to its tier pattern's
 *   services: a platform without the tier pattern is eliminated, and a
 *   database keeps only managed services (managed-*) or only IaaS ones (vm,
 *   sap-certified);
 * - `app.pin-conflict` reports a pin that differs from the app's choice.
 *
 * The `pattern.*` rules come from the family files.
 */

import { info, warning } from '../../../core/findings.js';
import { DB_SERVICES } from '../db-catalog.js';
import { isDatabase,               } from '../decide/disposition.js';
import { rule,                                } from '../decide/engine.js';
import { PLATFORM_LABELS, platformOfService } from '../options.js';
                                                                   
import { APPLIANCE_RULES } from './appliances.js';
import { CONTAINER_RULES } from './containers.js';
import { FILE_RULES } from './file.js';
import { INFRA_RULES } from './infra.js';
import { LEGACY_RULES } from './legacy.js';
import { MICROSOFT_RULES } from './microsoft.js';
import { MIDDLEWARE_RULES } from './middleware.js';
import { appPlanFor, isNone, tierPatternOf } from './model.js';
import { ORACLE_APP_RULES } from './oracle-apps.js';
import { SAP_RULES } from './sap.js';
import { DB_TIER_MANAGED, tierTarget } from './tier-patterns.js';
import { VDI_RULES } from './vdi.js';

/** The platform the item's app is placed on by choice, if any. */
export function chosenPlatformOf(item          , ctx             )                       {
  return appPlanFor(ctx.appOf(item), ctx)?.platform;
}

/** The platform the item itself is pinned to (a workload pin, or a database's pinned service), if any. */
export function itemPin(item          )                       {
  if (isDatabase(item)) return item.pinService ? platformOfService(item.pinService) : undefined;
  return item.pin;
}

const label = (p          )         => PLATFORM_LABELS[p] ?? p;
const NO_PLATFORM_EFFECT = new Set(['saas', 'specialist', 'retire', 'retain']);

export const STRUCTURAL_RULES                     = [
  rule          ({
    id: 'app.chosen-platform',
    kind: 'any',
    verification: 'I',
    applies: (item, ctx) => {
      const chosen = chosenPlatformOf(item, ctx);
      if (!chosen) return false;
      const pin = itemPin(item);
      return pin === undefined || pin === chosen;
    },
    evaluate: (item, o, ctx) => {
      const chosen = chosenPlatformOf(item, ctx) ;
      return o.platform === chosen
        ? undefined
        : { eliminate: true, reason: `The application ${ctx.appOf(item)?.name ?? item.app} is placed on ${label(chosen)} by choice.` };
    },
  }),

  rule          ({
    id: 'app.tier-pattern',
    kind: 'any',
    verification: 'V-DOC',
    applies: (item, ctx) => appPlanFor(ctx.appOf(item), ctx) !== undefined,
    evaluate: (item, o, ctx) => {
      const tp = tierPatternOf(item, ctx, o.platform);
      if (!tp || NO_PLATFORM_EFFECT.has(tp)) return undefined;
      const target = tierTarget(tp, o.platform);
      if (isNone(target)) return { eliminate: true, reason: `The component's tier pattern (${tp}) does not exist on ${label(o.platform)}: ${target.none}` };
      if (isDatabase(item) && o.service) {
        const managed = DB_TIER_MANAGED[tp];
        const isManaged = DB_SERVICES[o.service].managed;
        if (managed === true && !isManaged) return { eliminate: true, reason: `The component's tier pattern (${tp}) needs a managed service; ${DB_SERVICES[o.service].label} is IaaS.` };
        if (managed === false && isManaged) return { eliminate: true, reason: `The component's tier pattern (${tp}) runs the database on a VM; ${DB_SERVICES[o.service].label} is a managed service.` };
      }
      return undefined;
    },
  }),

  rule          ({
    id: 'app.pin-conflict',
    kind: 'any',
    verification: 'I',
    applies: (item, ctx) => {
      const chosen = chosenPlatformOf(item, ctx);
      const pin = itemPin(item);
      return chosen !== undefined && pin !== undefined && pin !== chosen;
    },
    findings: (item, ctx) => {
      const chosen = chosenPlatformOf(item, ctx) ;
      const pin = itemPin(item) ;
      return [warning('app.pin-conflict', `${item.name} is pinned to ${label(pin)}, but its application is placed on ${label(chosen)}; the pin wins for this item.`, {
        path: `${isDatabase(item) ? 'databases' : 'workloads'}.${item.id}.${isDatabase(item) ? 'pinService' : 'pin'}`,
        remediation: 'Remove the pin to follow the application, or move the application to the pinned platform.',
      })];
    },
  }),
];

/** The A.4.9 engines, and the managed services that carry them natively (+2) or through a compatible API (+1). */
const NOSQL_ENGINES                      = new Set(['mongodb', 'redis', 'cassandra', 'elasticsearch']);
const COMPATIBLE_API                           = new Set             (['aws-docdb', 'azure-documentdb', 'oci-adb-mongo', 'aws-keyspaces', 'aws-opensearch', 'oci-opensearch']);

export const DATABASE_PATTERN_RULES                     = [
  rule          ({
    id: 'pattern.db.managed-nosql',
    kind: 'database',
    verification: 'I',
    source: 'https://docs.aws.amazon.com/documentdb/latest/developerguide/functional-differences.html',
    applies: (db) => NOSQL_ENGINES.has(db.engine),
    evaluate: (_db, o) => {
      if (!o.service || !DB_SERVICES[o.service].managed) return undefined;
      return COMPATIBLE_API.has(o.service)
        ? { delta: 1, reason: `${DB_SERVICES[o.service].label} is managed, but implements a compatible API rather than the engine itself: test the application against it.` }
        : { delta: 2, reason: `${DB_SERVICES[o.service].label} runs the engine as a managed service: patching, backup and failover are the provider's.` };
    },
    review: (db, chosen) =>
      chosen?.service && COMPATIBLE_API.has(chosen.service)
        ? [info('pattern.db.compatible-api', `${db.name}: ${DB_SERVICES[chosen.service].label} is API-compatible with ${db.engine}, not the engine itself; check the functional differences before the move.`, { source: DB_SERVICES[chosen.service].source })]
        : [],
  }),
];

/** Every pattern rule, structural first: pass as `extraRules`. */
export const PATTERN_RULES                     = Object.freeze([
  ...STRUCTURAL_RULES,
  ...DATABASE_PATTERN_RULES,
  ...SAP_RULES,
  ...ORACLE_APP_RULES,
  ...MICROSOFT_RULES,
  ...VDI_RULES,
  ...FILE_RULES,
  ...MIDDLEWARE_RULES,
  ...INFRA_RULES,
  ...CONTAINER_RULES,
  ...LEGACY_RULES,
  ...APPLIANCE_RULES,
]);

export const PATTERN_RULES_BY_ID                               = new Map(PATTERN_RULES.map((r) => [r.id, r]));
