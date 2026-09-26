/**
 * mig_vmware_tools_removal: the vmware_tools_removal role.
 */

import { VMWARE_TOOLS_REMOVAL } from '../../migration/roles/index.ts';
import { migrationBlueprint, PLATFORM_INPUT, text } from './common.ts';

export const MIG_VMWARE_TOOLS_REMOVAL = migrationBlueprint({
  id: 'mig_vmware_tools_removal',
  label: 'Migration – Remove VMware Tools',
  description: 'Remove open-vm-tools (Linux) or VMware Tools (Windows, by its product code) from VMs that now run on a hyperscaler; a host still on vSphere keeps them.',
  inputs: [PLATFORM_INPUT],
  roles: () => [VMWARE_TOOLS_REMOVAL],
  vars: (v) => ({ mig_cloud_platform: text(v.platform, 'aws') }),
});
