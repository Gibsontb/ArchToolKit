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
  description: 'Create a Regional file system with IPv4 mount targets, backup policy, optional access point and customer-managed encryption.',
  emits: ['aws_efs_file_system', 'aws_efs_mount_target', 'aws_efs_backup_policy', 'aws_efs_access_point'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'File system name', control: 'text' },
    { id: 'subnets', label: 'Existing subnet IDs', control: 'text', hint: 'Comma-separated IPv4-capable subnets in one VPC, at most one subnet per Availability Zone.' },
    { id: 'groups', label: 'Existing mount-target security group IDs', control: 'text', hint: 'Comma-separated groups in the same VPC. Allow TCP 2049 from the approved client security groups.' },
    { id: 'throughput', label: 'Throughput mode', control: 'select', default: 'bursting', options: [
      { value: 'bursting', label: 'Bursting' }, { value: 'provisioned', label: 'Provisioned' },
      { value: 'elastic', label: 'Elastic — scale with workload activity' },
    ] },
    { id: 'mibps', label: 'Provisioned throughput (MiB/s)', control: 'number', min: 1, default: 1, showWhen: { input: 'throughput', equals: ['provisioned'] } },
    { id: 'kms', label: 'Existing KMS key ARN', control: 'text', hint: 'Optional customer-managed key in the selected region. Leave blank for the EFS managed key.' },
    { id: 'backups', label: 'Automatic backups', control: 'toggle', default: true },
    { id: 'accesspoint', label: 'Access point', control: 'select', default: 'NONE', options: [
      { value: 'NONE', label: 'No access point' }, { value: 'PRESERVE', label: 'Preserve client POSIX identity — migration' }, { value: 'ENFORCE', label: 'Enforce application UID/GID' },
    ] },
    { id: 'ap_path', label: 'Access-point root directory', control: 'text', default: '/migration', showWhen: { input: 'accesspoint', equals: ['PRESERVE', 'ENFORCE'] }, hint: 'New file system: creates this directory when first mounted. Up to four components/100 characters; no whole-filesystem root.' },
    { id: 'ap_uid', label: 'Directory owner UID', control: 'number', default: 1000, showWhen: { input: 'accesspoint', equals: ['PRESERVE', 'ENFORCE'] }, hint: 'Non-root numeric Linux owner. Enforce mode also uses this identity for all access-point requests.' },
    { id: 'ap_gid', label: 'Directory owner GID', control: 'number', default: 1000, showWhen: { input: 'accesspoint', equals: ['PRESERVE', 'ENFORCE'] } },
    { id: 'ap_permissions', label: 'Directory permissions', control: 'select', default: '0750', showWhen: { input: 'accesspoint', equals: ['PRESERVE', 'ENFORCE'] }, options: [{ value: '0700', label: '0700 — owner only' }, { value: '0750', label: '0750 — owner and read/traverse group' }] },
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
    const accesspoint = String(values.accesspoint ?? 'NONE'), apPath = String(values.ap_path ?? '').trim(), uid = Number(values.ap_uid), gid = Number(values.ap_gid), permissions = String(values.ap_permissions ?? '');
    if (!['NONE', 'PRESERVE', 'ENFORCE'].includes(accesspoint)) reject('accesspoint', 'Select access-point behavior.');
    if (accesspoint !== 'NONE') {
      if (!/^\/(?:[A-Za-z0-9_.-]+\/){0,3}[A-Za-z0-9_.-]+$/.test(apPath) || apPath.length > 100 || apPath.split('/').some(part => part === '.' || part === '..')) reject('ap_path', 'Use a non-root directory up to four components/100 characters without traversal.');
      for (const [key, value] of [['ap_uid', uid], ['ap_gid', gid]] as const) if (!Number.isInteger(value) || value < 1000 || value > 2147483647) reject(key, 'Use a non-root Linux identity from 1000 to 2147483647.');
      if (!['0700', '0750'].includes(permissions)) reject('ap_permissions', 'Choose directory permissions.');
    }
    if (!name || name.length > 256 || /[\r\n]/.test(name)) reject('name', 'Enter a file system name up to 256 characters.');
    if (!subnets.length || subnets.some(value => !subnetPattern.test(value))) reject('subnets', 'Enter valid existing subnet IDs.');
    if (!groups.length || groups.length > 5 || groups.some(value => !groupPattern.test(value))) reject('groups', 'Enter 1–5 valid existing security group IDs.');
    if (!['bursting', 'provisioned', 'elastic'].includes(throughput)) reject('throughput', 'Select a throughput mode.');
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
      ...(accesspoint !== 'NONE' ? [
        res('aws_efs_access_point', 'configured', { file_system_id: x('aws_efs_file_system.configured.id') }, [
          ...(accesspoint === 'ENFORCE' ? [blk('posix_user', { uid, gid })] : []),
          blk('root_directory', { path: apPath }, [blk('creation_info', { owner_uid: uid, owner_gid: gid, permissions })]),
          blk('lifecycle', { prevent_destroy: true }),
        ]),
        output('access_point_id', 'aws_efs_access_point.configured.id'), output('access_point_arn', 'aws_efs_access_point.configured.arn'),
      ] : []),
    ], `# Regional EFS setup

## Prepare
Select one IPv4-capable subnet per required Availability Zone in one VPC. Verify DNS support, available IPs, and routing. The mount-target security groups need inbound TCP 2049 from approved clients. Check client outbound rules. If using a customer-managed KMS key, verify its region, state and key policy permissions. Confirm EFS quotas and regional availability.

## Implement
Run terraform init, terraform validate, and terraform plan -out=service.tfplan. Review the AWS account, region, encryption key, backup policy and network targets. Apply the saved plan. This form creates Regional General Purpose storage with Bursting, Provisioned or Elastic throughput. Provisioned mode incurs throughput charges; Elastic meters reads/writes, so monitor MeteredIOBytes, service quotas and costs. Bursting uses credits. Throughput-mode changes/increases can impose a 24-hour change/decrease restriction. It uses existing network security rules.

## Optional access point
No access point is the preserved default. Preserve-client mode creates a dedicated directory root without forcing a replacement POSIX identity; use this for the separate NFS-to-EFS DataSync workflow that preserves numeric UID/GID/mode. Enforce mode replaces client IDs with the selected non-root UID/GID for application access and is unsuitable for that ownership-preserving migration. The selected directory creation owner/mode is used only if the directory does not already exist at mount time; existing permissions are not overwritten. Verify actual ownership/mode and application identity mapping.

Review IAM ClientMount/ClientWrite/ClientRootAccess, EFS resource policy and TLS requirements separately; this form does not authorize clients or replace a shared policy. An access-point root alone is not a complete security boundary: out-of-band file handles/other access paths need effective POSIX/IAM control. With an approved IAM-enabled role and installed amazon-efs-utils, use the file_system_id and access_point_id outputs in a read-only pilot: sudo mount -t efs -o tls,iam,accesspoint=<access-point-id>,ro <file-system-id>:/ <approved-existing-empty-mount-directory>. Verify the actual mounted source and metadata before enabling writes. Root access to preserve source owners for DataSync must be separately scoped to its dedicated role/access point.

## Verify
Wait for file system and mount targets to report available. Install the supported amazon-efs-utils package on an authorized Linux client. Use the file_system_id output with the documented mount helper and TLS option. Verify the mount, POSIX ownership, test read/write access and application behavior. Verify backup jobs and perform an isolated restore test.

## Recovery
Keep the file system while correcting mount, route, permission or application problems. Restore damaged data from a verified backup into a separate file system and validate before changing clients. prevent_destroy blocks file-system destruction while this configuration remains present; review any removal of this protection and retain recovery copies before deleting data.

https://docs.aws.amazon.com/efs/latest/ug/manage-fs-access-create-delete-mount-targets.html
https://docs.aws.amazon.com/efs/latest/ug/network-access.html
https://docs.aws.amazon.com/efs/latest/ug/managing-throughput.html
https://docs.aws.amazon.com/efs/latest/ug/enforce-root-directory-access-point.html
https://docs.aws.amazon.com/efs/latest/ug/enforce-identity-access-points.html
`, findings);
  },
} satisfies Blueprint;
