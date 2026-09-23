/**
 * An automation, as the files someone can apply.
 *
 * Whatever the platform wants — a suite-API payload, a cloud template, a
 * runbook — plus the README that carries the contract. They come from one
 * structure, so the README cannot describe an automation that does something
 * else, which is the usual fate of a README written a week later by someone
 * who was told what it was meant to do.
 */

import type { Blueprint, BlueprintValues, BuildResult } from '../kit/blueprint.ts';
import type { Finding } from '../core/findings.ts';
import { renderReadme, slugOf, standingFindings, type Automation, type AutomationPlatform } from './automation.ts';

export interface AutomationBlueprint extends Blueprint {
  /** The platform this writes for, so the page can group by it. */
  readonly platform: AutomationPlatform;
  /** The structured automation, for the tests and the findings. */
  readonly automation: (values: BlueprintValues, name: string) => Automation;
}

export function automationFiles(automation: Automation, name: string): BuildResult {
  const base = slugOf(name, 'automation');
  const findings: Finding[] = [...(automation.findings ?? []), ...standingFindings(automation)];

  return {
    files: {
      ...automation.files,
      'README.md': renderReadme(automation, base),
    },
    findings,
  };
}

/**
 * Declare a blueprint from an automation builder.
 *
 * The page sees an ordinary `Blueprint`; the tests see the structure
 * underneath, which is how they can check that everything irreversible has a
 * guardrail without reading the generated YAML.
 */
export function automationBlueprint(
  spec: Omit<Blueprint, 'build' | 'emits'> & {
    readonly platform: AutomationPlatform;
    readonly emits?: readonly string[];
    readonly automation: (values: BlueprintValues, name: string) => Automation;
  },
): AutomationBlueprint {
  return {
    ...spec,
    emits: spec.emits ?? [],
    build: (values: BlueprintValues, name: string) => automationFiles(spec.automation(values, name), name),
  };
}
