/**
 * The rule registry: every rule the engine runs, in evaluation order.
 *
 * To add rules (for SAP, Citrix / VDI, file servers, middleware, containers,
 * Unix, appliances, physical or other-hypervisor sources ...):
 *   1. write `rules/<topic>.ts` exporting `readonly AnyRule[]`, each built with
 *      `rule<Workload | Database | PlanItem>({ id, kind, verification, applies,
 *      evaluate, findings, review })`;
 *   2. add the array to `RULE_SETS` below.
 * Nothing else changes: the engine, the what-if, the decision record and the
 * decide.ts wrapper read rules only through this list. Order matters in one
 * way: when two rules eliminate the same option, the first one named here is
 * recorded as the reason.
 */

                                            
import { COMMERCIAL_RULES } from './commercial.js';
import { DATABASE_RULES } from './databases.js';
import { ELIMINATION_RULES } from './eliminations.js';
import { MICROSOFT_RULES } from './licensing-microsoft.js';
import { ORACLE_RULES } from './licensing-oracle.js';
import { REPORT_RULES } from './report-only.js';
import { SHAPE_RULES } from './shape.js';

export const RULE_SETS                                               = {
  eliminations: ELIMINATION_RULES,
  shape: SHAPE_RULES,
  commercial: COMMERCIAL_RULES,
  'licensing-microsoft': MICROSOFT_RULES,
  'licensing-oracle': ORACLE_RULES,
  databases: DATABASE_RULES,
  'report-only': REPORT_RULES,
};

/** Every rule, in order. */
export const RULES                     = Object.freeze(Object.values(RULE_SETS).flat());

/** Rule id to rule, for the decision record and the what-if. */
export const RULES_BY_ID                               = new Map(RULES.map((r) => [r.id, r]));

/** A registry with extra rules appended (pass the result as `EngineOptions.rules`). */
export function withRules(...extra                    )                     {
  return [...RULES, ...extra];
}
