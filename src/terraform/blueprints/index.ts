/**
 * Every Terraform blueprint, grouped by platform.
 *
 * The platform is chosen once — by the decision matrix, or on the page — and
 * then this is the list of things that can be built on it.
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import { withChoicesAll } from '../../kit/choices.ts';
import { withSecretLiftingAll } from '../secrets.ts';
import { AWS_TERRAFORM } from './aws.ts';
import { AZURE_TERRAFORM } from './azure.ts';
import { GCP_TERRAFORM } from './gcp.ts';
import { OCI_TERRAFORM } from './oci.ts';
import { VMWARE_TERRAFORM } from './vmware.ts';
import { LINUX_TERRAFORM } from './linux.ts';
import { WINDOWS_TERRAFORM } from './windows.ts';

/*
 * Two passes over the same list. `withChoicesAll` gives every input its answer
 * set, so a machine type is a dropdown of machine types; `withSecretLiftingAll`
 * fixes up what the templates emit, so a `var.` reference picked from one of
 * those dropdowns comes out as a reference rather than a quoted string.
 */
export const TERRAFORM_BLUEPRINTS: readonly BlueprintGroup[] = withSecretLiftingAll(withChoicesAll([
  AWS_TERRAFORM,
  AZURE_TERRAFORM,
  GCP_TERRAFORM,
  OCI_TERRAFORM,
  VMWARE_TERRAFORM,
  LINUX_TERRAFORM,
  WINDOWS_TERRAFORM,
], 'terraform'));
