import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { validS3BucketName } from './aws-s3-service.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_CLOUDTRAIL_SERVICE = {
  id: 'aws_service_cloudtrail', label: 'Set up a management-event audit trail',
  description: 'Create an account trail with integrity validation and a new encrypted, versioned, private S3 log bucket.',
  emits: ['aws_cloudtrail', 'aws_s3_bucket', 'aws_s3_bucket_public_access_block', 'aws_s3_bucket_versioning', 'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Trail name', control: 'text' },
    { id: 'bucket', label: 'New log bucket name', control: 'text', hint: 'A unique new S3 general-purpose bucket in the selected region. Logs are written below audit/.' },
    { id: 'multi_region', label: 'Record events across all enabled regions', control: 'toggle', default: true },
    { id: 'events', label: 'Management events', control: 'select', default: 'All', options: [{ value: 'All', label: 'Read and write' }, { value: 'WriteOnly', label: 'Write only' }, { value: 'ReadOnly', label: 'Read only' }] },
    { id: 'logging', label: 'Enable event logging', control: 'toggle', default: true },
    { id: 'kms', label: 'Existing log encryption KMS key ARN', control: 'text', hint: 'Optional symmetric customer-managed key in the trail region. Its policy must authorize this trail and approved log readers. Blank uses S3-managed encryption.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.cloudtrail.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), bucket = String(values.bucket ?? ''), events = String(values.events ?? ''), kms = String(values.kms ?? '').trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,126}[A-Za-z0-9])$/.test(name) || /^\d+\.\d+\.\d+\.\d+$/.test(name)) reject('name', 'Use 3–128 letters, numbers, dots, hyphens or underscores, with alphanumeric ends and no IP-address name.');
    if (!validS3BucketName(bucket)) reject('bucket', 'Enter a valid unique new S3 bucket name.');
    if (!['All', 'WriteOnly', 'ReadOnly'].includes(events)) reject('events', 'Select management-event coverage.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + location + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a KMS key ARN in the selected region and partition.');
    const trailArn = '"arn:' + partition + ':cloudtrail:' + location + ':${data.aws_caller_identity.current.account_id}:trail/' + name + '"';
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      res('aws_s3_bucket', 'audit', { bucket, force_destroy: false }, [blk('lifecycle', { prevent_destroy: true })]),
      res('aws_s3_bucket_public_access_block', 'audit', { bucket: x('aws_s3_bucket.audit.id'), block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
      res('aws_s3_bucket_versioning', 'audit', { bucket: x('aws_s3_bucket.audit.id') }, [blk('versioning_configuration', { status: 'Enabled' })]),
      res('aws_s3_bucket_server_side_encryption_configuration', 'audit', { bucket: x('aws_s3_bucket.audit.id') }, [blk('rule', {}, [blk('apply_server_side_encryption_by_default', kms ? { sse_algorithm: 'aws:kms', kms_master_key_id: kms } : { sse_algorithm: 'AES256' })])]),
      res('aws_s3_bucket_policy', 'audit', {
        bucket: x('aws_s3_bucket.audit.id'),
        policy: x(jsonencode({ Version: '2012-10-17', Statement: [
          { Sid: 'TrailAclCheck', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:GetBucketAcl', Resource: e('aws_s3_bucket.audit.arn'), Condition: { StringEquals: { 'aws:SourceArn': e(trailArn) } } },
          { Sid: 'TrailLogDelivery', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:PutObject', Resource: e('"${aws_s3_bucket.audit.arn}/audit/AWSLogs/${data.aws_caller_identity.current.account_id}/*"'), Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceArn': e(trailArn) } } },
          { Sid: 'RequireTls', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [e('aws_s3_bucket.audit.arn'), e('"${aws_s3_bucket.audit.arn}/*"')], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
        ] })),
      }),
      res('aws_cloudtrail', 'configured', {
        name, s3_bucket_name: x('aws_s3_bucket.audit.id'), s3_key_prefix: 'audit', enable_logging: bool(values, 'logging'),
        is_multi_region_trail: bool(values, 'multi_region'), include_global_service_events: true, enable_log_file_validation: true, ...(kms ? { kms_key_id: kms } : {}),
        depends_on: x('[aws_s3_bucket_policy.audit, aws_s3_bucket_versioning.audit, aws_s3_bucket_public_access_block.audit, aws_s3_bucket_server_side_encryption_configuration.audit]'),
      }, [blk('event_selector', { read_write_type: events, include_management_events: true })]),
      output('trail_arn', 'aws_cloudtrail.configured.arn'), output('log_bucket', 'aws_s3_bucket.audit.id'),
    ], `# Account management-event audit trail

## Prepare
Review existing account and organization trails to avoid duplicate charges and unintended audit gaps. Confirm the intended home region, management-event coverage and storage boundary. This form records management events, including global-service events; it does not configure resource data events, Insights or CloudTrail Lake. If selecting a KMS key, authorize cloudtrail.amazonaws.com to generate data keys for this trail with the correct source ARN/encryption context, and authorize approved log readers to decrypt. Review that existing key policy independently.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the new log bucket, trail-scoped write policy, TLS enforcement, encryption and event selection. Apply the saved plan. Bucket versioning and log integrity validation are enabled. No lifecycle expiration is created; apply approved retention and archival requirements separately. This is an account trail, not an organization trail or an authorization decision.

## Verify
Use CloudTrail get-trail-status and inspect delivery errors. Trigger a known management action and confirm the expected event and digest files appear beneath audit/AWSLogs in the bucket. Use cloudtrail validate-logs for the appropriate time range and confirm an authorized reader can decrypt if using KMS. Monitor delivery failures, unexpected logging stops and bucket/key policy changes. Validate retention and recovery requirements before relying on the trail for evidence.

## Recovery
Keep the preceding audit path active through cutover. Correct S3 or KMS policy errors promptly and verify delivery resumes; inspect the affected time range for gaps. Disabling the logging option stops new delivery. Deleting a trail does not recover missing events. The bucket blocks force deletion and has Terraform prevent_destroy; preserve its evidence and meet retention requirements before a reviewed retirement.

https://docs.aws.amazon.com/awscloudtrail/latest/userguide/create-s3-bucket-policy-for-cloudtrail.html
`, findings);
  },
} satisfies Blueprint;
