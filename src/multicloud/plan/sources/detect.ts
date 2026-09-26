/**
 * Workload-type detection (addendum A.3.7) lives in `patterns/detect.ts`
 * (WP-16): one detector for the whole system. Re-exported here for the
 * source-side callers.
 */
export {
  detectType, applyDetection, detectWorkloads, confirmFinding, proposePattern,
  type Detection, type DetectionFacts, type DetectionOutcome,
} from '../patterns/detect.ts';
export { DETECTORS, SIGNAL_WEIGHTS, DETECTED_THRESHOLD, CONFIRM_THRESHOLD, type Detector } from '../patterns/detect-data.ts';
