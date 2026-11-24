import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, jsonencode, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition } from './aws-service-module.js';
import { AWS_DATASYNC_NFS_SERVICE } from './aws-datasync-nfs-service.js';
import { awsDataSyncTask } from './aws-datasync-task.js';
import { awsDataSyncOperator } from './aws-datasync-operator.js';

export const AWS_DATASYNC_EFS_SERVICE = {
  id: 'aws_service_datasync_nfs_efs', label: 'Migrate on-premises NFS files to EFS',
  description: 'Basic-mode NFS copy to an existing encrypted EFS access point over TLS, preserving numeric POSIX ownership and permissions.',
  emits: ['aws_datasync_location_nfs', 'aws_datasync_location_efs', 'aws_datasync_task', 'aws_iam_role_policy'],
  inputs: [
    ...AWS_DATASYNC_NFS_SERVICE.inputs.filter(input => !['bucket', 'prefix', 'role'].includes(input.id)),
    { id: 'filesystem', label: 'Existing encrypted EFS file system ID', control: 'text' },
    { id: 'accesspoint', label: 'Existing EFS access point ID', control: 'text', hint: 'Approved non-root migration directory, without enforced POSIX user. No access point is created or changed.' },
    { id: 'target_path', label: 'Access-point root directory', control: 'text', default: '/migration', hint: 'Existing approved destination directory. Source numeric UID/GID and permissions must be appropriate for its future consumers.' },
    { id: 'mount', label: 'Existing EFS mount target ID', control: 'text' },
    { id: 'subnet', label: 'DataSync private subnet ID', control: 'text', hint: 'Same VPC and Availability Zone as the selected mount target, with at least four free addresses.' },
    { id: 'group', label: 'Existing mount-target security group ID', control: 'text', hint: 'Also used on the DataSync location. Owner must allow self-referencing inbound/outbound TCP 2049; this package does not alter shared security groups.' },
    { id: 'role', label: 'Existing dedicated DataSync EFS access role ARN', control: 'text', hint: 'This role receives a scoped policy including root access through this access point to preserve owners. Have its owner review trust and all effective policies.' },
  ],
  build(values)                                      {
    const findings            = [], reject = (path        , message        ) => findings.push(error('aws.datasync-efs.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), agent = String(values.agent ?? '').trim(), server = String(values.server ?? '').trim(), path = String(values.path ?? '').trim(), version = String(values.version ?? '');
    const agentMatch = /^arn:([^:]+):datasync:([^:]+):(\d{12}):agent\/agent-[0-9a-f]{17}$/.exec(agent), account = agentMatch?.[3] ?? '';
    if (!agentMatch || agentMatch[1] !== partition || agentMatch[2] !== region) reject('agent', 'Use an activated Basic-mode agent in the selected region/account/partition.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,99}$/.test(name)) reject('name', 'Use 2–100 letters, numbers, dots, underscores or hyphens.');
    if (server.length > 253 || !server.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) || /^\d+(?:\.\d+){3}$/.test(server) && server.split('.').some(value => Number(value) > 255)) reject('server', 'Enter the NFS hostname or valid IPv4 address.');
    if (!path.startsWith('/') || path.includes('//') || path.split('/').some(part => part === '.' || part === '..') || /[\x00-\x1f\\]/.test(path) || new TextEncoder().encode(path).length > 4096) reject('path', 'Use an absolute exported path without traversal, repeated slashes or control characters.');
    if (!['AUTOMATIC', 'NFS3', 'NFS4_0', 'NFS4_1'].includes(version)) reject('version', 'Select an NFS protocol supported by the source.');
    const filesystem = String(values.filesystem ?? '').trim(), accesspoint = String(values.accesspoint ?? '').trim(), mount = String(values.mount ?? '').trim(), subnet = String(values.subnet ?? '').trim(), group = String(values.group ?? '').trim(), targetPath = String(values.target_path ?? '').trim(), role = String(values.role ?? '').trim();
    for (const [key, value, pattern] of [['filesystem', filesystem, /^fs-[0-9a-f]{8,40}$/], ['accesspoint', accesspoint, /^fsap-[0-9a-f]{8,40}$/], ['mount', mount, /^fsmt-[0-9a-f]{8,40}$/], ['subnet', subnet, /^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/], ['group', group, /^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/]]         ) if (!pattern.test(value)) reject(key, 'Enter the existing ' + key + ' ID.');
    if (!/^\/(?:[A-Za-z0-9_.-]+\/){0,3}[A-Za-z0-9_.-]+$/.test(targetPath) || targetPath.split('/').some(part => part === '.' || part === '..') || targetPath.length > 100) reject('target_path', 'Use an approved non-root access-point directory, up to four components/100 characters, without traversal.');
    const roleMatch = /^arn:([^:]+):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(role);
    if (!roleMatch || roleMatch[1] !== partition || roleMatch[2] !== account) reject('role', 'Use a dedicated DataSync EFS role in the agent/deployment account.');
    const bandwidth = Number(values.bandwidth), bytes = bandwidth === 0 ? -1 : Math.round(bandwidth * 1e6), overwrite = String(values.overwrite ?? ''), logging = String(values.logging ?? ''), retention = Number(values.retention);
    if (!Number.isFinite(bandwidth) || bandwidth < 0 || !Number.isSafeInteger(bytes) || bytes === 0) reject('bandwidth', 'Use zero for unlimited or a positive finite MB/second rate.');
    if (!['NEVER', 'ALWAYS'].includes(overwrite)) reject('overwrite', 'Choose destination overwrite behavior.');
    if (!['BASIC', 'TRANSFER'].includes(logging)) reject('logging', 'Choose transfer log detail.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Choose log retention.');
    const fsArn = 'arn:' + partition + ':elasticfilesystem:' + region + ':' + account + ':file-system/' + filesystem, apArn = fsArn.split(':file-system/')[0] + ':access-point/' + accesspoint;
    const policy = { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite', 'elasticfilesystem:ClientRootAccess'], Resource: fsArn, Condition: { StringEquals: { 'elasticfilesystem:AccessPointArn': apArn }, Bool: { 'aws:SecureTransport': 'true', 'elasticfilesystem:AccessedViaMountTarget': 'true' } } },
      { Effect: 'Deny', Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite', 'elasticfilesystem:ClientRootAccess'], Resource: fsArn, Condition: { StringNotEquals: { 'elasticfilesystem:AccessPointArn': apArn } } },
    ] };
    const result = awsServiceModule(region, [
      dat('aws_efs_file_system', 'destination', { file_system_id: filesystem }), dat('aws_efs_access_point', 'destination', { access_point_id: accesspoint }), dat('aws_efs_mount_target', 'destination', { mount_target_id: mount }),
      dat('aws_subnet', 'destination', { id: subnet }), dat('aws_subnet', 'mount', { id: x('data.aws_efs_mount_target.destination.subnet_id') }), dat('aws_security_group', 'destination', { id: group }),
      dat('aws_vpc', 'destination', { id: x('data.aws_subnet.destination.vpc_id') }),
      dat('aws_iam_role', 'destination', { name: roleMatch?.[3]?.split('/').at(-1) ?? '' }),
      res('aws_iam_role_policy', 'destination', { name: name + '-efs-transfer', role: x('data.aws_iam_role.destination.name'), policy: x(jsonencode(policy)) }),
      res('aws_datasync_location_nfs', 'source', { server_hostname: server, subdirectory: path }, [blk('on_prem_config', { agent_arns: [agent] }), blk('mount_options', { version })]),
      res('aws_datasync_location_efs', 'destination', { efs_file_system_arn: fsArn, access_point_arn: apArn, file_system_access_role_arn: role, in_transit_encryption: 'TLS1_2', subdirectory: '/', depends_on: x('[aws_iam_role_policy.destination]') }, [
        blk('ec2_config', { subnet_arn: x('data.aws_subnet.destination.arn'), security_group_arns: x('[data.aws_security_group.destination.arn]') }),
        blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_vpc.destination.instance_tenancy == "default" && data.aws_efs_file_system.destination.arn == ' + JSON.stringify(fsArn) + ' && data.aws_efs_file_system.destination.encrypted && data.aws_efs_access_point.destination.file_system_id == ' + JSON.stringify(filesystem) + ' && data.aws_efs_access_point.destination.owner_id == data.aws_caller_identity.current.account_id && length(data.aws_efs_access_point.destination.posix_user) == 0 && data.aws_efs_access_point.destination.root_directory[0].path == ' + JSON.stringify(targetPath) + ' && data.aws_efs_mount_target.destination.file_system_id == ' + JSON.stringify(filesystem) + ' && data.aws_efs_mount_target.destination.owner_id == data.aws_caller_identity.current.account_id && data.aws_subnet.destination.vpc_id == data.aws_subnet.mount.vpc_id && data.aws_subnet.destination.availability_zone_id == data.aws_subnet.mount.availability_zone_id && !data.aws_subnet.destination.map_public_ip_on_launch && data.aws_subnet.destination.available_ip_address_count >= 4 && data.aws_security_group.destination.vpc_id == data.aws_subnet.destination.vpc_id && contains(data.aws_efs_mount_target.destination.security_groups, ' + JSON.stringify(group) + ') && data.aws_iam_role.destination.arn == ' + JSON.stringify(role)), error_message: 'Require same-account encrypted EFS, matching unforced-identity access point/root, selected mount/group and private default-tenancy same-VPC/AZ subnet with free IPs.' })]),
      ]),
      ...awsDataSyncTask(region, name, 'aws_datasync_location_nfs.source.arn', 'aws_datasync_location_efs.destination.arn', retention, { bytes_per_second: bytes, log_level: logging, overwrite_mode: overwrite, object_tags: 'NONE', uid: 'INT_VALUE', gid: 'INT_VALUE', posix_permissions: 'PRESERVE', atime: 'BEST_EFFORT', mtime: 'PRESERVE', preserve_devices: 'NONE' }),
    ], GUIDE, findings);
    return { ...result, files: { ...result.files, ...awsDataSyncOperator({ region, partition, name, source: { kind: 'nfs', server, path, agent, version }, destination: { kind: 'efs', filesystem, accesspoint, role, subnet, group, mount, path: targetPath }, options: { BytesPerSecond: bytes, LogLevel: logging, OverwriteMode: overwrite, ObjectTags: 'NONE', Uid: 'INT_VALUE', Gid: 'INT_VALUE', PosixPermissions: 'PRESERVE', Atime: 'BEST_EFFORT', Mtime: 'PRESERVE', PreserveDevices: 'NONE' } }), 'EFS-ACCESS.json': JSON.stringify(policy, null, 2) + '\n',
      'ROLE-TRUST-EXAMPLE.json': JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'datasync.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': account }, ArnLike: { 'aws:SourceArn': 'arn:' + partition + ':datasync:' + region + ':' + account + ':*' } } }] }, null, 2) + '\n',
    } };
  },
}                    ;

const GUIDE = `# On-premises NFS to EFS

## Prepare source and destination
Deploy/activate an approved Basic-mode DataSync appliance using current AWS sizing/network requirements. Inventory files, bytes, directory/metadata counts, links, numeric UID/GIDs, POSIX permissions and application consistency requirements. Confirm NFS export read privileges and source snapshot/quiescence. NFS source traffic is not made TLS-encrypted by the destination setting: use an approved protected source/agent network. This is a filesystem copy, not VM/database/application conversion.

Use existing encrypted same-account regional EFS, an available mount target and an approved existing access point rooted at a dedicated non-root migration directory. The access point must NOT enforce a replacement POSIX identity: that would change copied ownership and can fail verification. This workflow preserves numeric UID/GID, mtime and POSIX mode; atime is best effort. Confirm matching numeric identities on future consumers and EFS metadata/ACL/link/type limitations. Special devices are not recreated. It does not preserve every NFS extension or implement SMB/Windows ACL migration.

The selected existing security group is attached both to the mount target and DataSync ENIs. Its owner must allow TCP2049 to/from itself; verify route tables, NACLs and agent/service connectivity. Select a private subnet in the mount target's VPC/AZ with four free IPs. Terraform verifies placement but does not alter shared groups, routes or NACLs. EFS throughput/capacity/quotas and agent reachability need a pilot.

## Authorization and recovery
Use a dedicated existing role trusted by datasync.amazonaws.com with source-account/regional DataSync source-ARN restrictions. Review ROLE-TRUST-EXAMPLE.json with the role owner; it is not attached automatically. During initial location creation its ARN is unknown; after creation tighten trust to the exact destination location ARN from operator_job where supported. The service assumes this role for a location, so a task/* source condition is incorrect. This package attaches EFS-ACCESS.json as a named inline policy: ClientMount, ClientWrite and ClientRootAccess through the exact access point, TLS and mount target, plus deny access to this file system through other access points. Root privilege is intentional to preserve source owners; review this with the data/filesystem owners. It does not replace role trust, existing policies, EFS resource policy or KMS policy. Review all effective permissions and any access-point/root symlinks before granting access. Read/write includes modification/deletion where POSIX allows it, although this task preserves destination-only files.

Enable EFS automatic backups and verify actual completed recovery points, retention and tested restore. Enabled policy alone does not prove a recovery point exists. Prepare a dedicated empty root directory/backup before copy; no mkdir/chown or source/destination data change is performed by generation. Recover an overwritten EFS file from approved backup/restore; there is no S3 versioning on EFS.

## Build, copy and verify
Run terraform init, validate and plan -out=service.tfplan. Review source/target direction, identity/permissions, encryption, IAM and overwrite behavior, then apply the reviewed plan. No task starts automatically or on a schedule. Follow OPERATOR.md: inspect with python OPERATE.py; after approved transfer/recovery review start with --start --confirm-transfer (also --confirm-overwrite for ALWAYS). The helper checks metadata/backup policy, not data consistency, effective IAM, source mounts, completed backups or application acceptance. Save the execution ARN and monitor with --execution. No retry after an ambiguous start until execution history is investigated.

Pilot representative content/owners/modes/links and application reads. Reconcile counts/sizes/checksums/metadata and errors independently. Preserve-existing NEVER skips changed destination files too; final delta requires reviewed ALWAYS plus recovery protection. Freeze writers, run/reconcile the final delta, switch consumers and obtain owner acceptance. Keep source available for rollback; changes made at the destination after cutover need a separately reviewed reverse reconciliation. Cancellation does not undo completed writes. Removing task/location/IAM configuration does not delete EFS/NFS data or revert permissions on copied files. Cross-account, reverse cutback, S3/SMB sources, forced-identity destinations, Enhanced mode and full infrastructure creation remain separate workflows.

https://docs.aws.amazon.com/datasync/latest/userguide/create-efs-location.html
https://docs.aws.amazon.com/datasync/latest/userguide/agent-requirements.html
https://docs.aws.amazon.com/datasync/latest/apireference/API_Options.html
`;
