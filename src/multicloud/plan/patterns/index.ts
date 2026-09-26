/**
 * Application patterns (addendum A.4, WP-16): the catalogue, detection, the
 * pattern rules (pass `PATTERN_RULES` as `decidePlan`'s `extraRules`) and the
 * pattern designers (pass `withPatternMappers()` to `designPlan`).
 */

export * from './model.ts';
export { TIER_PATTERNS, tierTarget, tierAvailable, tierTerraformTypes, DB_TIER_MANAGED } from './tier-patterns.ts';
export {
  PATTERN_CATALOG, PATTERN_LIST, GENERIC_PATTERN, HONEST_PATH_PATTERNS, patternEntry, patternsOfFamily, patternsForType,
  defaultTierPattern, patternTerraformTypes, rankTierPatterns, allFacts, flaggedFacts, type RankedTierPattern,
} from './catalog.ts';
export { PATTERN_RULES, PATTERN_RULES_BY_ID, STRUCTURAL_RULES, chosenPlatformOf, itemPin } from './rules.ts';
export { detectType, applyDetection, detectWorkloads, confirmFinding, proposePattern, type Detection, type DetectionFacts, type DetectionOutcome } from './detect.ts';
export { DETECTORS, SIGNAL_WEIGHTS, DETECTED_THRESHOLD, CONFIRM_THRESHOLD, type Detector } from './detect-data.ts';
export {
  sapCertifiedMapper, extraDbMapper, PATTERN_MAPPERS, withPatternMappers, patternTargets, sizeFor, extraClassFor, hanaWorkloadsOn,
  type PatternTarget,
} from './designers.ts';
export { SAP_CERTIFIED, SAP_FETCHED_AT, SAP_SOURCES, SAP_FACTS, VCF_HANA_LIMITS, sapFit, certifiedTypes, type SapFit } from './sap-data.ts';
export { SAP_PATTERN_IDS, isHanaItem, hanaMemoryOf } from './sap.ts';
export { sessionHosts } from './vdi.ts';
export { FILE_PROTOCOLS, ONTAP_PLATFORMS } from './file.ts';
export { OPENSHIFT_OFFERS } from './containers.ts';
export { LEGACY_TARGETS, LEGACY_TYPES, legacyTypeOf, HPUX_EOS } from './legacy.ts';
export { EXCHANGE_EOS, SHAREPOINT_EOS } from './microsoft.ts';
export { GREENFIELD_INGRESS } from './greenfield.ts';
