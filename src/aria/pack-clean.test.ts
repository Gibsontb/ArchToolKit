import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { zip } from '../kit/archive.ts';
import { openZip } from '../core/zip.ts';
import { readDashboardExports } from './parse.ts';
import { removeDashboards, removeFromDashboardJson } from './pack-clean.ts';

const dash = (id: string, name: string) => ({ id, name, widgets: [], creationTime: 1758226000000 });
/** One owner's bundle: a zip holding dashboard/dashboard.json. */
const bundle = (dashboards: unknown[]) =>
  zip({ 'dashboard/dashboard.json': JSON.stringify({ entries: { resourceKind: [] }, dashboards, uuid: 'u-1' }, null, 3), 'dashboard/resources/resources.properties': '#Dashboard Localization\n' }, new Date(0), { keepOrder: true });

async function pack(): Promise<Uint8Array> {
  return zip(
    {
      'configuration.json': JSON.stringify({ customGroups: 2, dashboards: 3, dashboardsByOwner: [{ owner: 'owner-a', count: 2 }, { owner: 'owner-b', count: 1 }], views: 4 }, null, 3),
      'dashboards/owner-a': await bundle([dash('a1', 'Capacity'), dash('a2', 'Health')]),
      'dashboards/owner-b': await bundle([dash('b1', 'Only one')]),
      'dashboardsharings/owner-b': '{"shared":true}',
      'alertdefs.xml': '<alertDefs/>',
    },
    new Date(0),
    { keepOrder: true },
  );
}

const removalsFor = async (bytes: Uint8Array, ids: string[]) =>
  (await readDashboardExports('pack.zip', bytes)).flatMap((e) =>
    (e.json['dashboards'] as { id: string }[]).filter((d) => ids.includes(d.id)).map((d) => ({ id: d.id, file: e.file, json: d })),
  );

describe('aria/pack-clean: dashboards out of an export', () => {
  it('cuts a dashboard out of the array and leaves the rest of the text as it was', () => {
    const text = '{\n   "entries": {"a": [1, 2]},\n   "dashboards": [\n      {"id": "x", "big": 12345678901234567890},\n      {"id": "y", "name": "keep \\"this\\" }]"}\n   ],\n   "uuid": "u"\n}';
    const out = removeFromDashboardJson(text, (d) => d['id'] === 'x');
    expect(out.removed).toBe(1);
    expect(out.left).toBe(1);
    expect(out.text.includes('"id": "x"')).toBe(false);
    // The kept dashboard, the keys around the array, and an untouched big number elsewhere.
    expect(out.text.includes('{"id": "y", "name": "keep \\"this\\" }]"}')).toBe(true);
    expect(out.text.startsWith('{\n   "entries": {"a": [1, 2]},')).toBe(true);
    expect(out.text.endsWith('"uuid": "u"\n}')).toBe(true);
    expect((JSON.parse(out.text) as { dashboards: unknown[] }).dashboards.length).toBe(1);
  });

  it('removes one dashboard from its owner’s bundle, fixes the counts, and leaves every other entry byte for byte', async () => {
    const bytes = await pack();
    const out = await removeDashboards('pack.zip', bytes, await removalsFor(bytes, ['a2']));
    expect(out.removed).toBe(1);
    expect(out.bundlesDropped).toBe(0);
    const left = (await readDashboardExports('pack.zip', out.bytes)).flatMap((e) => (e.json['dashboards'] as { id: string }[]).map((d) => d.id));
    expect(left.sort()).toEqual(['a1', 'b1']);
    const before = openZip(bytes);
    const after = openZip(out.bytes);
    expect([...after.names]).toEqual([...before.names]);
    for (const name of ['dashboards/owner-b', 'dashboardsharings/owner-b', 'alertdefs.xml']) expect([name, [...(await after.bytes(name))]]).toEqual([name, [...(await before.bytes(name))]]);
    const config = JSON.parse(await after.text('configuration.json')) as { dashboards: number; dashboardsByOwner: unknown[]; views: number };
    expect(config.dashboards).toBe(2);
    expect(config.dashboardsByOwner).toEqual([{ owner: 'owner-a', count: 1 }, { owner: 'owner-b', count: 1 }]);
    expect(config.views).toBe(4);
  });

  it('drops an owner left with no dashboards, and its sharing entry', async () => {
    const bytes = await pack();
    const out = await removeDashboards('pack.zip', bytes, await removalsFor(bytes, ['b1']));
    expect(out.bundlesDropped).toBe(1);
    const after = openZip(out.bytes);
    expect(after.has('dashboards/owner-b')).toBe(false);
    expect(after.has('dashboardsharings/owner-b')).toBe(false);
    expect(after.has('dashboards/owner-a')).toBe(true);
    const config = JSON.parse(await after.text('configuration.json')) as { dashboards: number; dashboardsByOwner: unknown[] };
    expect(config.dashboards).toBe(2);
    expect(config.dashboardsByOwner).toEqual([{ owner: 'owner-a', count: 2 }]);
  });

  it('returns the file untouched when nothing is removed', async () => {
    const bytes = await pack();
    expect((await removeDashboards('pack.zip', bytes, [])).bytes).toBe(bytes);
  });

  it('writes a compressed zip the reader opens', async () => {
    const big = 'x'.repeat(20000);
    const out = await zip({ 'a.txt': big, 'b.txt': 'short' }, new Date(0), { keepOrder: true, compress: true });
    expect(out.length < 2000).toBe(true);
    const back = openZip(out);
    expect(await back.text('a.txt')).toBe(big);
    expect(await back.text('b.txt')).toBe('short');
  });
});
