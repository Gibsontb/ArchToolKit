/**
 * One cloud at a time on Migration & Utilities: which clouds the apps use,
 * which cloud a pane shows (never a default), and who builds the landing zone.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { itemId } from '../../multicloud/plan/options.ts';
import { emptyPlan } from '../../multicloud/plan/store.ts';
import type { App, AppPlan, ItemDecision, Plan, PlanDecision, Workload } from '../../multicloud/plan/types.ts';
import {
  CLOUD_NAMES, DC_LINK_NAMES, LANDING_ZONE_NAMES, chosenCloudOf, cloudUsage, landingZoneBuild, landingZoneBuildText, optionText, resolveCloud, usageText,
} from './cloud-choice.ts';

const app = (name: string): App => ({ id: itemId('app', name), name, criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none' });
const ap = (name: string, over: Record<string, unknown>): AppPlan => ({ app: itemId('app', name), origin: 'migrate', status: 'draft', variants: {}, answers: {}, landingZone: 'included', ...over } as unknown as AppPlan);
const server = (name: string, appName: string): Workload => ({
  id: itemId('workload', name), name, app: appName, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64],
  criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual',
} as Workload);

function plan(over: Partial<Plan> = {}): Plan {
  return { ...emptyPlan(), ...over } as Plan;
}

const decisionOn = (placements: Record<string, 'aws' | 'azure' | 'google' | 'oci' | 'vmware'>): PlanDecision => ({
  engineVersion: 't', platforms: [], subsetScores: [], findings: [],
  items: Object.fromEntries(Object.entries(placements).map(([id, platform]) => [id, { id, kind: 'workload', disposition: 'migrate', method: 'rehost', options: [], chosen: { platform }, pinned: false, margin: 1, findings: [] } as unknown as ItemDecision])),
});

describe('cloud choice (Migration & Utilities)', () => {
  it('an empty plan uses no cloud and resolves to none: never AWS by default', () => {
    const p = plan();
    expect(cloudUsage(p)).toEqual([]);
    expect(resolveCloud('', undefined, cloudUsage(p))).toBe(undefined);
    expect(resolveCloud(undefined, null, [])).toBe(undefined);
    expect(landingZoneBuild(p, 'aws').kind).toBe('none');
  });

  it('counts the apps per cloud from the chosen platform and the design cloud, and says the recommended ones apart', () => {
    const p = plan({
      apps: [app('Billing'), app('Portal'), app('Ledger'), app('Reports')],
      workloads: [server('rep01', 'Reports')],
      appPlans: [
        ap('Billing', { platform: 'azure' }),
        ap('Portal', { design: { cloud: 'azure', answers: {} } }),
        ap('Ledger', { platform: 'oci', design: { cloud: 'azure', answers: {} } }),
      ],
    });
    expect(chosenCloudOf(p, itemId('app', 'Portal'))).toBe('azure');
    expect(chosenCloudOf(p, itemId('app', 'Ledger'))).toBe('oci');
    const usage = cloudUsage(p, decisionOn({ [itemId('workload', 'rep01')]: 'aws' }));
    expect(usage.map((u) => [u.cloud, u.chosen.length, u.recommended.length])).toEqual([['aws', 0, 1], ['azure', 2, 0], ['oci', 1, 0]]);
    expect(optionText('azure', usage)).toBe('Microsoft Azure: 2 apps');
    expect(usageText(usage[0]!)).toBe('AWS: 1 app recommended, not chosen');
    expect(optionText('google', usage)).toBe('Google Cloud (GCP)');
    // The cloud most apps chose, not the recommended-only AWS.
    expect(resolveCloud('', undefined, usage)).toBe('azure');
  });

  it('a recommendation alone never picks the cloud', () => {
    const p = plan({ apps: [app('Reports')], workloads: [server('rep01', 'Reports')] });
    const usage = cloudUsage(p, decisionOn({ [itemId('workload', 'rep01')]: 'aws' }));
    expect(usage.length).toBe(1);
    expect(resolveCloud('', undefined, usage)).toBe(undefined);
  });

  it('the hash argument wins, then the viewer\'s remembered choice; junk is ignored', () => {
    const usage = cloudUsage(plan({ apps: [app('A')], appPlans: [ap('A', { platform: 'azure' })] }));
    expect(resolveCloud('google', 'oci', usage)).toBe('google');
    expect(resolveCloud('vmware/extra', undefined, usage)).toBe('vmware');
    expect(resolveCloud('mars', 'oci', usage)).toBe('oci');
    expect(resolveCloud('', 'nonsense', usage)).toBe('azure');
  });

  it('the first app on a cloud builds its landing zone and the later ones reuse it; a page-designed one is shared', () => {
    const p = plan({ apps: [app('Billing'), app('Portal')], appPlans: [ap('Billing', { platform: 'azure' }), ap('Portal', { platform: 'azure' })] });
    const b = landingZoneBuild(p, 'azure');
    expect(b).toEqual({ kind: 'app', app: 'Billing', reusedBy: ['Portal'] });
    expect(landingZoneBuildText(b, 'azure')).toContain('Built by Billing');
    expect(landingZoneBuildText(landingZoneBuild(p, 'oci'), 'oci')).toContain('Not built yet');
    const designed = { ...p, execution: { ...(p.execution ?? {}), landingZones: { azure: 'generated' } } } as unknown as Plan;
    expect(landingZoneBuild(designed, 'azure')).toEqual({ kind: 'page', state: 'generated' });
  });

  it('names each provider\'s landing zone and its data-centre link', () => {
    expect(CLOUD_NAMES.vmware).toBe('VMware Cloud Foundation (VCF) 9.1');
    expect(LANDING_ZONE_NAMES.aws).toBe('Landing zone (Control Tower + Landing Zone Accelerator)');
    expect(LANDING_ZONE_NAMES.google).toBe('Foundation (enterprise foundations blueprint)');
    expect(LANDING_ZONE_NAMES.oci).toBe('Core Landing Zone');
    expect(DC_LINK_NAMES.azure).toContain('ExpressRoute');
    expect(DC_LINK_NAMES.oci).toContain('FastConnect');
    expect(DC_LINK_NAMES.vmware).toBe('HCX + NSX');
  });
});
