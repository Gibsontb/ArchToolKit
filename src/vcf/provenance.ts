/**
 * Provenance tagging for VCF sizing and schema data.
 *
 * This toolkit generates real deployment configurations, so a number that came
 * from a blog post must never be indistinguishable from one that came from
 * Broadcom's own documentation. Every table entry carries a verification tag,
 * and the UI surfaces it, so the user always knows how much weight a figure
 * can bear.
 */

export type Verification =
  /** Verified against the official VCF Installer API reference. */
  | 'V-API'
  /** Verified against Broadcom TechDocs or a Broadcom KB article. */
  | 'V-DOC'
  /** Verified against a real, working 9.1.0.0 deployment spec. */
  | 'V-SPEC'
  /** Community source — indicative, not authoritative. */
  | 'C'
  /** Inferred — not directly stated by any source. */
  | 'I';

export interface Sourced<T> {
  readonly value: T;
  readonly verification: Verification;
  /** Where the figure came from, specific enough to re-check. */
  readonly source?: string;
  /** Anything the user should know before relying on it. */
  readonly caveat?: string;
}

export function sourced<T>(
  value: T,
  verification: Verification,
  source?: string,
  caveat?: string,
): Sourced<T> {
  return { value, verification, ...(source ? { source } : {}), ...(caveat ? { caveat } : {}) };
}

const CONFIDENCE_ORDER: Record<Verification, number> = {
  'V-API': 0,
  'V-DOC': 1,
  'V-SPEC': 2,
  C: 3,
  I: 4,
};

/** True when a figure is official (Broadcom API, docs, or a real working spec). */
export function isAuthoritative(verification: Verification): boolean {
  return verification === 'V-API' || verification === 'V-DOC' || verification === 'V-SPEC';
}

/**
 * The weakest tag across a set of inputs.
 *
 * A total built from one official and one community number is only as
 * trustworthy as the community number, and reporting it as official would be
 * misleading.
 */
export function weakestVerification(tags: readonly Verification[]): Verification {
  if (tags.length === 0) return 'I';
  return tags.reduce((worst, tag) =>
    CONFIDENCE_ORDER[tag] > CONFIDENCE_ORDER[worst] ? tag : worst,
  );
}

export const VERIFICATION_LABELS: Record<Verification, string> = {
  'V-API': 'Verified — VCF Installer API reference',
  'V-DOC': 'Verified — Broadcom TechDocs / KB',
  'V-SPEC': 'Verified — real working 9.1.0.0 spec',
  C: 'Community source — indicative only',
  I: 'Inferred — not directly documented',
};
