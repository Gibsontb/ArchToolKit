/**
 * Databases beyond the core (addendum A.4.9): the catalogue rows for the
 * `ExtraDbServiceId` services (Amazon RDS for Db2, DocumentDB, ElastiCache,
 * MemoryDB, Keyspaces, OpenSearch Service; Azure DocumentDB, Azure Managed
 * Redis, Managed Instance for Apache Cassandra; Memorystore; OCI Cache, OCI
 * Search with OpenSearch, Autonomous Database with the MongoDB API).
 *
 * Owned by WP-16, which fills it; `db-catalog.ts` spreads it into
 * `DB_SERVICES`. A service without a row here is simply not catalogued yet:
 * it is never an option, and `servicesFor` never returns it.
 *
 * Each row follows `DbServiceRow` (the same shape as the core rows): engines,
 * editions, managed, HA forms, unsupported features, limits, licence models,
 * IPv6, the Terraform types (checked against the pinned provider catalog by
 * `catalogs.test.ts`), the source URL and its verification.
 */

import type { DbServiceRow } from './db-catalog.ts';
import type { ExtraDbServiceId } from './types.ts';

export const DB_SERVICES_EXTRA: Readonly<Partial<Record<ExtraDbServiceId, DbServiceRow>>> = Object.freeze({});
