import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
export const AWS_FIREHOSE_SERVICE = {
  id: 'aws_service_firehose_s3', label: 'Set up Firehose delivery to S3',
  description: 'Direct input or existing Kinesis source, scoped delivery-role permissions, explicit encryption, S3 buffering/compression, retained delivery logs and a guarded producer example.',
  emits: ['aws_kinesis_firehose_delivery_stream', 'aws_iam_role_policy', 'aws_cloudwatch_log_group', 'aws_cloudwatch_log_stream'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Delivery stream name', control: 'text' },
    { id: 'source', label: 'Input source', control: 'select', default: 'DIRECT', options: [{ value: 'DIRECT', label: 'Direct PutRecord / PutRecordBatch producers' }, { value: 'KINESIS', label: 'Read an existing Kinesis data stream' }] },
    { id: 'stream', label: 'Existing regional Kinesis stream ARN', control: 'text', showWhen: { input: 'source', equals: ['KINESIS'] }, hint: 'Same-account stream. Firehose begins at LATEST and starts reading after creation; it does not backfill retained history.' },
    { id: 'role', label: 'Existing Firehose delivery role ARN', control: 'text', hint: 'Same-account role trusted by firehose.amazonaws.com. This package adds a named scoped inline policy; coordinate shared-role ownership.' },
    { id: 'bucket', label: 'Existing private S3 destination bucket', control: 'text', hint: 'Same account and region, with approved public-access blocks, default encryption, versioning/retention and key/bucket policies.' },
    { id: 'prefix', label: 'Literal S3 destination prefix', control: 'text', default: 'delivery/', hint: 'Relative prefix ending in /. No wildcard/dynamic partition expressions. Firehose appends its normal time-based object path.' },
    { id: 'destination_kms', label: 'S3 object encryption KMS key ARN', control: 'text', hint: 'Required for a KMS-encrypted destination. Leave blank only for approved SSE-S3 bucket encryption. Preflight checks the bucket default.' },
    { id: 'buffer_kms', label: 'Direct-input buffer KMS key ARN', control: 'text', showWhen: { input: 'source', equals: ['DIRECT'] }, hint: 'Optional existing regional symmetric key. Blank enables Firehose SSE with an AWS-owned key. Separate from S3 object encryption.' },
    { id: 'size', label: 'S3 buffer size hint (MiB)', control: 'select', default: '5', options: [1, 5, 16, 64, 128].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'interval', label: 'S3 buffer interval hint (seconds)', control: 'select', default: '300', options: [60, 120, 300, 900].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'compression', label: 'S3 compression', control: 'select', default: 'GZIP', options: ['UNCOMPRESSED', 'GZIP', 'ZIP', 'Snappy', 'HADOOP_SNAPPY'].map(value => ({ value, label: value })) },
    { id: 'log_days', label: 'Delivery error log retention (days)', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.firehose.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), source = String(values.source ?? ''), stream = source === 'KINESIS' ? String(values.stream ?? '').trim() : '', role = String(values.role ?? '').trim(), bucket = String(values.bucket ?? '').trim(), prefix = String(values.prefix ?? '').trim(), destinationKms = String(values.destination_kms ?? '').trim(), bufferKms = source === 'DIRECT' ? String(values.buffer_kms ?? '').trim() : '', size = Number(values.size), interval = Number(values.interval), compression = String(values.compression ?? ''), logDays = Number(values.log_days);
    const roleMatch = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), streamMatch = new RegExp('^arn:' + partition + ':kinesis:' + region + ':' + (roleMatch?.[1] ?? '\\d{12}') + ':stream/([A-Za-z0-9_.-]{1,128})$').exec(stream);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) reject('name', 'Use a letter followed by up to 63 letters, digits, underscores, periods or hyphens.');
    if (!['DIRECT', 'KINESIS'].includes(source)) reject('source', 'Choose direct input or an existing Kinesis source.');
    if (!roleMatch) reject('role', 'Use an existing same-account Firehose role ARN in the selected partition.');
    if (source === 'KINESIS' && !streamMatch) reject('stream', 'Use an existing Kinesis stream ARN in the delivery-role account and selected region.');
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject('bucket', 'Use an existing same-account regional S3 bucket.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,198}\/$/.test(prefix) || prefix.includes('//') || prefix.split('/').some(part => part === '.' || part === '..')) reject('prefix', 'Use a literal relative prefix within 200 characters ending in /, without wildcards or traversal.');
    for (const [path, key] of [['destination_kms', destinationKms], ['buffer_kms', bufferKms]]) if (key && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$').test(key)) reject(path!, 'Use a regional symmetric KMS key ARN with a UUID or multi-Region key ID.');
    if (![1, 5, 16, 64, 128].includes(size)) reject('size', 'Select a supported S3 buffer size.');
    if (![60, 120, 300, 900].includes(interval)) reject('interval', 'Select a supported buffering interval.');
    if (!['UNCOMPRESSED', 'GZIP', 'ZIP', 'Snappy', 'HADOOP_SNAPPY'].includes(compression)) reject('compression', 'Choose the S3 compression format.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Choose delivery-log retention.');
    const bucketArn = 'arn:' + partition + ':s3:::' + bucket;
    const deliveryStatements = [
      { Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'], Resource: bucketArn },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload'], Resource: bucketArn + '/' + prefix + '*' },
      { Effect: 'Allow', Action: ['logs:PutLogEvents'], Resource: e('format("%s:log-stream:%s", aws_cloudwatch_log_group.delivery.arn, aws_cloudwatch_log_stream.delivery.name)') },
      ...(destinationKms ? [{ Effect: 'Allow', Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Resource: e('data.aws_kms_key.destination.arn') }] : []),
      ...(source === 'KINESIS' ? [{ Effect: 'Allow', Action: ['kinesis:DescribeStream', 'kinesis:GetShardIterator', 'kinesis:GetRecords', 'kinesis:ListShards'], Resource: stream }] : []),
    ];
    const sourceKeyStatements = source === 'KINESIS' ? 'data.aws_kinesis_stream.source.encryption_type == "KMS" ? [{ Effect = "Allow", Action = ["kms:Decrypt"], Resource = data.aws_kms_key.source[0].arn }] : []' : '[]';
    const producerStatements = [{ Effect: 'Allow', Action: source === 'KINESIS' ? ['kinesis:PutRecord', 'kinesis:PutRecords'] : ['firehose:PutRecord', 'firehose:PutRecordBatch'], Resource: source === 'KINESIS' ? stream : e('aws_kinesis_firehose_delivery_stream.configured.arn') }, ...(bufferKms ? [{ Effect: 'Allow', Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Resource: e('data.aws_kms_key.buffer.arn') }] : [])];
    const sourceProducerKey = source === 'KINESIS' ? 'data.aws_kinesis_stream.source.encryption_type == "KMS" ? [{ Effect = "Allow", Action = ["kms:GenerateDataKey"], Resource = data.aws_kms_key.source[0].arn }] : []' : '[]';
    const guide = [
      '# Firehose delivery to S3',
      '## Prepare\nReview the same-account regional source/destination, bucket public-access blocks, encryption/retention, service quotas and ongoing stream/S3/KMS/log charges. The existing delivery role must trust firehose.amazonaws.com; this package adds a named inline policy, so coordinate existing owners and avoid name collisions. Bucket/KMS policies, SCPs and deployment PassRole permissions remain prerequisites. Bucket listing metadata is granted on this bucket; object reads/writes are limited to the literal destination prefix. No transformation, dynamic partitioning, format conversion or other destination is configured.',
      source === 'KINESIS' ? 'Applying this package starts consuming the selected Kinesis stream at LATEST, not retained history. Confirm data-owner authorization and capacity before apply. Firehose PutRecord/PutRecordBatch are disabled for this source type; producers write to Kinesis instead. The stream data source resolves encryption and an encrypted source key for scoped reader/producer grants. Existing source retention, encryption and consumer contention remain owned by the stream operator.' : 'Direct input enables server-side encryption using the selected symmetric buffer key or an AWS-owned key. A customer-managed buffer key also needs deployment CreateGrant and producer GenerateDataKey/Decrypt permissions under its key policy. Buffer encryption and S3 object encryption are separate controls.',
      '## Implement\nRun PREFLIGHT.ps1 using the deployment account first: it reads caller identity, expected bucket ownership, bucket public-access blocks and default encryption. Blank destination key is accepted only with SSE-S3; enter the actual regional key ARN for KMS destinations so delivery permissions include that key. This read-only check does not lock bucket settings; rerun after changes and review bucket/key policies. Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review exact source, role policy, destination prefix, both encryption layers, compression and buffer hints; apply the reviewed plan and wait for ACTIVE. Buffer size/interval are delivery hints, not strict latency guarantees. The literal S3 prefix receives the normal time-based Firehose object path. Verify actual object encryption/header and bucket policy rather than assuming a key from another layer.',
      'Export terraform output -raw producer_policy_json for the application IAM owner. It permits only the appropriate source write operations and any required key use; no credentials are embedded. Install the approved AWS CLI in the producer/test environment. SEND-EXAMPLE.ps1 does nothing until -Send is explicitly supplied. Run it only in an approved pilot prefix/source with nonsensitive test records. For Kinesis-source mode, the example writes Kinesis records; it never calls Firehose PutRecordBatch.',
      '## Verify\nCheck the delivery stream, delivery logs, DeliveryToS3 metrics/failures/data freshness, Kinesis lag where applicable, and the final S3 objects. Decompress and parse the delivered bytes using the configured format; Firehose concatenates record blobs, so producers must supply record delimiters such as newline. An accepted producer request is not proof of S3 arrival. The example checks per-record failure entries and does not automatically resend a whole batch. Retry only the failed/uncertain records through an idempotent application process; timeouts/retries and service delivery can produce duplicates. Include application event IDs and validate counts independently.',
      '## Recovery\nKeep an independent replay source/checkpoint and monitor delivery/key failures before the applicable retention window expires. Direct-input records are not retained indefinitely; sustained destination/key failure can lose buffered data after the service retention period. Restore destination permissions/key access and inspect actual delivery before replaying. Do not treat a stream configuration rollback as data rollback or exactly-once delivery. Stop/coordinate producers and drain/verify delivery before removal. Local generation/validation creates no stream and sends/consumes no data.',
      'https://docs.aws.amazon.com/firehose/latest/dev/controlling-access.html\nhttps://docs.aws.amazon.com/firehose/latest/dev/encryption.html\nhttps://docs.aws.amazon.com/firehose/latest/APIReference/API_PutRecordBatch.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_s3_bucket', 'destination', { bucket }), dat('aws_iam_role', 'delivery', { name: roleMatch?.[2]?.split('/').at(-1) ?? '' }),
      ...(destinationKms ? [dat('aws_kms_key', 'destination', { key_id: destinationKms })] : []), ...(bufferKms ? [dat('aws_kms_key', 'buffer', { key_id: bufferKms })] : []),
      ...(source === 'KINESIS' ? [dat('aws_kinesis_stream', 'source', { name: streamMatch?.[1] ?? '' }), dat('aws_kms_key', 'source', { count: x('data.aws_kinesis_stream.source.encryption_type == "KMS" ? 1 : 0'), key_id: x('data.aws_kinesis_stream.source.kms_key_id') })] : []),
      res('aws_cloudwatch_log_group', 'delivery', { name: '/aws/kinesisfirehose/' + name, retention_in_days: logDays }),
      res('aws_cloudwatch_log_stream', 'delivery', { name: 'S3Delivery', log_group_name: x('aws_cloudwatch_log_group.delivery.name') }),
      res('aws_iam_role_policy', 'delivery', { name: name + '-delivery', role: x('data.aws_iam_role.delivery.name'), policy: x('jsonencode({ Version = "2012-10-17", Statement = concat(' + hcl(deliveryStatements) + ', ' + sourceKeyStatements + ') })') }),
      res('aws_kinesis_firehose_delivery_stream', 'configured', { name, destination: 'extended_s3', tags: x(hcl({ Name: name })), depends_on: x('[aws_iam_role_policy.delivery]') }, [
        ...(source === 'DIRECT' ? [blk('server_side_encryption', { enabled: true, key_type: bufferKms ? 'CUSTOMER_MANAGED_CMK' : 'AWS_OWNED_CMK', ...(bufferKms ? { key_arn: x('data.aws_kms_key.buffer.arn') } : {}) })] : [blk('kinesis_source_configuration', { kinesis_stream_arn: stream, role_arn: role })]),
        blk('extended_s3_configuration', { role_arn: role, bucket_arn: bucketArn, prefix, buffering_size: size, buffering_interval: interval, compression_format: compression, ...(destinationKms ? { kms_key_arn: x('data.aws_kms_key.destination.arn') } : {}) }, [blk('cloudwatch_logging_options', { enabled: true, log_group_name: x('aws_cloudwatch_log_group.delivery.name'), log_stream_name: x('aws_cloudwatch_log_stream.delivery.name') })]),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(roleMatch?.[1] ?? '') + ' && data.aws_iam_role.delivery.arn == ' + JSON.stringify(role) + ' && data.aws_s3_bucket.destination.region == ' + JSON.stringify(region) + (source === 'KINESIS' ? ' && data.aws_kinesis_stream.source.arn == ' + JSON.stringify(stream) : '') + (destinationKms ? ' && data.aws_kms_key.destination.enabled && data.aws_kms_key.destination.key_spec == "SYMMETRIC_DEFAULT"' : '') + (bufferKms ? ' && data.aws_kms_key.buffer.enabled && data.aws_kms_key.buffer.key_spec == "SYMMETRIC_DEFAULT"' : '')), error_message: 'Use this account delivery role, regional bucket/source and enabled symmetric encryption keys.' })]),
      ]),
      output('delivery_stream_arn', 'aws_kinesis_firehose_delivery_stream.configured.arn'),
      output('producer_policy_json', 'jsonencode({ Version = "2012-10-17", Statement = concat(' + hcl(producerStatements) + ', ' + sourceProducerKey + ') })'),
      output('delivery_job', '{ account = data.aws_caller_identity.current.account_id, region = ' + JSON.stringify(region) + ', name = aws_kinesis_firehose_delivery_stream.configured.name, arn = aws_kinesis_firehose_delivery_stream.configured.arn, source = ' + JSON.stringify(source) + ', source_arn = ' + JSON.stringify(stream) + ', bucket_arn = ' + JSON.stringify(bucketArn) + ', prefix = ' + JSON.stringify(prefix) + ' }'),
    ], guide, findings);
    const records = ['example-1', 'example-2'].map(eventId => ({ Data: btoa(JSON.stringify({ eventId, message: 'approved test' }) + '\n'), ...(source === 'KINESIS' ? { PartitionKey: eventId } : {}) }));
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw ("Preflight failed: " + ($Arguments -join " ")) }; return ($raw | ConvertFrom-Json) }',
      "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json')",
      "if ($identity.Account -ne '" + (roleMatch?.[1] ?? '') + "') { throw 'Unexpected deployment account.' }",
      "$bucket = '" + bucket + "'; $region = '" + region + "'; $account = '" + (roleMatch?.[1] ?? '') + "'",
      "$null = Read-AwsJson @('s3api','head-bucket','--bucket',$bucket,'--expected-bucket-owner',$account,'--region',$region,'--output','json')",
      "$public = Read-AwsJson @('s3api','get-public-access-block','--bucket',$bucket,'--expected-bucket-owner',$account,'--region',$region,'--output','json')",
      'foreach ($flag in @("BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets")) { if ($public.PublicAccessBlockConfiguration.$flag -ne $true) { throw "All four bucket public-access blocks are required." } }',
      "$encryption = Read-AwsJson @('s3api','get-bucket-encryption','--bucket',$bucket,'--expected-bucket-owner',$account,'--region',$region,'--output','json')",
      '$rules = @($encryption.ServerSideEncryptionConfiguration.Rules)',
      "if ($rules.Count -ne 1) { throw 'Unexpected bucket default encryption configuration.' }",
      ...(!destinationKms ? ["if ($rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm -ne 'AES256') { throw 'Enter the destination KMS key ARN for this encrypted bucket and regenerate the package.' }"] : []),
      "Write-Host 'Bucket metadata checks passed. Review delivery role trust, key/bucket policies and the Terraform plan before applying.'",
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': preflight, 'EXAMPLE-RECORDS.json': JSON.stringify(records, null, 2) + '\n', 'SEND-EXAMPLE.ps1': firehoseExample.replaceAll('__NAME__', name).replaceAll('__REGION__', region).replaceAll('__ACCOUNT__', roleMatch?.[1] ?? '') } };
  },
} satisfies Blueprint;

const firehoseExample = [
  'param([switch]$Send)',
  "$ErrorActionPreference = 'Stop'",
  "if (-not $Send) { Write-Host 'No records sent. Review EXAMPLE-RECORDS.json and use -Send only with an approved pilot destination/source.'; return }",
  '$jobJson = terraform output -json delivery_job',
  "if ($LASTEXITCODE -ne 0) { throw 'Read the applied delivery_job from this package state.' }",
  '$job = $jobJson | ConvertFrom-Json',
  "if ($job.name -ne '__NAME__' -or $job.region -ne '__REGION__' -or $job.account -ne '__ACCOUNT__') { throw 'Delivery outputs do not match this package.' }",
  'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw ($Arguments[0] + " " + $Arguments[1] + " failed.") }; return ($raw | ConvertFrom-Json) }',
  "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json')",
  "if ($identity.Account -ne $job.account) { throw 'Unexpected producer account.' }",
  "$description = Read-AwsJson @('firehose','describe-delivery-stream','--delivery-stream-name',$job.name,'--region',$job.region,'--output','json')",
  '$stream = $description.DeliveryStreamDescription',
  "$expectedType = if ($job.source -eq 'DIRECT') { 'DirectPut' } elseif ($job.source -eq 'KINESIS') { 'KinesisStreamAsSource' } else { throw 'Unknown source mode.' }",
  "if ($stream.DeliveryStreamStatus -ne 'ACTIVE' -or $stream.DeliveryStreamARN -ne $job.arn -or $stream.DeliveryStreamType -ne $expectedType) { throw 'Unexpected/inactive delivery stream.' }",
  '$destinations = @($stream.Destinations)',
  "if ($destinations.Count -ne 1 -or $destinations[0].ExtendedS3DestinationDescription.BucketARN -ne $job.bucket_arn -or $destinations[0].ExtendedS3DestinationDescription.Prefix -ne $job.prefix) { throw 'Actual S3 destination differs from the reviewed output.' }",
  "if ($job.source -eq 'KINESIS' -and $stream.KinesisStreamSourceDescription.KinesisStreamARN -ne $job.source_arn) { throw 'Actual Kinesis source differs from the reviewed output.' }",
  "$recordPath = Join-Path $PSScriptRoot 'EXAMPLE-RECORDS.json'",
  '$recordData = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json',
  '$records = @($recordData)',
  "if ($records.Count -lt 1 -or $records.Count -gt 500) { throw 'Use 1–500 example records.' }",
  '$totalBytes = 0',
  'foreach ($record in $records) {',
  '  $bytes = [Convert]::FromBase64String($record.Data)',
  "  if ($bytes.Length -lt 1 -or $bytes.Length -gt 1000000) { throw 'Example record must be 1–1,000,000 decoded bytes.' }",
  '  $totalBytes += $bytes.Length',
  "  if ($job.source -eq 'KINESIS' -and (-not $record.PartitionKey -or $record.PartitionKey.Length -gt 256)) { throw 'Kinesis records require a partition key within 256 characters.' }",
  '}',
  "if ($totalBytes -gt 4000000) { throw 'Example batch exceeds the conservative 4,000,000-byte limit.' }",
  "if ($job.source -eq 'DIRECT') {",
  "  $response = Read-AwsJson @('firehose','put-record-batch','--delivery-stream-name',$job.name,'--records',('file://' + $recordPath),'--cli-binary-format','base64','--region',$job.region,'--output','json')",
  '  $failureCount = $response.FailedPutCount; $results = @($response.RequestResponses)',
  '} else {',
  "  $response = Read-AwsJson @('kinesis','put-records','--stream-arn',$job.source_arn,'--records',('file://' + $recordPath),'--cli-binary-format','base64','--region',$job.region,'--output','json')",
  '  $failureCount = $response.FailedRecordCount; $results = @($response.Records)',
  '}',
  "if ($null -eq $failureCount -or $results.Count -ne $records.Count) { throw 'Producer response is incomplete; reconcile acceptance before any retry.' }",
  '$failedIndices = @(); for ($index = 0; $index -lt $results.Count; $index++) { if ($results[$index].ErrorCode) { $failedIndices += $index } }',
  "if ($failedIndices.Count -ne $failureCount) { throw 'Failure count/result mismatch; reconcile acceptance before retry.' }",
  'if ($failureCount -gt 0) {',
  "  ConvertTo-Json -InputObject $failedIndices | Set-Content -LiteralPath failed-record-indices.json -Encoding UTF8",
  "  throw 'Some records were rejected. Inspect failed-record-indices.json; no automatic batch retry was performed.'",
  '}',
  "Write-Host 'Producer accepted every record. This does not confirm S3 arrival or exactly-once delivery; verify the destination independently.'",
].join('\n') + '\n';
