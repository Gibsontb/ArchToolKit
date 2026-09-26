/**
 * The "From a migration plan" Ansible blueprints (design 2.7.5), by the host
 * family they manage. The ones that manage both families are in both lists.
 */

                                                           
import { MIG_AD_DC_PROMOTE } from './ad-dc-promote.js';
import { MIG_CLOUD_AGENTS } from './cloud-agents.js';
import { MIG_LINUX_BASELINE } from './linux-baseline.js';
import { MIG_LINUX_DOMAIN_JOIN } from './linux-domain-join.js';
import { MIG_MONITORING } from './monitoring.js';
import { MIG_MSSQL_AG } from './mssql-ag.js';
import { MIG_MSSQL_LINUX } from './mssql-linux.js';
import { MIG_MSSQL_WINDOWS } from './mssql-windows.js';
import { MIG_MYSQL_SERVER } from './mysql-server.js';
import { MIG_ORACLE_DB } from './oracle-db.js';
import { MIG_POSTGRES_SERVER } from './postgres-server.js';
import { MIG_REACHABLE } from './reachable.js';
import { MIG_VALIDATE } from './validate.js';
import { MIG_VMWARE_TOOLS_REMOVAL } from './vmware-tools-removal.js';
import { MIG_WINDOWS_BASELINE } from './windows-baseline.js';
import { MIG_WINDOWS_DOMAIN_JOIN } from './windows-domain-join.js';

export { MIGRATION_GROUP } from './common.js';

/** Every migration blueprint once, in site order (design 2.7.4). */
export const MIGRATION_BLUEPRINTS                       = [
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
export const MIGRATION_LINUX                       = MIGRATION_BLUEPRINTS.filter((b) => !WINDOWS.has(b.id));
/** On the Generic Windows hosts platform. */
export const MIGRATION_WINDOWS                       = MIGRATION_BLUEPRINTS.filter((b) => WINDOWS.has(b.id) || BOTH.has(b.id));
