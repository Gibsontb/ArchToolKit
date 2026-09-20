/**
 * Every Terraform blueprint, grouped by platform.
 *
 * The platform is chosen once — by the decision matrix, or on the page — and
 * then this is the list of things that can be built on it.
 *
 * Two kinds sit in that list, under their own headings. The originals write
 * resources out: an EC2 instance and its security group, spelled in full, which
 * is the right shape when you want to read every line of what you are about to
 * apply. The module blueprints call a registry module instead — nine inputs to
 * `terraform-aws-modules/vpc/aws` rather than eleven resources and the route
 * table arithmetic — which is what most configurations actually do, and what
 * the kit could not do at all until the module catalog existed.
 *
 * Neither replaces the other, so both are offered and the picker says which is
 * which.
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
import { AWS_TERRAFORM_MODULES } from './modules-aws.js';
import { AZURE_TERRAFORM_MODULES } from './modules-azure.js';
import { GOOGLE_TERRAFORM_MODULES } from './modules-google.js';
import { OCI_TERRAFORM_MODULES } from './modules-oci.js';

const RESOURCES = 'Plain Terraform resources';
const MODULES = 'Terraform Registry modules';

function labelled(blueprints                      , group        )                       {
  return blueprints.map((blueprint) => ({ ...blueprint, group }));
}

/**
 * One platform's resource blueprints and module blueprints, in one list.
 *
 * Resources first: they are the ones the previous toolkit shipped, so someone
 * arriving from it finds what they came for at the top rather than having to
 * scroll past forty module calls to reach it.
 */
function combine(
  resources                ,
  modules                            ,
)                 {
  if (!modules) return { ...resources, blueprints: labelled(resources.blueprints, RESOURCES) };
  return {
    ...resources,
    blueprints: [
      ...labelled(resources.blueprints, RESOURCES),
      ...labelled(modules.blueprints, MODULES),
    ],
  };
}

/*
 * Two passes over the same list. `withChoicesAll` gives every input its answer
 * set, so a machine type is a dropdown of machine types; `withSecretLiftingAll`
 * fixes up what the templates emit, so a `var.` reference picked from one of
 * those dropdowns comes out as a reference rather than a quoted string.
 */
export const TERRAFORM_BLUEPRINTS                            = withSecretLiftingAll(
  withChoicesAll(
    [
      combine(AWS_TERRAFORM, AWS_TERRAFORM_MODULES),
      combine(AZURE_TERRAFORM, AZURE_TERRAFORM_MODULES),
      combine(GCP_TERRAFORM, GOOGLE_TERRAFORM_MODULES),
      combine(OCI_TERRAFORM, OCI_TERRAFORM_MODULES),
      combine(VMWARE_TERRAFORM, undefined),
      combine(LINUX_TERRAFORM, undefined),
      combine(WINDOWS_TERRAFORM, undefined),
    ],
    'terraform',
  ),
);
