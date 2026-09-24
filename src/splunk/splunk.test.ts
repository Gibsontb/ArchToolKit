/**
 * The Splunk kit's own checks.
 *
 * Three properties are worth enforcing, because all three fail silently in
 * Splunk itself: a setting on the wrong tier does nothing and says nothing, a
 * knowledge object with no metadata is invisible to everyone, and a credential
 * in a conf file has already been on disk in plain text before Splunk encrypts
 * it in place.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { SPLUNK_APPS, SPLUNK_BLUEPRINTS, splunkApp } from './blueprints/index.ts';
import { ACTIVATION_MEANING, TIERS, foldSearch, searchTitle, searchWindow, splunkName, spreadCron, type SplunkApp } from './splunk.ts';

function everyApp(): { id: string; app: SplunkApp }[] {
  return SPLUNK_APPS.map((blueprint) => ({ id: blueprint.id, app: blueprint.app(defaultValues(blueprint), blueprint.id) }));
}

describe('splunk: the vocabulary', () => {
  it('makes a name Splunk will accept', () => {
    expect(splunkName('My App 01', 'x')).toBe('my_app_01');
    expect(splunkName('  ', 'fallback')).toBe('fallback');
    expect(splunkName('app-prod.2', 'x')).toBe('app_prod_2');
  });

  it('keeps spaces in a saved search title but drops what Splunk reserves', () => {
    expect(searchTitle('Failed logins by source', 'x')).toBe('Failed logins by source');
    expect(searchTitle('Bad [title] / here', 'x')).toBe('Bad title here');
  });

  it('folds a long pipeline so a conf file stays readable', () => {
    const folded = foldSearch(['index=main', '| stats count by host', '| sort - count']);
    expect(folded[0]).toBe('search = index=main \\');
    expect(folded[folded.length - 1]).toBe('    | sort - count');
    // A one-line search needs no continuation.
    expect(foldSearch(['index=main'])).toEqual(['search = index=main']);
  });

  it('spreads schedules off the hour, but consistently for the same name', () => {
    const first = spreadCron('Failed logins', 60);
    expect(spreadCron('Failed logins', 60)).toBe(first);
    expect(first === '0 */1 * * *').toBe(false);
    expect(spreadCron('Something else', 60) === first).toBe(false);
  });

  it('gives a scheduled search a window longer than its interval', () => {
    // An event that indexes a second after the search runs must still be seen.
    const window = searchWindow(15);
    expect(window.latest).toBe('now');
    const minutes = Number(window.earliest.replace(/[^0-9]/g, ''));
    expect(minutes > 15).toBe(true);
  });
});

describe('every Splunk app', () => {
  it('says what it does, where it goes and how to take it out', () => {
    for (const { id, app } of everyApp()) {
      expect([id, app.title.length > 5]).toEqual([id, true]);
      expect([id, app.app.length > 0]).toEqual([id, true]);
      expect([id, Object.keys(app.files).length > 0]).toEqual([id, true]);
      expect([id, app.before.length > 0]).toEqual([id, true]);
      expect([id, app.verify.length > 0]).toEqual([id, true]);
      expect([id, app.backout.length > 0]).toEqual([id, true]);
    }
  });

  it('declares a tier and an activation the page can warn about', () => {
    for (const { id, app } of everyApp()) {
      expect([id, Object.keys(TIERS).includes(app.tier)]).toEqual([id, true]);
      expect([id, Object.keys(ACTIVATION_MEANING).includes(app.activation)]).toEqual([id, true]);
    }
  });

  it('puts index-time settings only on a tier that parses', () => {
    // A props.conf on a search head does nothing for data arriving over a
    // forwarder, and there is no error anywhere to say so.
    const indexTime = /^\s*(LINE_BREAKER|SHOULD_LINEMERGE|TIME_PREFIX|TIME_FORMAT|MAX_TIMESTAMP_LOOKAHEAD|TRUNCATE|TRANSFORMS-|SEDCMD-)/;
    for (const { id, app } of everyApp()) {
      if (app.tier !== 'search_head') continue;
      for (const [path, lines] of Object.entries(app.files)) {
        if (!path.includes('props.conf')) continue;
        for (const line of lines) {
          expect([id, path, line, indexTime.test(line)]).toEqual([id, path, line, false]);
        }
      }
    }
  });

  it('never writes a credential into a conf file', () => {
    // Splunk encrypts a password in place on restart, which means the plain
    // text was already on disk — and in version control.
    for (const { id, app } of everyApp()) {
      for (const [path, lines] of Object.entries(app.files)) {
        for (const line of lines) {
          if (line.trim().startsWith('#')) continue;
          if (!/^\s*(password|token|pass4SymmKey|sslPassword|clientSecret|bindDNpassword)\s*=/i.test(line)) continue;
          const value = line.split('=').slice(1).join('=').trim();
          const safe = value === '' || /^<|^\$/.test(value);
          expect([id, path, line, safe]).toEqual([id, path, line, true]);
        }
      }
    }
  });

  it('gives every knowledge object its metadata, or nobody can see it', () => {
    // An object with no default.meta is private to an owner that does not
    // exist when it arrives by deployment, so it is visible to nobody.
    const knowledge = /savedsearches\.conf|macros\.conf|data\/ui\/views|data\/models/;
    for (const { id, app } of everyApp()) {
      const hasKnowledge = Object.keys(app.files).some((path) => knowledge.test(path));
      if (!hasKnowledge) continue;
      expect([id, Object.keys(app.files).includes('metadata/default.meta')]).toEqual([id, true]);
    }
  });

  it('builds an app.conf and a deployment note, always', () => {
    for (const blueprint of SPLUNK_APPS) {
      const result = blueprint.build(defaultValues(blueprint), blueprint.id);
      const names = Object.keys(result.files);
      expect([blueprint.id, names.some((n) => n.endsWith('app.conf'))]).toEqual([blueprint.id, true]);
      expect([blueprint.id, names.includes('DEPLOY.md')]).toEqual([blueprint.id, true]);
      // Every file lives inside the app directory, or it is not part of the app.
      for (const name of names) {
        if (name === 'DEPLOY.md') continue;
        expect([blueprint.id, name, name.startsWith(`${blueprint.app(defaultValues(blueprint), blueprint.id).app}/`)]).toEqual([blueprint.id, name, true]);
      }
    }
  });

  it('builds from its own defaults without an error finding', () => {
    for (const blueprint of SPLUNK_APPS) {
      const result = blueprint.build(defaultValues(blueprint), blueprint.id);
      const errors = (result.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code);
      expect([blueprint.id, errors]).toEqual([blueprint.id, []]);
    }
  });

  it('names the index in every generated search', () => {
    // A search with no index reads every index the user can see, which on a
    // large deployment is the difference between finishing and being skipped.
    for (const { id, app } of everyApp()) {
      for (const [path, lines] of Object.entries(app.files)) {
        if (!path.includes('savedsearches.conf')) continue;
        const search = lines.filter((line) => line.startsWith('search =') || line.startsWith('    ')).join(' ');
        if (!search) continue;
        const namesIndex = /index=|datamodel=|\| rest |\| inputlookup |\| makeresults|\| tstats/.test(search);
        expect([id, path, namesIndex]).toEqual([id, path, true]);
      }
    }
  });
});

describe('every tier', () => {
  it('has a blueprint group of its own', () => {
    for (const tier of Object.keys(TIERS)) {
      const group = SPLUNK_BLUEPRINTS.find((g) => g.target === tier);
      expect([tier, group !== undefined]).toEqual([tier, true]);
      expect([tier, (group?.blueprints.length ?? 0) > 0]).toEqual([tier, true]);
    }
  });

  it('can be looked up by id, with unique ids across tiers', () => {
    const ids = SPLUNK_APPS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const blueprint of SPLUNK_APPS) expect(splunkApp(blueprint.id)?.id).toBe(blueprint.id);
    expect(splunkApp('nothing_like_this')).toBe(undefined);
  });

  it('says where the app goes and what puts it there', () => {
    for (const tier of Object.values(TIERS)) {
      expect(tier.deployTo.length > 20).toBe(true);
      expect(tier.distributedBy.length > 10).toBe(true);
      expect(tier.responsibility.length > 20).toBe(true);
    }
  });
});

describe('the generated app', () => {
  it('warns when an index will delete rather than archive', () => {
    const blueprint = splunkApp('splunk_index');
    expect(blueprint).toBeDefined();
    const result = blueprint!.build(defaultValues(blueprint!), 'idx');
    expect(hasErrors(result.findings ?? [])).toBe(false);
    expect((result.findings ?? []).some((f) => f.code === 'splunk.frozen-deletes')).toBe(true);
  });

  it('refuses a monitor input with no index', () => {
    const blueprint = splunkApp('splunk_file_input');
    expect(blueprint).toBeDefined();
    const values = { ...defaultValues(blueprint!), index: '' };
    const result = blueprint!.build(values, 'inputs');
    expect((result.findings ?? []).some((f) => f.code === 'splunk.input-no-index' && f.severity === 'error')).toBe(true);
  });

  it('refuses a single indexer in outputs.conf', () => {
    const blueprint = splunkApp('splunk_outputs');
    expect(blueprint).toBeDefined();
    const values = { ...defaultValues(blueprint!), indexers: 'idx01.example.com:9997' };
    const result = blueprint!.build(values, 'outputs');
    expect((result.findings ?? []).some((f) => f.code === 'splunk.single-indexer')).toBe(true);
  });

  it('says in the deployment note which tier the app goes on', () => {
    for (const blueprint of SPLUNK_APPS) {
      const result = blueprint.build(defaultValues(blueprint), blueprint.id);
      const note = result.files['DEPLOY.md'] ?? '';
      const tier = TIERS[blueprint.tier];
      expect([blueprint.id, note.includes(tier.label)]).toEqual([blueprint.id, true]);
      expect([blueprint.id, note.includes('## Back out')]).toEqual([blueprint.id, true]);
      expect([blueprint.id, note.includes('## Verify')]).toEqual([blueprint.id, true]);
    }
  });
});

describe('files are written the way their readers expect', () => {
  const built = () =>
    SPLUNK_APPS.map((blueprint) => ({ id: blueprint.id, files: blueprint.build(defaultValues(blueprint), blueprint.id).files }));

  it('keeps a lookup CSV header as the first line, or Splunk reads the comment as the column names', () => {
    const bad: string[] = [];
    for (const { id, files } of built()) {
      for (const [path, body] of Object.entries(files)) {
        if (/lookups\/[^/]+\.csv$/.test(path) && body.startsWith('#')) bad.push(`${id}: ${path}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps a script shebang on line one', () => {
    const bad: string[] = [];
    for (const { id, files } of built()) {
      for (const [path, body] of Object.entries(files)) {
        if (/\.(sh|py)$/.test(path) && body.includes('#!/') && !body.startsWith('#!')) bad.push(`${id}: ${path}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('writes JSON that parses', () => {
    const bad: string[] = [];
    for (const { id, files } of built()) {
      for (const [path, body] of Object.entries(files)) {
        if (!path.endsWith('.json')) continue;
        try {
          JSON.parse(body);
        } catch {
          bad.push(`${id}: ${path}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('never puts a note after a command on a network device line, where the CLI would reject it', () => {
    const blueprint = splunkApp('splunk_onboard_network');
    if (!blueprint) throw new Error('missing splunk_onboard_network');
    const bad: string[] = [];
    for (const [path, body] of Object.entries(blueprint.build(defaultValues(blueprint), 'x').files)) {
      if (!/device-config\//.test(path)) continue;
      body.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed && !/^[!#]/.test(trimmed) && /\s!\s/.test(line)) bad.push(`${path}:${index + 1}`);
        if (index === 0 && /Generated by|ArchToolKit/i.test(line)) bad.push(`${path}: generated banner on a device config`);
      });
    }
    expect(bad).toEqual([]);
  });
});
