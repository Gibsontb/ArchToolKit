/**
 * Every script, grouped by the language it is written in.
 *
 * The platform here is a language rather than a cloud, so this page keeps its
 * own selection instead of writing into the toolkit-wide target: "I am writing
 * PowerShell" says nothing about which cloud the Terraform page should open on.
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import type { ScriptBlueprint } from '../from-script.ts';
import { SCRIPT_PLATFORMS } from '../script.ts';
import { POWERSHELL_BASE } from './powershell.ts';
import { PYTHON_BASE } from './python.ts';
import { BASH_BASE } from './bash.ts';
import { CMD_BASE } from './cmd.ts';

export const POWERSHELL_SCRIPTS: BlueprintGroup = { target: 'powershell', label: SCRIPT_PLATFORMS.powershell.label, blueprints: POWERSHELL_BASE };
export const PYTHON_SCRIPTS: BlueprintGroup = { target: 'python', label: SCRIPT_PLATFORMS.python.label, blueprints: PYTHON_BASE };
export const BASH_SCRIPTS: BlueprintGroup = { target: 'bash', label: SCRIPT_PLATFORMS.bash.label, blueprints: BASH_BASE };
export const CMD_SCRIPTS: BlueprintGroup = { target: 'cmd', label: SCRIPT_PLATFORMS.cmd.label, blueprints: CMD_BASE };

export const SCRIPT_BLUEPRINTS: readonly BlueprintGroup[] = [POWERSHELL_SCRIPTS, PYTHON_SCRIPTS, BASH_SCRIPTS, CMD_SCRIPTS];

/** Every script blueprint, with its structured builder, in one list. */
export const SCRIPTS: readonly ScriptBlueprint[] = [...POWERSHELL_BASE, ...PYTHON_BASE, ...BASH_BASE, ...CMD_BASE];

export function scriptFor(id: string): ScriptBlueprint | undefined {
  return SCRIPTS.find((blueprint) => blueprint.id === id);
}
