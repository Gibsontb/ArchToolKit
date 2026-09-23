/**
 * The script kit's own checks.
 *
 * The contract a script here makes is narrow and worth enforcing: it says what
 * it needs, how to run it, and how to undo it; it never writes a credential;
 * and anything that changes something has a way to report instead of act.
 * Those are exactly the properties that get dropped when someone is in a hurry,
 * which is when scripts get written.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { SCRIPT_BLUEPRINTS, SCRIPTS, scriptFor } from './blueprints/index.ts';
import { EFFECT_MEANING, SCRIPT_PLATFORMS, identifier, listOf, pascal, renderScript, snake, type Script } from './script.ts';

/** Every script, built from its own defaults. */
function everyScript(): { id: string; script: Script }[] {
  return SCRIPTS.map((blueprint) => ({ id: blueprint.id, script: blueprint.script(defaultValues(blueprint), blueprint.id) }));
}

describe('scripts/script: the vocabulary', () => {
  it('makes a safe identifier out of whatever someone types', () => {
    expect(identifier('My Script 01', 'x')).toBe('My-Script-01');
    expect(identifier('  ', 'fallback')).toBe('fallback');
    expect(identifier('a/b\\c', 'x')).toBe('a-b-c');
  });

  it('shapes a name for each language the way that language wants it', () => {
    expect(pascal('get application health', 'X')).toBe('GetApplicationHealth');
    expect(snake('Get Application Health', 'x')).toBe('get_application_health');
  });

  it('reads a list written with commas or newlines', () => {
    expect(listOf('a, b\nc')).toEqual(['a', 'b', 'c']);
    expect(listOf('')).toEqual([]);
  });

  it('puts the shebang first, where the platform has one', () => {
    for (const platform of Object.values(SCRIPT_PLATFORMS)) {
      if (!platform.shebang) continue;
      const rendered = renderScript(
        { platform: platform.id, title: 'Test', effect: 'read', requires: [], parameters: [], body: ['true'], usage: ['x'], undo: ['none'] },
        'test',
      );
      expect([platform.id, rendered.split('\n')[0]]).toEqual([platform.id, platform.shebang]);
    }
  });
});

describe('every script', () => {
  it('says what it does, how to run it and how to undo it', () => {
    for (const { id, script } of everyScript()) {
      expect([id, script.title.length > 10]).toEqual([id, true]);
      expect([id, script.body.length > 0]).toEqual([id, true]);
      expect([id, script.usage.length > 0]).toEqual([id, true]);
      expect([id, script.undo.length > 0]).toEqual([id, true]);
    }
  });

  it('declares an effect the page can warn about', () => {
    for (const { id, script } of everyScript()) {
      expect([id, Object.keys(EFFECT_MEANING).includes(script.effect)]).toEqual([id, true]);
    }
  });

  it('never writes a credential into a script', () => {
    // What matters is an assignment of a literal: `password = "hunter2"`.
    // Naming a credential, reading one from the environment, prompting for one
    // or leaving a `<REQUIRED>` gap are all what these scripts are supposed to
    // do — so the rule looks for the assignment, not for the word.
    const assignsLiteral = /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*[:=]+\s*["'][^"'$%{<@]/i;
    for (const { id, script } of everyScript()) {
      const comment = SCRIPT_PLATFORMS[script.platform].comment;
      for (const line of script.body) {
        const trimmed = line.trim();
        if (trimmed.startsWith(comment) || trimmed.toLowerCase().startsWith('rem ')) continue;
        if (!assignsLiteral.test(line)) continue;
        // An empty string is clearing a variable, not setting a credential.
        const clearing = /[:=]+\s*["']["']/.test(line);
        expect([id, line, clearing]).toEqual([id, line, true]);
      }
    }
  });

  it('gives anything that changes something a way to report instead', () => {
    for (const { id, script } of everyScript()) {
      if (script.effect === 'read') continue;
      const platform = SCRIPT_PLATFORMS[script.platform];
      const text = script.body.join('\n');
      // In PowerShell the dry run is `SupportsShouldProcess`, which supplies
      // -WhatIf for free — but only for the lines inside ShouldProcess, so
      // both halves have to be there.
      const shouldProcess = script.platform === 'powershell' && /SupportsShouldProcess/.test(text) && /\$PSCmdlet\.ShouldProcess/.test(text);
      const hasDryRun = shouldProcess || text.includes(platform.dryRunFlag) || /WhatIf|DRY_RUN|dry_run|DryRun|WHATIF/i.test(text);
      expect([id, hasDryRun]).toEqual([id, true]);
    }
  });

  it('builds a script and a README, always', () => {
    for (const blueprint of SCRIPTS) {
      const result = blueprint.build(defaultValues(blueprint), blueprint.id);
      const names = Object.keys(result.files);
      const platform = SCRIPT_PLATFORMS[blueprint.platform];
      expect([blueprint.id, names.some((n) => n.endsWith(platform.extension))]).toEqual([blueprint.id, true]);
      expect([blueprint.id, names.includes('README.md')]).toEqual([blueprint.id, true]);
    }
  });

  it('builds from its own defaults without an error finding', () => {
    for (const blueprint of SCRIPTS) {
      const result = blueprint.build(defaultValues(blueprint), blueprint.id);
      const errors = (result.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code);
      expect([blueprint.id, errors]).toEqual([blueprint.id, []]);
    }
  });

  it('carries its own header into the rendered file, in that language’s comment syntax', () => {
    for (const blueprint of SCRIPTS) {
      const script = blueprint.script(defaultValues(blueprint), blueprint.id);
      const rendered = renderScript(script, blueprint.id);
      const comment = SCRIPT_PLATFORMS[script.platform].comment;
      expect([blueprint.id, rendered.includes(`${comment} ${script.title}`)]).toEqual([blueprint.id, true]);
      expect([blueprint.id, rendered.includes('Running it')]).toEqual([blueprint.id, true]);
      expect([blueprint.id, rendered.includes('Undoing it')]).toEqual([blueprint.id, true]);
      // Every line of the header — everything above the separator — must be
      // commented out, or the file will not run.
      const header = rendered.split('\n');
      const separator = header.findIndex((line) => line.includes('='.repeat(20)));
      expect([blueprint.id, separator > 0]).toEqual([blueprint.id, true]);
      for (const line of header.slice(0, separator)) {
        if (line === '' || line.startsWith('#!')) continue;
        expect([blueprint.id, line, line.startsWith(comment)]).toEqual([blueprint.id, line, true]);
      }
    }
  });
});

describe('every platform', () => {
  it('has a blueprint group of its own', () => {
    for (const platform of Object.keys(SCRIPT_PLATFORMS)) {
      const group = SCRIPT_BLUEPRINTS.find((g) => g.target === platform);
      expect([platform, group !== undefined]).toEqual([platform, true]);
      expect([platform, (group?.blueprints.length ?? 0) > 0]).toEqual([platform, true]);
    }
  });

  it('can be looked up by id', () => {
    for (const blueprint of SCRIPTS) {
      expect([blueprint.id, scriptFor(blueprint.id)?.id]).toEqual([blueprint.id, blueprint.id]);
    }
    expect(scriptFor('nothing_like_this')).toBe(undefined);
  });

  it('uses a unique id across every language', () => {
    const ids = SCRIPTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the generated files', () => {
  it('put the usage and the undo where someone will read them', () => {
    const blueprint = scriptFor('ps_ad_bulk_users');
    expect(blueprint).toBeDefined();
    const result = blueprint!.build(defaultValues(blueprint!), 'starters');
    const readme = result.files['README.md'] ?? '';
    expect(readme.includes('## Running it')).toBe(true);
    expect(readme.includes('## Undoing it')).toBe(true);
    expect(readme.includes('## What it needs')).toBe(true);
  });

  it('warns rather than refuses when a destructive script is generated', () => {
    const blueprint = scriptFor('py_file_organiser');
    expect(blueprint).toBeDefined();
    const values = { ...defaultValues(blueprint!), action: 'move' };
    const result = blueprint!.build(values, 'tidy');
    expect(hasErrors(result.findings ?? [])).toBe(false);
    expect((result.findings ?? []).some((f) => f.code === 'scripts.destructive')).toBe(true);
  });

  it('names the file after what the person called it, not after the blueprint', () => {
    const blueprint = scriptFor('sh_skeleton');
    expect(blueprint).toBeDefined();
    const result = blueprint!.build(defaultValues(blueprint!), 'nightly maintenance');
    expect(Object.keys(result.files)).toContain('nightly-maintenance.sh');
  });
});
