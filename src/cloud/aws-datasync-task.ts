import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServicePartition } from './aws-service-module.ts';

/** Shared Basic task/log resources; callers own their location prerequisites and runbooks. */
export function awsDataSyncTask(region: string, name: string, source: string, destination: string, retention: number, options: Record<string, string | number | boolean>) {
  const partition = awsServicePartition(region);
  return [
    dat('aws_caller_identity', 'current', {}),
    res('aws_cloudwatch_log_group', 'transfer', { name: '/aws/datasync/' + name, retention_in_days: retention }),
    res('aws_cloudwatch_log_resource_policy', 'transfer', { policy_name: name + '-datasync', policy_document: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'datasync.amazonaws.com' }, Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: e('"${aws_cloudwatch_log_group.transfer.arn}:*"'), Condition: { StringEquals: { 'aws:SourceAccount': e('data.aws_caller_identity.current.account_id') }, ArnLike: { 'aws:SourceArn': e('"arn:' + partition + ':datasync:' + region + ':${data.aws_caller_identity.current.account_id}:task/*"') } } }] })) }),
    res('aws_datasync_task', 'configured', { name, task_mode: 'BASIC', source_location_arn: x(source), destination_location_arn: x(destination), cloudwatch_log_group_arn: x('aws_cloudwatch_log_group.transfer.arn'), depends_on: x('[aws_cloudwatch_log_resource_policy.transfer]') }, [blk('options', { ...options, preserve_deleted_files: 'PRESERVE', transfer_mode: 'CHANGED', verify_mode: 'ONLY_FILES_TRANSFERRED', task_queueing: 'DISABLED' })]),
    output('task_arn', 'aws_datasync_task.configured.arn'),
  ];
}
