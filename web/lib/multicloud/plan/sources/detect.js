/**
 * Workload-type detection (addendum A.3.7) lives in `patterns/detect.ts`
 * (WP-16): one detector for the whole system. Re-exported here for the
 * source-side callers.
 */
export {
  detectType, applyDetection, detectWorkloads, confirmFinding, proposePattern,
                                                             
} from '../patterns/detect.js';
export { DETECTORS, SIGNAL_WEIGHTS, DETECTED_THRESHOLD, CONFIRM_THRESHOLD,               } from '../patterns/detect-data.js';
