import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_AURORA_SERVICE = {
  id: 'aws_service_aurora', label: 'Set up a private Aurora database cluster',
  description: 'Create encrypted Aurora PostgreSQL or MySQL with managed credentials, backups and provisioned or Serverless v2 instances.',
  emits: ['aws_db_subnet_group', 'aws_rds_cluster', 'aws_rds_cluster_instance'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Cluster identifier', control: 'text' },
    { id: 'engine', label: 'Database engine', control: 'select', default: 'aurora-postgresql', options: [{ value: 'aurora-postgresql', label: 'Aurora PostgreSQL' }, { value: 'aurora-mysql', label: 'Aurora MySQL' }] },
    { id: 'version', label: 'Engine version', control: 'text', hint: 'A version offered in this region for the selected engine, capacity mode and instance type.' },
    { id: 'capacity', label: 'Instance capacity', control: 'select', default: 'provisioned', options: [{ value: 'provisioned', label: 'Provisioned instances' }, { value: 'serverless', label: 'Serverless v2 instances' }] },
    { id: 'instance_class', label: 'DB instance class', control: 'combo', default: 'db.r6g.large', options: ['db.r6g.large', 'db.r6g.xlarge', 'db.r7g.large', 'db.r7g.xlarge', 'db.t4g.medium'].map(value => ({ value, label: value })), showWhen: { input: 'capacity', equals: ['provisioned'] } },
    { id: 'min_acu', label: 'Minimum capacity per instance (ACUs)', control: 'number', default: 0.5, min: 0.5, max: 128, showWhen: { input: 'capacity', equals: ['serverless'] } },
    { id: 'max_acu', label: 'Maximum capacity per instance (ACUs)', control: 'number', default: 16, min: 0.5, max: 128, showWhen: { input: 'capacity', equals: ['serverless'] } },
    { id: 'instances', label: 'Total DB instances, including the writer', control: 'number', default: 2, min: 1, max: 16, hint: 'Two or more provide a reader for failover. Each Serverless v2 instance has its own capacity range.' },
    { id: 'subnets', label: 'Existing private DB subnet IDs', control: 'text', hint: 'Comma-separated IPv4-capable subnets in one VPC across at least two Availability Zones.' },
    { id: 'groups', label: 'Existing DB security group IDs', control: 'text', hint: 'Comma-separated groups in the subnet VPC. Allow the database port only from approved application and administrator sources.' },
    { id: 'username', label: 'Master username', control: 'text', default: 'dbadmin', hint: 'RDS manages the password in Secrets Manager. Applications should use separate least-privilege database users.' },
    { id: 'database', label: 'Initial database name', control: 'text', default: 'application' },
    { id: 'retention', label: 'Backup retention (days)', control: 'number', default: 7, min: 1, max: 35 },
    { id: 'storage', label: 'Aurora storage configuration', control: 'select', default: 'aurora', options: [{ value: 'aurora', label: 'Aurora Standard' }, { value: 'aurora-iopt1', label: 'Aurora I/O-Optimized' }] },
    { id: 'kms', label: 'Existing storage KMS key ARN', control: 'text', hint: 'Optional symmetric customer-managed key in the selected region. Blank uses RDS-managed encryption.' },
    { id: 'iam_auth', label: 'Enable IAM database authentication', control: 'toggle', default: false },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.aurora.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), engine = String(values.engine ?? ''), version = String(values.version ?? ''), capacity = String(values.capacity ?? '');
    const instanceClass = String(values.instance_class ?? ''), username = String(values.username ?? ''), database = String(values.database ?? ''), storage = String(values.storage ?? ''), kms = String(values.kms ?? '').trim();
    if (!/^[a-z][a-z0-9-]{0,48}[a-z0-9]$/.test(name) || name.includes('--')) reject('name', 'Use 2–50 lowercase letters, numbers or single hyphens, with a letter first and an alphanumeric end.');
    if (!['aurora-postgresql', 'aurora-mysql'].includes(engine)) reject('engine', 'Select an Aurora engine.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(version)) reject('version', 'Enter a supported Aurora engine version identifier.');
    if (!['provisioned', 'serverless'].includes(capacity)) reject('capacity', 'Select a capacity mode.');
    if (capacity === 'provisioned' && !/^db\.[a-z][a-z0-9]*\.[a-z0-9]+$/.test(instanceClass)) reject('instance_class', 'Select a compatible regional DB instance class.');
    const minimum = Number(values.min_acu), maximum = Number(values.max_acu);
    if (capacity === 'serverless' && (![minimum, maximum].every(value => Number.isFinite(value) && value >= 0.5 && value <= 128 && Number.isInteger(value * 2)) || minimum > maximum)) reject('min_acu', 'Use 0.5-ACU increments from 0.5–128, with minimum no greater than maximum.');
    const count = Number(values.instances), retention = Number(values.retention);
    if (!Number.isInteger(count) || count < 1 || count > 16) reject('instances', 'Enter 1–16 total DB instances.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 35) reject('retention', 'Enter 1–35 days of backup retention.');
    if (!/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(username) || username.toLowerCase() === 'rdsadmin') reject('username', 'Use a nonreserved master username of 1–16 letters or numbers, starting with a letter.');
    if (!/^[A-Za-z][A-Za-z0-9]{0,62}$/.test(database)) reject('database', 'Use a database name of 1–63 letters or numbers, starting with a letter.');
    if (!['aurora', 'aurora-iopt1'].includes(storage)) reject('storage', 'Select Aurora Standard or I/O-Optimized storage.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + location + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a KMS key ARN in the selected region and partition.');
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups');
    if (subnets.length < 2 || subnets.length > 32 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Enter 2–32 valid DB subnet IDs.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Enter 1–5 valid security group IDs.');
    return awsServiceModule(location, [
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_db_subnet_group', 'configured', { name, subnet_ids: subnets }),
      res('aws_rds_cluster', 'configured', {
        cluster_identifier: name, engine, engine_version: version, engine_mode: 'provisioned', database_name: database, master_username: username, manage_master_user_password: true,
        db_subnet_group_name: x('aws_db_subnet_group.configured.name'), vpc_security_group_ids: groups, storage_encrypted: true, storage_type: storage,
        ...(kms ? { kms_key_id: kms } : {}), backup_retention_period: retention, deletion_protection: true, skip_final_snapshot: false, final_snapshot_identifier: name + '-final', iam_database_authentication_enabled: bool(values, 'iam_auth'), apply_immediately: false,
      }, [
        ...(capacity === 'serverless' ? [blk('serverlessv2_scaling_configuration', { min_capacity: minimum, max_capacity: maximum })] : []),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.selected : group.vpc_id]))) == 1 && length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) >= 2 && alltrue([for subnet in data.aws_subnet.selected : !subnet.ipv6_native])'), error_message: 'Use IPv4-capable DB subnets across at least two AZs and security groups in one VPC.' })]),
      ]),
      res('aws_rds_cluster_instance', 'configured', {
        count, identifier: x('"' + name + '-${count.index + 1}"'), cluster_identifier: x('aws_rds_cluster.configured.id'), engine, engine_version: x('aws_rds_cluster.configured.engine_version'),
        instance_class: capacity === 'serverless' ? 'db.serverless' : instanceClass, db_subnet_group_name: x('aws_db_subnet_group.configured.name'), publicly_accessible: false,
        availability_zone: x('element(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone]), count.index)'), promotion_tier: x('count.index'), auto_minor_version_upgrade: true, apply_immediately: false,
      }),
      output('writer_endpoint', 'aws_rds_cluster.configured.endpoint'), output('reader_endpoint', 'aws_rds_cluster.configured.reader_endpoint'), output('master_secret_arn', 'aws_rds_cluster.configured.master_user_secret[0].secret_arn'),
    ], `# Private Aurora PostgreSQL or MySQL

## Prepare
Confirm the exact engine version, instance class or Serverless v2 capacity range and storage mode are supported together in the selected region. Review extension/SQL compatibility and licensing before migration. Prepare private DB subnets, approved client connectivity, security rules and storage KMS permissions. RDS creates and manages the master credential in Secrets Manager; grant approved administrators access to its metadata and secret separately. No password is entered or exported.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review engine/version, the total writer-plus-reader count, private networking, encryption, backup retention and deletion protection. Serverless v2 uses provisioned engine mode with db.serverless instances and a capacity range per instance. Apply the saved plan. Two instances in distinct AZs provide a failover reader; one instance does not. Provision schema and least-privilege application users through the approved database deployment process.

## Verify
Wait for the cluster and all instances to become available. Retrieve the managed credential only through an authorized secure workflow. Connect over verified TLS from an approved client, test writes through writer_endpoint and suitable reads through reader_endpoint. Test application queries, failover, backup restoration and point-in-time recovery in an isolated environment. Enabling IAM authentication does not create database users or grant rds-db:connect permissions; configure those separately.

## Recovery
Keep the source database intact until application/data validation and cutover sign-off. Restore a snapshot or point in time into a separate compatible cluster, then validate before switching connections. Engine downgrades are not a rollback mechanism. Deletion protection and Terraform prevent_destroy require explicit reviewed changes before retirement. Before eventual deletion, choose an unused final snapshot identifier; the generated initial value is the cluster name followed by -final. Global databases, existing snapshots, replicas across regions and Serverless v1 use their corresponding existing builders.

https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.create.html
`, findings);
  },
} satisfies Blueprint;
