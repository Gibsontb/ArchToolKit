/**
 * The Multi-Cloud Planner's decision engine (design section 2.5).
 *
 * `decidePlan(plan)` gives the `PlanDecision`; `whatIfItem` and
 * `whatIfEstate` answer the Decision screen's what-ifs; `RULES` is the rule
 * registry (add a rule set in `rules/index.ts`).
 */

export {
  ENGINE_VERSION, NO_ALTERNATIVE_MARGIN, CLOSE_MARGIN, decidePlan, evaluatePlan, evaluateItem, createContext, optionSpecs,
  effectiveEdition, compareOptions, activeRules, rule,
                                                                                                                           
} from './engine.js';
export { whatIfItem, whatIfEstate, licenceTotals,                                    } from './whatif.js';
export { RULES, RULE_SETS, RULES_BY_ID, withRules } from './rules/index.js';
export { workloadPlacement, methodFor, isDatabase,                               } from './disposition.js';
export { overheadOf } from './estate.js';
export { dependencyEdges } from './affinity.js';
