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

import { info, warning } from '../../../core/findings.ts';
import { DB_SERVICES } from '../db-catalog.ts';
import { isDatabase, type PlanItem } from '../decide/disposition.ts';
import { rule, type AnyRule, type RuleContext } from '../decide/engine.ts';
import { PLATFORM_LABELS, platformOfService } from '../options.ts';
import type { Database, DbServiceId, Platform } from '../types.ts';
import { APPLIANCE_RULES } from './appliances.ts';
import { CONTAINER_RULES } from './containers.ts';
import { FILE_RULES } from './file.ts';
import { INFRA_RULES } from './infra.ts';
import { LEGACY_RULES } from './legacy.ts';
import { MICROSOFT_RULES } from './microsoft.ts';
import { MIDDLEWARE_RULES } from './middleware.ts';
import { appPlanFor, isNone, tierPatternOf } from './model.ts';
import { ORACLE_APP_RULES } from './oracle-apps.ts';
import { SAP_RULES } from './sap.ts';
import { DB_TIER_MANAGED, tierTarget } from './tier-patterns.ts';
import { VDI_RULES } from './vdi.ts';

/** The platform the item's app is placed on by choice, if any. */
export function chosenPlatformOf(item: PlanItem, ctx: RuleContext): Platform | undefined {
  return appPlanFor(ctx.appOf(item), ctx)?.platform;
}

/** The platform the item itself is pinned to (a workload pin, or a database's pinned service), if any. */
export function itemPin(item: PlanItem): Platform | undefined {
  if (isDatabase(item)) return item.pinService ? platformOfService(item.pinService) : undefined;
  return item.pin;
}

const label = (p: Platform): string => PLATFORM_LABELS[p] ?? p;
const NO_PLATFORM_EFFECT = new Set(['saas', 'specialist', 'retire', 'retain']);

export const STRUCTURAL_RULES: readonly AnyRule[] = [
  rule<PlanItem>({
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
      const chosen = chosenPlatformOf(item, ctx)!;
      return o.platform === chosen
        ? undefined
        : { eliminate: true, reason: `The application ${ctx.appOf(item)?.name ?? item.app} is placed on ${label(chosen)} by choice.` };
    },
  }),

  rule<PlanItem>({
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

  rule<PlanItem>({
    id: 'app.pin-conflict',
    kind: 'any',
    verification: 'I',
    applies: (item, ctx) => {
      const chosen = chosenPlatformOf(item, ctx);
      const pin = itemPin(item);
      return chosen !== undefined && pin !== undefined && pin !== chosen;
    },
    findings: (item, ctx) => {
      const chosen = chosenPlatformOf(item, ctx)!;
      const pin = itemPin(item)!;
      return [warning('app.pin-conflict', `${item.name} is pinned to ${label(pin)}, but its application is placed on ${label(chosen)}; the pin wins for this item.`, {
        path: `${isDatabase(item) ? 'databases' : 'workloads'}.${item.id}.${isDatabase(item) ? 'pinService' : 'pin'}`,
        remediation: 'Remove the pin to follow the application, or move the application to the pinned platform.',
      })];
    },
  }),
];

/** The A.4.9 engines, and the managed services that carry them natively (+2) or through a compatible API (+1). */
const NOSQL_ENGINES: ReadonlySet<string> = new Set(['mongodb', 'redis', 'cassandra', 'elasticsearch']);
const COMPATIBLE_API: ReadonlySet<DbServiceId> = new Set<DbServiceId>(['aws-docdb', 'azure-documentdb', 'oci-adb-mongo', 'aws-keyspaces', 'aws-opensearch', 'oci-opensearch']);

export const DATABASE_PATTERN_RULES: readonly AnyRule[] = [
  rule<Database>({
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
export const PATTERN_RULES: readonly AnyRule[] = Object.freeze([
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

export const PATTERN_RULES_BY_ID: ReadonlyMap<string, AnyRule> = new Map(PATTERN_RULES.map((r) => [r.id, r]));
