/**
 * Add a database (addendum A.9.2): one row of the platform's migration
 * databases blueprint (`<p>_mig_databases`, landing-zone variables), or a
 * new database in the plan and the app stack's diff when a stack manages the
 * app, or the engine's Ansible role on a server for a database on IaaS
 * (VCF, and an engine the platform has no managed service for).
 */

import { findAnsibleBlueprint } from '../../../ansible/blueprints/index.ts';
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.ts';
import { itemId } from '../../plan/options.ts';
import type { Database, DbEdition, DbEngine, DbVersionId } from '../../plan/types.ts';
import {
  ALL_PLATFORMS, NETWORK_INPUTS, PLATFORM_LABELS, ROUTE_INPUT, ansibleFromBlueprints, appInput, error, findDatabase, guestOs, info, landingZoneExample,
  managingAppOf, numVal, opt, platformInput, platformOf, routeOf, serverInput, stackChange, val,
  type ChangeUtility, type UtilityResult, type Finding, type PlanOp, type Platform,
} from './common.ts';

type Engine = 'postgres' | 'mysql' | 'sqlserver' | 'oracle';
/** [service, engine, edition, version, class, HA, licence] as the platform's databases grid writes them. */
type Row = readonly [string, string, string, string, string, string, string];
const MANAGED: Readonly<Record<Exclude<Platform, 'vmware'>, Partial<Record<Engine, Row>>>> = {
  aws: {
    postgres: ['aws-rds', 'postgres', 'community', '16', 'db.r7i.large', 'multi-az', 'li'],
    mysql: ['aws-rds', 'mysql', 'community', '8.0', 'db.r7i.large', 'multi-az', 'li'],
    sqlserver: ['aws-rds', 'sqlserver-se', 'sql-standard', '16.00', 'db.r7i.xlarge', 'multi-az', 'li'],
    oracle: ['aws-rds', 'oracle-ee', 'oracle-ee', '19', 'db.r7i.xlarge', 'multi-az', 'byol'],
  },
  azure: {
    postgres: ['azure-pg-flex', 'postgres', 'community', '16', 'GP_Standard_D4ds_v5', 'zone-redundant', 'li'],
    mysql: ['azure-mysql-flex', 'mysql', 'community', '8.0.21', 'GP_Standard_D2ds_v4', 'none', 'li'],
    sqlserver: ['azure-sqldb', 'sqlserver', 'sql-standard', '', 'GP_Gen5_4', 'zone-redundant', 'ahb'],
  },
  google: {
    postgres: ['google-cloudsql', 'POSTGRES_16', 'enterprise', '16', 'db-custom-4-15360', 'regional', 'li'],
    mysql: ['google-cloudsql', 'MYSQL_8_0', 'enterprise', '8.0', 'db-custom-2-7680', 'regional', 'li'],
    sqlserver: ['google-cloudsql', 'SQLSERVER_2022_STANDARD', 'enterprise', '2022', 'db-custom-4-15360', 'regional', 'li'],
  },
  oci: {
    postgres: ['oci-pg', 'postgres', '', '16', 'PostgreSQL.VM.Standard.E5.Flex:2:32', 'regional', 'li'],
    mysql: ['oci-mysql-heatwave', 'mysql', '', '', 'MySQL.4', 'regional', 'li'],
    oracle: ['oci-basedb', 'oracle', 'enterprise', '19', 'VM.Standard.E5.Flex:4', 'standby', 'byol'],
  },
};
const PLAN_ENGINE: Readonly<Record<Engine, { engine: DbEngine; edition: DbEdition; version: DbVersionId }>> = {
  postgres: { engine: 'postgres', edition: 'community', version: 'pg-16' },
  mysql: { engine: 'mysql', edition: 'community', version: 'mysql-8.0' },
  sqlserver: { engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2022' },
  oracle: { engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c' },
};

function iaasRole(engine: Engine, windows: boolean): string {
  switch (engine) {
    case 'postgres': return 'mig_postgres_server';
    case 'mysql': return 'mig_mysql_server';
    case 'oracle': return 'mig_oracle_db';
    default: return windows ? 'mig_mssql_windows' : 'mig_mssql_linux';
  }
}

export const addDatabase: ChangeUtility = {
  id: 'add-database',
  label: 'Add a database',
  category: 'data',
  description: 'A new database: a managed service row of the platform\'s databases blueprint (RDS, Azure Database / SQL Database, Cloud SQL, OCI Database with PostgreSQL / HeatWave / Base Database), the app stack\'s diff when a stack manages the app, or the engine\'s Ansible role on a server (IaaS, and VCF).',
  platforms: ALL_PLATFORMS,
  risk: 'low',
  reversible: true,
  rollback: 'Destroys the managed database (terraform destroy, or the app stack without it; a final snapshot where the service takes one) or, on IaaS, leaves the engine installed and names the uninstall step.',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    appInput('shop'),
    { id: 'name', label: 'Name', control: 'text', default: 'orders2' },
    { id: 'engine', label: 'Engine', control: 'select', default: 'postgres', options: [opt('postgres', 'PostgreSQL'), opt('mysql', 'MySQL'), opt('sqlserver', 'SQL Server'), opt('oracle', 'Oracle Database')] },
    { id: 'placement', label: 'Service', control: 'select', default: 'managed', options: [opt('managed', 'The platform\'s managed service'), opt('iaas', 'On a server (IaaS)')] },
    { id: 'class', label: 'Class', control: 'combo', default: '', options: [], hint: 'Blank: the service\'s general-purpose class.' },
    { id: 'storage_gib', label: 'Storage GiB', control: 'number', default: 100, min: 10 },
    { id: 'ha', label: 'High availability', control: 'select', default: 'yes', options: [opt('yes', 'Yes (the service\'s zone-redundant or standby option)'), opt('no', 'No')] },
    { id: 'backup_days', label: 'Backup retention days', control: 'number', default: 14, min: 1, max: 35 },
    { ...serverInput('Server (IaaS)', 'db01'), showWhen: { input: 'placement', equals: ['iaas'] } },
    ...NETWORK_INPUTS,
    ROUTE_INPUT,
  ],
  build(values, ctx): UtilityResult {
    let platform = platformOf(values, addDatabase);
    const findings: Finding[] = [];
    const name = val(values, 'name', 'orders2');
    const app = val(values, 'app', 'shop');
    const engine = (val(values, 'engine', 'postgres') as Engine);
    const gib = numVal(values, 'storage_gib', 100);
    if (findDatabase(ctx.plan, name)) findings.push(error('change.db.exists', `The plan already has a database named ${name}.`, { path: 'name' }));
    const managedRow = platform === 'vmware' ? undefined : MANAGED[platform][engine];
    let iaas = val(values, 'placement', 'managed') === 'iaas' || !managedRow;
    if (!iaas && !managedRow) iaas = true;
    if (val(values, 'placement', 'managed') === 'managed' && !managedRow) {
      findings.push(info('change.db.iaas', `${PLATFORM_LABELS[platform]} has no managed ${engine} service in the databases blueprint: it goes on a server (IaaS).`));
    }
    const pe = PLAN_ENGINE[engine];
    const db: Database = {
      id: itemId('database', name), name, engine: pe.engine, edition: pe.edition, version: pe.version, hosts: iaas ? [val(values, 'server', 'db01')] : [],
      vcpu: 2, ramGib: 8, sizeGib: gib, ha: 'none', dr: 'none', features: [], licence: engine === 'oracle' ? 'byol-sa' : engine === 'sqlserver' ? 'li' : 'community', app, source: 'manual',
    };
    const ops: PlanOp[] = [{ op: 'database-add', database: db }];
    const appId = managingAppOf(ctx.plan, app, platform);
    const route = routeOf(values, !!appId, findings);
    if (route === 'plan' && appId && ctx.plan) {
      const sc = stackChange(ctx.plan, ops, appId, platform, ctx);
      findings.push(...sc.findings);
      if (sc.changed) {
        return { platform, target: name, route: 'plan', summary: `Add the ${engine} database ${name} to ${app} through its app stack`, files: sc.files, findings, apply: sc.apply, rollback: sc.rollback, needs: [], planOps: ops };
      }
    }
    if (iaas) {
      const server = val(values, 'server', 'db01');
      const windows = guestOs(ctx.plan, server, values) === 'windows';
      const role = iaasRole(engine, windows);
      const files = ansibleFromBlueprints([{ blueprint: role, values: { backup_tier: 'silver' } }], [{ name: server, windows }], ctx.ansibleLookup ?? findAnsibleBlueprint, findings);
      platform = platformOf(values, addDatabase);
      return {
        platform, target: name, route: 'ansible', summary: `Install ${engine} for ${name} on ${server} (${app})`, files, findings,
        apply: [{ kind: 'ansible', title: `Install and configure ${engine} on ${server}`, playbook: 'site.yml' }],
        rollback: [{ kind: 'manual', title: 'Remove the engine', text: `stop and uninstall ${engine} on ${server} once its data is saved elsewhere (the role does not uninstall)` }],
        needs: [], planOps: ops,
      };
    }
    const r = managedRow!;
    const cls = val(values, 'class') || r[4];
    const ha = val(values, 'ha', 'yes') === 'yes' ? r[5] : 'none';
    const row = [name, r[0], r[1], r[2], r[3], cls, String(gib), ha, r[6], String(numVal(values, 'backup_days', 14)), val(values, 'network', 'prod'), app];
    const lookup = ctx.lookup ?? findTerraformBlueprint;
    const bp = lookup(`${platform}_mig_databases`);
    const files: Record<string, string> = {};
    if (!bp) findings.push(error('change.db.blueprint', `The databases blueprint for ${PLATFORM_LABELS[platform]} is not in the toolkit.`));
    else {
      const b = bp.build({ databases: row.join(' | '), landing_zone_source: 'variables' }, 'change');
      findings.push(...(b.findings ?? []));
      for (const [f, t] of Object.entries(b.files)) files[`terraform/${f}`] = t;
      files['terraform/landing_zone.auto.tfvars.json.example'] = landingZoneExample(platform === 'azure' ? 'azure' : platform as 'aws');
    }
    return {
      platform, target: name, route: 'terraform', summary: `Add the ${r[0]} ${engine} database ${name} (${cls}, ${gib} GiB) for ${app}`,
      files, findings,
      apply: [{ kind: 'terraform', title: `Create ${name}`, dir: 'terraform', lz: true }],
      rollback: [{ kind: 'terraform-destroy', title: `Destroy ${name}`, dir: 'terraform', lz: true }],
      needs: [], planOps: ops,
      notes: ['The admin password is created and kept by the service (or is a sensitive variable): see terraform/README.md.'],
    };
  },
};

export const DATABASE_UTILITIES: readonly ChangeUtility[] = [addDatabase];
