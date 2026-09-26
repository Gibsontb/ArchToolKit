/**
 * `<p>_app_managed_cache`, `<p>_app_managed_search` and `<p>_app_nosql`
 * (tier patterns `managed-cache` and `managed-search`, and the §A.4.9
 * services): the managed Redis / Valkey, OpenSearch and document / wide-column
 * databases an app's data moves to. The data moves by the WP-17 database
 * paths (`redis-replicaof` / `redis-rdb-import`, `es-snapshot-restore`,
 * `mongo-mongosync`, `cassandra-zdm-proxy` / `cassandra-ring-join`).
 *
 * Cache
 *   AWS     ElastiCache (Valkey or Redis OSS): a replication group across the
 *           zones, dual-stack on a dual-stack network, TLS required, an AUTH
 *           token as a sensitive variable
 *   Azure   Azure Managed Redis (Azure Cache for Redis is retiring), private,
 *           Entra ID authentication, high availability
 *   Google  Memorystore for Valkey: shards across the zones, IAM auth, TLS,
 *           Private Service Connect endpoints on the network
 *   OCI     OCI Cache: a cluster in the data tier
 *
 * Search
 *   AWS     OpenSearch Service: a VPC domain across the zones, dualstack,
 *           fine-grained access control with an IAM master, TLS 1.2, encrypted
 *   OCI     Search with OpenSearch: a cluster in the data tier, its master
 *           user's password hash a sensitive variable
 *
 * NoSQL
 *   AWS     DocumentDB (MongoDB) with its password managed in Secrets Manager,
 *           or Amazon Keyspaces (Cassandra)
 *   Azure   Azure DocumentDB (MongoDB vCore, `azurerm_mongo_cluster`), or
 *           Azure Managed Instance for Apache Cassandra in a delegated subnet
 */

import { error, info, type Finding } from '../../../core/findings.ts';
import type { Blueprint, BlueprintInput, BlueprintValues } from '../../../kit/blueprint.ts';
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.ts';
import type { HclBlock } from '../../hcl.ts';
import { LANDING_ZONE_SOURCE, blk, e, jsonencode, lzRef, output, q, res, rname, secretVariable, variable, x, type MigCloud } from '../migration/common.ts';
import {
  NETWORK_INPUT,
  PATTERN_GROUP,
  appInputs,
  appOf,
  azureDelegatedSubnet,
  ipv6Of,
  isV4Cidr,
  namePrefix,
  patternMainTf,
  preamble,
  securityGroupOf,
  subnetOf,
  subnetsOf,
  tagsExpr,
} from './common.ts';

const ha = (crit: string): boolean => crit === 'tier0' || crit === 'tier1';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_SIZES: Readonly<Record<MigCloud, readonly string[]>> = {
  aws: ['cache.r7g.large', 'cache.r7g.xlarge', 'cache.r7g.2xlarge', 'cache.m7g.large', 'cache.t4g.medium'],
  azure: ['Balanced_B5', 'Balanced_B10', 'Balanced_B20', 'MemoryOptimized_M10', 'MemoryOptimized_M20', 'ComputeOptimized_X5'],
  google: ['SHARED_CORE_NANO', 'STANDARD_SMALL', 'HIGHMEM_MEDIUM', 'HIGHMEM_XLARGE'],
  oci: ['8', '16', '32', '64'],
};

function cacheInputs(platform: MigCloud): BlueprintInput[] {
  return [
    ...appInputs(),
    NETWORK_INPUT,
    { id: 'size', label: platform === 'oci' ? 'Memory per node (GB)' : platform === 'google' ? 'Node type' : 'Node size', control: 'combo', default: CACHE_SIZES[platform][0]!, options: CACHE_SIZES[platform].map((v) => ({ value: v, label: v })) },
    { id: 'shards', label: 'Shards', control: 'number', default: 1, min: 1, max: 250, hint: 'Cluster mode: more than one spreads the keys.' },
    ...(platform === 'aws'
      ? [{ id: 'engine', label: 'Engine', control: 'select' as const, default: 'valkey', options: [{ value: 'valkey', label: 'Valkey' }, { value: 'redis', label: 'Redis OSS' }] }]
      : []),
    LANDING_ZONE_SOURCE,
  ];
}

function awsCache(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const v6 = ipv6Of(lz, net);
  const tags = x(tagsExpr(app, 'aws'));
  const shards = Math.max(1, numberOf(values, 'shards', 1));
  const token = `${app.id}_cache_auth_token`;
  const engine = valueOf(values, 'engine', 'valkey') === 'redis' ? 'redis' : 'valkey';
  return [
    ...preamble('aws', values),
    secretVariable(token, `The AUTH token (16–128 characters) of ${app.name}'s cache.`),
    res('aws_elasticache_subnet_group', 'cache', { name: x(`"${pfx}-cache"`), subnet_ids: x(subnetsOf(lz, net, 'db')), tags }),
    res('aws_elasticache_replication_group', 'cache', {
      replication_group_id: x(`substr("${pfx}-cache", 0, 40)`),
      description: `${app.name} cache`,
      engine,
      engine_version: engine === 'valkey' ? '8.0' : '7.1',
      node_type: valueOf(values, 'size', 'cache.r7g.large'),
      num_node_groups: shards,
      replicas_per_node_group: ha(app.criticality) ? 2 : 1,
      automatic_failover_enabled: true,
      multi_az_enabled: true,
      cluster_mode: shards > 1 ? 'enabled' : 'disabled',
      subnet_group_name: x('aws_elasticache_subnet_group.cache.name'),
      security_group_ids: x(`[${securityGroupOf(lz, net, 'db')}]`),
      network_type: x(`${v6} ? "dual_stack" : "ipv4"`),
      ip_discovery: 'ipv4',
      at_rest_encryption_enabled: true,
      kms_key_id: x(`${lz}.kms_key_id`),
      transit_encryption_enabled: true,
      transit_encryption_mode: 'required',
      auth_token: x(`var.${token}`),
      snapshot_retention_limit: 7,
      auto_minor_version_upgrade: true,
      apply_immediately: false,
      tags,
    }),
    output('endpoint', shards > 1 ? 'aws_elasticache_replication_group.cache.configuration_endpoint_address' : 'aws_elasticache_replication_group.cache.primary_endpoint_address'),
  ];
}

function azureCache(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'azure'));
  const rg = `${lz}.resource_group[${q(net)}]`;
  return [
    ...preamble('azure', values),
    res('azurerm_managed_redis', 'cache', {
      name: x(`"${pfx}-cache"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      sku_name: valueOf(values, 'size', 'Balanced_B5'),
      high_availability_enabled: true,
      public_network_access: 'Disabled',
      tags,
    }, [
      blk('default_database', {
        access_keys_authentication_enabled: false,
        client_protocol: 'Encrypted',
        clustering_policy: numberOf(values, 'shards', 1) > 1 ? 'OSSCluster' : 'EnterpriseCluster',
        eviction_policy: 'VolatileLRU',
        persistence_redis_database_backup_frequency: ha(app.criticality) ? '1h' : '6h',
      }),
      blk('identity', { type: 'SystemAssigned' }),
    ]),
    res('azurerm_private_endpoint', 'cache', {
      name: x(`"${pfx}-cache-pe"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      subnet_id: x(subnetOf(lz, net, 'db')),
      tags,
    }, [blk('private_service_connection', { name: 'redis', private_connection_resource_id: x('azurerm_managed_redis.cache.id'), subresource_names: ['redisEnterprise'], is_manual_connection: false })]),
    output('hostname', 'azurerm_managed_redis.cache.hostname'),
  ];
}

function googleCache(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const shards = Math.max(1, numberOf(values, 'shards', 1));
  findings.push(info('tf.app.memorystore-psc', 'Memorystore endpoints are made by Private Service Connect: the network needs a service connection policy for the memorystore service class in the region (network team, once).', { source: 'https://cloud.google.com/memorystore/docs/valkey/networking' }));
  return [
    ...preamble('google', values),
    res('google_memorystore_instance', 'cache', {
      instance_id: x(`"${pfx}-cache"`),
      project: x(`${lz}.project`),
      location: x(`${lz}.region`),
      shard_count: shards,
      replica_count: ha(app.criticality) ? 2 : 1,
      node_type: valueOf(values, 'size', 'SHARED_CORE_NANO'),
      mode: shards > 1 ? 'CLUSTER' : 'CLUSTER_DISABLED',
      engine_version: 'VALKEY_8_0',
      authorization_mode: 'IAM_AUTH',
      transit_encryption_mode: 'SERVER_AUTHENTICATION',
      deletion_protection_enabled: ha(app.criticality),
      labels: x(tagsExpr(app, 'google')),
    }, [
      blk('desired_auto_created_endpoints', { network: x(`${lz}.network_ids[${q(net)}]`), project_id: x(`${lz}.project`) }),
      blk('zone_distribution_config', { mode: 'MULTI_ZONE' }),
      blk('persistence_config', { mode: 'RDB' }, [blk('rdb_config', { rdb_snapshot_period: 'ONE_HOUR' })]),
    ]),
    output('endpoints', 'google_memorystore_instance.cache.endpoints'),
  ];
}

function ociCache(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  return [
    ...preamble('oci', values),
    res('oci_redis_redis_cluster', 'cache', {
      compartment_id: x(`${lz}.compartment_id`),
      display_name: x(`"${pfx}-cache"`),
      node_count: ha(app.criticality) ? 3 : 2,
      node_memory_in_gbs: Number(valueOf(values, 'size', '8')) || 8,
      software_version: 'VALKEY_7_2',
      subnet_id: x(subnetOf(lz, net, 'db')),
      nsg_ids: x(`[${securityGroupOf(lz, net, 'db')}]`),
      freeform_tags: x(tagsExpr(app, 'oci')),
    }),
    output('primary_endpoint', 'oci_redis_redis_cluster.cache.primary_fqdn'),
  ];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

type SearchCloud = 'aws' | 'oci';

function searchInputs(platform: SearchCloud): BlueprintInput[] {
  return [
    ...appInputs(),
    NETWORK_INPUT,
    { id: 'version', label: 'Version', control: 'text', default: platform === 'aws' ? 'OpenSearch_2.19' : '2.15.0' },
    { id: 'data_nodes', label: 'Data nodes', control: 'number', default: 3, min: 1 },
    { id: 'storage_gib', label: 'Storage per node (GiB)', control: 'number', default: 500, min: 10 },
    ...(platform === 'aws'
      ? [
          { id: 'instance_type', label: 'Data node type', control: 'combo' as const, default: 'r7g.large.search', options: ['r7g.large.search', 'r7g.xlarge.search', 'm7g.large.search', 'or2.large.search'].map((v) => ({ value: v, label: v })) },
          { id: 'master_user_arn', label: 'Master user (IAM ARN)', control: 'text' as const, default: '', hint: 'The IAM role that administers the domain; blank: a variable.' },
        ]
      : [
          { id: 'ocpus', label: 'OCPUs per data node', control: 'number' as const, default: 2, min: 1 },
          { id: 'memory_gb', label: 'Memory per data node (GB)', control: 'number' as const, default: 32, min: 8 },
        ]),
    LANDING_ZONE_SOURCE,
  ];
}

function awsSearch(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'aws'));
  const nodes = Math.max(1, numberOf(values, 'data_nodes', 3));
  const master = valueOf(values, 'master_user_arn');
  const blocks: HclBlock[] = [...preamble('aws', values)];
  if (!master) blocks.push(variable(`${app.id}_search_master_arn`, 'string', 'The IAM role ARN that administers the OpenSearch domain (fine-grained access control).'));
  const zones = Math.min(3, nodes);
  blocks.push(
    res('aws_opensearch_domain', 'search', {
      domain_name: x(`substr("${pfx}-search", 0, 28)`),
      engine_version: valueOf(values, 'version', 'OpenSearch_2.19'),
      ip_address_type: x(`${ipv6Of(lz, net)} ? "dualstack" : "ipv4"`),
      access_policies: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: '*' }, Action: 'es:ESHttp*', Resource: e(`"arn:aws:es:\${${lz}.region}:\${data.aws_caller_identity.search.account_id}:domain/\${substr("${pfx}-search", 0, 28)}/*"`) }] })),
      tags,
    }, [
      blk('cluster_config', {
        instance_type: valueOf(values, 'instance_type', 'r7g.large.search'),
        instance_count: nodes,
        zone_awareness_enabled: zones > 1,
        dedicated_master_enabled: nodes >= 3,
        dedicated_master_type: nodes >= 3 ? 'm7g.large.search' : undefined,
        dedicated_master_count: nodes >= 3 ? 3 : undefined,
      }, zones > 1 ? [blk('zone_awareness_config', { availability_zone_count: zones })] : []),
      blk('ebs_options', { ebs_enabled: true, volume_type: 'gp3', volume_size: numberOf(values, 'storage_gib', 500) }),
      blk('vpc_options', { subnet_ids: x(`slice(${subnetsOf(lz, net, 'db')}, 0, ${zones})`), security_group_ids: x(`[${securityGroupOf(lz, net, 'db')}]`) }),
      blk('encrypt_at_rest', { enabled: true, kms_key_id: x(`${lz}.kms_key_id`) }),
      blk('node_to_node_encryption', { enabled: true }),
      blk('domain_endpoint_options', { enforce_https: true, tls_security_policy: 'Policy-Min-TLS-1-2-PFS-2023-10' }),
      blk('advanced_security_options', { enabled: true, anonymous_auth_enabled: false, internal_user_database_enabled: false }, [blk('master_user_options', { master_user_arn: x(master ? q(master) : `var.${app.id}_search_master_arn`) })]),
      blk('software_update_options', { auto_software_update_enabled: true }),
    ]),
    { type: 'data', labels: ['aws_caller_identity', 'search'], attributes: [], blocks: [] },
    output('endpoint', 'aws_opensearch_domain.search.endpoint'),
  );
  return blocks;
}

function ociSearch(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const comp = `${lz}.compartment_id`;
  const hash = `${app.id}_search_master_password_hash`;
  return [
    ...preamble('oci', values),
    secretVariable(hash, `The PBKDF2 hash of ${app.name}'s OpenSearch master user password (the OCI API takes the hash, not the password).`),
    res('oci_opensearch_opensearch_cluster', 'search', {
      compartment_id: x(comp),
      display_name: x(`"${pfx}-search"`),
      software_version: valueOf(values, 'version', '2.15.0'),
      data_node_count: Math.max(1, numberOf(values, 'data_nodes', 3)),
      data_node_host_type: 'FLEX',
      data_node_host_ocpu_count: Math.max(1, numberOf(values, 'ocpus', 2)),
      data_node_host_memory_gb: Math.max(8, numberOf(values, 'memory_gb', 32)),
      data_node_storage_gb: numberOf(values, 'storage_gib', 500),
      master_node_count: 3,
      master_node_host_type: 'FLEX',
      master_node_host_ocpu_count: 1,
      master_node_host_memory_gb: 16,
      opendashboard_node_count: 1,
      opendashboard_node_host_ocpu_count: 1,
      opendashboard_node_host_memory_gb: 8,
      subnet_id: x(subnetOf(lz, net, 'db')),
      subnet_compartment_id: x(comp),
      vcn_id: x(`${lz}.network_ids[${q(net)}]`),
      vcn_compartment_id: x(comp),
      nsg_id: x(securityGroupOf(lz, net, 'db')),
      security_mode: 'ENFORCING',
      security_master_user_name: 'atkadmin',
      security_master_user_password_hash: x(`var.${hash}`),
      freeform_tags: x(tagsExpr(app, 'oci')),
    }),
    output('endpoint', 'oci_opensearch_opensearch_cluster.search.opensearch_fqdn'),
  ];
}

// ---------------------------------------------------------------------------
// NoSQL
// ---------------------------------------------------------------------------

type NosqlCloud = 'aws' | 'azure';

function nosqlInputs(platform: NosqlCloud): BlueprintInput[] {
  return [
    ...appInputs(),
    NETWORK_INPUT,
    { id: 'engine', label: 'Engine', control: 'select', default: 'mongodb', options: [{ value: 'mongodb', label: platform === 'aws' ? 'MongoDB (Amazon DocumentDB)' : 'MongoDB (Azure DocumentDB)' }, { value: 'cassandra', label: platform === 'aws' ? 'Cassandra (Amazon Keyspaces)' : 'Cassandra (Managed Instance)' }] },
    { id: 'keyspaces', label: 'Keyspaces / databases', control: 'text', default: 'shop', hint: 'Space-separated (Keyspaces creates each; the others are created by the migration).' },
    ...(platform === 'aws'
      ? [{ id: 'instance_class', label: 'DocumentDB instance class', control: 'combo' as const, default: 'db.r7g.large', options: ['db.r7g.large', 'db.r7g.xlarge', 'db.r6g.large', 'db.t4g.medium'].map((v) => ({ value: v, label: v })) }]
      : [
          { id: 'tier', label: 'DocumentDB compute tier', control: 'select' as const, default: 'M30', options: ['M10', 'M20', 'M30', 'M40', 'M50', 'M60', 'M80'].map((v) => ({ value: v, label: v })) },
          { id: 'storage_gib', label: 'Storage (GiB)', control: 'number' as const, default: 128, min: 32 },
          { id: 'cassandra_subnet_cidr', label: 'Cassandra MI subnet', control: 'text' as const, default: '10.40.255.0/24', hint: 'Cassandra only: a free range of the network, delegated to the Managed Instance.' },
        ]),
    LANDING_ZONE_SOURCE,
  ];
}

function awsNosql(values: BlueprintValues): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'aws'));
  const blocks: HclBlock[] = [...preamble('aws', values)];
  if (valueOf(values, 'engine', 'mongodb') === 'cassandra') {
    for (const k of valueOf(values, 'keyspaces', 'shop').split(/[\s,]+/).filter(Boolean)) {
      blocks.push(res('aws_keyspaces_keyspace', rname(k).replace(/-/g, '_'), { name: rname(k).replace(/-/g, '_'), tags }));
    }
    blocks.push(output('endpoint', `"cassandra.\${${lz}.region}.amazonaws.com:9142"`, 'Keyspaces is reached on its regional TLS endpoint (a VPC interface endpoint for private access).'));
    return blocks;
  }
  blocks.push(
    res('aws_docdb_subnet_group', 'nosql', { name: x(`"${pfx}-docdb"`), subnet_ids: x(subnetsOf(lz, net, 'db')), tags }),
    res('aws_docdb_cluster', 'nosql', {
      cluster_identifier: x(`"${pfx}-docdb"`),
      engine: 'docdb',
      engine_version: '5.0.0',
      master_username: 'atkadmin',
      manage_master_user_password: true,
      db_subnet_group_name: x('aws_docdb_subnet_group.nosql.name'),
      vpc_security_group_ids: x(`[${securityGroupOf(lz, net, 'db')}]`),
      storage_encrypted: true,
      kms_key_id: x(`${lz}.kms_key_id`),
      backup_retention_period: 7,
      deletion_protection: true,
      skip_final_snapshot: false,
      final_snapshot_identifier: x(`"${pfx}-docdb-final"`),
      enabled_cloudwatch_logs_exports: ['audit', 'profiler'],
      tags,
    }),
    res('aws_docdb_cluster_instance', 'nosql', {
      count: ha(app.criticality) ? 3 : 2,
      identifier: x(`"${pfx}-docdb-\${count.index + 1}"`),
      cluster_identifier: x('aws_docdb_cluster.nosql.id'),
      instance_class: valueOf(values, 'instance_class', 'db.r7g.large'),
      auto_minor_version_upgrade: true,
      tags,
    }),
    output('endpoint', 'aws_docdb_cluster.nosql.endpoint'),
    output('master_secret', 'aws_docdb_cluster.nosql.master_user_secret[0].secret_arn', 'The Secrets Manager secret holding the master password.'),
  );
  return blocks;
}

function azureNosql(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'azure'));
  const rg = `${lz}.resource_group[${q(net)}]`;
  const blocks: HclBlock[] = [...preamble('azure', values)];
  const pw = `${app.id}_nosql_admin_password`;
  blocks.push(secretVariable(pw, `The administrator password of ${app.name}'s database cluster.`));
  if (valueOf(values, 'engine', 'mongodb') === 'cassandra') {
    const cidr = valueOf(values, 'cassandra_subnet_cidr', '10.40.255.0/24');
    if (!isV4Cidr(cidr)) findings.push(error('tf.app.cassandra-subnet', `"${cidr}" is not an IPv4 range for the Managed Instance subnet.`, { path: 'cassandra_subnet_cidr' }));
    blocks.push(
      azureDelegatedSubnet('cassandra', lz, net, `"${pfx}-cassandra"`, cidr, 'Microsoft.DocumentDB/cassandraClusters', ['Microsoft.Network/virtualNetworks/subnets/join/action']),
      res('azurerm_cosmosdb_cassandra_cluster', 'nosql', {
        name: x(`"${pfx}-cassandra"`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        delegated_management_subnet_id: x('azurerm_subnet.cassandra.id'),
        default_admin_password: x(`var.${pw}`),
        version: '4.0',
        tags,
      }, [blk('identity', { type: 'SystemAssigned' })]),
      res('azurerm_cosmosdb_cassandra_datacenter', 'nosql', {
        name: 'dc1',
        location: x(`${lz}.location`),
        cassandra_cluster_id: x('azurerm_cosmosdb_cassandra_cluster.nosql.id'),
        delegated_management_subnet_id: x('azurerm_subnet.cassandra.id'),
        node_count: ha(app.criticality) ? 6 : 3,
        sku_name: 'Standard_E8s_v5',
        disk_count: 4,
        availability_zones_enabled: true,
      }),
      output('cluster_id', 'azurerm_cosmosdb_cassandra_cluster.nosql.id', 'The ring the source datacenter joins (cassandra-ring-join).'),
    );
    findings.push(info('tf.app.cassandra-mi-role', 'Cassandra Managed Instance needs the Azure Cosmos DB service principal as Network Contributor on the virtual network (a one-time tenant step).', { source: 'https://learn.microsoft.com/en-us/azure/managed-instance-apache-cassandra/create-cluster-cli' }));
    return blocks;
  }
  blocks.push(
    res('azurerm_mongo_cluster', 'nosql', {
      name: x(`"${pfx}-docdb"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      administrator_username: 'atkadmin',
      administrator_password: x(`var.${pw}`),
      compute_tier: valueOf(values, 'tier', 'M30'),
      storage_size_in_gb: numberOf(values, 'storage_gib', 128),
      shard_count: 1,
      high_availability_mode: ha(app.criticality) ? 'ZoneRedundantPreferred' : 'Disabled',
      public_network_access: 'Disabled',
      version: '8.0',
      tags,
    }),
    res('azurerm_private_endpoint', 'nosql', {
      name: x(`"${pfx}-docdb-pe"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      subnet_id: x(subnetOf(lz, net, 'db')),
      tags,
    }, [blk('private_service_connection', { name: 'mongo', private_connection_resource_id: x('azurerm_mongo_cluster.nosql.id'), subresource_names: ['MongoCluster'], is_manual_connection: false })]),
    output('connection_strings', 'azurerm_mongo_cluster.nosql.connection_strings', 'Connection strings (without the password).', true),
  );
  return blocks;
}

// ---------------------------------------------------------------------------

const CACHE_EMITS: Readonly<Record<MigCloud, readonly string[]>> = {
  aws: ['aws_elasticache_subnet_group', 'aws_elasticache_replication_group'],
  azure: ['azurerm_managed_redis', 'azurerm_private_endpoint'],
  google: ['google_memorystore_instance'],
  oci: ['oci_redis_redis_cluster'],
};
const CACHE_SERVICE: Readonly<Record<MigCloud, string>> = { aws: 'Amazon ElastiCache', azure: 'Azure Managed Redis', google: 'Memorystore for Valkey', oci: 'OCI Cache' };

function cache(platform: MigCloud): Blueprint {
  return {
    id: `${platform}_app_managed_cache`,
    label: `App cache on ${CACHE_SERVICE[platform]}`,
    group: PATTERN_GROUP,
    description: {
      aws: 'An ElastiCache replication group (Valkey or Redis OSS) across the zones of the db tier: Multi-AZ with automatic failover, dual-stack on a dual-stack network, encrypted at rest and in transit (TLS required), an AUTH token from a sensitive variable.',
      azure: 'An Azure Managed Redis instance, highly available, access keys off (Entra ID authentication), TLS only, public access off with a private endpoint in the db tier, and RDB persistence.',
      google: 'A Memorystore for Valkey instance across the zones: IAM authentication, TLS, RDB persistence, and Private Service Connect endpoints on the network.',
      oci: 'An OCI Cache (Valkey) cluster in the db tier and its NSG.',
    }[platform],
    inputs: cacheInputs(platform),
    emits: CACHE_EMITS[platform],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const blocks = platform === 'aws' ? awsCache(values) : platform === 'azure' ? azureCache(values) : platform === 'google' ? googleCache(values, findings) : ociCache(values);
      return { files: { 'main.tf': patternMainTf(blocks, `${CACHE_SERVICE[platform]}: ${appOf(values).name}`) }, findings };
    },
  };
}

function search(platform: SearchCloud): Blueprint {
  const service = platform === 'aws' ? 'Amazon OpenSearch Service' : 'OCI Search with OpenSearch';
  return {
    id: `${platform}_app_managed_search`,
    label: `App search on ${service}`,
    group: PATTERN_GROUP,
    description: platform === 'aws'
      ? 'An OpenSearch Service domain in the db tier (VPC, dualstack on a dual-stack network), zone-aware with dedicated masters, encrypted, HTTPS with TLS 1.2, fine-grained access control with an IAM master role.'
      : 'An OCI Search with OpenSearch cluster in the db tier (data, master and Dashboards nodes), security enforced, the master user\'s password hash from a sensitive variable.',
    inputs: searchInputs(platform),
    emits: platform === 'aws' ? ['aws_opensearch_domain'] : ['oci_opensearch_opensearch_cluster'],
    build: (values: BlueprintValues) => {
      const blocks = platform === 'aws' ? awsSearch(values) : ociSearch(values);
      return { files: { 'main.tf': patternMainTf(blocks, `${service}: ${appOf(values).name}`) }, findings: [] };
    },
  };
}

function nosql(platform: NosqlCloud): Blueprint {
  return {
    id: `${platform}_app_nosql`,
    label: 'App NoSQL database (MongoDB / Cassandra)',
    group: PATTERN_GROUP,
    description: platform === 'aws'
      ? 'Amazon DocumentDB (MongoDB compatibility) in the db tier with its master password managed in Secrets Manager, encrypted, deletion-protected; or Amazon Keyspaces keyspaces for Cassandra.'
      : 'Azure DocumentDB (MongoDB vCore) with a private endpoint and zone-redundant high availability for tier 0 and 1; or Azure Managed Instance for Apache Cassandra in a delegated subnet. The admin password is a sensitive variable.',
    inputs: nosqlInputs(platform),
    emits: platform === 'aws' ? ['aws_keyspaces_keyspace', 'aws_docdb_subnet_group', 'aws_docdb_cluster', 'aws_docdb_cluster_instance'] : ['azurerm_subnet', 'azurerm_cosmosdb_cassandra_cluster', 'azurerm_cosmosdb_cassandra_datacenter', 'azurerm_mongo_cluster', 'azurerm_private_endpoint'],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const blocks = platform === 'aws' ? awsNosql(values) : azureNosql(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `NoSQL: ${appOf(values).name}`) }, findings };
    },
  };
}

export const DATA_SERVICE_BLUEPRINTS: readonly Blueprint[] = [
  ...(['aws', 'azure', 'google', 'oci'] as const).map(cache),
  ...(['aws', 'oci'] as const).map(search),
  ...(['aws', 'azure'] as const).map(nosql),
];
