/**
 * Every script, grouped by the language it is written in.
 *
 * The platform here is a language rather than a cloud, so this page keeps its
 * own selection instead of writing into the toolkit-wide target: "I am writing
 * PowerShell" says nothing about which cloud the Terraform page should open on.
 */

                                                             
                                                         
import { SCRIPT_PLATFORMS } from '../script.js';
import { POWERSHELL_BASE } from './powershell.js';
import { PYTHON_BASE } from './python.js';
import { BASH_BASE } from './bash.js';
import { CMD_BASE } from './cmd.js';

export const POWERSHELL_SCRIPTS                 = { target: 'powershell', label: SCRIPT_PLATFORMS.powershell.label, blueprints: POWERSHELL_BASE };
export const PYTHON_SCRIPTS                 = { target: 'python', label: SCRIPT_PLATFORMS.python.label, blueprints: PYTHON_BASE };
export const BASH_SCRIPTS                 = { target: 'bash', label: SCRIPT_PLATFORMS.bash.label, blueprints: BASH_BASE };
export const CMD_SCRIPTS                 = { target: 'cmd', label: SCRIPT_PLATFORMS.cmd.label, blueprints: CMD_BASE };

export const SCRIPT_BLUEPRINTS                            = [POWERSHELL_SCRIPTS, PYTHON_SCRIPTS, BASH_SCRIPTS, CMD_SCRIPTS];

/** Every script blueprint, with its structured builder, in one list. */
export const SCRIPTS                             = [...POWERSHELL_BASE, ...PYTHON_BASE, ...BASH_BASE, ...CMD_BASE];

export function scriptFor(id        )                              {
  return SCRIPTS.find((blueprint) => blueprint.id === id);
}
