/**
 * Every catalogued command, in one place.
 *
 * This is what the Commands tab browses and what the snippet blueprint builds
 * from. Keeping the aggregation here rather than in the page means the tests
 * and the generator see exactly what the page does.
 */

                                                  
import { allCommands,                                      } from './catalog.js';
import { POWERSHELL_CATALOG } from './catalog-powershell.js';
import { PYTHON_CATALOG } from './catalog-python.js';
import { BASH_CATALOG } from './catalog-bash.js';
import { CMD_CATALOG } from './catalog-cmd.js';

export const CATALOG_BY_PLATFORM                                                            = {
  powershell: POWERSHELL_CATALOG,
  python: PYTHON_CATALOG,
  bash: BASH_CATALOG,
  cmd: CMD_CATALOG,
};

export const ALL_CATALOG_GROUPS                          = [
  ...POWERSHELL_CATALOG,
  ...PYTHON_CATALOG,
  ...BASH_CATALOG,
  ...CMD_CATALOG,
];

export const ALL_COMMANDS                          = allCommands(ALL_CATALOG_GROUPS);

export function catalogFor(platform                )                          {
  return CATALOG_BY_PLATFORM[platform] ?? [];
}

export function commandsFor(platform                )                          {
  return allCommands(catalogFor(platform));
}

/** Every command, keyed by id, for the generator's lookup. */
export function commandIndex()                                    {
  return new Map(ALL_COMMANDS.map((command) => [command.id, command]));
}
