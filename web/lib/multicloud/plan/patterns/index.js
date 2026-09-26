/**
 * Application patterns (addendum A.4, WP-16): the catalogue, detection, the
 * pattern rules (pass `PATTERN_RULES` as `decidePlan`'s `extraRules`) and the
 * pattern designers (pass `withPatternMappers()` to `designPlan`).
 */

export * from './model.js';
export { TIER_PATTERNS, tierTarget, tierAvailable, tierTerraformTypes, DB_TIER_MANAGED } from './tier-patterns.js';
export {
  PATTERN_CATALOG, PATTERN_LIST, GENERIC_PATTERN, HONEST_PATH_PATTERNS, patternEntry, patternsOfFamily, patternsForType,
  defaultTierPattern, patternTerraformTypes, rankTierPatterns, allFacts, flaggedFacts,                        
} from './catalog.js';
export { PATTERN_RULES, PATTERN_RULES_BY_ID, STRUCTURAL_RULES, chosenPlatformOf, itemPin } from './rules.js';
export { detectType, applyDetection, detectWorkloads, confirmFinding, proposePattern,                                                            } from './detect.js';
export { DETECTORS, SIGNAL_WEIGHTS, DETECTED_THRESHOLD, CONFIRM_THRESHOLD,               } from './detect-data.js';
export {
  sapCertifiedMapper, extraDbMapper, PATTERN_MAPPERS, withPatternMappers, patternTargets, sizeFor, extraClassFor, hanaWorkloadsOn,
                     
} from './designers.js';
export { SAP_CERTIFIED, SAP_FETCHED_AT, SAP_SOURCES, SAP_FACTS, VCF_HANA_LIMITS, sapFit, certifiedTypes,             } from './sap-data.js';
export { SAP_PATTERN_IDS, isHanaItem, hanaMemoryOf } from './sap.js';
export { sessionHosts } from './vdi.js';
export { FILE_PROTOCOLS, ONTAP_PLATFORMS } from './file.js';
export { OPENSHIFT_OFFERS } from './containers.js';
export { LEGACY_TARGETS, LEGACY_TYPES, legacyTypeOf, HPUX_EOS } from './legacy.js';
export { EXCHANGE_EOS, SHAREPOINT_EOS } from './microsoft.js';
export { GREENFIELD_INGRESS } from './greenfield.js';
