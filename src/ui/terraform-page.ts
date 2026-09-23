/**
 * Terraform: the generator and the map, on one page.
 *
 * They were two navigation entries, and that was wrong. The map answers the
 * question that comes before the generator's — given a domain, which resource
 * is the one to reach for — and a reference you have to navigate to is a
 * reference nobody opens. Now it is a tab, and the rows that talk about what
 * you just generated appear under the output as well.
 *
 * The blueprints and their HCL came from the previous toolkit; what is new is
 * that every resource type they emit is checked against the committed provider
 * catalog, so a resource renamed in a provider release fails here rather than
 * at plan time — and the map's names are checked against the same catalog, so
 * the two cannot disagree.
 */

import { mountGeneratorPage } from './generator-page.ts';
import { mountTabs } from './tab-shell.ts';
import { mountEstateBar } from './estate-bar.ts';
import { currentEstate } from '../kit/estate-store.ts';
import { TERRAFORM_BLUEPRINTS } from '../terraform/blueprints/index.ts';
import { catalogFindings } from '../terraform/catalog.ts';
import { moduleFindings } from '../terraform/modules.ts';
import { buildStack } from '../terraform/stack.ts';
import { referencePanel } from './terraform-reference.ts';
import { mountTerraformMapPage } from './terraform-map-page.ts';

function mountBuild(container: HTMLElement): void {
  // The estate is read before the form is built, so the estate blueprints and
  // the dropdowns that list its clusters, datastores and port groups have it.
  // Importing or forgetting one afterwards rebuilds the page around the new one.
  let mounted = false;
  void mountEstateBar(container, {
    purpose: 'generate Terraform from it: a VCF landing zone for a cluster, or a cloud rehost sized VM by VM',
    onEstate: () => {
      if (mounted) {
        globalThis.location.reload();
        return;
      }
      mounted = true;
      mountGeneratorPage(container, {
        groups: TERRAFORM_BLUEPRINTS,
        kindLabel: 'Terraform (HCL)',
        noun: 'blueprint',
        idleHint:
          'Pick a platform and blueprint, adjust the parameters, then Generate. Save the result as main.tf and run terraform init && terraform plan. The Map tab is the reference for what to reach for.',
        preferGroup: () => (currentEstate() ? 'From your estate' : undefined),
        settingsKind: 'archtoolkit.terraform-generator',
        stack: {
          noun: 'stack',
          build: (items, blueprintFor, opts) => buildStack(items, blueprintFor, { target: opts.target as never, stackName: opts.stackName }),
        },
        downloadExtension: '.tf',
        standingFindings: () => [...catalogFindings(), ...moduleFindings()],
        // The map rows that talk about what was just generated, under the output.
        panels: (platform, files) => referencePanel(platform, files),
      });
    },
  });
}

const root = document.getElementById('terraform-root');
if (root) {
  mountTabs(
    root,
    [
      { id: 'build', label: 'Build', mount: mountBuild },
      {
        id: 'map',
        label: 'Map',
        mount: (container) => mountTerraformMapPage(container),
        // Anything that linked to the old separate page, or to a section of it.
        alsoMatches: ['terraform-map', 'networking', 'identity', 'compute', 'data', 'security', 'observability'],
      },
    ],
    'build',
  );
}

export { mountGeneratorPage };
