import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
import { AWS_MSK_SERVERLESS_SERVICE } from './aws-msk-serverless-service.js';
import { awsMskClientFiles } from './aws-msk-client.js';
const versions = ['3.9.x', '3.9.x.kraft', '4.0.x.kraft', '4.1.x.kraft', '4.2.x.kraft'];
const sizes = ['kafka.m5.large', 'kafka.m5.xlarge', 'kafka.m5.2xlarge', 'kafka.m5.4xlarge', 'kafka.m7g.large', 'kafka.m7g.xlarge', 'kafka.m7g.2xlarge', 'kafka.m7g.4xlarge'];
export const AWS_MSK_PROVISIONED_SERVICE = {
  id: 'aws_service_msk_provisioned', label: 'Set up private provisioned MSK Standard brokers',
  description: 'Private IAM/TLS Kafka, two or three AZs, sized Standard brokers/local EBS, KMS encryption, retained broker logs, exact topic/group permissions and metadata-check code.',
  emits: ['aws_msk_cluster', 'aws_msk_configuration', 'aws_security_group', 'aws_iam_role_policy', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    ...AWS_MSK_SERVERLESS_SERVICE.inputs.filter(input => input.id !== 'aws_region'),
    { id: 'version', label: 'Kafka version / metadata mode', control: 'select', default: '3.9.x.kraft', options: versions.map(value => ({ value, label: value + (value.endsWith('.kraft') ? ' (KRaft)' : ' (ZooKeeper)') })) },
    { id: 'size', label: 'Standard broker size', control: 'select', default: 'kafka.m5.large', options: sizes.map(value => ({ value, label: value })), hint: 'Regional broker availability and quota require owner confirmation; this recipe excludes Express and burstable brokers.' },
    { id: 'per_az', label: 'Brokers per AZ', control: 'number', default: 1 },
    { id: 'storage', label: 'Local EBS storage per broker (GiB)', control: 'number', default: 1000 },
    { id: 'retention', label: 'Default topic retention (hours)', control: 'number', default: 168 },
    { id: 'log_retention', label: 'Broker log retention (days)', control: 'select', default: '90', options: ['7', '14', '30', '60', '90', '180', '365'].map(value => ({ value, label: value })) },
    { id: 'kms', label: 'Existing broker storage KMS key ARN', control: 'text' },
    { id: 'log_kms', label: 'Existing CloudWatch log KMS key ARN', control: 'text', hint: 'Key policy must allow the regional CloudWatch Logs service with the exact log-group encryption context.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.msk.provisioned.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), role = String(values.role ?? '').trim(), version = String(values.version ?? ''), size = String(values.size ?? ''), access = String(values.access ?? ''), create = String(values.create_topics ?? '');
    const list = (key        ) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients'), topics = list('topics'), groups = access === 'WRITE' ? [] : list('groups');
    const match = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), account = match?.[1] ?? '';
    const perAz = Number(values.per_az), storage = Number(values.storage), retention = Number(values.retention), logRetention = Number(values.log_retention);
    const kms = String(values.kms ?? '').trim(), logKms = String(values.log_kms ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) reject('name', 'Use a 1–64 character literal cluster name.');
    if (subnets.length < 2 || subnets.length > 3 || (region === 'us-west-1' && subnets.length !== 2) || subnets.some(id => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))) reject('subnets', 'Use two or three distinct-AZ private subnets; N. California requires two.');
    if (!clients.length || clients.length > 5 || clients.some(id => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))) reject('clients', 'Use 1–5 same-VPC application security groups.');
    if (!match) reject('role', 'Use an existing same-account application role ARN.');
    if (!versions.includes(version)) reject('version', 'Choose a supported version and metadata mode, then verify current regional availability.');
    if (!sizes.includes(size)) reject('size', 'Choose one of the listed Standard broker sizes.');
    if (!Number.isInteger(perAz) || perAz < 1 || perAz > 10) reject('per_az', 'Use 1–10 brokers per AZ; this recipe caps the total at 30.');
    if (!Number.isInteger(storage) || storage < 100 || storage > 16384) reject('storage', 'Use 100–16384 GiB per broker.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 8760) reject('retention', 'Use 1–8760 hours; verify capacity against write rate and replication.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logRetention)) reject('log_retention', 'Choose a listed log retention.');
    if (!['READ', 'WRITE', 'BOTH'].includes(access)) reject('access', 'Choose consume, produce or both.');
    if (!['YES', 'NO'].includes(create)) reject('create_topics', 'Choose whether exact-topic creation is permitted.');
    for (const [key, names] of [['topics', topics], ['groups', groups]]         ) {
      if ((key === 'topics' || access !== 'WRITE') && (!names.length || names.length > 20 || names.some(value => !/^[A-Za-z0-9._-]{1,249}$/.test(value) || ['.', '..'].includes(value)))) reject(key, 'Use 1–20 literal topic/group names without wildcards.');
    }
    for (const [key, arn] of [['kms', kms], ['log_kms', logKms]]) if (!new RegExp('^arn:' + partition + ':kms:' + region + ':' + account + ':key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(arn )) reject(key , 'Use an existing same-account regional symmetric KMS key ARN.');
    const cluster = 'aws_msk_cluster.configured.arn';
    const objectArn = (kind        , value        ) => e('format("%s/%s", replace(' + cluster + ', ":cluster/", ":' + kind + '/"), ' + JSON.stringify(value) + ')');
    const statements = [
      { Effect: 'Allow', Action: ['kafka-cluster:Connect', 'kafka-cluster:DescribeCluster', ...(access !== 'READ' ? ['kafka-cluster:WriteDataIdempotently'] : [])], Resource: e(cluster) },
      { Effect: 'Allow', Action: ['kafka-cluster:DescribeTopic', ...(access !== 'WRITE' ? ['kafka-cluster:ReadData'] : []), ...(access !== 'READ' ? ['kafka-cluster:WriteData'] : []), ...(create === 'YES' ? ['kafka-cluster:CreateTopic'] : [])], Resource: topics.map(topic => objectArn('topic', topic)) },
      ...(groups.length ? [{ Effect: 'Allow', Action: ['kafka-cluster:DescribeGroup', 'kafka-cluster:AlterGroup'], Resource: groups.map(group => objectArn('group', group)) }] : []),
    ];
    const replicas = Math.min(3, subnets.length * perAz), minIsr = replicas - 1;
    const configuration = ['auto.create.topics.enable=false', 'unclean.leader.election.enable=false', 'default.replication.factor=' + replicas, 'min.insync.replicas=' + minIsr, 'offsets.topic.replication.factor=' + replicas, 'transaction.state.log.replication.factor=' + replicas, 'transaction.state.log.min.isr=' + minIsr, 'log.retention.hours=' + retention].join('\n') + '\n';
    const guide = [
      '# Provisioned MSK Standard',
      '## Prepare\nThis creates a new empty cluster, not a topic/offset/data migration. Review regional Standard-broker availability, supported Kafka version/mode, quotas and current prices. Run PREFLIGHT.ps1 to check this account and the regional ACTIVE version list; this does not prove broker-size availability or capacity. Confirm approved role trust, IAM permission boundaries, private VPC/DNS/routes/NACLs and service-linked-role/log-delivery permissions. Plan checks distinct AZs, one VPC, standard AZ type, free IPs, disallowed use1-az3 and same-VPC client groups. Public subnet auto-address assignment is rejected; routing still requires separate review.',
      'Existing enabled symmetric keys are mandatory for broker storage and retained CloudWatch broker logs. Review key policies/grants for MSK and logs.' + region + '.amazonaws.com (regional service principal varies by partition); restrict log encryption context to the created log group. No key-policy/trust overwrite, FIPS certification, APL listing or authorization is inferred. Review source data, schema/metadata/log classification and approved destination before moving records.',
      '## Deploy\nRun terraform init, terraform validate and terraform plan -out=service.tfplan; review and apply the approved plan. New cluster ingress permits selected application groups on IAM/TLS 9098; self-only broker traffic is separately allowed. Public access, unauthenticated and SCRAM access are disabled. Client and in-cluster traffic use TLS. Local EBS capacity is per broker, not total estate storage. There is no tiered storage, automatic capacity scaling, provisioned-throughput setting or Express broker support in this recipe. Storage cannot shrink; monitor disk utilization/write rate and plan capacity increases before saturation.',
      'Broker configuration disables topic auto-creation and unclean leader election, sets bounded retention and replication/min-ISR defaults based on broker count. Existing topic settings can override defaults. Two-broker deployments default to replication 2/min ISR 1, allowing an acknowledged record to have only one in-sync copy during failure; choose three-AZ/three-broker or stronger reviewed per-topic ISR requirements where loss/availability requirements demand it. Producers must explicitly use acks=all and reviewed retries/idempotence. Replication is not backup.',
      '## Verify and use\nAfter ACTIVE, inspect describe-cluster-v2 in the selected region: account/ARN, version/mode, broker count/size, private subnets, IAM-only TLS, both keys and broker log delivery. Verify CloudWatch log arrival, permissions/retention and storage/under-replicated-partition/offline-partition/lag metrics. Install the approved requirements and run CHECK.py inside the authorized client network with the selected application role. It only reads named-topic metadata: no publish, consume-group join, offset commit or auto-create. Missing topics fail. Separately create reviewed topics, partition counts, replication, min ISR and retention; optional CreateTopic permission is only for the exact selected names. Transactional producer permissions are not granted.',
      '## Migration and recovery\nInventory source topic/schema/partition settings, retention, throughput, consumer groups and committed offsets. Design an explicit MirrorMaker/Connect/Replicator or application replay workflow, reconcile counts/duplicates/order and verify group-offset translation before cutover. This package does not create replication, restore snapshots or transfer records. Preserve a replay/rollback source, test failure and restore, and obtain owner acceptance before source decommission. Terraform prevent_destroy guards the cluster/configuration; it is not an AWS deletion lock. Shutdown, accepted export and an explicit reviewed lifecycle change are required for removal.',
      'https://docs.aws.amazon.com/msk/latest/developerguide/msk-create-cluster.html\nhttps://docs.aws.amazon.com/msk/latest/developerguide/supported-kafka-versions.html\nhttps://docs.aws.amazon.com/msk/latest/developerguide/iam-access-control-use-cases.html',
    ].join('\n\n') + '\n';
    const first = 'data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + ']';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'application', { name: match?.[2]?.split('/').at(-1) ?? '' }),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'clients', { for_each: x('toset(' + JSON.stringify(clients) + ')'), id: x('each.value') }),
      dat('aws_availability_zone', 'selected', { for_each: x('data.aws_subnet.selected'), name: x('each.value.availability_zone') }),
      dat('aws_kms_key', 'storage', { key_id: kms }), dat('aws_kms_key', 'logs', { key_id: logKms }),
      res('aws_security_group', 'cluster', { name: name + '-kafka', description: 'Private IAM clients and broker-only traffic', vpc_id: x(first + '.vpc_id') }, [
        blk('ingress', { protocol: 'tcp', from_port: 9098, to_port: 9098, security_groups: clients }),
        blk('ingress', { protocol: '-1', from_port: 0, to_port: 0, self: true }),
        blk('egress', { protocol: '-1', from_port: 0, to_port: 0, self: true }),
      ]),
      res('aws_cloudwatch_log_group', 'brokers', { name: '/aws/msk/' + name + '/brokers', retention_in_days: logRetention, kms_key_id: logKms }),
      res('aws_msk_configuration', 'configured', { name: name + '-broker-defaults', kafka_versions: [version], server_properties: configuration }, [blk('lifecycle', { prevent_destroy: true, create_before_destroy: true })]),
      res('aws_msk_cluster', 'configured', { cluster_name: name, kafka_version: version, number_of_broker_nodes: subnets.length * perAz, storage_mode: 'LOCAL', enhanced_monitoring: 'PER_BROKER', tags: x(hcl({ Name: name })) }, [
        blk('broker_node_group_info', { instance_type: size, client_subnets: subnets, security_groups: x('[aws_security_group.cluster.id]') }, [
          blk('storage_info', {}, [blk('ebs_storage_info', { volume_size: storage })]),
          blk('connectivity_info', {}, [blk('public_access', { type: 'DISABLED' })]),
        ]),
        blk('client_authentication', { unauthenticated: false }, [blk('sasl', { iam: true, scram: false })]),
        blk('encryption_info', { encryption_at_rest_kms_key_arn: kms }, [blk('encryption_in_transit', { client_broker: 'TLS', in_cluster: true })]),
        blk('configuration_info', { arn: x('aws_msk_configuration.configured.arn'), revision: x('aws_msk_configuration.configured.latest_revision') }),
        blk('logging_info', {}, [blk('broker_logs', {}, [blk('cloudwatch_logs', { enabled: true, log_group: x('aws_cloudwatch_log_group.brokers.name') })])]),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', {
          condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.application.arn == ' + JSON.stringify(role) + ' && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + subnets.length + ' && alltrue([for subnet in data.aws_subnet.selected : !subnet.map_public_ip_on_launch && subnet.available_ip_address_count >= 6 && subnet.availability_zone_id != "use1-az3"]) && alltrue([for zone in data.aws_availability_zone.selected : zone.zone_type == "availability-zone"]) && alltrue([for group in data.aws_security_group.clients : group.vpc_id == ' + first + '.vpc_id]) && alltrue([for key in [data.aws_kms_key.storage, data.aws_kms_key.logs] : key.enabled && key.key_spec == "SYMMETRIC_DEFAULT" && key.key_usage == "ENCRYPT_DECRYPT"])'),
          error_message: 'Use this account role, same-VPC distinct standard private AZs with free IPs, approved client groups and enabled symmetric encryption keys.',
        })]),
      ]),
      res('aws_iam_role_policy', 'application', { name: name + '-kafka-client', role: x('data.aws_iam_role.application.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: statements })) }),
      output('cluster_arn', cluster), output('bootstrap_brokers', 'aws_msk_cluster.configured.bootstrap_brokers_sasl_iam'),
    ], guide, findings);
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw "MSK metadata request failed." }; return ($raw | ConvertFrom-Json) }',
      "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json'); if ($identity.Account -ne '" + account + "') { throw 'Unexpected application account.' }",
      "$response = Read-AwsJson @('kafka','list-kafka-versions','--region','" + region + "','--output','json')",
      "$matches = @($response.KafkaVersions | Where-Object { $_.Version -eq '" + version + "' -and $_.Status -eq 'ACTIVE' })",
      'if ($matches.Count -ne 1) { throw "Selected Kafka version/mode is not ACTIVE in this region." }',
      'Write-Host "Regional version/account checks passed. Confirm broker-size availability, quotas, subnet routing and key policies before deployment. No cluster created."',
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, ...awsMskClientFiles(region, topics, groups, access, role), 'BROKER-PROPERTIES.txt': configuration, 'PREFLIGHT.ps1': preflight } };
  },
}                    ;
