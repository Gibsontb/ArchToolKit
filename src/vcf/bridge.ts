/**
 * Carrying a sizing result into the specification builder.
 *
 * The two tools already agree on the facts — host count, storage type, failures
 * to tolerate, how many addresses each pool needs — but until now a person had
 * to read them off one screen and retype them into another. Retyping is where
 * the numbers drift, and a spec whose pools disagree with the sizing that
 * justified them is worse than one built from scratch.
 *
 * This is deliberately a partial plan: sizing knows nothing about names, domains
 * or VLANs, and inventing them here would put guesses in front of the user as
 * though they were derived.
 */

import type { SizingResult, SizingInput } from './sizing.ts';
import type { DeploymentPlan } from './spec-builder.ts';
import type { DeploymentScenario } from './scenarios.ts';

/** The deployment scenario a sizing path implies, where one does. */
export function scenarioForPath(path: SizingInput['path']): DeploymentScenario | undefined {
  switch (path) {
    case 'greenfield':
      return 'new-vcf-fleet';
    case 'brownfield-converge':
      return 'converge-to-vcf-fleet';
    // Importing an existing estate as a workload domain is a day-2 operation,
    // not a bring-up, so no bring-up scenario corresponds to it.
    case 'brownfield-import':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The part of a deployment plan a sizing result determines.
 *
 * Pool sizes are carried as counts rather than ranges: the builder allocates the
 * actual addresses from the subnets it is given, and it should keep doing that —
 * what sizing contributes is how many are needed.
 */
export function sizingToPlan(result: SizingResult): Partial<DeploymentPlan> {
  const { input } = result;
  const scenario = scenarioForPath(input.path);

  return {
    hostCount: input.hostCount,
    storage: input.storage,
    // The spec builder's profile is the HA split only; the sizing profile also
    // carries a scale, which maps to the appliance sizes instead.
    profile: input.profile === 'simple' ? 'simple' : 'ha',
    failuresToTolerate: result.storage.ftt,
    ...(scenario ? { scenario } : {}),
    ...(input.pnicsPerHost ? { pnicsPerHost: input.pnicsPerHost } : {}),
    ...(input.includeAutomation !== undefined
      ? { includeAutomation: input.includeAutomation }
      : {}),
    ...(input.automationSize ? { automationSize: input.automationSize } : {}),
    // Counts come from the sizing model so the emitted pools match the sizing
    // that justified them.
    vcfmsPool: { count: result.ips.vcfmsRecommended },
    automationPool: { count: result.ips.automationIps },
    tepPool: { count: result.ips.tepIps },
  };
}

/** A one-line description of what a sizing result contributes, for a banner. */
export function describeSizingHandoff(result: SizingResult): string {
  const { input } = result;
  const profile = input.profile === 'simple' ? 'simple' : 'HA';
  return `${input.hostCount} hosts, ${input.storage}, ${profile} profile, FTT ${result.storage.ftt}, ${result.ips.totalRecommended} addresses recommended`;
}
