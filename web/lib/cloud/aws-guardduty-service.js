import { error,              } from '../core/findings.js';
                                                     
import { blk, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';

const features = [
  ['s3', 'S3_DATA_EVENTS', 'S3 data-event protection'],
  ['eks', 'EKS_AUDIT_LOGS', 'EKS audit-log protection'],
  ['malware', 'EBS_MALWARE_PROTECTION', 'EC2 EBS malware protection'],
  ['rds', 'RDS_LOGIN_EVENTS', 'RDS login-event protection'],
  ['lambda', 'LAMBDA_NETWORK_LOGS', 'Lambda network-log protection'],
]         ;
export const AWS_GUARDDUTY_SERVICE = {
  id: 'aws_service_guardduty', label: 'Set up regional GuardDuty protection',
  description: 'Create a regional detector or configure selected protection plans on an existing detector, with a read-only account preflight.',
  emits: ['aws_guardduty_detector', 'aws_guardduty_detector_feature'],
  inputs: [
    awsServiceRegion,
    { id: 'mode', label: 'Detector setup', control: 'select', default: 'new', options: [{ value: 'new', label: 'Create detector in this account and region' }, { value: 'existing', label: 'Configure protection on an existing detector' }] },
    { id: 'detector', label: 'Existing detector ID', control: 'text', showWhen: { input: 'mode', equals: ['existing'] }, hint: 'Use the 32-character hexadecimal regional ID.' },
    { id: 'frequency', label: 'Updated finding publication frequency', control: 'select', default: 'FIFTEEN_MINUTES', showWhen: { input: 'mode', equals: ['new'] }, options: ['FIFTEEN_MINUTES', 'ONE_HOUR', 'SIX_HOURS'].map(value => ({ value, label: value })), hint: 'This workflow leaves an existing detector\'s settings and ownership unchanged.' },
    ...features.map(([id, , label]) => ({ id, label, control: 'select'         , default: 'unmanaged', options: [{ value: 'unmanaged', label: 'Use existing / AWS defaults' }, { value: 'ENABLED', label: 'Enable protection plan' }, { value: 'DISABLED', label: 'Disable protection plan' }] })),
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.guardduty.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), mode = String(values.mode ?? ''), detector = String(values.detector ?? '').trim(), frequency = String(values.frequency ?? '');
    if (!['new', 'existing'].includes(mode)) reject('mode', 'Choose a new or existing detector.');
    if (mode === 'existing' && !/^[a-fA-F0-9]{32}$/.test(detector)) reject('detector', 'Enter a 32-character hexadecimal existing detector ID.');
    if (!['FIFTEEN_MINUTES', 'ONE_HOUR', 'SIX_HOURS'].includes(frequency)) reject('frequency', 'Choose a finding publication frequency.');
    for (const [id] of features) if (!['unmanaged', 'ENABLED', 'DISABLED'].includes(String(values[id] ?? ''))) reject(id, 'Choose the protection-plan behavior.');
    const selected = features.filter(([id]) => ['ENABLED', 'DISABLED'].includes(String(values[id])));
    if (mode === 'existing' && !selected.length) reject('mode', 'Select at least one protection-plan change for an existing detector.');
    const reference = mode === 'new' ? 'aws_guardduty_detector.configured.id' : JSON.stringify(detector);
    const result = awsServiceModule(location, [
      ...(mode === 'new' ? [res('aws_guardduty_detector', 'configured', { enable: true, finding_publishing_frequency: frequency }, [blk('lifecycle', { prevent_destroy: true })])] : []),
      ...selected.map(([id, name]) => res('aws_guardduty_detector_feature', id, { detector_id: x(reference), name, status: String(values[id]) })),
      output('detector_id', reference),
    ], `# Regional GuardDuty detector and protection plans

## Prepare
Run PREFLIGHT.ps1 with an authorized AWS CLI identity before terraform plan. GuardDuty allows one detector per account and region. The existing-detector path manages only selected protection plans; coordinate with its Terraform owner and delegated security administrator. Organization policies may control member settings. Review regional availability, service-linked role permissions, trial status and recurring plan costs. Unmanaged plans retain existing/AWS defaults, which can include enabled paid plans. Review those defaults before applying.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Check the selected account, region and each explicit enabled/disabled plan. Apply the reviewed saved plan. New detectors enable foundational threat detection. Existing detectors must already be enabled; their frequency and ownership are preserved. This workflow configures five optional protection plans. Runtime agents, organization-wide enrollment, finding export and notification routing require their own setup.

## Verify
Use aws guardduty get-detector --detector-id <output detector_id> --region ${location}. Confirm detector status, feature states and updated-finding frequency. Review service coverage and permissions for the selected plans. Coordinate a controlled sample-finding test with security operations and verify the existing downstream notification/response path. Review costs and findings after the billing/analysis processing interval.

## Recovery
Restore an explicit prior feature status through a reviewed plan. Removing a feature resource from Terraform does not disable that protection plan; set DISABLED explicitly when authorized. New detector deletion is blocked by prevent_destroy. Preserve required findings and approvals before changing that protection. Existing-detector deletion is outside this package. No automated remediation or claim of compliance/authorization is included.

https://docs.aws.amazon.com/guardduty/latest/APIReference/API_CreateDetector.html
`, findings);
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': `$ErrorActionPreference = 'Stop'
$detectorResponse = aws guardduty list-detectors --region '${location}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not list regional detectors. Check identity, permissions and region.' }
$regionalDetectorIds = @(($detectorResponse | ConvertFrom-Json).DetectorIds)
${mode === 'new' ? "if ($regionalDetectorIds.Count -ne 0) { throw 'A regional detector already exists. Use the existing-detector setup and coordinate ownership.' }" : `if ($regionalDetectorIds -notcontains '${detector}') { throw 'The selected detector is not in this account and region.' }
$detectorDetails = aws guardduty get-detector --detector-id '${detector}' --region '${location}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the selected detector.' }
if (($detectorDetails | ConvertFrom-Json).Status -ne 'ENABLED') { throw 'Enable the existing detector through its owner before changing protection plans.' }`}
Write-Host 'Regional detector check passed. Review organization policy, feature support, ownership and pricing before applying.'
` } };
  },
}                    ;
