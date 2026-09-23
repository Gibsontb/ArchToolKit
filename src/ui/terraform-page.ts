/**
 * Terraform generator.
 *
 * Pick the platform once, pick what you are building, fill in its parameters,
 * generate. The blueprints and their HCL came from the previous toolkit; what
 * is new is that every resource type they emit is checked against the committed
 * provider catalog, so a resource renamed in a provider release fails here
 * rather than at plan time.
 *
 * The Reference panel under the output is the Terraform Map, joined to what was
 * just generated. The map on its own answers a browsing question — which
 * resource do I reach for in this domain — and keeps its own page for that. But
 * once something has been written, the same rows are reference for what is on
 * the screen, and that belongs beside the output rather than one navigation
 * away. A generated resource the map says nothing about is a gap in the map,
 * and it is reported as one.
 */

import { mountGeneratorPage } from './generator-page.ts';
import { mountEstateBar } from './estate-bar.ts';
import { currentEstate } from '../kit/estate-store.ts';
import { TERRAFORM_BLUEPRINTS } from '../terraform/blueprints/index.ts';
import { catalogFindings } from '../terraform/catalog.ts';
import { moduleFindings } from '../terraform/modules.ts';
import { buildStack } from '../terraform/stack.ts';
import { referencePanel } from './terraform-reference.ts';

const root = document.getElementById('terraform-root');
if (root) {
  // The estate is read before the form is built, so the estate blueprints and
  // the dropdowns that list its clusters, datastores and port groups have it.
  // Importing or forgetting one afterwards rebuilds the page around the new one.
  let mounted = false;
  void mountEstateBar(root, {
    purpose: 'generate Terraform from it: a VCF landing zone for a cluster, or a cloud rehost sized VM by VM',
    onEstate: () => {
      if (mounted) {
        globalThis.location.reload();
        return;
      }
      mounted = true;
      mountGeneratorPage(root, {
        groups: TERRAFORM_BLUEPRINTS,
        kindLabel: 'Terraform (HCL)',
        noun: 'blueprint',
        idleHint:
          'Pick a platform and blueprint, adjust the parameters, then Generate. Save the result as main.tf and run terraform init && terraform plan.',
        preferGroup: () => (currentEstate() ? 'From your estate' : undefined),
        settingsKind: 'archtoolkit.terraform-generator',
        mapHref: 'terraform-map.html',
        stack: {
          noun: 'stack',
          build: (items, blueprintFor, opts) => buildStack(items, blueprintFor, { target: opts.target as never, stackName: opts.stackName }),
        },
        downloadExtension: '.tf',
        standingFindings: () => [...catalogFindings(), ...moduleFindings()],
        panels: (platform, files) => referencePanel(platform, files),
      });
    },
  });
}

export { mountGeneratorPage };
