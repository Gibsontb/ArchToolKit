/**
 * The eight deployment scenarios Broadcom publishes for the JSON spec workflow.
 *
 * Broadcom's "Use a JSON Specification File to Deploy VMware Cloud Foundation or
 * vSphere Foundation" page carries a decision table: an "I want to..." row per
 * supported scenario, mapped to a `workflowType` and to the state of seven
 * components. Picking `workflowType` without also setting the component flags
 * the same row prescribes produces a document the installer either rejects or,
 * worse, accepts and deploys wrongly.
 *
 * The table is transcribed verbatim below, including the cells that leave the
 * choice open. It is the single source of truth for scenario handling; the
 * builder derives from it rather than reimplementing the rules.
 *
 * Two columns are NOT `useExistingDeployment` flags despite sitting beside four
 * that are — `managementServices`, `licenseServer` and `identityBroker` describe
 * whether the component appears in the document at all. That asymmetry is in
 * Broadcom's table, and conflating the two kinds of column is the easiest way to
 * get this wrong.
 *
 * Verification: V-DOC.
 * Source: VCF 9.1 Deployment — Use a JSON Specification File to Deploy VMware
 * Cloud Foundation or vSphere Foundation (retrieved 2026-09-20).
 */

import type { WorkflowType } from './spec-types.ts';

export type DeploymentScenario =
  | 'new-vcf-fleet'
  | 'new-vcf-instance'
  | 'deferred-components'
  | 'converge-to-vcf-fleet'
  | 'converge-to-vcf-instance'
  | 'new-vvf'
  | 'converge-to-vvf'
  | 'vvf-management-services';

/**
 * One cell of the decision table.
 *
 * `either` is Broadcom's "true / false" — the scenario permits both, so the plan
 * decides. `na` is their "n/a", which carries two different meanings depending on
 * the column, and conflating them is the trap:
 *
 *  - On a presence column it means the component is left out of the document.
 *  - On a `useExistingDeployment` column it usually means only that the *flag*
 *    has no meaning, because the scenario never reuses that component. NSX is
 *    marked n/a for a new VCF fleet, yet every VCF deployment has NSX. NSX is
 *    genuinely absent only from a vSphere Foundation platform.
 *
 * `componentTakesPart` resolves that; do not test the raw cell for `na`.
 */
export type ScenarioFlag = 'true' | 'false' | 'either' | 'na';

export interface ScenarioRule {
  readonly scenario: DeploymentScenario;
  /** Broadcom's own row wording, so a finding can quote the table. */
  readonly label: string;
  readonly workflowType: WorkflowType;

  // --- useExistingDeployment columns ---------------------------------------
  readonly operationsExisting: ScenarioFlag;
  readonly vcenterExisting: ScenarioFlag;
  readonly automationExisting: ScenarioFlag;
  readonly nsxExisting: ScenarioFlag;

  // --- presence columns ------------------------------------------------------
  /** Whether `vspClusterSpec` appears at all. */
  readonly managementServices: ScenarioFlag;
  readonly licenseServer: ScenarioFlag;
  readonly identityBroker: ScenarioFlag;

  /** Footnote markers attached to this row in the published table. */
  readonly notes?: readonly ScenarioNote[];

  /**
   * Cells where Broadcom's summary table and Broadcom's own worked example
   * disagree, and the example was followed.
   */
  readonly supersedesTable?: readonly {
    readonly column: string;
    readonly tableValue: ScenarioFlag;
    readonly used: ScenarioFlag;
    readonly reason: string;
  }[];
}

/**
 * The table's footnotes, which carry conditions the cells alone do not express.
 */
export type ScenarioNote =
  /** * — required only when converging an existing VCF Operations instance that
   * is not already deployed and integrated with VCF Operations. */
  | 'conditional-on-existing-operations'
  /** ** — VVF may be deployed with or without VCF management services; without
   * them the Installer appliance must be reconfigured first. */
  | 'vvf-management-services-optional'
  /** **** — Identity Broker is mandatory for the primary VCF instance only; a
   * subsequent instance may omit `vidbSpec`. */
  | 'identity-broker-primary-only';

export const SCENARIO_RULES: readonly ScenarioRule[] = [
  {
    scenario: 'new-vcf-fleet',
    label: 'Deploy a new VCF fleet',
    workflowType: 'VCF',
    operationsExisting: 'false',
    vcenterExisting: 'false',
    managementServices: 'true',
    automationExisting: 'either',
    nsxExisting: 'na',
    licenseServer: 'true',
    identityBroker: 'true',
  },
  {
    scenario: 'new-vcf-instance',
    label: 'Deploy a new VCF Instance',
    workflowType: 'VCF_EXTEND',
    operationsExisting: 'true',
    vcenterExisting: 'false',
    managementServices: 'true',
    automationExisting: 'true',
    nsxExisting: 'na',
    licenseServer: 'true',
    identityBroker: 'either',
    notes: ['conditional-on-existing-operations', 'identity-broker-primary-only'],
  },
  {
    scenario: 'deferred-components',
    label: 'Deploy deferred components',
    workflowType: 'VCF_COMPLETE',
    // These two are deliberately the inverse of the summary table. See
    // supersedesTable below.
    operationsExisting: 'false',
    vcenterExisting: 'true',
    managementServices: 'false',
    automationExisting: 'false',
    nsxExisting: 'false',
    licenseServer: 'true',
    identityBroker: 'na',
    supersedesTable: [
      {
        column: 'vcenterSpec.useExistingDeployment',
        tableValue: 'false',
        used: 'true',
        reason:
          'Deferred components are added to an instance that already exists, so its vCenter is by definition existing. Broadcom\u2019s own worked example for this workflow sets it to true, as it does for sddcManagerSpec.',
      },
      {
        column: 'vcfOperationsSpec.useExistingDeployment',
        tableValue: 'true',
        used: 'false',
        reason:
          'VCF Operations is one of the components being deployed now, so it is new. Broadcom\u2019s worked example sets it to false. The summary table appears to have these two columns transposed for this row.',
      },
    ],
  },
  {
    scenario: 'converge-to-vcf-fleet',
    label: 'Converge existing vSphere infrastructure to a new VCF fleet',
    workflowType: 'VCF',
    operationsExisting: 'either',
    vcenterExisting: 'true',
    managementServices: 'true',
    automationExisting: 'either',
    nsxExisting: 'either',
    licenseServer: 'true',
    identityBroker: 'true',
    notes: ['conditional-on-existing-operations'],
  },
  {
    scenario: 'converge-to-vcf-instance',
    label: 'Converge existing vSphere infrastructure to a new VCF instance',
    workflowType: 'VCF_EXTEND',
    operationsExisting: 'true',
    vcenterExisting: 'true',
    managementServices: 'true',
    automationExisting: 'true',
    nsxExisting: 'either',
    licenseServer: 'true',
    identityBroker: 'true',
    notes: ['conditional-on-existing-operations'],
  },
  {
    scenario: 'new-vvf',
    label: 'Deploy a new vSphere Foundation platform',
    workflowType: 'VVF',
    operationsExisting: 'false',
    vcenterExisting: 'false',
    managementServices: 'either',
    automationExisting: 'na',
    nsxExisting: 'na',
    licenseServer: 'true',
    identityBroker: 'true',
    notes: ['vvf-management-services-optional'],
  },
  {
    scenario: 'converge-to-vvf',
    label: 'Converge existing vSphere infrastructure to a new vSphere Foundation platform',
    workflowType: 'VVF',
    operationsExisting: 'false',
    vcenterExisting: 'true',
    managementServices: 'either',
    automationExisting: 'na',
    nsxExisting: 'na',
    licenseServer: 'true',
    identityBroker: 'na',
    notes: ['conditional-on-existing-operations', 'vvf-management-services-optional'],
  },
  {
    scenario: 'vvf-management-services',
    label: 'Install VCF Management Services and License Server for vSphere Foundation',
    workflowType: 'VVF',
    operationsExisting: 'true',
    vcenterExisting: 'true',
    managementServices: 'true',
    automationExisting: 'false',
    nsxExisting: 'false',
    licenseServer: 'true',
    identityBroker: 'na',
  },
];

/**
 * Whether a component appears in the document at all.
 *
 * On a `useExistingDeployment` column, `na` means the component is absent only
 * when the scenario has no such component to begin with — which, for NSX and
 * VCF Automation, means the vSphere Foundation scenarios.
 */
export function componentTakesPart(rule: ScenarioRule, cell: ScenarioFlag): boolean {
  if (cell !== 'na') return true;
  return rule.workflowType !== 'VVF';
}

export function scenarioRule(scenario: DeploymentScenario): ScenarioRule {
  const rule = SCENARIO_RULES.find((r) => r.scenario === scenario);
  if (!rule) throw new Error(`Unknown deployment scenario: ${scenario}`);
  return rule;
}

/**
 * Resolve one cell against what the plan asked for.
 *
 * A fixed cell wins over the plan — the table is the constraint, not a default —
 * and the disagreement is reported so the caller can surface it rather than
 * silently overriding the user.
 */
export function resolveFlag(
  flag: ScenarioFlag,
  requested: boolean | undefined,
  fallback: boolean,
): { value: boolean; conflict: boolean } {
  if (flag === 'na') return { value: false, conflict: requested === true };
  if (flag === 'either') return { value: requested ?? fallback, conflict: false };
  const fixed = flag === 'true';
  return { value: fixed, conflict: requested !== undefined && requested !== fixed };
}

/**
 * The manual precondition for a vSphere Foundation platform without VCF
 * management services.
 *
 * This is the one documented step in the JSON-spec workflow that no JSON field
 * can express: the Installer appliance itself has to be reconfigured first.
 */
export const VVF_WITHOUT_MANAGEMENT_SERVICES_PREREQUISITE = [
  "SSH to the VCF Installer appliance as root and run:",
  "  echo 'explicit.management.components.deployment=true' >> /etc/vmware/vcf/domainmanager/application.properties",
  '  systemctl restart domainmanager',
  '  sleep 180',
  '  curl localhost/domainmanager/about   # expect HTTP 200 and a JSON response',
].join('\n');
