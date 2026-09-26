/**
 * VCF Operations cost and capacity: what the build-out added and changed.
 *
 * Every blueprint in vcf-ops-cost.ts builds clean from its defaults and with
 * each select option and each toggle flipped; what used to be "values to type"
 * or a design file is now an apply script that writes, reads back and says so
 * when an API is not there; schedules are written enabled; and the findings
 * that guard the new inputs fire.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { VCF_OPS_COST } from './blueprints/vcf-ops-cost.ts';

// Straight from the file, so these run whatever state the other blueprint files are in.
const automationFor = (id: string) => VCF_OPS_COST.find((blueprint) => blueprint.id === id);

function build(id: string, overrides: BlueprintValues = {}) {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`missing ${id}`);
  return blueprint.build({ ...defaultValues(blueprint), ...overrides }, id);
}
const codes = (id: string, overrides: BlueprintValues = {}, severity?: string) =>
  (automationFor(id)!.automation({ ...defaultValues(automationFor(id)!), ...overrides }, id).findings ?? []).filter((f) => !severity || f.severity === severity).map((f) => f.code);
const all = (files: Record<string, string>) => Object.values(files).join('\n');
const liveCron = (text: string | undefined) => (text ?? '').split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('#'));

function variants(id: string): { label: string; values: BlueprintValues }[] {
  const blueprint = automationFor(id)!;
  const base = defaultValues(blueprint);
  const out: { label: string; values: BlueprintValues }[] = [{ label: 'defaults', values: { ...base } }];
  for (const input of blueprint.inputs) {
    if (input.control === 'select') for (const option of input.options ?? []) out.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
    if (input.control === 'toggle') out.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
  }
  return out;
}

const IDS = ['vcfops_cost_drivers', 'vcfops_showback', 'vcfops_whatif', 'vcfops_reclaim_91', 'vcfops_capacity_policy', 'vcfops_vks_cost', 'vcfops_custom_profile'];

describe('cost and capacity: every blueprint, every option', () => {
  it('has the blueprints, custom profiles included', () => {
    expect(VCF_OPS_COST.map((b) => b.id)).toEqual(IDS);
  });

  it('builds with no error from its defaults and from each select option and toggle', () => {
    const problems: string[] = [];
    for (const id of IDS) {
      for (const { label, values } of variants(id)) {
        let out;
        try {
          out = automationFor(id)!.build(values, id);
        } catch (failure) {
          problems.push(`${id} ${label}: threw ${String(failure)}`);
          continue;
        }
        const errors = (out.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code);
        if (errors.length > 0) problems.push(`${id} ${label}: ${errors.join(', ')}`);
        if (!out.files['IMPORT.md']?.startsWith('# Importing: ')) problems.push(`${id} ${label}: no IMPORT.md`);
        for (const [path, body] of Object.entries(out.files)) {
          if (path.endsWith('.json')) {
            try {
              JSON.parse(body);
            } catch {
              problems.push(`${id} ${label}: ${path} does not parse`);
            }
          }
          if (path.endsWith('.sh') && !body.startsWith('#!/usr/bin/env bash')) problems.push(`${id} ${label}: ${path} is not a bash script`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('uses VCF 9.1 names only and leaves no footprint, whatever is picked', () => {
    const banned = /\b(Aria|vRealize|vROps|VROPS|ESXi|Service Broker|ArchToolKit)\b/i;
    const problems: string[] = [];
    for (const id of IDS) {
      for (const { label, values } of variants(id)) {
        const files = automationFor(id)!.automation(values, id).files;
        for (const [path, body] of Object.entries(files)) {
          body.split('\n').forEach((line, index) => {
            if (banned.test(line)) problems.push(`${id} ${label} ${path}:${index + 1}: ${line.trim().slice(0, 80)}`);
          });
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('applies by default: every script that changes something runs unless --dry-run is given', () => {
    for (const id of IDS) {
      for (const { values } of variants(id)) {
        for (const [path, body] of Object.entries(automationFor(id)!.automation(values, id).files)) {
          if (!path.endsWith('.sh') || !/--dry-run/.test(body)) continue;
          // It starts out applying, and only --dry-run turns that off.
          expect(/^EXECUTE=1$/m.test(body) || /^DRY_RUN=0$/m.test(body) || /if \[\[ "\$\{1:-\}" == "--dry-run" \]\]; then/.test(body)).toBe(true);
        }
      }
    }
  });
});

describe('vcfops_cost_drivers: applied, not typed', () => {
  it('writes the cost drivers through the API and reads them back', () => {
    const files = build('vcfops_cost_drivers').files;
    const apply = files['apply-cost-drivers.sh'] ?? '';
    expect(/api PUT "\$DRIVERS_PATH"/.test(apply)).toBe(true);
    expect(apply.includes('drivers.py" check')).toBe(true);
    expect(apply.includes('cost-drivers-before-')).toBe(true);
    expect(apply.includes('set_global "currency"')).toBe(true);
    expect(apply.includes('FORCE_CURRENCY')).toBe(true);
    expect(/--dry-run/.test(apply)).toBe(true);
    expect(/enter the values|values to type/i.test(all(files))).toBe(false);
  });

  it('carries the additional costs, storage costs and ratio into cost-drivers.json', () => {
    const want = JSON.parse(build('vcfops_cost_drivers').files['cost-drivers.json']!);
    expect(want.currency).toBe('USD');
    expect(want.additionalCosts.length).toBe(3);
    expect(want.additionalCosts.find((c: { method: string }) => c.method === 'metric').basis).toBe('cpu|corecount_provisioned');
    expect(want.set.some((e: { scope: string }) => e.scope === 'vSAN Default Storage Policy')).toBe(true);
    expect(want.set.some((e: { label: string; value: number }) => e.label.startsWith('Cost ratio') && e.value === 60)).toBe(true);
  });

  it('offers the wider currency list as a dropdown', () => {
    const input = automationFor('vcfops_cost_drivers')!.inputs.find((i) => i.id === 'currency')!;
    expect(input.control).toBe('select');
    expect((input.options ?? []).length).toBeGreaterThan(15);
    expect(JSON.parse(build('vcfops_cost_drivers', { currency: 'CHF' }).files['cost-drivers.json']!).currency).toBe('CHF');
  });

  it('catches additional-cost and storage rows that cannot be applied', () => {
    expect(codes('vcfops_cost_drivers', { additional_costs: 'vm | x | fixed | - | 10 | monthly | a' }).includes('vcfops.cost.extra-target')).toBe(true);
    expect(codes('vcfops_cost_drivers', { additional_costs: 'cluster | x | guess | - | 10 | monthly | a' }).includes('vcfops.cost.extra-method')).toBe(true);
    expect(codes('vcfops_cost_drivers', { additional_costs: 'cluster | x | tag | Finance | 10 | monthly | a' }).includes('vcfops.cost.extra-tag')).toBe(true);
    expect(codes('vcfops_cost_drivers', { additional_costs: 'cluster | x | metric | - | 10 | monthly | a' }).includes('vcfops.cost.extra-metric')).toBe(true);
    expect(codes('vcfops_cost_drivers', { additional_costs: 'cluster | x | fixed | - | ten | monthly | a' }).includes('vcfops.cost.extra-amount')).toBe(true);
    expect(codes('vcfops_cost_drivers', { additional_costs: 'cluster | x | fixed | - | 10 | weekly | a' }).includes('vcfops.cost.extra-period')).toBe(true);
    expect(codes('vcfops_cost_drivers', { additional_costs: 'cluster | x | fixed | - | 1 | monthly | a\nhost | y | fixed | - | 1 | monthly | a' }).includes('vcfops.cost.extra-duplicate')).toBe(true);
    expect(codes('vcfops_cost_drivers', { storage_costs: 'lun | x | 0.1' }).includes('vcfops.cost.storage-kind')).toBe(true);
    expect(codes('vcfops_cost_drivers', { storage_costs: 'datastore | x | cheap' }).includes('vcfops.cost.storage-rate')).toBe(true);
    expect(codes('vcfops_cost_drivers', { additional_costs: '', storage_costs: '' }, 'error')).toEqual([]);
  });
});

describe('vcfops_showback: the 9.1 pricing surface', () => {
  it('prices VKS per VM class and storage per policy, in the engine currency, with upfront pricing', () => {
    const files = build('vcfops_showback', { currency: 'EUR' }).files;
    const card = JSON.parse(files['rate-card.json']!);
    expect(card.currency).toBe('EUR');
    expect(card.upfrontPricing).toBe(true);
    expect(card.rates.filter((r: { label: string }) => r.label.startsWith('VKS node')).length).toBe(3);
    expect(card.rates.some((r: { label: string }) => r.label.startsWith('Storage policy vSAN Default Storage Policy'))).toBe(true);
    // Specific rates come before the generic ones, so a VKS item is not priced as vCPU.
    expect(card.rates.findIndex((r: { label: string }) => r.label === 'vCPU')).toBeGreaterThan(card.rates.findIndex((r: { label: string }) => r.label.startsWith('VKS node')));
    const script = files['build-policy.sh']!;
    expect(script.includes('The cost engine runs in')).toBe(true);
    expect(script.includes('api PUT /suite-api/api/pricing')).toBe(true);
    expect(script.includes('readback.json')).toBe(true);
    expect(script.includes('upfront')).toBe(true);
  });

  it('drops VKS rates when VKS pricing is off, and names the service type', () => {
    const card = JSON.parse(build('vcfops_showback', { vks_pricing: false, service_type: 'vm' }).files['rate-card.json']!);
    expect(card.rates.some((r: { label: string }) => r.label.startsWith('VKS'))).toBe(false);
    expect(card.serviceType).toBe('vm');
    expect(build('vcfops_showback', { service_type: 'dsm' }).files['showback-setup.md']!.includes('Data Services Manager only')).toBe(true);
  });

  it('warns about upfront prices on usage, and refuses unpriceable rows', () => {
    expect(codes('vcfops_showback', { basis: 'usage' }).includes('vcfops.showback.upfront-usage')).toBe(true);
    expect(codes('vcfops_showback', { basis: 'usage', upfront_pricing: false }).includes('vcfops.showback.upfront-usage')).toBe(false);
    expect(codes('vcfops_showback', { vks_rates: '' }).includes('vcfops.showback.vks-empty')).toBe(true);
    expect(codes('vcfops_showback', { vks_rates: 'best-effort-small | cheap' }).includes('vcfops.showback.vks-row')).toBe(true);
    expect(codes('vcfops_showback', { storage_policy_rates: 'Gold | x' }).includes('vcfops.showback.storage-policy-row')).toBe(true);
  });
});

describe('vcfops_vks_cost: scheduled enabled', () => {
  it('writes a live monthly cron line by default, and none when the schedule is off', () => {
    expect(liveCron(build('vcfops_vks_cost').files['crontab.txt'])).toBe(true);
    expect('crontab.txt' in build('vcfops_vks_cost', { schedule: false }).files).toBe(false);
  });
});

describe('vcfops_capacity_policy: applied, not designed', () => {
  it('merges the capacity settings into the policy, imports and reads back', () => {
    const files = build('vcfops_capacity_policy').files;
    const merge = files['merge-policy.sh']!;
    expect(merge.includes('/suite-api/api/policies/export')).toBe(true);
    expect(merge.includes('/suite-api/api/policies/import?forceImport=true')).toBe(true);
    expect(merge.includes('merge.py" check')).toBe(true);
    expect(merge.includes('import_policy "$BEFORE"')).toBe(true);
    const xml = files['vcfops-capacity-policy-capacity-overrides.xml']!;
    expect(xml.includes('model="ALLOCATION"')).toBe(true);
    expect(xml.includes('cpuOvercommitRatio="4"')).toBe(true);
    expect(xml.includes('storageBasedEviction="true"')).toBe(true);
    expect('export-policy.sh' in files).toBe(false);
    expect(files['apply-exclusions.sh']!.includes('set_global')).toBe(true);
  });

  it('writes no allocation element for a demand model, and no <REQUIRED> in the schedule', () => {
    const files = build('vcfops_capacity_policy', { model: 'demand' }).files;
    expect(files['vcfops-capacity-policy-capacity-overrides.xml']!.includes('<Allocation')).toBe(false);
    expect(files['capacity-report-schedule.json']!.includes('<REQUIRED')).toBe(false);
    expect(files['apply-report-schedule.sh']!.includes('already exists')).toBe(true);
  });

  it('keeps its threshold findings', () => {
    expect(codes('vcfops_capacity_policy', { tr_warning: 60, tr_critical: 90 }).includes('vcfops.capacity.thresholds')).toBe(true);
  });
});

describe('vcfops_reclaim_91: jobs applied', () => {
  it('creates the Automation Central jobs enabled, with a live pre-run check, and no design file', () => {
    const files = build('vcfops_reclaim_91').files;
    expect(Object.keys(files).some((path) => /design\.md$/.test(path))).toBe(false);
    const jobs = JSON.parse(files['automation-central-jobs.json']!);
    expect(jobs.jobs.length).toBe(2);
    expect(jobs.jobs.every((job: { enabled: boolean }) => job.enabled === true)).toBe(true);
    expect(jobs.jobs[0].schedule).toEqual({ recurrence: 'WEEKLY', dayOfWeek: 'SUNDAY', startTime: '02:00' });
    const apply = files['apply-jobs.sh']!;
    expect(apply.includes('api POST "$JOBS_PATH"')).toBe(true);
    expect(apply.includes('exit 3')).toBe(true);
    expect(liveCron(files['crontab.txt'])).toBe(true);
    expect(/"enabled":\s*false/.test(all(files))).toBe(false);
  });

  it('adds a job per option and refuses a window it cannot schedule', () => {
    const jobs = JSON.parse(build('vcfops_reclaim_91', { delete_off: true, upsize: true }).files['automation-central-jobs.json']!);
    expect(jobs.jobs.map((job: { action: string }) => job.action)).toEqual(['DELETE_OLD_SNAPSHOTS', 'DELETE_POWERED_OFF_VMS', 'DOWNSIZE_OVERSIZED_VMS', 'UPSIZE_UNDERSIZED_VMS']);
    expect(codes('vcfops_reclaim_91', { window: 'weekends' }).includes('vcfops.reclaim91.window')).toBe(true);
  });

  it('still writes the orphaned-disk script in its modes', () => {
    expect('orphan-disks.sh' in build('vcfops_reclaim_91', { mode: 'orphan-quarantine' }).files).toBe(true);
  });
});

describe('vcfops_custom_profile: new', () => {
  it('creates the profiles, turns them on in the policy and checks VMs remaining', () => {
    const files = build('vcfops_custom_profile').files;
    const doc = JSON.parse(files['custom-profiles.json']!);
    expect(doc.profiles.map((p: { name: string }) => p.name)).toEqual(['Small VM', 'Medium VM', 'Large database']);
    expect(files['apply-profiles.sh']!.includes('PROFILES_PATH')).toBe(true);
    expect(files['vcfops-custom-profile-policy-overrides.xml']!.includes('<CustomProfile name="Small VM" enabled="true"/>')).toBe(true);
    expect(files['merge-policy.sh']!.includes('/suite-api/api/policies/import')).toBe(true);
    expect(files['profiles-remaining.sh']!.includes('remaining')).toBe(true);
    expect(liveCron(files['crontab.txt'])).toBe(true);
  });

  it('leaves the policy alone when told to, and says the profiles then count nowhere', () => {
    const files = build('vcfops_custom_profile', { enable_in_policy: false }).files;
    expect('merge-policy.sh' in files).toBe(false);
    expect(codes('vcfops_custom_profile', { enable_in_policy: false }).includes('vcfops.profile.not-enabled')).toBe(true);
  });

  it('catches profiles it cannot create', () => {
    expect(codes('vcfops_custom_profile', { profiles: 'Tiny | 0 | 1 | 10 | ClusterComputeResource' }).includes('vcfops.profile.size')).toBe(true);
    expect(codes('vcfops_custom_profile', { profiles: 'Tiny | 1 | 1 | 10 | Folder' }).includes('vcfops.profile.kind')).toBe(true);
    expect(codes('vcfops_custom_profile', { profiles: 'A | 1 | 1 | 1 | Datastore\na | 2 | 2 | 2 | Datastore' }).includes('vcfops.profile.duplicate')).toBe(true);
    expect(codes('vcfops_custom_profile', { profiles: '' }).includes('vcfops.profile.none')).toBe(true);
  });
});

describe('vcfops_whatif: vSAN, datacenter comparison, several scenarios', () => {
  it('writes every scenario, and a baseline for every cluster', () => {
    const files = build('vcfops_whatif').files;
    const spec = JSON.parse(files['vcfops-whatif-scenarios.json']!);
    expect(spec.scenarios.length).toBe(3);
    expect(files['baseline.sh']!.includes('CLUSTERS=("wld01-cl01" "wld02-cl01")')).toBe(true);
  });

  it('models vSAN raw capacity from the storage policy and failures to tolerate', () => {
    const spec = JSON.parse(build('vcfops_whatif', { scenario: 'hci-workload', ftt: 'ftt1-raid1', more_scenarios: '' }).files['vcfops-whatif-scenarios.json']!);
    expect(spec.scenarios[0].vsan.failuresToTolerate).toBe('FTT=1, RAID-1');
    expect(spec.scenarios[0].workload.totals.vsanRawGb).toBe(40 * 200 * 2);
    // 1,000 VMs of 150 GB is under 200 TB usable but over it raw at FTT=1 RAID-1.
    expect(codes('vcfops_whatif', { scenario: 'hci-workload', ftt: 'ftt1-raid1', vm_count: 1000, disk_gb: 150, more_scenarios: '' }).includes('vcfops.whatif.too-much-storage')).toBe(true);
    expect(codes('vcfops_whatif', { scenario: 'add-workload', vm_count: 1000, disk_gb: 150, more_scenarios: '' }).includes('vcfops.whatif.too-much-storage')).toBe(false);
    const hosts = JSON.parse(build('vcfops_whatif', { scenario: 'hci-hosts', more_scenarios: '' }).files['vcfops-whatif-scenarios.json']!);
    expect(hosts.scenarios[0].hosts.vsanRawTbEach).toBe(30);
  });

  it('compares datacenters, and needs two to compare', () => {
    const spec = JSON.parse(build('vcfops_whatif', { scenario: 'compare-datacenters' }).files['vcfops-whatif-scenarios.json']!);
    expect(spec.scenarios[0].compare).toEqual(['DC-North', 'DC-South']);
    expect(codes('vcfops_whatif', { scenario: 'compare-datacenters', compare_targets: 'DC-North' }).includes('vcfops.whatif.compare-few')).toBe(true);
  });

  it('refuses scenario rows it cannot enter', () => {
    expect(codes('vcfops_whatif', { more_scenarios: 'X | resize | wld01-cl01 | 1 | 1 | 1 | 1 | 0' }).includes('vcfops.whatif.row-type')).toBe(true);
    expect(codes('vcfops_whatif', { more_scenarios: 'X | add-workload | wld01-cl01 | 0 | 0 | 0 | 0 | 0' }).includes('vcfops.whatif.row-workload')).toBe(true);
    expect(codes('vcfops_whatif', { more_scenarios: 'Q1 ERP expansion | add-hosts | wld01-cl01 | 0 | 0 | 0 | 0 | 2' }).includes('vcfops.whatif.duplicate-name')).toBe(true);
  });
});
