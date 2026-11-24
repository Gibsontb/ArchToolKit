import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_RDS_PROXY_SERVICE = {
  id: 'aws_service_rds_proxy', label: 'Set up a TLS database connection proxy',
  description: 'Create a private MySQL/PostgreSQL RDS Proxy, scoped secret-access role, connection pool and target registration.',
  emits: ['aws_iam_role', 'aws_iam_role_policy', 'aws_db_proxy', 'aws_db_proxy_default_target_group', 'aws_db_proxy_target'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Proxy name', control: 'text' },
    { id: 'family', label: 'Database engine family', control: 'select', default: 'POSTGRESQL', options: [{ value: 'POSTGRESQL', label: 'PostgreSQL / Aurora PostgreSQL' }, { value: 'MYSQL', label: 'MySQL / Aurora MySQL' }] },
    { id: 'target_type', label: 'Existing database target', control: 'select', default: 'cluster', options: [{ value: 'cluster', label: 'Aurora DB cluster' }, { value: 'instance', label: 'RDS DB instance' }] },
    { id: 'target', label: 'Existing database identifier', control: 'text', hint: 'An available supported DB cluster or instance in this account, region and VPC.' },
    { id: 'secret', label: 'Existing database credential secret ARN', control: 'text', hint: 'Regional Secrets Manager secret containing the matching database username and password. No secret content is read or exported.' },
    { id: 'kms', label: 'Credential secret KMS key ARN', control: 'text', hint: 'Required for a customer-managed secret key. Blank assumes the AWS-managed Secrets Manager key. The existing key policy must permit the generated proxy role.' },
    { id: 'subnets', label: 'Existing proxy subnet IDs', control: 'text', hint: 'Comma-separated IPv4-capable subnets across at least two supported Availability Zones in the database VPC.' },
    { id: 'groups', label: 'Existing proxy security group IDs', control: 'text', hint: 'Comma-separated groups in the subnet VPC. Permit client-to-proxy and proxy-to-database traffic separately.' },
    { id: 'iam', label: 'Client authentication', control: 'select', default: 'DISABLED', options: [{ value: 'DISABLED', label: 'Database credentials over TLS' }, { value: 'REQUIRED', label: 'Require IAM client authentication over TLS' }] },
    { id: 'connections', label: 'Maximum DB connection pool (%)', control: 'number', default: 80, min: 1, max: 100 },
    { id: 'idle', label: 'Maximum idle DB connections (%)', control: 'number', default: 40, min: 0, max: 100 },
    { id: 'borrow', label: 'Connection borrow timeout (seconds)', control: 'number', default: 120, min: 0, max: 3600 },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.rds-proxy.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), family = String(values.family ?? ''), targetType = String(values.target_type ?? ''), target = String(values.target ?? ''), secret = String(values.secret ?? '').trim(), kms = String(values.kms ?? '').trim(), iam = String(values.iam ?? '');
    if (!/^[a-z](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(name) || name.includes('--')) reject('name', 'Use 1–39 lowercase letters, numbers or single hyphens, beginning with a letter and ending with an alphanumeric character.');
    if (!['POSTGRESQL', 'MYSQL'].includes(family)) reject('family', 'Select PostgreSQL or MySQL.');
    if (!['cluster', 'instance'].includes(targetType)) reject('target_type', 'Select a cluster or instance target.');
    if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(target) || target.endsWith('-') || target.includes('--')) reject('target', 'Enter the existing DB identifier.');
    const parsedSecret = /^arn:([^:]+):secretsmanager:([^:]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/.exec(secret);
    if (!parsedSecret || parsedSecret[1] !== partition || parsedSecret[2] !== location) reject('secret', 'Use a credential secret ARN in the selected region and partition.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + location + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a secret encryption key ARN in this region and partition.');
    if (!['DISABLED', 'REQUIRED'].includes(iam)) reject('iam', 'Select client authentication.');
    const list = (key        ) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups');
    if (subnets.length < 2 || subnets.length > 16 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Enter 2–16 valid subnet IDs.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Enter 1–5 security group IDs.');
    const integer = (key        , min        , max        ) => { const value = Number(values[key]); if (values[key] === '' || !Number.isInteger(value) || value < min || value > max) reject(key, 'Enter a whole number from ' + min + ' to ' + max + '.'); return value; };
    const connections = integer('connections', 1, 100), idle = integer('idle', 0, 100), borrow = integer('borrow', 0, 3600);
    if (idle > connections) reject('idle', 'Idle connection percentage cannot exceed the maximum pool percentage.');
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_iam_role', 'proxy', { name_prefix: name + '-', assume_role_policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'rds.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }),
      res('aws_iam_role_policy', 'secret', { role: x('aws_iam_role.proxy.id'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: secret },
        ...(kms ? [{ Effect: 'Allow', Action: ['kms:Decrypt'], Resource: kms }] : []),
      ] })) }),
      res('aws_db_proxy', 'configured', { name, engine_family: family, role_arn: x('aws_iam_role.proxy.arn'), vpc_subnet_ids: subnets, vpc_security_group_ids: groups, require_tls: true, debug_logging: false, depends_on: x('[aws_iam_role_policy.secret]') }, [
        blk('auth', { auth_scheme: 'SECRETS', secret_arn: secret, iam_auth: iam }),
        blk('lifecycle', {}, [
          blk('precondition', { condition: x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.selected : group.vpc_id]))) == 1 && length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) >= 2 && alltrue([for subnet in data.aws_subnet.selected : !subnet.ipv6_native])'), error_message: 'Use IPv4-capable subnets across at least two AZs and security groups in the database VPC.' }),
          blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsedSecret?.[3] ?? '')), error_message: 'Use a credential secret in the deployment account.' }),
        ]),
      ]),
      res('aws_db_proxy_default_target_group', 'configured', { db_proxy_name: x('aws_db_proxy.configured.name') }, [blk('connection_pool_config', { max_connections_percent: connections, max_idle_connections_percent: idle, connection_borrow_timeout: borrow })]),
      res('aws_db_proxy_target', 'configured', { db_proxy_name: x('aws_db_proxy.configured.name'), target_group_name: x('aws_db_proxy_default_target_group.configured.name'), ...(targetType === 'cluster' ? { db_cluster_identifier: target } : { db_instance_identifier: target }) }),
      output('proxy_endpoint', 'aws_db_proxy.configured.endpoint'), output('secret_access_role_arn', 'aws_iam_role.proxy.arn'),
    ], `# TLS RDS Proxy for MySQL or PostgreSQL

## Prepare
Confirm RDS Proxy supports the database engine/version, target type and AZs in this region. The target must be in the same account and VPC as the proxy and use the selected engine family. Prepare client/proxy/database security rules and a matching username/password secret. Prefer a dedicated least-privilege application database user. RDS-managed master credentials can be referenced for a controlled test, but applications should not rely on master privileges. If the secret uses a customer-managed KMS key, supply it and authorize the generated role through the key policy before relying on proxy connectivity.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the generated role's exact secret/key access, private subnets, TLS, client authentication and connection-pool bounds. Apply the saved plan. No secret value is retrieved or placed in the exported files. The proxy uses the stored credential to connect to the database. IAM client authentication requires separate client rds-db:connect permissions and valid signed authentication tokens; this form does not configure end-to-end IAM database authentication.

## Verify
Inspect proxy target health until the database target is AVAILABLE. Test verified TLS connections through proxy_endpoint using the intended application identity, and test denied access. Exercise transactions, prepared statements, session state and connection pinning with the real workload. Monitor borrowed/available connections, latency, authentication failures and failover. SQL or driver behavior can reduce pooling benefits.

## Recovery
Keep the previous application connection configuration until tests pass. Restore its endpoint and authentication settings if proxy validation fails. Correct target health, security rules, secret schema or KMS policy before retrying. Changing or removing the proxy does not restore database contents or undo credential rotation. Coordinate secret and database password changes. Additional endpoints, read-only routing, multiple database users and SQL Server use their corresponding existing builders.

https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-creating.html
`, findings);
  },
}                    ;
