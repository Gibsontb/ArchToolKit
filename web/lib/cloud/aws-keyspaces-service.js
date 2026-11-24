import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
const types = ['ascii', 'bigint', 'blob', 'boolean', 'date', 'decimal', 'double', 'float', 'inet', 'int', 'smallint', 'text', 'time', 'timestamp', 'timeuuid', 'tinyint', 'uuid', 'varint'];
const keyTypes = ['ascii', 'bigint', 'int', 'text', 'timestamp', 'timeuuid', 'uuid'];
export const AWS_KEYSPACES_SERVICE = {
  id: 'aws_service_keyspaces', label: 'Set up an encrypted Cassandra-compatible table',
  description: 'Single-region Keyspaces table, new/existing keyspace, compound keys/static columns, capacity, recovery, optional expiry and exact application-role permissions with metadata-check code.',
  emits: ['aws_keyspaces_keyspace', 'aws_keyspaces_table', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Table name', control: 'text' },
    { id: 'keyspace', label: 'Keyspace name', control: 'text' },
    { id: 'create', label: 'Keyspace setup', control: 'select', default: 'NEW', options: [{ value: 'NEW', label: 'Create a new single-region keyspace' }, { value: 'EXISTING', label: 'Use an existing single-region keyspace' }] },
    { id: 'columns', label: 'Table columns and keys', control: 'textarea', default: 'tenant_id | text | PARTITION | \nrecord_id | uuid | CLUSTERING | ASC\npayload | text | REGULAR | ', hint: 'Column | Type | Role | Order', options: [...types.map(value => ({ value, label: value, group: 'Type' })), ...['PARTITION', 'CLUSTERING', 'STATIC', 'REGULAR'].map(value => ({ value, label: value, group: 'Role' })), { value: '', label: 'N/A', group: 'Order' }, ...['ASC', 'DESC'].map(value => ({ value, label: value, group: 'Order' }))], help: '1–50 scalar columns. PARTITION and CLUSTERING row order defines the composite key. Order applies only to clustering keys. Static columns require a clustering key. Collections/UDTs/counters and multi-region replication need separate recipes.' },
    { id: 'capacity', label: 'Capacity mode', control: 'select', default: 'PAY_PER_REQUEST', options: [{ value: 'PAY_PER_REQUEST', label: 'On demand' }, { value: 'PROVISIONED', label: 'Provisioned read/write units' }] },
    { id: 'reads', label: 'Read capacity units', control: 'number', default: 100, showWhen: { input: 'capacity', equals: ['PROVISIONED'] } },
    { id: 'writes', label: 'Write capacity units', control: 'number', default: 100, showWhen: { input: 'capacity', equals: ['PROVISIONED'] } },
    { id: 'ttl', label: 'Default TTL seconds (0 = no expiry)', control: 'number', default: 0, hint: 'Expiry is asynchronous and can remove data; review retention and TTL pricing before enabling.' },
    { id: 'timestamps', label: 'Client-side timestamps', control: 'select', default: 'NO', options: [{ value: 'NO', label: 'Service timestamps' }, { value: 'YES', label: 'Enable reviewed client-side timestamps' }] },
    { id: 'kms', label: 'Existing table encryption KMS key ARN', control: 'text' },
    { id: 'role', label: 'Existing application IAM role ARN', control: 'text' },
    { id: 'access', label: 'Application data operations', control: 'select', default: 'READ', options: [{ value: 'READ', label: 'Read only' }, { value: 'WRITE', label: 'Read and modify rows (includes deletes)' }] },
  ],
  build(values)                                      {
    const findings            = [], reject = (path        , message        ) => findings.push(error('aws.keyspaces.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), keyspace = String(values.keyspace ?? '').trim(), create = String(values.create ?? ''), capacity = String(values.capacity ?? ''), role = String(values.role ?? '').trim(), kms = String(values.kms ?? '').trim(), access = String(values.access ?? ''), timestamps = String(values.timestamps ?? '');
    const match = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), account = match?.[1] ?? '';
    for (const [field, value] of [['name', name], ['keyspace', keyspace]]) if (!/^[a-z][a-z0-9_]{0,47}$/.test(value ) || value .startsWith('system')) reject(field , 'Use a lowercase letter followed by up to 47 lowercase letters/digits/underscores, outside reserved system names.');
    if (!['NEW', 'EXISTING'].includes(create)) reject('create', 'Choose a new or existing single-region keyspace.');
    if (!match) reject('role', 'Use an existing same-account application role ARN.');
    if (!new RegExp('^arn:' + partition + ':kms:' + region + ':' + account + ':key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing same-account regional symmetric KMS key ARN.');
    if (!['READ', 'WRITE'].includes(access)) reject('access', 'Choose read only or row modification.');
    if (!['NO', 'YES'].includes(timestamps)) reject('timestamps', 'Choose the client timestamp setting.');
    if (!['PAY_PER_REQUEST', 'PROVISIONED'].includes(capacity)) reject('capacity', 'Choose on-demand or provisioned capacity.');
    const reads = Number(values.reads), writes = Number(values.writes), ttl = Number(values.ttl);
    if (capacity === 'PROVISIONED') for (const [field, value] of [['reads', reads], ['writes', writes]]         ) if (!Number.isInteger(value) || value < 1 || value > 40000) reject(field, 'Use 1–40000 units within approved account/table quotas.');
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 630720000) reject('ttl', 'Use 0 for no expiry or 1–630720000 seconds.');
    const columns                                                                = [];
    const rows = String(values.columns ?? '').split(/\r?\n/).map(row => row.trim()).filter(Boolean);
    if (!rows.length || rows.length > 50) reject('columns', 'Use 1–50 scalar columns.');
    for (const [index, row] of rows.entries()) {
      const cells = row.split('|').map(value => value.trim()), [column = '', type = '', kind = '', order = ''] = cells;
      if (cells.length !== 4 || !/^[a-z][a-z0-9_]{0,47}$/.test(column) || columns.some(item => item.name === column) || !types.includes(type) || !['PARTITION', 'CLUSTERING', 'STATIC', 'REGULAR'].includes(kind) || (kind === 'CLUSTERING' ? !['ASC', 'DESC'].includes(order) : Boolean(order)) || (['PARTITION', 'CLUSTERING'].includes(kind) && !keyTypes.includes(type))) {
        reject('columns', 'Row ' + (index + 1) + ' requires a unique literal column, supported type/role and ASC/DESC only for clustering keys; key types are restricted to the documented recipe subset.'); continue;
      }
      columns.push({ name: column, type, role: kind, order });
    }
    const partitionKeys = columns.filter(column => column.role === 'PARTITION'), clustering = columns.filter(column => column.role === 'CLUSTERING'), statics = columns.filter(column => column.role === 'STATIC');
    if (!partitionKeys.length || partitionKeys.length > 8 || clustering.length > 8 || (statics.length && !clustering.length)) reject('columns', 'Use 1–8 partition columns, at most eight clustering columns; static columns need a clustering key.');
    const tableArn = 'arn:' + partition + ':cassandra:' + region + ':' + account + ':/keyspace/' + keyspace + '/table/' + name;
    const schema = { allColumns: columns.map(column => ({ name: column.name, type: column.type })), partitionKeys: partitionKeys.map(column => ({ name: column.name })), clusteringKeys: clustering.map(column => ({ name: column.name, orderBy: column.order })), staticColumns: statics.map(column => ({ name: column.name })) };
    const guide = [
      '# Amazon Keyspaces table and application access',
      '## Prepare\nThis is a new empty single-region table with scalar schema, not a Cassandra data copy or full protocol/feature compatibility guarantee. Review partition distribution, row/static size, query patterns, provisioned/on-demand quotas and regional availability. Existing-keyspace mode requires a single-region keyspace; CHECK.py verifies the resulting table. No UDT/collection/counter schema, secondary-index migration, CDC stream, global replication or capacity autoscaling is configured.',
      'Use an existing same-account enabled symmetric encryption key and a dedicated application role with approved trust. Review service key-policy grants, regional encryption requirements, customer-key cost and the impact of disabling/deleting a key. Runtime IAM permits only selected-table Select and optional Modify plus required read-only system* metadata for driver/control-plane initialization. Modify includes insert/update/delete; it is not write-without-delete. Key decrypt/describe is exact-key scoped; effective policies and grants still require owner verification. No static Cassandra password or IAM access key is created.',
      '## Deploy\nRun PREFLIGHT.py as the approved deployment identity before plan; existing mode verifies the exact single-region keyspace via its regional API. Provider 5 has no keyspace metadata data source, so this prerequisite is an explicit operator check; rerun if the keyspace changes. The restricted application role need not have deployment/keyspace-administration permissions. Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review new/existing keyspace ownership, schema/key order, capacity, enabled PITR, optional TTL/client timestamps, KMS and role policy; apply the reviewed plan. New keyspace and table have prevent_destroy, not an AWS deletion lock. Primary-key changes/replacements require a separately accepted data migration and explicit lifecycle review. Client-side timestamps and the TTL feature cannot be disabled once enabled; do not treat switching these inputs off as reversal of an existing table setting. Use a separately reviewed replacement/data migration where reversal is required. A zero default TTL removes the default expiry assumption, not a previously enabled per-write TTL feature. PITR restores into a separate table; exercise restore and application validation. TTL is asynchronous expiration with charges, not a precise legal-retention or sanitization control.',
      '## Verify and connect\nInstall approved boto3 requirements and run CHECK.py under the intended application role. It uses signed regional AWS APIs only to verify account, table identity/ACTIVE state, exact columns/key order, capacity mode, key, PITR, expiry and client timestamps. It neither reads application rows nor proves a CQL session. Supply an approved regional Cassandra endpoint/private interface endpoint, private DNS/routes/client rules and TCP9142. Configure the AWS SigV4 Cassandra driver plugin with the normal temporary-credential chain and a validated TLS1.2+ context with hostname checking and approved Amazon trust roots; never disable verification. CLIENT-CONFIG.json includes exact table/region/auth settings and AWS primary connection references. Do not assume an API metadata check proves CQL routing, read/write/delete behavior or workload performance.',
      '## Migration and cutover\nInventory source CQL types, compound key order, partition distribution, TTL remaining time, original write timestamps/tombstones, consistency assumptions, unsupported queries and total rows/bytes. Choose reviewed export/import, database-aware connector appropriate to Cassandra semantics, or application dual-write/replay design; this package does not prescribe a file-copy tool as a Cassandra database migration. Load a pilot, reconcile counts/partition samples and TTL/timestamp behavior, test target throttling/retries and actual application operations. Freeze/final-delta/reconcile and obtain owner acceptance before routing clients. Preserve source/replay and rollback rules; switching writers back can require reconciliation. No import, query, connection, key-policy change or deployment runs during generation/local validation.',
      'https://docs.aws.amazon.com/keyspaces/latest/devguide/security_iam_service-with-iam.html\nhttps://docs.aws.amazon.com/keyspaces/latest/devguide/using_python_driver.html\nhttps://docs.aws.amazon.com/keyspaces/latest/APIReference/API_GetTable.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'application', { name: match?.[2]?.split('/').at(-1) ?? '' }), dat('aws_kms_key', 'storage', { key_id: kms }),
      ...(create === 'NEW' ? [res('aws_keyspaces_keyspace', 'configured', { name: keyspace }, [blk('replication_specification', { replication_strategy: 'SINGLE_REGION' }), blk('lifecycle', { prevent_destroy: true })])] : []),
      res('aws_keyspaces_table', 'configured', { keyspace_name: create === 'NEW' ? x('aws_keyspaces_keyspace.configured.name') : keyspace, table_name: name, ...(ttl ? { default_time_to_live: ttl } : {}), tags: x(hcl({ Name: name })) }, [
        blk('schema_definition', {}, [
          ...columns.map(column => blk('column', { name: column.name, type: column.type })),
          ...partitionKeys.map(column => blk('partition_key', { name: column.name })),
          ...clustering.map(column => blk('clustering_key', { name: column.name, order_by: column.order })),
          ...statics.map(column => blk('static_column', { name: column.name })),
        ]),
        blk('capacity_specification', { throughput_mode: capacity, ...(capacity === 'PROVISIONED' ? { read_capacity_units: reads, write_capacity_units: writes } : {}) }),
        blk('encryption_specification', { type: 'CUSTOMER_MANAGED_KMS_KEY', kms_key_identifier: kms }),
        blk('point_in_time_recovery', { status: 'ENABLED' }),
        ...(timestamps === 'YES' ? [blk('client_side_timestamps', { status: 'ENABLED' })] : []),
        ...(ttl ? [blk('ttl', { status: 'ENABLED' })] : []),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.application.arn == ' + JSON.stringify(role) + ' && data.aws_kms_key.storage.enabled && data.aws_kms_key.storage.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.storage.key_usage == "ENCRYPT_DECRYPT"'), error_message: 'Use this account role and an enabled symmetric regional encryption key.' })]),
      ]),
      res('aws_iam_role_policy', 'application', { name: keyspace + '-' + name + '-client', role: x('data.aws_iam_role.application.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['cassandra:Select', ...(access === 'WRITE' ? ['cassandra:Modify'] : [])], Resource: e('aws_keyspaces_table.configured.arn') },
        { Effect: 'Allow', Action: ['cassandra:Select'], Resource: 'arn:' + partition + ':cassandra:' + region + ':' + account + ':/keyspace/system*' },
        { Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: kms },
      ] })) }),
      output('table_arn', 'aws_keyspaces_table.configured.arn'),
    ], guide, findings);
    const config = { region, account, keyspace, table: name, arn: tableArn, capacity, reads, writes, kms, ttl, timestamps: timestamps === 'YES', schema, auth: 'AWS_SIGV4', tls_minimum: 'TLSv1.2', port: 9142, cql_driver_reference: 'https://docs.aws.amazon.com/keyspaces/latest/devguide/using_python_driver.html' };
    const preflight = [
      'import json, pathlib, boto3',
      'config = json.loads((pathlib.Path(__file__).resolve().parent / "CLIENT-CONFIG.json").read_text(encoding="utf-8"))',
      'session = boto3.Session(region_name=config["region"])',
      'if session.client("sts").get_caller_identity()["Account"] != config["account"]: raise RuntimeError("Unexpected deployment account")',
      ...(create === 'EXISTING' ? [
        'keyspace = session.client("keyspaces").get_keyspace(keyspaceName=config["keyspace"])',
        'if keyspace.get("resourceArn") != config["arn"].split("/table/")[0] + "/" or keyspace.get("replicationStrategy") != "SINGLE_REGION": raise RuntimeError("Require the exact existing single-region keyspace")',
      ] : []),
      'print("Deployment account/existing-keyspace prerequisites checked; table/schema/key policy/network still require plan and owner review. No resource changed.")',
    ].join('\n') + '\n';
    const check = [
      'import json, pathlib, boto3',
      'config = json.loads((pathlib.Path(__file__).resolve().parent / "CLIENT-CONFIG.json").read_text(encoding="utf-8"))',
      'session = boto3.Session(region_name=config["region"])',
      'if session.client("sts").get_caller_identity()["Account"] != config["account"]: raise RuntimeError("Unexpected table account")',
      'table = session.client("keyspaces").get_table(keyspaceName=config["keyspace"], tableName=config["table"])',
      'if table.get("resourceArn") != config["arn"] or table.get("status") != "ACTIVE": raise RuntimeError("Require exact ACTIVE table")',
      'if any(replica.get("region") != config["region"] for replica in table.get("replicaSpecifications", [])): raise RuntimeError("This recipe requires a single-region table")',
      'actual = table.get("schemaDefinition", {}); expected = config["schema"]',
      'for field in ["allColumns", "staticColumns"]:',
      '    if sorted(actual.get(field, []), key=lambda item: item["name"]) != sorted(expected[field], key=lambda item: item["name"]): raise RuntimeError("Column schema differs")',
      'for field in ["partitionKeys", "clusteringKeys"]:',
      '    if actual.get(field, []) != expected[field]: raise RuntimeError("Primary key order differs")',
      'capacity = table.get("capacitySpecification", {})',
      'if capacity.get("throughputMode") != config["capacity"]: raise RuntimeError("Capacity mode differs")',
      'if config["capacity"] == "PROVISIONED" and (capacity.get("readCapacityUnits") != config["reads"] or capacity.get("writeCapacityUnits") != config["writes"]): raise RuntimeError("Provisioned capacity differs")',
      'encryption = table.get("encryptionSpecification", {})',
      'if encryption.get("type") != "CUSTOMER_MANAGED_KMS_KEY" or encryption.get("kmsKeyIdentifier") != config["kms"]: raise RuntimeError("Encryption key differs")',
      'if table.get("pointInTimeRecovery", {}).get("status") != "ENABLED": raise RuntimeError("PITR is not enabled")',
      'if table.get("defaultTimeToLive", 0) != config["ttl"]: raise RuntimeError("Default expiry differs")',
      'if config["ttl"] and table.get("ttl", {}).get("status") != "ENABLED": raise RuntimeError("TTL is not enabled")',
      'if (table.get("clientSideTimestamps", {}).get("status") == "ENABLED") != config["timestamps"]: raise RuntimeError("Client timestamp setting differs")',
      'print(json.dumps({"table": config["table"], "state": "ACTIVE", "metadata_verified": True, "cql_or_rows_tested": False}))',
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'CLIENT-CONFIG.json': JSON.stringify(config, null, 2) + '\n', 'PREFLIGHT.py': preflight, 'CHECK.py': check, 'requirements.txt': 'boto3>=1.35,<2\n' } };
  },
}                    ;
