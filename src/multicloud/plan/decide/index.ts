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
  type AnyRule, type ItemRule, type RuleContext, type RuleResult, type OptionSpec, type EngineOptions, type ItemEvaluation,
} from './engine.ts';
export { whatIfItem, whatIfEstate, licenceTotals, type EstateMove, type EstateWhatIf } from './whatif.ts';
export { RULES, RULE_SETS, RULES_BY_ID, withRules } from './rules/index.ts';
export { workloadPlacement, methodFor, isDatabase, type Placement, type PlanItem } from './disposition.ts';
export { overheadOf } from './estate.ts';
export { dependencyEdges } from './affinity.ts';
