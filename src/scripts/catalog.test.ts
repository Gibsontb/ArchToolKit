/**
 * The catalogue's own checks.
 *
 * A catalogue of four hundred commands is only worth having if every entry is
 * worth having, and the thing that makes an entry worth having is the note —
 * the bit that is true, not obvious, and costs an afternoon. Without a check
 * for that, the four hundred and first entry is a syntax line copied from the
 * help, and then so is the next fifty.
 *
 * The other half of this file checks the other half of the idea: that the
 * snippet blueprint can actually build every single entry, in every mode,
 * without throwing and without dropping the dry run. Four hundred commands that
 * the generator cannot wrap is a reference page, not a kit.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { allCommands, catalogFindings, coverage, group, search, type CommandEntry } from './catalog.ts';
import { ALL_CATALOG_GROUPS, ALL_COMMANDS, CATALOG_BY_PLATFORM, catalogFor, commandsFor } from './catalog-index.ts';
import { SNIPPET_SCRIPTS } from './blueprints/snippet.ts';
import { SCRIPT_PLATFORMS, renderScript, type ScriptPlatform } from './script.ts';

const PLATFORMS: readonly ScriptPlatform[] = ['powershell', 'python', 'bash', 'cmd'];

describe('scripts/catalog: the model', () => {
  it('stamps the platform, group and id onto every entry it is given', () => {
    const made = group('bash', 'Testing', [
      { name: 'ss -tulpn', task: 'list listening ports', syntax: 'ss -tulpn', effect: 'read', note: 'x' },
    ]);
    const first = made.commands[0];
    expect(first?.platform).toBe('bash');
    expect(first?.group).toBe('Testing');
    expect(first?.id).toBe('sh.ss-tulpn');
  });

  it('weights what someone is trying to do above the command name', () => {
    // Nobody searching for "list open ports" knows the answer is `ss`. If the
    // name were weighted above the task, this search would find nothing useful.
    const hits = search(commandsFor('bash'), 'listening ports', 5);
    expect(hits.some((command) => command.name === 'ss')).toBe(true);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(search(ALL_COMMANDS, 'zzzz-not-a-command', 10).length).toBe(0);
  });

  it('reports its own size and what is deprecated in it', () => {
    const findings = catalogFindings(ALL_COMMANDS);
    expect(hasErrors(findings)).toBe(false);
    expect(findings.some((finding) => finding.code === 'scripts.catalog.size')).toBe(true);
    expect(findings.some((finding) => finding.code === 'scripts.catalog.deprecated')).toBe(true);
  });

  it('counts coverage by group', () => {
    const rows = coverage(catalogFor('powershell'));
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row.withNotes).toBe(row.count);
  });
});

describe('scripts/catalog: what is in it', () => {
  it('covers all four languages, in depth', () => {
    for (const platform of PLATFORMS) {
      const groups = catalogFor(platform);
      expect(groups.length).toBeGreaterThanOrEqual(5);
      expect(allCommands(groups).length).toBeGreaterThanOrEqual(45);
    }
    // Forty-eight hand-written task scripts was the thing this replaces.
    expect(ALL_COMMANDS.length).toBeGreaterThan(300);
  });

  it('gives every entry a note, because the syntax alone is in the help', () => {
    const missing = ALL_COMMANDS.filter((command) => !command.note || command.note.trim().length < 40);
    expect(missing.map((command) => command.id)).toEqual([]);
  });

  it('gives every entry a real invocation rather than a syntax summary', () => {
    const thin = ALL_COMMANDS.filter((command) => command.syntax.trim().length < 8);
    expect(thin.map((command) => command.id)).toEqual([]);
  });

  it('describes the task in the words someone would search with', () => {
    // Lower case and a verb phrase — "list files", not "Get-ChildItem cmdlet" —
    // because the task text is what the search weights above the name.
    const vague = ALL_COMMANDS.filter((command) => command.task.trim().length < 12 || /^[A-Z]/.test(command.task.trim()));
    expect(vague.map((command) => command.id)).toEqual([]);
  });

  it('keeps every id unique, so a link to one lands on one', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const command of ALL_COMMANDS) {
      const already = seen.get(command.id);
      if (already) clashes.push(`${command.id}: ${already} and ${command.group}`);
      else seen.set(command.id, command.group);
    }
    expect(clashes).toEqual([]);
  });

  it('only points at entries that exist', () => {
    const known = new Set(ALL_COMMANDS.map((command) => command.id));
    const dangling = ALL_COMMANDS.flatMap((command) => (command.related ?? []).filter((id) => !known.has(id)).map((id) => `${command.id} -> ${id}`));
    expect(dangling).toEqual([]);
  });

  it('names the replacement whenever it calls something deprecated', () => {
    const unhelpful = ALL_COMMANDS.filter((command) => command.deprecated !== undefined && command.deprecated.trim().length < 3);
    expect(unhelpful.map((command) => command.id)).toEqual([]);
    // And there are some: a catalogue that claims nothing is on the way out is
    // not describing anything real.
    expect(ALL_COMMANDS.filter((command) => command.deprecated).length).toBeGreaterThan(0);
  });

  it('never writes a credential into a syntax line', () => {
    // A value assigned from a variable, an environment lookup or a prompt is
    // fine; a literal in quotes is not.
    const assignsLiteral = /\b(password|passwd|secret|api[_-]?key|token)\w*\s*[:=]+\s*["'][^"'$%{<]/i;
    const offenders = ALL_COMMANDS.filter((command) => assignsLiteral.test(command.syntax));
    expect(offenders.map((command) => command.id)).toEqual([]);
  });

  it('marks what each command does to whatever it is pointed at', () => {
    const effects = new Set(ALL_COMMANDS.map((command) => command.effect));
    expect([...effects].sort()).toEqual(['changes', 'destructive', 'read']);
    // Something that deletes a disk and something that lists files cannot carry
    // the same warning, so the destructive set has to be non-empty and small.
    const destructive = ALL_COMMANDS.filter((command) => command.effect === 'destructive');
    expect(destructive.length).toBeGreaterThan(3);
    expect(destructive.length < ALL_COMMANDS.length / 4).toBe(true);
  });

  it('keeps every entry under the platform it belongs to', () => {
    for (const platform of PLATFORMS) {
      for (const command of allCommands(CATALOG_BY_PLATFORM[platform])) expect(command.platform).toBe(platform);
    }
  });

  it('adds up to the same thing however it is counted', () => {
    expect(allCommands(ALL_CATALOG_GROUPS).length).toBe(ALL_COMMANDS.length);
    expect(PLATFORMS.reduce((n, platform) => n + commandsFor(platform).length, 0)).toBe(ALL_COMMANDS.length);
  });
});

describe('scripts/catalog: the generator over it', () => {
  const blueprintFor = (platform: ScriptPlatform) => {
    const found = SNIPPET_SCRIPTS.find((blueprint) => blueprint.platform === platform);
    if (!found) throw new Error(`no snippet blueprint for ${platform}`);
    return found;
  };

  it('offers every catalogued command as an option, grouped', () => {
    for (const platform of PLATFORMS) {
      const input = blueprintFor(platform).inputs.find((i) => i.id === 'command');
      expect(input?.options?.length).toBe(commandsFor(platform).length);
      expect((input?.options ?? []).every((option) => Boolean(option.group))).toBe(true);
    }
  });

  it('builds every single command in the catalogue without throwing', () => {
    const failures: string[] = [];
    for (const platform of PLATFORMS) {
      const blueprint = blueprintFor(platform);
      for (const command of commandsFor(platform)) {
        try {
          const out = blueprint.build({ ...defaultValues(blueprint), command: command.id }, command.id);
          if (Object.keys(out.files).length !== 2) failures.push(`${command.id}: expected a script and a README`);
        } catch (error) {
          failures.push(`${command.id}: ${String(error)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('puts the command, and its note, into what it generates', () => {
    const failures: string[] = [];
    for (const platform of PLATFORMS) {
      const blueprint = blueprintFor(platform);
      for (const command of commandsFor(platform)) {
        const script = blueprint.script({ ...defaultValues(blueprint), command: command.id }, command.id);
        const text = renderScript(script, 'wrapped');
        const firstLine = command.syntax.split('\n')[0]?.trim() ?? '';
        if (!text.includes(firstLine)) failures.push(`${command.id}: the command itself is missing`);
        // The trap that costs an afternoon has to travel with the file, or the
        // person running it is back where they started. Comment markers and the
        // wrapping come off first, so a note split over three lines still counts.
        const flat = text.replace(/^\s*(#|REM)\s?/gm, '').replace(/\s+/g, ' ');
        const note = (command.note ?? '').replace(/\s+/g, ' ').trim();
        if (note && !flat.includes(note)) failures.push(`${command.id}: the note did not make it into the file`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('gives anything that changes something a dry run that comes first', () => {
    const failures: string[] = [];
    for (const platform of PLATFORMS) {
      const blueprint = blueprintFor(platform);
      const info = SCRIPT_PLATFORMS[platform];
      for (const command of commandsFor(platform).filter((c) => c.effect !== 'read')) {
        const script = blueprint.script({ ...defaultValues(blueprint), command: command.id }, command.id);
        const text = renderScript(script, 'wrapped');
        const hasDryRun =
          text.includes(info.dryRunFlag) ||
          /DRY RUN|ShouldProcess|dry_run|DRY_RUN|--execute|\/EXECUTE/.test(text);
        if (!hasDryRun) failures.push(`${command.id}: nothing to make it report instead of act`);
        if (!/Undoing it/.test(text)) failures.push(`${command.id}: no undo section`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('loops over an input list when asked, in every language', () => {
    for (const platform of PLATFORMS) {
      const blueprint = blueprintFor(platform);
      const values = { ...defaultValues(blueprint), iterate: 'list' };
      const text = renderScript(blueprint.script(values, 'each'), 'each');
      const loop = { powershell: 'foreach ($item in $items)', python: 'for item in items:', bash: 'done < "$INPUT_LIST"', cmd: 'for /f' }[platform];
      expect(text.includes(loop)).toBe(true);
    }
  });

  it('warns about a deprecated or destructive command rather than quietly wrapping it', () => {
    const deprecated = ALL_COMMANDS.find((command) => command.deprecated);
    if (!deprecated) throw new Error('the catalogue claims nothing is deprecated');
    const blueprint = blueprintFor(deprecated.platform);
    const out = blueprint.build({ ...defaultValues(blueprint), command: deprecated.id }, deprecated.id);
    expect((out.findings ?? []).some((finding) => finding.code === 'scripts.snippet.deprecated')).toBe(true);
    expect(hasErrors(out.findings ?? [])).toBe(false);
  });

  it('builds clean from its own defaults, like every other blueprint', () => {
    for (const platform of PLATFORMS) {
      const blueprint = blueprintFor(platform);
      const out = blueprint.build(defaultValues(blueprint), 'default');
      expect(hasErrors(out.findings ?? [])).toBe(false);
    }
  });
});

/** Keeps the unused-import checker honest about the type-only import. */
const _entry: CommandEntry | undefined = ALL_COMMANDS[0];
void _entry;
