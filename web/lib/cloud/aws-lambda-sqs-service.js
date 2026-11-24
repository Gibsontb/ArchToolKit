import { bool } from '../kit/blueprint.js';
import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_LAMBDA_SQS_SERVICE = {
  id: 'aws_service_lambda_sqs', label: 'Connect an SQS queue to an existing Lambda function',
  description: 'Configure queue polling, batch behavior, concurrency and queue-scoped execution-role permissions for an existing function.',
  emits: ['aws_iam_role_policy', 'aws_lambda_event_source_mapping'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Integration policy name', control: 'text' },
    { id: 'function_name', label: 'Existing Lambda function name', control: 'text' },
    { id: 'queue', label: 'Existing SQS queue ARN', control: 'text' },
    { id: 'batch', label: 'Maximum batch messages', control: 'number', default: 10, min: 1, max: 10000 },
    { id: 'window', label: 'Batch window (seconds)', control: 'number', default: 0, min: 0, max: 300 },
    { id: 'concurrency', label: 'Maximum concurrent invocations', control: 'number', min: 2, max: 1000, hint: 'Optional. Confirm function reserved concurrency and regional event-source quotas.' },
    { id: 'partial', label: 'Handler returns partial batch failures', control: 'toggle', default: false, hint: 'Enable only after the handler implements the ReportBatchItemFailures response contract.' },
    { id: 'enabled', label: 'Enable queue processing', control: 'toggle', default: true },
    { id: 'kms', label: 'Existing queue customer KMS key ARN', control: 'text', hint: 'Required if this queue uses a customer-managed KMS key. Its existing key policy must permit the function execution role.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.lambda-sqs.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), fn = String(values.function_name ?? ''), queue = String(values.queue ?? '').trim(), kms = String(values.kms ?? '').trim();
    const parsed = /^arn:([^:]+):sqs:([^:]+):(\d{12}):([A-Za-z0-9_-]+(?:\.fifo)?)$/.exec(queue), fifo = parsed?.[4]?.endsWith('.fifo') === true;
    if (!/^[A-Za-z0-9_+=,.@-]{1,100}$/.test(name)) reject('name', 'Use 1–100 IAM policy-name characters.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(fn)) reject('function_name', 'Enter an existing Lambda function name.');
    if (!parsed || parsed[1] !== partition || parsed[2] !== location || (parsed?.[4]?.length ?? 0) > 80) reject('queue', 'Use an SQS queue ARN in the selected region and partition.');
    const batch = Number(values.batch), window = Number(values.window);
    if (!Number.isInteger(batch) || batch < 1 || batch > (fifo ? 10 : 10000)) reject('batch', fifo ? 'FIFO queues support batches of 1–10 messages.' : 'Enter 1–10,000 messages.');
    if (values.window === '' || !Number.isInteger(window) || window < 0 || window > 300 || (fifo && window !== 0)) reject('window', fifo ? 'FIFO processing requires a zero batch window.' : 'Enter 0–300 seconds.');
    if (!fifo && batch > 10 && window < 1) reject('window', 'Batches above ten messages require a window of at least one second.');
    const hasConcurrency = values.concurrency !== undefined && values.concurrency !== '', concurrency = Number(values.concurrency);
    if (hasConcurrency && (!Number.isInteger(concurrency) || concurrency < 2 || concurrency > 1000)) reject('concurrency', 'Enter 2–1000 concurrent invocations or leave blank.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + location + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a queue encryption key ARN in the selected partition and region.');
    const result = awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}), dat('aws_lambda_function', 'selected', { function_name: fn }), dat('aws_sqs_queue', 'selected', { name: parsed?.[4] ?? '' }),
      res('aws_iam_role_policy', 'queue', { name, role: x('element(reverse(split("/", data.aws_lambda_function.selected.role)), 0)'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'], Resource: queue },
        ...(kms ? [{ Effect: 'Allow', Action: 'kms:Decrypt', Resource: kms }] : []),
      ] })) }),
      res('aws_lambda_event_source_mapping', 'configured', {
        function_name: x('data.aws_lambda_function.selected.arn'), event_source_arn: x('data.aws_sqs_queue.selected.arn'), batch_size: batch,
        ...(!fifo ? { maximum_batching_window_in_seconds: window } : {}), enabled: bool(values, 'enabled'),
        function_response_types: bool(values, 'partial') ? ['ReportBatchItemFailures'] : [], depends_on: x('[aws_iam_role_policy.queue]'),
      }, [
        ...(hasConcurrency ? [blk('scaling_config', { maximum_concurrency: concurrency })] : []),
        blk('lifecycle', {}, [
          blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsed?.[3] ?? '')), error_message: 'This integration supports a queue and function in the deployment account.' }),
        ]),
      ]),
      output('event_source_mapping_id', 'aws_lambda_event_source_mapping.configured.uuid'),
    ], `# SQS-triggered Lambda processing

## Prepare
Confirm the existing function implements the SQS event contract, handles duplicates idempotently and can process the selected batch within its timeout. Configure the queue's visibility timeout for at least six times the function timeout plus the batch window, and review its redrive policy/DLQ. The template adds a queue-scoped inline policy to the function's existing execution role; review that role's other consumers before applying. For a customer-managed queue key, supply its ARN and authorize the role in the key policy. VPC-attached functions also need their required service connectivity.

## Implement
Run the exported PREFLIGHT.ps1 to check the real queue visibility timeout and KMS metadata against the existing function. The provider's queue data source does not expose these attributes, so they are checked through read-only AWS CLI calls. Then run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the existing role policy change, queue/function identities, batch and concurrency settings. Applying with processing enabled can immediately consume and delete successfully processed messages. Disable the processing option for a staged setup. Allow IAM changes to propagate before retrying a failed mapping creation.

## Verify
Send controlled test messages, confirm expected application side effects, and inspect Lambda errors, duration, concurrency, queue age and DLQ behavior. Test duplicates, poison messages, timeout and recovery. Enable ReportBatchItemFailures only when the handler returns the required per-message failure identifiers. For FIFO, preserve ordering and stop processing after the first relevant failure. Maximum concurrency must fit the function's reserved concurrency and account quota.

## Recovery
Disable the mapping to pause polling while retaining queued messages. Correct the handler or permissions, then resume and redrive failed messages only after validating idempotency. Disabling polling does not undo messages already processed or restore expired/deleted messages. Preserve the queue's retention and recovery evidence. Cross-account queues, aliases/versions, event filtering and other stream sources use their corresponding existing builders.

https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
`, findings);
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': `$ErrorActionPreference = 'Stop'
$queueUrl = aws sqs get-queue-url --queue-name '${parsed?.[4] ?? ''}' --queue-owner-aws-account-id '${parsed?.[3] ?? ''}' --region '${location}' --query QueueUrl --output text
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the source queue.' }
$response = aws sqs get-queue-attributes --queue-url $queueUrl --attribute-names VisibilityTimeout KmsMasterKeyId --region '${location}'
if ($LASTEXITCODE -ne 0) { throw 'Could not read queue attributes.' }
$attributes = ($response | ConvertFrom-Json).Attributes
$timeout = aws lambda get-function-configuration --function-name '${fn}' --region '${location}' --query Timeout --output text
if ($LASTEXITCODE -ne 0) { throw 'Could not read function timeout.' }
if ([int]$attributes.VisibilityTimeout -lt [int]$timeout) { throw 'Queue visibility timeout is below the function timeout.' }
if ([int]$attributes.VisibilityTimeout -lt (6 * [int]$timeout + ${window})) { Write-Warning 'Increase queue visibility to at least six times the function timeout plus the batch window.' }
if ($attributes.KmsMasterKeyId) {
  $response = aws kms describe-key --key-id $attributes.KmsMasterKeyId --region '${location}'
  if ($LASTEXITCODE -ne 0) { throw 'Could not verify the queue encryption key.' }
  $key = ($response | ConvertFrom-Json).KeyMetadata
  if ($key.KeyManager -eq 'CUSTOMER' -and $key.Arn -ne '${kms}') { throw 'Set the form KMS key ARN to the queue customer-managed key and regenerate.' }
}
Write-Host 'Queue timeout and encryption preflight passed. Review IAM, key policy, DLQ and handler behavior before applying.'
` } };
  },
}                    ;
