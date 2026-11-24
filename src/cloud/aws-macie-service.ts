import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.ts';
export const AWS_MACIE_SERVICE = {
  id: 'aws_service_macie_job', label: 'Set up a scoped Macie classification job',
  description: 'Configure explicit S3 bucket/prefix scope, sampling, one-time/scheduled analysis and read-only processing/findings export for an enabled Macie account.',
  emits: ['aws_macie2_classification_job'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Classification job name', control: 'text' },
    { id: 'account', label: 'Expected bucket-owning AWS account ID', control: 'text', hint: 'This workflow uses this authenticated account only. Regional Macie activation is a prerequisite.' },
    { id: 'buckets', label: 'Existing regional S3 bucket names', control: 'text', hint: 'Comma-separated bucket names owned by this account, up to 50. Review data-owner approval and inspection charges.' },
    { id: 'prefixes', label: 'Object key prefixes to include', control: 'text', hint: 'Optional comma-separated literal prefixes, such as exports/. No wildcard syntax. Blank means all eligible objects in the selected buckets.' },
    { id: 'sample', label: 'Eligible object sampling (%)', control: 'number', default: 100, hint: '1–100% of eligible objects, not a percentage of bytes. Review a smaller pilot where appropriate.' },
    { id: 'frequency', label: 'Job execution', control: 'select', default: 'ONE_TIME', options: [{ value: 'ONE_TIME', label: 'One time — starts when the package is applied' }, { value: 'DAILY', label: 'Daily schedule' }, { value: 'WEEKLY', label: 'Weekly schedule' }, { value: 'MONTHLY', label: 'Monthly schedule' }] },
    { id: 'initial', label: 'Analyze existing objects at schedule creation', control: 'select', default: 'no', showWhen: { input: 'frequency', equals: ['DAILY', 'WEEKLY', 'MONTHLY'] }, options: [{ value: 'no', label: 'Wait for the scheduled run' }, { value: 'yes', label: 'Run initial analysis when applied' }] },
    { id: 'weekday', label: 'Weekly run day', control: 'select', default: 'MON', showWhen: { input: 'frequency', equals: ['WEEKLY'] }, options: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map(value => ({ value, label: value })) },
    { id: 'month_day', label: 'Monthly run day', control: 'number', default: 1, showWhen: { input: 'frequency', equals: ['MONTHLY'] }, hint: '1–28 so the selected date exists in every month.' },
    { id: 'identifiers', label: 'Existing custom data identifier IDs', control: 'text', hint: 'Optional comma-separated regional custom identifier UUIDs. The provider uses AWS defaults for managed identifiers.' },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.macie.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), name = String(values.name ?? '').trim(), account = String(values.account ?? '').trim(), frequency = String(values.frequency ?? ''), initial = String(values.initial ?? ''), weekday = String(values.weekday ?? ''), monthDay = Number(values.month_day), sample = Number(values.sample);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) reject('name', 'Use 1–100 letters, numbers, dots, underscores or hyphens.');
    if (!/^\d{12}$/.test(account)) reject('account', 'Enter the intended authenticated bucket-owner account ID.');
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const buckets = list('buckets'), prefixes = list('prefixes'), identifiers = list('identifiers');
    if (!buckets.length || buckets.length > 50 || buckets.some(bucket => !/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..'))) reject('buckets', 'Use 1–50 existing regional bucket names owned by this account.');
    if (prefixes.length > 20 || prefixes.some(prefix => /[\x00-\x1f*?]/.test(prefix) || new TextEncoder().encode(prefix).length > 1024)) reject('prefixes', 'Use up to 20 literal object key prefixes within 1024 UTF-8 bytes, without wildcard/control characters.');
    if (!Number.isInteger(sample) || sample < 1 || sample > 100) reject('sample', 'Use a whole sampling percentage from 1 to 100.');
    if (!['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) reject('frequency', 'Select a job execution mode.');
    if (frequency !== 'ONE_TIME' && !['yes', 'no'].includes(initial)) reject('initial', 'Choose initial analysis behavior.');
    if (frequency === 'WEEKLY' && !['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].includes(weekday)) reject('weekday', 'Select the weekly run day.');
    if (frequency === 'MONTHLY' && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 28)) reject('month_day', 'Use a monthly day from 1 to 28.');
    if (identifiers.length > 50 || identifiers.some(id => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) reject('identifiers', 'Use up to 50 existing regional custom data identifier UUIDs.');
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_s3_bucket', 'selected', { for_each: x('toset(' + JSON.stringify(buckets) + ')'), bucket: x('each.value') }),
      res('aws_macie2_classification_job', 'configured', { name, job_type: frequency === 'ONE_TIME' ? 'ONE_TIME' : 'SCHEDULED', sampling_percentage: sample, ...(identifiers.length ? { custom_data_identifier_ids: identifiers } : {}), ...(frequency !== 'ONE_TIME' ? { initial_run: initial === 'yes' } : {}), tags: x(hcl({ Name: name })) }, [
        blk('s3_job_definition', {}, [blk('bucket_definitions', { account_id: account, buckets }), ...(prefixes.length ? [blk('scoping', {}, [blk('includes', {}, [blk('and', {}, [blk('simple_scope_term', { key: 'OBJECT_KEY', comparator: 'STARTS_WITH', values: prefixes })])])])] : [])]),
        ...(frequency === 'ONE_TIME' ? [] : [blk('schedule_frequency', frequency === 'DAILY' ? { daily_schedule: true } : frequency === 'WEEKLY' ? { weekly_schedule: weekday } : { monthly_schedule: monthDay })]),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && alltrue([for bucket in data.aws_s3_bucket.selected : bucket.region == ' + JSON.stringify(region) + '])'), error_message: 'Use the expected bucket-owner account and buckets in the selected region.' })]),
      ]), output('job_id', 'aws_macie2_classification_job.configured.job_id'), output('job_arn', 'aws_macie2_classification_job.configured.job_arn'),
    ], `# Scoped Macie sensitive-data classification job

## Prepare
Run PREFLIGHT.ps1 under the intended operator identity. Macie must already be enabled in this region, with its service-linked role and required S3/KMS permissions. Configure an approved classification-results repository/retention policy where required before creating the job. Coordinate existing account-level automated discovery and its separate scope; this package does not enable, disable or reconfigure that feature. Review data-owner approval, exact buckets/prefixes, object eligibility, inspection costs, sampling and export handling. Whole-bucket scope applies when no prefixes are entered. Existing custom identifiers must belong to the selected region. The pinned provider uses AWS defaults for managed identifiers; this path does not expose their selector API.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review every bucket, prefix, sampling setting and schedule, then apply the saved reviewed plan. A one-time job starts analysis when created; scheduled jobs follow the selected schedule and the initial-run choice. This is data inspection, not a passive readiness assessment. Macie chooses service scheduling details; there is no arbitrary cron/time-of-day field here. No source object is migrated or modified by this job. Package generation and Terraform validate do not submit a job.

## Verify and export
Run aws macie2 describe-classification-job --job-id <job_id> --region ${region} and review processing status/statistics, errors and eligibility. Run GET-REPORT.ps1 to save job details and only findings associated with this job. It retrieves all listed finding IDs in supported batches. Reconcile inspected/eligible/skipped objects, sampled scope, KMS/access errors and classification-results evidence. No findings does not prove complete coverage or absence of sensitive data. Unsupported formats, encrypted content, sampling and permission gaps can limit inspection. Findings indicate patterns for review; they do not assign national-security classification, determine handling requirements or authorize a transfer/ATO. Data owners make those decisions under the applicable rules.

## Recovery
Pause or cancel through aws macie2 update-classification-job --job-id <job_id> --job-status USER_PAUSED (or CANCELLED) --region ${region}, after reviewing service constraints and pending work. Preserve job/statistics/findings/results evidence before changes. A cancelled/completed one-time job is not a reusable migration action; create a newly reviewed job when required. Terraform prevent_destroy protects accidental removal/cancellation, but changing replacement-only settings can require a new job. Removing a job does not delete S3 source data. Treat generated reports as potentially sensitive, keep them within approved boundaries and apply retention. Account activation, custom-identifier creation, organization discovery and result-repository setup remain separate builders.

https://docs.aws.amazon.com/macie/latest/user/discovery-jobs-manage-results.html
`, findings);
    return { ...result, files: { ...result.files,
      'PREFLIGHT.ps1': `$ErrorActionPreference = 'Stop'
$identityJson = aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read current AWS identity.' }
if (($identityJson | ConvertFrom-Json).Account -ne '${account}') { throw 'Unexpected bucket-owner account.' }
$sessionJson = aws macie2 get-macie-session --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Macie must already be enabled and accessible in this region.' }
if (($sessionJson | ConvertFrom-Json).status -ne 'ENABLED') { throw 'Enable the regional Macie account through its owner before creating this job.' }
Write-Host 'Account/session checked. Review source ownership, S3/KMS access, object eligibility, results retention, scope and inspection approval.'
`,
      'GET-REPORT.ps1': `$ErrorActionPreference = 'Stop'
$reportIdentityJson = aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read report-export identity.' }
if (($reportIdentityJson | ConvertFrom-Json).Account -ne '${account}') { throw 'Unexpected report-export account.' }
$classificationJobId = terraform output -raw job_id
if ($LASTEXITCODE -ne 0) { throw 'Read job_id from the applied Terraform state first.' }
$jobDetails = aws macie2 describe-classification-job --job-id $classificationJobId --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read classification job details.' }
$jobDetails | Out-File -LiteralPath macie-job.json -Encoding utf8
$criteriaFile = [System.IO.Path]::GetTempFileName()
try {
  $criteria = @{ criterion = @{ 'classificationDetails.jobId' = @{ eq = @($classificationJobId) } } }
  [System.IO.File]::WriteAllText($criteriaFile, ($criteria | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
  $findingIdJson = aws macie2 list-findings --finding-criteria ('file://' + $criteriaFile) --region '${region}' --output json
  if ($LASTEXITCODE -ne 0) { throw 'Could not list job findings.' }
  $findingIds = @(($findingIdJson | ConvertFrom-Json).findingIds | Where-Object { $_ })
  $allFindings = [System.Collections.Generic.List[object]]::new()
  for ($offset = 0; $offset -lt $findingIds.Count; $offset += 50) {
    $lastIndex = [Math]::Min($offset + 49, $findingIds.Count - 1)
    $findingBatch = @($findingIds[$offset..$lastIndex])
    $batchJson = aws macie2 get-findings --finding-ids $findingBatch --region '${region}' --output json
    if ($LASTEXITCODE -ne 0) { throw 'Could not retrieve a findings batch.' }
    foreach ($finding in ($batchJson | ConvertFrom-Json).findings) { $allFindings.Add($finding) }
  }
  $reportJson = ConvertTo-Json -InputObject $allFindings.ToArray() -Depth 100
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'macie-findings.json'), $reportJson, [System.Text.UTF8Encoding]::new($false))
} finally { Remove-Item -LiteralPath $criteriaFile -Force }
Write-Host 'Saved job details and scoped findings. Review inspection coverage and handle reports within the approved boundary.'
`,
    } };
  },
} satisfies Blueprint;
