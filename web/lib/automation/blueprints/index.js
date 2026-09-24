/**
 * Every automation, grouped by where it runs.
 *
 * The platform here is a capability of VCF rather than a cloud, so this page
 * keeps its own selection: "I am writing a VCF Operations automation" says
 * nothing about which cloud the Terraform page should open on.
 *
 * Within each platform the order is the order the work is done in: set it up,
 * write the content, then automate on top of it.
 */

                                                             
import { AUTOMATION_PLATFORMS } from '../automation.js';
                                                                 
import { VCF_OPERATIONS_AUTOMATIONS } from './vcf-operations.js';
import { VCF_OPERATIONS_SETUP } from './vcf-operations-setup.js';
import { VCF_OPERATIONS_CONTENT } from './vcf-operations-content.js';
import { NETWORKS_AUTOMATIONS } from './vcf-networks-logs.js';
import { NETWORKS_MORE } from './vcf-logs-networks-more.js';
import { VCF_AUTOMATION_AUTOMATIONS } from './vcf-automation.js';
import { VCF_AUTOMATION_SETUP } from './vcf-automation-setup.js';
import { VCF_AUTOMATION_EXTEND } from './vcf-automation-extend.js';
import { VCF_FLEET } from './vcf-fleet.js';
import { VCF_TAGS } from './vcf-tags.js';
import { VCF_FLEET_91 } from './vcf-fleet-91.js';
import { VCF_OPS_COST } from './vcf-ops-cost.js';
import { VCF_OPS_OPERATE, VCF_OPS_LOGS_91 } from './vcf-ops-operate.js';
import { VCF_OPS_BUILD, NETWORKS_91 } from './vcf-ops-build.js';
import { VCF_AUTOMATION_91 } from './vcf-automation-91.js';

const OPERATIONS = [...VCF_OPERATIONS_SETUP, ...VCF_OPERATIONS_CONTENT, ...VCF_OPS_BUILD, ...VCF_OPERATIONS_AUTOMATIONS, ...VCF_OPS_OPERATE, ...VCF_OPS_COST];
const NETWORKS = [...NETWORKS_MORE, ...NETWORKS_91, ...NETWORKS_AUTOMATIONS];
const LOGS = [...VCF_OPS_LOGS_91];
const AUTOMATION = [...VCF_AUTOMATION_91, ...VCF_AUTOMATION_SETUP, ...VCF_AUTOMATION_AUTOMATIONS, ...VCF_AUTOMATION_EXTEND];
// Tags first: they are what every other fleet automation scopes by.
const FLEET = [...VCF_TAGS, ...VCF_FLEET_91, ...VCF_FLEET];

export const AUTOMATION_BLUEPRINTS                            = [
  { target: 'vcf-operations', label: AUTOMATION_PLATFORMS['vcf-operations'].label, blueprints: OPERATIONS },
  { target: 'vcf-operations-networks', label: AUTOMATION_PLATFORMS['vcf-operations-networks'].label, blueprints: NETWORKS },
  { target: 'vcf-operations-logs', label: AUTOMATION_PLATFORMS['vcf-operations-logs'].label, blueprints: LOGS },
  { target: 'vcf-automation', label: AUTOMATION_PLATFORMS['vcf-automation'].label, blueprints: AUTOMATION },
  { target: 'vcf-fleet', label: AUTOMATION_PLATFORMS['vcf-fleet'].label, blueprints: FLEET },
];

/** Every automation blueprint, with its structured builder, in one list. */
export const AUTOMATIONS                                 = [...OPERATIONS, ...NETWORKS, ...LOGS, ...AUTOMATION, ...FLEET];

export function automationFor(id        )                                  {
  return AUTOMATIONS.find((blueprint) => blueprint.id === id);
}
