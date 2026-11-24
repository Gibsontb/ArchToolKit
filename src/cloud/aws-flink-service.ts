import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
export const AWS_FLINK_SERVICE = {
  id: 'aws_service_flink', label: 'Set up a managed Apache Flink application',
  description: 'Pinned existing JAR, checkpoint/snapshot configuration, scoped artifact/log permissions, optional private networking and guarded fresh/snapshot startup. Does not build a business-data pipeline.',
  emits: ['aws_kinesisanalyticsv2_application', 'aws_iam_role_policy', 'aws_cloudwatch_log_group', 'aws_cloudwatch_log_stream'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Application name', control: 'text' },
    { id: 'runtime', label: 'Compatible Flink runtime', control: 'select', default: 'FLINK-1_20', options: ['FLINK-1_19', 'FLINK-1_20'].map(value => ({ value, label: value })), hint: 'Bounded provider-5-compatible runtimes. Verify regional availability and artifact compatibility; newer Managed Flink runtimes require a separate provider/runtime upgrade.' },
    { id: 'role', label: 'Existing Flink execution role ARN', control: 'text', hint: 'Same-account role trusted by kinesisanalytics.amazonaws.com. Connector, dataset and secret permissions remain application-specific.' },
    { id: 'bucket', label: 'Existing private artifact bucket', control: 'text' },
    { id: 'key', label: 'Existing JAR object key', control: 'text', hint: 'Reviewed compatible fat JAR, at most 512 MB. No upload or application compilation is performed.' },
    { id: 'object_version', label: 'Exact S3 object version ID', control: 'text', hint: 'Non-null version from the versioned artifact bucket; prevents an unreviewed latest-object replacement.' },
    { id: 'kms', label: 'Optional artifact KMS key ARN', control: 'text', hint: 'Adds decrypt permission for the actual versioned artifact key. Application state and logs have separate service encryption; this field does not select a state key.' },
    { id: 'parallelism', label: 'Initial parallelism', control: 'number', default: 2 },
    { id: 'per_kpu', label: 'Parallelism per KPU', control: 'select', default: '1', options: [1, 2, 4, 8].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'autoscale', label: 'Service automatic scaling', control: 'select', default: 'NO', options: [{ value: 'NO', label: 'Disabled — fixed configured parallelism' }, { value: 'YES', label: 'Enabled — monitor scaling, quotas and cost' }] },
    { id: 'properties', label: 'Nonsecret application properties (JSON string map)', control: 'textarea', default: '{}', hint: 'Optional map exposed to the JAR as the application property group. Do not put credentials or secret values in Terraform state.' },
    { id: 'log_days', label: 'Application log retention (days)', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'private', label: 'VPC data-source networking', control: 'select', default: 'NO', options: [{ value: 'NO', label: 'Service-managed networking' }, { value: 'YES', label: 'Existing private subnets and worker groups' }] },
    { id: 'subnets', label: 'Private subnet IDs', control: 'text', showWhen: { input: 'private', equals: ['YES'] } },
    { id: 'groups', label: 'Worker security group IDs', control: 'text', showWhen: { input: 'private', equals: ['YES'] }, hint: 'Existing groups must permit required worker connectivity and approved service/data egress.' },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.flink.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), runtime = String(values.runtime ?? ''), role = String(values.role ?? '').trim(), bucket = String(values.bucket ?? '').trim(), key = String(values.key ?? '').trim(), objectVersion = String(values.object_version ?? '').trim(), kms = String(values.kms ?? '').trim(), network = String(values.private ?? ''), autoscale = String(values.autoscale ?? '');
    const parallelism = Number(values.parallelism), perKpu = Number(values.per_kpu), logDays = Number(values.log_days);
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = network === 'YES' ? list('subnets') : [], groups = network === 'YES' ? list('groups') : [];
    const match = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), account = match?.[1] ?? '';
    let properties: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(String(values.properties ?? '{}'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.entries(parsed).length > 50 || Object.entries(parsed).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(key) || typeof value !== 'string' || value.length > 1024)) throw new Error();
      properties = parsed as Record<string, string>;
    } catch { reject('properties', 'Use a JSON object of up to 50 nonsecret string properties.'); }
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) reject('name', 'Use a letter followed by up to 63 letters, digits, underscores or hyphens.');
    if (!['FLINK-1_19', 'FLINK-1_20'].includes(runtime)) reject('runtime', 'Select a compatible supported runtime.');
    if (!match) reject('role', 'Use an existing same-account execution role ARN.');
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject('bucket', 'Use an existing private regional artifact bucket.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,900}\.jar$/.test(key) || key.includes('//') || key.split('/').some(part => part === '.' || part === '..')) reject('key', 'Use an exact relative JAR key without wildcard or traversal.');
    if (!/^[A-Za-z0-9+_./=-]{1,1024}$/.test(objectVersion) || objectVersion === 'null') reject('object_version', 'Use the exact non-null S3 artifact version ID.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing regional symmetric artifact key ARN.');
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 64) reject('parallelism', 'Use initial parallelism 1–64 within account KPU limits.');
    if (![1, 2, 4, 8].includes(perKpu)) reject('per_kpu', 'Choose parallelism per KPU.');
    if (!['YES', 'NO'].includes(autoscale)) reject('autoscale', 'Choose whether service scaling is enabled.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Choose log retention.');
    if (!['YES', 'NO'].includes(network)) reject('private', 'Choose service-managed or VPC networking.');
    if (network === 'YES') {
      if (subnets.length < 2 || subnets.length > 3 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Use two or three distinct-AZ private subnets.');
      if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Use 1–5 existing worker groups.');
    }
    const bucketArn = 'arn:' + partition + ':s3:::' + bucket;
    const guide = [
      '# Managed Apache Flink application with pinned existing code',
      '## Prepare\nBuild/test a compatible application JAR and connectors using the selected Flink runtime and the official Maven dependency guidance; upload it to an existing private versioned regional bucket and record the exact version ID. This package does not compile your business logic, select connector starting offsets, transform records or define source/sink schemas. Run PREFLIGHT.ps1 to check bucket ownership/public-access blocks, the pinned version, artifact size and key metadata. Source/sink access, connector version compatibility, state serializers/operator UIDs and any secrets remain application-owner responsibilities. Nonsecret runtime properties are exposed as the application property group; code must explicitly consume them. Do not put credentials in that map.',
      '## Deploy\nExisting execution role trust must permit kinesisanalytics.amazonaws.com for the approved account/application. This package adds exact versioned artifact read and scoped log access, not broad connector permissions. A VPC connection additionally needs separately reviewed ENI/network permissions on the existing role, suitable subnets/addresses, worker rules, DNS and endpoints/routes. Run terraform init, terraform validate and terraform plan -out=service.tfplan; review runtime, pinned artifact, role, initial KPU/parallelism, autoscaling, checkpoint/snapshot settings and logs, then apply the reviewed plan. Creation leaves the app stopped. Terraform ignores later manual start_application changes so it does not stop a running app merely to restore the original false value. Code/config updates can still restart/update a running app and require normal deployment review.',
      '## State, encryption and startup\nCheckpointing is explicitly enabled at 60-second intervals with 5-second minimum pause; snapshots are enabled and non-restored state is refused. Checkpoints and named snapshots serve different recovery purposes. Artifact KMS decrypt is separate from managed application state encryption and CloudWatch encryption. This provider-5 recipe uses the service default state encryption and default CloudWatch encryption; it does not configure a customer-managed application-state key. If that key is mandatory for the receiving boundary, this recipe requires a provider/control-plane extension before deployment. Verify the actual data classification, boundary and approved service configuration; no authorization is implied.',
      'Use OPERATE.ps1 -Action Inspect for limited application status. StartFresh additionally requires -ConfirmFresh and discards restore state intentionally; use it only for a reviewed first/pilot start. StartLatest requires an available snapshot and asks the service to restore the latest one. StartSnapshot -SnapshotName <name> verifies that exact snapshot is READY before starting. All start paths require application READY, exact package role/runtime/artifact metadata, and refuse allow-non-restored-state. They submit a start request, not a completion claim. Starting consumes data according to your JAR/connector, so verify source offsets/retention and sink idempotency before running it.',
      '## Verify and recover\nWait for RUNNING and successful checkpoints; review last checkpoint age/duration/failures, restarts, lag/backpressure, actual KPU/cost and sink outcomes. Check INFO/APPLICATION metrics and retained logs without enabling sensitive payload logging. Prove source-to-sink counts/semantics independently: checkpoint/snapshot enablement is not a blanket exactly-once guarantee for external systems. Before code/schema/operator changes, take a named compatible snapshot through an approved operator process and test restore in isolation. Inspect snapshot status and compatibility; do not silently allow missing operator state. Existing source retention/replay and output reconciliation remain necessary. No automatic snapshot creation command, job code build, connector permission grant, data migration, force-stop or destructive reset is included. Deletion is blocked by Terraform prevent_destroy until reviewed.',
      'https://docs.aws.amazon.com/managed-flink/latest/java/how-creating-apps.html\nhttps://docs.aws.amazon.com/managed-flink/latest/java/how-fault.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'execution', { name: match?.[2]?.split('/').at(-1) ?? '' }), dat('aws_s3_bucket', 'artifact', { bucket }),
      ...(kms ? [dat('aws_kms_key', 'artifact', { key_id: kms })] : []),
      ...(network === 'YES' ? [dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }), dat('aws_security_group', 'workers', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') })] : []),
      res('aws_cloudwatch_log_group', 'application', { name: '/aws/kinesis-analytics/' + name, retention_in_days: logDays }),
      res('aws_cloudwatch_log_stream', 'application', { name: 'application', log_group_name: x('aws_cloudwatch_log_group.application.name') }),
      res('aws_iam_role_policy', 'execution', { name: name + '-flink-runtime', role: x('data.aws_iam_role.execution.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['s3:GetObjectVersion'], Resource: bucketArn + '/' + key, Condition: { StringEquals: { 's3:VersionId': objectVersion } } },
        { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: bucketArn },
        { Effect: 'Allow', Action: ['logs:PutLogEvents'], Resource: e('format("%s:log-stream:%s", aws_cloudwatch_log_group.application.arn, aws_cloudwatch_log_stream.application.name)') },
        { Effect: 'Allow', Action: ['logs:DescribeLogGroups'], Resource: 'arn:' + partition + ':logs:' + region + ':' + account + ':*' },
        { Effect: 'Allow', Action: ['logs:DescribeLogStreams'], Resource: e('format("%s:*", aws_cloudwatch_log_group.application.arn)') },
        ...(kms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: kms }] : []),
      ] })) }),
      res('aws_kinesisanalyticsv2_application', 'configured', { name, runtime_environment: runtime, service_execution_role: role, application_mode: 'STREAMING', start_application: false, force_stop: false, tags: x(hcl({ Name: name })), depends_on: x('[aws_iam_role_policy.execution]') }, [
        blk('application_configuration', {}, [
          blk('application_code_configuration', { code_content_type: 'ZIPFILE' }, [blk('code_content', {}, [blk('s3_content_location', { bucket_arn: bucketArn, file_key: key, object_version: objectVersion })])]),
          blk('application_snapshot_configuration', { snapshots_enabled: true }),
          blk('flink_application_configuration', {}, [
            blk('checkpoint_configuration', { configuration_type: 'CUSTOM', checkpointing_enabled: true, checkpoint_interval: 60000, min_pause_between_checkpoints: 5000 }),
            blk('monitoring_configuration', { configuration_type: 'CUSTOM', log_level: 'INFO', metrics_level: 'APPLICATION' }),
            blk('parallelism_configuration', { configuration_type: 'CUSTOM', parallelism, parallelism_per_kpu: perKpu, auto_scaling_enabled: autoscale === 'YES' }),
          ]),
          blk('run_configuration', {}, [blk('application_restore_configuration', { application_restore_type: 'RESTORE_FROM_LATEST_SNAPSHOT' }), blk('flink_run_configuration', { allow_non_restored_state: false })]),
          ...(Object.keys(properties).length ? [blk('environment_properties', {}, [blk('property_group', { property_group_id: 'application', property_map: x(hcl(properties)) })])] : []),
          ...(network === 'YES' ? [blk('vpc_configuration', { subnet_ids: subnets, security_group_ids: groups })] : []),
        ]),
        blk('cloudwatch_logging_options', { log_stream_arn: x('aws_cloudwatch_log_stream.application.arn') }),
        blk('lifecycle', { prevent_destroy: true, ignore_changes: x('[start_application]') }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.execution.arn == ' + JSON.stringify(role) + ' && data.aws_s3_bucket.artifact.region == ' + JSON.stringify(region) + (kms ? ' && data.aws_kms_key.artifact.enabled && data.aws_kms_key.artifact.key_spec == "SYMMETRIC_DEFAULT"' : '') + (network === 'YES' ? ' && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + subnets.length + ' && alltrue([for group in data.aws_security_group.workers : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])' : '')), error_message: 'Use this account role, regional artifact/key and distinct-AZ same-VPC subnets/groups.' })]),
      ]),
      output('application_arn', 'aws_kinesisanalyticsv2_application.configured.arn'),
      output('flink_job', '{ arn = aws_kinesisanalyticsv2_application.configured.arn, account = data.aws_caller_identity.current.account_id, name = ' + JSON.stringify(name) + ', region = ' + JSON.stringify(region) + ', runtime = ' + JSON.stringify(runtime) + ', role = ' + JSON.stringify(role) + ', bucket = ' + JSON.stringify(bucketArn) + ', key = ' + JSON.stringify(key) + ', object_version = ' + JSON.stringify(objectVersion) + ' }'),
    ], guide, findings);
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      "$account = '" + account + "'; $region = '" + region + "'; $bucket = '" + bucket + "'",
      '$raw = aws s3api get-public-access-block --bucket $bucket --expected-bucket-owner $account --region $region --output json',
      'if ($LASTEXITCODE -ne 0) { throw "Could not verify artifact bucket owner/public blocks." }',
      '$public = ($raw | ConvertFrom-Json).PublicAccessBlockConfiguration',
      'foreach ($flag in @("BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets")) { if ($public.$flag -ne $true) { throw "Require all four artifact bucket public-access blocks." } }',
      "$raw = aws s3api head-object --bucket $bucket --key '" + key + "' --version-id '" + objectVersion + "' --expected-bucket-owner $account --region $region --output json",
      'if ($LASTEXITCODE -ne 0) { throw "Could not read the exact pinned artifact version." }',
      '$object = $raw | ConvertFrom-Json',
      "if ($object.VersionId -ne '" + objectVersion + "' -or $object.ContentLength -lt 1 -or $object.ContentLength -gt 512000000) { throw 'Require the exact nonempty JAR version within the conservative 512 MB limit.' }",
      "if ($object.ServerSideEncryption -like 'aws:kms*' -and $object.SSEKMSKeyId -ne '" + kms + "') { throw 'Enter the actual artifact KMS key and regenerate.' }",
      "Write-Host 'Artifact metadata checks passed. Review runtime/connector compatibility and the Terraform plan; no application was started.'",
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': preflight, 'OPERATE.ps1': flinkOperator.replaceAll('__NAME__', name).replaceAll('__REGION__', region).replaceAll('__ACCOUNT__', account) } };
  },
} satisfies Blueprint;

const flinkOperator = [
  'param([ValidateSet("Inspect","StartFresh","StartLatest","StartSnapshot")][string]$Action = "Inspect", [string]$SnapshotName, [switch]$ConfirmFresh)',
  "$ErrorActionPreference = 'Stop'",
  '$raw = terraform output -json flink_job; if ($LASTEXITCODE -ne 0) { throw "Read this applied package state." }; $job = $raw | ConvertFrom-Json',
  "if ($job.name -ne '__NAME__' -or $job.region -ne '__REGION__' -or $job.account -ne '__ACCOUNT__') { throw 'Application state differs from this package.' }",
  'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw ("AWS metadata/start request failed: " + $Arguments[0] + " " + $Arguments[1]) }; return ($raw | ConvertFrom-Json) }',
  "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json'); if ($identity.Account -ne $job.account) { throw 'Unexpected application account.' }",
  "$response = Read-AwsJson @('kinesisanalyticsv2','describe-application','--application-name',$job.name,'--region',$job.region,'--output','json')",
  '$application = $response.ApplicationDetail; $code = $application.ApplicationConfigurationDescription.ApplicationCodeConfigurationDescription.CodeContentDescription.S3ApplicationCodeLocationDescription',
  "if ($application.ApplicationARN -ne $job.arn -or $application.ApplicationName -ne $job.name -or $application.RuntimeEnvironment -ne $job.runtime -or $application.ServiceExecutionRole -ne $job.role -or $code.BucketARN -ne $job.bucket -or $code.FileKey -ne $job.key -or $code.ObjectVersion -ne $job.object_version) { throw 'Actual application runtime/role/artifact differs from the reviewed state.' }",
  'if ($Action -eq "Inspect") { [pscustomobject]@{ Name = $application.ApplicationName; Status = $application.ApplicationStatus; Version = $application.ApplicationVersionId; Runtime = $application.RuntimeEnvironment }; return }',
  'if ($application.ApplicationStatus -ne "READY") { throw "Start requires READY; inspect current operation/state before proceeding." }',
  '$restore = @{ ApplicationRestoreType = "RESTORE_FROM_LATEST_SNAPSHOT" }',
  'if ($Action -eq "StartFresh") {',
  '  if (-not $ConfirmFresh) { throw "Fresh startup requires -ConfirmFresh after reviewing discarded restore state and connector offsets." }',
  '  $restore.ApplicationRestoreType = "SKIP_RESTORE_FROM_SNAPSHOT"',
  '} elseif ($Action -eq "StartSnapshot") {',
  '  if ($SnapshotName -notmatch "^[A-Za-z0-9_.-]{1,256}$") { throw "Provide an exact snapshot name." }',
  "  $snapshot = Read-AwsJson @('kinesisanalyticsv2','describe-application-snapshot','--application-name',$job.name,'--snapshot-name',$SnapshotName,'--region',$job.region,'--output','json')",
  '  if ($snapshot.SnapshotDetails.SnapshotName -ne $SnapshotName -or $snapshot.SnapshotDetails.SnapshotStatus -ne "READY") { throw "The selected snapshot is not READY." }',
  '  $restore = @{ ApplicationRestoreType = "RESTORE_FROM_CUSTOM_SNAPSHOT"; SnapshotName = $SnapshotName }',
  '} else {',
  "  $snapshots = Read-AwsJson @('kinesisanalyticsv2','list-application-snapshots','--application-name',$job.name,'--region',$job.region,'--output','json')",
  '  $ready = @($snapshots.SnapshotSummaries | Where-Object { $_.SnapshotStatus -eq "READY" })',
  '  if ($ready.Count -eq 0) { throw "No READY snapshot is available; do not silently start without restored state." }',
  '}',
  '$configuration = @{ ApplicationRestoreConfiguration = $restore; FlinkRunConfiguration = @{ AllowNonRestoredState = $false } }',
  '$requestPath = Join-Path $PSScriptRoot ("start-configuration-" + [guid]::NewGuid().ToString() + ".json")',
  '[System.IO.File]::WriteAllText($requestPath, ($configuration | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))',
  "$null = Read-AwsJson @('kinesisanalyticsv2','start-application','--application-name',$job.name,'--run-configuration',('file://' + $requestPath),'--region',$job.region,'--output','json')",
  'Write-Host "Start request accepted. Inspect until RUNNING and verify successful checkpoints and source/sink outcomes; no completion claim is made."',
].join('\n') + '\n';
