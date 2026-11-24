import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
import { awsDataSyncTask } from './aws-datasync-task.js';

export const AWS_DATASYNC_SERVICE = {
  id: 'aws_service_datasync_s3', label: 'Set up an S3-to-S3 DataSync transfer',
  description: 'Configure two existing regional buckets, prefix-scoped access prerequisites, a Basic-mode transfer task, integrity verification and logs.',
  emits: ['aws_datasync_location_s3', 'aws_datasync_task', 'aws_cloudwatch_log_group', 'aws_cloudwatch_log_resource_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Transfer task name', control: 'text' },
    ...(['source', 'destination']         ).flatMap(side => [
      { id: side + '_bucket', label: (side === 'source' ? 'Source' : 'Destination') + ' S3 bucket', control: 'text'         , hint: 'Existing bucket in the selected region; this path uses separate source and destination buckets.' },
      { id: side + '_prefix', label: (side === 'source' ? 'Source' : 'Destination') + ' prefix', control: 'text'         , default: '/', hint: 'Use / for the entire bucket, or /prefix/ for a scoped transfer. No wildcard or dot segments.' },
      { id: side + '_role', label: (side === 'source' ? 'Source' : 'Destination') + ' bucket access role ARN', control: 'text'         , hint: 'Existing IAM role in the deployment account, trusted by DataSync. Review the generated access-policy example and bucket/KMS permissions.' },
    ]),
    { id: 'overwrite', label: 'Existing destination objects', control: 'select', default: 'NEVER', options: [{ value: 'NEVER', label: 'Preserve existing objects' }, { value: 'ALWAYS', label: 'Overwrite changed objects' }] },
    { id: 'tags', label: 'Object tags', control: 'select', default: 'PRESERVE', options: [{ value: 'PRESERVE', label: 'Copy object tags' }, { value: 'NONE', label: 'Do not copy object tags' }] },
    { id: 'bandwidth', label: 'Bandwidth limit (MB/second)', control: 'number', default: 0, hint: 'Decimal MB/s. Zero means unlimited. DataSync and S3 request/transfer charges still apply.' },
    { id: 'logging', label: 'Transfer logging', control: 'select', default: 'BASIC', options: [{ value: 'BASIC', label: 'Basic — status and errors' }, { value: 'TRANSFER', label: 'Detailed object transfer and verification' }] },
    { id: 'retention', label: 'Log retention (days)', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.datasync.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,119}$/.test(name)) reject('name', 'Use 2–120 letters, numbers, dots, underscores or hyphens.');
    const locations = (['source', 'destination']         ).map(side => {
      const bucket = String(values[side + '_bucket'] ?? '').trim(), prefix = String(values[side + '_prefix'] ?? '').trim(), role = String(values[side + '_role'] ?? '').trim();
      if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject(side + '_bucket', 'Enter the existing bucket name.');
      if (!prefix.startsWith('/') || !prefix.endsWith('/') || /[\x00-\x1f*?\\]/.test(prefix) || prefix.includes('//') || prefix.split('/').some(part => part === '.' || part === '..') || new TextEncoder().encode(prefix).length > 1024) reject(side + '_prefix', 'Use / or /prefix/ without wildcard characters, repeated slashes or dot segments, within 1024 UTF-8 bytes.');
      const parsed = /^arn:([^:]+):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(role);
      if (!parsed || parsed[1] !== partition) reject(side + '_role', 'Enter an existing bucket-access IAM role ARN in the selected partition.');
      return { side, bucket, prefix, role, account: parsed?.[2] ?? '' };
    });
    if (locations[0] .bucket === locations[1] .bucket) reject('destination_bucket', 'Use a separate destination bucket to prevent overlapping source and destination paths.');
    const bandwidth = Number(values.bandwidth), bytes = bandwidth === 0 ? -1 : Math.round(bandwidth * 1e6), overwrite = String(values.overwrite ?? ''), tags = String(values.tags ?? ''), logging = String(values.logging ?? ''), retention = Number(values.retention);
    if (!Number.isFinite(bandwidth) || bandwidth < 0 || !Number.isSafeInteger(bytes) || bytes === 0) reject('bandwidth', 'Use zero for unlimited or a positive finite MB/second limit of at least one byte per second.');
    if (!['NEVER', 'ALWAYS'].includes(overwrite)) reject('overwrite', 'Select destination overwrite behavior.');
    if (!['PRESERVE', 'NONE'].includes(tags)) reject('tags', 'Choose object tag handling.');
    if (!['BASIC', 'TRANSFER'].includes(logging)) reject('logging', 'Choose a log detail level.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Choose log retention.');
    const result = awsServiceModule(region, [
      ...locations.map(location => dat('aws_s3_bucket', location.side, { bucket: location.bucket })),
      ...locations.map(location => res('aws_datasync_location_s3', location.side, { s3_bucket_arn: x('data.aws_s3_bucket.' + location.side + '.arn'), subdirectory: location.prefix, ...(location.side === 'destination' ? { s3_storage_class: 'STANDARD' } : {}) }, [blk('s3_config', { bucket_access_role_arn: location.role }), blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_s3_bucket.' + location.side + '.region == ' + JSON.stringify(region) + ' && data.aws_caller_identity.current.account_id == ' + JSON.stringify(location.account)), error_message: 'Each bucket must be in the selected region and each access role must belong to the deployment account.' })])])),
      ...awsDataSyncTask(region, name, 'aws_datasync_location_s3.source.arn', 'aws_datasync_location_s3.destination.arn', retention, { bytes_per_second: bytes, log_level: logging, overwrite_mode: overwrite, object_tags: tags }),
    ], `# S3-to-S3 DataSync transfer

## Prepare
Prepare separate existing regional source and destination buckets, versioning/backups and approved transfer boundaries. Existing access roles in the deployment account must trust datasync.amazonaws.com with account/source-ARN restrictions. Review SOURCE-ACCESS.json and DESTINATION-ACCESS.json with their owners; these are scoped IAM policy examples, not automatically attached policies. Cross-account buckets need corresponding bucket policies. Source/destination customer-managed KMS keys separately need scoped IAM and key-policy permissions for decrypt/encrypt/data keys as applicable; this package does not infer those keys. Review S3 Object Lock, storage-class restore requirements, object ownership, quotas, DataSync/S3 charges and CloudWatch resource-policy quotas.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Confirm source/destination direction, prefixes, access roles, overwrite and tag behavior. Apply the reviewed saved plan. This creates Basic-mode locations and a transfer task without starting a transfer or scheduling one. Run terraform output -raw task_arn and use aws datasync start-task-execution --task-arn <task-arn> --region ${region} only after the transfer is approved. Record the returned execution ARN. No DataSync agent is required for this S3-to-S3 path.

## Verify
Run aws datasync describe-task-execution --task-execution-arn <execution-arn> --region ${region}. Check status, counts, bytes, errors and verification results. Review CloudWatch logs. Reconcile source and destination object counts, sizes, selected checksums, metadata and application readability; this task verifies only files transferred. Deleted source objects are retained at the destination. Preserve-existing mode skips destination objects even when source data changes; overwrite mode replaces changed objects, so destination versioning and a recovery plan matter. The task transfers current eligible objects; it does not reproduce S3 version history, bucket policies, lifecycle rules or every storage service attribute.

## Recovery
Cancel with aws datasync cancel-task-execution --task-execution-arn <execution-arn> --region ${region}. Cancellation does not undo completed writes. Recover overwritten objects from destination versions/backups and reconcile partial transfers before retrying. Preserve task logs and completion evidence. Removing the Terraform task/locations does not remove bucket data. On-premises NFS/SMB, FSx/EFS, cross-region and enhanced-mode configurations remain separate existing builders.

https://docs.aws.amazon.com/datasync/latest/userguide/configure-logging.html
`, findings);
    const files                         = { ...result.files };
    for (const location of locations) {
      const arn = 'arn:' + partition + ':s3:::' + location.bucket, prefix = location.prefix.slice(1);
      files[location.side.toUpperCase() + '-ACCESS.json'] = JSON.stringify({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: arn },
        { Effect: 'Allow', Action: ['s3:ListBucket', 's3:ListBucketMultipartUploads'], Resource: arn, ...(prefix ? { Condition: { StringLike: { 's3:prefix': [prefix.slice(0, -1), prefix + '*'] } } } : {}) },
        { Effect: 'Allow', Action: location.side === 'source' ? ['s3:GetObject', 's3:GetObjectTagging', 's3:GetObjectVersion', 's3:GetObjectVersionTagging'] : ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts', ...(tags === 'PRESERVE' ? ['s3:GetObjectTagging', 's3:PutObjectTagging'] : [])], Resource: arn + '/' + prefix + '*' },
      ] }, null, 2) + '\n';
    }
    return { ...result, files };
  },
}                    ;
