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

import { mountGeneratorPage } from './generator-page.js';
import { ANSIBLE_BLUEPRINTS } from '../ansible/blueprints/index.js';
import { catalogFindings } from '../ansible/catalog.js';

const root = document.getElementById('ansible-root');
if (root) {
  mountGeneratorPage(root, {
    groups: ANSIBLE_BLUEPRINTS,
    kindLabel: 'Ansible (YAML)',
    noun: 'playbook',
    idleHint:
      'Pick a platform and playbook, adjust the parameters, then Generate. Install the collections from requirements.yml, then run ansible-playbook -i inventory <file> --check --diff.',
    downloadExtension: '.yml',
    standingFindings: () => catalogFindings(),
  });
}
