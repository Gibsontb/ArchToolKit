/**
 * The script generator.
 *
 * Four languages on one page, chosen the way the network page chooses a device
 * operating system: the choice belongs to this page, not to the toolkit, so
 * "I am writing PowerShell today" does not change what the Terraform page is
 * working on.
 *
 * The output is always two files — the script and its README — because the
 * question people come back to weeks later is not "what does this do" but "what
 * does it need, and how do I undo it". Keeping the answer in the file's own
 * header means it cannot be separated from the script.
 */

import { mountGeneratorPage } from './generator-page.js';
import { SCRIPT_BLUEPRINTS } from '../scripts/blueprints/index.js';
import { info,              } from '../core/findings.js';

const root = document.getElementById('scripts-root');
if (root) {
  mountGeneratorPage(root, {
    groups: SCRIPT_BLUEPRINTS,
    kindLabel: 'Script',
    noun: 'script',
    idleHint:
      'Pick a language and a script, adjust the parameters, then Generate. Read the header before you run it — it says what the script needs, how to make it report instead of act, and how to undo it.',
    settingsKind: 'archtoolkit.script-generator',
    // A language is not a cloud. Choosing PowerShell here must not change what
    // the Terraform or Ansible pages think they are targeting.
    sharedPlatform: false,
    downloadExtension: '.txt',
    standingFindings: ()            => [
      info('scripts.read-before-running', 'Nothing here is meant to be run unread. Every script carries its requirements, its dry run and its undo in the header — that is the part worth reading.', {
        source: 'ArchToolKit',
      }),
    ],
  });
}
