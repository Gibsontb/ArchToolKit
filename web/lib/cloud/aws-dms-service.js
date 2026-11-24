import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
export const AWS_DMS_SERVICE = {
  id: 'aws_service_dms_postgres', label: 'Set up a PostgreSQL data migration',
  description: 'Private classic DMS instance or existing host, secret-backed verified-TLS endpoints, exact table selection, validation and an operator-controlled start/report script.',
  emits: ['aws_dms_replication_instance', 'aws_dms_endpoint', 'aws_dms_replication_task', 'aws_dms_replication_subnet_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Migration identifier', control: 'text' },
    { id: 'mode', label: 'Data migration mode', control: 'select', default: 'full-load', options: [{ value: 'full-load', label: 'Full load — approved source write freeze' }, { value: 'full-load-and-cdc', label: 'Full load plus ongoing changes — prepared primary writer' }], hint: 'CDC requires logical replication/read privileges, selected-table primary keys and WAL/slot monitoring. Neither mode starts automatically.' },
    { id: 'host', label: 'Replication host', control: 'select', default: 'NEW', options: [{ value: 'NEW', label: 'Create a private DMS replication instance' }, { value: 'EXISTING', label: 'Use an existing private DMS replication instance' }] },
    { id: 'existing', label: 'Existing replication instance identifier', control: 'text', showWhen: { input: 'host', equals: ['EXISTING'] } },
    { id: 'version', label: 'Exact regional DMS engine version', control: 'text', showWhen: { input: 'host', equals: ['NEW'] }, hint: 'Required currently orderable version from describe-orderable-replication-instances.' },
    { id: 'instance', label: 'Replication instance class', control: 'combo', default: 'dms.r6i.large', showWhen: { input: 'host', equals: ['NEW'] }, options: ['dms.t3.medium', 'dms.r6i.large', 'dms.r6i.xlarge', 'dms.c6i.large'].map(value => ({ value, label: value })) },
    { id: 'storage', label: 'Replication storage (GiB)', control: 'number', default: 100, showWhen: { input: 'host', equals: ['NEW'] } },
    { id: 'availability', label: 'Replication host availability', control: 'select', default: 'true', showWhen: { input: 'host', equals: ['NEW'] }, options: [{ value: 'true', label: 'Multi-AZ' }, { value: 'false', label: 'Single-AZ' }] },
    { id: 'subnets', label: 'Existing private replication subnet IDs', control: 'text', showWhen: { input: 'host', equals: ['NEW'] }, hint: 'At least two comma-separated subnets in one VPC across different AZs.' },
    { id: 'groups', label: 'Existing replication security group IDs', control: 'text', showWhen: { input: 'host', equals: ['NEW'] }, hint: 'Same VPC, with approved source/target PostgreSQL, DNS and required service-endpoint connectivity.' },
    { id: 'kms', label: 'Replication storage KMS key ARN', control: 'text', showWhen: { input: 'host', equals: ['NEW'] }, hint: 'Optional regional customer-managed key; otherwise DMS default storage encryption.' },
    { id: 'secret_role', label: 'Existing DMS secret access role ARN', control: 'text', hint: 'Same-account role trusted for regional DMS secret access, scoped to both endpoint secrets and their KMS keys.' },
    { id: 'source_secret', label: 'Existing source migration secret ARN', control: 'text', hint: 'Must contain username, password, host and port. Use a dedicated migration user; RDS/Aurora managed master secrets may omit host/port.' },
    { id: 'source_database', label: 'Source PostgreSQL database', control: 'text' },
    { id: 'source_certificate', label: 'Imported source CA certificate ARN', control: 'text', hint: 'Existing regional DMS certificate ARN. Endpoint uses verify-full; secret host must match the server certificate.' },
    { id: 'target_secret', label: 'Existing target migration secret ARN', control: 'text', hint: 'Must contain username, password, host and port; target tables/schema must be prepared and empty.' },
    { id: 'target_database', label: 'Target PostgreSQL database', control: 'text' },
    { id: 'target_certificate', label: 'Imported target CA certificate ARN', control: 'text' },
    { id: 'parallel', label: 'Parallel full-load tables', control: 'number', default: 4, hint: '1–16 in this recipe; size against source/target load, replication memory and full-LOB behavior.' },
    { id: 'tables', label: 'Exact source tables to copy', control: 'textarea', default: 'public | ', hint: 'Schema | Table', help: '1–100 explicit case-sensitive tables. No wildcards; target uses the same schema/table names.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.dms.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), host = String(values.host ?? ''), existing = host === 'EXISTING' ? String(values.existing ?? '').trim() : '', version = host === 'NEW' ? String(values.version ?? '').trim() : '', instance = String(values.instance ?? '').trim(), role = String(values.secret_role ?? '').trim();
    const roleMatch = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role);
    const mode = String(values.mode ?? 'full-load'), cdc = mode === 'full-load-and-cdc';
    if (!['full-load', 'full-load-and-cdc'].includes(mode)) reject('mode', 'Choose full load or full load plus ongoing changes.');
    const identifier = /^[a-z][a-z0-9-]{0,49}$/;
    if (!identifier.test(name) || name.endsWith('-') || name.includes('--')) reject('name', 'Use a lowercase letter and up to 49 lowercase letters/digits/single internal hyphens.');
    if (!['NEW', 'EXISTING'].includes(host)) reject('host', 'Choose new or existing replication host.');
    if (host === 'EXISTING' && (!identifier.test(existing) || existing.endsWith('-') || existing.includes('--'))) reject('existing', 'Use the existing replication instance identifier.');
    if (!roleMatch) reject('secret_role', 'Use an existing same-account DMS secrets access role ARN.');
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = host === 'NEW' ? list('subnets') : [], groups = host === 'NEW' ? list('groups') : [], kms = host === 'NEW' ? String(values.kms ?? '').trim() : '', storage = Number(values.storage), availability = String(values.availability ?? ''), parallel = Number(values.parallel);
    if (host === 'NEW') {
      if (!/^\d+\.\d+\.\d+$/.test(version)) reject('version', 'Enter an exact regionally orderable DMS engine version.');
      if (!/^dms\.[a-z0-9]+\.[a-z0-9]+$/.test(instance)) reject('instance', 'Use an orderable DMS instance class.');
      if (!Number.isInteger(storage) || storage < 50 || storage > 6144) reject('storage', 'Use 50–6144 whole GiB within the actual regional offering limits.');
      if (!['true', 'false'].includes(availability)) reject('availability', 'Choose single- or multi-AZ.');
      if (subnets.length < 2 || subnets.length > 20 || subnets.some(id => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))) reject('subnets', 'Use 2–20 subnet IDs spanning at least two AZs in one VPC.');
      if (!groups.length || groups.length > 5 || groups.some(id => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))) reject('groups', 'Use 1–5 existing same-VPC replication groups.');
      if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a regional replication-storage KMS key ARN.');
    }
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) reject('parallel', 'Use 1–16 parallel tables.');
    const endpoints = ['source', 'target'].map(kind => {
      const secret = String(values[kind + '_secret'] ?? '').trim(), database = String(values[kind + '_database'] ?? '').trim(), certificate = String(values[kind + '_certificate'] ?? '').trim();
      if (!new RegExp('^arn:' + partition + ':secretsmanager:' + region + ':' + (roleMatch?.[1] ?? '\\d{12}') + ':secret:[A-Za-z0-9/_+=.@-]+$').test(secret)) reject(kind + '_secret', 'Use a same-account regional migration secret ARN.');
      if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(database)) reject(kind + '_database', 'Use the existing PostgreSQL database identifier, up to 63 characters.');
      if (!new RegExp('^arn:' + partition + ':dms:' + region + ':' + (roleMatch?.[1] ?? '\\d{12}') + ':cert:[A-Za-z0-9-]+$').test(certificate)) reject(kind + '_certificate', 'Use an existing same-account regional DMS certificate ARN.');
      return { kind, secret, database, certificate };
    });
    if (endpoints[0] .secret === endpoints[1] .secret && endpoints[0] .database === endpoints[1] .database) reject('target_secret', 'Do not use the same secret/database for source and target.');
    const rows = String(values.tables ?? '').split(/\r?\n/).map(row => row.trim()).filter(Boolean), selected = new Set        ();
    const rules                            = [];
    if (!rows.length || rows.length > 100) reject('tables', 'Specify 1–100 exact source schema/table pairs.');
    for (const [index, row] of rows.entries()) {
      const cells = row.split('|').map(value => value.trim()), [schema = '', table = ''] = cells, key = schema + '.' + table;
      if (cells.length !== 2 || [schema, table].some(value => !/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(value)) || selected.has(key)) { reject('tables', 'Row ' + (index + 1) + ' needs unique exact schema/table identifiers, without wildcard syntax.'); continue; }
      selected.add(key);
      rules.push({ 'rule-type': 'selection', 'rule-id': String(index + 1), 'rule-name': 'table' + (index + 1), 'object-locator': { 'schema-name': schema, 'table-name': table, 'table-type': 'table' }, 'rule-action': 'explicit' });
    }
    const instanceRef = host === 'NEW' ? 'aws_dms_replication_instance.configured' : 'data.aws_dms_replication_instance.selected';
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw ($Arguments[0] + " " + $Arguments[1] + " failed.") }; return ($raw | ConvertFrom-Json) }',
      "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json')",
      "if ($identity.Account -ne '" + (roleMatch?.[1] ?? '') + "') { throw 'Unexpected migration account.' }",
      ...(host === 'NEW' ? [
        "$offerings = Read-AwsJson @('dms','describe-orderable-replication-instances','--region','" + region + "','--output','json')",
        "$offerMatches = @($offerings.OrderableReplicationInstances | Where-Object { $_.EngineVersion -eq '" + version + "' -and $_.ReplicationInstanceClass -eq '" + instance + "' -and $_.ReleaseStatus -eq 'prod' -and $_.MinAllocatedStorage -le " + storage + " -and $_.MaxAllocatedStorage -ge " + storage + " })",
        "if ($offerMatches.Count -eq 0) { throw 'No production regional offering matches the exact class/version/storage.' }",
        "$network = Read-AwsJson @('ec2','describe-subnets','--subnet-ids'," + subnets.map(id => "'" + id + "'").join(',') + ",'--region','" + region + "','--output','json')",
        '$selectedZones = @($network.Subnets | ForEach-Object { $_.AvailabilityZone } | Select-Object -Unique)',
        '$compatible = @($offerMatches | Where-Object { $candidate = $_; @($selectedZones | Where-Object { $candidate.AvailabilityZones -notcontains $_ }).Count -eq 0 })',
        "if ($selectedZones.Count -lt 2 -or $compatible.Count -eq 0) { throw 'Selected subnet AZs do not match an orderable offering across at least two AZs.' }",
      ] : [
        "$hosts = Read-AwsJson @('dms','describe-replication-instances','--filters','Name=replication-instance-id,Values=" + existing + "','--region','" + region + "','--output','json')",
        "if (-not $hosts.ReplicationInstances -or @($hosts.ReplicationInstances).Count -ne 1 -or $hosts.ReplicationInstances[0].ReplicationInstanceIdentifier -ne '" + existing + "' -or $hosts.ReplicationInstances[0].PubliclyAccessible -or $hosts.ReplicationInstances[0].ReplicationInstanceStatus -ne 'available') { throw 'Use the configured available private replication instance.' }",
      ]),
      ...endpoints.flatMap(endpoint => [
        "$secret = Read-AwsJson @('secretsmanager','describe-secret','--secret-id','" + endpoint.secret + "','--region','" + region + "','--output','json')",
        "if ($secret.ARN -ne '" + endpoint.secret + "' -or $secret.DeletedDate) { throw 'Endpoint secret metadata is missing, unexpected or scheduled for deletion.' }",
      ]),
      "Write-Host 'Regional host/secret metadata checked; secret values were not read. Verify CA imports, secret host/port/credentials, permissions, database compatibility and target readiness separately.'",
    ].join('\n') + '\n';
    const settings = { TargetMetadata: { SupportLobs: true, FullLobMode: true, LimitedSizeLobMode: false, LobChunkSize: 64 }, FullLoadSettings: { TargetTablePrepMode: 'DO_NOTHING', MaxFullLoadSubTasks: parallel }, ValidationSettings: { EnableValidation: true, ValidationMode: 'ROW_LEVEL' }, ErrorBehavior: { DataErrorPolicy: 'STOP_TASK', DataTruncationErrorPolicy: 'STOP_TASK', TableErrorPolicy: 'STOP_TASK' }, Logging: { EnableLogging: true } };
    const guide = [
      '# PostgreSQL ' + (cdc ? 'full-load plus ongoing-change' : 'full-load') + ' data migration',
      '## Prepare\nThis classic DMS task copies explicitly selected PostgreSQL tables into matching target schemas/tables. It does not convert schema, users, sequences, constraints, functions, extensions or application code. Prepare compatible empty target tables and required control/validation permissions; test representative types, LOBs, keys and row-level validation in a pilot. Full LOB transfer and validation have engine/key/permission limitations. Review source/target version support and DMS task settings before deployment.',
      (cdc ? 'This is full load plus ongoing changes from a prepared PostgreSQL primary writer, with test_decoding and DDL capture disabled. Read replicas, CDC-only/custom LSN starts, existing-slot adoption and schema changes are outside this recipe. Read CDC-RUNBOOK.md and run SOURCE-CHECK.sql through an approved TLS psql session using the actual source migration identity before starting. ' : 'This is full-load only, not CDC. Quiesce source writes and establish an approved consistent-copy/cutover window; DMS does not guarantee an application-consistent cross-table snapshot merely because a full load succeeds. ') + 'Keep source authoritative until independent validation and application acceptance. DO_NOTHING avoids automatic drop/truncate of existing target tables but does not prevent inserts or creation of missing tables; pre-create and verify intended empty targets. Do not run against active production target data.',
      'Create dedicated source/target migration users and DMS-format Secrets Manager secrets containing username, password, host and port. RDS/Aurora managed master secrets can omit host/port and must not be blindly reused. No secret values are read/exported here. Confirm password-character/rotation compatibility, secret-role regional trust, GetSecretValue/DescribeSecret/KMS permissions and deployment GetRole/PassRole permissions. Import the trusted CA certificates into DMS; verify-full requires secret hostnames matching server certificates.',
      '## Provision\n' + (host === 'NEW' ? 'Check describe-orderable-replication-instances in ' + region + ' for the exact version/class/storage/availability before plan. Prepare dms-vpc-role and dms-cloudwatch-logs-role with their required trust/permissions. Private subnets need source/target routes, DNS and the required Secrets Manager/CloudWatch/service endpoints. Review free IPs, capacity, encryption and replication charges.' : 'Verify the existing private replication instance has compatible engine, spare capacity, network/endpoint access and approved maintenance. Prepare dms-cloudwatch-logs-role. This package does not alter the shared host configuration.'),
      'Run PREFLIGHT.ps1 to check the deployment account, regional host offering/AZs or existing private-host status, and nondeleted secret metadata without reading secret values. Then run terraform init, terraform validate and terraform plan -out=service.tfplan. Review exact tables, TLS certificates, secret references, target prep, LOB/validation/error settings and host. Apply the reviewed plan. The task is created without starting it. Subsequent Terraform applies ignore start_replication_task so manual operator running state is not reconciled back to false; never change host/endpoints/settings during an active copy without a coordinated stop. Set approved CloudWatch log retention/access after its generated log group exists; logs and control/validation tables can contain governed identifiers or failure details.',
      '## Execute and verify\nUse OPERATE.ps1 -Action TestConnections to test both endpoints; this establishes database connections but copies no tables. Wait for successful connection results. After backups, target-empty checks, source readiness, required full-load-only write freeze, application cutover/rollback approvals and independent schema review, use -Action Start -ConfirmTargetReady' + (cdc ? ' -ConfirmCdcReady' : '') + '. Start is allowed only for a new ready task and rechecks both connection results. It starts a real copy; it is never run during generation/local tests. -Action Report writes task/table-statistics metadata for review; protect those files. Reconcile row validation, errors, LOBs, independent counts/checksums, sequence state, constraints and application behavior. A completed task alone is not migration acceptance.',
      '## Recovery\nUse -Action Stop to request a stop and verify its resulting state before changing endpoints or source. Stopping does not undo target writes. Preserve source/backups and cut back applications through the approved plan; reconcile any target writes before switching authority. Do not blindly restart/reload into partially loaded targets: it can duplicate/conflict with data. Clean/reconcile under database-owner control and use reviewed resume/reload procedures outside this initial-start script. Protected Terraform resources require explicit review before destruction. No connection test, task start/stop or data copy is executed by local generation/validation.',
      'https://docs.aws.amazon.com/dms/latest/userguide/security_iam_secretsmanager.html\nhttps://docs.aws.amazon.com/dms/latest/userguide/CHAP_Tasks.CustomizingTasks.TableMapping.SelectionTransformation.Selections.html\nhttps://docs.aws.amazon.com/dms/latest/userguide/CHAP_Security.SSL.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'secret', { name: roleMatch?.[2]?.split('/').at(-1) ?? '' }), dat('aws_iam_role', 'logs', { name: 'dms-cloudwatch-logs-role' }),
      ...(host === 'NEW' ? [
        dat('aws_iam_role', 'vpc', { name: 'dms-vpc-role' }),
        dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }), dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
        res('aws_dms_replication_subnet_group', 'configured', { replication_subnet_group_id: name + '-subnets', replication_subnet_group_description: 'Private migration subnets', subnet_ids: subnets }, [blk('lifecycle', {}, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= 2 && alltrue([for group in data.aws_security_group.selected : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])'), error_message: 'Replication subnets must span two AZs in one VPC with groups in that VPC.' })])]),
        res('aws_dms_replication_instance', 'configured', { replication_instance_id: name + '-host', replication_instance_class: instance, engine_version: version, allocated_storage: storage, multi_az: availability === 'true', publicly_accessible: false, replication_subnet_group_id: x('aws_dms_replication_subnet_group.configured.id'), vpc_security_group_ids: groups, ...(kms ? { kms_key_arn: kms } : {}), auto_minor_version_upgrade: true, allow_major_version_upgrade: false, apply_immediately: false, tags: x(hcl({ Name: name })), depends_on: x('[data.aws_iam_role.vpc]') }, [blk('lifecycle', { prevent_destroy: true })]),
      ] : [dat('aws_dms_replication_instance', 'selected', { replication_instance_id: existing })]),
      ...endpoints.map(endpoint => res('aws_dms_endpoint', endpoint.kind, { endpoint_id: name + '-' + endpoint.kind, endpoint_type: endpoint.kind, engine_name: 'postgres', database_name: endpoint.database, secrets_manager_arn: endpoint.secret, secrets_manager_access_role_arn: role, certificate_arn: endpoint.certificate, ssl_mode: 'verify-full', tags: x(hcl({ Name: name + '-' + endpoint.kind })) }, [...(cdc && endpoint.kind === 'source' ? [blk('postgres_settings', { plugin_name: 'test_decoding', capture_ddls: false })] : []), blk('lifecycle', { prevent_destroy: true })])),
      res('aws_dms_replication_task', 'configured', { replication_task_id: name, migration_type: mode, replication_instance_arn: x(instanceRef + '.replication_instance_arn'), source_endpoint_arn: x('aws_dms_endpoint.source.endpoint_arn'), target_endpoint_arn: x('aws_dms_endpoint.target.endpoint_arn'), start_replication_task: false, table_mappings: x(jsonencode({ rules })), replication_task_settings: x(jsonencode(settings)), tags: x(hcl({ Name: name })), depends_on: x('[data.aws_iam_role.logs]') }, [blk('lifecycle', { prevent_destroy: true, ignore_changes: x('[start_replication_task]') }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(roleMatch?.[1] ?? '') + ' && data.aws_iam_role.secret.arn == ' + JSON.stringify(role) + ' && !' + instanceRef + '.publicly_accessible'), error_message: 'Use this account secret access role and a private replication host.' })])]),
      output('dms_job', '{ account = data.aws_caller_identity.current.account_id, region = ' + JSON.stringify(region) + ', task = aws_dms_replication_task.configured.replication_task_arn, instance = ' + instanceRef + '.replication_instance_arn, endpoints = [aws_dms_endpoint.source.endpoint_arn, aws_dms_endpoint.target.endpoint_arn] }'),
    ], guide, findings);
    return { ...result, files: { ...result.files, 'table-mappings.json': JSON.stringify({ rules }, null, 2) + '\n', 'task-settings.json': JSON.stringify(settings, null, 2) + '\n', 'PREFLIGHT.ps1': preflight, 'OPERATE.ps1': dmsOperatorScript.replaceAll('__DMS_TYPE__', mode).replaceAll('__DMS_NAME__', name).replaceAll('__DMS_REGION__', region).replaceAll('__DMS_ACCOUNT__', roleMatch?.[1] ?? ''), ...(cdc ? dmsPostgresCdcFiles(endpoints[0] .database, rules) : {}) } };
  },
}                    ;

const dmsOperatorScript = [
  "param([ValidateSet('Inspect','TestConnections','Start','Report','Stop')][string]$Action = 'Inspect', [switch]$ConfirmTargetReady, [switch]$ConfirmCdcReady)",
  "$ErrorActionPreference = 'Stop'",
  'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw ($Arguments[0] + " " + $Arguments[1] + " failed.") }; return ($raw | ConvertFrom-Json) }',
  '$jobJson = terraform output -json dms_job',
  "if ($LASTEXITCODE -ne 0) { throw 'Read the applied migration outputs from this package state.' }",
  '$job = $jobJson | ConvertFrom-Json',
  "if ($job.account -ne '__DMS_ACCOUNT__' -or $job.region -ne '__DMS_REGION__') { throw 'Migration output placement does not match this package.' }",
  "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json')",
  "if ($identity.Account -ne $job.account) { throw 'Unexpected migration account.' }",
  "$taskFilter = 'Name=replication-task-arn,Values=' + $job.task",
  "$tasks = Read-AwsJson @('dms','describe-replication-tasks','--filters',$taskFilter,'--without-settings','--region',$job.region,'--output','json')",
  "if (-not $tasks.ReplicationTasks -or @($tasks.ReplicationTasks).Count -ne 1) { throw 'Expected exactly the configured migration task.' }",
  '$task = @($tasks.ReplicationTasks)[0]',
  "if ($task.ReplicationTaskArn -ne $job.task -or $task.ReplicationTaskIdentifier -ne '__DMS_NAME__' -or $task.MigrationType -ne '__DMS_TYPE__' -or $task.ReplicationInstanceArn -ne $job.instance -or $task.SourceEndpointArn -ne $job.endpoints[0] -or $task.TargetEndpointArn -ne $job.endpoints[1]) { throw 'Migration task outputs do not match this package and configured host/endpoints.' }",
  "if ($Action -eq 'TestConnections') {",
  "  foreach ($endpoint in $job.endpoints) { $null = Read-AwsJson @('dms','test-connection','--replication-instance-arn',$job.instance,'--endpoint-arn',$endpoint,'--region',$job.region,'--output','json') }",
  "  Write-Host 'Connection tests requested; wait and inspect their status before starting.'",
  "} elseif ($Action -eq 'Start') {",
  "  if (-not $ConfirmTargetReady) { throw 'Start requires explicit -ConfirmTargetReady after backups, empty-target and cutover review (source freeze also required for full-load-only).' }",
  "  if ('__DMS_TYPE__' -eq 'full-load-and-cdc' -and -not $ConfirmCdcReady) { throw 'CDC Start also requires -ConfirmCdcReady after source checks, replication privileges, WAL monitoring and CDC runbook review.' }",
  "  if ($task.Status -ne 'ready') { throw 'Initial Start requires a ready task; resume/reload needs a separate reviewed procedure.' }",
  '  foreach ($endpoint in $job.endpoints) {',
  "    $connections = Read-AwsJson @('dms','describe-connections','--filters',('Name=replication-instance-arn,Values=' + $job.instance),('Name=endpoint-arn,Values=' + $endpoint),'--region',$job.region,'--output','json')",
  "    if (@($connections.Connections).Count -ne 1 -or @($connections.Connections)[0].Status -ne 'successful' -or @($connections.Connections)[0].EndpointArn -ne $endpoint -or @($connections.Connections)[0].ReplicationInstanceArn -ne $job.instance) { throw 'Both exact endpoint connection tests must be successful.' }",
  '  }',
  "  $null = Read-AwsJson @('dms','start-replication-task','--replication-task-arn',$job.task,'--start-replication-task-type','start-replication','--region',$job.region,'--output','json')",
  "} elseif ($Action -eq 'Stop') {",
  "  if ($task.Status -ne 'running') { throw 'Stop requires a running task; inspect/wait for the actual state first.' }",
  "  $null = Read-AwsJson @('dms','stop-replication-task','--replication-task-arn',$job.task,'--region',$job.region,'--output','json')",
  "} elseif ($Action -eq 'Report') {",
  "  $tables = Read-AwsJson @('dms','describe-table-statistics','--replication-task-arn',$job.task,'--region',$job.region,'--output','json')",
  "  $tasks | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath dms-task-report.json -Encoding UTF8",
  "  $tables | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath dms-table-statistics.json -Encoding UTF8",
  '}',
  "if ($Action -in @('Start','Stop')) { Write-Host ($Action + ' request accepted. Use Inspect/Report to read current state; this does not confirm final completion.') } else { $task | Format-List }",
].join('\n') + '\n';

function dmsPostgresCdcFiles(database        , rules                           )                         {
  const literal = (value        ) => "'" + value.replaceAll("'", "''") + "'";
  const selected = rules.map(rule => rule['object-locator']                                                   );
  const sql = [
    '\\set ON_ERROR_STOP on',
    '-- Run manually through verified TLS as the actual source migration identity. Metadata only; no credentials embedded.',
    'BEGIN READ ONLY;',
    'DO $checks$',
    'BEGIN',
    '  IF current_database() <> ' + literal(database) + " THEN RAISE EXCEPTION 'Wrong source database'; END IF;",
    "  IF pg_is_in_recovery() THEN RAISE EXCEPTION 'This recipe requires the primary writer'; END IF;",
    "  IF current_setting('wal_level') <> 'logical' THEN RAISE EXCEPTION 'Owner must configure logical WAL and perform approved restart where required'; END IF;",
    "  IF current_setting('max_replication_slots')::int <= (SELECT count(*) FROM pg_replication_slots) THEN RAISE EXCEPTION 'No free replication slot'; END IF;",
    "  IF current_setting('max_wal_senders')::int <= (SELECT count(*) FROM pg_stat_replication) THEN RAISE EXCEPTION 'No available WAL sender capacity'; END IF;",
    "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolreplication)) AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_replication' AND pg_has_role(current_user, oid, 'MEMBER')) THEN RAISE EXCEPTION 'Source identity lacks replication privilege'; END IF;",
    ...selected.map(table =>
      '  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ' + literal(table['schema-name']) + ' AND c.relname = ' + literal(table['table-name']) +
      " AND c.relkind = 'r' AND NOT c.relrowsecurity AND has_schema_privilege(current_user, n.oid, 'USAGE') AND c.relreplident IN ('d','f') AND has_table_privilege(current_user, c.oid, 'SELECT') AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND i.indisvalid)) THEN RAISE EXCEPTION " +
      literal('Selected table requires ordinary-table/primary-key/SELECT/replica-identity readiness: ' + table['schema-name'] + '.' + table['table-name']) + '; END IF;'),
    'END;',
    '$checks$;',
    '-- Record a source reference point; this is not an automatic task start position or proof of target catch-up.',
    'SELECT current_database(), current_user, pg_current_wal_lsn() AS observed_source_lsn;',
    '-- Review existing logical slots; do not drop/recreate slots from this inspection script.',
    'SELECT slot_name, plugin, database, active, restart_lsn, confirmed_flush_lsn, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_wal_bytes FROM pg_replication_slots WHERE slot_type = ' + literal('logical') + ' AND database = current_database();',
    'ROLLBACK;',
  ].join('\n') + '\n';
  const runbook = [
    '# PostgreSQL full-load + CDC',
    '1. Verify supported PostgreSQL/DMS versions and data types. Use a primary writer, exact ordinary tables with primary keys, approved test_decoding availability, replication/read privileges and logical WAL. Configure self-managed settings or RDS/Aurora writer parameters through the database owner; perform approved restart if needed. No parameter/role/slot changes are automated.',
    '2. Run SOURCE-CHECK.sql manually as the migration identity through verified TLS. It checks metadata, not decoding-plugin execution or full data-type compatibility. Complete the DMS premigration assessment. Partitioned/RLS tables, no-PK workarounds, read replicas, DDL changes, custom LSNs and existing slots require separate design.',
    '3. Prepare empty target schemas, keys/types and application objects. Freeze DDL. Start only after endpoint tests using OPERATE.ps1 -Action Start -ConfirmTargetReady -ConfirmCdcReady. DMS manages the initial slot; do not manually create a slot for this path.',
    '4. Monitor full-load/table validation, errors, CDC source/target latency, replication disk/memory, source free storage and retained WAL. Paused/stopped tasks can retain WAL; finite slot-WAL limits can invalidate replication. Establish alarms, limits and an owner response before launch.',
    '5. For cutover, freeze all source writers, drain transactions and verify final catch-up plus independent table/LOB checks and application acceptance. Reconcile sequence values separately before enabling target writers. Low latency alone is insufficient. Preserve rollback/replay evidence; stop/slot removal needs explicit review and never undoes copied rows. Resume/reload/restart are not automated.',
    'https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html',
    'https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Task.CDC.html',
    'https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Tasks.AssessmentReport.PG.html',
  ].join('\n\n') + '\n';
  return { 'SOURCE-CHECK.sql': sql, 'CDC-RUNBOOK.md': runbook };
}
