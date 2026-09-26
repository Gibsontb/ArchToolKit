/**
 * Databases beyond the core (addendum A.4.9): the catalogue rows for the
 * `ExtraDbServiceId` services (DocumentDB, ElastiCache, MemoryDB, Keyspaces,
 * OpenSearch Service; Azure DocumentDB, Azure Managed Redis, Managed Instance
 * for Apache Cassandra; Memorystore; OCI Cache, OCI Search with OpenSearch,
 * Autonomous Database with the MongoDB API).
 *
 * Owned by WP-16; `db-catalog.ts` spreads it into `DB_SERVICES`. A service
 * without a row here is simply not catalogued: it is never an option.
 *
 * `aws-rds-db2` is deliberately left out: the core `aws-rds` row already runs
 * the `db2` engine (BYOL), so a second row would offer Amazon RDS for Db2
 * twice. (WP-0 / WP-1: either drop the id or move `db2` off `aws-rds`.)
 *
 * The rows follow `DbServiceRow`. The Terraform types are checked against the
 * pinned provider catalog by `catalogs.test.ts` and `patterns.test.ts`.
 * Verification: 'C' where the row rests on the provider's product page read
 * for this work but its limits were not all re-read; IPv6 is `false` wherever
 * dual-stack was not confirmed (the conservative answer).
 */

                                                    
                                                   

const CLUSTER_HA = ['none', 'other-cluster']         ;

export const DB_SERVICES_EXTRA                                                            = Object.freeze({
  // ---- AWS ------------------------------------------------------------------
  'aws-docdb': {
    engines: ['mongodb'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    maxStorageGib: 131072,
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['aws_docdb_cluster', 'aws_docdb_cluster_instance', 'aws_docdb_subnet_group'],
    source: 'https://docs.aws.amazon.com/documentdb/latest/developerguide/limits.html ; https://docs.aws.amazon.com/documentdb/latest/developerguide/functional-differences.html',
    verification: 'C',
    notes: [
      'Amazon DocumentDB (with MongoDB compatibility) implements the MongoDB API, not the MongoDB server: check the functional differences before choosing it.',
      'Migrated with AWS DMS or mongosync-style tooling; mongomirror reached end of life on 2025-07-31.',
    ],
  },
  'aws-elasticache': {
    engines: ['redis'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: true,
    terraformTypes: ['aws_elasticache_replication_group', 'aws_elasticache_subnet_group'],
    source: 'https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/network-type.html',
    verification: 'C',
    notes: ['Valkey or Redis OSS engines; seeded from an RDB file in S3, or by online migration (replication) where the source allows.'],
  },
  'aws-memorydb': {
    engines: ['redis'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['aws_memorydb_cluster', 'aws_memorydb_subnet_group'],
    source: 'https://docs.aws.amazon.com/memorydb/latest/devguide/what-is-memorydb.html',
    verification: 'C',
    notes: ['Durable (Multi-AZ transaction log): for Redis / Valkey used as a primary store rather than a cache.'],
  },
  'aws-keyspaces': {
    engines: ['cassandra'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['aws_keyspaces_keyspace', 'aws_keyspaces_table'],
    source: 'https://docs.aws.amazon.com/keyspaces/latest/devguide/migrating-online.html',
    verification: 'C',
    notes: ['Serverless, CQL-compatible: online migration by dual writes (ZDM proxy) plus a bulk copy (dsbulk / CQLReplicator).'],
  },
  'aws-opensearch': {
    engines: ['elasticsearch'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: true,
    terraformTypes: ['aws_opensearch_domain'],
    source: 'https://docs.aws.amazon.com/opensearch-service/latest/developerguide/migration.html',
    verification: 'C',
    notes: ['Elasticsearch moves by snapshot and restore (version-compatibility check first) or reindex-from-remote.'],
  },

  // ---- Azure ----------------------------------------------------------------
  'azure-documentdb': {
    engines: ['mongodb'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['azurerm_mongo_cluster'],
    source: 'https://learn.microsoft.com/en-us/azure/documentdb/faq',
    verification: 'V-DOC',
    notes: ['Previously Azure Cosmos DB for MongoDB (vCore); now Azure DocumentDB (with MongoDB compatibility), built on the open-source DocumentDB project.'],
  },
  'azure-managed-redis': {
    engines: ['redis'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['azurerm_managed_redis'],
    source: 'https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/retirement-faq',
    verification: 'C',
    notes: ['Azure Cache for Redis retires (Enterprise tiers 2027-03-31, the other tiers 2028-09-30): Azure Managed Redis is the target.'],
  },
  'azure-cassandra-mi': {
    engines: ['cassandra'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['azurerm_cosmosdb_cassandra_cluster', 'azurerm_cosmosdb_cassandra_datacenter'],
    source: 'https://learn.microsoft.com/en-us/azure/managed-instance-apache-cassandra/introduction',
    verification: 'C',
    notes: ['A real Apache Cassandra ring: the on-premises ring can be joined (hybrid) and the old data centre decommissioned.'],
  },

  // ---- Google Cloud ---------------------------------------------------------
  'google-memorystore': {
    engines: ['redis'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['google_memorystore_instance'],
    source: 'https://docs.cloud.google.com/memorystore/docs/valkey',
    verification: 'C',
    notes: ['`google_memorystore_instance` is Memorystore for Valkey; Memorystore for Redis Cluster (`google_redis_cluster`) is the Redis-engine alternative.'],
  },

  // ---- OCI ------------------------------------------------------------------
  'oci-cache': {
    engines: ['redis'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['oci_redis_redis_cluster'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/ocicache/overview.htm',
    verification: 'V-DOC',
    notes: ['OCI Cache: managed Valkey and Redis (formerly "OCI Cache with Redis").'],
  },
  'oci-opensearch': {
    engines: ['elasticsearch'],
    managed: true,
    ha: CLUSTER_HA,
    unsupportedFeatures: [],
    licence: ['li'],
    ipv6: false,
    terraformTypes: ['oci_opensearch_opensearch_cluster'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/search-opensearch/home.htm',
    verification: 'C',
  },
  'oci-adb-mongo': {
    engines: ['mongodb'],
    managed: true,
    ha: ['none', 'data-guard-local'],
    unsupportedFeatures: [],
    licence: ['li', 'byol'],
    ipv6: false,
    terraformTypes: ['oci_database_autonomous_database'],
    source: 'https://docs.oracle.com/en/database/oracle/mongodb-api/',
    verification: 'C',
    notes: ['Oracle Database API for MongoDB on Autonomous Database: MongoDB drivers against Oracle; check the supported commands before choosing it.'],
  },
});
