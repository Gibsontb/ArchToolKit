import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
const firstThroughputs = [64, 128, 256, 512, 1024, 2048, 3072, 4096];
const secondThroughputs = [160, 320, 640, 1280, 2560, 3840, 5120, 7680, 10240];
export const AWS_FSX_OPENZFS_SERVICE = {
  id: 'aws_service_fsx_openzfs', label: 'Set up FSx for OpenZFS storage',
  description: 'Create single-AZ or multi-AZ SSD NFS storage with scoped exports, client routing, compression, backups and a deploy-time mount command.',
  emits: ['aws_fsx_openzfs_file_system'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'File system name tag', control: 'text' },
    { id: 'deployment', label: 'Deployment type', control: 'select', default: 'SINGLE_AZ_2', options: [{ value: 'SINGLE_AZ_1', label: 'Single-AZ 1 — non-HA' }, { value: 'SINGLE_AZ_2', label: 'Single-AZ 2 — HA within one AZ' }, { value: 'MULTI_AZ_1', label: 'Multi-AZ 1 — HA across two AZs' }] },
    { id: 'throughput1', label: 'Throughput capacity (MB/second)', control: 'select', default: '64', showWhen: { input: 'deployment', equals: ['SINGLE_AZ_1'] }, options: firstThroughputs.map(value => ({ value: String(value), label: String(value) })) },
    { id: 'throughput2', label: 'Throughput capacity (MB/second)', control: 'select', default: '160', showWhen: { input: 'deployment', equals: ['SINGLE_AZ_2', 'MULTI_AZ_1'] }, options: secondThroughputs.map(value => ({ value: String(value), label: String(value) })) },
    { id: 'storage', label: 'SSD storage capacity (GiB)', control: 'number', default: 1024, hint: '1024 GiB = 1 TiB, approximately 1.10 TB. This path supports 64–65,536 GiB; check regional capacity/throughput limits.' },
    { id: 'subnet', label: 'Existing primary / preferred subnet ID', control: 'text', hint: 'Regional subnet with free service addresses. Multi-AZ uses this as the preferred file server subnet.' },
    { id: 'standby', label: 'Existing standby subnet ID', control: 'text', showWhen: { input: 'deployment', equals: ['MULTI_AZ_1'] }, hint: 'Must be in the same VPC and a different AZ from the preferred subnet.' },
    { id: 'routes', label: 'Existing client route table IDs', control: 'text', showWhen: { input: 'deployment', equals: ['MULTI_AZ_1'] }, hint: 'Comma-separated route tables in the filesystem VPC for approved client subnets. FSx manages endpoint routes in these tables.' },
    { id: 'endpoint_range', label: 'Approved endpoint IPv4 /28 range', control: 'text', showWhen: { input: 'deployment', equals: ['MULTI_AZ_1'] }, hint: 'Unused canonical /28, outside subnet ranges. Review VPC/floating-range requirements, client routes and on-premises/peering connectivity.' },
    { id: 'groups', label: 'Existing storage security group IDs', control: 'text', hint: 'Comma-separated IDs in the subnet VPC. Permit approved NFS client traffic; rules are not changed here.' },
    { id: 'clients', label: 'Approved IPv4 client CIDRs', control: 'text', hint: 'Comma-separated canonical CIDRs, up to 25. No wildcard or unrestricted /0 export.' },
    { id: 'access', label: 'Client export access', control: 'select', default: 'rw', options: [{ value: 'rw', label: 'Read and write' }, { value: 'ro', label: 'Read only' }] },
    { id: 'root', label: 'NFS client root mapping', control: 'select', default: 'root_squash', options: [{ value: 'root_squash', label: 'Map client root to anonymous identity' }, { value: 'no_root_squash', label: 'Permit client root — restricted bootstrap/admin use' }] },
    { id: 'compression', label: 'Root volume compression', control: 'select', default: 'ZSTD', options: ['NONE', 'LZ4', 'ZSTD'].map(value => ({ value, label: value })) },
    { id: 'record', label: 'Root record size (KiB)', control: 'select', default: '128', options: [4, 8, 16, 32, 64, 128, 256, 512, 1024].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'kms', label: 'Storage KMS key ARN', control: 'text', hint: 'Optional regional customer-managed encryption key. AWS FSx managed encryption is used otherwise.' },
    { id: 'retention', label: 'Automatic backup retention (days)', control: 'number', default: 7 },
    { id: 'backup', label: 'Daily backup start (UTC HH:MM)', control: 'text', default: '05:00' },
    { id: 'maintenance', label: 'Weekly maintenance (day:HH:MM UTC)', control: 'text', default: '7:03:00', hint: 'Day 1 is Monday, day 7 Sunday. Review backup and maintenance windows for workload impact.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.fsx-openzfs.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), deployment = String(values.deployment ?? ''), throughput = Number(values[deployment === 'SINGLE_AZ_1' ? 'throughput1' : 'throughput2']), storage = Number(values.storage), subnet = String(values.subnet ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) reject('name', 'Use 1–100 letters, numbers, dots, underscores or hyphens.');
    if (!['SINGLE_AZ_1', 'SINGLE_AZ_2', 'MULTI_AZ_1'].includes(deployment)) reject('deployment', 'Choose a supported deployment type.');
    if (!(deployment === 'SINGLE_AZ_1' ? firstThroughputs : secondThroughputs).includes(throughput)) reject(deployment === 'SINGLE_AZ_1' ? 'throughput1' : 'throughput2', 'Choose throughput for the selected deployment type.');
    if (!Number.isInteger(storage) || storage < 64 || storage > 65536) reject('storage', 'Use 64–65,536 whole GiB and verify the regional throughput/storage combination.');
    if (!/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(subnet)) reject('subnet', 'Enter an existing subnet ID.');
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const groups = list('groups'), clients = list('clients');
    const multi = deployment === 'MULTI_AZ_1', standby = multi ? String(values.standby ?? '').trim() : '', routes = multi ? list('routes') : [], endpointRange = multi ? String(values.endpoint_range ?? '').trim() : '';
    if (multi && (!/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(standby) || standby === subnet)) reject('standby', 'Use a different existing standby subnet in another AZ of the same VPC.');
    if (multi && (!routes.length || routes.length > 50 || routes.some(value => !/^rtb-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value)))) reject('routes', 'Select 1–50 existing client route table IDs in the filesystem VPC.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Use 1–5 security groups in the subnet VPC.');
    const cidr = (value: string) => {
      const parsed = /^([^/]+)\/(\d{1,2})$/.exec(value);
      if (!parsed) return false;
      const prefix = Number(parsed[2]), octets = parsed[1]!.split('.');
      if (prefix < 1 || prefix > 32 || String(prefix) !== parsed[2] || octets.length !== 4 || octets.some(part => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
      return octets.reduce((address, part) => address * 256 + Number(part), 0) % 2 ** (32 - prefix) === 0;
    };
    if (!clients.length || clients.length > 25 || clients.some(value => !cidr(value))) reject('clients', 'Use 1–25 canonical IPv4 CIDRs with prefixes /1–/32, without wildcard or /0.');
    if (multi && (!cidr(endpointRange) || !endpointRange.endsWith('/28'))) reject('endpoint_range', 'Enter an approved unused canonical IPv4 /28 endpoint range and review subnet/VPC overlap and client routing.');
    const access = String(values.access ?? ''), root = String(values.root ?? ''), compression = String(values.compression ?? ''), record = Number(values.record), kms = String(values.kms ?? '').trim(), retention = Number(values.retention), backup = String(values.backup ?? ''), maintenance = String(values.maintenance ?? '');
    if (!['rw', 'ro'].includes(access)) reject('access', 'Select client read/write access.');
    if (!['root_squash', 'no_root_squash'].includes(root)) reject('root', 'Select client root mapping.');
    if (!['NONE', 'LZ4', 'ZSTD'].includes(compression)) reject('compression', 'Select compression.');
    if (![4, 8, 16, 32, 64, 128, 256, 512, 1024].includes(record)) reject('record', 'Select root record size.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a regional KMS key ARN in the selected partition.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 90) reject('retention', 'Use 1–90 days of automatic backup retention.');
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(backup)) reject('backup', 'Use a UTC HH:MM backup start time.');
    if (!/^[1-7]:(?:[01]\d|2[0-3]):[0-5]\d$/.test(maintenance)) reject('maintenance', 'Use day:HH:MM UTC, with day 1–7.');
    return awsServiceModule(region, [
      dat('aws_subnet', 'selected', { id: subnet }), dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      ...(multi ? [dat('aws_subnet', 'standby', { id: standby }), dat('aws_route_table', 'clients', { for_each: x('toset(' + JSON.stringify(routes) + ')'), route_table_id: x('each.value') })] : []),
      res('aws_fsx_openzfs_file_system', 'configured', { deployment_type: deployment, storage_type: 'SSD', storage_capacity: storage, throughput_capacity: throughput, subnet_ids: multi ? [subnet, standby] : [subnet], ...(multi ? { preferred_subnet_id: subnet, route_table_ids: routes, endpoint_ip_address_range: endpointRange } : {}), security_group_ids: groups, automatic_backup_retention_days: retention, daily_automatic_backup_start_time: backup, weekly_maintenance_start_time: maintenance, copy_tags_to_backups: true, copy_tags_to_volumes: true, skip_final_backup: false, tags: x(hcl({ Name: name })), ...(kms ? { kms_key_id: kms } : {}) }, [
        blk('disk_iops_configuration', { mode: 'AUTOMATIC' }),
        blk('root_volume_configuration', { data_compression_type: compression, record_size_kib: record, read_only: false, copy_tags_to_snapshots: true }, [blk('nfs_exports', {}, clients.map(client => blk('client_configurations', { clients: client, options: [access, root] })))]),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('alltrue([for group in data.aws_security_group.selected : group.vpc_id == data.aws_subnet.selected.vpc_id])'), error_message: 'All storage security groups must belong to the selected subnet VPC.' }), ...(multi ? [blk('precondition', { condition: x('data.aws_subnet.standby.vpc_id == data.aws_subnet.selected.vpc_id && data.aws_subnet.standby.availability_zone != data.aws_subnet.selected.availability_zone && alltrue([for route in data.aws_route_table.clients : route.vpc_id == data.aws_subnet.selected.vpc_id])'), error_message: 'Multi-AZ subnets must use different AZs of one VPC, with client route tables in that VPC.' })] : [])]),
      ]), output('file_system_id', 'aws_fsx_openzfs_file_system.configured.id'), output('dns_name', 'aws_fsx_openzfs_file_system.configured.dns_name'), output('root_volume_id', 'aws_fsx_openzfs_file_system.configured.root_volume_id'), output('mount_command', '"sudo mount -t nfs -o nfsvers=4.1 ${aws_fsx_openzfs_file_system.configured.dns_name}:/fsx /mnt/fsx"'),
    ], `# FSx for OpenZFS NFS storage

## Prepare
Confirm deployment-type availability and regional storage/throughput limits, subnet address capacity, KMS permissions, NFS client routing/DNS and security-group rules. Single-AZ 2 is highly available within one AZ; it does not provide multi-AZ disaster recovery. Review provisioned SSD, throughput, backup and KMS costs. Existing security groups must allow the required NFS traffic from approved clients; no rules or clients are provisioned here. Review in-transit protection/authentication requirements and the approved network boundary; encryption at rest does not establish encrypted NFS transport.

Multi-AZ 1 uses preferred/standby subnets in different AZs of one VPC. Review the explicit /28 endpoint range for subnet/VPC overlap and choose all relevant client route tables; the form checks CIDR syntax and VPC/AZ ownership, not whether that range is unused across the whole estate. FSx manages endpoint routes in those tables. Peered/on-premises clients and floating endpoint ranges can require additional Transit Gateway/network routes. Validate client reachability and documented failover/reconnect behavior before production cutover. Cross-AZ HA does not replace backups or cross-region recovery planning.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review subnet/AZ, export CIDRs, client/root permissions, performance, compression and backup windows; apply the saved reviewed plan. Wait for AVAILABLE. On an approved Linux client install nfs-common on Debian/Ubuntu or nfs-utils on the applicable RHEL-family system. Create /mnt/fsx with sudo mkdir -p /mnt/fsx, then read terraform output -raw mount_command and run that reviewed command on the client. The root volume path is /fsx. Security groups, exports and POSIX ownership/permissions all affect access.

## Bootstrap application ownership
For a new empty volume, establish application directories and correct UID/GID ownership using the approved storage administrator. Client root is squashed by default and cannot automatically act as server root. If temporary no_root_squash is required, restrict client CIDRs to the approved bootstrap host, apply the reviewed temporary setting, create/chown the required application directory as that administrator, then restore root_squash and approved production CIDRs through another reviewed plan. Do not leave broad root access enabled as a shortcut. Read-only exports must be populated through an approved writable/admin path before application use. UID/GID mapping must match the clients.

## Verify
Run aws fsx describe-file-systems --file-system-ids <file_system_id> --region ${region}; confirm deployment, capacity, root volume, backups and maintenance settings. From the intended application identity test authorized read/write (or read-only denial), ownership, export restrictions and remount behavior. Check that an unapproved client is denied. Benchmark representative I/O before changing throughput/record size. Verify backup completion and perform a restore/readability test through the recovery owner. This package schedules backups but does not prove restore or migrate existing data. Plan source consistency, initial copy, final delta and cutover separately.

## Recovery
Keep source data and consumer configuration until cutover acceptance. Stop writes and restore the appropriate backup to an isolated recovery filesystem when needed; reconcile application consistency and restore ownership/export settings before switching clients. Capacity and performance changes have service constraints and can affect availability; review in-progress maintenance. Terraform prevent_destroy blocks accidental deletion and final backups remain enabled for an explicitly authorized deletion. Intelligent-Tiering, restore-from-backup, additional volumes/quotas, snapshots and replication require their corresponding additional builders.

https://docs.aws.amazon.com/fsx/latest/OpenZFSGuide/getting-started.html
`, findings);
  },
} satisfies Blueprint;
