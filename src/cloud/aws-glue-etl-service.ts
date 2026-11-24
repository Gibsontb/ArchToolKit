import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
export const AWS_GLUE_ETL_SERVICE = {
  id: 'aws_service_glue_s3_etl', label: 'Set up a Glue Spark S3 format-conversion job',
  description: 'Configured Spark script and job, scoped existing-role permissions, encrypted script/output/logs, retained logs and isolated output per run. No job starts automatically.',
  emits: ['aws_glue_job', 'aws_glue_security_configuration', 'aws_s3_object', 'aws_iam_role_policy', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Job name', control: 'text' },
    { id: 'role', label: 'Existing Glue execution role ARN', control: 'text', hint: 'Same-account role trusted by glue.amazonaws.com; the package adds scoped S3/KMS/log permissions and leaves trust unchanged.' },
    { id: 'source_bucket', label: 'Existing source bucket', control: 'text' },
    { id: 'source_prefix', label: 'Source dataset prefix', control: 'text', default: 'source/', hint: 'Literal relative prefix ending in /. The complete prefix is read on every run; bookmarks/incremental ingestion are not enabled.' },
    { id: 'target_bucket', label: 'Existing destination bucket', control: 'text' },
    { id: 'target_prefix', label: 'Destination dataset prefix', control: 'text', default: 'converted/', hint: 'Each attempt writes a new run-<UUID>/ child. No source overwrite or automatic dataset publication.' },
    { id: 'artifact_bucket', label: 'Existing script/temp bucket', control: 'text', hint: 'Regional private bucket, separate from the source bucket. The package uploads one script and grants job-specific temporary-prefix access.' },
    { id: 'source_format', label: 'Source format', control: 'select', default: 'parquet', options: ['parquet', 'json', 'csv'].map(value => ({ value, label: value.toUpperCase() })) },
    { id: 'target_format', label: 'Destination format', control: 'select', default: 'parquet', options: ['parquet', 'json', 'csv'].map(value => ({ value, label: value.toUpperCase() })) },
    { id: 'workers', label: 'Worker count', control: 'number', default: 2, hint: '2–100 G.1X workers in this recipe; verify regional Glue 5.0 availability and DPU quotas.' },
    { id: 'timeout', label: 'Timeout (minutes)', control: 'number', default: 60 },
    { id: 'kms', label: 'Output/script/bookmark/log KMS key ARN', control: 'text', hint: 'Existing enabled symmetric regional key. Key policy must permit the role, deployment identity and regional CloudWatch Logs service with approved encryption context.' },
    { id: 'source_kms', label: 'Optional source-data KMS key ARN', control: 'text', hint: 'Adds decrypt permission for a separate source key; same key already receives decrypt permission through the job key grant.' },
    { id: 'log_days', label: 'Log retention (days)', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.glue.etl.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), role = String(values.role ?? '').trim(), sourceBucket = String(values.source_bucket ?? '').trim(), targetBucket = String(values.target_bucket ?? '').trim(), artifactBucket = String(values.artifact_bucket ?? '').trim(), sourcePrefix = String(values.source_prefix ?? '').trim(), targetPrefix = String(values.target_prefix ?? '').trim(), sourceFormat = String(values.source_format ?? ''), targetFormat = String(values.target_format ?? ''), kms = String(values.kms ?? '').trim(), sourceKms = String(values.source_kms ?? '').trim();
    const workers = Number(values.workers), timeout = Number(values.timeout), logDays = Number(values.log_days);
    const match = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), account = match?.[1] ?? '', roleName = match?.[2]?.split('/').at(-1) ?? '';
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) reject('name', 'Use a letter followed by up to 63 letters, digits, underscores or hyphens.');
    if (!match) reject('role', 'Use an existing same-account Glue execution role ARN.');
    for (const [id, bucket] of [['source_bucket', sourceBucket], ['target_bucket', targetBucket], ['artifact_bucket', artifactBucket]]) if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket!) || bucket!.includes('..')) reject(id!, 'Use an existing private regional S3 bucket.');
    for (const [id, prefix] of [['source_prefix', sourcePrefix], ['target_prefix', targetPrefix]]) if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,198}\/$/.test(prefix!) || prefix!.includes('//') || prefix!.split('/').some(part => part === '.' || part === '..') || prefix!.startsWith('__archtoolkit/')) reject(id!, 'Use a literal relative dataset prefix ending in /, outside __archtoolkit/, without traversal/wildcards.');
    if (sourceBucket === targetBucket && (sourcePrefix.startsWith(targetPrefix) || targetPrefix.startsWith(sourcePrefix))) reject('target_prefix', 'Source/destination prefixes must not overlap in the same bucket.');
    if (artifactBucket === sourceBucket) reject('artifact_bucket', 'Keep the script/temp bucket separate from source datasets to prevent recursive re-ingestion.');
    for (const [id, format] of [['source_format', sourceFormat], ['target_format', targetFormat]]) if (!['parquet', 'json', 'csv'].includes(format!)) reject(id!, 'Choose Parquet, newline JSON or header CSV.');
    if (!Number.isInteger(workers) || workers < 2 || workers > 100) reject('workers', 'Use 2–100 G.1X workers within account quotas.');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 480) reject('timeout', 'Use a bounded timeout of 1–480 minutes.');
    const keyPattern = new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$');
    if (!keyPattern.test(kms)) reject('kms', 'Provide an existing enabled regional symmetric key.');
    if (sourceKms && !keyPattern.test(sourceKms)) reject('source_kms', 'Use an existing regional source KMS key ARN.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Select log retention.');
    const bucketArn = (bucket: string) => 'arn:' + partition + ':s3:::' + bucket;
    const scriptKey = '__archtoolkit/scripts/' + name + '/ETL.py', tempPrefix = '__archtoolkit/temp/' + name + '/', securityName = name + '-encryption', logPrefix = '/aws-glue/archtoolkit/' + name, actualLogPrefix = logPrefix + '/' + securityName + '-role/' + roleName;
    const sourceUri = 's3://' + sourceBucket + '/' + sourcePrefix, targetUri = 's3://' + targetBucket + '/' + targetPrefix;
    const guide = [
      '# Glue 5.0 Spark S3 dataset format conversion',
      '## Prepare\nReview ETL.py and representative data before deployment. This bounded batch recipe reads the entire source prefix on EACH run, converts file format and writes a new run-UUID child under the destination. It does not implement migration acceptance, CDC, bookmarks, schema/type transformations, deduplication, merge/upsert, Data Catalog tables, Lake Formation grants or a transactional dataset publish. CSV input uses headers and string values without inferred business types; JSON means newline-delimited JSON. Parquet preserves its existing types. CSV output cannot represent arbitrary nested fields; transform/schema-normalize such data separately. Validate malformed-record behavior, nulls, decimals, timestamps, encodings and application semantics in an approved pilot.',
      '## Security and deploy\nUse three existing private regional buckets, or share artifact and destination buckets with disjoint dataset/internal prefixes; artifact and source must differ. Run PREFLIGHT.ps1 to check expected ownership and all four public-access blocks. Confirm source object encryption keys, bucket/key policies, deployment script-upload rights and Glue role trust. The output/script key must also permit the regional CloudWatch Logs service for the exact encrypted log groups; the package does not alter key policy. Additional source key permission is decrypt-only. Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review script bytes, one uploaded KMS-encrypted artifact, exact read/write/temp prefixes, job security configuration, retained KMS-encrypted log groups and resource/timeout caps. Apply the reviewed plan. This uploads the script and creates a job but does not START it.',
      'The fixed runtime is Glue 5.0 with G.1X workers. Confirm current regional runtime/worker availability and DPU quotas before apply. This job has no private VPC connection and uses service S3 connectivity; endpoint-restricted buckets, private JDBC data sources or networks needing a dedicated VPC path require a separately designed connection. Runtime output, bookmarks and logs use the security configuration key. Source bucket reads are prefix-limited; destination and temporary-prefix permissions include deletion for Spark commit/cleanup operations, not source deletion. Existing role permissions may be broader and require independent effective-permission review. Runtime source/target locations are embedded in the reviewed uploaded script; no command-line override is used.',
      '## Execute and verify\nFrom an approved deployment account, run the explicit start command in START-COMMAND.txt only after pilot data/targets and KMS/log access are approved. Record the JobRunId. Inspect get-job-run until SUCCEEDED/FAILED/TIMEOUT/STOPPED and reconcile the emitted run prefix, logs and S3 objects. MaxRetries=0 and max_concurrent_runs=1 prevent configured automatic retries/concurrent runs; callers can still start another complete read. Every attempt writes a new UUID prefix. Failed attempts can leave partial files. A successful attempt or _SUCCESS marker does not itself prove row/content/schema equivalence. Reconcile independent source/output counts, checksums where meaningful, null/type distributions and representative application queries before publishing a dataset pointer. No source/output data is printed by this generated script.',
      '## Recovery\nDo not automatically re-run or append all run prefixes to one dataset: that can duplicate the entire source. Keep a run ledger and expose only an independently accepted run through an approved catalog/pointer change. Retain old datasets and source snapshots; inspect failed outputs before scoped cleanup and retry. Stop-job-run is asynchronous and can leave partial outputs; verify final status before cleanup. Version/retain the script and configuration through the approved repository/bucket policy. No job schedule, trigger, source-data deletion or production cutover is created. Review state guards and object retention before removing infrastructure. Sensitive data handling, residency and the permitted execution boundary must be approved for the actual workload.',
      'https://docs.aws.amazon.com/glue/latest/dg/add-job.html\nhttps://docs.aws.amazon.com/glue/latest/dg/monitor-continuous-logging.html',
    ].join('\n\n') + '\n';
    const statements = [
      { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: [...new Set([sourceBucket, targetBucket, artifactBucket])].map(bucketArn) },
      ...[{ bucket: sourceBucket, prefixes: [sourcePrefix, sourcePrefix + '*'] }, { bucket: targetBucket, prefixes: [targetPrefix, targetPrefix + '*'] }, { bucket: artifactBucket, prefixes: [scriptKey, tempPrefix, tempPrefix + '*'] }].map(item => ({ Effect: 'Allow', Action: ['s3:ListBucket'], Resource: bucketArn(item.bucket), Condition: { StringLike: { 's3:prefix': item.prefixes } } })),
      { Effect: 'Allow', Action: ['s3:GetObject'], Resource: [bucketArn(sourceBucket) + '/' + sourcePrefix + '*', bucketArn(artifactBucket) + '/' + scriptKey] },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], Resource: [bucketArn(targetBucket) + '/' + targetPrefix + '*', bucketArn(artifactBucket) + '/' + tempPrefix + '*'] },
      { Effect: 'Allow', Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], Resource: kms },
      ...(sourceKms && sourceKms !== kms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: sourceKms }] : []),
      { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:AssociateKmsKey'], Resource: ['error', 'output'].flatMap(kind => [e('aws_cloudwatch_log_group.' + kind + '.arn'), e('format("%s:*", aws_cloudwatch_log_group.' + kind + '.arn)')]) },
    ];
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'execution', { name: roleName }), dat('aws_kms_key', 'job', { key_id: kms }),
      ...(sourceKms && sourceKms !== kms ? [dat('aws_kms_key', 'source', { key_id: sourceKms })] : []),
      ...[...new Set([sourceBucket, targetBucket, artifactBucket])].map((bucket, index) => dat('aws_s3_bucket', 'selected_' + index, { bucket })),
      ...['error', 'output'].map(kind => res('aws_cloudwatch_log_group', kind, { name: actualLogPrefix + '/' + kind, kms_key_id: kms, retention_in_days: logDays })),
      res('aws_iam_role_policy', 'execution', { name: name + '-s3-etl', role: x('data.aws_iam_role.execution.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: statements })) }),
      res('aws_s3_object', 'script', { bucket: artifactBucket, key: scriptKey, content: x('file(format("%s/ETL.py", path.module))'), content_type: 'text/x-python', server_side_encryption: 'aws:kms', kms_key_id: kms }, [blk('lifecycle', { prevent_destroy: true })]),
      res('aws_glue_security_configuration', 'configured', { name: securityName }, [blk('encryption_configuration', {}, [
        blk('s3_encryption', { s3_encryption_mode: 'SSE-KMS', kms_key_arn: kms }),
        blk('cloudwatch_encryption', { cloudwatch_encryption_mode: 'SSE-KMS', kms_key_arn: kms }),
        blk('job_bookmarks_encryption', { job_bookmarks_encryption_mode: 'CSE-KMS', kms_key_arn: kms }),
      ])]),
      res('aws_glue_job', 'configured', { name, role_arn: role, glue_version: '5.0', worker_type: 'G.1X', number_of_workers: workers, timeout, max_retries: 0, execution_class: 'STANDARD', security_configuration: x('aws_glue_security_configuration.configured.name'), non_overridable_arguments: x(hcl({ '--job-language': 'python', '--job-bookmark-option': 'job-bookmark-disable', '--TempDir': 's3://' + artifactBucket + '/' + tempPrefix, '--custom-logGroup-prefix': logPrefix, '--enable-metrics': 'true' })), depends_on: x('[aws_iam_role_policy.execution, aws_cloudwatch_log_group.error, aws_cloudwatch_log_group.output]'), tags: x(hcl({ Name: name })) }, [
        blk('command', { name: 'glueetl', python_version: '3', script_location: x('format("s3://%s/%s", aws_s3_object.script.bucket, aws_s3_object.script.key)') }),
        blk('execution_property', { max_concurrent_runs: 1 }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.execution.arn == ' + JSON.stringify(role) + ' && data.aws_kms_key.job.enabled && data.aws_kms_key.job.key_spec == "SYMMETRIC_DEFAULT"' + (sourceKms && sourceKms !== kms ? ' && data.aws_kms_key.source.enabled && data.aws_kms_key.source.key_spec == "SYMMETRIC_DEFAULT"' : '') + [...new Set([sourceBucket, targetBucket, artifactBucket])].map((_, index) => ' && data.aws_s3_bucket.selected_' + index + '.region == ' + JSON.stringify(region)).join('')), error_message: 'Use this account role, regional buckets and enabled symmetric encryption keys.' })]),
      ]),
      output('job_name', 'aws_glue_job.configured.name'), output('script_object_version', 'aws_s3_object.script.version_id'),
    ], guide, findings);
    const script = [
      'import uuid',
      'from pyspark.context import SparkContext',
      'from awsglue.context import GlueContext',
      'context = GlueContext(SparkContext.getOrCreate())',
      'spark = context.spark_session',
      'source = ' + JSON.stringify(sourceUri),
      'destination = ' + JSON.stringify(targetUri) + ' + "run-" + str(uuid.uuid4()) + "/"',
      'reader = spark.read.format(' + JSON.stringify(sourceFormat) + ').option("mode", "FAILFAST")',
      ...(sourceFormat === 'csv' ? ['reader = reader.option("header", "true").option("inferSchema", "false")'] : []),
      ...(sourceFormat === 'json' ? ['reader = reader.option("multiLine", "false")'] : []),
      'data = reader.load(source)',
      'writer = data.write.mode("errorifexists").format(' + JSON.stringify(targetFormat) + ')',
      ...(targetFormat === 'csv' ? ['writer = writer.option("header", "true")'] : []),
      'writer = writer.option("compression", ' + JSON.stringify(targetFormat === 'parquet' ? 'snappy' : 'gzip') + ')',
      'writer.save(destination)',
      'context.get_logger().info("Completed isolated output prefix: " + destination)',
    ].join('\n') + '\n';
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      "$account = '" + account + "'; $region = '" + region + "'",
      'foreach ($bucket in @(' + [...new Set([sourceBucket, targetBucket, artifactBucket])].map(bucket => "'" + bucket + "'").join(',') + ')) {',
      '  $null = aws s3api head-bucket --bucket $bucket --expected-bucket-owner $account --region $region',
      '  if ($LASTEXITCODE -ne 0) { throw "Bucket access/ownership check failed." }',
      '  $raw = aws s3api get-public-access-block --bucket $bucket --expected-bucket-owner $account --region $region --output json',
      '  if ($LASTEXITCODE -ne 0) { throw "Could not verify bucket public-access blocks." }',
      '  $settings = ($raw | ConvertFrom-Json).PublicAccessBlockConfiguration',
      '  foreach ($flag in @("BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets")) { if ($settings.$flag -ne $true) { throw "All four bucket public-access blocks are required." } }',
      '}',
      "Write-Host 'Bucket checks passed; review object/key policies, Glue 5.0 region/DPU capacity and the Terraform plan. No job was started.'",
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'ETL.py': script, 'PREFLIGHT.ps1': preflight, 'START-COMMAND.txt': 'aws glue start-job-run --job-name ' + name + ' --region ' + region + '\n# Record JobRunId; inspect with aws glue get-job-run --job-name ' + name + ' --run-id <returned-id> --region ' + region + '\n' } };
  },
} satisfies Blueprint;
