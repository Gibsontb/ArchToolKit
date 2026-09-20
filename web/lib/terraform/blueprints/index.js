/**
 * Every Terraform blueprint, grouped by platform.
 *
 * The platform is chosen once — by the decision matrix, or on the page — and
 * then this is the list of things that can be built on it.
 */

                                                             
import { withChoicesAll } from '../../kit/choices.js';
import { withSecretLiftingAll } from '../secrets.js';
import { AWS_TERRAFORM } from './aws.js';
import { AZURE_TERRAFORM } from './azure.js';
import { GCP_TERRAFORM } from './gcp.js';
import { OCI_TERRAFORM } from './oci.js';
import { VMWARE_TERRAFORM } from './vmware.js';
import { LINUX_TERRAFORM } from './linux.js';
import { WINDOWS_TERRAFORM } from './windows.js';

/*
 * Two passes over the same list. `withChoicesAll` gives every input its answer
 * set, so a machine type is a dropdown of machine types; `withSecretLiftingAll`
 * fixes up what the templates emit, so a `var.` reference picked from one of
 * those dropdowns comes out as a reference rather than a quoted string.
 */
export const TERRAFORM_BLUEPRINTS                            = withSecretLiftingAll(withChoicesAll([
  AWS_TERRAFORM,
  AZURE_TERRAFORM,
  GCP_TERRAFORM,
  OCI_TERRAFORM,
  VMWARE_TERRAFORM,
  LINUX_TERRAFORM,
  WINDOWS_TERRAFORM,
], 'terraform'));
