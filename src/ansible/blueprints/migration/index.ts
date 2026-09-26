/**
 * The "From a migration plan" Ansible blueprints (design 2.7.5), by the host
 * family they manage. The ones that manage both families are in both lists.
 */

import type { Blueprint } from '../../../kit/blueprint.ts';
import { MIG_AD_DC_PROMOTE } from './ad-dc-promote.ts';
import { MIG_CLOUD_AGENTS } from './cloud-agents.ts';
import { MIG_LINUX_BASELINE } from './linux-baseline.ts';
import { MIG_LINUX_DOMAIN_JOIN } from './linux-domain-join.ts';
import { MIG_MONITORING } from './monitoring.ts';
import { MIG_MSSQL_AG } from './mssql-ag.ts';
import { MIG_MSSQL_LINUX } from './mssql-linux.ts';
import { MIG_MSSQL_WINDOWS } from './mssql-windows.ts';
import { MIG_MYSQL_SERVER } from './mysql-server.ts';
import { MIG_ORACLE_DB } from './oracle-db.ts';
import { MIG_POSTGRES_SERVER } from './postgres-server.ts';
import { MIG_REACHABLE } from './reachable.ts';
import { MIG_VALIDATE } from './validate.ts';
import { MIG_VMWARE_TOOLS_REMOVAL } from './vmware-tools-removal.ts';
import { MIG_WINDOWS_BASELINE } from './windows-baseline.ts';
import { MIG_WINDOWS_DOMAIN_JOIN } from './windows-domain-join.ts';

export { MIGRATION_GROUP } from './common.ts';

/** Every migration blueprint once, in site order (design 2.7.4). */
export const MIGRATION_BLUEPRINTS: readonly Blueprint[] = [
  MIG_REACHABLE,
  MIG_LINUX_BASELINE,
  MIG_WINDOWS_BASELINE,
  MIG_VMWARE_TOOLS_REMOVAL,
  MIG_CLOUD_AGENTS,
  MIG_AD_DC_PROMOTE,
  MIG_WINDOWS_DOMAIN_JOIN,
  MIG_LINUX_DOMAIN_JOIN,
  MIG_ORACLE_DB,
  MIG_MSSQL_WINDOWS,
  MIG_MSSQL_LINUX,
  MIG_MSSQL_AG,
  MIG_POSTGRES_SERVER,
  MIG_MYSQL_SERVER,
  MIG_MONITORING,
  MIG_VALIDATE,
];

const BOTH = new Set(['mig_reachable', 'mig_vmware_tools_removal', 'mig_cloud_agents', 'mig_monitoring', 'mig_validate']);
const WINDOWS = new Set(['mig_windows_baseline', 'mig_ad_dc_promote', 'mig_windows_domain_join', 'mig_mssql_windows', 'mig_mssql_ag']);

/** On the Generic Linux hosts platform. */
export const MIGRATION_LINUX: readonly Blueprint[] = MIGRATION_BLUEPRINTS.filter((b) => !WINDOWS.has(b.id));
/** On the Generic Windows hosts platform. */
export const MIGRATION_WINDOWS: readonly Blueprint[] = MIGRATION_BLUEPRINTS.filter((b) => WINDOWS.has(b.id) || BOTH.has(b.id));
