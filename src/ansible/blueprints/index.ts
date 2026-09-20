/**
 * Every Ansible blueprint, grouped by platform.
 *
 * The platform is chosen once — by the decision matrix, or on the page — and
 * then this is the list of things that can be automated on it.
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import { withChoicesAll } from '../../kit/choices.ts';
import { AWS_ANSIBLE } from './aws.ts';
import { AZURE_ANSIBLE } from './azure.ts';
import { GCP_ANSIBLE } from './gcp.ts';
import { OCI_ANSIBLE } from './oci.ts';
import { VMWARE_ANSIBLE } from './vmware.ts';
import { LINUX_ANSIBLE } from './linux.ts';
import { WINDOWS_ANSIBLE } from './windows.ts';

export const ANSIBLE_BLUEPRINTS: readonly BlueprintGroup[] = withChoicesAll([
  AWS_ANSIBLE,
  AZURE_ANSIBLE,
  GCP_ANSIBLE,
  OCI_ANSIBLE,
  VMWARE_ANSIBLE,
  LINUX_ANSIBLE,
  WINDOWS_ANSIBLE,
]);
