import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_RDS_ORACLE_SERVICE = {
  id: 'aws_service_rds_oracle', label: 'Set up a private Oracle RDS instance',
  description: 'Oracle 19c non-CDB with explicit edition/licensing, regional version/class checks, a private TLS-only client security group, encrypted gp3 and managed credentials.',
  emits: ['aws_db_instance', 'aws_db_subnet_group', 'aws_db_option_group', 'aws_security_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Database instance identifier', control: 'text' },
    { id: 'edition', label: 'Oracle edition and licensing', control: 'select', default: 'se2-li', options: [{ value: 'se2-li', label: 'Standard Edition 2 — license included' }, { value: 'se2-byol', label: 'Standard Edition 2 — bring your own license' }, { value: 'ee-byol', label: 'Enterprise Edition — bring your own license' }] },
    { id: 'version', label: 'Exact Oracle 19c regional engine version', control: 'text', hint: 'Required release-update string from describe-db-engine-versions, e.g. 19.0.0.0.ru-YYYY-MM.rur-YYYY-MM.rN. Confirm regional availability; no release is assumed.' },
    { id: 'instance', label: 'Database instance class', control: 'combo', default: 'db.m6i.large', options: ['db.m6i.large', 'db.m6i.xlarge', 'db.r6i.large', 'db.r6i.xlarge'].map(value => ({ value, label: value })), hint: 'Plan checks the exact regional engine/version/license/encryption offering. Review Oracle licensing and workload sizing separately.' },
    { id: 'availability', label: 'Availability', control: 'select', default: 'false', options: [{ value: 'false', label: 'Single-AZ DB instance' }, { value: 'true', label: 'Multi-AZ DB instance with standby' }] },
    { id: 'database', label: 'Initial Oracle database SID', control: 'text', default: 'APPDB', hint: 'This recipe creates a traditional Oracle 19c non-CDB. Use 1–8 alphanumeric characters beginning with a letter; avoid Oracle reserved words.' },
    { id: 'username', label: 'Master admin username', control: 'text', default: 'dbadmin', hint: 'RDS generates/manages the password in Secrets Manager.' },
    { id: 'subnets', label: 'Existing database subnet IDs', control: 'text', hint: 'Comma-separated IDs spanning at least two AZs in one VPC.' },
    { id: 'clients', label: 'Approved application client security group IDs', control: 'text', hint: '1–5 existing groups in the same VPC. A new database group permits these groups on TLS TCP 2484 only.' },
    { id: 'storage', label: 'Encrypted gp3 storage (GiB)', control: 'number', default: 100 },
    { id: 'kms', label: 'Storage KMS key ARN', control: 'text', hint: 'Optional regional customer-managed key; blank uses the AWS-managed RDS key.' },
    { id: 'secret_kms', label: 'Admin secret KMS key ARN', control: 'text', hint: 'Optional regional customer-managed credentials key.' },
    { id: 'retention', label: 'Automated backup retention (days)', control: 'number', default: 7 },
    { id: 'snapshot', label: 'Final snapshot identifier', control: 'text', hint: 'Optional; defaults to <instance>-final and must be unused at deletion.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.rds-oracle.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), edition = String(values.edition ?? ''), version = String(values.version ?? '').trim(), instance = String(values.instance ?? '').trim();
    const engine = edition === 'ee-byol' ? 'oracle-ee' : 'oracle-se2', license = edition === 'se2-li' ? 'license-included' : 'bring-your-own-license';
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name) || name.endsWith('-') || name.includes('--')) reject('name', 'Use a lowercase letter followed by up to 62 lowercase letters, digits or single internal hyphens.');
    if (!['se2-li', 'se2-byol', 'ee-byol'].includes(edition)) reject('edition', 'Choose SE2 license-included, SE2 BYOL or EE BYOL.');
    if (!/^19\.[A-Za-z0-9._-]{1,198}$/.test(version)) reject('version', 'Enter an exact available Oracle 19c engine release-update version.');
    if (!/^db\.[a-z0-9]+\.[a-z0-9]+$/.test(instance)) reject('instance', 'Enter an RDS instance class; regional compatibility is checked during plan.');
    const availability = String(values.availability ?? ''), database = String(values.database ?? '').trim(), username = String(values.username ?? '').trim();
    if (!['false', 'true'].includes(availability)) reject('availability', 'Select single-AZ or multi-AZ.');
    if (!/^[A-Za-z][A-Za-z0-9]{0,7}$/.test(database) || /^(SYS|SYSTEM|SELECT|DATABASE|RDSADMIN|DEFAULT|ORACLE)$/i.test(database)) reject('database', 'Use a nonreserved 1–8 character alphanumeric Oracle SID beginning with a letter.');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(username) || /^(sys|system|rdsadmin|admin|dbsnmp|outln|public|select|oracle)$/i.test(username)) reject('username', 'Use a nonreserved Oracle admin identifier, beginning with a letter, up to 30 characters.');
    const list = (key        ) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients');
    if (subnets.length < 2 || subnets.length > 20 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Use 2–20 subnet IDs in one VPC across at least two AZs.');
    if (!clients.length || clients.length > 5 || clients.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('clients', 'Use 1–5 approved client security groups in the database VPC.');
    const storage = Number(values.storage), retention = Number(values.retention), kms = String(values.kms ?? '').trim(), secretKms = String(values.secret_kms ?? '').trim(), snapshot = String(values.snapshot ?? '').trim() || name + '-final';
    if (!Number.isInteger(storage) || storage < 20 || storage > 65536) reject('storage', 'Use 20–65,536 whole GiB; plan checks the selected offering limits.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 35) reject('retention', 'Use 1–35 days of automated backups.');
    if (!/^[a-z][a-z0-9-]{0,254}$/.test(snapshot) || snapshot.endsWith('-') || snapshot.includes('--')) reject('snapshot', 'Use a valid final snapshot identifier without trailing/consecutive hyphens.');
    for (const [path, key] of [['kms', kms], ['secret_kms', secretKms]]) if (key && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(key)) reject(path , 'Use a regional KMS key ARN in the selected partition.');
    const result = awsServiceModule(region, [
      dat('aws_rds_engine_version', 'selected', { engine, version }),
      dat('aws_rds_orderable_db_instance', 'selected', { engine, engine_version: x('data.aws_rds_engine_version.selected.version_actual'), instance_class: instance, license_model: license, storage_type: 'gp3', vpc: true, supports_storage_encryption: true, ...(availability === 'true' ? { supports_multi_az: true } : {}) }),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'clients', { for_each: x('toset(' + JSON.stringify(clients) + ')'), id: x('each.value') }),
      res('aws_db_subnet_group', 'configured', { name: name + '-subnets', subnet_ids: subnets }, [blk('lifecycle', {}, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= 2 && alltrue([for group in data.aws_security_group.clients : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])'), error_message: 'Database subnets must span two AZs in one VPC and client groups must belong to that VPC.' })])]),
      res('aws_security_group', 'database', { name: name + '-tls', description: 'Oracle TLS from approved application groups', vpc_id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id'), tags: x(hcl({ Name: name + '-tls' })) }, [blk('ingress', { description: 'Oracle TLS clients', protocol: 'tcp', from_port: 2484, to_port: 2484, security_groups: clients })]),
      res('aws_db_option_group', 'tls', { name: name + '-tls', engine_name: engine, major_engine_version: '19', option_group_description: 'Oracle TLS 1.2 listener' }, [blk('option', { option_name: 'SSL', port: 2484, vpc_security_group_memberships: x('[aws_security_group.database.id]') }, [blk('option_settings', { name: 'SQLNET.SSL_VERSION', value: '1.2' })])]),
      res('aws_db_instance', 'configured', { identifier: name, engine, engine_version: x('data.aws_rds_engine_version.selected.version_actual'), instance_class: x('data.aws_rds_orderable_db_instance.selected.instance_class'), license_model: license, db_name: database, username, manage_master_user_password: true, ...(secretKms ? { master_user_secret_kms_key_id: secretKms } : {}), db_subnet_group_name: x('aws_db_subnet_group.configured.name'), vpc_security_group_ids: x('[aws_security_group.database.id]'), option_group_name: x('aws_db_option_group.tls.name'), port: 1521, publicly_accessible: false, multi_az: availability === 'true', storage_type: 'gp3', allocated_storage: storage, storage_encrypted: true, ...(kms ? { kms_key_id: kms } : {}), backup_retention_period: retention, deletion_protection: true, skip_final_snapshot: false, final_snapshot_identifier: snapshot, copy_tags_to_snapshot: true, apply_immediately: false, auto_minor_version_upgrade: false, allow_major_version_upgrade: false, tags: x(hcl({ Name: name })) }, [blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x(String(storage) + ' >= data.aws_rds_orderable_db_instance.selected.min_storage_size && ' + storage + ' <= data.aws_rds_orderable_db_instance.selected.max_storage_size'), error_message: 'Storage must fit the exact regional engine/class offering.' }), blk('precondition', { condition: x('data.aws_rds_engine_version.selected.parameter_group_family == ' + JSON.stringify(engine + '-19')), error_message: 'This recipe requires an Oracle 19c non-CDB engine.' })])]),
      output('database_address', 'aws_db_instance.configured.address'), output('tls_port', '2484'), output('database_sid', 'aws_db_instance.configured.db_name'), output('master_secret_arn', 'aws_db_instance.configured.master_user_secret[0].secret_arn'), output('engine_version', 'aws_db_instance.configured.engine_version_actual'), output('database_security_group_id', 'aws_security_group.database.id'),
      output('client_connect_descriptor', JSON.stringify('(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=${aws_db_instance.configured.address})(PORT=2484))(CONNECT_DATA=(SID=' + database + '))(SECURITY=(SSL_SERVER_DN_MATCH=YES)))')),
    ], `# Private Oracle 19c RDS

## Prepare
Use an exact regional Oracle 19c non-CDB version from aws rds describe-db-engine-versions --engine ${engine} --region ${region}. Confirm application compatibility, supported character set, capacity and licensing before provisioning. SE2 supports license-included or BYOL; EE uses BYOL. BYOL requires appropriate Oracle licenses and active support for the selected class and features. The package cannot determine license entitlement. Regional engine/orderable-instance data sources verify the requested offering during plan; they do not price it. CDB/PDB, RDS Custom and other major versions need separate workflows.

## Implement
Confirm private subnet routes, client security-group membership/egress, NACLs, DNS and KMS/Secrets Manager permissions. Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review edition/license, exact version/class, both AZs, storage, backup retention and the new TLS group; apply the saved reviewed plan. Wait for AVAILABLE and the SSL option to be in-sync. RDS manages the admin password; access its secret through an approved credential mechanism. No password is exported.

The DB has its normal 1521 listener, but the newly created attached security group permits only TLS 2484 from selected client groups. The SSL option does not itself turn off the plaintext listener. Do not attach additional groups or add 1521 ingress. Stateful response traffic needs no general outbound rule; optional integrations requiring outbound connections need separately reviewed rules.

Install the current regional RDS CA into the Oracle client trust wallet. Use the output TCPS descriptor, trusted CA, hostname/DN verification and the chosen database SID. Configure the wallet path for your client installation. Do not disable certificate verification or put credentials in exported files/command history. Establish least-privilege application schemas/users and migration tooling separately; this package does not import data or grant application privileges.

## Verify
Inspect describe-db-instances and describe-option-groups in ${region}: private endpoint, correct license/version, storage encryption, managed secret, backup retention and in-sync SSL option. Connect from an approved client using TCPS and run CHECK.sql. Validate the certificate and representative application transactions; a TCP 1521 connection from the same client must be blocked. Test from an unauthorized group too. Check every attached security group after future changes; permissions are additive. Configure audit policy/log export and monitoring to your applicable baseline separately. TLS encryption alone does not establish FIPS validation, federal product approval or authorization to host any data classification.

## Recovery
Test snapshot and point-in-time recovery into an isolated instance, including option-group/TLS configuration, schema, secret access and client reconnection. Multi-AZ is not a substitute for restore testing. Keep source data and rollback plans until application acceptance. Destruction requires explicit reviewed changes to Terraform prevent_destroy and RDS deletion protection; ensure the final snapshot name is unused. Review managed-secret lifecycle on deletion. Generation and local validation do not create a DB, run SQL or migrate data.

https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Oracle.Concepts.Licensing.html
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.Oracle.Options.SSL.OptionGroup.html
`, findings);
    return { ...result, files: { ...result.files, 'CHECK.sql': "SELECT SYS_CONTEXT('USERENV','DB_NAME') AS database_name, SYS_CONTEXT('USERENV','NETWORK_PROTOCOL') AS network_protocol FROM dual;\nSELECT banner FROM v$version;\n" } };
  },
}                    ;
