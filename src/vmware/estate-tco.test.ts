import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estateTco } from './estate-tco.ts';

test('uses cash-flow refreshes and includes migration and overlap when comparing cloud', () => {
  const result = estateTco({
    years: 2, purchaseNow: false, refreshMonths: 60, firstRefreshMonths: 12,
    hardwareCost: 1200, sourceMonthly: 100, sourceGrowth: 0, hardwareGrowth: 0, discountRate: 0,
    cloud: { monthly: 50, annualGrowth: 0, upfront: 500, dualRunMonths: 2 },
  });
  assert.deepEqual(result.rows.map(({ capital, operating, cloudSpend }) => [capital, operating, cloudSpend]), [
    [0, 1200, 1300], [1200, 1200, 600],
  ]);
  assert.equal(result.sourceTotal, 3600);
  assert.equal(result.cloudTotal, 1900);
  assert.equal(result.crossover, 13);
  assert.equal(result.sourcePresentValue, result.sourceTotal);
});
