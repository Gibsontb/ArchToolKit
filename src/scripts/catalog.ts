/**
 * The command catalogue.
 *
 * Forty-eight hand-written task scripts is not coverage of four languages. The
 * languages have hundreds of commands each, and the question people actually
 * arrive with is not "build me a stale account report" — it is "what is the
 * command for this, and what is the incantation that makes it work".
 *
 * So the commands are data. The same shape the Terraform kit already uses: a
 * catalogue that can be browsed and searched, a generator that can build a
 * correct, wrapped invocation of any entry in it, and checks that run over the
 * whole catalogue rather than over one blueprint at a time.
 *
 * What makes an entry worth having is not the syntax — that is in the help. It
 * is the `note`: the thing that is true, not obvious, and costs an afternoon to
 * discover. An entry with a correct syntax line and nothing else is a worse
 * version of `--help`.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import type { ScriptPlatform } from './script.ts';

/** What running it does, so the page can warn and the generator can wrap it. */
export type CommandEffect =
  /** Reads and reports. */
  | 'read'
  /** Changes configuration or state, recoverably. */
  | 'changes'
  /** Deletes, overwrites or disables. There may be no way back. */
  | 'destructive';

export interface CommandEntry {
  /** Stable id: platform prefix, then the command. */
  readonly id: string;
  readonly platform: ScriptPlatform;
  /** The command as it is typed. */
  readonly name: string;
  /** The module, package or package name it comes from, where it is not built in. */
  readonly module?: string;
  /** The heading it sits under when the catalogue is browsed. */
  readonly group: string;
  /**
   * What it is for, in the words someone would search with.
   *
   * This is the field that matters most: people do not search for
   * `Get-ChildItem`, they search for "list files".
   */
  readonly task: string;
  /** A correct, complete invocation — not a syntax summary. */
  readonly syntax: string;
  /** The parameters worth knowing about, not all of them. */
  readonly parameters?: readonly { readonly name: string; readonly what: string }[];
  /**
   * The thing that is true, not obvious, and costs an afternoon to discover.
   *
   * An entry without one of these is a worse version of `--help`.
   */
  readonly note?: string;
  readonly effect: CommandEffect;
  /** Other entries worth knowing about beside this one. */
  readonly related?: readonly string[];
  /** What replaced it, where it is on the way out. */
  readonly deprecated?: string;
  /** Where it is not available everywhere. */
  readonly availability?: string;
}

export interface CommandGroup {
  readonly platform: ScriptPlatform;
  readonly name: string;
  readonly commands: readonly CommandEntry[];
}

/** Build a group, stamping the platform onto every entry so it cannot drift. */
export function group(platform: ScriptPlatform, name: string, commands: readonly Omit<CommandEntry, 'platform' | 'group' | 'id'>[]): CommandGroup {
  const prefix = platform === 'powershell' ? 'ps' : platform === 'python' ? 'py' : platform === 'bash' ? 'sh' : 'cmd';
  return {
    platform,
    name,
    commands: commands.map((command) => ({
      ...command,
      platform,
      group: name,
      id: `${prefix}.${command.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
    })),
  };
}

/** Every command in a set of groups, flattened. */
export function allCommands(groups: readonly CommandGroup[]): readonly CommandEntry[] {
  return groups.flatMap((g) => g.commands);
}

/**
 * Search the catalogue the way people actually look.
 *
 * The task text is weighted above the name, because someone looking for "how do
 * I list open ports" does not know the answer is `ss` — which is the whole
 * reason for having this.
 */
export function search(commands: readonly CommandEntry[], query: string, limit = 40): readonly CommandEntry[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return commands.slice(0, limit);

  const scored = commands
    .map((command) => {
      const name = command.name.toLowerCase();
      const task = command.task.toLowerCase();
      const note = (command.note ?? '').toLowerCase();
      const module = (command.module ?? '').toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 100;
        else if (name.includes(term)) score += 40;
        if (task.includes(term)) score += 30;
        if (module.includes(term)) score += 10;
        if (note.includes(term)) score += 5;
        if (command.group.toLowerCase().includes(term)) score += 8;
      }
      return { command, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));

  return scored.slice(0, limit).map((entry) => entry.command);
}

export function commandById(commands: readonly CommandEntry[], id: string): CommandEntry | undefined {
  return commands.find((command) => command.id === id);
}

/**
 * What the catalogue itself has to say.
 *
 * A deprecated command that still works is the dangerous kind: it will keep
 * working until the release that removes it, and then it stops everywhere at
 * once.
 */
export function catalogFindings(commands: readonly CommandEntry[]): Finding[] {
  const findings: Finding[] = [];
  const deprecated = commands.filter((command) => command.deprecated);
  const destructive = commands.filter((command) => command.effect === 'destructive');

  findings.push(
    info('scripts.catalog.size', `${commands.length} commands catalogued, across ${new Set(commands.map((c) => c.group)).size} groups.`, { source: 'ArchToolKit' }),
  );

  if (deprecated.length > 0) {
    findings.push(
      warning('scripts.catalog.deprecated', `${deprecated.length} of these are deprecated and still work. That is the dangerous kind: they keep working until the release that removes them, and then stop everywhere at once.`, {
        remediation: 'Each one names its replacement. Prefer the replacement in anything new.',
        source: 'ArchToolKit',
      }),
    );
  }

  if (destructive.length > 0) {
    findings.push(
      info('scripts.catalog.destructive', `${destructive.length} delete, overwrite or disable something. The generator wraps those in a confirmation and a dry run rather than emitting them bare.`, { source: 'ArchToolKit' }),
    );
  }

  return findings;
}

/** Coverage by group, for the page to show what is and is not covered. */
export function coverage(groups: readonly CommandGroup[]): readonly { readonly group: string; readonly count: number; readonly withNotes: number }[] {
  return groups
    .map((g) => ({
      group: g.name,
      count: g.commands.length,
      withNotes: g.commands.filter((c) => c.note).length,
    }))
    .sort((a, b) => b.count - a.count);
}
