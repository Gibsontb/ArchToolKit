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

import type { Blueprint, BlueprintGroup } from '../../kit/blueprint.ts';
import { withChoicesAll } from '../../kit/choices.ts';
import { withSecretLiftingAll } from '../secrets.ts';
import { withRootModuleLayoutAll } from '../layout.ts';
import { AWS_TERRAFORM } from './aws.ts';
import { AZURE_TERRAFORM } from './azure.ts';
import { GCP_TERRAFORM } from './gcp.ts';
import { OCI_TERRAFORM } from './oci.ts';
import { VMWARE_TERRAFORM } from './vmware.ts';
import { LINUX_TERRAFORM } from './linux.ts';
import { WINDOWS_TERRAFORM } from './windows.ts';
import { AWS_TERRAFORM_MODULES } from './modules-aws.ts';
import { AZURE_TERRAFORM_MODULES } from './modules-azure.ts';
import { GOOGLE_TERRAFORM_MODULES } from './modules-google.ts';
import { OCI_TERRAFORM_MODULES } from './modules-oci.ts';
import { ESTATE_GROUP, rehostBlueprint, VSPHERE_LANDING } from './estate.ts';

export { ESTATE_GROUP };

const RESOURCES = 'Plain Terraform resources';
const MODULES = 'Terraform Registry modules';

function labelled(blueprints: readonly Blueprint[], group: string): readonly Blueprint[] {
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
  resources: BlueprintGroup,
  modules: BlueprintGroup | undefined,
  estate: readonly Blueprint[] = [],
): BlueprintGroup {
  // The estate blueprints come last in the list, and the page opens on them
  // when an estate is loaded: with one, they answer "what does Terraform do to
  // move this"; without one, they have nothing to build from.
  return {
    ...resources,
    blueprints: [
      ...labelled(resources.blueprints, RESOURCES),
      ...(modules ? labelled(modules.blueprints, MODULES) : []),
      ...labelled(estate, ESTATE_GROUP),
    ],
  };
}

/*
 * Two passes over the same list. `withChoicesAll` gives every input its answer
 * set, so a machine type is a dropdown of machine types; `withSecretLiftingAll`
 * fixes up what the templates emit, so a `var.` reference picked from one of
 * those dropdowns comes out as a reference rather than a quoted string.
 * `withRootModuleLayoutAll` then splits the one main.tf into versions.tf,
 * providers.tf, main.tf, variables.tf, outputs.tf and terraform.tfvars.example,
 * so the zip unpacks as a root module laid out the way Terraform's docs lay one out.
 */
export const TERRAFORM_BLUEPRINTS: readonly BlueprintGroup[] = withRootModuleLayoutAll(withSecretLiftingAll(
  withChoicesAll(
    [
      combine(AWS_TERRAFORM, AWS_TERRAFORM_MODULES, [rehostBlueprint('aws')]),
      combine(AZURE_TERRAFORM, AZURE_TERRAFORM_MODULES, [rehostBlueprint('azure')]),
      combine(GCP_TERRAFORM, GOOGLE_TERRAFORM_MODULES, [rehostBlueprint('google')]),
      combine(OCI_TERRAFORM, OCI_TERRAFORM_MODULES, [rehostBlueprint('oci')]),
      combine(VMWARE_TERRAFORM, undefined, [VSPHERE_LANDING]),
      combine(LINUX_TERRAFORM, undefined),
      combine(WINDOWS_TERRAFORM, undefined),
    ],
    'terraform',
  ),
));
