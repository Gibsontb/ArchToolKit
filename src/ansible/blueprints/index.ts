/**
 * Every Ansible blueprint, grouped by platform.
 *
 * The platform is chosen once — by the decision matrix, or on the page — and
 * then this is the list of things that can be automated on it.
 */

import type { Blueprint, BlueprintGroup } from '../../kit/blueprint.ts';
import { withChoicesAll } from '../../kit/choices.ts';
import { withAnsibleProjectAll } from '../project.ts';
import { AWS_ANSIBLE } from './aws.ts';
import { AZURE_ANSIBLE } from './azure.ts';
import { GCP_ANSIBLE } from './gcp.ts';
import { OCI_ANSIBLE } from './oci.ts';
import { VMWARE_ANSIBLE } from './vmware.ts';
import { LINUX_ANSIBLE } from './linux.ts';
import { WINDOWS_ANSIBLE } from './windows.ts';
import { inventoryBlueprint, PREMIGRATION, POSTMIGRATION } from './estate.ts';

/** The estate blueprints follow; the page opens on them when an estate is loaded. */
function withEstate(group: BlueprintGroup, estate: readonly Blueprint[]): BlueprintGroup {
  return {
    ...group,
    blueprints: [...group.blueprints.map((b) => ({ ...b, group: b.group ?? 'Playbooks' })), ...estate],
  };
}

// withAnsibleProjectAll adds ansible.cfg, inventory/hosts.yml and a README to
// every playbook, so the zip runs as unzipped rather than matching no hosts.
export const ANSIBLE_BLUEPRINTS: readonly BlueprintGroup[] = withAnsibleProjectAll(withChoicesAll([
  AWS_ANSIBLE,
  AZURE_ANSIBLE,
  GCP_ANSIBLE,
  OCI_ANSIBLE,
  withEstate(VMWARE_ANSIBLE, [inventoryBlueprint('all'), PREMIGRATION, POSTMIGRATION]),
  withEstate(LINUX_ANSIBLE, [inventoryBlueprint('linux')]),
  withEstate(WINDOWS_ANSIBLE, [inventoryBlueprint('windows')]),
], 'ansible'));
