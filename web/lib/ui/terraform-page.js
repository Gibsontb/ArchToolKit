/**
 * Terraform generator.
 *
 * Pick the platform once, pick what you are building, fill in its parameters,
 * generate. The blueprints and their HCL came from the previous toolkit; what
 * is new is that every resource type they emit is checked against the committed
 * provider catalog, so a resource renamed in a provider release fails here
 * rather than at plan time.
 */

import { mountGeneratorPage } from './generator-page.js';
import { TERRAFORM_BLUEPRINTS } from '../terraform/blueprints/index.js';
import { catalogFindings } from '../terraform/catalog.js';

const root = document.getElementById('terraform-root');
if (root) {
  mountGeneratorPage(root, {
    groups: TERRAFORM_BLUEPRINTS,
    kindLabel: 'Terraform (HCL)',
    noun: 'blueprint',
    idleHint:
      'Pick a platform and blueprint, adjust the parameters, then Generate. Save the result as main.tf and run terraform init && terraform plan.',
    downloadExtension: '.tf',
    standingFindings: () => catalogFindings(),
  });
}

export { mountGeneratorPage };
