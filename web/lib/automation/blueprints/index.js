/**
 * Every automation, grouped by where it runs.
 *
 * The platform here is a capability of VCF rather than a cloud, so this page
 * keeps its own selection: "I am writing a VCF Operations automation" says
 * nothing about which cloud the Terraform page should open on.
 */

                                                             
import { AUTOMATION_PLATFORMS } from '../automation.js';
                                                                 
import { VCF_OPERATIONS_AUTOMATIONS } from './vcf-operations.js';
import { NETWORKS_AUTOMATIONS, LOGS_AUTOMATIONS } from './vcf-networks-logs.js';
import { VCF_AUTOMATION_AUTOMATIONS } from './vcf-automation.js';
import { PIPELINE_AUTOMATIONS } from './pipeline.js';

export const AUTOMATION_BLUEPRINTS                            = [
  { target: 'vcf-operations', label: AUTOMATION_PLATFORMS['vcf-operations'].label, blueprints: VCF_OPERATIONS_AUTOMATIONS },
  { target: 'vcf-operations-networks', label: AUTOMATION_PLATFORMS['vcf-operations-networks'].label, blueprints: NETWORKS_AUTOMATIONS },
  { target: 'vcf-operations-logs', label: AUTOMATION_PLATFORMS['vcf-operations-logs'].label, blueprints: LOGS_AUTOMATIONS },
  { target: 'vcf-automation', label: AUTOMATION_PLATFORMS['vcf-automation'].label, blueprints: VCF_AUTOMATION_AUTOMATIONS },
  { target: 'pipeline', label: AUTOMATION_PLATFORMS.pipeline.label, blueprints: PIPELINE_AUTOMATIONS },
];

/** Every automation blueprint, with its structured builder, in one list. */
export const AUTOMATIONS                                 = [
  ...VCF_OPERATIONS_AUTOMATIONS,
  ...NETWORKS_AUTOMATIONS,
  ...LOGS_AUTOMATIONS,
  ...VCF_AUTOMATION_AUTOMATIONS,
  ...PIPELINE_AUTOMATIONS,
];

export function automationFor(id        )                                  {
  return AUTOMATIONS.find((blueprint) => blueprint.id === id);
}
