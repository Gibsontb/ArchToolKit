import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '../testing/expect.ts';
import { TRACKER_STATES, loadTrackerIndex, trackerEntryFor, trackerIndexFrom } from './tracker-index.ts';
import { ITEM_STATE_VALUES } from '../multicloud/plan/options.ts';

const plan = {
  kind: 'archtoolkit.multicloud-plan', version: 1, id: 'p1',
  workloads: [
    { id: 'w:web01', name: 'web01', sourceKey: 'VC1|web01' },
    { id: 'w:app01', name: 'APP01' },
    { id: 'w:gone', name: 'gone', sourceKey: 'vc1|gone' },
    { id: 'w:untracked', name: 'untracked' },
  ],
};
const tracker = {
  kind: 'archtoolkit.migration-tracker', version: 1, planId: 'p1',
  items: {
    'w:web01': { item: 'w:web01', state: 'cut-over', wave: 2 },
    'w:app01': { item: 'w:app01', state: 'in-sync', wave: 1 },
    'w:gone': { item: 'w:gone', state: 'planned', wave: 1, removed: true },
  },
};

describe('kit/tracker-index', () => {
  it('imports nothing from src/multicloud', () => {
    const src = readFileSync(fileURLToPath(new URL('./tracker-index.ts', import.meta.url)), 'utf8');
    const specifiers = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g), ...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['./idb.ts']);
    expect(specifiers.some((s) => s?.includes('multicloud'))).toBe(false);
  });

  it('repeats the planner’s states exactly', () => {
    expect([...TRACKER_STATES]).toEqual([...ITEM_STATE_VALUES]);
  });

  it('keys by sourceKey (lower-cased) with the lower-cased name as a fallback; skips removed and untracked items', () => {
    const index = trackerIndexFrom(plan, tracker);
    expect(index.get('vc1|web01')).toEqual({ state: 'cut-over', wave: 2 });
    expect(index.get('web01')).toEqual({ state: 'cut-over', wave: 2 });
    expect(index.get('app01')).toEqual({ state: 'in-sync', wave: 1 });
    expect(index.has('vc1|gone')).toBe(false);
    expect(index.has('untracked')).toBe(false);
    expect(trackerEntryFor(index, 'VC1', 'web01')?.state).toBe('cut-over');
    expect(trackerEntryFor(index, 'other-vc', 'App01')?.state).toBe('in-sync');
    expect(trackerEntryFor(index, undefined, 'nobody')).toBeUndefined();
  });

  it('is empty for a tracker of another plan, a bad record, or nothing stored', async () => {
    expect(trackerIndexFrom(plan, { ...tracker, planId: 'p2' }).size).toBe(0);
    expect(trackerIndexFrom(plan, { ...tracker, version: 2 }).size).toBe(0);
    expect(trackerIndexFrom(null, tracker).size).toBe(0);
    expect(trackerIndexFrom(plan, { ...tracker, items: { 'w:web01': { state: 'flying', wave: 1 } } }).size).toBe(0);
    expect((await loadTrackerIndex()).size).toBe(0);
  });
});
