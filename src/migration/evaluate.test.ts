/**
 * What the evaluation has to get right.
 *
 * The scoring first, because it is the thing that was wrong in the page this
 * was ported from: the form says 5 is the best case for every factor, so
 * raising any rating must raise readiness, never lower it.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { courseOfAction, evaluate, isRegulated, normalizeCompliance, readinessScore, riskOf, targetCloud, WEIGHTS } from './evaluate.ts';
import { DEFAULT_RATINGS, EMPTY_APPLICATION, NO_GATES, type Application, type Ratings } from './types.ts';
import { playbookFor } from './playbook.ts';

const app = (over: Partial<Application> = {}): Application => ({ ...EMPTY_APPLICATION, name: 'Test app', ...over });

describe('readiness', () => {
  it('reads every factor the way the form labels it: 5 is best', () => {
    for (const key of Object.keys(WEIGHTS) as (keyof Ratings)[]) {
      const low = readinessScore({ ...DEFAULT_RATINGS, [key]: 1 });
      const high = readinessScore({ ...DEFAULT_RATINGS, [key]: 5 });
      expect([key, high > low]).toEqual([key, true]);
    }
  });

  it('runs 0 to 100 and puts the middle in the middle', () => {
    const all = (n: number): Ratings => ({
      cloudCompatibility: n,
      technicalDebt: n,
      vendorLockRisk: n,
      complianceComplexity: n,
      architectureModularity: n,
      refactorEffort: n,
    });
    expect([readinessScore(all(1)), readinessScore(all(3)), readinessScore(all(5))]).toEqual([0, 50, 100]);
  });

  it('takes a missing or impossible rating as the middle of the range', () => {
    expect(readinessScore({ ...DEFAULT_RATINGS, technicalDebt: Number.NaN })).toBe(50);
    expect(readinessScore({ ...DEFAULT_RATINGS, technicalDebt: 99 })).toBe(readinessScore({ ...DEFAULT_RATINGS, technicalDebt: 5 }));
  });

  it('weights the factors as the original did', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(WEIGHTS.cloudCompatibility > WEIGHTS.vendorLockRisk).toBe(true);
  });
});

describe('the course of action', () => {
  it('lets a hard constraint decide, whatever the score says', () => {
    const perfect = { cloudCompatibility: 5, technicalDebt: 5, vendorLockRisk: 5, complianceComplexity: 5, architectureModularity: 5, refactorEffort: 5 };
    const obsolete = app({ ratings: perfect, gates: { ...NO_GATES, isObsolete: true } });
    expect(courseOfAction(obsolete, readinessScore(perfect)).route).toBe('Retire');

    const saas = app({ ratings: perfect, gates: { ...NO_GATES, vendorSaaSAvailable: true } });
    expect(courseOfAction(saas, 100).route).toBe('Repurchase');

    const bound = app({ ratings: perfect, gates: { ...NO_GATES, mainframeBound: true } });
    expect(courseOfAction(bound, 100).route).toBe('Retain');
  });

  it('keeps SaaS behind a policy that says the application stays put', () => {
    const both = app({ gates: { ...NO_GATES, vendorSaaSAvailable: true, mustStayOnPrem: true } });
    expect(courseOfAction(both, 90).route).toBe('Retain');
  });

  it('follows the readiness bands otherwise', () => {
    const plain = app();
    expect(courseOfAction(plain, 85).route).toBe('Refactor');
    expect(courseOfAction(plain, 65).route).toBe('Replatform');
    expect(courseOfAction(plain, 45).route).toBe('Rehost');
    expect(courseOfAction(plain, 25).route).toBe('Retain');
    expect(courseOfAction(plain, 10).route).toBe('Retire');
  });

  it('says why, in a sentence that carries the number', () => {
    expect(courseOfAction(app(), 65).rationale.includes('65')).toBe(true);
  });
});

describe('compliance', () => {
  it('folds the shorthands people type into the long names', () => {
    expect(normalizeCompliance('PCI, SOC 2').sort()).toEqual(['pci_dss', 'soc2']);
    expect(normalizeCompliance(['ISO 27001']).includes('iso27001')).toBe(true);
  });

  it('takes FedRAMP as implying a commercial boundary', () => {
    expect(normalizeCompliance(['fedramp']).includes('commercial')).toBe(true);
    expect(normalizeCompliance(['fedramp']).includes('fedramp_moderate')).toBe(true);
  });

  it('knows which scopes mean regulated', () => {
    expect(isRegulated(['cjis'])).toBe(true);
    expect(isRegulated(['itar'])).toBe(true);
    expect(isRegulated(['hipaa'])).toBe(false);
    expect(isRegulated([])).toBe(false);
  });
});

describe('the target cloud', () => {
  it('follows the enterprise standard before anything else', () => {
    const chosen = targetCloud(app({ enterpriseStandardCloud: 'gcp', database: 'Oracle Database 19c' }));
    expect(chosen.cloud).toBe('gcp');
    expect(chosen.rationale.includes('standardised')).toBe(true);
  });

  it('puts regulated and sovereign data before the stack signals', () => {
    expect(targetCloud(app({ compliance: ['cjis'], database: 'Oracle' })).cloud).toBe('aws');
    expect(targetCloud(app({ compliance: ['cjis'], primaryStack: 'C# / .NET 8' })).cloud).toBe('azure');
    expect(targetCloud(app({ gates: { ...NO_GATES, dataSovereigntyRequired: true } })).cloud).toBe('aws');
  });

  it('reads the stack when nothing stronger applies', () => {
    expect(targetCloud(app({ database: 'Oracle Database 19c' })).cloud).toBe('oci');
    expect(targetCloud(app({ database: 'Microsoft SQL Server 2019' })).cloud).toBe('azure');
    expect(targetCloud(app({ workloadType: 'AI/ML' })).cloud).toBe('gcp');
    expect(targetCloud(app()).cloud).toBe('aws');
  });
});

describe('risk', () => {
  it('adds up the answers that make a move risky, and says which they were', () => {
    const risky = riskOf(app({ criticality: 'Mission Critical', rtoHours: 2, rpoHours: 0.5, integrationCount: 25, compliance: ['cjis'] }));
    expect(risky.risk).toBe('High');
    expect(risky.because.includes('mission critical')).toBe(true);
    expect(risky.because.includes('regulated data')).toBe(true);
  });

  it('leaves a quiet application at low risk, with nothing to explain', () => {
    const quiet = riskOf(app({ criticality: 'Low', rtoHours: 72, rpoHours: 24, integrationCount: 2, compliance: [] }));
    expect(quiet.risk).toBe('Low');
    expect(quiet.because).toEqual([]);
  });

  it('bands in between', () => {
    // High criticality (2) + a four-hour RTO (2) + a two-hour RPO (1) is five points.
    expect(riskOf(app({ criticality: 'High', rtoHours: 4, rpoHours: 2, integrationCount: 4, compliance: [] })).risk).toBe('Medium');
  });
});

describe('the whole evaluation', () => {
  it('holds together: the plan is for the route, on the chosen cloud', () => {
    const result = evaluate(app({ database: 'Microsoft SQL Server 2019', ratings: { ...DEFAULT_RATINGS, cloudCompatibility: 5, refactorEffort: 5 } }));
    expect(result.cloud).toBe('azure');
    expect(result.plan).toEqual(playbookFor(result.route, 'azure', false));
    expect(result.services.length > 0).toBe(true);
    expect(result.services.every((s) => s.primary.length > 0)).toBe(true);
  });

  it('gives the same answer every time, which is what lets a portfolio be re-evaluated', () => {
    const subject = app({ name: 'Ledger', compliance: ['pci'], integrationCount: 12 });
    const { plan: _plan, ...first } = evaluate(subject);
    const { plan: _again, ...second } = evaluate(subject);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('turns the regulated guardrails on in the plan when the data is regulated', () => {
    const regulated = evaluate(app({ compliance: ['fedramp_high'] }));
    expect(regulated.plan.some((line) => line.includes('regulated guardrails'))).toBe(true);
    expect(evaluate(app()).plan.some((line) => line.includes('regulated guardrails'))).toBe(false);
  });

  it('gives the routes that do not move anywhere a standing plan instead of a migration', () => {
    const retire = evaluate(app({ gates: { ...NO_GATES, isObsolete: true } }));
    expect(retire.route).toBe('Retire');
    expect(retire.plan.some((line) => line.includes('legal hold'))).toBe(true);
    expect(retire.plan.some((line) => line.includes('Cut over'))).toBe(false);
  });
});
