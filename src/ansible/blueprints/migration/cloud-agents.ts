/**
 * mig_cloud_agents: the cloud_agents role: the platform's guest agents, and
 * the EDR and vulnerability-scanner agents listed in group_vars
 * (edr_agents, scanner_agents), with their tokens from the vault.
 */

import { CLOUD_AGENTS } from '../../migration/roles/index.ts';
import { migrationBlueprint, PLATFORM_INPUT, text } from './common.ts';

export const MIG_CLOUD_AGENTS = migrationBlueprint({
  id: 'mig_cloud_agents',
  label: 'Migration – Cloud guest agents',
  description:
    "The platform's guest agents installed and running (SSM Agent and EC2Launch v2, the Azure VM agent, the Google guest environment and OS Config agent, the Oracle Cloud Agent or Cloudbase-Init), and on replicated VMs the other clouds' agents removed. Then the EDR and vulnerability-scanner agents in edr_agents / scanner_agents (group_vars) installed, registered with a token from their vault_* variable (no_log), enabled and running.",
  inputs: [PLATFORM_INPUT],
  roles: () => [CLOUD_AGENTS],
  vars: (v) => ({ mig_cloud_platform: text(v.platform, 'aws') }),
});
