import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
const paths = {
  fsbp: 'aws-foundational-security-best-practices/v/1.0.0',
  cis: 'cis-aws-foundations-benchmark/v/5.0.0',
  nist: 'nist-800-53/v/5.0.0',
};
export const AWS_SECURITYHUB_SERVICE = {
  id: 'aws_service_securityhub', label: 'Set up Security Hub CSPM and standards',
  description: 'Configure regional posture findings and explicit standards with account safeguards, adoption instructions and an availability preflight.',
  emits: ['aws_securityhub_account', 'aws_securityhub_standards_subscription'],
  inputs: [
    awsServiceRegion,
    { id: 'account', label: 'Expected AWS account ID', control: 'text' },
    { id: 'baseline', label: 'Standards baseline', control: 'select', default: 'fsbp', options: [{ value: 'fsbp', label: 'AWS Foundational Security Best Practices' }, { value: 'fsbp,cis', label: 'AWS FSBP + CIS AWS Foundations v5.0.0' }, { value: 'fsbp,nist', label: 'AWS FSBP + NIST SP 800-53 Rev. 5' }, { value: 'fsbp,cis,nist', label: 'AWS FSBP + CIS v5 + NIST SP 800-53 Rev. 5' }, { value: 'custom', label: 'Select exact standard ARNs below' }] },
    { id: 'additional', label: 'Additional or custom standard ARNs', control: 'text', hint: 'Optional comma-separated regional standard ARNs returned by aws securityhub describe-standards. Required for custom-only setup.' },
    { id: 'controls', label: 'Automatically enable newly added controls', control: 'select', default: 'no', options: [{ value: 'no', label: 'Review new controls before enabling' }, { value: 'yes', label: 'Automatically enable new controls' }] },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.securityhub.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), account = String(values.account ?? '').trim(), baseline = String(values.baseline ?? ''), controls = String(values.controls ?? '');
    if (!/^\d{12}$/.test(account)) reject('account', 'Enter the intended 12-digit authenticated AWS account ID.');
    if (!['fsbp', 'fsbp,cis', 'fsbp,nist', 'fsbp,cis,nist', 'custom'].includes(baseline)) reject('baseline', 'Select a standards baseline.');
    if (!['yes', 'no'].includes(controls)) reject('controls', 'Choose new-control behavior.');
    const prefix = 'arn:' + partition + ':securityhub:' + region + '::standards/';
    const additional = String(values.additional ?? '').split(/[,\n]/).map(value => value.trim()).filter(Boolean);
    if (additional.some(arn => !arn.startsWith(prefix) || !/^[a-z0-9-]+\/v\/\d+\.\d+\.\d+$/.test(arn.slice(prefix.length)))) reject('additional', 'Use exact standards ARNs for the selected region and partition, including their version.');
    const selected = [...new Set([...(baseline === 'custom' ? [] : baseline.split(',').flatMap(key => key in paths ? [prefix + paths[key                      ]] : [])), ...additional])];
    if (!selected.length || selected.length > 20) reject('additional', 'Select 1–20 standards, then verify regional support using the preflight.');
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      res('aws_securityhub_account', 'configured', { enable_default_standards: false, control_finding_generator: 'SECURITY_CONTROL', auto_enable_controls: controls === 'yes' }, [blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account)), error_message: 'Configure Security Hub CSPM only in the expected authenticated account.' })])]),
      ...selected.map((arn, index) => res('aws_securityhub_standards_subscription', 'standard_' + index, { standards_arn: arn, depends_on: x('[aws_securityhub_account.configured]') })),
      output('hub_arn', 'aws_securityhub_account.configured.arn'),
    ], `# Regional Security Hub CSPM and standards

## Prepare
Run CHECK-STANDARDS.ps1 before planning to verify identity and regional availability. Coordinate central configuration, delegated-administrator policy, account ownership and existing Terraform state. This workflow configures Security Hub CSPM (the posture-management service formerly named Security Hub), not the separate unified Security Hub service. Review pricing, data handling, regional standards and required AWS Config recording/resource coverage. Enabling a standard is a monitoring configuration, not certification or an ATO. Automated remediation is outside this package.

## Adopt an existing setup
If the regional hub is already enabled, coordinate ownership and import it before applying: terraform import aws_securityhub_account.configured ${account}. Use aws securityhub get-enabled-standards --region ${region} to identify existing subscriptions. Import each already-enabled selected subscription into its matching aws_securityhub_standards_subscription.standard_<index> address using its StandardsSubscriptionArn; match indexes against EXPECTED-STANDARDS.json. Review a saved plan before any update. Do not create overlapping state owners. Standards outside this package are not automatically reconciled or removed.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review exact account/region, selected standard versions, consolidated findings and new-control behavior; apply the reviewed saved plan. Default standards are disabled on creation so only explicitly selected subscriptions are requested. Selected standards initially enable their applicable controls; the new-control setting governs future added controls. Regional or organization policy can impose different settings and must be resolved with the security owner.

## Verify
Run aws securityhub describe-hub --region ${region} and aws securityhub get-enabled-standards --region ${region}; confirm each selected subscription reaches READY. Review controls and Config dependencies, then inspect findings in the console or with aws securityhub get-findings --region ${region}. Check account/region, control coverage, evaluation freshness and the configured downstream response path. Consolidated findings reduce duplicate control findings across standards. New/unsupported/missing-resource evaluations need investigation; a score alone is not compliance evidence.

## Recovery
Preserve hub and subscription settings before changes. Restore prior subscriptions/control policy through reviewed plans. Removing a subscription resource disables that standard subscription; deleting/disabling the hub affects findings and integrations and is blocked by Terraform prevent_destroy until explicitly changed. Do not use a disable/reenable cycle as a rollback shortcut. Keep required findings and security evidence within retention and classification boundaries. Multi-account administration, aggregation, individual control exceptions, automated response and the newer unified Security Hub offering require separate workflows.

https://docs.aws.amazon.com/securityhub/latest/userguide/standards-reference.html
`, findings);
    return { ...result, files: { ...result.files,
      'EXPECTED-STANDARDS.json': JSON.stringify(selected.map((arn, index) => ({ address: 'aws_securityhub_standards_subscription.standard_' + index, standardsArn: arn })), null, 2) + '\n',
      'CHECK-STANDARDS.ps1': `$ErrorActionPreference = 'Stop'
$identityJson = aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read current AWS identity.' }
if (($identityJson | ConvertFrom-Json).Account -ne '${account}') { throw 'Unexpected AWS account.' }
$standardsJson = aws securityhub describe-standards --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not list available regional standards.' }
$availableStandardArns = @(($standardsJson | ConvertFrom-Json).Standards | ForEach-Object { $_.StandardsArn })
$expectedStandards = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'EXPECTED-STANDARDS.json') -Raw | ConvertFrom-Json
foreach ($standard in $expectedStandards) {
  if ($availableStandardArns -notcontains $standard.standardsArn) { throw ('Selected standard is unavailable in this region: ' + $standard.standardsArn) }
}
Write-Host 'Account and standard availability checked. Review existing hub/state ownership, organization policy, Config coverage and charges before applying.'
`,
    } };
  },
}                    ;
