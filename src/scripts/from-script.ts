/**
 * A script, as the files someone can use.
 *
 * Two of them: the script itself, and the README that goes in the ticket or
 * beside it in a repository. They come from one structure, so the README cannot
 * describe a script that does something else — which is the usual fate of a
 * README written separately a week later.
 */

import type { Blueprint, BlueprintValues, BuildResult } from '../kit/blueprint.ts';
import { slug } from '../kit/blueprint.ts';
import type { Finding } from '../core/findings.ts';
import { SCRIPT_PLATFORMS, renderReadme, renderScript, standingFindings, type Script, type ScriptPlatform } from './script.ts';

export interface ScriptBlueprint extends Blueprint {
  /** The language this writes, so the bundle can group by it. */
  readonly platform: ScriptPlatform;
  /** The structured script, for the bundle to assemble. */
  readonly script: (values: BlueprintValues, name: string) => Script;
}

export function scriptFiles(script: Script, name: string): BuildResult {
  const platform = SCRIPT_PLATFORMS[script.platform];
  const base = slug(name, 'script').replace(/_/g, '-');
  const findings: Finding[] = [...(script.findings ?? []), ...standingFindings(script)];

  return {
    files: {
      [`${base}${platform.extension}`]: renderScript(script, base),
      'README.md': `${renderReadme(script, base).join('\n')}\n`,
    },
    findings,
  };
}

/**
 * Declare a blueprint from a script builder.
 *
 * The page sees an ordinary `Blueprint`; the bundle sees the structured script
 * underneath it. Writing both by hand is how the two would eventually disagree.
 */
export function scriptBlueprint(
  spec: Omit<Blueprint, 'build' | 'emits'> & {
    readonly platform: ScriptPlatform;
    readonly emits?: readonly string[];
    readonly script: (values: BlueprintValues, name: string) => Script;
  },
): ScriptBlueprint {
  return {
    ...spec,
    emits: spec.emits ?? [],
    build: (values: BlueprintValues, name: string) => scriptFiles(spec.script(values, name), name),
  };
}
