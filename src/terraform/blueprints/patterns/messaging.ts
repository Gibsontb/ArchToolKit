/**
 * `<p>_app_managed_messaging` and `<p>_app_managed_kafka` (tier patterns
 * `managed-messaging` and `managed-kafka`, addendum A.4.2 Middleware): the
 * brokers an app's queues and topics move to. The data moves by MirrorMaker 2
 * (`app_mm2`) for Kafka and by Shovel for RabbitMQ.
 *
 * Messaging
 *   AWS     Amazon MQ (RabbitMQ or ActiveMQ): a private broker in the app
 *           tier, Multi-AZ for tier 0 / 1, logs on, its admin password a
 *           sensitive variable
 *   Azure   Service Bus: a Premium (zone-redundant) or Standard namespace,
 *           local auth off, the queues and topics named
 *   OCI     OCI Queue: a queue per name, dead-lettering after 10 deliveries
 *
 * Kafka
 *   AWS     MSK: brokers across the zones of the app tier (dual-stack
 *           connectivity on a dual-stack network), IAM and SCRAM auth, TLS in
 *           transit, broker logs, a configuration
 *   Azure   Event Hubs (Kafka endpoint): a Premium or Standard namespace and an
 *           event hub per topic
 *   Google  Managed Service for Apache Kafka: a cluster on the app tier's
 *           subnet and its topics
 *   OCI     Streaming with Apache Kafka: a cluster configuration and a cluster
 *           in the app tier
 */

import { info, type Finding } from '../../../core/findings.ts';
import type { Blueprint, BlueprintInput, BlueprintValues } from '../../../kit/blueprint.ts';
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.ts';
import type { HclBlock } from '../../hcl.ts';
import { LANDING_ZONE_SOURCE, blk, hcl, ident, lzRef, output, q, res, rname, secretVariable, x, type MigCloud } from '../migration/common.ts';
import { NETWORK_INPUT, PATTERN_GROUP, appInputs, appOf, ipv6Of, listOf, namePrefix, patternMainTf, preamble, securityGroupOf, subnetOf, subnetsOf, tagsExpr } from './common.ts';

const ha = (crit: string): boolean => crit === 'tier0' || crit === 'tier1';

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

type MsgCloud = 'aws' | 'azure' | 'oci';

function messagingInputs(platform: MsgCloud): BlueprintInput[] {
  return [
    ...appInputs(),
    NETWORK_INPUT,
    { id: 'queues', label: 'Queues', control: 'text', default: 'orders payments', hint: 'Space-separated.' },
    ...(platform === 'aws'
      ? [
          { id: 'engine', label: 'Engine', control: 'select' as const, default: 'RabbitMQ', options: [{ value: 'RabbitMQ', label: 'RabbitMQ' }, { value: 'ActiveMQ', label: 'ActiveMQ' }] },
          { id: 'engine_version', label: 'Engine version', control: 'text' as const, default: '3.13', hint: 'RabbitMQ 3.13 or 4.x; ActiveMQ 5.18.' },
          { id: 'instance_type', label: 'Broker size', control: 'combo' as const, default: 'mq.m7g.large', options: ['mq.m7g.medium', 'mq.m7g.large', 'mq.m7g.xlarge', 'mq.m5.large'].map((v) => ({ value: v, label: v })) },
        ]
      : platform === 'azure'
        ? [
            { id: 'topics', label: 'Topics', control: 'text' as const, default: 'events', hint: 'Space-separated.' },
            { id: 'sku', label: 'Tier', control: 'select' as const, default: 'Premium', options: [{ value: 'Premium', label: 'Premium (zone-redundant, VNet)' }, { value: 'Standard', label: 'Standard' }] },
          ]
        : [{ id: 'retention_hours', label: 'Retention (hours)', control: 'number' as const, default: 168, min: 10, max: 168 }]),
    LANDING_ZONE_SOURCE,
  ];
}

function awsMessaging(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'aws'));
  const engine = valueOf(values, 'engine', 'RabbitMQ') === 'ActiveMQ' ? 'ActiveMQ' : 'RabbitMQ';
  const multi = ha(app.criticality);
  const pw = `${app.id}_mq_admin_password`;
  findings.push(info('tf.app.mq-queues', `The queues (${listOf(values, 'queues').join(', ')}) are created by the application or the Shovel / configuration import, not by Terraform (Amazon MQ has no queue resource).`, { path: 'queues' }));
  if (engine === 'RabbitMQ' && multi) findings.push(info('tf.app.mq-rabbit-cluster', 'RabbitMQ on Amazon MQ is highly available as a three-node cluster (CLUSTER_MULTI_AZ).', { source: 'https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-broker-architecture.html' }));
  return [
    ...preamble('aws', values),
    secretVariable(pw, `The ${engine} admin password of ${app.name}'s broker.`),
    res('aws_mq_broker', 'app', {
      broker_name: x(`"${pfx}-mq"`),
      engine_type: engine,
      engine_version: valueOf(values, 'engine_version', engine === 'RabbitMQ' ? '3.13' : '5.18'),
      host_instance_type: valueOf(values, 'instance_type', 'mq.m7g.large'),
      deployment_mode: multi ? (engine === 'RabbitMQ' ? 'CLUSTER_MULTI_AZ' : 'ACTIVE_STANDBY_MULTI_AZ') : 'SINGLE_INSTANCE',
      publicly_accessible: false,
      subnet_ids: x(multi ? (engine === 'RabbitMQ' ? subnetsOf(lz, net, 'app') : `slice(${subnetsOf(lz, net, 'app')}, 0, 2)`) : `[${subnetOf(lz, net, 'app')}]`),
      security_groups: x(`[${securityGroupOf(lz, net, 'app')}]`),
      auto_minor_version_upgrade: true,
      apply_immediately: false,
      tags,
    }, [
      blk('encryption_options', { use_aws_owned_key: false, kms_key_id: x(`${lz}.kms_key_id`) }),
      blk('logs', { general: true, audit: engine === 'ActiveMQ' ? 'true' : undefined }),
      blk('maintenance_window_start_time', { day_of_week: 'SUNDAY', time_of_day: '03:00', time_zone: 'UTC' }),
      blk('user', { username: 'atkadmin', password: x(`var.${pw}`), console_access: engine === 'ActiveMQ' ? true : undefined }),
    ]),
    output('endpoints', 'aws_mq_broker.app.instances[*].endpoints'),
  ];
}

function azureMessaging(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'azure'));
  const premium = valueOf(values, 'sku', 'Premium') === 'Premium';
  const blocks: HclBlock[] = [
    ...preamble('azure', values),
    res('azurerm_servicebus_namespace', 'app', {
      name: x(`"${pfx}-bus"`),
      resource_group_name: x(`${lz}.resource_group[${q(net)}]`),
      location: x(`${lz}.location`),
      sku: premium ? 'Premium' : 'Standard',
      capacity: premium ? (ha(app.criticality) ? 2 : 1) : undefined,
      premium_messaging_partitions: premium ? 1 : undefined,
      local_auth_enabled: false,
      minimum_tls_version: '1.2',
      public_network_access_enabled: !premium,
      tags,
    }, [blk('identity', { type: 'SystemAssigned' })]),
  ];
  if (premium) {
    blocks.push(
      res('azurerm_private_endpoint', 'servicebus', {
        name: x(`"${pfx}-bus-pe"`),
        resource_group_name: x(`${lz}.resource_group[${q(net)}]`),
        location: x(`${lz}.location`),
        subnet_id: x(subnetOf(lz, net, 'app')),
        tags,
      }, [blk('private_service_connection', { name: 'namespace', private_connection_resource_id: x('azurerm_servicebus_namespace.app.id'), subresource_names: ['namespace'], is_manual_connection: false })]),
    );
  }
  for (const qn of listOf(values, 'queues')) {
    blocks.push(res('azurerm_servicebus_queue', ident('queue', qn), { name: rname(qn), namespace_id: x('azurerm_servicebus_namespace.app.id'), dead_lettering_on_message_expiration: true, max_delivery_count: 10 }));
  }
  for (const t of listOf(values, 'topics')) {
    blocks.push(res('azurerm_servicebus_topic', ident('topic', t), { name: rname(t), namespace_id: x('azurerm_servicebus_namespace.app.id') }));
  }
  blocks.push(output('endpoint', 'azurerm_servicebus_namespace.app.endpoint'));
  return blocks;
}

function ociMessaging(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const tags = x(tagsExpr(app, 'oci'));
  const retention = Math.min(168, Math.max(10, numberOf(values, 'retention_hours', 168)));
  return [
    ...preamble('oci', values),
    ...listOf(values, 'queues').map((qn) =>
      res('oci_queue_queue', ident('queue', qn), {
        compartment_id: x(`${lz}.compartment_id`),
        display_name: x(`"${pfx}-${rname(qn)}"`),
        retention_in_seconds: retention * 3600,
        visibility_in_seconds: 30,
        dead_letter_queue_delivery_count: 10,
        freeform_tags: tags,
      }),
    ),
    output('queues', `{ ${listOf(values, 'queues').map((qn) => `${q(rname(qn))} = oci_queue_queue.${ident('queue', qn)}.messages_endpoint`).join(', ')} }`),
  ];
}

// ---------------------------------------------------------------------------
// Kafka
// ---------------------------------------------------------------------------

function kafkaInputs(platform: MigCloud): BlueprintInput[] {
  return [
    ...appInputs(),
    NETWORK_INPUT,
    { id: 'topics', label: 'Topics', control: 'text', default: 'orders events', hint: 'Space-separated (MirrorMaker 2 also creates the ones it mirrors).' },
    { id: 'partitions', label: 'Partitions per topic', control: 'number', default: 6, min: 1, max: 1024 },
    ...(platform === 'aws'
      ? [
          { id: 'kafka_version', label: 'Kafka version', control: 'text' as const, default: '3.8.x' },
          { id: 'broker_size', label: 'Broker size', control: 'combo' as const, default: 'kafka.m7g.large', options: ['kafka.m7g.large', 'kafka.m7g.xlarge', 'kafka.m7g.2xlarge', 'kafka.m5.large'].map((v) => ({ value: v, label: v })) },
          { id: 'storage_gib', label: 'Storage per broker (GiB)', control: 'number' as const, default: 1000, min: 1 },
        ]
      : platform === 'azure'
        ? [{ id: 'sku', label: 'Tier', control: 'select' as const, default: 'Premium', options: [{ value: 'Premium', label: 'Premium' }, { value: 'Standard', label: 'Standard' }] }]
        : platform === 'google'
          ? [
              { id: 'vcpu', label: 'vCPUs', control: 'number' as const, default: 3, min: 3 },
              { id: 'memory_gib', label: 'Memory (GiB)', control: 'number' as const, default: 12, min: 3 },
            ]
          : [
              { id: 'kafka_version', label: 'Kafka version', control: 'text' as const, default: '3.7.0' },
              { id: 'brokers', label: 'Brokers', control: 'number' as const, default: 3, min: 1 },
              { id: 'ocpus', label: 'OCPUs per broker', control: 'number' as const, default: 2, min: 1 },
            ]),
    LANDING_ZONE_SOURCE,
  ];
}

function awsKafka(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'aws'));
  const partitions = numberOf(values, 'partitions', 6);
  findings.push(info('tf.app.msk-topics', `The topics (${listOf(values, 'topics').join(', ')}) are created by MirrorMaker 2 or the application: the pinned AWS provider has no MSK topic resource.`, { path: 'topics' }));
  return [
    ...preamble('aws', values),
    res('aws_cloudwatch_log_group', 'kafka', { name: x(`"/aws/msk/${pfx}"`), retention_in_days: 90, tags }),
    res('aws_msk_configuration', 'app', {
      name: x(`"${pfx}-kafka"`),
      kafka_versions: [valueOf(values, 'kafka_version', '3.8.x')],
      server_properties: x(`<<-EOT\n    auto.create.topics.enable=false\n    default.replication.factor=3\n    min.insync.replicas=2\n    num.partitions=${partitions}\n    unclean.leader.election.enable=false\n  EOT`),
    }),
    res('aws_msk_cluster', 'app', {
      cluster_name: x(`"${pfx}-kafka"`),
      kafka_version: valueOf(values, 'kafka_version', '3.8.x'),
      number_of_broker_nodes: x(`length(${subnetsOf(lz, net, 'app')})`),
      enhanced_monitoring: 'PER_TOPIC_PER_BROKER',
      tags,
    }, [
      blk('broker_node_group_info', {
        client_subnets: x(subnetsOf(lz, net, 'app')),
        instance_type: valueOf(values, 'broker_size', 'kafka.m7g.large'),
        security_groups: x(`[${securityGroupOf(lz, net, 'app')}]`),
      }, [
        blk('storage_info', {}, [blk('ebs_storage_info', { volume_size: numberOf(values, 'storage_gib', 1000) })]),
        blk('connectivity_info', { network_type: x(`${ipv6Of(lz, net)} ? "DUAL" : "IPV4"`) }),
      ]),
      blk('client_authentication', { unauthenticated: false }, [blk('sasl', { iam: true, scram: true })]),
      blk('encryption_info', { encryption_at_rest_kms_key_arn: x(`${lz}.kms_key_id`) }, [blk('encryption_in_transit', { client_broker: 'TLS', in_cluster: true })]),
      blk('configuration_info', { arn: x('aws_msk_configuration.app.arn'), revision: x('aws_msk_configuration.app.latest_revision') }),
      blk('logging_info', {}, [blk('broker_logs', {}, [blk('cloudwatch_logs', { enabled: true, log_group: x('aws_cloudwatch_log_group.kafka.name') })])]),
    ]),
    output('bootstrap_brokers', 'aws_msk_cluster.app.bootstrap_brokers_sasl_iam'),
    output('bootstrap_brokers_scram', 'aws_msk_cluster.app.bootstrap_brokers_sasl_scram', 'For MirrorMaker 2 with SCRAM (a Secrets Manager secret associated with the cluster).'),
  ];
}

function azureKafka(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'azure'));
  const premium = valueOf(values, 'sku', 'Premium') === 'Premium';
  const blocks: HclBlock[] = [
    ...preamble('azure', values),
    res('azurerm_eventhub_namespace', 'app', {
      name: x(`"${pfx}-kafka"`),
      resource_group_name: x(`${lz}.resource_group[${q(net)}]`),
      location: x(`${lz}.location`),
      sku: premium ? 'Premium' : 'Standard',
      capacity: premium ? (ha(app.criticality) ? 2 : 1) : 2,
      auto_inflate_enabled: premium ? undefined : true,
      maximum_throughput_units: premium ? undefined : 10,
      local_authentication_enabled: false,
      minimum_tls_version: '1.2',
      public_network_access_enabled: false,
      tags,
    }, [blk('identity', { type: 'SystemAssigned' })]),
    res('azurerm_private_endpoint', 'kafka', {
      name: x(`"${pfx}-kafka-pe"`),
      resource_group_name: x(`${lz}.resource_group[${q(net)}]`),
      location: x(`${lz}.location`),
      subnet_id: x(subnetOf(lz, net, 'app')),
      tags,
    }, [blk('private_service_connection', { name: 'namespace', private_connection_resource_id: x('azurerm_eventhub_namespace.app.id'), subresource_names: ['namespace'], is_manual_connection: false })]),
  ];
  for (const t of listOf(values, 'topics')) {
    blocks.push(res('azurerm_eventhub', ident('topic', t), { name: rname(t), namespace_id: x('azurerm_eventhub_namespace.app.id'), partition_count: Math.min(premium ? 100 : 32, numberOf(values, 'partitions', 6)), message_retention: 7 }));
  }
  blocks.push(output('kafka_endpoint', '"${azurerm_eventhub_namespace.app.name}.servicebus.windows.net:9093"'));
  return blocks;
}

function googleKafka(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const labels = x(tagsExpr(app, 'google'));
  const project = `${lz}.project`;
  const vcpu = Math.max(3, numberOf(values, 'vcpu', 3));
  const mem = Math.max(vcpu, numberOf(values, 'memory_gib', 12));
  const blocks: HclBlock[] = [
    ...preamble('google', values),
    res('google_managed_kafka_cluster', 'app', {
      cluster_id: x(`"${pfx}-kafka"`),
      project: x(project),
      location: x(`${lz}.region`),
      labels,
    }, [
      blk('capacity_config', { vcpu_count: String(vcpu), memory_bytes: String(mem * 1024 * 1024 * 1024) }),
      blk('gcp_config', { kms_key: undefined }, [blk('access_config', {}, [blk('network_configs', { subnet: x(subnetOf(lz, net, 'app')) })])]),
      blk('rebalance_config', { mode: 'AUTO_REBALANCE_ON_SCALE_UP' }),
    ]),
  ];
  for (const t of listOf(values, 'topics')) {
    blocks.push(res('google_managed_kafka_topic', ident('topic', t), { topic_id: rname(t), cluster: x('google_managed_kafka_cluster.app.cluster_id'), project: x(project), location: x(`${lz}.region`), partition_count: numberOf(values, 'partitions', 6), replication_factor: 3 }));
  }
  blocks.push(output('bootstrap', '"bootstrap.${google_managed_kafka_cluster.app.cluster_id}.${google_managed_kafka_cluster.app.location}.managedkafka.${google_managed_kafka_cluster.app.project}.cloud.goog:9092"'));
  return blocks;
}

function ociKafka(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'oci'));
  const comp = `${lz}.compartment_id`;
  const partitions = numberOf(values, 'partitions', 6);
  findings.push(info('tf.app.oci-kafka-values', 'The cluster type and coordination type values (PRODUCTION, ZOOKEEPER / KRAFT) are from the OCI Streaming with Apache Kafka API: verify them against the region\'s offering.', { source: 'https://docs.oracle.com/en-us/iaas/Content/kafka/home.htm' }));
  return [
    ...preamble('oci', values),
    res('oci_managed_kafka_kafka_cluster_config', 'app', {
      compartment_id: x(comp),
      display_name: x(`"${pfx}-kafka"`),
      freeform_tags: tags,
    }, [blk('latest_config', { properties: x(hcl({ 'auto.create.topics.enable': 'false', 'default.replication.factor': '3', 'min.insync.replicas': '2', 'num.partitions': String(partitions) })) })]),
    res('oci_managed_kafka_kafka_cluster', 'app', {
      compartment_id: x(comp),
      display_name: x(`"${pfx}-kafka"`),
      kafka_version: valueOf(values, 'kafka_version', '3.7.0'),
      cluster_type: 'PRODUCTION',
      coordination_type: 'KRAFT',
      cluster_config_id: x('oci_managed_kafka_kafka_cluster_config.app.id'),
      cluster_config_version: 1,
      freeform_tags: tags,
    }, [
      blk('access_subnets', { subnets: x(`[${subnetOf(lz, net, 'app')}]`) }),
      blk('broker_shape', { node_count: Math.max(1, numberOf(values, 'brokers', 3)), ocpu_count: Math.max(1, numberOf(values, 'ocpus', 2)), storage_size_in_gbs: 500 }),
    ]),
    output('cluster_id', 'oci_managed_kafka_kafka_cluster.app.id', 'The bootstrap servers are on the cluster\'s details in the console or API.'),
  ];
}

// ---------------------------------------------------------------------------

const MSG_EMITS: Readonly<Record<MsgCloud, readonly string[]>> = {
  aws: ['aws_mq_broker'],
  azure: ['azurerm_servicebus_namespace', 'azurerm_private_endpoint', 'azurerm_servicebus_queue', 'azurerm_servicebus_topic'],
  oci: ['oci_queue_queue'],
};
const KAFKA_EMITS: Readonly<Record<MigCloud, readonly string[]>> = {
  aws: ['aws_cloudwatch_log_group', 'aws_msk_configuration', 'aws_msk_cluster'],
  azure: ['azurerm_eventhub_namespace', 'azurerm_private_endpoint', 'azurerm_eventhub'],
  google: ['google_managed_kafka_cluster', 'google_managed_kafka_topic'],
  oci: ['oci_managed_kafka_kafka_cluster_config', 'oci_managed_kafka_kafka_cluster'],
};
const MSG_SERVICE: Readonly<Record<MsgCloud, string>> = { aws: 'Amazon MQ', azure: 'Azure Service Bus', oci: 'OCI Queue' };
const KAFKA_SERVICE: Readonly<Record<MigCloud, string>> = { aws: 'Amazon MSK', azure: 'Azure Event Hubs (Kafka)', google: 'Managed Service for Apache Kafka', oci: 'OCI Streaming with Apache Kafka' };

function messaging(platform: MsgCloud): Blueprint {
  return {
    id: `${platform}_app_managed_messaging`,
    label: `App messaging on ${MSG_SERVICE[platform]}`,
    group: PATTERN_GROUP,
    description: {
      aws: 'An Amazon MQ broker (RabbitMQ or ActiveMQ) in the app tier, private, Multi-AZ for tier 0 and 1, encrypted with the landing zone key, logs on; its admin password is a sensitive variable.',
      azure: 'A Service Bus namespace (Premium with a private endpoint, or Standard), local auth off, TLS 1.2, and the queues (dead-lettering on) and topics.',
      oci: 'An OCI Queue per queue name, with dead-lettering after 10 deliveries.',
    }[platform],
    inputs: messagingInputs(platform),
    emits: MSG_EMITS[platform],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const blocks = platform === 'aws' ? awsMessaging(values, findings) : platform === 'azure' ? azureMessaging(values) : ociMessaging(values);
      return { files: { 'main.tf': patternMainTf(blocks, `${MSG_SERVICE[platform]}: ${appOf(values).name}`) }, findings };
    },
  };
}

function kafka(platform: MigCloud): Blueprint {
  return {
    id: `${platform}_app_managed_kafka`,
    label: `App Kafka on ${KAFKA_SERVICE[platform]}`,
    group: PATTERN_GROUP,
    description: {
      aws: 'An MSK cluster with a broker in each zone of the app tier (dual-stack connectivity on a dual-stack network), IAM and SCRAM authentication, TLS in transit, encryption with the landing zone key, per-topic monitoring and broker logs, and a configuration with safe replication defaults.',
      azure: 'An Event Hubs namespace (its Kafka endpoint) with a private endpoint and local auth off, and an event hub per topic.',
      google: 'A Managed Service for Apache Kafka cluster on the app tier\'s subnet, rebalancing on scale-up, and the topics with replication factor 3.',
      oci: 'An OCI Streaming with Apache Kafka cluster in the app tier with a configuration of safe replication defaults.',
    }[platform],
    inputs: kafkaInputs(platform),
    emits: KAFKA_EMITS[platform],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const blocks = platform === 'aws' ? awsKafka(values, findings) : platform === 'azure' ? azureKafka(values) : platform === 'google' ? googleKafka(values) : ociKafka(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `${KAFKA_SERVICE[platform]}: ${appOf(values).name}`) }, findings };
    },
  };
}

export const MESSAGING_BLUEPRINTS: readonly Blueprint[] = [
  ...(['aws', 'azure', 'oci'] as const).map(messaging),
  ...(['aws', 'azure', 'google', 'oci'] as const).map(kafka),
];
