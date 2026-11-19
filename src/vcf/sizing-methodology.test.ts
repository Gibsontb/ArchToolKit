import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStorage, sizeWorkloadCluster } from './sizing.ts';
import { SIZING_FORM_DEFAULTS, planFromForm, formFromSizingInput, estateOptions, ESTATE_EXTRAS_DEFAULTS } from '../ui/vcf-sizing-form.ts';
import { estateWorkbook } from '../testing/estate-fixture.ts';
import { importRvToolsWorkbook } from '../vmware/rvtools.ts';
import { planEstate } from './estate-plan.ts';
import { SIZING_METHODOLOGY } from './sizing-methodology.ts';

const host = { cpuSockets: 2, coresPerCpu: 32, ramGib: 1024, rawStorageGib: 10000, hyperthreading: true };

test('workbook workload storage includes swap exactly once in fit and result', () => {
  const result = sizeWorkloadCluster({ name: 'workload', host, storage: 'vsan-esa', vcpu: 32, ramGib: 100, storageGib: 50000, vsan: { model: 'workbook' } });
  const expected = computeStorage('vsan-esa', 'standard', result.hosts, host, 1, 50000, { model: 'workbook', swapGib: 100 });
  assert.equal(result.storage.rawRequiredGib, expected.rawRequiredGib);
  assert.equal(result.storage.sufficient, true);
  const smaller = computeStorage('vsan-esa', 'standard', result.hosts - 1, host, 1, 50000, { model: 'workbook', swapGib: 100 });
  assert.equal(smaller.sufficient, false);
});

test('manual default and round trip preserve the selected formula', () => {
  const plan = planFromForm(SIZING_FORM_DEFAULTS);
  assert.equal(plan.primary.vsan?.model, 'workbook');
  for (const model of ['engine', 'workbook'] as const) {
    const values = formFromSizingInput({ ...plan.primary, vsan: { model } });
    assert.equal(planFromForm(values).primary.vsan?.model, model);
  }
});

test('estate and management sizing share the chosen formula without stacking storage growth', async () => {
  const { inventory } = await importRvToolsWorkbook(new Uint8Array(await estateWorkbook()));
  const plan = planEstate(inventory, { host, workloadStorage: 'vsan-esa', growth: 0.2 });
  assert.equal(plan.options.vsanModel, 'workbook');
  assert.equal(plan.management.vsan?.model, 'workbook');
  const options = estateOptions(plan.options, ESTATE_EXTRAS_DEFAULTS, { ...SIZING_FORM_DEFAULTS, vsanModel: 'engine' });
  assert.equal(options.vsanModel, 'engine');
  const raw = planEstate(inventory, { ...options, workloadStorage: 'vsan-esa' });
  const wbClusters = plan.domains.filter(d => d.kind === 'workload').flatMap(d => d.clusters);
  const rawClusters = raw.domains.filter(d => d.kind === 'workload').flatMap(d => d.clusters);
  assert.ok(wbClusters.length > 0);
  for (let i = 0; i < wbClusters.length; i++) assert.ok(Math.abs(wbClusters[i]!.storageGib * 1.1 - rawClusters[i]!.storageGib) < 0.001);
});

test('offline methodology identifies its snapshot and separates assumptions', () => {
  assert.equal(SIZING_METHODOLOGY.workbookSnapshot, '2026-09-27');
  assert.ok(SIZING_METHODOLOGY.rules.every(rule => /^https:\/\//.test(rule.source)));
  assert.ok(SIZING_METHODOLOGY.limitations.some(text => text.includes('9.0')));
});
