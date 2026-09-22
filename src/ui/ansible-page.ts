/**
 * Ansible generator.
 *
 * Pick the platform once, pick what you are automating, fill in its parameters,
 * generate. The playbooks came from the previous toolkit; what is new is that
 * every module name is checked against the committed Galaxy catalog, and a
 * requirements.yml is derived from the modules each playbook actually uses — so
 * it cannot drift from the play, and a collection is never left out.
 *
 * Fixing those checks found eleven playbooks naming modules that no longer
 * exist: the OCI network modules were renamed, DynamoDB, SQS and SNS moved to
 * community.aws, and the Active Directory modules left ansible.windows for
 * microsoft.ad.
 */

import { mountGeneratorPage } from './generator-page.ts';
import { buildSite } from '../ansible/site.ts';
import { mountEstateBar } from './estate-bar.ts';
import { currentEstate } from '../kit/estate-store.ts';
import { ANSIBLE_BLUEPRINTS } from '../ansible/blueprints/index.ts';
import { catalogFindings } from '../ansible/catalog.ts';

const root = document.getElementById('ansible-root');
if (root) {
  // The estate is read before the form is built, so the estate blueprints and
  // the dropdowns that list its clusters, datastores and port groups have it.
  // Importing or forgetting one afterwards rebuilds the page around the new one.
  let mounted = false;
  void mountEstateBar(root, {
    purpose: 'generate Ansible from it: an inventory of its VMs, and the plays before and after a move',
    onEstate: () => {
      if (mounted) {
        globalThis.location.reload();
        return;
      }
      mounted = true;
      mountGeneratorPage(root, {
        groups: ANSIBLE_BLUEPRINTS,
        kindLabel: 'Ansible (YAML)',
        noun: 'playbook',
        idleHint:
          'Pick a platform and playbook, adjust the parameters, then Generate. Install the collections from requirements.yml, then run ansible-playbook -i inventory <file> --check --diff.',
        preferGroup: () => (currentEstate() ? 'From your estate' : undefined),
        settingsKind: 'archtoolkit.ansible-generator',
        stack: {
          noun: 'site playbook',
          // Two plays cannot hand values to each other; group_vars/all.yml can.
          referenceLabel: 'a shared variable',
          wrap: (name) => `{{ ${name} }}`,
          build: (items, blueprintFor, opts) => buildSite(items, blueprintFor, { stackName: opts.stackName }),
        },
        downloadExtension: '.yml',
        standingFindings: () => catalogFindings(),
      });
    },
  });
}
