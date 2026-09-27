/**
 * The migration system's end-to-end chain on the WP-10 fixture
 * (multicloud-fixture.ts), as the two pages run it: intake (Sources), types and
 * patterns confirmed (Servers, Applications), a new service, recommendation and
 * choice per app, decision with the pattern rules, design with the pattern
 * mappers, sizing, Terraform and Ansible, waves, the execution kit, the
 * executive summary, network and security translation, the exit sequence, one
 * utility, the new service's stack and the Generate project.
 *
 * Shared by src/multicloud/plan/e2e.test.ts and tools/browser-check.mjs (which
 * loads the plan into both pages).
 */

import { withUserNetworks } from './network-rows.ts';
import {
  ASA_CONFIG, AWS_DISCOVERY, FIXTURE_DATE, FORTIGATE_CONFIG, HYPERV_DISCOVERY, PHYSICAL_DISCOVERY, fixtureDcExit, twentyDeployments, vsphereWorkbook,
} from './multicloud-fixture.ts';
import type { Finding } from '../core/findings.ts';
import { importRvToolsWorkbook } from '../vmware/rvtools.ts';
import { applyIntake } from '../ui/multicloud/sources-model.ts';
import { assembleMigrationProject, PROJECT_PARTS, type MigrationProject } from '../ui/multicloud/project.ts';
import { localWavePlan } from '../ui/multicloud/wave-model.ts';
import { buildStack, type StackBuild } from '../ui/application-migration/generate-model.ts';
import { generateChange, type ChangeBundle } from '../multicloud/change/index.ts';
import { appPlanOf, defaultAppPlan, newApplication, withAppPlan, withoutServiceSynthetics } from '../multicloud/plan/apps/components.ts';
import { chooseAppPlatform, decideApps, recommendApps, recommendationDecision, saveAppPlans } from '../multicloud/plan/apps/recommend.ts';
import { designPlan } from '../multicloud/plan/design/index.ts';
import { exitSequence, exitSequenceMarkdown, checkDcExit, wavesFromPlan, type ExitSequence } from '../multicloud/plan/dcexit/sequence.ts';
import { executionKit, type ExecutionKit } from '../multicloud/plan/execute/kit.ts';
import { ansibleFiles } from '../multicloud/plan/generate/ansible.ts';
import { terraformFiles } from '../multicloud/plan/generate/terraform.ts';
import { executiveSummary } from '../multicloud/plan/governance/reports.ts';
import { waveViews } from '../multicloud/plan/governance/comms.ts';
import { workloadsFromInventory } from '../multicloud/plan/intake/from-inventory.ts';
import { intakeFromDiscovery } from '../multicloud/plan/intake/sources/discovery.ts';
import { emitTerraform, type EmittedNetsec } from '../multicloud/plan/netsec/emit.ts';
import { parseAsa } from '../multicloud/plan/netsec/parse-asa.ts';
import { parseFortios } from '../multicloud/plan/netsec/parse-fortios.ts';
import { netsecContext, translateConfigs, type Translation } from '../multicloud/plan/netsec/translate.ts';
import { defaultExecution, defaultGovernance, defaultRequirements, DEFAULT_WAVE_SETTINGS } from '../multicloud/plan/options.ts';
import { proposePattern, withPatternMappers } from '../multicloud/plan/patterns/index.ts';
import { sizeApp } from '../multicloud/plan/sizing/index.ts';
import { toGrid } from '../multicloud/plan/sizing/k8s-import.ts';
import { PLAN_KIND } from '../multicloud/plan/types.ts';
import type { AppPattern, AppRecommendation, Plan, PlanDecision, Platform, SizingRecommendation, TargetDesign, WavePlan, WorkloadType } from '../multicloud/plan/types.ts';

export const SAVED_AT = `${FIXTURE_DATE}T00:00:00.000Z`;
export const ENGINE = { today: FIXTURE_DATE };

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** Types a person confirms on the Servers grid (the RVTools rows carry no software list to detect from). */
export const CONFIRMED_TYPES: Readonly<Record<string, WorkloadType>> = {
  's4p-hana01': 'sap-hana', 's4p-ascs01': 'sap-netweaver', 's4p-pas01': 'sap-netweaver', 's4p-aas01': 'sap-netweaver',
  'exch-mbx01': 'exchange', 'exch-mbx02': 'exchange', 'ctx-ddc01': 'citrix-infra', 'ctx-sf01': 'citrix-infra',
  'ctx-vda01': 'citrix-vda', 'ctx-vda02': 'citrix-vda', 'ctx-vda03': 'citrix-vda', 'ctx-vda04': 'citrix-vda',
  'k8s-cp01': 'k8s-node', 'k8s-cp02': 'k8s-node', 'k8s-cp03': 'k8s-node',
  'k8s-wk01': 'k8s-node', 'k8s-wk02': 'k8s-node', 'k8s-wk03': 'k8s-node', 'k8s-wk04': 'k8s-node', 'k8s-wk05': 'k8s-node',
  fs01: 'file-server', dc01: 'ad-ds', dc02: 'ad-ds',
};
/** Patterns the catalogue proposes from the confirmed types (asserted below), and those picked by hand. */
export const PICKED_PATTERNS: Readonly<Record<string, AppPattern>> = { Mail: 'exchange', Files: 'file-server' };
/** The pattern assessment answers. */
export const ANSWERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  S4: { hanaMemoryGib: '1024' },
  Mail: { version: '2019' },
  Citrix: { users: '300', persona: 'medium', concurrentPct: '100' },
  Files: { protocol: 'smb', tib: '12' },
};
/** Choices that differ from the recommendation, so every target platform is in play. */
export const CHOICES: Readonly<Record<string, Platform>> = {
  'a:platform': 'google', 'a:shop': 'aws', 'a:hr': 'oci', 'a:intranet': 'vmware', 'a:batch': 'vmware', 'a:analytics': 'oci', 'a:orders-api': 'aws',
};
export const NEW_SERVICE = 'a:orders-api';

export interface Step { readonly step: string; readonly findings: readonly Finding[] }

export interface E2e {
  readonly proposed: Readonly<Record<string, AppPattern | undefined>>;
  readonly recommendations: Readonly<Record<string, AppRecommendation>>;
  readonly plan: Plan;
  readonly decision: PlanDecision;
  readonly design: TargetDesign;
  readonly sizing: Readonly<Record<string, readonly SizingRecommendation[]>>;
  readonly terraform: Readonly<Record<string, string>>;
  readonly ansible: Readonly<Record<string, string>>;
  readonly waves: WavePlan;
  readonly kit: ExecutionKit;
  readonly netsec: { readonly translation: Translation; readonly emitted: EmittedNetsec };
  readonly exit: ExitSequence;
  readonly change: ChangeBundle;
  readonly stack: StackBuild;
  readonly project: MigrationProject;
  readonly steps: readonly Step[];
  /** Every generated file, by `<step>/<path>`. */
  readonly files: Readonly<Record<string, string>>;
}

export function basePlan(): Plan {
  const base = defaultRequirements();
  // The networks the user built on every cloud (Landing zones), with the platform subnets the services need.
  return withUserNetworks(bare(base), ['aws', 'azure', 'google', 'oci', 'vmware'], { allPlatformSubnets: true });
}

function bare(base: ReturnType<typeof defaultRequirements>): Plan {
  return {
    kind: PLAN_KIND, version: 1, id: 'e2e-dc1-exit-0001', name: 'DC1 exit', savedAt: SAVED_AT,
    workloads: [], databases: [], apps: [], edges: [],
    requirements: {
      ...base,
      maxPlatforms: 5,
      regions: { ...base.regions, vmware: { primary: 'wld01-vc01.corp.example.com' } },
      sites: [
        { name: 'dc1', vpnPeer: '203.0.113.10', bgpAsn: 65010, cidrs: ['172.20.0.0/16', '172.21.0.0/16', '172.22.0.0/16', 'fd00:20::/48'], bandwidth: '10g', circuit: 'direct-connect', circuitLocation: 'Equinix LD5' },
        { name: 'office', vpnPeer: '203.0.113.30', bgpAsn: 65020, cidrs: ['172.29.0.0/16'], bandwidth: '1g', circuit: 'none' },
      ],
      connection: 'circuit-with-vpn-backup',
      licensing: { ...base.licensing, microsoftSa: 'yes-some', oracle: 'processor' },
    },
    // The ranges the user assigns for the ODB networks and the relocate targets (never picked by the toolkit).
    designOverrides: {
      'aws:range:odb': '10.60.0.0/24', 'google:range:odb': '10.61.0.0/24', 'google:range:managed-ad': '10.99.0.0/24',
      'aws:range:relocate': '10.200.0.0/22', 'azure:range:relocate': '10.204.0.0/22', 'google:range:relocate': '10.208.0.0/22', 'oci:range:relocate': '10.216.0.0/21',
    },
    waveSettings: { ...DEFAULT_WAVE_SETTINGS, start: '2026-11-02', freezes: [] },
    mode: 'dc-exit',
    appPlans: [],
    execution: defaultExecution(),
    governance: { ...defaultGovernance(), cicd: 'github-actions', environments: ['prod'] },
    dcExit: fixtureDcExit(),
  };
}

export async function buildE2e(): Promise<E2e> {
  const steps: Step[] = [];
  const files: Record<string, string> = {};
  const keep = (step: string, out: Readonly<Record<string, string>>): void => {
    for (const [p, t] of Object.entries(out)) files[`${step}/${p}`] = t;
  };

  // 1. Intake: the RVTools workbook, then the collectors' files (merged by name).
  let plan = basePlan();
  const inventory = (await importRvToolsWorkbook(await vsphereWorkbook())).inventory;
  const vsphere = workloadsFromInventory(inventory, { includePoweredOff: false, on: FIXTURE_DATE, appAttribute: 'Application', envAttribute: 'Environment', ownerAttribute: 'Owner' });
  const a = applyIntake(plan, vsphere, 'merge');
  const b = applyIntake(a.plan, intakeFromDiscovery([HYPERV_DISCOVERY, PHYSICAL_DISCOVERY, AWS_DISCOVERY], { on: FIXTURE_DATE }), 'merge');
  plan = b.plan;
  steps.push({ step: 'intake', findings: [...a.findings, ...b.findings] });

  // 2. Types confirmed on the Servers grid; the patterns the catalogue proposes, plus the ones picked by hand.
  plan = {
    ...plan,
    workloads: plan.workloads.map((w) => {
      const t = CONFIRMED_TYPES[w.name];
      if (!t) return w;
      return { ...w, workloadType: t, typeConfirmed: true, edited: [...(w.edited ?? []), 'workloadType'], ...(t === 'sap-hana' ? { role: 'db' as const } : {}) };
    }),
  };
  const proposed: Record<string, AppPattern | undefined> = {};
  for (const app of plan.apps) proposed[app.name] = proposePattern(plan.workloads.filter((w) => w.app === app.name));
  plan = {
    ...plan,
    apps: plan.apps.map((app) => {
      const pattern = PICKED_PATTERNS[app.name] ?? proposed[app.name];
      return { ...app, ...(pattern ? { pattern } : {}), ...(app.name === 'Citrix' ? { users: 300, concurrentUsers: 300 } : {}) };
    }),
  };
  for (const app of plan.apps) {
    const answers = ANSWERS[app.name];
    if (answers) plan = withAppPlan(plan, { ...(appPlanOf(plan, app.id) ?? defaultAppPlan(app)), answers: { ...answers } });
  }

  // 3. The new API service (Applications → New application).
  const added = newApplication(plan, { name: 'Orders API', pattern: 'api', load: { environments: ['prod'], nonprodPct: 25, peakRps: 300, dataGib: 50, tps: 100, slo: '99.9' } });
  plan = added.plan;
  steps.push({ step: 'new-service', findings: added.findings });

  // 4. Recommend, choose, save the application plans.
  const recommendations = recommendApps(plan, recommendationDecision(plan, ENGINE));
  for (const [id, r] of Object.entries(recommendations)) {
    const choice = CHOICES[id] ?? r.recommended;
    if (!choice) continue;
    const chosen = chooseAppPlatform(plan, id, choice);
    plan = chosen.plan;
    steps.push({ step: `choose ${id}`, findings: chosen.findings });
  }
  // The Kubernetes platform's workloads grid (the Sizing tab's import of `kubectl get deploy -A -o json`).
  const k8s = appPlanOf(plan, 'a:platform')!;
  plan = withAppPlan(plan, {
    ...k8s,
    variants: { ...k8s.variants, google: (k8s.variants.google ?? []).map((c) => (c.kind === 'pattern' ? { ...c, settings: { ...c.settings, 'k8s.workloads': toGrid(twentyDeployments()) } } : c)) },
  });
  plan = saveAppPlans(plan, plan.apps.map((x) => x.id), recommendations, SAVED_AT);

  // 5. Decision (the pattern rules) and design (the pattern mappers), as the Migrate panes read them.
  const decision = decideApps(plan, ENGINE);
  const design = withoutServiceSynthetics(plan, designPlan(plan, decision, withPatternMappers()));
  plan = { ...plan, decision };
  steps.push({ step: 'decision', findings: [...decision.findings, ...Object.values(decision.items).flatMap((i) => i.findings)] });
  steps.push({ step: 'design', findings: design.findings });

  // 6. Sizing, per app on its platform.
  const sizing: Record<string, SizingRecommendation[]> = {};
  for (const ap of plan.appPlans ?? []) {
    if (!ap.platform) continue;
    sizing[ap.app] = sizeApp(plan, ap.app, ap.platform);
    steps.push({ step: `sizing ${ap.app}`, findings: sizing[ap.app]!.flatMap((r) => r.findings) });
  }

  // 7. Terraform and Ansible for the estate.
  const tf = terraformFiles(plan, decision, design, { scope: 'estate' });
  const an = ansibleFiles(plan, decision, design);
  keep('terraform', tf.files);
  keep('ansible', an.files);
  steps.push({ step: 'terraform', findings: tf.findings }, { step: 'ansible', findings: an.findings });

  // 8. Waves and the execution kit.
  const waves = localWavePlan(plan, decision);
  steps.push({ step: 'waves', findings: waves.findings });
  const kit = executionKit(plan, decision, design, waves);
  keep('execute', kit.files);
  steps.push({ step: 'execute', findings: kit.findings });

  // 9. Governance: the executive summary.
  const summary = executiveSummary({ plan, waves: waveViews(plan, waves), design, date: FIXTURE_DATE });
  keep('reports', { 'executive-summary.md': summary.markdown, 'executive-summary.html': summary.html });

  // 10. Network and security translation from the two firewalls.
  const configs = [parseAsa(ASA_CONFIG, 'dc1-edge-asa'), parseFortios(FORTIGATE_CONFIG, 'dc1-core-fgt')];
  const translation = translateConfigs(configs, netsecContext(plan, decision), { today: FIXTURE_DATE });
  const emitted = emitTerraform(translation, { prefix: 'dc1' });
  keep('netsec', emitted.files);
  steps.push({ step: 'netsec', findings: [...translation.findings, ...emitted.findings] });

  // 11. The exit sequence.
  const { waveOf, waveEnds } = wavesFromPlan(plan, { ...waves, waves: waves.waves.filter((w) => w.kind !== 'exit') });
  const exit = exitSequence({ dcExit: plan.dcExit!, workloads: plan.workloads, waveOf, waveEnds, planId: plan.id, today: FIXTURE_DATE });
  keep('dcexit', { 'exit-sequence.md': exitSequenceMarkdown(exit) });
  steps.push({ step: 'dcexit', findings: [...exit.findings, ...checkDcExit(plan.dcExit!, FIXTURE_DATE)] });

  // 12. One utility: a disk added to a migrated server, against the plan.
  const change = generateChange('add-disk', { platform: 'aws', app: 'Shop', server: 'shop-app01', sizeGib: '100' }, { plan, date: FIXTURE_DATE });
  keep('utilities', change.files);
  steps.push({ step: 'utilities', findings: change.findings });

  // 13. The new service's own stack (Stack & generate), and the Generate project.
  const stack = buildStack(plan, [NEW_SERVICE]);
  keep('stack', stack.files);
  steps.push({ step: 'stack', findings: stack.findings });
  const project = assembleMigrationProject({ plan, decision, design, waves }, { parts: PROJECT_PARTS.map((p) => p.id), apps: ['a:s4', NEW_SERVICE] });
  keep('project', project.files);
  steps.push({ step: 'project', findings: project.findings });

  return {
    proposed, recommendations, plan, decision, design, sizing, terraform: tf.files, ansible: an.files, waves, kit,
    netsec: { translation, emitted }, exit, change, stack, project, steps, files,
  };
}
