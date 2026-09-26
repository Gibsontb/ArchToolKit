/**
 * mig_cloud_agents: the cloud_agents role.
 */

import { CLOUD_AGENTS } from '../../migration/roles/index.js';
import { migrationBlueprint, PLATFORM_INPUT, text } from './common.js';

export const MIG_CLOUD_AGENTS = migrationBlueprint({
  id: 'mig_cloud_agents',
  label: 'Migration – Cloud guest agents',
  description:
    "The platform's guest agents installed and running (SSM Agent and EC2Launch v2, the Azure VM agent, the Google guest environment and OS Config agent, the Oracle Cloud Agent or Cloudbase-Init), and on replicated VMs the other clouds' agents removed.",
  inputs: [PLATFORM_INPUT],
  roles: () => [CLOUD_AGENTS],
  vars: (v) => ({ mig_cloud_platform: text(v.platform, 'aws') }),
});
