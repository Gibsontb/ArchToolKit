import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_NEPTUNE_SERVICE = {
  id: 'aws_service_neptune', label: 'Set up a private Neptune graph database',
  description: 'Provisioned or Serverless instances, encrypted private cluster, exact regional offering checks, IAM query roles, retained audit logs, backups and a read-only SDK check.',
  emits: ['aws_neptune_cluster', 'aws_neptune_cluster_instance', 'aws_neptune_subnet_group', 'aws_neptune_cluster_parameter_group', 'aws_security_group', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Cluster identifier', control: 'text' },
    { id: 'version', label: 'Regional Neptune engine version', control: 'text', default: '1.3.4.0', hint: 'Exact available engine patch; Terraform resolves the parameter family, IAM/encryption-capable class and supported AZs.' },
    { id: 'mode', label: 'Instance capacity model', control: 'select', default: 'PROVISIONED', options: [{ value: 'PROVISIONED', label: 'Provisioned instances' }, { value: 'SERVERLESS', label: 'Neptune Serverless instances' }] },
    { id: 'instance', label: 'Provisioned instance class', control: 'combo', default: 'db.r6g.large', options: ['db.r6g.large', 'db.r6g.xlarge', 'db.r5.large', 'db.r5.xlarge'].map(value => ({ value, label: value })), showWhen: { input: 'mode', equals: ['PROVISIONED'] } },
    { id: 'minimum', label: 'Minimum NCUs per Serverless instance', control: 'number', default: 2.5, showWhen: { input: 'mode', equals: ['SERVERLESS'] } },
    { id: 'maximum', label: 'Maximum NCUs per Serverless instance', control: 'number', default: 16, showWhen: { input: 'mode', equals: ['SERVERLESS'] }, hint: 'This recipe supports 2.5–128 NCUs in half-unit increments; verify current regional limits and workload sizing.' },
    { id: 'nodes', label: 'Instance count', control: 'select', default: '2', options: [{ value: '1', label: 'One writer — no replica instance' }, { value: '2', label: 'Writer and one replica in different AZs' }, { value: '3', label: 'Writer and two replicas across three AZs' }] },
    { id: 'subnets', label: 'Private subnet IDs', control: 'text', hint: 'At least two subnet AZs; at least three for three instances. One VPC, with a distinct AZ for every instance.' },
    { id: 'clients', label: 'Existing client security group IDs', control: 'text', hint: '1–5 same-VPC groups; a new database group allows only those groups on HTTPS TCP 8182.' },
    { id: 'reader', label: 'Existing read-query IAM role ARN', control: 'text', hint: 'Same-account role. Grants engine status and query reads on this cluster resource ID, not all Neptune databases.' },
    { id: 'writer', label: 'Optional read/write-query IAM role ARN', control: 'text', hint: 'Separate same-account role. Adds read, write and delete-via-query permissions; no loader, ML, cluster administration or backup permissions.' },
    { id: 'kms', label: 'Optional storage KMS key ARN', control: 'text', hint: 'Existing enabled symmetric regional key; otherwise service-managed encrypted storage is used.' },
    { id: 'retention', label: 'Backup retention (days)', control: 'number', default: 7 },
    { id: 'log_days', label: 'Audit log retention (days)', control: 'select', default: '90', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'snapshot', label: 'Final snapshot identifier', control: 'text', hint: 'Optional; defaults to <cluster>-final. Must be unused when the cluster is removed.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.neptune.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), version = String(values.version ?? '').trim(), mode = String(values.mode ?? ''), instance = mode === 'SERVERLESS' ? 'db.serverless' : String(values.instance ?? '').trim(), reader = String(values.reader ?? '').trim(), writer = String(values.writer ?? '').trim(), kms = String(values.kms ?? '').trim(), snapshot = String(values.snapshot ?? '').trim() || name + '-final';
    const nodes = Number(values.nodes), minimum = mode === 'SERVERLESS' ? Number(values.minimum) : 0, maximum = mode === 'SERVERLESS' ? Number(values.maximum) : 0, retention = Number(values.retention), logDays = Number(values.log_days);
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients');
    const rolePattern = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$'), account = rolePattern.exec(reader)?.[1] ?? '';
    if (!/^[a-z][a-z0-9-]{0,54}$/.test(name) || name.endsWith('-') || name.includes('--')) reject('name', 'Use a lowercase identifier up to 55 characters without trailing/consecutive hyphens.');
    if (!/^1\.\d+\.\d+\.\d+$/.test(version)) reject('version', 'Use an exact available Neptune 1.x engine patch.');
    if (!['PROVISIONED', 'SERVERLESS'].includes(mode)) reject('mode', 'Choose provisioned or Serverless instances.');
    if (mode === 'PROVISIONED' && (!/^db\.[a-z0-9]+\.[a-z0-9]+$/.test(instance) || instance === 'db.serverless')) reject('instance', 'Use a regional provisioned instance class.');
    if (mode === 'SERVERLESS' && (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 2.5 || maximum > 128 || minimum > maximum || !Number.isInteger(minimum * 2) || !Number.isInteger(maximum * 2))) reject('minimum', 'Use 2.5–128 NCUs in half-unit increments with minimum no larger than maximum.');
    if (![1, 2, 3].includes(nodes)) reject('nodes', 'Choose one, two or three instances.');
    if (subnets.length < Math.max(2, nodes) || subnets.length > 20 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Use at least two subnet AZs and one distinct AZ per instance.');
    if (!clients.length || clients.length > 5 || clients.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('clients', 'Use 1–5 same-VPC client group IDs.');
    if (!account) reject('reader', 'Use an existing same-account read role ARN.');
    if (writer && (!rolePattern.test(writer) || rolePattern.exec(writer)?.[1] !== account || writer === reader)) reject('writer', 'Use a separate existing write role in the read-role account.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing regional symmetric KMS key ARN.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 35) reject('retention', 'Use 1–35 backup retention days.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Choose an audit log retention period.');
    if (!/^[a-z][a-z0-9-]{0,254}$/.test(snapshot) || snapshot.endsWith('-') || snapshot.includes('--')) reject('snapshot', 'Use a valid unused final snapshot identifier.');
    const roles = [{ id: 'reader', arn: reader, write: false }, ...(writer ? [{ id: 'writer', arn: writer, write: true }] : [])];
    const azs = 'sort(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone]))';
    const databaseArn = 'format("arn:' + partition + ':neptune-db:' + region + ':%s:%s/*", data.aws_caller_identity.current.account_id, aws_neptune_cluster.configured.cluster_resource_id)';
    const guide = [
      '# Private IAM-authenticated Neptune database',
      '## Prepare\nValidate the graph model, query language/version, indexes, data size, concurrency and application driver compatibility. This is Neptune Database, not Neptune Analytics. Plan resolves exact regional engine version, parameter family, IAM/encryption-capable provisioned or db.serverless offering and selected subnet AZs. NCUs are per instance: replicas add capacity cost. Confirm current Serverless NCU limits and scale/latency behavior before selecting them. One instance has no replica failover target even though cluster storage is replicated. Provide private same-VPC subnets across at least two AZs and one distinct AZ per instance, sufficient addresses, approved client egress/NACLs and DNS. Existing IAM role trust and KMS policy/grants remain owner prerequisites.',
      '## Deploy\nRun terraform init, terraform validate and terraform plan -out=service.tfplan. Review private 8182-only security group, encrypted cluster, required IAM authentication, instances/AZs, backups, query-role policies and audit parameter/export. Apply the reviewed plan and wait for all instances and the cluster to be available. Verify parameter group status on every instance; neptune_enable_audit_log is static, so existing-instance parameter changes require a controlled reboot before they are active. The package configures audit collection and retained CloudWatch export; validate delivery and sensitive query/log handling. Major engine upgrades and immediate application are disabled. No database password is generated.',
      '## Query access and verification\nIAM query policies use the Neptune DATABASE resource ARN derived from cluster_resource_id, not the cluster management ARN. Read and optional write roles are distinct; write includes delete-via-query, and both roles can read engine status. Permissions apply across this database, without graph/tenant/row isolation; design separate clusters or an application authorization layer if needed. No broad neptune-db:* grant, loader or cluster-management permission is added. Install approved requirements.txt, assume the read role through the normal credential chain, then run CHECK.py from the applied package inside the client network. It checks engine status over TLS with SigV4 and certificate/hostname verification. Optional --query runs only RETURN 1 AS readiness through openCypher, without reading graph records or writing data. Inspect private endpoints, node AZs, actual encryption/IAM mode, audit logs, backup retention and parameters. Verify representative application reads and approved pilot writes separately; reject unsigned and unauthorized-source requests.',
      '## Migration and cutover\nInventory source graph/schema conventions, identifiers, RDF/property-graph model, query semantics, transactions, export format and application dependencies. Select a separately approved export/transform/bulk-load/replay process, prepare a private staging bucket and least-privilege loader role if required, then prove sample conversion and full count/integrity checks. This package creates an empty target and grants no bulk-loader access. Freeze/replay writes, reconcile duplicates/IDs, validate application queries and obtain owner acceptance before endpoint cutover. Preserve source and replay checkpoints until a tested rollback/write-reconciliation procedure can meet the agreed recovery objectives.',
      '## Recovery\nTest snapshot and point-in-time restore into an isolated new cluster, including instances, IAM query policies for the NEW resource ID, security groups, parameter groups and application endpoint changes. A replica does not recover logical deletion. Retain/export audit logs and source data under the actual records/data policy. Cluster deletion requires reviewed removal of Terraform prevent_destroy and service deletion protection plus an unused final snapshot identifier. Global databases, Analytics graphs, bulk loading, Streams/CDC and graph transformation require separate workflows. Local generation/validation provisions no cluster and runs no graph queries.',
      'https://docs.aws.amazon.com/neptune/latest/userguide/iam-auth.html\nhttps://docs.aws.amazon.com/neptune/latest/userguide/iam-dp-actions.html\nhttps://docs.aws.amazon.com/neptune/latest/userguide/auditing.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_neptune_engine_version', 'selected', { engine: 'neptune', version }),
      dat('aws_neptune_orderable_db_instance', 'selected', { engine: 'neptune', engine_version: x('data.aws_neptune_engine_version.selected.version'), instance_class: instance, vpc: true }),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'clients', { for_each: x('toset(' + JSON.stringify(clients) + ')'), id: x('each.value') }),
      ...roles.map(role => dat('aws_iam_role', role.id, { name: rolePattern.exec(role.arn)?.[2]?.split('/').at(-1) ?? '' })),
      ...(kms ? [dat('aws_kms_key', 'storage', { key_id: kms })] : []),
      res('aws_neptune_subnet_group', 'configured', { name: name + '-subnets', subnet_ids: subnets }, [blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_neptune_orderable_db_instance.selected.supports_iam_database_authentication && data.aws_neptune_orderable_db_instance.selected.supports_storage_encryption && contains(data.aws_neptune_engine_version.selected.exportable_log_types, "audit") && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(' + azs + ') >= ' + Math.max(2, nodes) + ' && alltrue([for az in ' + azs + ' : contains(data.aws_neptune_orderable_db_instance.selected.availability_zones, az)]) && alltrue([for group in data.aws_security_group.clients : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])' + roles.map(role => ' && data.aws_iam_role.' + role.id + '.arn == ' + JSON.stringify(role.arn)).join('') + (kms ? ' && data.aws_kms_key.storage.enabled && data.aws_kms_key.storage.key_spec == "SYMMETRIC_DEFAULT"' : '')), error_message: 'Use this account roles, an IAM/encryption/audit-capable offering, enough distinct same-VPC subnet AZs, matching client groups and enabled symmetric key.' })])]),
      res('aws_security_group', 'database', { name: name + '-graph', description: 'Approved Neptune HTTPS clients', vpc_id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id') }, [blk('ingress', { protocol: 'tcp', from_port: 8182, to_port: 8182, security_groups: clients })]),
      res('aws_neptune_cluster_parameter_group', 'configured', { name: name + '-parameters', family: x('data.aws_neptune_engine_version.selected.parameter_group_family'), description: 'Enable graph audit logging' }, [blk('parameter', { name: 'neptune_enable_audit_log', value: '1', apply_method: 'pending-reboot' })]),
      res('aws_cloudwatch_log_group', 'audit', { name: '/aws/neptune/' + name + '/audit', retention_in_days: logDays }),
      res('aws_neptune_cluster', 'configured', { cluster_identifier: name, engine: 'neptune', engine_version: x('data.aws_neptune_engine_version.selected.version'), port: 8182, storage_encrypted: true, ...(kms ? { kms_key_arn: x('data.aws_kms_key.storage.arn') } : {}), iam_database_authentication_enabled: true, neptune_subnet_group_name: x('aws_neptune_subnet_group.configured.name'), neptune_cluster_parameter_group_name: x('aws_neptune_cluster_parameter_group.configured.name'), vpc_security_group_ids: x('[aws_security_group.database.id]'), backup_retention_period: retention, enable_cloudwatch_logs_exports: ['audit'], deletion_protection: true, skip_final_snapshot: false, final_snapshot_identifier: snapshot, copy_tags_to_snapshot: true, apply_immediately: false, allow_major_version_upgrade: false, tags: x(hcl({ Name: name })), depends_on: x('[aws_cloudwatch_log_group.audit]') }, [
        ...(mode === 'SERVERLESS' ? [blk('serverless_v2_scaling_configuration', { min_capacity: minimum, max_capacity: maximum })] : []),
        blk('lifecycle', { prevent_destroy: true }),
      ]),
      res('aws_neptune_cluster_instance', 'configured', { count: nodes, identifier: x('format("%s-node-%s", ' + JSON.stringify(name) + ', count.index + 1)'), cluster_identifier: x('aws_neptune_cluster.configured.id'), engine: 'neptune', instance_class: x('data.aws_neptune_orderable_db_instance.selected.instance_class'), availability_zone: x('element(' + azs + ', count.index)'), neptune_subnet_group_name: x('aws_neptune_subnet_group.configured.name'), publicly_accessible: false, auto_minor_version_upgrade: true, apply_immediately: false, promotion_tier: x('count.index'), tags: x(hcl({ Name: name })) }),
      ...roles.map(role => res('aws_iam_role_policy', role.id, { name: name + '-graph-' + role.id, role: x('data.aws_iam_role.' + role.id + '.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['neptune-db:GetEngineStatus', 'neptune-db:ReadDataViaQuery', ...(role.write ? ['neptune-db:WriteDataViaQuery', 'neptune-db:DeleteDataViaQuery'] : [])], Resource: e(databaseArn) }] })) })),
      output('cluster_endpoint', 'aws_neptune_cluster.configured.endpoint'), output('reader_endpoint', 'aws_neptune_cluster.configured.reader_endpoint'), output('cluster_arn', 'aws_neptune_cluster.configured.arn'),
      output('database_resource_arn', databaseArn),
    ], guide, findings);
    const check = [
      'import argparse, json, subprocess',
      'import boto3',
      'from botocore.config import Config',
      'parser = argparse.ArgumentParser(description="Read-only Neptune engine status and optional constant query")',
      'parser.add_argument("--query", action="store_true")',
      'args = parser.parse_args()',
      'endpoint = subprocess.check_output(["terraform", "output", "-raw", "cluster_endpoint"], text=True).strip()',
      'if not endpoint or "/" in endpoint or ":" in endpoint or any(c.isspace() for c in endpoint): raise RuntimeError("Invalid cluster endpoint")',
      'client = boto3.client("neptunedata", region_name=' + JSON.stringify(region) + ', endpoint_url="https://" + endpoint + ":8182", verify=True, config=Config(connect_timeout=10, read_timeout=30, retries={"total_max_attempts": 1}))',
      'try:',
      '    status = client.get_engine_status()',
      '    print(json.dumps({key: status.get(key) for key in ["status", "role", "dbEngineVersion"]}))',
      '    if status.get("status") != "healthy": raise RuntimeError("Engine does not report healthy")',
      '    if args.query: print(json.dumps(client.execute_open_cypher_query(openCypherQuery="RETURN 1 AS readiness").get("results")))',
      'finally:',
      '    client.close()',
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'CHECK.py': check, 'requirements.txt': 'boto3>=1.35,<2\n' } };
  },
}                    ;
