import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyPlan } from '../store.ts';
import type { WavePlan } from '../types.ts';
import { EXIT_TARGETS, federalChecks, vmwareExitProject } from './vmware-exit.ts';

const plan = emptyPlan();
const waves: WavePlan = { settings: plan.waveSettings, waves: [], groups: [], findings: [] };

test('exports the chosen destinations, wave dates, and State CUI review', () => {
  const selected = EXIT_TARGETS.filter((target) => target.id === 'ahv' || target.id === 'aws');
  const scheduled: WavePlan = { ...waves, waves: [{ n: 1, groups: ['pilot'], start: '2026-12-03', end: '2026-12-04', gates: ['G2'] }] };
  const project = vmwareExitProject(plan, scheduled, selected, 'VMware vSphere', 'Department of State', 'CUI');
  assert.match(project, /DT architecture or product approval/);
  assert.match(project, /CISA CDM applicability/);
  assert.match(project, /CUI category/);
  assert.match(project, /Wave 1: 1 move groups. 2026-12-03 through 2026-12-04. Gates: G2/);
  assert.ok(project.includes('Nutanix AOS / AHV'));
  assert.match(project, /Vendor workflow with ArchToolKit integration still required/);
  assert.match(project, /### AWS/);
  assert.doesNotMatch(project, /### Azure Government/);
});

test('distinguishes DoD cloud evidence, civilian criteria and unknown handling', () => {
  assert.match(federalChecks('DoD', 'Nonpublic unclassified').join('\n'), /Cloud SRG impact level/);
  assert.doesNotMatch(federalChecks('Federal civilian', 'Public').join('\n'), /Cloud SRG impact level|DT architecture/);
  assert.match(federalChecks('Department of State', 'Unassessed').join('\n'), /Hold all workload transfer/);
});

test('only exports a generic template for classified planning', () => {
  const selected = EXIT_TARGETS.filter((target) => target.id === 'azure-local');
  assert.match(vmwareExitProject(plan, waves, selected, 'VMware Cloud Foundation', 'DoD', 'Classified'), /authorized classified workflow/);
  const scheduled: WavePlan = { ...waves, waves: [{ n: 1, groups: [] }] };
  assert.throws(() => vmwareExitProject(plan, scheduled, selected, 'VMware Cloud Foundation', 'DoD', 'Classified'), /empty plan/);
});
