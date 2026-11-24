import { bool } from '../kit/blueprint.js';
import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { validS3BucketName } from './aws-s3-service.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_CONFIG_SERVICE = {
  id: 'aws_service_config', label: 'Set up AWS Config recording and delivery',
  description: 'Create an enabled regional recorder, delivery channel, scoped IAM role and a new private encrypted versioned S3 bucket.',
  emits: ['aws_config_configuration_recorder', 'aws_config_delivery_channel', 'aws_config_configuration_recorder_status', 'aws_iam_role', 'aws_iam_role_policy_attachment', 'aws_iam_role_policy', 'aws_s3_bucket', 'aws_s3_bucket_public_access_block', 'aws_s3_bucket_versioning', 'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Recorder and delivery channel name', control: 'text' },
    { id: 'bucket', label: 'New configuration history bucket name', control: 'text' },
    { id: 'all', label: 'Record all supported regional resource types', control: 'toggle', default: true },
    { id: 'types', label: 'Selected resource types', control: 'text', hint: 'Comma-separated AWS Config type names, for example AWS::EC2::Instance,AWS::S3::Bucket. Confirm support in this region.', showWhen: { input: 'all', equals: ['false'] } },
    { id: 'global', label: 'Include supported global IAM resource types', control: 'toggle', default: false, hint: 'Select only in the designated supported home region to avoid duplicate global recording.' },
    { id: 'frequency', label: 'Configuration snapshot delivery frequency', control: 'select', default: 'TwentyFour_Hours', options: [
      { value: 'One_Hour', label: 'Hourly' }, { value: 'Three_Hours', label: 'Every 3 hours' }, { value: 'Six_Hours', label: 'Every 6 hours' }, { value: 'Twelve_Hours', label: 'Every 12 hours' }, { value: 'TwentyFour_Hours', label: 'Every 24 hours' },
    ] },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.config.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), bucket = String(values.bucket ?? ''), frequency = String(values.frequency ?? '');
    const types = [...new Set(String(values.types ?? '').split(',').map(value => value.trim()).filter(Boolean))], all = bool(values, 'all');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) reject('name', 'Use 1–40 letters, numbers, hyphens or underscores.');
    if (!validS3BucketName(bucket)) reject('bucket', 'Enter a valid unique new S3 bucket name.');
    if (!all && (!types.length || types.length > 100 || types.some(value => !/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(value)))) reject('types', 'Enter 1–100 supported AWS::Service::Resource type names.');
    if (!['One_Hour', 'Three_Hours', 'Six_Hours', 'Twelve_Hours', 'TwentyFour_Hours'].includes(frequency)) reject('frequency', 'Select snapshot delivery frequency.');
    const bucketArn = e('aws_s3_bucket.history.arn'), objectArn = e('"${aws_s3_bucket.history.arn}/config/AWSLogs/${data.aws_caller_identity.current.account_id}/Config/*"');
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      res('aws_s3_bucket', 'history', { bucket, force_destroy: false }, [blk('lifecycle', { prevent_destroy: true })]),
      res('aws_s3_bucket_public_access_block', 'history', { bucket: x('aws_s3_bucket.history.id'), block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
      res('aws_s3_bucket_versioning', 'history', { bucket: x('aws_s3_bucket.history.id') }, [blk('versioning_configuration', { status: 'Enabled' })]),
      res('aws_s3_bucket_server_side_encryption_configuration', 'history', { bucket: x('aws_s3_bucket.history.id') }, [blk('rule', {}, [blk('apply_server_side_encryption_by_default', { sse_algorithm: 'AES256' })])]),
      res('aws_s3_bucket_policy', 'history', { bucket: x('aws_s3_bucket.history.id'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Principal: { Service: 'config.amazonaws.com' }, Action: ['s3:GetBucketAcl', 's3:ListBucket'], Resource: bucketArn, Condition: { StringEquals: { 'AWS:SourceAccount': e('data.aws_caller_identity.current.account_id') } } },
        { Effect: 'Allow', Principal: { Service: 'config.amazonaws.com' }, Action: 's3:PutObject', Resource: objectArn, Condition: { StringEquals: { 'AWS:SourceAccount': e('data.aws_caller_identity.current.account_id'), 's3:x-amz-acl': 'bucket-owner-full-control' } } },
        { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [bucketArn, e('"${aws_s3_bucket.history.arn}/*"')], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
      ] })) }),
      res('aws_iam_role', 'recorder', { name_prefix: name + '-', assume_role_policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'config.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'AWS:SourceAccount': e('data.aws_caller_identity.current.account_id') } } }] })) }),
      res('aws_iam_role_policy_attachment', 'recording', { role: x('aws_iam_role.recorder.name'), policy_arn: 'arn:' + partition + ':iam::aws:policy/service-role/AWS_ConfigRole' }),
      res('aws_iam_role_policy', 'delivery', { role: x('aws_iam_role.recorder.id'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['s3:GetBucketAcl', 's3:ListBucket', 's3:GetBucketLocation'], Resource: bucketArn },
        { Effect: 'Allow', Action: ['s3:PutObject'], Resource: objectArn, Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } } },
      ] })) }),
      res('aws_config_configuration_recorder', 'configured', { name, role_arn: x('aws_iam_role.recorder.arn'), depends_on: x('[aws_iam_role_policy_attachment.recording, aws_iam_role_policy.delivery]') }, [blk('recording_group', { all_supported: all, include_global_resource_types: bool(values, 'global'), ...(!all ? { resource_types: types } : {}) })]),
      res('aws_config_delivery_channel', 'configured', { name, s3_bucket_name: x('aws_s3_bucket.history.id'), s3_key_prefix: 'config', depends_on: x('[aws_config_configuration_recorder.configured, aws_s3_bucket_public_access_block.history, aws_s3_bucket_versioning.history, aws_s3_bucket_server_side_encryption_configuration.history, aws_s3_bucket_policy.history]') }, [blk('snapshot_delivery_properties', { delivery_frequency: frequency })]),
      res('aws_config_configuration_recorder_status', 'configured', { name: x('aws_config_configuration_recorder.configured.name'), is_enabled: true, depends_on: x('[aws_config_delivery_channel.configured]') }),
      output('configuration_bucket', 'aws_s3_bucket.history.id'), output('recorder_name', 'aws_config_configuration_recorder.configured.name'),
    ], `# AWS Config regional recording and delivery

## Prepare
Check for an existing customer-managed recorder and delivery channel in this account/region before deployment. Import and adapt existing resources rather than creating competing ownership. Review the selected resource coverage, regional/global-type availability and recording costs. All-supported recording automatically includes newly supported resource types. Choose a supported designated region for global IAM recording. The deployer needs the appropriate Config, S3, IAM and iam:PassRole permissions.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review resource coverage, the AWS-managed recording policy, bucket-scoped delivery permissions, storage and snapshot delivery frequency. Apply the saved plan. Recording is continuous and enabled after the delivery channel is configured. Snapshot delivery frequency controls snapshots, not resource-change recording frequency. The bucket is encrypted, private and versioned; no automatic expiration is added.

## Verify
Check recorder and delivery-channel status for recording/delivery failures. Make an approved test change to a selected resource and confirm its configuration item and history. Confirm snapshots and history arrive beneath config/AWSLogs in the bucket. Verify expected coverage, excluded types, delivery timing and authorized evidence access. This configures inventory/history, not Config rules, conformance packs, remediation or an ATO/compliance determination.

## Recovery
Retain the preceding evidence path during cutover. Correct recording permissions, unsupported types or bucket delivery errors and verify the affected interval. Stopping or deleting a recorder causes a recording gap that cannot be reconstructed automatically. Preserve S3 history according to the approved retention policy. Bucket force deletion is disabled and Terraform prevent_destroy requires an explicit reviewed retirement change. Organization aggregation, managed rules, conformance packs and remediation use their corresponding existing builders.

https://docs.aws.amazon.com/config/latest/developerguide/gs-console.html
`, findings);
  },
}                    ;
