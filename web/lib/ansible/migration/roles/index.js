/**
 * Every role the migration blueprints apply, by directory name.
 */

import { CLOUD_AGENTS, VMWARE_TOOLS_REMOVAL } from './agents.js';
import { LINUX_AD_JOIN, WINDOWS_AD_JOIN } from './ad_join.js';
import { MYSQL_SERVER, POSTGRES_SERVER } from './databases.js';
import { LINUX_BASELINE } from './linux_baseline.js';
import { MSSQL_AG, MSSQL_LINUX, MSSQL_WINDOWS } from './mssql.js';
import { ORACLE_DB } from './oracle_db.js';
                                       
import { VALIDATE } from './validate.js';
import { WINDOWS_BASELINE } from './windows_baseline.js';

export { roleFiles, flatTasks,                      } from './types.js';
export { LOCKDOWN_LINUX } from './linux_baseline.js';
export { LOCKDOWN_WINDOWS } from './windows_baseline.js';

export const MIGRATION_ROLES                                 = Object.fromEntries(
  [
    LINUX_BASELINE,
    WINDOWS_BASELINE,
    LINUX_AD_JOIN,
    WINDOWS_AD_JOIN,
    ORACLE_DB,
    MSSQL_WINDOWS,
    MSSQL_LINUX,
    MSSQL_AG,
    POSTGRES_SERVER,
    MYSQL_SERVER,
    CLOUD_AGENTS,
    VMWARE_TOOLS_REMOVAL,
    VALIDATE,
  ].map((r) => [r.name, r]),
);

export {
  CLOUD_AGENTS,
  LINUX_AD_JOIN,
  LINUX_BASELINE,
  MSSQL_AG,
  MSSQL_LINUX,
  MSSQL_WINDOWS,
  MYSQL_SERVER,
  ORACLE_DB,
  POSTGRES_SERVER,
  VALIDATE,
  VMWARE_TOOLS_REMOVAL,
  WINDOWS_AD_JOIN,
  WINDOWS_BASELINE,
};
