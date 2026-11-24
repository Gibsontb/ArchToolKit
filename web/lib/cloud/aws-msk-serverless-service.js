import { awsMskClientFiles } from './aws-msk-client.js';
import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';
const regions = ['us-east-1', 'us-east-2', 'us-west-2', 'ca-central-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'eu-central-1', 'eu-north-1', 'eu-west-1', 'eu-west-2', 'eu-west-3'];
export const AWS_MSK_SERVERLESS_SERVICE = {
  id: 'aws_service_msk_serverless', label: 'Set up private MSK Serverless',
  description: 'Private IAM-authenticated Kafka cluster, scoped topic/group permissions on an existing role and a TLS-verified metadata client.',
  emits: ['aws_msk_serverless_cluster', 'aws_security_group', 'aws_iam_role_policy'],
  inputs: [
    { ...awsServiceRegion, options: awsServiceRegion.options .filter(option => regions.includes(option.value)), hint: 'Regions currently listed for MSK Serverless by AWS; GovCloud/China are not offered by this recipe.' },
    { id: 'name', label: 'Cluster name', control: 'text' },
    { id: 'subnets', label: 'Private subnet IDs', control: 'text', hint: 'Two or three subnets in distinct AZs within one VPC; private DNS and address capacity are required.' },
    { id: 'clients', label: 'Client security group IDs', control: 'text', hint: '1–5 same-VPC groups permitted on IAM/TLS TCP 9098 through a new cluster group.' },
    { id: 'role', label: 'Existing application IAM role ARN', control: 'text', hint: 'Same-account role with approved trust. Adds one scoped inline policy; does not change trust or assume the role.' },
    { id: 'access', label: 'Application operations', control: 'select', default: 'BOTH', options: [{ value: 'READ', label: 'Consume only' }, { value: 'WRITE', label: 'Produce only' }, { value: 'BOTH', label: 'Produce and consume' }] },
    { id: 'topics', label: 'Exact topic names', control: 'text', hint: 'Comma-separated names, no wildcards. Existing topics or separately created by an approved operator.' },
    { id: 'groups', label: 'Exact consumer group names', control: 'text', showWhen: { input: 'access', equals: ['READ', 'BOTH'] }, hint: 'Comma-separated consumer group IDs; no wildcard access.' },
    { id: 'create_topics', label: 'Allow application to create selected topics', control: 'select', default: 'NO', options: [{ value: 'NO', label: 'No — operator creates topics separately' }, { value: 'YES', label: 'Yes — exact listed topic names only' }] },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.msk.serverless.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), name = String(values.name ?? '').trim(), role = String(values.role ?? '').trim(), access = String(values.access ?? ''), createTopics = String(values.create_topics ?? '');
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients'), topics = list('topics'), groups = access === 'WRITE' ? [] : list('groups');
    const match = /^arn:aws:iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$/.exec(role);
    if (!regions.includes(region)) reject('aws_region', 'Choose a currently documented MSK Serverless region.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) reject('name', 'Use 1–64 letters, digits, underscores or hyphens.');
    if (subnets.length < 2 || subnets.length > 3 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Use two or three distinct-AZ private subnets.');
    if (!clients.length || clients.length > 5 || clients.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('clients', 'Use 1–5 existing same-VPC client groups.');
    if (!match) reject('role', 'Use an existing same-account application role ARN.');
    if (!['READ', 'WRITE', 'BOTH'].includes(access)) reject('access', 'Choose consume, produce or both.');
    for (const [id, names] of [['topics', topics], ['groups', groups]]         ) {
      if ((id === 'topics' || access !== 'WRITE') && (!names.length || names.length > 20 || names.some(value => !/^[A-Za-z0-9._-]{1,249}$/.test(value) || value === '.' || value === '..'))) reject(id, 'Use 1–20 exact names containing only letters, digits, periods, underscores or hyphens.');
    }
    if (!['NO', 'YES'].includes(createTopics)) reject('create_topics', 'Select whether exact topic creation is permitted.');
    const clusterArn = 'aws_msk_serverless_cluster.configured.arn';
    const objectArn = (kind        , value        ) => e('format("%s/%s", replace(' + clusterArn + ', ":cluster/", ":' + kind + '/"), ' + JSON.stringify(value) + ')');
    const statements = [
      { Effect: 'Allow', Action: ['kafka-cluster:Connect', 'kafka-cluster:DescribeCluster', ...(access !== 'READ' ? ['kafka-cluster:WriteDataIdempotently'] : [])], Resource: e(clusterArn) },
      { Effect: 'Allow', Action: ['kafka-cluster:DescribeTopic', ...(access !== 'WRITE' ? ['kafka-cluster:ReadData'] : []), ...(access !== 'READ' ? ['kafka-cluster:WriteData'] : []), ...(createTopics === 'YES' ? ['kafka-cluster:CreateTopic'] : [])], Resource: topics.map(topic => objectArn('topic', topic)) },
      ...(groups.length ? [{ Effect: 'Allow', Action: ['kafka-cluster:DescribeGroup', 'kafka-cluster:AlterGroup'], Resource: groups.map(group => objectArn('group', group)) }] : []),
    ];
    const guide = [
      '# Private MSK Serverless',
      '## Prepare\nConfirm the selected region is currently available for MSK Serverless and review cluster/partition/throughput/storage quotas and cost. Serverless uses IAM authentication; Kafka ACLs, SCRAM and mTLS authentication are not configured. Service-managed at-rest encryption is separate from IAM-authenticated TLS transport; this recipe offers no customer storage key field. Confirm the approved data boundary, private DNS, client network route, subnet free IPs, NACLs and client outbound TCP 9098. Existing role trust and any required service-linked role permissions remain owner prerequisites. This is a new empty cluster, not a copy of existing topics or records.',
      '## Deploy\nRun terraform init, terraform validate and terraform plan -out=service.tfplan. Plan reads all selected subnet/client/role metadata and rejects another account, multiple VPCs or repeated AZs. Review the new 9098-only group, serverless cluster and exact-role inline policy, then apply the reviewed plan. Wait for cluster ACTIVE using aws kafka describe-cluster-v2 with the output ARN and selected region; inspect Serverless settings and private endpoints. No public access or anonymous listener is created. The cluster uses Terraform prevent_destroy; the inline policy remains a separately managed resource. This is not an AWS deletion lock. Coordinate shared role inline-policy names.',
      '## Configure clients and topics\nReview CLIENT-CONFIG.json, install approved requirements.txt packages and use the existing application role through the normal credential provider chain. CHECK.py only requests metadata for each selected topic; it does not join a consumer group, commit offsets, produce records or auto-create topics. Run it from the applied package inside the authorized client network after approved topic creation. Empty/missing metadata is an error, not successful validation. Create each selected topic separately through an approved Kafka administration client with replication factor 3 and a reviewed partition/retention policy. Optional CreateTopic permission is limited to the exact names; the package does not issue that API. Transactional producers and arbitrary topic/group names are not granted. Idempotent producer cluster permission is included for write modes, with topic WriteData still restricted to listed names.',
      '## Verify\nConfirm DescribeClusterV2 reports ACTIVE and the expected cluster, region, account, subnet and security settings. Check topic partition leaders, replica health, retention and serverless CloudWatch capacity/lag metrics. Test the configured producer and consumer roles against approved pilot records, exact topic/group names, offset behavior, retries and replay. A metadata check is not proof of successful publish/consume or exactly-once application behavior. Reject unlisted topics/groups and unauthorized network sources. Use TLS certificate and hostname validation; do not disable verification or place access keys in properties.',
      '## Migration and recovery\nInventory source topic configurations, schemas, partitions, retention, consumer groups and offsets. Choose a separately designed replication/replay process, prove compatibility/quotas and reconcile counts and duplicates before producer/consumer cutover. Group names do not transfer committed offsets. Keep a replay source and explicit rollback/write-reconciliation procedure; serverless managed infrastructure is not a backup of application records. No MirrorMaker/MSK Connect replication, topic configuration, data transfer, broker logs or restore repository is provisioned. Cluster removal requires a reviewed change to prevent_destroy after producer shutdown, retention/export and cutover acceptance.',
      'https://docs.aws.amazon.com/msk/latest/developerguide/serverless.html\nhttps://docs.aws.amazon.com/msk/latest/developerguide/iam-access-control-use-cases.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'clients', { for_each: x('toset(' + JSON.stringify(clients) + ')'), id: x('each.value') }),
      dat('aws_iam_role', 'application', { name: match?.[2]?.split('/').at(-1) ?? '' }),
      res('aws_security_group', 'cluster', { name: name + '-kafka', description: 'Approved IAM Kafka clients', vpc_id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id') }, [blk('ingress', { protocol: 'tcp', from_port: 9098, to_port: 9098, security_groups: clients })]),
      res('aws_msk_serverless_cluster', 'configured', { cluster_name: name, tags: x(hcl({ Name: name })) }, [
        blk('vpc_config', { subnet_ids: subnets, security_group_ids: x('[aws_security_group.cluster.id]') }),
        blk('client_authentication', {}, [blk('sasl', {}, [blk('iam', { enabled: true })])]),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(match?.[1] ?? '') + ' && data.aws_iam_role.application.arn == ' + JSON.stringify(role) + ' && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + subnets.length + ' && alltrue([for group in data.aws_security_group.clients : group.vpc_id == data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id])'), error_message: 'Use this account role, distinct-AZ subnets in one VPC and same-VPC client groups.' })]),
      ]),
      res('aws_iam_role_policy', 'application', { name: name + '-kafka-client', role: x('data.aws_iam_role.application.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: statements })) }),
      output('cluster_arn', clusterArn), output('bootstrap_brokers', 'aws_msk_serverless_cluster.configured.bootstrap_brokers_sasl_iam'),
    ], guide, findings);
    return { ...result, files: { ...result.files, ...awsMskClientFiles(region, topics, groups, access, role) } };
  },
}                    ;
