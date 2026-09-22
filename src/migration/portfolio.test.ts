/**
 * The portfolio: waves, the CSV and JSON round trip, and what an import does
 * with a file that is not quite right.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { countWaves, wavePlan, WAVE_MODES } from './waves.ts';
import { applicationFromRow, CSV_COLUMNS, entryFor, exportCsv, exportJson, importCsv, importJson, merge, parseCsv, reevaluate, remove, upsert } from './portfolio.ts';
import { DEFAULT_RATINGS, EMPTY_APPLICATION, NO_GATES, type Application } from './types.ts';

const app = (over: Partial<Application> = {}): Application => ({ ...EMPTY_APPLICATION, name: 'Ledger', ...over });

describe('waves', () => {
  it('blocks what cannot move, and puts an outcome that removes footprint first', () => {
    expect(wavePlan('Retain', 90, 'Low').wave).toBe('Blocked');
    expect(wavePlan('Retire', 10, 'High').wave).toBe('Wave 1');
    expect(wavePlan('Repurchase', 50, 'High').wave).toBe('Wave 1');
  });

  it('sorts the rest by risk and readiness', () => {
    expect(wavePlan('Rehost', 60, 'Low').wave).toBe('Wave 1');
    expect(wavePlan('Rehost', 45, 'Medium').wave).toBe('Wave 2');
    expect(wavePlan('Refactor', 90, 'High').wave).toBe('Wave 3');
    expect(wavePlan('Rehost', 30, 'Low').wave).toBe('Wave 3');
  });

  it('changes what goes first when the programme does', () => {
    expect(wavePlan('Rehost', 45, 'Medium', 'fast').wave).toBe('Wave 1');
    expect(wavePlan('Refactor', 75, 'Medium', 'modernize').wave).toBe('Wave 1');
    // The mode never rescues a high-risk application from its own discovery.
    expect(wavePlan('Rehost', 45, 'High', 'fast').wave).toBe('Wave 3');
    expect(wavePlan('Refactor', 65, 'Medium', 'modernize').wave).toBe('Wave 2');
  });

  it('says why, every time', () => {
    for (const mode of WAVE_MODES) {
      const plan = wavePlan('Rehost', 50, 'Medium', mode.id);
      expect([mode.id, plan.rationale.length > 10]).toEqual([mode.id, true]);
    }
  });

  it('counts a portfolio', () => {
    expect(countWaves(['Wave 1', 'Wave 1', 'Wave 3', 'Blocked'])).toEqual({ total: 4, wave1: 2, wave2: 0, wave3: 1, blocked: 1 });
  });
});

describe('holding a portfolio', () => {
  it('replaces an application evaluated again rather than adding a second row', () => {
    const first = entryFor(app({ owner: 'Finance' }));
    const second = entryFor(app({ owner: 'Treasury' }));
    const held = upsert(upsert([], first), second);
    expect(held.length).toBe(1);
    expect(held[0]?.application.owner).toBe('Treasury');
  });

  it('matches on the name however it was typed', () => {
    expect(entryFor(app({ name: 'Ledger  ' })).id).toBe(entryFor(app({ name: 'ledger' })).id);
  });

  it('removes one, and re-evaluates the rest with the current rules', () => {
    const held = [entryFor(app({ name: 'A' })), entryFor(app({ name: 'B' }))];
    expect(remove(held, 'a').map((e) => e.id)).toEqual(['b']);
    const again = reevaluate(held);
    expect(again.map((e) => e.evaluation.route)).toEqual(held.map((e) => e.evaluation.route));
  });
});

describe('reading a CSV', () => {
  it('handles quoted fields, embedded commas and CRLF', () => {
    expect(parseCsv('a,b\r\n"one, two",three\r\n')).toEqual([
      ['a', 'b'],
      ['one, two', 'three'],
    ]);
    expect(parseCsv('a\n"say ""hi"""\n')).toEqual([['a'], ['say "hi"']]);
  });

  it('turns a row into an application, with the ratings left to be answered', () => {
    const subject = applicationFromRow({
      name: 'Claims',
      owner: 'Ops',
      criticality: 'mission critical',
      rtoHours: '2',
      rpoHours: '0.5',
      compliance: 'cjis; hipaa',
      dataSovereigntyRequired: 'yes',
      enterpriseStandardCloud: 'AZURE',
      integrationCount: '18',
    });
    expect(subject.criticality).toBe('Mission Critical');
    expect(subject.rtoHours).toBe(2);
    expect(subject.compliance).toEqual(['cjis', 'hipaa']);
    expect(subject.gates.dataSovereigntyRequired).toBe(true);
    expect(subject.enterpriseStandardCloud).toBe('azure');
    expect(subject.ratings).toEqual(DEFAULT_RATINGS);
  });

  it('imports an inventory as drafts, and says so', () => {
    const csv = `${CSV_COLUMNS.join(',')}\nClaims,Ops,High,4,1,General LOB App,,Java 17,RHEL 9,PostgreSQL 15,,12,400,Entra ID,pci,no,\n`;
    const result = importCsv(csv);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.draft).toBe(true);
    expect((result.entries[0]?.evaluation.route ?? '').length > 0).toBe(true);
    expect(result.findings.some((f) => f.code === 'migration.csv.imported')).toBe(true);
  });

  it('refuses a file with no name column, and says what it expected', () => {
    const result = importCsv('owner,criticality\nOps,High\n');
    expect(result.entries).toEqual([]);
    expect(result.findings[0]?.code).toBe('migration.csv.no-name-column');
    expect(result.findings[0]?.remediation?.includes('name')).toBe(true);
  });

  it('skips a nameless row, warns about a repeated one, and ignores a column it does not read', () => {
    const csv = 'name,owner,costCentre\nClaims,Ops,123\n,Ops,123\nClaims,Finance,123\n';
    const result = importCsv(csv);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.application.owner).toBe('Finance');
    expect(result.findings.some((f) => f.code === 'migration.csv.no-name')).toBe(true);
    expect(result.findings.some((f) => f.code === 'migration.csv.duplicate')).toBe(true);
    expect(result.findings.some((f) => f.code === 'migration.csv.extra-column')).toBe(true);
  });

  it('says plainly when there is nothing in the file', () => {
    expect(importCsv('').findings[0]?.code).toBe('migration.csv.empty');
  });
});

describe('writing a CSV', () => {
  const held = [entryFor(app({ name: 'Ledger, core', compliance: ['pci'] }))];

  it('carries the intake and the verdict, with the wave the page is showing', () => {
    const csv = exportCsv(held, () => 'Wave 2');
    const [header, row] = csv.trim().split('\n');
    expect(header?.includes('readiness,route,targetCloud,risk,wave')).toBe(true);
    expect(row?.startsWith('"Ledger, core"')).toBe(true);
    expect(row?.includes('Wave 2')).toBe(true);
  });

  it('reads back into the same applications', () => {
    const rows = parseCsv(exportCsv(held));
    const header = rows[0] as string[];
    const cells = rows[1] as string[];
    const row: Record<string, string> = {};
    header.forEach((column, i) => {
      row[column] = cells[i] ?? '';
    });
    expect(applicationFromRow(row).name).toBe('Ledger, core');
    expect(applicationFromRow(row).compliance).toEqual(['pci']);
  });
});

describe('JSON', () => {
  const held = [entryFor(app({ name: 'Ledger', ratings: { ...DEFAULT_RATINGS, cloudCompatibility: 5 }, gates: { ...NO_GATES, vendorSaaSAvailable: true } }))];

  it('goes out and comes back the same, ratings and gates included', () => {
    const result = importJson(exportJson(held));
    expect(result.entries.length).toBe(1);
    const back = result.entries[0]?.application;
    expect(back?.ratings.cloudCompatibility).toBe(5);
    expect(back?.gates.vendorSaaSAvailable).toBe(true);
    expect(result.entries[0]?.evaluation.route).toBe(held[0]?.evaluation.route);
  });

  it('accepts a bare application and a bare array, which is what the older page wrote', () => {
    expect(importJson(JSON.stringify({ name: 'Solo', criticality: 'High' })).entries.length).toBe(1);
    expect(importJson(JSON.stringify([{ name: 'One' }, { name: 'Two' }])).entries.length).toBe(2);
  });

  it('evaluates again on the way in rather than trusting a stored verdict', () => {
    const tampered = JSON.stringify([{ application: { name: 'Fibbed', ratings: DEFAULT_RATINGS }, evaluation: { route: 'Refactor', readiness: 99 } }]);
    const back = importJson(tampered).entries[0];
    expect(back?.evaluation.readiness).toBe(50);
    expect(back?.evaluation.route).toBe('Rehost');
  });

  it('says what is wrong with a file it cannot use', () => {
    expect(importJson('{ nope').findings[0]?.code).toBe('migration.json.unreadable');
    expect(importJson('[]').findings.some((f) => f.code === 'migration.json.nothing-read')).toBe(true);
    expect(importJson(JSON.stringify([{ owner: 'Ops' }])).findings.some((f) => f.code === 'migration.json.skipped')).toBe(true);
  });

  it('merges an import into what is already held, the import winning', () => {
    const existing = [entryFor(app({ name: 'Ledger', owner: 'Finance' })), entryFor(app({ name: 'Claims' }))];
    const incoming = [entryFor(app({ name: 'Ledger', owner: 'Treasury' }))];
    const merged = merge(existing, incoming);
    expect(merged.length).toBe(2);
    expect(merged.find((e) => e.id === 'ledger')?.application.owner).toBe('Treasury');
  });
});
