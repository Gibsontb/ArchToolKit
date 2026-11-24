import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_KINESIS_SERVICE = {
  id: 'aws_service_kinesis', label: 'Set up an encrypted Kinesis data stream',
  description: 'Create an on-demand or provisioned stream with explicit retention, encryption and optional enhanced fan-out consumer registration.',
  emits: ['aws_kinesis_stream', 'aws_kinesis_stream_consumer'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Stream name', control: 'text' },
    { id: 'mode', label: 'Capacity mode', control: 'select', default: 'ON_DEMAND', options: [{ value: 'ON_DEMAND', label: 'On-demand' }, { value: 'PROVISIONED', label: 'Provisioned shards' }] },
    { id: 'shards', label: 'Provisioned shards', control: 'number', default: 1, min: 1, showWhen: { input: 'mode', equals: ['PROVISIONED'] } },
    { id: 'retention', label: 'Record retention (hours)', control: 'number', default: 24, min: 24, max: 8760, hint: 'Longer retention has additional charges. Align replay and data-retention requirements.' },
    { id: 'kms', label: 'Existing KMS key ARN', control: 'text', hint: 'Optional regional symmetric key. Blank uses the AWS-managed Kinesis key. Producers and consumers need applicable encryption permissions.' },
    { id: 'consumer', label: 'Enhanced fan-out consumer name', control: 'text', hint: 'Optional. Registers a dedicated-throughput consumer; application code and IAM permissions are configured separately.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.kinesis.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), mode = String(values.mode ?? ''), kms = String(values.kms ?? '').trim(), consumer = String(values.consumer ?? '').trim();
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) reject('name', 'Use 1–128 letters, numbers, dots, hyphens or underscores.');
    if (!['ON_DEMAND', 'PROVISIONED'].includes(mode)) reject('mode', 'Select a stream capacity mode.');
    const shards = Number(values.shards), retention = Number(values.retention);
    if (mode === 'PROVISIONED' && (!Number.isSafeInteger(shards) || shards < 1 || shards > 100000)) reject('shards', 'Enter 1–100,000 shards and confirm the regional shard quota.');
    if (!Number.isInteger(retention) || retention < 24 || retention > 8760) reject('retention', 'Enter a retention period from 24–8760 hours.');
    if (consumer && !/^[A-Za-z0-9_.-]{1,128}$/.test(consumer)) reject('consumer', 'Use a consumer name of 1–128 letters, numbers, dots, hyphens or underscores.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + location + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a KMS key ARN in the selected region and partition.');
    return awsServiceModule(location, [
      res('aws_kinesis_stream', 'configured', { name, ...(mode === 'PROVISIONED' ? { shard_count: shards } : {}), retention_period: retention, encryption_type: 'KMS', kms_key_id: kms || 'alias/aws/kinesis', enforce_consumer_deletion: false }, [blk('stream_mode_details', { stream_mode: mode }), blk('lifecycle', { prevent_destroy: true })]),
      ...(consumer ? [res('aws_kinesis_stream_consumer', 'configured', { name: consumer, stream_arn: x('aws_kinesis_stream.configured.arn') })] : []),
      output('stream_arn', 'aws_kinesis_stream.configured.arn'),
      ...(consumer ? [output('consumer_arn', 'aws_kinesis_stream_consumer.configured.arn')] : []),
    ], `# Encrypted Kinesis Data Streams

## Prepare
Estimate producer throughput, partition-key distribution, consumer count and replay window. Confirm regional on-demand/provisioned capacity, scaling limits, consumer quotas and retention charges. Prepare producer/consumer IAM and KMS access. On-demand capacity still has limits; a hot partition key can cause throttling. Enhanced fan-out registration does not create or run a consumer application.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review capacity mode, shard count when provisioned, retention, KMS key and optional fan-out consumer. Apply the saved plan. The stream is encrypted with KMS. Changes to capacity mode or shard count must respect the service's mode-switching and resharding limits.

## Verify
Wait for the stream and optional consumer to become ACTIVE. Send representative records with the intended producer identity. Read them through the intended consumer path and validate ordering per partition key, checkpointing, retries and duplicate handling. Exercise a restart and replay from retained records. Monitor write/read throttling, incoming bytes/records, iterator age and consumer lag. Verify unauthorized identities cannot read or write.

## Recovery
Correct producer throttling or consumer failures before replaying from a known checkpoint. Retention is a replay window, not a permanent archive; decreasing it can make older records unavailable. Preserve records externally when required. The stream has Terraform prevent_destroy and does not force-delete registered consumers. Review consumer ownership and data disposition before retirement. Firehose delivery, Lambda event-source mappings and application consumer code use their corresponding builders.

https://docs.aws.amazon.com/streams/latest/dev/key-concepts.html
`, findings);
  },
} satisfies Blueprint;
