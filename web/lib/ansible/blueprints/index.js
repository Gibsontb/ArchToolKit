/**
 * Every Ansible blueprint, grouped by platform.
 *
 * The platform is chosen once — by the decision matrix, or on the page — and
 * then this is the list of things that can be automated on it.
 */

                                                                        
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

/** The estate blueprints follow; the page opens on them when an estate is loaded. */
function withEstate(group                , estate                      )                 {
  return {
    ...group,
    blueprints: [...group.blueprints.map((b) => ({ ...b, group: b.group ?? 'Playbooks' })), ...estate],
  };
}

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
], 'ansible'));
