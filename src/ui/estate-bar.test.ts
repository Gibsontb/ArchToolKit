import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estateWorkbook } from '../testing/estate-fixture.ts';
import { importEstateFiles } from './estate-bar.ts';

test('reads a costing workbook once and rejects a second workbook before reading it', async () => {
  const workbook = await estateWorkbook();
  const buffer = new Uint8Array(workbook).buffer;
  let reads = 0;
  const file = {
    name: 'rvtools.xlsx',
    arrayBuffer: async () => { reads++; return buffer; },
  } as File;
  const snapshots: string[] = [];
  const result = await importEstateFiles([file], (message) => {
    if (message.startsWith('Reading ')) snapshots.push(message.split(' (')[0]!);
  }, true);
  assert.equal(reads, 1);
  assert.equal(result.inventory.vms.filter(({ name }) => name === 'app-01').length, 1);
  assert.equal(new Set(snapshots).size, snapshots.length);
  await assert.rejects(importEstateFiles([file, file], undefined, true), /one RVTools workbook/);
  assert.equal(reads, 1);
});
