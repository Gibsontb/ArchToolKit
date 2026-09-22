/**
 * Network device generator.
 *
 * The same page as Terraform and Ansible — pick the platform, pick what you
 * are building, fill in the parameters, generate — with one difference that
 * matters: the platform here is a device operating system, not a cloud, so
 * this page keeps its own selection rather than writing into the toolkit-wide
 * cloud. Being on Cisco IOS says nothing about where the Terraform page should
 * open.
 *
 * The build list assembles a whole change: the steps in order, one file each,
 * a playbook that applies them in that order, and a change record whose
 * back-out runs in reverse.
 */

import { mountGeneratorPage } from './generator-page.ts';
import { NETWORK_BLUEPRINTS } from '../network/blueprints/index.ts';
import { buildChange } from '../network/change.ts';
import { catalogFindings } from '../ansible/catalog.ts';

const root = document.getElementById('network-root');
if (root) {
  mountGeneratorPage(root, {
    groups: NETWORK_BLUEPRINTS,
    kindLabel: 'device configuration',
    noun: 'change',
    idleHint:
      'Pick a platform and a change, fill in the parameters, then Generate. Every change comes with what to capture first, what proves it worked, and the commands that undo it.',
    settingsKind: 'archtoolkit.network-generator',
    sharedPlatform: false,
    downloadExtension: '.cfg',
    stack: {
      noun: 'change',
      addLabel: 'Add to change',
      referenceLabel: 'an earlier step',
      wrap: (expression) => expression,
      build: (items, blueprintFor, opts) => buildChange(items, blueprintFor, { stackName: opts.stackName }),
    },
    standingFindings: () => catalogFindings(),
  });
}
