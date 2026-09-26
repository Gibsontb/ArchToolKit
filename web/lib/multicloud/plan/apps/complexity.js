/**
 * Complexity and risk per app (addendum A.10.17). The score lives in
 * governance/complexity.ts (WP-21); the app workspace reads it from here.
 */

export {
  appComplexity, estateComplexity, bandOf, criticalityBand, higherBand, downtimeFromDecision, crRiskOf, patternClass,
  COMPLEXITY_SOURCES, PATTERN_CLASS_POINTS, DOWNTIME_POINTS,
                                                                                                                                
} from '../governance/complexity.js';
