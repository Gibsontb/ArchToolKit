import { error,              } from '../core/findings.js';
                                                     
import { blk, output, res } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';

const types = [
  { value: 'ACCOUNT', label: 'Account — external access' },
  { value: 'ORGANIZATION', label: 'Organization — external access' },
  { value: 'ACCOUNT_UNUSED_ACCESS', label: 'Account — unused access' },
  { value: 'ORGANIZATION_UNUSED_ACCESS', label: 'Organization — unused access' },
];
export const AWS_ACCESS_ANALYZER_SERVICE = {
  id: 'aws_service_access_analyzer', label: 'Set up an IAM external or unused access analyzer',
  description: 'Create a protected regional analyzer with explicit trust scope and a read-only findings export script.',
  emits: ['aws_accessanalyzer_analyzer'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Analyzer name', control: 'text' },
    { id: 'type', label: 'Analysis and trust scope', control: 'select', default: 'ACCOUNT', options: types },
    { id: 'age', label: 'Unused access age (days)', control: 'number', default: 90, min: 1, max: 180, showWhen: { input: 'type', equals: ['ACCOUNT_UNUSED_ACCESS', 'ORGANIZATION_UNUSED_ACCESS'] } },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.access-analyzer.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), name = String(values.name ?? ''), type = String(values.type ?? ''), unused = type.endsWith('_UNUSED_ACCESS'), age = Number(values.age);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,254}$/.test(name)) reject('name', 'Use 1–255 letters, numbers, dots, hyphens or underscores, beginning with a letter.');
    if (!types.some(option => option.value === type)) reject('type', 'Select an analyzer type and trust scope.');
    if (unused && (!Number.isInteger(age) || age < 1 || age > 180)) reject('age', 'Enter an unused-access window from 1–180 days.');
    const result = awsServiceModule(location, [
      res('aws_accessanalyzer_analyzer', 'configured', { analyzer_name: name, type }, [
        ...(unused ? [blk('configuration', {}, [blk('unused_access', { unused_access_age: age })])] : []),
        blk('lifecycle', { prevent_destroy: true }),
      ]),
      output('analyzer_arn', 'aws_accessanalyzer_analyzer.configured.arn'),
    ], `# IAM external or unused access analysis

## Prepare
Confirm regional support, existing analyzers, quotas and the selected analysis type's charges. An account analyzer treats the account as its trust boundary. An organization analyzer requires the appropriate management/delegated-administrator setup and trusted service access; it treats the organization as its trust boundary. Verify that scope matches the intended review. The analyzer does not grant access to resources or automatically remediate findings.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the trust scope and unused-access lookback when selected, then apply the saved plan. This form supports unused-access ages through 180 days. Internal-access analysis, exclusions, archive rules and other advanced features use their corresponding existing builders. Changing analyzer type can require replacement, which is blocked by prevent_destroy until explicitly reviewed.

## Verify
Wait for analyzer readiness and initial findings. Run the exported GET-FINDINGS.ps1 with a permitted AWS CLI identity. Validate a controlled test case and inspect findings, affected resources, policy evidence and the selected trust boundary. External-access findings require policy-context review; unused access requires confirmation of business, break-glass and periodic workload needs. Store findings within the authorized data boundary and retention policy.

## Recovery
Preserve findings and review evidence before retirement or replacement. Correct scope/configuration when the analyzer does not cover the intended resources. Revise resource/IAM policies only through their own reviewed workflow, then confirm the finding's resulting state. Archiving or deleting a finding does not remove the access that caused it. Retain a tested administrative recovery path when changing permissions.

https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-concepts.html
`, findings);
    return { ...result, files: { ...result.files, 'GET-FINDINGS.ps1': `$ErrorActionPreference = 'Stop'
$analyzerArn = terraform output -raw analyzer_arn
if ($LASTEXITCODE -ne 0) { throw 'Read analyzer_arn from the applied Terraform state first.' }
$findingsJson = aws accessanalyzer ${unused ? 'list-findings-v2' : 'list-findings'} --analyzer-arn $analyzerArn --region '${location}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not retrieve analyzer findings.' }
$findingsJson | Out-File -LiteralPath findings.json -Encoding utf8
Write-Host 'Saved findings.json. Review it within the authorized data boundary.'
` } };
  },
}                    ;
