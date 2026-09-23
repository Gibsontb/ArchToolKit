/**
 * Every automation, grouped by where it runs.
 *
 * The platform here is a capability of VCF rather than a cloud, so this page
 * keeps its own selection: "I am writing a VCF Operations automation" says
 * nothing about which cloud the Terraform page should open on.
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import { AUTOMATION_PLATFORMS } from '../automation.ts';
import type { AutomationBlueprint } from '../from-automation.ts';
import { VCF_OPERATIONS_AUTOMATIONS } from './vcf-operations.ts';
import { NETWORKS_AUTOMATIONS, LOGS_AUTOMATIONS } from './vcf-networks-logs.ts';
import { VCF_AUTOMATION_AUTOMATIONS } from './vcf-automation.ts';
import { PIPELINE_AUTOMATIONS } from './pipeline.ts';

export const AUTOMATION_BLUEPRINTS: readonly BlueprintGroup[] = [
  { target: 'vcf-operations', label: AUTOMATION_PLATFORMS['vcf-operations'].label, blueprints: VCF_OPERATIONS_AUTOMATIONS },
  { target: 'vcf-operations-networks', label: AUTOMATION_PLATFORMS['vcf-operations-networks'].label, blueprints: NETWORKS_AUTOMATIONS },
  { target: 'vcf-operations-logs', label: AUTOMATION_PLATFORMS['vcf-operations-logs'].label, blueprints: LOGS_AUTOMATIONS },
  { target: 'vcf-automation', label: AUTOMATION_PLATFORMS['vcf-automation'].label, blueprints: VCF_AUTOMATION_AUTOMATIONS },
  { target: 'pipeline', label: AUTOMATION_PLATFORMS.pipeline.label, blueprints: PIPELINE_AUTOMATIONS },
];

/** Every automation blueprint, with its structured builder, in one list. */
export const AUTOMATIONS: readonly AutomationBlueprint[] = [
  ...VCF_OPERATIONS_AUTOMATIONS,
  ...NETWORKS_AUTOMATIONS,
  ...LOGS_AUTOMATIONS,
  ...VCF_AUTOMATION_AUTOMATIONS,
  ...PIPELINE_AUTOMATIONS,
];

export function automationFor(id: string): AutomationBlueprint | undefined {
  return AUTOMATIONS.find((blueprint) => blueprint.id === id);
}
