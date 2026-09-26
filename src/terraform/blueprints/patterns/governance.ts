/**
 * `<p>_mig_governance` (addendum A.10.15): the landing zone's guard rails, an
 * item of the landing-zone stack (after connectivity). The plan's
 * Requirements (frameworks, security baseline, residency, sovereignty) pick
 * the policy sets; the budgets are the user's own amounts (A.9.2 "Budget").
 *
 *   AWS     AWS Config (a recorder, its own delivery bucket) and managed
 *           Config rules per framework, including REQUIRED_TAGS; an
 *           Organizations tag policy when an organisation target is given
 *           (run from the management account); AWS Budgets
 *   Azure   subscription policy assignments: "Require a tag" and "Inherit a
 *           tag from the resource group" per required tag, "Allowed locations"
 *           from the residency, and a regulatory initiative per framework;
 *           consumption budgets
 *   Google  project organisation policies (resource locations from the
 *           residency, OS Login, no service-account keys, no external IPs,
 *           uniform bucket access, no public Cloud SQL); billing budgets
 *   OCI     a tag namespace, a tag and a required tag default per tag, Cloud
 *           Guard (enabled, a target on the compartment with the Oracle
 *           detector recipes), a security zone, budgets with alert rules
 *   VCF     vSphere tag categories for the atk_* tags (single cardinality)
 *
 * The policy and initiative ids and the Config rule identifiers are data
 * here, each set marked to verify against the provider's current list.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import type { Blueprint, BlueprintInput, BlueprintValues } from '../../../kit/blueprint.ts';
import { str as valueOf } from '../../../kit/blueprint.ts';
import type { HclBlock } from '../../hcl.ts';
import {
  LANDING_ZONE_SOURCE,
  attrs,
  blk,
  cellNumber,
  dat,
  e,
  gridInput,
  hcl,
  ident,
  ignoreChanges,
  jsonencode,
  lzRef,
  output,
  parseGrid,
  q,
  res,
  rname,
  uniqueNames,
  variable,
  x,
  type GridColumn,
} from '../migration/common.ts';
import { PATTERN_GROUP, VSPHERE_SERVER_INPUT, listOf, patternMainTf, preamble, vsphereProvider, type PatternPlatform } from './common.ts';

export const FRAMEWORKS = [
  'pci-dss-4', 'hipaa', 'soc2', 'iso27001', 'gdpr', 'uk-gdpr', 'fedramp-moderate', 'fedramp-high', 'dod-il2', 'dod-il4', 'dod-il5', 'cjis',
  'irap-protected', 'bsi-c5', 'ens-high', 'nis2', 'dora',
] as const;

/** AWS Config managed rules: a base set, and extra ones per framework family (identifiers verify: https://docs.aws.amazon.com/config/latest/developerguide/managed-rules-by-aws-config.html). */
const AWS_BASE_RULES = [
  'ENCRYPTED_VOLUMES', 'RDS_STORAGE_ENCRYPTED', 'S3_BUCKET_PUBLIC_READ_PROHIBITED', 'S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED', 'IAM_ROOT_ACCESS_KEY_CHECK',
  'CLOUD_TRAIL_ENABLED', 'VPC_FLOW_LOGS_ENABLED', 'EC2_IMDSV2_CHECK', 'RESTRICTED_INCOMING_TRAFFIC', 'INCOMING_SSH_DISABLED',
];
const AWS_FRAMEWORK_RULES: Readonly<Record<string, readonly string[]>> = {
  'pci-dss-4': ['MFA_ENABLED_FOR_IAM_CONSOLE_ACCESS', 'CLOUDWATCH_LOG_GROUP_ENCRYPTED', 'DB_INSTANCE_BACKUP_ENABLED', 'RDS_INSTANCE_PUBLIC_ACCESS_CHECK'],
  hipaa: ['DB_INSTANCE_BACKUP_ENABLED', 'CLOUDWATCH_LOG_GROUP_ENCRYPTED', 'RDS_INSTANCE_PUBLIC_ACCESS_CHECK', 'S3_BUCKET_VERSIONING_ENABLED'],
  'fedramp-moderate': ['MFA_ENABLED_FOR_IAM_CONSOLE_ACCESS', 'IAM_PASSWORD_POLICY', 'MULTI_REGION_CLOUD_TRAIL_ENABLED'],
  'fedramp-high': ['MFA_ENABLED_FOR_IAM_CONSOLE_ACCESS', 'IAM_PASSWORD_POLICY', 'MULTI_REGION_CLOUD_TRAIL_ENABLED', 'ROOT_ACCOUNT_HARDWARE_MFA_ENABLED'],
  soc2: ['MFA_ENABLED_FOR_IAM_CONSOLE_ACCESS', 'S3_BUCKET_VERSIONING_ENABLED'],
  iso27001: ['MFA_ENABLED_FOR_IAM_CONSOLE_ACCESS', 'IAM_PASSWORD_POLICY'],
};

/** Azure built-in policy definitions and regulatory initiatives (ids verify: https://learn.microsoft.com/en-us/azure/governance/policy/samples/built-in-policies). */
const AZ_POLICY = {
  requireTag: '/providers/Microsoft.Authorization/policyDefinitions/871b6d14-10aa-478d-b590-94f262ecfa99',
  inheritTag: '/providers/Microsoft.Authorization/policyDefinitions/ea3f2387-9b95-492a-a190-fcdc54f7b070',
  allowedLocations: '/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c',
} as const;
const AZ_INITIATIVES: Readonly<Record<string, string>> = {
  baseline: '1f3afdf9-d0c9-4c3d-847f-89da613e70a8',
  'pci-dss-4': 'c676748e-3af9-4e22-bc28-50feed564afb',
  hipaa: 'a169a624-5599-4385-a696-c8d643089fab',
  iso27001: '89c6cddc-1c73-4ac1-b19c-54d1a15a42f2',
  soc2: '4054785f-702b-4a98-9215-009cbd58b141',
  'fedramp-moderate': 'e95f5a9f-57ad-4d03-bb0b-b1d16db93693',
  'fedramp-high': 'd5264498-16f4-418a-b659-fa7ef418175f',
};
const AZ_LOCATIONS: Readonly<Record<string, readonly string[]>> = {
  eu: ['westeurope', 'northeurope', 'germanywestcentral', 'francecentral', 'swedencentral'],
  uk: ['uksouth', 'ukwest'],
  us: ['eastus', 'eastus2', 'centralus', 'westus2', 'westus3'],
  ca: ['canadacentral', 'canadaeast'],
  de: ['germanywestcentral', 'germanynorth'],
  fr: ['francecentral', 'francesouth'],
  ch: ['switzerlandnorth', 'switzerlandwest'],
  nl: ['westeurope'],
  se: ['swedencentral'],
  au: ['australiaeast', 'australiasoutheast'],
  nz: ['newzealandnorth'],
  jp: ['japaneast', 'japanwest'],
  kr: ['koreacentral', 'koreasouth'],
  in: ['centralindia', 'southindia'],
  sg: ['southeastasia'],
  ae: ['uaenorth'],
  br: ['brazilsouth'],
  za: ['southafricanorth'],
};
/** Google Cloud location value groups for gcp.resourceLocations (verify: https://cloud.google.com/resource-manager/docs/organization-policy/defining-locations). */
const GCP_LOCATIONS: Readonly<Record<string, string>> = {
  eu: 'in:eu-locations', us: 'in:us-locations', uk: 'in:europe-west2-locations', de: 'in:europe-west3-locations', nl: 'in:europe-west4-locations',
  ch: 'in:europe-west6-locations', fr: 'in:europe-west9-locations', ca: 'in:northamerica-northeast1-locations', au: 'in:australia-southeast1-locations',
  jp: 'in:asia-northeast1-locations', sg: 'in:asia-southeast1-locations', in: 'in:asia-south1-locations', br: 'in:southamerica-east1-locations',
};

const BUDGET_COLUMNS: readonly GridColumn[] = [{ name: 'Name' }, { name: 'Amount' }, { name: 'Currency', options: ['USD', 'EUR', 'GBP'] }, { name: 'Alert at %' }, { name: 'Email' }];

interface Budget {
  readonly name: string;
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly percent: number;
  readonly email: string;
}

function parseBudgets(text: string, findings: Finding[]): Budget[] {
  return uniqueNames(parseGrid(text, BUDGET_COLUMNS.map((c) => c.name)), 'Name', 'budgets', findings).map((r) => ({
    name: rname(r['Name'] ?? ''),
    id: ident(r['Name'] ?? 'budget'),
    amount: cellNumber(r['Amount'], 1000),
    currency: (r['Currency'] || 'USD').toUpperCase(),
    percent: Math.min(1000, cellNumber(r['Alert at %'], 80)),
    email: r['Email'] ?? '',
  }));
}

function governanceInputs(platform: PatternPlatform): BlueprintInput[] {
  if (platform === 'vsphere') {
    return [VSPHERE_SERVER_INPUT, { id: 'required_tags', label: 'Tag categories', control: 'text', default: 'atk_app atk_env atk_owner atk_cost_centre atk_criticality', hint: 'Space-separated.' }];
  }
  return [
    { id: 'frameworks', label: 'Frameworks', control: 'checklist', default: 'iso27001', options: FRAMEWORKS.map((f) => ({ value: f, label: f })) },
    { id: 'security_baseline', label: 'Security baseline', control: 'select', default: 'cis-l1', options: ['cis-l1', 'cis-l2', 'stig', 'internal'].map((v) => ({ value: v, label: v })) },
    { id: 'residency', label: 'Data residency', control: 'select', default: 'any', options: ['any', 'eu', 'uk', 'us', 'ca', 'de', 'fr', 'ch', 'nl', 'se', 'au', 'nz', 'jp', 'kr', 'in', 'sg', 'ae', 'sa', 'br', 'za'].map((v) => ({ value: v, label: v })) },
    { id: 'sovereignty', label: 'Sovereignty', control: 'select', default: 'none', options: ['none', 'sovereign-region', 'government-region', 'dedicated', 'air-gapped'].map((v) => ({ value: v, label: v })) },
    { id: 'required_tags', label: 'Required tags', control: 'text', default: 'atk_app atk_env atk_owner atk_cost_centre', hint: 'Space-separated tag keys every resource must carry.' },
    gridInput('budgets', 'Budgets', BUDGET_COLUMNS, [['landing-zone', '10000', 'USD', '80', 'finops@example.com']], 'One row per monthly budget: the amount, the alert threshold (forecast) and who is told.'),
    ...(platform === 'aws' ? [{ id: 'organization_target_id', label: 'Organizations target', control: 'text' as const, default: '', hint: 'The root, OU or account id the tag policy attaches to (from the management account); blank: no tag policy.' }] : []),
    ...(platform === 'google' ? [{ id: 'billing_account', label: 'Billing account', control: 'text' as const, default: '', hint: 'The billing account id the budgets are created on; blank: no budgets.' }] : []),
    ...(platform === 'oci'
      ? [
          { id: 'tenancy_ocid', label: 'Tenancy OCID', control: 'text' as const, default: '', hint: 'Cloud Guard and budgets live in the root compartment; blank: a variable.' },
          { id: 'security_zone', label: 'Security zone', control: 'select' as const, default: 'yes', options: [{ value: 'yes', label: 'Yes: the Oracle-managed policies on the compartment' }, { value: 'no', label: 'No' }] },
        ]
      : []),
    LANDING_ZONE_SOURCE,
  ];
}

const frameworksOf = (values: BlueprintValues): string[] => listOf(values, 'frameworks').filter((f) => (FRAMEWORKS as readonly string[]).includes(f));

function sovereigntyFinding(values: BlueprintValues, findings: Finding[]): void {
  const s = valueOf(values, 'sovereignty', 'none');
  if (s !== 'none') findings.push(info('tf.gov.sovereignty', `Sovereignty "${s}" is a choice of region and cloud offering (sovereign or government regions, dedicated or disconnected clouds): it is met by the landing zone's region and the contract, not by a policy here.`, { path: 'sovereignty' }));
}

// ---------------------------------------------------------------------------

function awsGovernance(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const lz = lzRef(values);
  const pfx = `\${${lz}.prefix}`;
  const tags = listOf(values, 'required_tags', 'atk_app');
  const fw = frameworksOf(values);
  const rules = [...new Set([...AWS_BASE_RULES, ...fw.flatMap((f) => AWS_FRAMEWORK_RULES[f] ?? [])])];
  const blocks: HclBlock[] = [
    ...preamble('aws', values),
    dat('aws_caller_identity', 'governance', {}),
    res('aws_s3_bucket', 'config', { bucket_prefix: x(`"${pfx}-config-"`), force_destroy: false }),
    res('aws_s3_bucket_public_access_block', 'config', { bucket: x('aws_s3_bucket.config.id'), block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
    res('aws_s3_bucket_server_side_encryption_configuration', 'config', { bucket: x('aws_s3_bucket.config.id') }, [blk('rule', {}, [blk('apply_server_side_encryption_by_default', { sse_algorithm: 'AES256' })])]),
    res('aws_s3_bucket_policy', 'config', {
      bucket: x('aws_s3_bucket.config.id'),
      policy: x(jsonencode({
        Version: '2012-10-17',
        Statement: [
          { Sid: 'ConfigAcl', Effect: 'Allow', Principal: { Service: 'config.amazonaws.com' }, Action: ['s3:GetBucketAcl', 's3:ListBucket'], Resource: e('aws_s3_bucket.config.arn'), Condition: { StringEquals: { 'AWS:SourceAccount': e('data.aws_caller_identity.governance.account_id') } } },
          { Sid: 'ConfigWrite', Effect: 'Allow', Principal: { Service: 'config.amazonaws.com' }, Action: 's3:PutObject', Resource: e('"${aws_s3_bucket.config.arn}/AWSLogs/${data.aws_caller_identity.governance.account_id}/Config/*"'), Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'AWS:SourceAccount': e('data.aws_caller_identity.governance.account_id') } } },
        ],
      })),
    }),
    res('aws_iam_service_linked_role', 'config', { aws_service_name: 'config.amazonaws.com' }, [], 'AWS Config records through its service-linked role (remove this block if the account has it already).'),
    res('aws_config_configuration_recorder', 'governance', { name: 'default', role_arn: x('aws_iam_service_linked_role.config.arn') }, [
      blk('recording_group', { all_supported: true, include_global_resource_types: true }),
    ]),
    res('aws_config_delivery_channel', 'governance', { name: 'default', s3_bucket_name: x('aws_s3_bucket.config.id'), depends_on: x('[aws_config_configuration_recorder.governance, aws_s3_bucket_policy.config]') }),
    res('aws_config_configuration_recorder_status', 'governance', { name: x('aws_config_configuration_recorder.governance.name'), is_enabled: true, depends_on: x('[aws_config_delivery_channel.governance]') }),
    res('aws_config_config_rule', 'required_tags', {
      name: x(`"${pfx}-required-tags"`),
      input_parameters: x(jsonencode(Object.fromEntries(tags.slice(0, 6).map((t, i) => [`tag${i + 1}Key`, t])))),
      depends_on: x('[aws_config_configuration_recorder_status.governance]'),
    }, [blk('source', { owner: 'AWS', source_identifier: 'REQUIRED_TAGS' })]),
  ];
  if (tags.length > 6) findings.push(warning('tf.gov.aws-tags', `REQUIRED_TAGS checks six keys: ${tags.slice(6).join(', ')} are not checked by it.`, { path: 'required_tags' }));
  for (const r of rules) {
    blocks.push(res('aws_config_config_rule', r.toLowerCase(), { name: x(`"${pfx}-${r.toLowerCase().replace(/_/g, '-')}"`), depends_on: x('[aws_config_configuration_recorder_status.governance]') }, [blk('source', { owner: 'AWS', source_identifier: r })]));
  }
  const target = valueOf(values, 'organization_target_id');
  if (target) {
    blocks.push(
      res('aws_organizations_policy', 'tags', {
        name: x(`"${pfx}-tags"`),
        type: 'TAG_POLICY',
        description: 'The atk_* tags, spelt the same everywhere.',
        content: x(jsonencode({ tags: Object.fromEntries(tags.map((t) => [t, { tag_key: { '@@assign': t } }])) })),
      }),
      res('aws_organizations_policy_attachment', 'tags', { policy_id: x('aws_organizations_policy.tags.id'), target_id: target }),
    );
  } else findings.push(info('tf.gov.aws-tag-policy', 'No Organizations target was given: tag keys are enforced by the REQUIRED_TAGS Config rule only (a tag policy needs the management account).', { path: 'organization_target_id' }));
  for (const b of parseBudgets(valueOf(values, 'budgets'), findings)) {
    blocks.push(
      res('aws_budgets_budget', b.id, { name: x(`"${pfx}-${b.name}"`), budget_type: 'COST', limit_amount: String(b.amount), limit_unit: b.currency, time_unit: 'MONTHLY' }, [
        blk('notification', { comparison_operator: 'GREATER_THAN', threshold: b.percent, threshold_type: 'PERCENTAGE', notification_type: 'FORECASTED', subscriber_email_addresses: b.email ? [b.email] : [] }),
      ]),
    );
  }
  if (valueOf(values, 'residency', 'any') !== 'any') findings.push(info('tf.gov.aws-residency', 'Residency on AWS is a service control policy that denies other regions (from the management account) plus the landing zone\'s region: add the SCP with the organisation\'s region list.', { source: 'https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps_examples_general.html' }));
  findings.push(info('tf.gov.aws-rules', `The Config rule identifiers (${rules.length}) are AWS managed rules for the base and the frameworks selected: verify them against the managed-rule list; a conformance pack per framework is the fuller alternative.`, { source: 'https://docs.aws.amazon.com/config/latest/developerguide/managed-rules-by-aws-config.html' }));
  blocks.push(output('config_recorder', 'aws_config_configuration_recorder.governance.name'));
  return blocks;
}

function azureGovernance(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const lz = lzRef(values);
  const pfx = `\${${lz}.prefix}`;
  const tags = listOf(values, 'required_tags', 'atk_app');
  const fw = frameworksOf(values);
  const residency = valueOf(values, 'residency', 'any');
  const blocks: HclBlock[] = [...preamble('azure', values), dat('azurerm_subscription', 'governance', {})];
  const assign = (label: string, name: string, definition: string, params: Record<string, unknown> | undefined, identity = false) =>
    res('azurerm_subscription_policy_assignment', label, {
      name: x(`substr("${pfx}-${name}", 0, 64)`),
      subscription_id: x('data.azurerm_subscription.governance.id'),
      policy_definition_id: definition,
      display_name: name,
      enforce: true,
      location: identity ? x(`${lz}.location`) : undefined,
      parameters: params ? x(jsonencode(params)) : undefined,
    }, identity ? [blk('identity', { type: 'SystemAssigned' })] : []);
  for (const t of tags) {
    blocks.push(
      assign(`require_${ident(t)}`, `require-${rname(t)}`, AZ_POLICY.requireTag, { tagName: { value: t } }),
      assign(`inherit_${ident(t)}`, `inherit-${rname(t)}`, AZ_POLICY.inheritTag, { tagName: { value: t } }, true),
      res('azurerm_role_assignment', `inherit_${ident(t)}`, {
        scope: x('data.azurerm_subscription.governance.id'),
        role_definition_name: 'Tag Contributor',
        principal_id: x(`azurerm_subscription_policy_assignment.inherit_${ident(t)}.identity[0].principal_id`),
      }, [], 'The Modify effect adds the tag with the assignment\'s identity.'),
    );
  }
  const locations = AZ_LOCATIONS[residency];
  if (locations) blocks.push(assign('allowed_locations', 'allowed-locations', AZ_POLICY.allowedLocations, { listOfAllowedLocations: { value: [...locations] } }));
  else if (residency !== 'any') findings.push(warning('tf.gov.azure-residency', `No Azure region list for residency "${residency}" here: add "Allowed locations" with the regions by hand.`, { path: 'residency' }));
  for (const f of ['baseline', ...fw]) {
    const id = AZ_INITIATIVES[f];
    if (!id) {
      findings.push(info('tf.gov.azure-framework', `No built-in regulatory initiative is mapped for ${f}: assign it from the Regulatory compliance blade if Azure offers one.`, { path: 'frameworks' }));
      continue;
    }
    blocks.push(assign(`initiative_${ident(f)}`, f === 'baseline' ? 'mcsb' : f, `/providers/Microsoft.Authorization/policySetDefinitions/${id}`, undefined));
  }
  for (const b of parseBudgets(valueOf(values, 'budgets'), findings)) {
    blocks.push(
      res('azurerm_consumption_budget_subscription', b.id, { name: x(`"${pfx}-${b.name}"`), subscription_id: x('data.azurerm_subscription.governance.id'), amount: b.amount, time_grain: 'Monthly' }, [
        blk('time_period', { start_date: x('formatdate("YYYY-MM-01\'T\'00:00:00Z", plantimestamp())') }),
        blk('notification', { enabled: true, threshold: b.percent, operator: 'GreaterThan', threshold_type: 'Forecasted', contact_emails: b.email ? [b.email] : [] }),
        ignoreChanges(['time_period']),
      ]),
    );
    if (b.currency !== 'USD') findings.push(info('tf.gov.azure-currency', `${b.name}: Azure budgets are in the billing currency of the subscription, not ${b.currency}.`, { path: 'budgets' }));
  }
  findings.push(info('tf.gov.azure-ids', 'The built-in policy and initiative ids are data here: verify them in the policy definitions list before applying (Azure renames and versions initiatives).', { source: 'https://learn.microsoft.com/en-us/azure/governance/policy/samples/built-in-initiatives' }));
  return blocks;
}

function googleGovernance(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const lz = lzRef(values);
  const pfx = `\${${lz}.prefix}`;
  const residency = valueOf(values, 'residency', 'any');
  const blocks: HclBlock[] = [...preamble('google', values), dat('google_project', 'governance', { project_id: x(`${lz}.project`) })];
  const parent = '"projects/${data.google_project.governance.number}"';
  const policy = (label: string, constraint: string, rule: HclBlock) =>
    res('google_org_policy_policy', label, { name: x(`"projects/\${data.google_project.governance.number}/policies/${constraint}"`), parent: x(parent) }, [blk('spec', {}, [rule])]);
  blocks.push(
    policy('os_login', 'compute.requireOsLogin', blk('rules', { enforce: 'TRUE' })),
    policy('no_sa_keys', 'iam.disableServiceAccountKeyCreation', blk('rules', { enforce: 'TRUE' })),
    policy('no_external_ip', 'compute.vmExternalIpAccess', blk('rules', { deny_all: 'TRUE' })),
    policy('uniform_buckets', 'storage.uniformBucketLevelAccess', blk('rules', { enforce: 'TRUE' })),
    policy('sql_no_public_ip', 'sql.restrictPublicIp', blk('rules', { enforce: 'TRUE' })),
  );
  const group = GCP_LOCATIONS[residency];
  if (group) blocks.push(policy('locations', 'gcp.resourceLocations', blk('rules', {}, [blk('values', { allowed_values: [group] })])));
  else if (residency !== 'any') findings.push(warning('tf.gov.gcp-residency', `No location value group for residency "${residency}" here: set gcp.resourceLocations by hand.`, { path: 'residency' }));
  findings.push(info('tf.gov.gcp-os-login', 'compute.requireOsLogin means the Ansible user signs in through OS Login: grant its service account roles/compute.osAdminLogin (the ssh-keys metadata is then ignored).', { source: 'https://cloud.google.com/compute/docs/oslogin' }));
  findings.push(info('tf.gov.gcp-labels', 'Google Cloud labels cannot be required by a built-in organisation policy: the required tags are checked by the plan and the dynamic inventory (custom constraints need the organisation).', { path: 'required_tags' }));
  const account = valueOf(values, 'billing_account');
  const budgets = parseBudgets(valueOf(values, 'budgets'), findings);
  if (account) {
    for (const b of budgets) {
      blocks.push(
        res('google_billing_budget', b.id, { billing_account: account, display_name: x(`"${pfx}-${b.name}"`) }, [
          blk('budget_filter', { projects: x(`["projects/\${data.google_project.governance.number}"]`), calendar_period: 'MONTH' }),
          blk('amount', {}, [blk('specified_amount', { currency_code: b.currency, units: String(b.amount) })]),
          blk('threshold_rules', { threshold_percent: b.percent / 100, spend_basis: 'FORECASTED_SPEND' }),
        ]),
      );
    }
  } else if (budgets.length > 0) findings.push(info('tf.gov.gcp-budget', 'No billing account was given, so no budget is created; the email recipients of a Google budget are the billing account\'s admins (or a Monitoring channel).', { path: 'billing_account' }));
  findings.push(info('tf.gov.gcp-frameworks', `Frameworks (${frameworksOf(values).join(', ') || 'none'}) on Google Cloud are Assured Workloads regimes and Security Command Center posture templates, chosen at folder level: outside this project-level item.`, { source: 'https://cloud.google.com/assured-workloads/docs/overview' }));
  return blocks;
}

function ociGovernance(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const lz = lzRef(values);
  const pfx = `\${${lz}.prefix}`;
  const comp = `${lz}.compartment_id`;
  const tags = listOf(values, 'required_tags', 'atk_app');
  const blocks: HclBlock[] = [...preamble('oci', values)];
  const tenancy = valueOf(values, 'tenancy_ocid');
  if (!tenancy) blocks.push(variable('tenancy_ocid', 'string', 'The tenancy OCID (the root compartment): Cloud Guard and budgets live there.'));
  const root = tenancy ? q(tenancy) : 'var.tenancy_ocid';
  blocks.push(res('oci_identity_tag_namespace', 'governance', { compartment_id: x(comp), name: x(`"${pfx}-atk"`), description: 'The atk_* tags the migration writes.' }));
  for (const t of tags) {
    blocks.push(
      res('oci_identity_tag', ident(t), { tag_namespace_id: x('oci_identity_tag_namespace.governance.id'), name: t, description: `${t} (required on the compartment)` }),
      res('oci_identity_tag_default', ident(t), { compartment_id: x(comp), tag_definition_id: x(`oci_identity_tag.${ident(t)}.id`), value: 'unassigned', is_required: true }),
    );
  }
  blocks.push(
    res('oci_cloud_guard_cloud_guard_configuration', 'governance', { compartment_id: x(root), reporting_region: x(`${lz}.region`), status: 'ENABLED' }, [], 'Cloud Guard is enabled once per tenancy: remove this block if it is already on.'),
    dat('oci_cloud_guard_detector_recipes', 'oracle', { compartment_id: x(root), resource_metadata_only: false }),
    res('oci_cloud_guard_target', 'governance', {
      compartment_id: x(comp),
      display_name: x(`"${pfx}-landing-zone"`),
      target_resource_id: x(comp),
      target_resource_type: 'COMPARTMENT',
      depends_on: x('[oci_cloud_guard_cloud_guard_configuration.governance]'),
    }, [
      {
        type: 'dynamic',
        labels: ['target_detector_recipes'],
        attributes: attrs({ for_each: x('[for r in data.oci_cloud_guard_detector_recipes.oracle.detector_recipe_collection[0].items : r.id if r.owner == "ORACLE"]') }),
        blocks: [blk('content', { detector_recipe_id: x('target_detector_recipes.value') })],
      },
    ]),
  );
  if (valueOf(values, 'security_zone', 'yes') === 'yes') {
    blocks.push(
      dat('oci_cloud_guard_security_policies', 'oracle', { compartment_id: x(root) }),
      res('oci_cloud_guard_security_recipe', 'governance', {
        compartment_id: x(comp),
        display_name: x(`"${pfx}-security-zone"`),
        security_policies: x('[for p in data.oci_cloud_guard_security_policies.oracle.security_policy_collection[0].items : p.id if p.owner == "ORACLE"]'),
      }),
      res('oci_cloud_guard_security_zone', 'governance', { compartment_id: x(comp), display_name: x(`"${pfx}-security-zone"`), security_zone_recipe_id: x('oci_cloud_guard_security_recipe.governance.id') }),
    );
    findings.push(warning('tf.gov.oci-security-zone', 'The security zone applies every Oracle-managed policy to the compartment: it refuses public buckets and subnets and unencrypted volumes, so a public static site or public load balancer needs a compartment outside it.', { source: 'https://docs.oracle.com/en-us/iaas/security-zone/using/security-zone-policies.htm' }));
  }
  for (const b of parseBudgets(valueOf(values, 'budgets'), findings)) {
    blocks.push(
      res('oci_budget_budget', b.id, { compartment_id: x(root), display_name: x(`"${pfx}-${b.name}"`), amount: b.amount, reset_period: 'MONTHLY', target_type: 'COMPARTMENT', targets: x(`[${comp}]`) }),
      res('oci_budget_alert_rule', b.id, { budget_id: x(`oci_budget_budget.${b.id}.id`), threshold: b.percent, threshold_type: 'PERCENTAGE', type: 'FORECAST', recipients: b.email || undefined, display_name: `${b.name}-forecast` }),
    );
  }
  return blocks;
}

function vsphereGovernance(values: BlueprintValues): HclBlock[] {
  const tags = listOf(values, 'required_tags', 'atk_app');
  return [
    ...vsphereProvider(values),
    ...tags.map((t) => res('vsphere_tag_category', ident(t), { name: t, description: `${t}: one value per object`, cardinality: 'SINGLE', associable_types: ['VirtualMachine', 'Datastore', 'Network', 'Folder', 'ResourcePool'] })),
    output('tag_categories', hcl(Object.fromEntries(tags.map((t) => [t, e(`vsphere_tag_category.${ident(t)}.id`)])))),
  ];
}

// ---------------------------------------------------------------------------

const EMITS: Readonly<Record<PatternPlatform, readonly string[]>> = {
  aws: [
    'aws_s3_bucket', 'aws_s3_bucket_public_access_block', 'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket_policy', 'aws_iam_service_linked_role',
    'aws_config_configuration_recorder', 'aws_config_delivery_channel', 'aws_config_configuration_recorder_status', 'aws_config_config_rule',
    'aws_organizations_policy', 'aws_organizations_policy_attachment', 'aws_budgets_budget',
  ],
  azure: ['azurerm_subscription_policy_assignment', 'azurerm_role_assignment', 'azurerm_consumption_budget_subscription'],
  google: ['google_org_policy_policy', 'google_billing_budget'],
  oci: [
    'oci_identity_tag_namespace', 'oci_identity_tag', 'oci_identity_tag_default', 'oci_cloud_guard_cloud_guard_configuration', 'oci_cloud_guard_target',
    'oci_cloud_guard_security_recipe', 'oci_cloud_guard_security_zone', 'oci_budget_budget', 'oci_budget_alert_rule',
  ],
  vsphere: ['vsphere_tag_category'],
};
const CLOUD: Readonly<Record<PatternPlatform, string>> = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud (GCP)', oci: 'OCI', vsphere: 'VCF' };

function governance(platform: PatternPlatform): Blueprint {
  return {
    id: `${platform}_mig_governance`,
    label: 'Governance (policies, tags, budgets)',
    group: PATTERN_GROUP,
    description: {
      aws: 'AWS Config with a delivery bucket of its own and managed rules per framework (REQUIRED_TAGS among them), an Organizations tag policy when a target is given, and monthly AWS Budgets with forecast alerts.',
      azure: 'Subscription policy assignments: require and inherit each tag, allowed locations from the residency, the Microsoft cloud security benchmark and a regulatory initiative per framework; monthly consumption budgets.',
      google: 'Project organisation policies: resource locations from the residency, OS Login, no service-account keys, no external IPs, uniform bucket access, no public Cloud SQL; billing budgets on the project.',
      oci: 'A tag namespace with a required tag default per tag, Cloud Guard with the Oracle detector recipes on the compartment, a security zone, and budgets with forecast alerts.',
      vsphere: 'vSphere tag categories for the atk_* tags, one value per object, so VCF objects carry the same keys as the clouds.',
    }[platform],
    inputs: governanceInputs(platform),
    emits: EMITS[platform],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      if (platform !== 'vsphere') sovereigntyFinding(values, findings);
      const blocks =
        platform === 'aws' ? awsGovernance(values, findings)
        : platform === 'azure' ? azureGovernance(values, findings)
        : platform === 'google' ? googleGovernance(values, findings)
        : platform === 'oci' ? ociGovernance(values, findings)
        : vsphereGovernance(values);
      return { files: { 'main.tf': patternMainTf(blocks, `${CLOUD[platform]} governance`) }, findings };
    },
  };
}

export const GOVERNANCE_BLUEPRINTS: readonly Blueprint[] = (['aws', 'azure', 'google', 'oci', 'vsphere'] as const).map(governance);

