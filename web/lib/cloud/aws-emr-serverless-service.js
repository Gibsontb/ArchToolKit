import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
export const AWS_EMR_SERVERLESS_SERVICE = {
  id: 'aws_service_emr_serverless', label: 'Set up an EMR Serverless Spark application',
  description: 'Bounded on-demand Spark application, existing execution role/script, retained CloudWatch logs, optional private networking and an explicit guarded job launcher.',
  emits: ['aws_emrserverless_application', 'aws_iam_role_policy', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Application name', control: 'text' },
    { id: 'release', label: 'Regional EMR Serverless release', control: 'text', default: 'emr-7.8.0', hint: 'Exact supported Serverless release. Review Spark/Python and native package compatibility for the selected region/architecture.' },
    { id: 'architecture', label: 'Worker architecture', control: 'select', default: 'X86_64', options: [{ value: 'X86_64', label: 'x86-64' }, { value: 'ARM64', label: 'Arm64 — compatible native dependencies required' }] },
    { id: 'cpu', label: 'Application maximum aggregate vCPUs', control: 'select', default: '16', options: [8, 16, 32, 64, 128].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'timeout', label: 'Per-job execution timeout (minutes)', control: 'number', default: 60 },
    { id: 'idle', label: 'Auto-stop idle minutes', control: 'select', default: '15', options: [5, 15, 30, 60].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'role', label: 'Existing EMR Serverless execution role ARN', control: 'text', hint: 'Same-account role trusted by emr-serverless.amazonaws.com. Adds exact script-read/log-write permissions only.' },
    { id: 'script', label: 'Existing PySpark script S3 URI', control: 'text', hint: 'Exact private same-account regional s3://bucket/path/script.py. Upload the reviewed SYNTHETIC-EXAMPLE.py separately for a nonsensitive pilot, or supply your reviewed job script.' },
    { id: 'script_kms', label: 'Optional script KMS key ARN', control: 'text', hint: 'Existing regional symmetric key; adds decrypt only. Custom scripts need separately reviewed dataset/service permissions.' },
    { id: 'log_days', label: 'CloudWatch log retention (days)', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'private', label: 'Outbound private VPC networking', control: 'select', default: 'NO', options: [{ value: 'NO', label: 'Service-managed connectivity' }, { value: 'YES', label: 'Existing private subnets and security groups' }] },
    { id: 'subnets', label: 'Private subnet IDs', control: 'text', showWhen: { input: 'private', equals: ['YES'] }, hint: 'Two or three same-VPC subnets in distinct AZs with adequate free addresses and required endpoints/routes.' },
    { id: 'groups', label: 'Worker security group IDs', control: 'text', showWhen: { input: 'private', equals: ['YES'] }, hint: 'Existing same-VPC groups with required worker-to-worker and service/data egress rules. No groups/rules are modified.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.emr.serverless.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), release = String(values.release ?? '').trim(), architecture = String(values.architecture ?? ''), role = String(values.role ?? '').trim(), script = String(values.script ?? '').trim(), kms = String(values.script_kms ?? '').trim(), network = String(values.private ?? '');
    const cpu = Number(values.cpu), timeout = Number(values.timeout), idle = Number(values.idle), logDays = Number(values.log_days);
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = network === 'YES' ? list('subnets') : [], groups = network === 'YES' ? list('groups') : [];
    const roleMatch = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), account = roleMatch?.[1] ?? '';
    const scriptMatch = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/([A-Za-z0-9][A-Za-z0-9._/-]{0,900}\.py)$/.exec(script);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) reject('name', 'Use a letter followed by up to 63 letters, digits, underscores or hyphens.');
    if (!/^emr-(?:6|7)\.\d+\.\d+$/.test(release)) reject('release', 'Use an exact supported EMR Serverless 6.x/7.x release label.');
    if (!['X86_64', 'ARM64'].includes(architecture)) reject('architecture', 'Choose a supported worker architecture.');
    if (![8, 16, 32, 64, 128].includes(cpu)) reject('cpu', 'Select the bounded aggregate application capacity.');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 480) reject('timeout', 'Use 1–480 execution minutes.');
    if (![5, 15, 30, 60].includes(idle)) reject('idle', 'Select an idle auto-stop duration.');
    if (!roleMatch) reject('role', 'Use an existing same-account execution role ARN.');
    if (!scriptMatch || scriptMatch[1] .includes('..') || scriptMatch[2] .split('/').some(part => part === '.' || part === '..') || script.includes('//', 5)) reject('script', 'Use an exact private regional PySpark S3 object URI, without traversal, wildcard or query string.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('script_kms', 'Use an existing regional symmetric script key ARN.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Choose log retention.');
    if (!['YES', 'NO'].includes(network)) reject('private', 'Choose service-managed or private VPC networking.');
    if (network === 'YES') {
      if (subnets.length < 2 || subnets.length > 3 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Use two or three private distinct-AZ subnets.');
      if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Use 1–5 existing worker security groups.');
    }
    const bucket = scriptMatch?.[1] ?? '', key = scriptMatch?.[2] ?? '', scriptArn = 'arn:' + partition + ':s3:::' + bucket + '/' + key;
    const driver = { sparkSubmit: { entryPoint: script, sparkSubmitParameters: '--conf spark.dynamicAllocation.enabled=true --conf spark.dynamicAllocation.minExecutors=1 --conf spark.dynamicAllocation.maxExecutors=' + (cpu / 4 - 1) + ' --conf spark.driver.cores=4 --conf spark.driver.memory=14g --conf spark.executor.cores=4 --conf spark.executor.memory=14g' } };
    const guide = [
      '# EMR Serverless Spark application',
      '## Prepare\nVerify exact Serverless release/architecture availability, native Python/JAR dependencies, Spark compatibility and account vCPU quotas. This recipe provides 4-vCPU workers with 14g Spark memory plus platform overhead, an application cap of four GiB aggregate memory per vCPU, a bounded executor count and no preinitialized capacity. It is not a complete workload-sizing recommendation. Review the supplied existing script and data/service permissions. SYNTHETIC-EXAMPLE.py uses only generated numeric data and no external dataset, so it can be reviewed/uploaded separately for a pilot. This package does not upload or replace the existing script. The runtime role must trust emr-serverless.amazonaws.com with account/application-scoped conditions; output role_trust_example_json is a post-creation example for owner review, not an automatic trust update.',
      '## Deploy\nRun terraform init, terraform validate and terraform plan -out=service.tfplan. Review exact script bucket/role/key, capacity, optional worker network and log retention; apply the reviewed plan. The application has auto-start-on-job enabled and idle auto-stop, but no job is submitted and no initial worker capacity is allocated by this configuration. Optional existing VPC groups must permit required intra-worker traffic and S3/CloudWatch/KMS/data routing; endpoints, policies, DNS and address capacity remain owner prerequisites. The application is private worker infrastructure, not a public web endpoint. Custom scripts needing datasets, catalogs, secrets or writes require separately reviewed execution-role permissions; this scoped package grants only the selected script read, optional key decrypt and this log group write/discovery.',
      '## Submit explicitly\nReview START.ps1, then run it without -Start to inspect the local Terraform job request. When ready, run START.ps1 -Start from the approved operator identity. It checks the package name/region/account/runtime role/script request, STS account, actual application ARN/name/release/type and the existing source object owner before submitting. No arguments or dataset locations are accepted from the command line. Each explicit start gets a client token and one request; do not blindly resubmit after a timeout. Save JobRunId and inspect get-job-run for the same application/region until the terminal status is known. The caller needs application StartJobRun/GetApplication, exact role PassRole, object metadata access and any required monitoring permissions. The execution role is a different identity. No IAM token, access key, schedule or automatic job retry is created.',
      '## Verify and recover\nThe launcher reports request acceptance, not completion. Confirm terminal job status and driver logs, release/architecture, actual worker capacity, idle-stop behavior and permission denials for unrelated buckets. CloudWatch driver logs are enabled with explicit retention. Managed persistence is disabled in this submitted configuration, so Spark UI/history and AWS-managed 30-day log storage are unavailable; design an approved alternative if required. CloudWatch default encryption applies; a customer-managed log key is not configured by this recipe. Synthetic output must contain ten numeric buckets with 100 records each; it is not evidence of migration integrity. For real jobs, independently reconcile data and retain input/replay checkpoints. Cancellation can leave application-specific partial output; inspect before retry, and reconcile accepted requests rather than submitting duplicates. Export script/configuration and retain required logs before deletion. Terraform prevent_destroy is a plan guard. EC2 EMR clusters, Hive, streaming, Lake Formation, data migration and custom dependencies need separate workflows.',
      'https://docs.aws.amazon.com/emr/latest/EMR-Serverless-UserGuide/jobs-spark.html\nhttps://docs.aws.amazon.com/emr/latest/EMR-Serverless-UserGuide/logging.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'execution', { name: roleMatch?.[2]?.split('/').at(-1) ?? '' }), dat('aws_s3_bucket', 'script', { bucket }),
      ...(kms ? [dat('aws_kms_key', 'script', { key_id: kms })] : []),
      ...(network === 'YES' ? [dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }), dat('aws_security_group', 'workers', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') })] : []),
      res('aws_cloudwatch_log_group', 'jobs', { name: '/aws/emr-serverless/' + name, retention_in_days: logDays }),
      res('aws_emrserverless_application', 'configured', { name, release_label: release, type: 'SPARK', architecture, tags: x(hcl({ Name: name })) }, [
        blk('maximum_capacity', { cpu: cpu + ' vCPU', memory: cpu * 4 + ' GB', disk: cpu / 4 * 20 + ' GB' }),
        blk('auto_start_configuration', { enabled: true }), blk('auto_stop_configuration', { enabled: true, idle_timeout_minutes: idle }),
        ...(network === 'YES' ? [blk('network_configuration', { subnet_ids: subnets, security_group_ids: groups })] : []),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.execution.arn == ' + JSON.stringify(role) + ' && data.aws_s3_bucket.script.region == ' + JSON.stringify(region) + (kms ? ' && data.aws_kms_key.script.enabled && data.aws_kms_key.script.key_spec == "SYMMETRIC_DEFAULT"' : '') + (network === 'YES' ? ' && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + subnets.length + ' && alltrue([for group in data.aws_security_group.workers : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])' : '')), error_message: 'Use this account role, regional script/key and distinct-AZ same-VPC subnets/groups.' })]),
      ]),
      res('aws_iam_role_policy', 'execution', { name: name + '-spark-runtime', role: x('data.aws_iam_role.execution.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: scriptArn },
        { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: 'arn:' + partition + ':s3:::' + bucket },
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'], Resource: e('format("%s:*", aws_cloudwatch_log_group.jobs.arn)') },
        { Effect: 'Allow', Action: ['logs:DescribeLogGroups'], Resource: 'arn:' + partition + ':logs:' + region + ':' + account + ':*' },
        ...(kms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: kms }] : []),
      ] })) }),
      output('application_id', 'aws_emrserverless_application.configured.id'),
      output('start_job_request', '{ applicationId = aws_emrserverless_application.configured.id, executionRoleArn = ' + JSON.stringify(role) + ', name = ' + JSON.stringify(name + '-job') + ', executionTimeoutMinutes = ' + timeout + ', jobDriver = ' + hcl(driver) + ', configurationOverrides = { monitoringConfiguration = { managedPersistenceMonitoringConfiguration = { enabled = false }, cloudWatchLoggingConfiguration = { enabled = true, logGroupName = aws_cloudwatch_log_group.jobs.name, logStreamNamePrefix = ' + JSON.stringify(name) + ' } } } }'),
      output('application_metadata', '{ arn = aws_emrserverless_application.configured.arn, account = data.aws_caller_identity.current.account_id, region = ' + JSON.stringify(region) + ', name = ' + JSON.stringify(name) + ' }'),
      output('role_trust_example_json', 'jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "emr-serverless.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = ' + JSON.stringify(account) + ' }, ArnEquals = { "aws:SourceArn" = aws_emrserverless_application.configured.arn } } }] })'),
    ], guide, findings);
    const start = [
      'param([switch]$Start)',
      "$ErrorActionPreference = 'Stop'",
      '$raw = terraform output -json start_job_request; if ($LASTEXITCODE -ne 0) { throw "Read this applied package state." }; $job = $raw | ConvertFrom-Json',
      'if (-not $Start) { $job | ConvertTo-Json -Depth 20; Write-Host "Preview only. No job submitted."; return }',
      '$raw = terraform output -json application_metadata; if ($LASTEXITCODE -ne 0) { throw "Could not read application metadata." }; $meta = $raw | ConvertFrom-Json',
      "if ($meta.account -ne '" + account + "' -or $meta.region -ne '" + region + "' -or $meta.name -ne '" + name + "' -or $job.executionRoleArn -ne '" + role + "' -or $job.jobDriver.sparkSubmit.entryPoint -ne '" + script + "') { throw 'Job state does not match this package.' }",
      'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw ("AWS request failed: " + $Arguments[0] + " " + $Arguments[1]) }; return ($raw | ConvertFrom-Json) }',
      "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json'); if ($identity.Account -ne $meta.account) { throw 'Unexpected operator account.' }",
      "$description = Read-AwsJson @('emr-serverless','get-application','--application-id',$job.applicationId,'--region',$meta.region,'--output','json')",
      "if ($description.application.arn -ne $meta.arn -or $description.application.name -ne '" + name + "' -or $description.application.releaseLabel -ne '" + release + "' -or $description.application.type -ne 'SPARK' -or $description.application.state -notin @('CREATED','STOPPED','STARTED')) { throw 'Unexpected or unavailable Spark application.' }",
      "$public = Read-AwsJson @('s3api','get-public-access-block','--bucket','" + bucket + "','--expected-bucket-owner',$meta.account,'--region',$meta.region,'--output','json')",
      'foreach ($flag in @("BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets")) { if ($public.PublicAccessBlockConfiguration.$flag -ne $true) { throw "Require all four script-bucket public-access blocks." } }',
      "$object = Read-AwsJson @('s3api','head-object','--bucket','" + bucket + "','--key','" + key + "','--expected-bucket-owner',$meta.account,'--region',$meta.region,'--output','json')",
      "if ($object.ServerSideEncryption -like 'aws:kms*' -and $object.SSEKMSKeyId -ne '" + kms + "') { throw 'Enter the actual script KMS key ARN and regenerate before starting.' }",
      '$job | Add-Member -NotePropertyName clientToken -NotePropertyValue ([guid]::NewGuid().ToString()) -Force',
      '$requestPath = Join-Path $PSScriptRoot ("start-request-" + $job.clientToken + ".json")',
      '[System.IO.File]::WriteAllText($requestPath, ($job | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))',
      'Write-Host ("Preserved idempotent request: " + $requestPath)',
      "$response = Read-AwsJson @('emr-serverless','start-job-run','--cli-input-json',('file://' + $requestPath),'--region',$meta.region,'--output','json')",
      'if (-not $response.jobRunId) { throw "No JobRunId returned; reconcile request status before retrying." }',
      '$response | ConvertTo-Json -Depth 10',
      'Write-Host "Job request accepted. Record JobRunId and inspect get-job-run; completion is not yet verified."',
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'START.ps1': start, 'SYNTHETIC-EXAMPLE.py': 'from pyspark.sql import SparkSession\nspark = SparkSession.builder.appName("archtoolkit-synthetic-pilot").getOrCreate()\ntry:\n    spark.range(1000).selectExpr("id % 10 AS bucket").groupBy("bucket").count().orderBy("bucket").show()\nfinally:\n    spark.stop()\n' } };
  },
}                    ;
