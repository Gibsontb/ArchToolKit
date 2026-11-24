import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_OPENSEARCH_DOMAIN_SERVICE = {
  id: 'aws_service_opensearch_domain', label: 'Set up a private OpenSearch domain',
  description: 'VPC-only provisioned domain, encrypted storage/transport, IAM master, explicit application role mapping files, retained audit logs and regional offering preflight.',
  emits: ['aws_opensearch_domain', 'aws_security_group', 'aws_cloudwatch_log_group', 'aws_cloudwatch_log_resource_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Domain name', control: 'text' },
    { id: 'version', label: 'OpenSearch engine version', control: 'text', default: 'OpenSearch_2.19', hint: 'Exact regional version. Run the exported metadata preflight before planning.' },
    { id: 'topology', label: 'Availability Zone layout', control: 'select', default: '3', options: [{ value: '1', label: 'One AZ — development only, no dedicated masters' }, { value: '2', label: 'Two AZs — three dedicated masters' }, { value: '3', label: 'Three AZs — three dedicated masters' }] },
    { id: 'instance', label: 'Data node type', control: 'combo', default: 'm6g.large.search', options: ['m6g.large.search', 'm6g.xlarge.search', 'r6g.large.search', 'r6g.xlarge.search'].map(value => ({ value, label: value })) },
    { id: 'nodes', label: 'Data node count', control: 'number', default: 3, hint: 'A multiple of the AZ count. This recipe permits up to 30; regional quotas still apply.' },
    { id: 'master_type', label: 'Dedicated master type', control: 'combo', default: 'm6g.large.search', options: ['m6g.large.search', 'm6g.xlarge.search', 'r6g.large.search'].map(value => ({ value, label: value })), showWhen: { input: 'topology', equals: ['2', '3'] } },
    { id: 'storage', label: 'gp3 storage per data node (GiB)', control: 'number', default: 100, hint: '3,000 IOPS and 125 MiB/s baseline; preflight checks volume capacity limits. Size shards, heap and performance separately.' },
    { id: 'subnets', label: 'Private subnet IDs, one per selected AZ', control: 'text', hint: 'Comma-separated, distinct AZs in one default-tenancy VPC with sufficient free addresses and working DNS.' },
    { id: 'clients', label: 'Existing client security group IDs', control: 'text', hint: '1–5 same-VPC groups, allowed HTTPS only through a new domain group.' },
    { id: 'admin', label: 'Existing IAM master role ARN', control: 'text', hint: 'Same-account assumable operator role. No password or internal user database is created.' },
    { id: 'applications', label: 'Existing application role ARNs', control: 'text', hint: 'Optional comma-separated same-account roles. IAM admission alone is insufficient: apply the exported index role/mapping as the master before app use.' },
    { id: 'index', label: 'Application index prefix', control: 'text', default: 'application-', hint: 'Application role grants read/write/create-index only for this prefix, followed by *. No delete-index or security administration.' },
    { id: 'kms', label: 'Optional storage KMS key ARN', control: 'text', hint: 'Existing enabled symmetric regional key; blank uses the service-managed storage key. Key policy/grants remain prerequisites.' },
    { id: 'log_days', label: 'Audit log retention (days)', control: 'select', default: '90', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.opensearch.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), version = String(values.version ?? '').trim(), instance = String(values.instance ?? '').trim(), topology = Number(values.topology), nodes = Number(values.nodes), storage = Number(values.storage), admin = String(values.admin ?? '').trim(), index = String(values.index ?? '').trim(), kms = String(values.kms ?? '').trim(), logDays = Number(values.log_days);
    const master = topology === 1 ? '' : String(values.master_type ?? '').trim();
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients'), applications = list('applications');
    const rolePattern = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/[A-Za-z0-9+=,.@_/-]+$'), account = rolePattern.exec(admin)?.[1] ?? '';
    if (!/^[a-z][a-z0-9-]{2,27}$/.test(name)) reject('name', 'Use 3–28 lowercase letters, digits or hyphens, starting with a letter.');
    if (!/^OpenSearch_[1-9][0-9]?\.[0-9]{1,2}$/.test(version)) reject('version', 'Enter an exact OpenSearch_X.Y regional version.');
    if (!/^[a-z][a-z0-9]*\.[a-z0-9]+\.search$/.test(instance)) reject('instance', 'Use a supported provisioned data node type.');
    if (![1, 2, 3].includes(topology)) reject('topology', 'Choose one, two or three AZs.');
    if (topology !== 1 && !/^[a-z][a-z0-9]*\.[a-z0-9]+\.search$/.test(master)) reject('master_type', 'Use a supported dedicated master type.');
    if (!Number.isInteger(nodes) || nodes < topology || nodes > 30 || nodes % topology !== 0) reject('nodes', 'Use a multiple of the AZ count, up to 30 data nodes.');
    if (!Number.isInteger(storage) || storage < 10 || storage > 16384) reject('storage', 'Use 10–16,384 GiB per data node, within the regional instance gp3 limits.');
    if (subnets.length !== topology || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Supply exactly one subnet per selected AZ.');
    if (!clients.length || clients.length > 5 || clients.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('clients', 'Provide 1–5 same-VPC client group IDs.');
    if (!account) reject('admin', 'Use an existing same-account IAM master role ARN.');
    if (applications.length > 10 || applications.some(value => !rolePattern.test(value) || rolePattern.exec(value)?.[1] !== account || value === admin)) reject('applications', 'Use up to ten distinct application roles in the master account, separate from the master.');
    if (!/^[a-z][a-z0-9_-]{0,62}-$/.test(index)) reject('index', 'Use a lowercase application index prefix ending in -, without wildcard or system-index names.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use a regional symmetric storage key ARN.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Choose an audit retention period.');
    const domainArn = 'arn:' + partition + ':es:' + region + ':' + account + ':domain/' + name;
    const guide = [
      '# Private provisioned OpenSearch domain',
      '## Prepare\nRun PREFLIGHT.ps1 first using the deployment account. It checks the selected regional engine, data/master capabilities, distinct subnet AZs and gp3 capacity limits using read-only metadata. Confirm subnet free IP capacity, DNS, private routing, client egress/NACLs, default VPC tenancy, service quotas, shard/heap/storage/performance sizing, service-linked role availability and IAM PassRole/key permissions. This recipe uses standard multi-AZ without standby; the three-AZ option is not Multi-AZ with Standby. One AZ has no availability guarantee. No public endpoint, warm/cold tier, serverless collection, remote reindex or ingestion pipeline is created.',
      '## Deploy\nRun terraform init, terraform validate and terraform plan -out=service.tfplan; review encrypted VPC-only domain, node/master counts, per-node storage, TLS policy, IAM admission and log policy, then apply the reviewed plan. Wait for Processing=false and a successful configuration status. Existing AWSServiceRoleForAmazonOpenSearchService must be present or created by an authorized owner before apply. The IAM master role must be assumable by the approved operator; IAM admission requires SigV4 requests, not browser basic authentication. Fine-grained security is enabled with no internal password database.',
      '## Configure application permissions\nInstall requirements.txt using the approved Python environment. Run python SETUP-ACCESS.py to preview both JSON payloads without network access. Review them, then run python SETUP-ACCESS.py --apply with the IAM master role through the trusted VPC network. The script checks the package domain ARN and master backend role, checks both named security resources for existing definitions, and makes two SigV4 PUT requests. Existing definitions are refused unless --replace-existing is also explicitly supplied. These writes are not atomic: if role creation succeeds but mapping fails, inspect both definitions before retrying. No automatic retry, data write or index creation runs. Equivalent manual paths are /_plugins/_security/api/roles/archtoolkit_application and /_plugins/_security/api/rolesmapping/archtoolkit_application. The mapping uses exact existing role ARNs; do not map the master as an application. App roles also need appropriate identity policies and trusted sessions. The exported role allows read/write/create_index on the selected prefix only; write permits document updates/deletions, not index deletion. Review index/field/document/tenant permissions for actual data requirements. With no app roles selected, skip those writes. Domain IAM admission alone does not grant index access.',
      '## Verify\nInstall the approved boto3 package using requirements.txt and run CHECK.py from this applied package with master-role credentials inside the authorized network. It reads the endpoint from Terraform state, checks TLS with hostname/CA verification and signs read-only cluster-health and auth-info requests. Review domain describe/config status, actual node AZs, encryption, TLS and log delivery. As each app role, test permitted prefix operations and reject access to system/unrelated indices and security administration; reject unauthorized groups and unsigned traffic. Audit export does not enable every event category: review audit settings under /_plugins/_security/api/audit, sensitive body logging and retention before loading production data.',
      '## Recovery and migration\nAutomated snapshots are not a complete migration or disaster recovery plan. Configure and test an approved manual snapshot repository/role and isolated restore, or a tested application reindex/replay procedure. Retain the source, record index mappings/templates/analyzers/plugins, validate versions and data counts, freeze/replay writes and prove application acceptance before endpoint cutover. Capture a rollback endpoint and reconcile writes before reverting. Encryption and VPC changes can require replacement; prevent_destroy blocks planned destruction but is not an AWS deletion lock. No data is imported or destroyed by local generation. Snapshot repositories, security-role application, ingest pipelines and data migration remain explicit follow-on work.',
      'https://docs.aws.amazon.com/opensearch-service/latest/developerguide/vpc.html\nhttps://docs.aws.amazon.com/opensearch-service/latest/developerguide/fgac.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'clients', { for_each: x('toset(' + JSON.stringify(clients) + ')'), id: x('each.value') }),
      dat('aws_vpc', 'selected', { id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id') }),
      ...(kms ? [dat('aws_kms_key', 'storage', { key_id: kms })] : []),
      res('aws_security_group', 'domain', { name: name + '-search', description: 'Approved OpenSearch HTTPS clients', vpc_id: x('data.aws_vpc.selected.id') }, [blk('ingress', { protocol: 'tcp', from_port: 443, to_port: 443, security_groups: clients })]),
      res('aws_cloudwatch_log_group', 'audit', { name: '/aws/opensearch/' + name + '/audit', retention_in_days: logDays }),
      res('aws_cloudwatch_log_resource_policy', 'audit', { policy_name: name + '-search-audit', policy_document: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'es.amazonaws.com' }, Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: e('format("%s:*", aws_cloudwatch_log_group.audit.arn)'), Condition: { StringEquals: { 'aws:SourceAccount': account }, ArnEquals: { 'aws:SourceArn': domainArn } } }] })) }),
      res('aws_opensearch_domain', 'configured', { domain_name: name, engine_version: version, access_policies: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: [admin, ...applications] }, Action: ['es:ESHttpGet', 'es:ESHttpHead', 'es:ESHttpPost', 'es:ESHttpPut', 'es:ESHttpPatch', 'es:ESHttpDelete'], Resource: domainArn + '/*' }] })), depends_on: x('[aws_cloudwatch_log_resource_policy.audit]'), tags: x(hcl({ Name: name })) }, [
        blk('cluster_config', { instance_type: instance, instance_count: nodes, zone_awareness_enabled: topology > 1, dedicated_master_enabled: topology > 1, ...(topology > 1 ? { dedicated_master_type: master, dedicated_master_count: 3 } : {}), multi_az_with_standby_enabled: false }, topology > 1 ? [blk('zone_awareness_config', { availability_zone_count: topology })] : []),
        blk('ebs_options', { ebs_enabled: true, volume_type: 'gp3', volume_size: storage, iops: 3000, throughput: 125 }),
        blk('vpc_options', { subnet_ids: subnets, security_group_ids: x('[aws_security_group.domain.id]') }),
        blk('encrypt_at_rest', { enabled: true, ...(kms ? { kms_key_id: x('data.aws_kms_key.storage.arn') } : {}) }),
        blk('node_to_node_encryption', { enabled: true }),
        blk('domain_endpoint_options', { enforce_https: true, tls_security_policy: 'Policy-Min-TLS-1-2-2019-07' }),
        blk('advanced_security_options', { enabled: true, internal_user_database_enabled: false, anonymous_auth_enabled: false }, [blk('master_user_options', { master_user_arn: admin })]),
        blk('log_publishing_options', { log_type: 'AUDIT_LOGS', enabled: true, cloudwatch_log_group_arn: x('aws_cloudwatch_log_group.audit.arn') }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_vpc.selected.instance_tenancy == "default" && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + topology + ' && alltrue([for group in data.aws_security_group.clients : group.vpc_id == data.aws_vpc.selected.id])' + (kms ? ' && data.aws_kms_key.storage.enabled && data.aws_kms_key.storage.key_spec == "SYMMETRIC_DEFAULT"' : '')), error_message: 'Use the master account, default-tenancy VPC, distinct subnet AZs, same-VPC clients and enabled symmetric key.' })]),
      ]),
      output('domain_endpoint', 'aws_opensearch_domain.configured.endpoint'), output('domain_arn', 'aws_opensearch_domain.configured.arn'),
    ], guide, findings);
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw ("Regional metadata read failed: " + ($Arguments -join " ")) }; return ($raw | ConvertFrom-Json) }',
      "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json')",
      "if ($identity.Account -ne '" + account + "') { throw 'Unexpected deployment account.' }",
      "$region = '" + region + "'; $version = '" + version + "'",
      "$versions = Read-AwsJson @('opensearch','list-versions','--region',$region,'--output','json')",
      "if ($versions.Versions -notcontains $version) { throw 'Engine version is not available in this region.' }",
      "$details = Read-AwsJson @('opensearch','list-instance-type-details','--engine-version',$version,'--region',$region,'--output','json')",
      "$subnets = Read-AwsJson (@('ec2','describe-subnets','--subnet-ids') + @(" + subnets.map(value => "'" + value + "'").join(',') + ") + @('--region',$region,'--output','json'))",
      '$azs = @($subnets.Subnets | ForEach-Object { $_.AvailabilityZone } | Select-Object -Unique)',
      "if ($azs.Count -ne " + topology + ") { throw 'Use one distinct AZ per selected subnet.' }",
      "$types = @('" + instance + "'" + (master && master !== instance ? ",'" + master + "'" : '') + ')',
      'foreach ($type in $types) {',
      '  $matches = @($details.InstanceTypeDetails | Where-Object { $_.InstanceType -eq $type -and $_.EncryptionEnabled -and $_.AdvancedSecurityEnabled })',
      "  if ($matches.Count -ne 1) { throw 'Instance type lacks the selected engine/security capabilities in this region.' }",
      '  foreach ($az in $azs) { if ($matches[0].AvailabilityZones -notcontains $az) { throw "Instance type unavailable in a selected subnet AZ." } }',
      '}',
      "$limits = Read-AwsJson @('opensearch','describe-instance-type-limits','--engine-version',$version,'--instance-type','" + instance + "','--region',$region,'--output','json')",
      "$gp3 = @($limits.LimitsByRole.data.StorageTypes | Where-Object { $_.StorageSubTypeName -eq 'gp3' })",
      "if ($gp3.Count -ne 1) { throw 'Selected data node lacks gp3 storage.' }",
      "$minimum = @($gp3[0].StorageTypeLimits | Where-Object { $_.LimitName -eq 'MinimumVolumeSize' })",
      "$maximum = @($gp3[0].StorageTypeLimits | Where-Object { $_.LimitName -eq 'MaximumVolumeSize' })",
      'if ($minimum.Count -ne 1 -or $maximum.Count -ne 1) { throw "Volume capacity metadata is incomplete; review current offering limits." }',
      'if (' + storage + ' -lt [int]$minimum[0].LimitValues[0] -or ' + storage + ' -gt [int]$maximum[0].LimitValues[0]) { throw "Requested per-node storage exceeds instance limits." }',
      '$counts = $limits.LimitsByRole.data.InstanceLimits.InstanceCountLimits',
      'if ($null -eq $counts.MinimumInstanceCount -or $null -eq $counts.MaximumInstanceCount) { throw "Data node count metadata is incomplete." }',
      'if (' + nodes + ' -lt $counts.MinimumInstanceCount -or ' + nodes + ' -gt $counts.MaximumInstanceCount) { throw "Requested data node count exceeds instance limits." }',
      'foreach ($bound in @(@("MinimumIops",3000,"minimum"), @("MaximumIops",3000,"maximum"), @("MinimumThroughput",125,"minimum"), @("MaximumThroughput",125,"maximum"))) {',
      '  $entry = @($gp3[0].StorageTypeLimits | Where-Object { $_.LimitName -eq $bound[0] })',
      '  if ($entry.Count -eq 1 -and @($entry[0].LimitValues).Count -eq 1) {',
      '    $limit = [double]$entry[0].LimitValues[0]',
      '    if (($bound[2] -eq "minimum" -and $bound[1] -lt $limit) -or ($bound[2] -eq "maximum" -and $bound[1] -gt $limit)) { throw "Baseline gp3 performance is outside this instance offering; choose a different supported type or a separately sized configuration." }',
      '  }',
      '}',
      "Write-Host 'Offering checks passed. Review node quotas, gp3 IOPS/throughput limits, service-linked role, subnet addresses and the Terraform plan.'",
    ].join('\n') + '\n';
    const client = [
      'import json, subprocess, urllib.request',
      'import boto3',
      'from botocore.awsrequest import AWSRequest',
      'from botocore.auth import SigV4Auth',
      'def connect():',
      '    arn = subprocess.check_output(["terraform", "output", "-raw", "domain_arn"], text=True).strip()',
      '    if arn != ' + JSON.stringify(domainArn) + ': raise RuntimeError("State domain differs from this package")',
      '    endpoint = subprocess.check_output(["terraform", "output", "-raw", "domain_endpoint"], text=True).strip()',
      '    if not endpoint or "/" in endpoint or ":" in endpoint or any(c.isspace() for c in endpoint): raise RuntimeError("Invalid domain endpoint")',
      '    session = boto3.Session(region_name=' + JSON.stringify(region) + ')',
      '    credentials = session.get_credentials()',
      '    if credentials is None: raise RuntimeError("Use approved IAM role credentials")',
      '    return endpoint, credentials',
      'def request(connection, method, path, payload=None):',
      '    endpoint, credentials = connection',
      '    url = "https://" + endpoint + path',
      '    data = None if payload is None else json.dumps(payload).encode("utf-8")',
      '    request = AWSRequest(method=method, url=url, data=data, headers={"Content-Type": "application/json"})',
      '    SigV4Auth(credentials.get_frozen_credentials(), "es", ' + JSON.stringify(region) + ').add_auth(request)',
      '    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=dict(request.headers), method=method), timeout=30) as response:',
      '        return json.load(response)',
    ].join('\n') + '\n';
    const check = [
      'import json',
      'from opensearch_client import connect, request',
      'connection = connect()',
      'for path in ["/_cluster/health", "/_plugins/_security/authinfo"]:',
      '    print(path, json.dumps(request(connection, "GET", path), ensure_ascii=False))',
    ].join('\n') + '\n';
    const setup = [
      'import argparse, json, pathlib, urllib.error',
      'parser = argparse.ArgumentParser(description="Preview or explicitly apply this package application security role/mapping")',
      'parser.add_argument("--apply", action="store_true")',
      'parser.add_argument("--replace-existing", action="store_true")',
      'args = parser.parse_args()',
      'directory = pathlib.Path(__file__).resolve().parent',
      'role = json.loads((directory / "SECURITY-ROLE.json").read_text(encoding="utf-8"))',
      'mapping = json.loads((directory / "SECURITY-MAPPING.json").read_text(encoding="utf-8"))',
      'if not args.apply:',
      '    print(json.dumps({"role": role, "mapping": mapping}, indent=2))',
      '    raise SystemExit(0)',
      'if not mapping.get("backend_roles"): raise RuntimeError("No application roles selected; nothing to map")',
      'from opensearch_client import connect, request',
      'connection = connect()',
      'identity = request(connection, "GET", "/_plugins/_security/authinfo")',
      'if ' + JSON.stringify(admin) + ' not in identity.get("backend_roles", []): raise RuntimeError("Use the configured IAM master role")',
      'resources = [("/_plugins/_security/api/roles/archtoolkit_application", role), ("/_plugins/_security/api/rolesmapping/archtoolkit_application", mapping)]',
      'for path, payload in resources:',
      '    try:',
      '        request(connection, "GET", path)',
      '    except urllib.error.HTTPError as error:',
      '        if error.code != 404: raise',
      '    else:',
      '        if not args.replace_existing: raise RuntimeError("Existing definition at " + path + "; review before --replace-existing")',
      'for path, payload in resources:',
      '    response = request(connection, "PUT", path, payload)',
      '    print(path, json.dumps(response))',
      'print("Security writes accepted. Test application permissions and inspect both definitions; no index data was copied.")',
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': preflight, 'CHECK.py': check, 'opensearch_client.py': client, 'SETUP-ACCESS.py': setup, 'requirements.txt': 'boto3>=1.35,<2\n', 'SECURITY-ROLE.json': JSON.stringify({ cluster_permissions: ['cluster_composite_ops'], index_permissions: [{ index_patterns: [index + '*'], allowed_actions: ['read', 'write', 'create_index'] }], tenant_permissions: [] }, null, 2) + '\n', 'SECURITY-MAPPING.json': JSON.stringify({ backend_roles: applications, hosts: [], users: [] }, null, 2) + '\n' } };
  },
} satisfies Blueprint;
