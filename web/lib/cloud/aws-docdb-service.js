import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_DOCDB_SERVICE = {
  id: 'aws_service_docdb', label: 'Set up a private DocumentDB instance cluster',
  description: 'Regional engine/class checks, 1–3 instances placed in distinct AZs, required TLS, scoped clients, managed credentials, backups and retained audit logging.',
  emits: ['aws_docdb_cluster', 'aws_docdb_cluster_instance', 'aws_docdb_subnet_group', 'aws_docdb_cluster_parameter_group', 'aws_security_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Cluster identifier', control: 'text' },
    { id: 'version', label: 'Regional DocumentDB engine version', control: 'text', default: '5.0.0', hint: 'Exact currently available instance-cluster version. This recipe supports the docdb4.0/5.0/8.0 families; plan resolves the matching family and orderable class.' },
    { id: 'instance', label: 'Instance class', control: 'combo', default: 'db.r6g.large', options: ['db.r6g.large', 'db.r6g.xlarge', 'db.r6g.2xlarge', 'db.r5.large', 'db.r5.xlarge'].map(value => ({ value, label: value })) },
    { id: 'nodes', label: 'Instance count', control: 'select', default: '3', options: [{ value: '1', label: '1 — no read replica/failover instance' }, { value: '2', label: '2 — writer and one replica in different AZs' }, { value: '3', label: '3 — writer and two replicas across three AZs' }] },
    { id: 'subnets', label: 'Existing private database subnet IDs', control: 'text', hint: 'Comma-separated IDs in one VPC, spanning at least two AZs, or three AZs for three instances.' },
    { id: 'clients', label: 'Application/admin client security group IDs', control: 'text', hint: '1–5 existing groups in that VPC; a new database group permits only those groups on TCP 27017.' },
    { id: 'username', label: 'Master admin username', control: 'text', default: 'dbadmin', hint: 'The service generates/manages the password in Secrets Manager. No password is exported.' },
    { id: 'storage', label: 'Cluster storage pricing model', control: 'select', default: 'standard', options: [{ value: 'standard', label: 'Standard — storage plus I/O charges' }, { value: 'iopt1', label: 'I/O-Optimized — check regional engine/class support and pricing' }] },
    { id: 'kms', label: 'Storage KMS key ARN', control: 'text', hint: 'Optional regional symmetric customer-managed key; blank uses AWS-managed DocumentDB storage encryption. The managed admin secret uses its service-supported encryption configuration separately.' },
    { id: 'retention', label: 'Automated backup retention (days)', control: 'number', default: 7 },
    { id: 'audit', label: 'Audit events', control: 'select', default: 'ddl', options: [{ value: 'ddl', label: 'DDL, authentication, authorization and user management' }, { value: 'ddl,dml_write', label: 'DDL plus data writes' }, { value: 'all', label: 'All supported audit events, including reads — review log volume' }] },
    { id: 'log_days', label: 'Audit log retention (days)', control: 'select', default: '90', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'snapshot', label: 'Final snapshot identifier', control: 'text', hint: 'Optional; defaults to <cluster>-final and must be unused at deletion.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.docdb.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), version = String(values.version ?? '').trim(), instance = String(values.instance ?? '').trim(), username = String(values.username ?? '').trim(), storage = String(values.storage ?? ''), kms = String(values.kms ?? '').trim(), audit = String(values.audit ?? ''), snapshot = String(values.snapshot ?? '').trim() || name + '-final';
    const nodes = Number(values.nodes), retention = Number(values.retention), logDays = Number(values.log_days);
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients');
    if (!/^[a-z][a-z0-9-]{0,54}$/.test(name) || name.endsWith('-') || name.includes('--')) reject('name', 'Use a lowercase letter followed by up to 54 lowercase letters, digits or single internal hyphens.');
    if (!/^(?:4|5|8)\.0(?:\.\d+)?$/.test(version)) reject('version', 'Enter an exact available 4.0, 5.0 or 8.0 family engine version.');
    if (!/^db\.[a-z0-9]+\.[a-z0-9]+$/.test(instance)) reject('instance', 'Enter a supported instance class; plan checks the regional offering.');
    if (![1, 2, 3].includes(nodes)) reject('nodes', 'Choose 1, 2 or 3 instances.');
    if (subnets.length < Math.max(2, nodes) || subnets.length > 20 || subnets.some(subnet => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(subnet))) reject('subnets', 'Provide enough existing subnets for at least two AZs and one distinct AZ per instance.');
    if (!clients.length || clients.length > 5 || clients.some(group => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(group))) reject('clients', 'Use 1–5 existing same-VPC client security group IDs.');
    if (!/^[A-Za-z][A-Za-z0-9]{0,62}$/.test(username) || /^(admin|root|rdsadmin)$/i.test(username)) reject('username', 'Use a nonreserved master identifier beginning with a letter, up to 63 letters/digits.');
    if (!['standard', 'iopt1'].includes(storage)) reject('storage', 'Choose Standard or I/O-Optimized storage.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 35) reject('retention', 'Use 1–35 days of automated backups.');
    if (!['ddl', 'ddl,dml_write', 'all'].includes(audit)) reject('audit', 'Choose the supported audit event scope.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Choose audit log retention.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a regional symmetric KMS key ARN.');
    if (!/^[a-z][a-z0-9-]{0,254}$/.test(snapshot) || snapshot.endsWith('-') || snapshot.includes('--')) reject('snapshot', 'Use a valid final snapshot identifier without trailing/consecutive hyphens.');
    const azs = 'sort(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone]))';
    const result = awsServiceModule(region, [
      dat('aws_docdb_engine_version', 'selected', { engine: 'docdb', version }),
      dat('aws_docdb_orderable_db_instance', 'selected', { engine: 'docdb', engine_version: x('data.aws_docdb_engine_version.selected.version'), instance_class: instance, vpc: true }),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'clients', { for_each: x('toset(' + JSON.stringify(clients) + ')'), id: x('each.value') }),
      res('aws_docdb_subnet_group', 'configured', { name: name + '-subnets', subnet_ids: subnets }, [blk('lifecycle', {}, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(' + azs + ') >= ' + Math.max(2, nodes) + ' && alltrue([for group in data.aws_security_group.clients : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)]) && alltrue([for az in ' + azs + ' : contains(data.aws_docdb_orderable_db_instance.selected.availability_zones, az)])'), error_message: 'Use one VPC with enough distinct, regionally orderable AZs and client groups in that VPC.' })])]),
      res('aws_security_group', 'database', { name: name + '-database', description: 'DocumentDB approved clients', vpc_id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id'), tags: x(hcl({ Name: name + '-database' })) }, [blk('ingress', { protocol: 'tcp', from_port: 27017, to_port: 27017, security_groups: clients })]),
      res('aws_docdb_cluster_parameter_group', 'configured', { name: name + '-parameters', family: x('data.aws_docdb_engine_version.selected.parameter_group_family'), description: 'Required TLS and selected audit scope' }, [blk('parameter', { name: 'tls', value: 'tls1.2+', apply_method: 'pending-reboot' }), blk('parameter', { name: 'audit_logs', value: audit, apply_method: 'immediate' })]),
      res('aws_cloudwatch_log_group', 'audit', { name: '/aws/docdb/' + name + '/audit', retention_in_days: logDays }),
      res('aws_docdb_cluster', 'configured', { cluster_identifier: name, engine: 'docdb', engine_version: x('data.aws_docdb_engine_version.selected.version'), master_username: username, manage_master_user_password: true, port: 27017, storage_encrypted: true, storage_type: storage, ...(kms ? { kms_key_id: kms } : {}), db_subnet_group_name: x('aws_docdb_subnet_group.configured.name'), db_cluster_parameter_group_name: x('aws_docdb_cluster_parameter_group.configured.name'), vpc_security_group_ids: x('[aws_security_group.database.id]'), backup_retention_period: retention, deletion_protection: true, skip_final_snapshot: false, final_snapshot_identifier: snapshot, apply_immediately: false, allow_major_version_upgrade: false, enabled_cloudwatch_logs_exports: ['audit'], tags: x(hcl({ Name: name })), depends_on: x('[aws_cloudwatch_log_group.audit]') }, [blk('lifecycle', { prevent_destroy: true })]),
      res('aws_docdb_cluster_instance', 'configured', { count: nodes, identifier: x(JSON.stringify(name + '-node-${count.index + 1}')), cluster_identifier: x('aws_docdb_cluster.configured.id'), engine: 'docdb', instance_class: x('data.aws_docdb_orderable_db_instance.selected.instance_class'), availability_zone: x('element(' + azs + ', count.index)'), promotion_tier: x('count.index'), auto_minor_version_upgrade: true, apply_immediately: false, copy_tags_to_snapshot: true, tags: x(hcl({ Name: name })) }),
      output('cluster_endpoint', 'aws_docdb_cluster.configured.endpoint'), output('reader_endpoint', 'aws_docdb_cluster.configured.reader_endpoint'), output('master_secret_arn', 'aws_docdb_cluster.configured.master_user_secret[0].secret_arn'), output('engine_version', 'aws_docdb_cluster.configured.engine_version'),
      output('client_uri_without_credentials', JSON.stringify('mongodb://${aws_docdb_cluster.configured.endpoint}:27017/?tls=true&replicaSet=rs0&readPreference=primary&retryWrites=false&authSource=admin')),
    ], `# Private instance-based DocumentDB cluster

## Prepare
Confirm application/query/index/transaction compatibility with DocumentDB rather than assuming full MongoDB equivalence. Regional data sources check the exact engine, parameter family and instance-class offering; review I/O-Optimized availability and cost separately before choosing that storage model. Provide private subnets with sufficient free addresses and one distinct AZ per instance (minimum two subnet AZs). One instance has no read replica; three instances use three AZs. Storage replication and instance failover are different features.

## Implement
Review private routing, client group membership/egress, NACLs, DNS and KMS/Secrets Manager permissions. Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review node count, regional AZs, storage pricing model, TLS parameter, audit scope and backups; apply the reviewed plan. Wait for cluster/instances to be available and parameters in sync. Install the current AWS trust bundle and use a supported driver with TLS CA and hostname verification, replicaSet=rs0 and retryWrites=false. The output URI has no credentials; obtain the DocumentDB-managed admin secret through an approved mechanism. Create least-privilege application database users through a trusted client rather than using master credentials for application traffic.

The custom group requires tls1.2+; verify support for the deployed engine patch and the applied value. Audit configuration sets both audit_logs and audit export, with explicit CloudWatch retention. DML/all auditing can expose query data and generate substantial log volume; align scope, access and retention with the data owner's requirements. Profiler logging and application observability are separate. This recipe does not configure a FIPS mode or establish authorization for any classification.

## Verify
Inspect aws docdb describe-db-clusters --db-cluster-identifier ${name} --region ${region} and describe-db-instances. Check private endpoint, storage encryption, secret status, node AZs, TLS/audit parameters and backups. From an approved client, run CHECK.js through mongosh using the trusted CA and an approved credential prompt/mechanism. Verify representative application reads/writes, indexes, roles and audit records; plaintext and unauthorized-source access must fail. Test failover/reconnect using an approved procedure and verify replica lag and read-consistency behavior before choosing a reader endpoint/read preference. No database writes are included in CHECK.js.

## Recovery
Test snapshot and point-in-time restore into an isolated new cluster, including TLS group, secret access, node creation and application reconnection. Retain source data and acceptance/cutback procedures until migration sign-off. Replica promotion does not recover accidental deletions; restore testing remains necessary. Deletion requires reviewed changes to Terraform prevent_destroy and service deletion protection, and an unused final snapshot name. Managed-secret lifecycle must be included in the removal plan. Elastic clusters, global clusters, serverless variants, data import and schema/user migration use separate workflows. Local generation/validation does not provision resources or connect to the database.

https://docs.aws.amazon.com/documentdb/latest/devguide/security.encryption.ssl.html
https://docs.aws.amazon.com/documentdb/latest/devguide/event-auditing.html
`, findings);
    return { ...result, files: { ...result.files, 'CHECK.js': 'db.adminCommand({ ping: 1 });\ndb.adminCommand({ hello: 1 });\ndb.adminCommand({ getEngineVersion: 1 });\n' } };
  },
}                    ;
