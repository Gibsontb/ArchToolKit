import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_BACKUP_SERVICE = {
  id: 'aws_service_backup', label: 'Set up scheduled AWS Backup protection',
  description: 'Create a protected backup vault, scheduled snapshot plan and explicit resource selection using an existing backup role.',
  emits: ['aws_backup_vault', 'aws_backup_plan', 'aws_backup_selection'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Backup plan and vault name', control: 'text' },
    { id: 'resource_type', label: 'Resource type', control: 'select', default: 'EC2', options: ['EC2', 'EBS', 'EFS', 'RDS', 'DynamoDB', 'S3'].map(value => ({ value, label: value })) },
    { id: 'resources', label: 'Existing resource ARNs', control: 'text', hint: 'Comma-separated exact ARNs for the selected type. No wildcard selection. Regional resources must be in this account and region.' },
    { id: 'role', label: 'Existing AWS Backup IAM role ARN', control: 'text', hint: 'Trust backup.amazonaws.com and grant the required backup, service and KMS permissions for the selected resources.' },
    { id: 'frequency', label: 'Backup frequency', control: 'select', default: 'daily', options: [{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly — Sunday' }, { value: 'monthly', label: 'Monthly — first day' }] },
    { id: 'hour', label: 'Start hour (UTC)', control: 'select', default: '2', options: Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: String(hour).padStart(2, '0') + ':00 UTC' })) },
    { id: 'start_window', label: 'Start window (minutes)', control: 'number', default: 60, min: 60, max: 525600 },
    { id: 'completion_window', label: 'Completion window (minutes)', control: 'number', default: 360, min: 60, max: 525600 },
    { id: 'retention', label: 'Recovery point retention (days)', control: 'number', default: 35, min: 1, max: 36500 },
    { id: 'kms', label: 'Existing vault KMS key ARN', control: 'text', hint: 'Optional symmetric customer-managed key in the selected region. Blank uses the AWS Backup managed key. Source encryption permissions remain required.' },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.backup.' + path, message, { path }));
    const name = String(values.name ?? ''), type = String(values.resource_type ?? ''), location = String(values.aws_region ?? ''), partition = awsServicePartition(location);
    const role = String(values.role ?? ''), kms = String(values.kms ?? '').trim(), frequency = String(values.frequency ?? '');
    const parsedRole = /^arn:([^:]+):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(role);
    if (!/^[A-Za-z0-9_-]{2,50}$/.test(name)) reject('name', 'Use 2–50 letters, numbers, hyphens or underscores.');
    if (!['EC2', 'EBS', 'EFS', 'RDS', 'DynamoDB', 'S3'].includes(type)) reject('resource_type', 'Select a supported resource type.');
    if (!parsedRole || parsedRole[1] !== partition) reject('role', 'Enter an existing backup role ARN in the selected partition.');
    const resources = [...new Set(String(values.resources ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const accounts           = [];
    if (!resources.length || resources.length > 500) reject('resources', 'Enter 1–500 exact resource ARNs.');
    const patterns                         = {
      EC2: /^ec2:[^:]+:\d{12}:instance\/i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/,
      EBS: /^ec2:[^:]+:\d{12}:volume\/vol-(?:[a-f0-9]{8}|[a-f0-9]{17})$/,
      EFS: /^elasticfilesystem:[^:]+:\d{12}:file-system\/fs-(?:[a-f0-9]{8}|[a-f0-9]{17})$/,
      RDS: /^rds:[^:]+:\d{12}:(?:db|cluster):[A-Za-z][A-Za-z0-9-]*$/,
      DynamoDB: /^dynamodb:[^:]+:\d{12}:table\/[A-Za-z0-9_.-]{3,255}$/,
      S3: /^s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    };
    for (const arn of resources) {
      const parts = arn.split(':');
      if (parts[0] !== 'arn' || parts[1] !== partition || !patterns[type]?.test(parts.slice(2).join(':')) || (type !== 'S3' && parts[3] !== location)) reject('resources', 'Every ARN must match the selected resource type, partition and region.');
      if (type !== 'S3' && parts[4]) accounts.push(parts[4]);
    }
    if (!['daily', 'weekly', 'monthly'].includes(frequency)) reject('frequency', 'Select a schedule.');
    const integer = (key        , min        , max        ) => { const value = Number(values[key]); if (values[key] === '' || !Number.isInteger(value) || value < min || value > max) reject(key, 'Enter a whole number from ' + min + ' to ' + max + '.'); return value; };
    const hour = integer('hour', 0, 23), start = integer('start_window', 60, 525600), completion = integer('completion_window', 60, 525600), retention = integer('retention', 1, 36500);
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + location + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a KMS key ARN in the selected partition and region.');
    const schedule = frequency === 'weekly' ? `cron(0 ${hour} ? * SUN *)` : frequency === 'monthly' ? `cron(0 ${hour} 1 * ? *)` : `cron(0 ${hour} * * ? *)`;
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      res('aws_backup_vault', 'configured', { name, force_destroy: false, ...(kms ? { kms_key_arn: kms } : {}) }, [blk('lifecycle', { prevent_destroy: true }, [blk('precondition', {
        condition: x('alltrue([for account in ' + JSON.stringify([parsedRole?.[2] ?? '', ...accounts]) + ' : account == data.aws_caller_identity.current.account_id])'), error_message: 'Use resources and a backup role in the deployment account. Verify S3 bucket ownership independently.',
      })])]),
      res('aws_backup_plan', 'configured', { name }, [blk('rule', { rule_name: 'scheduled', target_vault_name: x('aws_backup_vault.configured.name'), schedule, start_window: start, completion_window: completion }, [blk('lifecycle', { delete_after: retention })])]),
      res('aws_backup_selection', 'configured', { name, iam_role_arn: role, plan_id: x('aws_backup_plan.configured.id'), resources }),
      output('backup_plan_id', 'aws_backup_plan.configured.id'), output('backup_vault_arn', 'aws_backup_vault.configured.arn'),
    ], `# Scheduled AWS Backup protection

## Prepare
Confirm each selected resource supports AWS Backup in this region, is in this account, and is opted in where required. Verify S3 bucket ownership and region explicitly because bucket ARNs contain neither. S3 protection requires versioning and the appropriate backup role permissions. Review RDS/Aurora engine and cluster support. Grant the existing role the service-specific backup and source KMS permissions, and grant the deployer iam:PassRole. Avoid overlapping plans that unintentionally duplicate protection or cost.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review exact resource selection, UTC schedule, completion window, vault encryption and recovery point retention. Apply the saved plan. This creates scheduled backups, not an immediate backup job. Existing recovery points retain their own lifecycle settings when the plan changes. This form does not enable continuous backup, cold storage, copy actions, Vault Lock or cross-account transfer; use their corresponding existing builders after validating requirements.

## Verify
Wait for a scheduled job or start an explicit test backup with the approved role. Check job completion, selected resource coverage, recovery point encryption and expiry in the vault. Restore into an isolated authorized destination using an appropriately scoped restore role. Validate application integrity and record the measured recovery time and recovery point. A successful backup job alone does not prove recovery.

## Recovery
Preserve source resources until a restore has passed validation. Investigate failed jobs, service opt-in, IAM/KMS access and competing maintenance windows. Removing selection stops future scheduled protection; it does not delete existing recovery points. The vault has force_destroy disabled and Terraform prevent_destroy enabled. Retire it only after retention and data-owner requirements are satisfied and an explicit protection change is reviewed.

https://docs.aws.amazon.com/aws-backup/latest/devguide/creating-a-backup-plan.html
https://docs.aws.amazon.com/aws-backup/latest/devguide/assigning-resources.html
`, findings);
  },
}                    ;
