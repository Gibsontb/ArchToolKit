import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { quote } from '../terraform/hcl.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

const idSuffix = '(?:[0-9a-f]{8}|[0-9a-f]{17})';
const subnetPattern = new RegExp('^subnet-' + idSuffix + '$');
const groupPattern = new RegExp('^sg-' + idSuffix + '$');

export const AWS_EFS_SERVICE = {
  id: 'aws_service_efs',
  label: 'Set up an encrypted Regional EFS file system',
  description: 'Create a Regional file system with IPv4 mount targets, backup policy and optional customer-managed encryption.',
  emits: ['aws_efs_file_system', 'aws_efs_mount_target', 'aws_efs_backup_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'File system name', control: 'text' },
    { id: 'subnets', label: 'Existing subnet IDs', control: 'text', hint: 'Comma-separated IPv4-capable subnets in one VPC, at most one subnet per Availability Zone.' },
    { id: 'groups', label: 'Existing mount-target security group IDs', control: 'text', hint: 'Comma-separated groups in the same VPC. Allow TCP 2049 from the approved client security groups.' },
    { id: 'throughput', label: 'Throughput mode', control: 'select', default: 'bursting', options: [
      { value: 'bursting', label: 'Bursting' }, { value: 'provisioned', label: 'Provisioned' },
    ] },
    { id: 'mibps', label: 'Provisioned throughput (MiB/s)', control: 'number', min: 1, default: 1, showWhen: { input: 'throughput', equals: ['provisioned'] } },
    { id: 'kms', label: 'Existing KMS key ARN', control: 'text', hint: 'Optional customer-managed key in the selected region. Leave blank for the EFS managed key.' },
    { id: 'backups', label: 'Automatic backups', control: 'toggle', default: true },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.efs.' + path, message, { path }));
    const location = String(values.aws_region ?? '');
    const name = String(values.name ?? '').trim();
    const kms = String(values.kms ?? '').trim();
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets');
    const groups = list('groups');
    const throughput = String(values.throughput ?? '');
    const provisioned = throughput === 'provisioned';
    const mibps = Number(values.mibps);
    if (!name || name.length > 256 || /[\r\n]/.test(name)) reject('name', 'Enter a file system name up to 256 characters.');
    if (!subnets.length || subnets.some(value => !subnetPattern.test(value))) reject('subnets', 'Enter valid existing subnet IDs.');
    if (!groups.length || groups.length > 5 || groups.some(value => !groupPattern.test(value))) reject('groups', 'Enter 1–5 valid existing security group IDs.');
    if (!['bursting', 'provisioned'].includes(throughput)) reject('throughput', 'Select a throughput mode.');
    if (provisioned && (!Number.isFinite(mibps) || mibps < 1)) reject('mibps', 'Enter at least 1 MiB/s and confirm the regional throughput quota.');
    if (kms) {
      const parsed = /^arn:([^:]+):kms:([^:]+):\d{12}:key\/[A-Za-z0-9-]+$/.exec(kms);
      if (parsed?.[1] !== awsServicePartition(location) || parsed?.[2] !== location) reject('kms', 'Enter a KMS key ARN in the selected partition and region.');
    }
    return awsServiceModule(location, [
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_efs_file_system', 'configured', {
        encrypted: true, performance_mode: 'generalPurpose', throughput_mode: throughput,
        ...(provisioned ? { provisioned_throughput_in_mibps: mibps } : {}),
        ...(kms ? { kms_key_id: kms } : {}), tags: x('{ Name = ' + quote(name) + ' }'),
      }, [
        blk('lifecycle', { prevent_destroy: true }, [
          blk('precondition', {
            condition: x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.selected : group.vpc_id]))) == 1'),
            error_message: 'All selected subnets and security groups must belong to one VPC.',
          }),
          blk('precondition', {
            condition: x('length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) == length(data.aws_subnet.selected)'),
            error_message: 'Select at most one subnet in each Availability Zone.',
          }),
          blk('precondition', {
            condition: x('alltrue([for subnet in data.aws_subnet.selected : !subnet.ipv6_native])'),
            error_message: 'This form uses IPv4 mount targets. Select IPv4-capable subnets.',
          }),
        ]),
      ]),
      res('aws_efs_mount_target', 'configured', {
        for_each: x('data.aws_subnet.selected'),
        file_system_id: x('aws_efs_file_system.configured.id'), subnet_id: x('each.value.id'), security_groups: groups,
      }),
      res('aws_efs_backup_policy', 'configured', { file_system_id: x('aws_efs_file_system.configured.id') }, [
        blk('backup_policy', { status: bool(values, 'backups') ? 'ENABLED' : 'DISABLED' }),
      ]),
      output('file_system_id', 'aws_efs_file_system.configured.id'),
      output('mount_target_ids', '[for target in aws_efs_mount_target.configured : target.id]'),
    ], `# Regional EFS setup

## Prepare
Select one IPv4-capable subnet per required Availability Zone in one VPC. Verify DNS support, available IPs, and routing. The mount-target security groups need inbound TCP 2049 from approved clients. Check client outbound rules. If using a customer-managed KMS key, verify its region, state and key policy permissions. Confirm EFS quotas and regional availability.

## Implement
Run terraform init, terraform validate, and terraform plan -out=service.tfplan. Review the AWS account, region, encryption key, backup policy and network targets. Apply the saved plan. This form creates Regional General Purpose storage with Bursting or Provisioned throughput. Provisioned mode incurs throughput charges. It uses existing network security rules.

## Verify
Wait for file system and mount targets to report available. Install the supported amazon-efs-utils package on an authorized Linux client. Use the file_system_id output with the documented mount helper and TLS option. Verify the mount, POSIX ownership, test read/write access and application behavior. Verify backup jobs and perform an isolated restore test.

## Recovery
Keep the file system while correcting mount, route, permission or application problems. Restore damaged data from a verified backup into a separate file system and validate before changing clients. prevent_destroy blocks file-system destruction while this configuration remains present; review any removal of this protection and retain recovery copies before deleting data.

https://docs.aws.amazon.com/efs/latest/ug/manage-fs-access-create-delete-mount-targets.html
https://docs.aws.amazon.com/efs/latest/ug/network-access.html
`, findings);
  },
} satisfies Blueprint;
