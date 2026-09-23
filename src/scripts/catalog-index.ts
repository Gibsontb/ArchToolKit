/**
 * Every catalogued command, in one place.
 *
 * This is what the Commands tab browses and what the snippet blueprint builds
 * from. Keeping the aggregation here rather than in the page means the tests
 * and the generator see exactly what the page does.
 */

import type { ScriptPlatform } from './script.ts';
import { allCommands, type CommandEntry, type CommandGroup } from './catalog.ts';
import { POWERSHELL_CATALOG } from './catalog-powershell.ts';
import { PYTHON_CATALOG } from './catalog-python.ts';
import { BASH_CATALOG } from './catalog-bash.ts';
import { CMD_CATALOG } from './catalog-cmd.ts';

export const CATALOG_BY_PLATFORM: Readonly<Record<ScriptPlatform, readonly CommandGroup[]>> = {
  powershell: POWERSHELL_CATALOG,
  python: PYTHON_CATALOG,
  bash: BASH_CATALOG,
  cmd: CMD_CATALOG,
};

export const ALL_CATALOG_GROUPS: readonly CommandGroup[] = [
  ...POWERSHELL_CATALOG,
  ...PYTHON_CATALOG,
  ...BASH_CATALOG,
  ...CMD_CATALOG,
];

export const ALL_COMMANDS: readonly CommandEntry[] = allCommands(ALL_CATALOG_GROUPS);

export function catalogFor(platform: ScriptPlatform): readonly CommandGroup[] {
  return CATALOG_BY_PLATFORM[platform] ?? [];
}

export function commandsFor(platform: ScriptPlatform): readonly CommandEntry[] {
  return allCommands(catalogFor(platform));
}

/** Every command, keyed by id, for the generator's lookup. */
export function commandIndex(): ReadonlyMap<string, CommandEntry> {
  return new Map(ALL_COMMANDS.map((command) => [command.id, command]));
}
