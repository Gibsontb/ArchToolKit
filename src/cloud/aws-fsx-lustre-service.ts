import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
export const AWS_FSX_LUSTRE_SERVICE = {
  id: 'aws_service_fsx_lustre', label: 'Set up FSx for Lustre parallel storage',
  description: 'Create persistent or scratch SSD storage with compatible capacity, throughput, encryption, networking and client mount instructions.',
  emits: ['aws_fsx_lustre_file_system'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'File system name tag', control: 'text' },
    { id: 'deployment', label: 'Storage deployment', control: 'select', default: 'PERSISTENT_2', options: [{ value: 'PERSISTENT_2', label: 'Persistent 2 — replicated persistent storage' }, { value: 'SCRATCH_2', label: 'Scratch 2 — temporary, reproducible data only' }] },
    { id: 'version', label: 'Lustre file system version', control: 'select', default: '2.15', options: [{ value: '2.15', label: '2.15' }, { value: '2.12', label: '2.12 — verify workload/client compatibility' }] },
    { id: 'storage', label: 'SSD storage capacity (GiB)', control: 'number', default: 1200, hint: 'This workflow uses 1200 GiB or multiples of 2400 GiB. Verify regional limits; newer/smaller capacity variants require separate validation.' },
    { id: 'throughput', label: 'Persistent throughput (MB/second per TiB)', control: 'select', default: '250', showWhen: { input: 'deployment', equals: ['PERSISTENT_2'] }, options: [125, 250, 500, 1000].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'subnet', label: 'Existing storage subnet ID', control: 'text' },
    { id: 'groups', label: 'Existing Lustre security group IDs', control: 'text', hint: 'Comma-separated security groups in the subnet VPC. Review the Lustre client/server port rules before deploying.' },
    { id: 'compression', label: 'Data compression', control: 'select', default: 'LZ4', options: [{ value: 'LZ4', label: 'LZ4 compression' }, { value: 'NONE', label: 'No compression' }] },
    { id: 'kms', label: 'Persistent storage KMS key ARN', control: 'text', showWhen: { input: 'deployment', equals: ['PERSISTENT_2'] }, hint: 'Optional regional customer-managed key. Scratch uses the service encryption key.' },
    { id: 'retention', label: 'Persistent backup retention (days)', control: 'number', default: 7, showWhen: { input: 'deployment', equals: ['PERSISTENT_2'] } },
    { id: 'backup', label: 'Daily backup start (UTC HH:MM)', control: 'text', default: '05:00', showWhen: { input: 'deployment', equals: ['PERSISTENT_2'] } },
    { id: 'maintenance', label: 'Weekly maintenance (day:HH:MM UTC)', control: 'text', default: '7:03:00', hint: 'Day 1 is Monday; day 7 Sunday.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.fsx-lustre.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), deployment = String(values.deployment ?? ''), persistent = deployment === 'PERSISTENT_2', version = String(values.version ?? ''), storage = Number(values.storage), throughput = Number(values.throughput), subnet = String(values.subnet ?? '').trim(), compression = String(values.compression ?? ''), maintenance = String(values.maintenance ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) reject('name', 'Use 1–100 letters, numbers, dots, underscores or hyphens.');
    if (!['PERSISTENT_2', 'SCRATCH_2'].includes(deployment)) reject('deployment', 'Choose persistent or scratch storage.');
    if (!['2.12', '2.15'].includes(version)) reject('version', 'Choose a supported Lustre version.');
    if (!Number.isInteger(storage) || storage < 1200 || storage > 100800 || storage !== 1200 && storage % 2400 !== 0) reject('storage', 'Use 1200 GiB or multiples of 2400 GiB, up to this workflow\'s 100,800 GiB ceiling, and verify regional quotas.');
    if (persistent && ![125, 250, 500, 1000].includes(throughput)) reject('throughput', 'Choose persistent per-unit throughput.');
    if (!/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(subnet)) reject('subnet', 'Enter the existing storage subnet ID.');
    const groups = [...new Set(String(values.groups ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Use 1–5 existing security groups in the subnet VPC.');
    if (!['LZ4', 'NONE'].includes(compression)) reject('compression', 'Select compression.');
    if (!/^[1-7]:(?:[01]\d|2[0-3]):[0-5]\d$/.test(maintenance)) reject('maintenance', 'Use day:HH:MM UTC with day 1–7.');
    const kms = persistent ? String(values.kms ?? '').trim() : '', retention = Number(values.retention), backup = String(values.backup ?? '');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a regional KMS key ARN in the selected partition.');
    if (persistent && (!Number.isInteger(retention) || retention < 1 || retention > 90)) reject('retention', 'Use 1–90 days of persistent backup retention.');
    if (persistent && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(backup)) reject('backup', 'Use a UTC HH:MM backup start time.');
    return awsServiceModule(region, [
      dat('aws_subnet', 'selected', { id: subnet }), dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_fsx_lustre_file_system', 'configured', { deployment_type: deployment, file_system_type_version: version, storage_type: 'SSD', storage_capacity: storage, subnet_ids: [subnet], security_group_ids: groups, data_compression_type: compression, weekly_maintenance_start_time: maintenance, skip_final_backup: !persistent, tags: x(hcl({ Name: name })), ...(persistent ? { per_unit_storage_throughput: throughput, automatic_backup_retention_days: retention, daily_automatic_backup_start_time: backup, copy_tags_to_backups: true, ...(kms ? { kms_key_id: kms } : {}) } : {}) }, [blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('alltrue([for group in data.aws_security_group.selected : group.vpc_id == data.aws_subnet.selected.vpc_id])'), error_message: 'All Lustre security groups must belong to the selected subnet VPC.' })])]),
      output('file_system_id', 'aws_fsx_lustre_file_system.configured.id'), output('dns_name', 'aws_fsx_lustre_file_system.configured.dns_name'), output('mount_name', 'aws_fsx_lustre_file_system.configured.mount_name'), output('mount_command', '"sudo mount -t lustre -o relatime,flock ${aws_fsx_lustre_file_system.configured.dns_name}@tcp:/${aws_fsx_lustre_file_system.configured.mount_name} /mnt/fsx"'),
    ], `# FSx for Lustre parallel storage

## Prepare
Confirm regional deployment/version/capacity availability, quotas, storage/throughput costs, KMS policy and subnet capacity. Prepare existing security groups with AWS's required Lustre client/server and filesystem self-communication rules, including TCP 988 and 1018–1023 as applicable. Rules are not modified here. Verify routes/DNS and choose clients with an AWS-supported Lustre driver for the exact OS/kernel and filesystem version. Install the client through the current official AWS procedure, not an assumed generic package name.

Persistent 2 replicates file data within its service deployment; configure and test recovery independently. Scratch 2 is for reproducible temporary data: it has no persistent backup/final-backup configuration in this package and uses service encryption. Keep authoritative input/output outside scratch. Customer-managed encryption and backup inputs from persistent mode are inactive in scratch mode. This workflow uses the pinned provider's common SSD capacity pattern; newer 600-GiB/other capacity, EFA and metadata-performance variants need separate validation.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review persistent/scratch choice, exact GiB capacity, per-TiB throughput when persistent, version, compression, networking and backup windows; apply the saved reviewed plan. Wait for AVAILABLE. On an approved compatible Linux client create /mnt/fsx, read terraform output -raw mount_command and execute that reviewed mount command. The mount name comes from the applied filesystem, not an assumed /fsx export name. Establish application directories and correct POSIX UID/GID permissions through the storage administrator. No client host or application data is created by Terraform here.

## Verify
Use aws fsx describe-file-systems --file-system-ids <file_system_id> --region ${region}. Confirm deployment, version, capacity and persistent backups. On the client verify mount and filesystem space with the supported filesystem tools; test read/write, POSIX permissions, locking and representative parallel I/O. Validate denied access from unapproved clients, CloudWatch capacity/throughput metrics and agreed job completion behavior. For persistent storage verify scheduled backup completion and perform an isolated restore/readability test. For scratch verify complete reconstruction from authoritative source data. Do not treat creation or a benchmark as a restore test.

## Recovery
Stop jobs and coordinate mounts before filesystem changes. Recover persistent data through the approved backup/recovery procedure, or recreate scratch and repopulate it from authoritative sources. Preserve application checkpoints, permissions and source manifests for cutback. Terraform prevent_destroy blocks deletion; explicitly reviewed persistent deletion retains a final backup, while scratch has no final backup. S3 data repository association/import/export, restore-from-backup, HDD/Persistent 1, EFA, custom metadata scaling, Kubernetes CSI and job-scheduler integration use additional workflows. No storage migration or job execution occurs during package generation.

https://docs.aws.amazon.com/fsx/latest/LustreGuide/getting-started.html
https://docs.aws.amazon.com/fsx/latest/APIReference/API_CreateFileSystem.html
`, findings);
  },
} satisfies Blueprint;
