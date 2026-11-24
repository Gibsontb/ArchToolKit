import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.ts';
const scanTypes = ['EC2', 'ECR', 'LAMBDA', 'LAMBDA_CODE'] as const;
export const AWS_INSPECTOR_SERVICE = {
  id: 'aws_service_inspector', label: 'Set up regional Inspector vulnerability scanning',
  description: 'Enable selected scan types for the authenticated account, with account safeguards, existing-status checks and findings/coverage retrieval.',
  emits: ['aws_inspector2_enabler'],
  inputs: [
    awsServiceRegion,
    { id: 'account', label: 'Expected AWS account ID', control: 'text', hint: 'Required 12-digit account guard. This workflow configures only the authenticated account.' },
    ...scanTypes.map(type => ({ id: type.toLowerCase(), label: type === 'LAMBDA_CODE' ? 'Lambda application code scanning' : type + ' vulnerability scanning', control: 'select' as const, default: type === 'LAMBDA_CODE' ? 'off' : 'on', options: [{ value: 'on', label: 'Enable and manage' }, { value: 'off', label: 'Not selected' }] })),
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.inspector.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), account = String(values.account ?? '').trim();
    if (!/^\d{12}$/.test(account)) reject('account', 'Enter the intended 12-digit AWS account ID.');
    for (const type of scanTypes) if (!['on', 'off'].includes(String(values[type.toLowerCase()] ?? ''))) reject(type.toLowerCase(), 'Choose whether to manage this scan type.');
    const selected = scanTypes.filter(type => values[type.toLowerCase()] === 'on');
    if (!selected.length) reject('ec2', 'Select at least one scan type.');
    if (selected.includes('LAMBDA_CODE') && !selected.includes('LAMBDA')) reject('lambda_code', 'Lambda code scanning also requires Lambda standard scanning.');
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      res('aws_inspector2_enabler', 'configured', { account_ids: [account], resource_types: selected }, [blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account)), error_message: 'Inspector scanning must be configured in the expected authenticated account.' })])]),
      output('scanning_account_id', 'data.aws_caller_identity.current.account_id'),
    ], `# Regional Amazon Inspector vulnerability scanning

## Prepare
Run PREFLIGHT.ps1 with the deployment AWS CLI identity and review current scan status. Coordinate existing Terraform ownership and organization/delegated-administrator policy before adopting account-level scanning. Review regional scan-type availability, supported OS/runtimes, exclusions, charges and service-linked role creation permissions. EC2 agent-based coverage requires eligible Systems Manager-managed instances; agentless coverage depends on the regional EC2 scan mode and supported volumes/keys. This package leaves EC2 scan mode and ECR rescan settings under their existing owner. ECR activation changes the registry to enhanced scanning; review existing registry scanning configuration first.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Confirm the exact account and selected regional scan types, then apply the reviewed saved plan. Inspector starts eligible-resource assessment automatically after activation. Lambda code scanning requires standard scanning. This package does not enroll other accounts, deploy SSM agents, remove exclusions, configure EC2 scan mode, define repository filters or repair discovered vulnerabilities. Existing enabled scan types outside this resource remain subject to their current configuration and organization policy. Removing a previously managed type from this resource can disable that scan type; review changes carefully.

## Verify
Run GET-COVERAGE.ps1 to save current coverage and findings within the approved data boundary. Reconcile coverage against the expected EC2 instances, ECR images and Lambda functions. Investigate unsupported, excluded, stale and inaccessible resources; activation alone does not establish full coverage. Verify service-linked roles, SSM health and relevant KMS access for intended scan methods. Review severity, remediation guidance, scan timestamps and existing security-operations routing. Test remediation on a known finding and confirm its next assessment result. Exports can contain resource identifiers and security findings; handle and retain them appropriately.

## Recovery
Preserve previous scan configuration and coordinate changes with the security owner. Terraform prevent_destroy blocks accidental removal of the whole enabler; it does not block scan-type changes in an update. Restore selected types through a reviewed plan when coverage was unintentionally reduced. Disabling a scan type does not remediate vulnerabilities. Organization policies can override member actions. Code Security repository scanning, machine-image scanning and organization-wide rollout require separate workflows/provider support.

https://docs.aws.amazon.com/inspector/latest/user/activate-scans.html
`, findings);
    const identityCheck = `$identityJson = aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the current AWS identity.' }
if (($identityJson | ConvertFrom-Json).Account -ne '${account}') { throw 'AWS identity does not match the expected scanning account.' }
`;
    return { ...result, files: { ...result.files,
      'PREFLIGHT.ps1': `$ErrorActionPreference = 'Stop'
${identityCheck}$scanStatus = aws inspector2 batch-get-account-status --account-ids '${account}' --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read Inspector account status.' }
$scanStatus
Write-Host 'Review scan status, ownership, organization policy and regional coverage before applying.'
`,
      'GET-COVERAGE.ps1': `$ErrorActionPreference = 'Stop'
${identityCheck}$coverageJson = aws inspector2 list-coverage --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not list Inspector coverage.' }
$coverageJson | Out-File -LiteralPath inspector-coverage.json -Encoding utf8
$findingsJson = aws inspector2 list-findings --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not list Inspector findings.' }
$findingsJson | Out-File -LiteralPath inspector-findings.json -Encoding utf8
Write-Host 'Saved coverage and findings. Review completeness and handle both files within the approved boundary.'
`,
    } };
  },
} satisfies Blueprint;
