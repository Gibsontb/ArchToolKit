/**
 * Scripts: the generator and the command catalogue, on one page.
 *
 * Four languages, chosen the way the network page chooses a device operating
 * system: the choice belongs to this page, not to the toolkit, so "I am writing
 * PowerShell today" does not change what the Terraform page is working on.
 *
 * The Build tab has the hand-written tasks — the ones worth having an opinion
 * about — and, above them, one blueprint per language that will wrap any of the
 * four hundred catalogued commands in that language's skeleton. The Commands
 * tab is that catalogue, browsable and searchable, and every row there links
 * back into the generator with the command already chosen. Forty-eight hand
 * written tasks was never going to be coverage of four languages; this is.
 *
 * The output is always two files — the script and its README — because the
 * question people come back to weeks later is not "what does this do" but "what
 * does it need, and how do I undo it". Keeping the answer in the file's own
 * header means it cannot be separated from the script.
 */

import { mountGeneratorPage } from './generator-page.ts';
import { mountTabs } from './tab-shell.ts';
import { mountCommandsPage } from './commands-page.ts';
import { SCRIPT_BLUEPRINTS } from '../scripts/blueprints/index.ts';
import { ALL_COMMANDS } from '../scripts/catalog-index.ts';
import { info, type Finding } from '../core/findings.ts';

/** `scripts.html#build:sh.ss` — a command sent here from the Commands tab. */
function openWith(): { blueprint: string; values: Record<string, string> } | undefined {
  const argument = (globalThis.location?.hash ?? '').split(':')[1];
  if (!argument) return undefined;
  const command = ALL_COMMANDS.find((entry) => entry.id === argument);
  if (!command) return undefined;
  return {
    blueprint: `${command.platform}_snippet`,
    values: { command: command.id, script_name: command.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') },
  };
}

function mountBuild(container: HTMLElement): void {
  mountGeneratorPage(container, {
    groups: SCRIPT_BLUEPRINTS,
    kindLabel: 'Script',
    noun: 'script',
    idleHint:
      'Pick a language and a script, adjust the parameters, then Generate. "Any catalogued command" at the top of each language will wrap any of the commands in the Commands tab. Read the header before you run it — it says what the script needs, how to make it report instead of act, and how to undo it.',
    settingsKind: 'archtoolkit.script-generator',
    // A language is not a cloud. Choosing PowerShell here must not change what
    // the Terraform or Ansible pages think they are targeting.
    sharedPlatform: false,
    downloadExtension: '.txt',
    openWith,
    standingFindings: (): Finding[] => [
      info('scripts.read-before-running', 'Nothing here is meant to be run unread. Every script carries its requirements, its dry run and its undo in the header — that is the part worth reading.', {
        source: 'ArchToolKit',
      }),
    ],
  });
}

const root = document.getElementById('scripts-root');
if (root) {
  mountTabs(
    root,
    [
      { id: 'build', label: 'Build', mount: mountBuild },
      { id: 'commands', label: `Commands (${ALL_COMMANDS.length})`, mount: mountCommandsPage },
    ],
    'build',
  );
}
