/**
 * VCF version comparison, and the behaviour that depends on it.
 *
 * Several documented rules change between patch releases rather than between
 * major versions, so "what VCF 9.1 does" is not a single answer. Pinning them to
 * a comparison against the target version keeps the builder honest instead of
 * hardcoding whichever release happened to be current when the code was written.
 */

/** 9.1.1.0 is GA, and the JSON specification workflow requires 9.1.1 or later. */
export const DEFAULT_VCF_VERSION = '9.1.1.0';

/** The minimum VCF Installer version that accepts a JSON specification file. */
export const MIN_JSON_SPEC_INSTALLER_VERSION = '9.1.1.0';

/**
 * The release that changed the VCF Automation pool from 5 addresses to 6, and
 * allowed them to be non-contiguous.
 */
export const AUTOMATION_SIX_IP_VERSION = '9.1.0.400';

/** The release where `small` became the default size for both deployment models. */
export const SMALL_DEFAULT_VERSION = '9.1.1.0';

/** Split a dotted version into numbers, tolerating any number of parts. */
export function parseVcfVersion(version: string): number[] {
  return version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareVcfVersion(a: string, b: string): number {
  const left = parseVcfVersion(a);
  const right = parseVcfVersion(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function atLeastVcfVersion(version: string, minimum: string): boolean {
  return compareVcfVersion(version, minimum) >= 0;
}

/**
 * Size of the VCF Automation IP pool.
 *
 * Broadcom documents 5 contiguous addresses for 9.1.0.0 through 9.1.0.300, and 6
 * (contiguous or not) from 9.1.0.400. The sixth is requested but not consumed.
 *
 * This settles a discrepancy the toolkit previously recorded as unresolved: a
 * real 9.1.0.0 spec was observed carrying 6 addresses where the docs then said
 * 5. The rule is a version boundary, not a contradiction.
 */
export function automationIpCount(version: string): number {
  return atLeastVcfVersion(version, AUTOMATION_SIX_IP_VERSION) ? 6 : 5;
}

/**
 * Default appliance size for a deployment model.
 *
 * In 9.1, `small` was the only option for the simple model and `medium` was the
 * default for HA. From 9.1.1, `small` is the default for both.
 */
export function defaultApplianceSize(version: string, ha: boolean): 'small' | 'medium' {
  if (!ha) return 'small';
  return atLeastVcfVersion(version, SMALL_DEFAULT_VERSION) ? 'small' : 'medium';
}
