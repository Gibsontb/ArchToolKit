/**
 * Every Ansible blueprint, grouped by platform.
 *
 * The platform is chosen once — by the decision matrix, or on the page — and
 * then this is the list of things that can be automated on it.
 */

                                                                        
import { derive } from '../../kit/blueprint.js';
import { moduleBlueprintsByPlatform, newPlatformGroups } from '../module-blueprints.js';
import { withChoicesAll } from '../../kit/choices.js';
import { withAnsibleProjectAll } from '../project.js';
import { AWS_ANSIBLE } from './aws.js';
import { AZURE_ANSIBLE } from './azure.js';
import { GCP_ANSIBLE } from './gcp.js';
import { OCI_ANSIBLE } from './oci.js';
import { VMWARE_ANSIBLE } from './vmware.js';
import { LINUX_ANSIBLE } from './linux.js';
import { WINDOWS_ANSIBLE } from './windows.js';
import { inventoryBlueprint, PREMIGRATION, POSTMIGRATION } from './estate.js';
import { NETWORK_PLAYBOOKS } from './network.js';
import { CONTAINERS_PLAYBOOKS } from './containers.js';
import { DATABASES_PLAYBOOKS } from './databases.js';
import { STORAGE_PLAYBOOKS } from './storage.js';
import { PRIVATE_CLOUDS_PLAYBOOKS } from './private-clouds.js';
import { OPERATIONS_PLAYBOOKS } from './operations.js';

/** The estate blueprints follow; the page opens on them when an estate is loaded. */
function withEstate(group                , estate                      )                 {
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
const withModules = (group                )                 => ({
  ...group,
  // The hand-written playbooks under their own heading, then each module under its topic.
  blueprints: [...group.blueprints.map((b) => (b.group ? b : derive(b, { group: 'Playbooks' }))), ...(MODULES.get(group.target) ?? [])],
});

// withAnsibleProjectAll adds ansible.cfg, inventory/hosts.yml and a README to
// every playbook, so the zip runs as unzipped rather than matching no hosts.
export const ANSIBLE_BLUEPRINTS                            = withAnsibleProjectAll(withChoicesAll([
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
