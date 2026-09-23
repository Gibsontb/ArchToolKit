/**
 * The automation generator.
 *
 * VCF Operations, VCF Operations for Networks, VCF Operations for Logs, VCF
 * Automation and the runners — five capabilities of one platform in 9.1, chosen
 * on this page rather than from the toolkit-wide cloud, because none of them is
 * a cloud.
 *
 * Every output carries the same six answers in its README: what starts it, what
 * it may touch, what has to be true before it acts, how to make it report
 * instead, how to undo it, and who is told. An automation runs when nobody is
 * watching; those six are the questions asked afterwards.
 */

import { mountGeneratorPage } from './generator-page.ts';
import { AUTOMATION_BLUEPRINTS } from '../automation/blueprints/index.ts';
import { info, type Finding } from '../core/findings.ts';

const root = document.getElementById('automation-root');
if (root) {
  mountGeneratorPage(root, {
    groups: AUTOMATION_BLUEPRINTS,
    kindLabel: 'Automation',
    noun: 'automation',
    idleHint:
      'Pick where it runs and what it should do, fill in the parameters, then Generate. Read the README before you turn anything on — it says what starts it, what it may touch, and how to undo it.',
    settingsKind: 'archtoolkit.automation-generator',
    // A VCF capability is not a cloud. Choosing VCF Operations here must not
    // change what the Terraform or Ansible pages think they are targeting.
    sharedPlatform: false,
    downloadExtension: '.txt',
    standingFindings: (): Finding[] => [
      info('automation.scope-first', 'The scope is the part that goes wrong, not the code. Before turning anything on, count the objects it can reach.', {
        remediation: 'An action inherits its scope from an alert, the alert from a policy, the policy from a custom group, and the group from a rule somebody wrote a year ago.',
        source: 'ArchToolKit',
      }),
      info('automation.disabled-first', 'Everything generated here is created disabled, with its dry run on.', {
        remediation: 'That is deliberate. Applying a file should never start something running against production.',
        source: 'ArchToolKit',
      }),
    ],
  });
}
