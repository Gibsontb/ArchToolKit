import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_ELASTICACHE_SERVICE = {
  id: 'aws_service_elasticache', label: 'Set up an encrypted Valkey or Redis replication group',
  description: 'Create a private, non-sharded replication group with replicas, TLS, encryption, snapshots and an existing RBAC user group.',
  emits: ['aws_elasticache_subnet_group', 'aws_elasticache_replication_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Replication group name', control: 'text' },
    { id: 'engine', label: 'Cache engine', control: 'select', default: 'valkey', options: [{ value: 'valkey', label: 'Valkey' }, { value: 'redis', label: 'Redis OSS' }] },
    { id: 'version', label: 'Engine version', control: 'text', hint: 'Enter a regionally available Valkey version 7.2 or later, or Redis OSS version 7.0 or later. Confirm compatibility with the RBAC user group.' },
    { id: 'node_type', label: 'Cache node type', control: 'combo', default: 'cache.t4g.small', options: ['cache.t4g.small', 'cache.t4g.medium', 'cache.m6g.large', 'cache.m6g.xlarge', 'cache.r6g.large', 'cache.r6g.xlarge'].map(value => ({ value, label: value })) },
    { id: 'replicas', label: 'Read replicas', control: 'number', default: 1, min: 1, max: 5, hint: 'One primary plus this number of replicas. Multi-AZ automatic failover is enabled.' },
    { id: 'subnets', label: 'Existing cache subnet IDs', control: 'text', hint: 'Comma-separated private IPv4 subnet IDs across at least two Availability Zones within one VPC.' },
    { id: 'groups', label: 'Existing cache security group IDs', control: 'text', hint: 'Comma-separated security groups in the subnet VPC. Permit TLS traffic on the selected cache port only from approved clients.' },
    { id: 'user_group', label: 'Existing RBAC user group ID', control: 'text', hint: 'An existing engine-compatible user group containing an appropriately restricted default user. Manage credentials and rotation separately.' },
    { id: 'port', label: 'Cache port', control: 'number', default: 6379, min: 1, max: 65535 },
    { id: 'snapshots', label: 'Automatic snapshot retention (days)', control: 'number', default: 7, min: 1, max: 35 },
    { id: 'kms', label: 'Existing KMS key ARN', control: 'text', hint: 'Optional customer-managed symmetric encryption key in this region. Blank uses service-managed encryption.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.elasticache.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), engine = String(values.engine ?? ''), version = String(values.version ?? '');
    const type = String(values.node_type ?? ''), userGroup = String(values.user_group ?? ''), kms = String(values.kms ?? '').trim();
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups');
    if (!/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name) || name.includes('--')) reject('name', 'Use 1–40 lowercase letters, numbers or single hyphens, beginning with a letter and ending with a letter or number.');
    if (!['valkey', 'redis'].includes(engine)) reject('engine', 'Select a cache engine.');
    const parsedVersion = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
    if (!parsedVersion || Number(parsedVersion[1]) < 7 || (engine === 'valkey' && parsedVersion[1] === '7' && Number(parsedVersion[2]) < 2)) reject('version', 'Enter a supported engine version compatible with required TLS mode and RBAC.');
    if (!/^cache\.[a-z][a-z0-9]*\.[a-z0-9]+$/.test(type)) reject('node_type', 'Enter an available cache node type.');
    if (subnets.length < 2 || subnets.length > 32 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Enter 2–32 valid subnet IDs.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Enter 1–5 security group IDs.');
    if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(userGroup)) reject('user_group', 'Enter an existing RBAC user group ID.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + location + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a KMS key ARN in the selected partition and region.');
    const integer = (key: string, min: number, max: number) => { const value = Number(values[key]); if (values[key] === '' || !Number.isInteger(value) || value < min || value > max) reject(key, 'Enter a whole number from ' + min + ' to ' + max + '.'); return value; };
    const replicas = integer('replicas', 1, 5), port = integer('port', 1, 65535), snapshots = integer('snapshots', 1, 35);
    return awsServiceModule(location, [
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_elasticache_subnet_group', 'configured', { name, subnet_ids: subnets }),
      res('aws_elasticache_replication_group', 'configured', {
        replication_group_id: name, description: name + ' application cache', engine, engine_version: version, node_type: type, port,
        num_cache_clusters: replicas + 1, automatic_failover_enabled: true, multi_az_enabled: true,
        subnet_group_name: x('aws_elasticache_subnet_group.configured.name'), security_group_ids: groups, user_group_ids: [userGroup],
        at_rest_encryption_enabled: true, transit_encryption_enabled: true, transit_encryption_mode: 'required',
        ...(kms ? { kms_key_id: kms } : {}), snapshot_retention_limit: snapshots, auto_minor_version_upgrade: true, apply_immediately: false,
      }, [blk('lifecycle', { prevent_destroy: true }, [
        blk('precondition', { condition: x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.selected : group.vpc_id]))) == 1 && length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) >= 2'), error_message: 'Use subnets across at least two AZs and security groups in the same VPC.' }),
        blk('precondition', { condition: x('alltrue([for subnet in data.aws_subnet.selected : !subnet.ipv6_native])'), error_message: 'This cache setup requires IPv4-capable subnets.' }),
      ])]),
      output('primary_endpoint', 'aws_elasticache_replication_group.configured.primary_endpoint_address'),
      output('reader_endpoint', 'aws_elasticache_replication_group.configured.reader_endpoint_address'),
    ], `# Encrypted Valkey or Redis OSS replication group

## Prepare
Confirm engine version, node availability, quota and RBAC compatibility in the selected region. Prepare private subnets and client connectivity. Review the existing user group's default user, least-privilege access strings and authentication configuration. Grant clients only their required cache commands and key patterns. Manage passwords, IAM authentication and rotation through the approved user-management path; no credentials are entered or exported by this form. Review source data and application compatibility before choosing an engine.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the primary-plus-replica node count, TLS requirements, encryption, snapshot retention and RBAC group. Apply the saved plan. This creates a non-sharded replication group with Multi-AZ automatic failover. Subsequent changes honor the service maintenance window unless explicitly changed in code. Confirm no engine change or replacement is introduced unintentionally.

## Verify
Use the primary endpoint for writes and the reader endpoint for suitable reads from an authorized client. Require TLS and the configured RBAC authentication. Test allowed and denied commands, application behavior, replica reads, failover and snapshot restoration into an isolated test cache. Monitor evictions, memory pressure, replication lag, connection counts and snapshot success. Cache replication and snapshots do not replace source-system data protection.

## Recovery
Keep the previous cache and source data until validation passes. Restore a tested snapshot or repopulate from the authoritative system when needed. Review client retry behavior during failover. Terraform prevent_destroy requires an explicit reviewed protection change before replacement or deletion. Cluster-mode sharding, serverless caches, Memcached and new RBAC users use their corresponding existing builders.

https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Clusters.html
https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Clusters.RBAC.html
`, findings);
  },
} satisfies Blueprint;
