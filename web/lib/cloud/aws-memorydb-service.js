import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
export const AWS_MEMORYDB_SERVICE = {
  id: 'aws_service_memorydb', label: 'Set up an IAM-authenticated MemoryDB cluster',
  description: 'Private TLS Valkey/Redis cluster, scoped IAM user/ACL and key prefix, replicas/snapshots, and a short-lived IAM token client with optional isolated pilot write.',
  emits: ['aws_memorydb_cluster', 'aws_memorydb_subnet_group', 'aws_memorydb_acl', 'aws_memorydb_user', 'aws_iam_role_policy', 'aws_security_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Cluster name', control: 'text' },
    { id: 'engine', label: 'Engine family', control: 'select', default: 'valkey', options: [{ value: 'valkey', label: 'Valkey 7.2' }, { value: 'redis', label: 'Redis OSS 7.0/7.1' }] },
    { id: 'redis_version', label: 'Redis OSS version', control: 'select', default: '7.1', options: [{ value: '7.0', label: '7.0' }, { value: '7.1', label: '7.1 enhanced' }], showWhen: { input: 'engine', equals: ['redis'] } },
    { id: 'instance', label: 'Node type', control: 'combo', default: 'db.r6g.large', options: ['db.t4g.small', 'db.t4g.medium', 'db.r6g.large', 'db.r6g.xlarge', 'db.r7g.large', 'db.r7g.xlarge'].map(value => ({ value, label: value })), hint: 'Verify node availability and quota in the selected region. Data-tiering node families are outside this recipe.' },
    { id: 'shards', label: 'Shard count', control: 'number', default: 1 },
    { id: 'replicas', label: 'Replicas per shard', control: 'select', default: '1', options: [{ value: '0', label: '0 — no replica failover target' }, { value: '1', label: '1 replica per shard' }, { value: '2', label: '2 replicas per shard' }] },
    { id: 'subnets', label: 'Private subnet IDs', control: 'text', hint: 'At least two distinct AZs; three AZs for two replicas per shard. One VPC with approved routing/DNS.' },
    { id: 'clients', label: 'Application client security group IDs', control: 'text', hint: '1–5 existing same-VPC groups; new cluster group allows only those groups on TLS TCP6379.' },
    { id: 'role', label: 'Existing application IAM role ARN', control: 'text', hint: 'Same-account role; adds memorydb:Connect only for this exact cluster and IAM-authenticated database user.' },
    { id: 'username', label: 'New MemoryDB IAM username', control: 'text', hint: 'Optional; defaults to the cluster name so unrelated new clusters do not share one default application user.' },
    { id: 'key_prefix', label: 'Application key prefix', control: 'text', default: 'application:', hint: 'Exact literal prefix ending in :. No wildcard input; only keys under this prefix are granted.' },
    { id: 'access', label: 'String-key application permissions', control: 'select', default: 'READ', options: [{ value: 'READ', label: 'Read string keys only' }, { value: 'READWRITE', label: 'Read/write string keys, expiration and counters' }], hint: 'No global scans, scripts, pub/sub, transactions, admin commands or unrestricted data-type categories.' },
    { id: 'kms', label: 'Optional storage KMS key ARN', control: 'text', hint: 'Existing enabled symmetric regional key; service-managed storage encryption otherwise. This is separate from TLS/IAM authentication.' },
    { id: 'retention', label: 'Snapshot retention (days)', control: 'number', default: 7 },
    { id: 'snapshot', label: 'Final snapshot name', control: 'text', hint: 'Optional; defaults to <cluster>-final and must be unused at deletion.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.memorydb.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), engine = String(values.engine ?? ''), version = engine === 'valkey' ? '7.2' : String(values.redis_version ?? ''), instance = String(values.instance ?? '').trim(), role = String(values.role ?? '').trim(), username = String(values.username ?? '').trim() || name, prefix = String(values.key_prefix ?? '').trim(), access = String(values.access ?? ''), kms = String(values.kms ?? '').trim(), snapshot = String(values.snapshot ?? '').trim() || name + '-final';
    const shards = Number(values.shards), replicas = Number(values.replicas), retention = Number(values.retention);
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients');
    const match = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), account = match?.[1] ?? '';
    const validName = (value        , maximum        ) => new RegExp('^[a-z][a-z0-9-]{0,' + (maximum - 1) + '}$').test(value) && !value.endsWith('-') && !value.includes('--');
    if (!validName(name, 40)) reject('name', 'Use a lowercase cluster identifier up to 40 characters without trailing/consecutive hyphens.');
    if (!['valkey', 'redis'].includes(engine)) reject('engine', 'Choose Valkey or Redis OSS.');
    if (engine === 'redis' && !['7.0', '7.1'].includes(version)) reject('redis_version', 'Choose an IAM-capable Redis OSS 7.0/7.1 version.');
    if (!/^db\.[a-z0-9]+\.[a-z0-9]+$/.test(instance) || /^db\.[^.]*gd\./.test(instance)) reject('instance', 'Use a supported nontiering MemoryDB node type.');
    if (!Number.isInteger(shards) || shards < 1 || shards > 20) reject('shards', 'Use 1–20 shards within account quotas.');
    if (![0, 1, 2].includes(replicas)) reject('replicas', 'Choose zero, one or two replicas per shard.');
    if (subnets.length < Math.max(2, replicas + 1) || subnets.length > 20 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Provide sufficient distinct-AZ private subnets for the selected replica count.');
    if (!clients.length || clients.length > 5 || clients.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('clients', 'Use 1–5 same-VPC client groups.');
    if (!match) reject('role', 'Use an existing same-account application IAM role ARN.');
    if (!validName(username, 40) || username === 'default') reject('username', 'Use a non-default lowercase IAM username up to 40 characters.');
    if (!/^[A-Za-z][A-Za-z0-9:_-]{0,99}:$/.test(prefix)) reject('key_prefix', 'Use a literal application prefix ending in :, without ACL wildcard characters.');
    if (!['READ', 'READWRITE'].includes(access)) reject('access', 'Select the bounded string-key permission set.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing regional symmetric KMS key ARN.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 35) reject('retention', 'Use 1–35 snapshot retention days.');
    if (!validName(snapshot, 255)) reject('snapshot', 'Use a valid unused final snapshot name.');
    const commands = ['ping', 'hello', 'command', 'cluster|slots', 'cluster|shards', 'client|setname', ...(engine === 'valkey' ? ['client|setinfo'] : []), 'readonly', 'get', 'mget', 'exists', 'ttl', 'pttl', 'type', ...(access === 'READWRITE' ? ['set', 'mset', 'del', 'unlink', 'expire', 'pexpire', 'persist', 'incr', 'incrby', 'decr', 'decrby'] : [])];
    const acl = 'on ~' + prefix + '* -@all ' + commands.map(command => '+' + command).join(' ');
    const guide = [
      '# Private IAM-authenticated MemoryDB cluster',
      '## Prepare\nRun PREFLIGHT.ps1 to confirm the selected regional engine/version is advertised; review actual node-family availability, node/shard quotas and cost separately. Validate Valkey/Redis protocol, cluster hash slots, application key types, timeouts and source compatibility. This recipe supports a new single-region cluster with nontiering nodes, TLS/IAM authentication, one restricted string-key user and no imported data. It is not ElastiCache, Multi-Region MemoryDB, a transparent Redis replacement or a complete cache migration. Provide at least two private subnet AZs, three for two replicas per shard, same-VPC approved clients, DNS and client egress/NACLs. Nodes are shards × (1 + replicas); zero replicas gives no replica promotion target.',
      '## Deploy\nExisting application role trust and KMS key policies remain owner prerequisites. Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review custom IAM user/ACL (not open-access/default), exact key prefix/commands, private TLS6379 group, engine, shards/replicas, encryption and snapshots, then apply the reviewed plan. Wait for cluster/user/ACL available and inspect actual node/AZ distribution and applied engine patch. Storage encryption is service-managed unless the selected customer key is supplied. TLS and IAM are independent from at-rest keys; no FIPS/ATO/agency approval is implied.',
      '## Client identity and permissions\nThe existing IAM role receives memorydb:Connect on BOTH this exact cluster and database user. The ACL separately controls commands and key names. The selected presets support string keys and cluster/client metadata needed by the Python client; they do not allow global key scans, hash/list/set operations, Lua, pub/sub, transactions or administrative commands. READWRITE permits deletion only of keys matching the prefix. Command/cluster topology metadata remains visible. Use separate users/roles/prefixes for distinct trust domains and verify effective existing policies. No static password or token is generated into Terraform files/state.',
      '## Verify explicitly\nInstall approved requirements.txt and assume the application role through the standard credential chain. Run CHECK.py inside the authorized network from the applied package. It uses a credentials provider that generates a 15-minute SigV4 MemoryDB IAM token for each new connection, with TLS certificate/hostname verification and minimum TLS1.2. Default behavior only pings; it does not scan/read existing keys. Optional --write-test is allowed only for the READWRITE preset and creates one UUID-named pilot key under the approved prefix using NX and a 60-second TTL, verifies its synthetic value, and deletes only that confirmed-created key. A failed/ambiguous SET leaves the short TTL to expire; no existing key is deliberately overwritten. No write occurs unless that switch is explicitly used. A ping is not proof of read/write authorization or application integrity. Verify rejection of unlisted keys/roles/groups and representative owner-approved operations separately.',
      'IAM tokens expire after 15 minutes; authenticated connections have a 12-hour lifetime unless reauthenticated, so production applications must handle reconnect/refresh and failover. IAM authentication is not supported inside MULTI EXEC. The generated short check is not a long-running connection manager. Existing credentials are loaded at connection time and never printed. Use appropriate cluster-aware key routing; cross-slot multikey/transaction behavior needs application changes.',
      '## Migration and recovery\nInventory source keys/types/TTL/eviction/transactions/scripts/clients, select an approved snapshot/RDB import or controlled replication/replay process and separately scope any additional loader/access policies. This package creates an empty target and does not copy keys or offsets. Reconcile TTL and data behavior, pilot failure/reconnect, prove snapshot restore into an isolated new cluster, and retain source/replay/cutback until acceptance. Snapshot retention and an unused final snapshot name are configured; Terraform prevent_destroy blocks unreviewed removal but is not an AWS deletion lock. MemoryDB durability does not recover logical deletes without tested restore/replay. Slow-query/audit delivery, alarms, parameter tuning and multi-region replication are not configured by this recipe.',
      'https://docs.aws.amazon.com/memorydb/latest/devguide/auth-iam.html\nhttps://docs.aws.amazon.com/memorydb/latest/devguide/engine-versions.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'application', { name: match?.[2]?.split('/').at(-1) ?? '' }),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'clients', { for_each: x('toset(' + JSON.stringify(clients) + ')'), id: x('each.value') }),
      ...(kms ? [dat('aws_kms_key', 'storage', { key_id: kms })] : []),
      res('aws_memorydb_subnet_group', 'configured', { name: name + '-subnets', subnet_ids: subnets }, [blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.application.arn == ' + JSON.stringify(role) + ' && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= ' + Math.max(2, replicas + 1) + ' && alltrue([for group in data.aws_security_group.clients : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])' + (kms ? ' && data.aws_kms_key.storage.enabled && data.aws_kms_key.storage.key_spec == "SYMMETRIC_DEFAULT"' : '')), error_message: 'Use this account role, enough distinct same-VPC subnet AZs, matching client groups and enabled symmetric key.' })])]),
      res('aws_security_group', 'database', { name: name + '-memorydb', description: 'Approved MemoryDB TLS clients', vpc_id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id') }, [blk('ingress', { protocol: 'tcp', from_port: 6379, to_port: 6379, security_groups: clients })]),
      res('aws_memorydb_user', 'application', { user_name: username, access_string: acl }, [blk('authentication_mode', { type: 'iam' })]),
      res('aws_memorydb_acl', 'application', { name, user_names: x('[aws_memorydb_user.application.user_name]') }),
      res('aws_memorydb_cluster', 'configured', { name, engine, engine_version: version, node_type: instance, num_shards: shards, num_replicas_per_shard: replicas, acl_name: x('aws_memorydb_acl.application.name'), subnet_group_name: x('aws_memorydb_subnet_group.configured.name'), security_group_ids: x('[aws_security_group.database.id]'), port: 6379, tls_enabled: true, data_tiering: false, ...(kms ? { kms_key_arn: x('data.aws_kms_key.storage.arn') } : {}), snapshot_retention_limit: retention, final_snapshot_name: snapshot, auto_minor_version_upgrade: true, tags: x(hcl({ Name: name })) }, [blk('lifecycle', { prevent_destroy: true })]),
      res('aws_iam_role_policy', 'connect', { name: name + '-memorydb-connect', role: x('data.aws_iam_role.application.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['memorydb:Connect'], Resource: [e('aws_memorydb_cluster.configured.arn'), e('aws_memorydb_user.application.arn')] }] })) }),
      output('client_configuration', '{ cluster = aws_memorydb_cluster.configured.name, endpoint = aws_memorydb_cluster.configured.cluster_endpoint[0].address, port = aws_memorydb_cluster.configured.cluster_endpoint[0].port, region = ' + JSON.stringify(region) + ', username = aws_memorydb_user.application.user_name, key_prefix = ' + JSON.stringify(prefix) + ', access = ' + JSON.stringify(access) + ' }'),
    ], guide, findings);
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      "$raw = aws memorydb describe-engine-versions --engine '" + engine + "' --engine-version '" + version + "' --region '" + region + "' --output json",
      'if ($LASTEXITCODE -ne 0) { throw "Could not read regional MemoryDB engine availability." }',
      '$response = $raw | ConvertFrom-Json',
      "$offerings = @($response.EngineVersions | Where-Object { $_.Engine -eq '" + engine + "' -and $_.EngineVersion -eq '" + version + "' })",
      'if ($offerings.Count -eq 0) { throw "Selected engine/version is not advertised in this region." }',
      "Write-Host 'Engine metadata check passed. Review node types, quotas, network and Terraform plan before applying.'",
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': preflight, 'CHECK.py': memorydbClient, 'requirements.txt': 'boto3>=1.35,<2\nredis>=5.2,<7\n' } };
  },
}                    ;
const memorydbClient = [
  'import argparse, json, ssl, subprocess, uuid',
  'import boto3',
  'from botocore.auth import SigV4QueryAuth',
  'from botocore.awsrequest import AWSRequest',
  'from redis.cluster import RedisCluster',
  'from redis.credentials import CredentialProvider',
  'parser = argparse.ArgumentParser(description="MemoryDB IAM/TLS ping and optional isolated synthetic write")',
  'parser.add_argument("--write-test", action="store_true")',
  'args = parser.parse_args()',
  'configuration = json.loads(subprocess.check_output(["terraform", "output", "-json", "client_configuration"], text=True))',
  'if args.write_test and configuration["access"] != "READWRITE": raise RuntimeError("Write test requires the READWRITE preset")',
  'host = configuration["endpoint"]',
  'if not host or "/" in host or ":" in host or any(c.isspace() for c in host) or configuration["port"] != 6379: raise RuntimeError("Invalid cluster endpoint")',
  'class IAMCredentials(CredentialProvider):',
  '    def get_credentials(self):',
  '        credentials = boto3.Session().get_credentials()',
  '        if credentials is None: raise RuntimeError("Use approved application IAM role credentials")',
  '        request = AWSRequest(method="GET", url="http://" + configuration["cluster"] + "/", params={"Action": "connect", "User": configuration["username"]})',
  '        SigV4QueryAuth(credentials.get_frozen_credentials(), "memorydb", configuration["region"], expires=900).add_auth(request)',
  '        return configuration["username"], request.url.removeprefix("http://")',
  'client = RedisCluster(host=host, port=6379, credential_provider=IAMCredentials(), ssl=True, ssl_cert_reqs="required", ssl_check_hostname=True, ssl_min_version=ssl.TLSVersion.TLSv1_2, socket_connect_timeout=10, socket_timeout=30)',
  'created = False',
  'pilot = configuration["key_prefix"] + "archtoolkit:pilot:" + str(uuid.uuid4())',
  'try:',
  '    result = client.ping()',
  '    healthy = result is True or (isinstance(result, dict) and bool(result) and all(value is True for value in result.values()))',
  '    if not healthy: raise RuntimeError("Cluster ping did not confirm success")',
  '    print("IAM/TLS ping succeeded. No existing key data was read.")',
  '    if args.write_test:',
  '        created = client.set(pilot, b"archtoolkit-synthetic-pilot", nx=True, ex=60) is True',
  '        if not created: raise RuntimeError("Pilot key was not created; no existing key will be deleted")',
  '        if client.get(pilot) != b"archtoolkit-synthetic-pilot": raise RuntimeError("Pilot readback failed")',
  '        print("Isolated synthetic key write/read passed.")',
  'finally:',
  '    try:',
  '        if created: client.delete(pilot)',
  '    finally:',
  '        client.close()',
].join('\n') + '\n';
