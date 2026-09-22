/**
 * A change, as the files someone can use.
 *
 * Three of them, because a network change is three jobs: the configuration to
 * paste or diff, the playbook that applies the same thing to many devices, and
 * the record that goes in the ticket. They are generated from one structure so
 * they cannot drift apart, and the playbook's module names are checked against
 * the committed Galaxy catalog exactly as the Ansible kit's are.
 *
 * This is also where a blueprint is declared, so that the page and the change
 * list both reach the same builder: `deviceBlueprint` keeps the structured
 * builder beside the `Blueprint` the page renders, rather than the change list
 * having to parse configuration text back out of a file.
 */

import type { Blueprint, BlueprintValues, BuildResult } from '../kit/blueprint.ts';
import { slug } from '../kit/blueprint.ts';
import type { Finding } from '../core/findings.ts';
import { playbookFiles } from '../ansible/from-plays.ts';
import { PLATFORMS, renderChange, renderRecord, standingFindings, type DeviceChange, type Platform } from './device.ts';
import { playFor } from './push.ts';

export interface ChangeBlueprint extends Blueprint {
  /** The platform this builds for, so a change list can group by device. */
  readonly platform: Platform;
  /** The structured change, for the change list to assemble. */
  readonly change: (values: BlueprintValues, name: string) => DeviceChange;
}

export function changeFiles(change: DeviceChange, name: string): BuildResult {
  const platform = PLATFORMS[change.platform];
  const base = slug(name, 'change').replace(/_/g, '-');
  const files: Record<string, string> = {};
  const findings: Finding[] = [...(change.findings ?? []), ...standingFindings(change)];

  files[`${base}${platform.extension}`] = renderChange(change, name);

  const play = playFor(change, name);
  if (play) {
    const playbook = playbookFiles(play, base, `${change.title} (${platform.label})`);
    for (const [file, contents] of Object.entries(playbook.files)) files[file] = contents;
    // The "uses N modules" line is noise on a single change; the warnings are not.
    findings.push(...playbook.findings.filter((f) => f.code !== 'ansible.blueprint.modules-used'));
  }

  files['change-record.md'] = `${[`# ${name || change.title}`, '', ...renderRecord(change, name)].join('\n')}\n`;

  return { files, findings };
}

/**
 * Declare a blueprint from a change builder.
 *
 * The page sees an ordinary `Blueprint`; the change list sees the structured
 * builder underneath it. Writing both by hand is how the two would eventually
 * disagree about what a blueprint emits.
 */
export function deviceBlueprint(
  spec: Omit<Blueprint, 'build' | 'emits'> & {
    readonly platform: Platform;
    readonly emits?: readonly string[];
    readonly change: (values: BlueprintValues, name: string) => DeviceChange;
  },
): ChangeBlueprint {
  return {
    ...spec,
    emits: spec.emits ?? [],
    build: (values: BlueprintValues, name: string) => changeFiles(spec.change(values, name), name),
  };
}
