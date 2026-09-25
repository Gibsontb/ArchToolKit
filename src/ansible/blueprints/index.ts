/**
 * Every Ansible blueprint, grouped by platform.
 *
 * The platform is chosen once — by the decision matrix, or on the page — and
 * then this is the list of things that can be automated on it.
 */

import type { Blueprint, BlueprintGroup } from '../../kit/blueprint.ts';
import { derive } from '../../kit/blueprint.ts';
import { moduleBlueprintsByPlatform, newPlatformGroups } from '../module-blueprints.ts';
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
import { NETWORK_PLAYBOOKS } from './network.ts';
import { CONTAINERS_PLAYBOOKS } from './containers.ts';
import { DATABASES_PLAYBOOKS } from './databases.ts';
import { STORAGE_PLAYBOOKS } from './storage.ts';
import { PRIVATE_CLOUDS_PLAYBOOKS } from './private-clouds.ts';
import { OPERATIONS_PLAYBOOKS } from './operations.ts';

/** The estate blueprints follow; the page opens on them when an estate is loaded. */
function withEstate(group: BlueprintGroup, estate: readonly Blueprint[]): BlueprintGroup {
  return {
    ...group,
    blueprints: [...group.blueprints.map((b) => (b.group ? b : derive(b, { group: 'Playbooks' }))), ...estate],
  };
}

// withAnsibleProjectAll adds ansible.cfg, inventory/hosts.yml and a README to
// every playbook, so the zip runs as unzipped rather than matching no hosts.
/*
 * Every module of every collection in the Ansible package (and oracle.oci),
 * each a blueprint with every option it documents, after each platform's
 * playbooks — and the platforms that had none (network devices, containers,
 * databases, storage, private clouds, the rest) made of them.
 */
const MODULES = moduleBlueprintsByPlatform();
const withModules = (group: BlueprintGroup): BlueprintGroup => ({
  ...group,
  // The hand-written playbooks under their own heading, then each module under its topic.
  blueprints: [...group.blueprints.map((b) => (b.group ? b : derive(b, { group: 'Playbooks' }))), ...(MODULES.get(group.target) ?? [])],
});

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
].map(withModules).concat(newPlatformGroups(MODULES, {
  network: NETWORK_PLAYBOOKS,
  containers: CONTAINERS_PLAYBOOKS,
  databases: DATABASES_PLAYBOOKS,
  storage: STORAGE_PLAYBOOKS,
  'private-clouds': PRIVATE_CLOUDS_PLAYBOOKS,
  operations: OPERATIONS_PLAYBOOKS,
})), 'ansible'));
