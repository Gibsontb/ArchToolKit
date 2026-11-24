import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
const engines = ['sqlserver-ex', 'sqlserver-web', 'sqlserver-se', 'sqlserver-ee'];
export const AWS_RDS_SQLSERVER_SERVICE = {
  id: 'aws_service_rds_sqlserver', label: 'Set up a private SQL Server RDS instance',
  description: 'Configure a license-included SQL Server edition with regional engine/class checks, a TLS parameter group, managed credentials, backups and application database SQL.',
  emits: ['aws_db_instance', 'aws_db_subnet_group', 'aws_db_parameter_group', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Database instance identifier', control: 'text' },
    { id: 'engine', label: 'License-included SQL Server edition', control: 'select', default: 'sqlserver-se', options: [{ value: 'sqlserver-ex', label: 'Express' }, { value: 'sqlserver-web', label: 'Web' }, { value: 'sqlserver-se', label: 'Standard' }, { value: 'sqlserver-ee', label: 'Enterprise' }] },
    { id: 'version', label: 'Exact regional engine version', control: 'text', hint: 'Optional. Blank resolves the current AWS default during Terraform plan. Pin the resolved version for repeatable production plans.' },
    { id: 'instance', label: 'Database instance class', control: 'combo', default: 'auto', options: [{ value: 'auto', label: 'Auto — first available edition-specific preferred class' }, ...['db.t3.small', 'db.t3.medium', 'db.m5.large', 'db.m6i.large', 'db.m6i.xlarge', 'db.r6i.large', 'db.r6i.xlarge'].map(value => ({ value, label: value }))], hint: 'Auto tries t3.small/medium/large for Express/Web and m6i.large/m5.large/r6i.large for Standard/Enterprise. Review the resolved class and costs in plan.' },
    { id: 'availability', label: 'Availability', control: 'select', default: 'false', showWhen: { input: 'engine', equals: ['sqlserver-web', 'sqlserver-se', 'sqlserver-ee'] }, options: [{ value: 'false', label: 'Single-AZ DB instance' }, { value: 'true', label: 'Multi-AZ — requires regional edition/version support' }] },
    { id: 'database', label: 'Application database to bootstrap', control: 'text', default: 'application', hint: 'Exported SETUP.sql creates this database after the server is available; SQL Server RDS does not use db_name for this.' },
    { id: 'collation', label: 'Application database collation', control: 'combo', default: 'SQL_Latin1_General_CP1_CI_AS', options: ['SQL_Latin1_General_CP1_CI_AS', 'Latin1_General_100_CI_AS', 'Latin1_General_100_CS_AS'].map(value => ({ value, label: value })), hint: 'Verify application requirements and availability with SQL Server before running the bootstrap SQL.' },
    { id: 'username', label: 'Master admin username', control: 'text', default: 'dbadmin', hint: 'RDS manages the password in Secrets Manager. No password is entered or exported.' },
    { id: 'subnets', label: 'Existing database subnet IDs', control: 'text', hint: 'Comma-separated subnet IDs in one VPC and at least two AZs.' },
    { id: 'groups', label: 'Existing database security group IDs', control: 'text', hint: 'Comma-separated security groups in that VPC; permit approved application clients on TCP 1433.' },
    { id: 'storage', label: 'Encrypted gp3 storage (GiB)', control: 'number', default: 100, hint: '20–16,384 GiB in this recipe. Terraform checks the selected engine/class offering\'s actual storage limits.' },
    { id: 'kms', label: 'Storage KMS key ARN', control: 'text', hint: 'Optional regional customer-managed storage key; otherwise AWS-managed RDS encryption.' },
    { id: 'secret_kms', label: 'Admin secret KMS key ARN', control: 'text', hint: 'Optional separate regional customer-managed key for the generated credentials secret.' },
    { id: 'retention', label: 'Automated backup retention (days)', control: 'number', default: 7 },
    { id: 'log_days', label: 'SQL Server error log retention (days)', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'snapshot', label: 'Final snapshot identifier', control: 'text', hint: 'Optional. Defaults to <instance>-final; must be unused when deletion is explicitly approved.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.rds-sqlserver.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), engine = String(values.engine ?? ''), version = String(values.version ?? '').trim(), instance = String(values.instance ?? '').trim();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name) || name.endsWith('-') || name.includes('--')) reject('name', 'Use a lowercase letter followed by up to 62 lowercase letters, numbers or single internal hyphens.');
    if (!engines.includes(engine)) reject('engine', 'Choose a license-included SQL Server edition.');
    if (version && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(version)) reject('version', 'Use an exact regional engine version without spaces/control characters, or leave blank for the AWS default.');
    if (instance !== 'auto' && !/^db\.[a-z0-9]+\.[a-z0-9]+$/.test(instance)) reject('instance', 'Choose auto or enter an RDS instance class; plan checks regional engine compatibility.');
    const availability = engine === 'sqlserver-ex' ? 'false' : String(values.availability ?? '');
    if (!['false', 'true'].includes(availability)) reject('availability', 'Select single-AZ or an available multi-AZ configuration.');
    const database = String(values.database ?? '').trim(), collation = String(values.collation ?? '').trim(), username = String(values.username ?? '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(database) || /^(master|model|msdb|tempdb|rdsadmin)$/i.test(database)) reject('database', 'Use a new non-system application database identifier, up to 128 letters, numbers or underscores.');
    if (!/^[A-Za-z][A-Za-z0-9_]{1,127}$/.test(collation)) reject('collation', 'Enter a SQL Server collation name without whitespace, punctuation or control characters.');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(username) || /^(sa|guest|rdsadmin)$/i.test(username)) reject('username', 'Use a nonreserved master username beginning with a letter, up to 128 letters, numbers or underscores.');
    const list = (key        ) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups');
    if (subnets.length < 2 || subnets.length > 20 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Use 2–20 subnet IDs spanning at least two AZs in one VPC.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Use 1–5 security groups in the database VPC.');
    const storage = Number(values.storage), retention = Number(values.retention), logDays = Number(values.log_days), kms = String(values.kms ?? '').trim(), secretKms = String(values.secret_kms ?? '').trim(), snapshot = String(values.snapshot ?? '').trim() || name + '-final';
    if (!Number.isInteger(storage) || storage < 20 || storage > 16384) reject('storage', 'Use 20–16,384 whole GiB; actual offering limits are checked during plan.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 35) reject('retention', 'Use 1–35 days of automated backup retention.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Choose error-log retention.');
    if (!/^[a-z][a-z0-9-]{0,254}$/.test(snapshot) || snapshot.endsWith('-') || snapshot.includes('--')) reject('snapshot', 'Use a valid lowercase final snapshot identifier with no trailing/consecutive hyphens.');
    for (const [path, key] of [['kms', kms], ['secret_kms', secretKms]]) if (key && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(key)) reject(path , 'Use a regional KMS key ARN in the selected partition.');
    const result = awsServiceModule(region, [
      dat('aws_rds_engine_version', 'selected', { engine, ...(version ? { version } : { default_only: true }) }),
      dat('aws_rds_orderable_db_instance', 'selected', { engine, engine_version: x('data.aws_rds_engine_version.selected.version_actual'), ...(instance === 'auto' ? { preferred_instance_classes: ['sqlserver-ex', 'sqlserver-web'].includes(engine) ? ['db.t3.small', 'db.t3.medium', 'db.t3.large'] : ['db.m6i.large', 'db.m5.large', 'db.r6i.large'] } : { instance_class: instance }), license_model: 'license-included', storage_type: 'gp3', vpc: true, supports_storage_encryption: true, ...(availability === 'true' ? { supports_multi_az: true } : {}) }),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }), dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_db_subnet_group', 'configured', { name: name + '-subnets', subnet_ids: subnets }, [blk('lifecycle', {}, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= 2 && alltrue([for group in data.aws_security_group.selected : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])'), error_message: 'Database subnets must span two AZs in one VPC, with security groups in that VPC.' })])]),
      res('aws_db_parameter_group', 'tls', { name: name + '-tls', family: x('data.aws_rds_engine_version.selected.parameter_group_family') }, [blk('parameter', { name: 'rds.force_ssl', value: '1', apply_method: 'pending-reboot' })]),
      res('aws_cloudwatch_log_group', 'error', { name: '/aws/rds/instance/' + name + '/error', retention_in_days: logDays }),
      res('aws_db_instance', 'configured', { identifier: name, engine, engine_version: x('data.aws_rds_engine_version.selected.version_actual'), instance_class: x('data.aws_rds_orderable_db_instance.selected.instance_class'), license_model: 'license-included', username, manage_master_user_password: true, ...(secretKms ? { master_user_secret_kms_key_id: secretKms } : {}), db_subnet_group_name: x('aws_db_subnet_group.configured.name'), vpc_security_group_ids: groups, parameter_group_name: x('aws_db_parameter_group.tls.name'), port: 1433, publicly_accessible: false, multi_az: availability === 'true', storage_type: 'gp3', allocated_storage: storage, storage_encrypted: true, ...(kms ? { kms_key_id: kms } : {}), backup_retention_period: retention, deletion_protection: true, skip_final_snapshot: false, final_snapshot_identifier: snapshot, copy_tags_to_snapshot: true, apply_immediately: false, allow_major_version_upgrade: false, auto_minor_version_upgrade: false, enabled_cloudwatch_logs_exports: ['error'], tags: x(hcl({ Name: name })), depends_on: x('[aws_cloudwatch_log_group.error]') }, [blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x(String(storage) + ' >= data.aws_rds_orderable_db_instance.selected.min_storage_size && ' + storage + ' <= data.aws_rds_orderable_db_instance.selected.max_storage_size'), error_message: 'Allocated storage must fit the exact regional engine/class offering.' })])]),
      output('database_address', 'aws_db_instance.configured.address'), output('database_port', 'aws_db_instance.configured.port'), output('engine_version', 'aws_db_instance.configured.engine_version_actual'), output('instance_class', 'aws_db_instance.configured.instance_class'), output('master_secret_arn', 'aws_db_instance.configured.master_user_secret[0].secret_arn'),
      output('client_config_json', jsonencode({ server: e('aws_db_instance.configured.address'), port: 1433, database, encrypt: true, trustServerCertificate: false })),
    ], `# Private SQL Server RDS with required TLS

## Prepare
Review regional edition/version/class availability, license-included pricing/terms, database compatibility, private routing/security groups and KMS/Secrets Manager permissions. The generated data sources resolve the selected version (or current AWS default), matching parameter-group family and exact orderable class/license/gp3 offering during plan. Pin the resolved version for repeatable production changes. Express uses single-AZ; other editions request Multi-AZ only when selected and regionally supported. Confirm the collation with the application owner. Existing security groups must permit approved clients on TCP 1433; this package does not create or broaden rules.

Automatic class selection uses only the bounded preferred list shown in the form, in order. If none is available for the requested edition/version/storage/availability, planning fails and you must choose a supported explicit class or adjust requirements. It does not search for an arbitrary larger instance or calculate a price recommendation. The resolved class is an output and must be reviewed for workload sizing and cost before apply.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the resolved version, edition/class availability, TLS parameter group, encrypted storage, generated secret, backup/log retention and availability. Apply the saved reviewed plan and wait for AVAILABLE. RDS generates/manages the master password in Secrets Manager; only its ARN is output. Retrieve it through an approved authorized mechanism. Install the current RDS CA trust bundle for the selected region/partition and configure a SQL Server client with encryption and certificate/hostname verification. Do not use TrustServerCertificate=true or a trust-bypass client flag.

SQL Server RDS does not create the application database through the DB instance db_name attribute. Review SETUP.sql and execute it once through the trusted TLS admin client after verifying that the database does not already exist and the collation is available. For example, use sqlcmd with the server address/port, encryption, an approved credential prompt/mechanism and -i SETUP.sql. Do not place the password in command history or exported files. Create least-privilege application logins/users and rotate/restrict bootstrap admin use separately.

## Verify
Use aws rds describe-db-instances --db-instance-identifier ${name} --region ${region}. Verify private access, encryption, managed secret, parameter-group status, version, backup settings and availability. Check that rds.force_ssl is 1 and that encrypted clients validate the RDS server certificate; an unencrypted connection must fail after the parameter applies. Execute CHECK.sql from the application network and verify application permissions, schema, collation and representative queries. Error-log export is configured with retention; SQL Server auditing, performance telemetry and application query logging are separate features. Test snapshot and point-in-time restore into an isolated instance, including endpoint, application database, users and secret recovery. Multi-AZ does not replace backup/restore testing.

## Recovery
Use approved database backups, rollback scripts and application cutback before schema/data migration. Pause clients during consistency-sensitive operations and preserve source data until acceptance. Review maintenance/mandatory engine-update policy independently; this recipe does not automatically authorize major upgrades. Terraform/AWS deletion protection both require explicit reviewed changes before removal. The final snapshot identifier must be unused at deletion, and deleting a managed-credential DB affects its secret lifecycle. RDS Custom, alternative SQL Server licensing/media options, AD integration, native restore/S3 roles, replicas, agent/audit options and application migration require additional workflows. No database, credentials or SQL commands are executed during package generation or local validation.

https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/SQLServer.Concepts.General.SSL.Using.html
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html
`, findings);
    return { ...result, files: { ...result.files,
      'SETUP.sql': 'CREATE DATABASE [' + database + '] COLLATE ' + collation + ';\nGO\nUSE [' + database + '];\nGO\nSELECT DB_NAME() AS database_name, SUSER_SNAME() AS login_name;\nGO\n',
      'CHECK.sql': "SELECT DB_NAME() AS database_name, SUSER_SNAME() AS login_name;\nSELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID;\nSELECT @@VERSION AS server_version;\n",
    } };
  },
}                    ;
