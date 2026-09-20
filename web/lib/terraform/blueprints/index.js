/**
 * Every Terraform blueprint, grouped by platform.
 *
 * The platform is chosen once — by the decision matrix, or on the page — and
 * then this is the list of things that can be built on it.
 */

                                                             
import { AWS_TERRAFORM } from './aws.js';
import { AZURE_TERRAFORM } from './azure.js';
import { GCP_TERRAFORM } from './gcp.js';
import { OCI_TERRAFORM } from './oci.js';
import { VMWARE_TERRAFORM } from './vmware.js';
import { LINUX_TERRAFORM } from './linux.js';
import { WINDOWS_TERRAFORM } from './windows.js';

export const TERRAFORM_BLUEPRINTS                            = [
  AWS_TERRAFORM,
  AZURE_TERRAFORM,
  GCP_TERRAFORM,
  OCI_TERRAFORM,
  VMWARE_TERRAFORM,
  LINUX_TERRAFORM,
  WINDOWS_TERRAFORM,
];
