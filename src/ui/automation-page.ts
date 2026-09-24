/**
 * The automation generator.
 *
 * VCF Operations, VCF Operations for Networks, VCF Operations for Logs, VCF
 * Automation and fleet management — capabilities of one platform in 9.1, chosen
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

const root = document.getElementById('automation-root');
if (root) {
  mountGeneratorPage(root, {
    groups: AUTOMATION_BLUEPRINTS,
    kindLabel: 'Automation',
    // VCF Operations, for Networks and for Logs take their own content, not
    // something VCF Automation runs.
    kindLabelFor: (platform) => (platform.startsWith('vcf-operations') ? 'Content' : undefined),
    noun: 'automation',
    idleHint:
      'Pick where it runs and what it should do, fill in the parameters, then Generate. The README says what starts it, what it touches, and how to undo it.',
    settingsKind: 'archtoolkit.automation-generator',
    // A VCF capability is not a cloud. Choosing VCF Operations here must not
    // change what the Terraform or Ansible pages think they are targeting.
    sharedPlatform: false,
    downloadExtension: '.txt',
  });
}
