/**
 * Findings are the universal currency for anything the toolkit wants to tell the
 * user about their input: schema violations, sizing shortfalls, unsupported
 * brownfield topologies, migration blockers.
 *
 * Every engine in the toolkit emits Findings rather than throwing or returning
 * bare booleans, so the UI can render them uniformly and the user always gets
 * the *reason*, not just a red border.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  /** Stable machine-readable id, e.g. "vcf.network.subnet-too-small". */
  readonly code: string;
  readonly severity: Severity;
  /** One sentence stating the problem in the user's terms. */
  readonly message: string;
  /** Dotted path to the offending field, e.g. "networkSpecs[0].subnet". */
  readonly path?: string;
  /** What the user should do about it. */
  readonly remediation?: string;
  /**
   * Where the rule comes from. Sizing and schema rules are only trustworthy if
   * they can be traced, so engines that encode vendor rules cite them.
   */
  readonly source?: string;
}

export function error(
  code: string,
  message: string,
  extra: Partial<Omit<Finding, 'code' | 'message' | 'severity'>> = {},
): Finding {
  return { code, message, severity: 'error', ...extra };
}

export function warning(
  code: string,
  message: string,
  extra: Partial<Omit<Finding, 'code' | 'message' | 'severity'>> = {},
): Finding {
  return { code, message, severity: 'warning', ...extra };
}

export function info(
  code: string,
  message: string,
  extra: Partial<Omit<Finding, 'code' | 'message' | 'severity'>> = {},
): Finding {
  return { code, message, severity: 'info', ...extra };
}

export function hasErrors(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

export function countBySeverity(
  findings: readonly Finding[],
): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** Errors first, then warnings, then info; stable within a severity. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
