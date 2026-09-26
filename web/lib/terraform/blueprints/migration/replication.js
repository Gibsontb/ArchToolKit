/**
 * Replication blueprints for a migration plan (addendum A.6.5, A.6.7, A.6.8,
 * WP-11c): the Terraform side of the execution kit's cloud paths, one per
 * cloud, stack item "Replication".
 *
 *   aws_mig_replication     AWS Transform MGN's supporting pieces (there is no
 *                           aws_mgn_* resource: the service is driven by the
 *                           CLI) and AWS DMS: the roles DMS requires by name,
 *                           the subnet group, a Secrets Manager container per
 *                           endpoint (the value is put by the kit's script from
 *                           the vault) and the endpoints reading it.
 *   google_mig_replication  the Migrate to Virtual Machines and Database
 *                           Migration Service APIs, and the DMS connection
 *                           profiles and continuous migration jobs (created,
 *                           not started: the kit starts them at its replicate
 *                           step). There is no google_vm_migration_*.
 *   oci_mig_replication     Oracle Cloud Migrations in full: Cloud Bridge
 *                           environment, inventory, vCenter asset source and
 *                           schedules, one migration per wave, the migration
 *                           assets (from the discovered inventory OCIDs the kit
 *                           writes), a test and a cutover plan per wave with
 *                           their target assets; and OCI Database Migration
 *                           connections and migrations.
 *
 * Azure has none: azurerm has no Azure Migrate resource, and the DMS
 * resources it has model DMS classic, whose SQL Server scenarios are retired.
 *
 * Each writes an output the kit's scripts read (`mgn`, `dms`, `m2vm`, `ocm`),
 * carrying the landing-zone ids they need, so the scripts depend on this item
 * only. See ./common.ts for the landing-zone contract and the grid formats.
 */

import { info, warning,              } from '../../../core/findings.js';
                                                                                            
import { str as valueOf } from '../../../kit/blueprint.js';
                                             
import {
  DB_PORTS,
  LANDING_ZONE_SOURCE,
  MIGRATION_GROUP,
  PLAN_ID_INPUT,
  YES_NO,
  blk,
  consumerPreamble,
  dat,
  dbColumns,
  e,
  gridInput,
  hcl,
  jsonencode,
  lzRef,
  mainTf,
  output,
  parseDbs,
  parseGrid,
  parseVms,
  q,
  res,
  rname,
  secretVariable,
  terraformBlock,
  uniqueNames,
  variable,
  vmColumns,
  words,
  x,
              
                  
              
} from './common.js';
import { parseShape } from './oci.js';

// ---------------------------------------------------------------------------
// Shared inputs
// ---------------------------------------------------------------------------

const NETWORK_INPUT                 = {
  id: 'network', label: 'Network', control: 'text', default: 'prod',
  hint: 'The landing-zone network replication and DMS run in (its mgmt and db subnets).',
};

const DMS_DATABASES_INPUT                 = {
  id: 'dms_databases',
  label: 'Databases moved by the database migration service',
  control: 'text',
  default: 'auto',
  hint: 'auto: the rows whose default path is the cloud\'s DMS; or database names, space-separated; none: no DMS.',
};

export const SOURCE_COLUMNS                        = [
  { name: 'Database' },
  { name: 'Host' },
  { name: 'Port' },
  { name: 'Database name' },
  { name: 'User' },
];
const SOURCES_INPUT = ()                 =>
  gridInput('sources', 'Source databases', SOURCE_COLUMNS, [], 'Where each database moved by DMS is today: its host (name or address), port, database (service name for Oracle) and the migration user. A database with no row gets variables for them. Passwords are never here: they are sensitive variables.');

                                                                                                                           

function parseSources(values                 , findings           )                          {
  const rows = uniqueNames(parseGrid(valueOf(values, 'sources'), SOURCE_COLUMNS.map((c) => c.name)), 'Database', 'sources', findings);
  const out = new Map                    ();
  for (const r of rows) {
    const port = Number(r['Port']);
    out.set(rname(r['Database'] ?? ''), {
      ...(r['Host'] ? { host: r['Host'] } : {}),
      ...(Number.isFinite(port) && port > 0 ? { port } : {}),
      ...(r['Database name'] ? { database: r['Database name'] } : {}),
      ...(r['User'] ? { user: r['User'] } : {}),
    });
  }
  return out;
}

/** The rows DMS moves: `auto` by the rule given, a list of names, or none. */
function dmsRows(values                 , dbs                   , auto                         , findings           )           {
  const choice = valueOf(values, 'dms_databases', 'auto').trim();
  if (choice === '' || choice === 'none') return [];
  if (choice === 'auto') return dbs.filter(auto);
  const names = new Set(words(choice).map((n) => rname(n)));
  for (const n of names) {
    if (!dbs.some((d) => d.name === n)) findings.push(warning('tf.mig.dms-unknown-db', `${n} is named for DMS but is not in the databases grid.`, { path: 'dms_databases' }));
  }
  return dbs.filter((d) => names.has(d.name));
}

const replicated = (vms                   )           => vms.filter((v) => v.method === 'replicate');

const failed = (id        , findings                    ) => ({
  files: { 'main.tf': `# ${id}: nothing was generated; see the findings.\n` },
  findings,
});

const DEFAULT_PORT                                   = { oracle: 1521, sqlserver: 1433, postgres: 5432, mysql: 3306, mariadb: 3306 };

// ---------------------------------------------------------------------------
// AWS: MGN supporting pieces and DMS
// ---------------------------------------------------------------------------

const AWS_DEFAULT_VMS                                 = [
  ['db01', 'ol-8', 'replicated', 'r7i.2xlarge', '4', 'gp3:100 io2:500', 'prod', 'db', 'a', 'byol-image', 'gold', 'replicate', 'shop', 'oracle', 'prod', '2'],
  ['app02', 'rhel-9', 'replicated', 'm7i.xlarge', '', 'gp3:50 gp3:200', 'prod', 'app', 'b', 'li', 'silver', 'replicate', 'shop', 'app', 'prod', '1'],
];
const AWS_DEFAULT_DBS                                 = [
  ['orders', 'aws-rds', 'postgres', 'community', '16', 'db.r7i.large', '200', 'multi-az', 'li', '14', 'prod', 'shop'],
  ['erp', 'aws-rds', 'oracle-ee', 'oracle-ee', '19', 'db.r7i.xlarge', '500', 'multi-az', 'byol', '14', 'prod', 'erp'],
  ['ledger', 'aws-aurora', 'aurora-postgresql', 'community', '16', 'db.r7i.large', '100', 'multi-az', 'li', '7', 'prod', 'finance'],
];
const AWS_DB_SERVICES = ['aws-rds', 'aws-aurora', 'aws-rds-custom'];
const RDS_ENGINES = ['postgres', 'mysql', 'mariadb', 'oracle-ee', 'oracle-se2', 'sqlserver-ee', 'sqlserver-se', 'sqlserver-web', 'sqlserver-ex', 'aurora-postgresql', 'aurora-mysql'];

/** The DMS endpoint engine names for an RDS engine (https://docs.aws.amazon.com/dms/latest/APIReference/API_CreateEndpoint.html). */
export function dmsEngines(rdsEngine        )                                                            {
  const e0 = rdsEngine.toLowerCase();
  if (e0.startsWith('oracle')) return { source: 'oracle', target: 'oracle', family: 'oracle' };
  if (e0.startsWith('sqlserver')) return { source: 'sqlserver', target: 'sqlserver', family: 'sqlserver' };
  if (e0 === 'aurora-postgresql') return { source: 'postgres', target: 'aurora-postgresql', family: 'postgres' };
  if (e0 === 'postgres') return { source: 'postgres', target: 'postgres', family: 'postgres' };
  if (e0 === 'aurora-mysql') return { source: 'mysql', target: 'aurora', family: 'mysql' };
  if (e0 === 'mysql') return { source: 'mysql', target: 'mysql', family: 'mysql' };
  if (e0 === 'mariadb') return { source: 'mariadb', target: 'mariadb', family: 'mariadb' };
  return null;
}

/** AWS DMS by default (the kit's A.6.1 table): Oracle and PostgreSQL to RDS or Aurora. */
const awsDmsAuto = (d        )          => AWS_DB_SERVICES.includes(d.service) && ['oracle', 'postgres'].includes(dmsEngines(d.engine)?.family ?? '');

const trust = (principal                         ) =>
  x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: principal, Action: 'sts:AssumeRole' }] }));

function awsReplication()            {
  return {
    id: 'aws_mig_replication',
    label: 'Replication (migration)',
    group: MIGRATION_GROUP,
    description: 'AWS Transform MGN\'s supporting pieces (the agent-install role and the replication security group; MGN itself is driven by the execution kit, as the provider has no MGN resource) and AWS DMS: the roles it requires, the subnet group, a secret container per endpoint and the endpoints reading them.',
    inputs: [
      NETWORK_INPUT,
      gridInput('vms', 'VMs', vmColumns([], ['gp3', 'io2']), AWS_DEFAULT_VMS, 'The compute grid; rows with Method replicate move by AWS Transform MGN, and make the MGN pieces.'),
      gridInput('databases', 'Databases', dbColumns(AWS_DB_SERVICES, RDS_ENGINES, [], ['li', 'byol']), AWS_DEFAULT_DBS, 'The databases grid; DMS endpoints are made for the rows DMS moves.'),
      DMS_DATABASES_INPUT,
      { id: 'dms_account_roles', label: 'Create dms-vpc-role and dms-cloudwatch-logs-role', control: 'select', default: 'yes', options: YES_NO, hint: 'DMS requires these names, once per account: say no when the account has them.' },
      PLAN_ID_INPUT,
      LANDING_ZONE_SOURCE,
    ],
    emits: [
      'aws_iam_role', 'aws_iam_role_policy', 'aws_iam_role_policy_attachment', 'aws_security_group', 'aws_vpc_security_group_ingress_rule',
      'aws_vpc_security_group_egress_rule', 'aws_dms_replication_subnet_group', 'aws_secretsmanager_secret', 'aws_dms_endpoint',
    ],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const net = rname(valueOf(values, 'network', 'prod'));
      const vms = replicated(parseVms(valueOf(values, 'vms'), 'gp3', [], valueOf(values, 'plan_id')));
      const dbs = dmsRows(values, parseDbs(valueOf(values, 'databases'), findings), awsDmsAuto, findings);
      if (findings.some((f) => f.severity === 'error')) return failed('aws_mig_replication', findings);
      const prefix = '${' + lz + '.prefix}';
      const plan = valueOf(values, 'plan_id').trim();
      const tags = (name        ) => x(hcl({ Name: e(`"${prefix}-${name}"`), atk_plan: plan, atk_role: 'replication' }));
      const partition = 'data.aws_partition.current.partition';
      const blocks             = [
        terraformBlock(['aws']),
        ...consumerPreamble('aws', values),
        dat('aws_partition', 'current', {}),
        dat('aws_caller_identity', 'current', {}),
      ];
      const vpc = `${lz}.network_ids[${q(net)}]`;
      const sub = (tier        ) => `[for k, v in ${lz}.subnet_ids : v if startswith(k, ${q(`${net}/${tier}/`)})]`;

      if (vms.length) {
        blocks.push(
          res('aws_iam_role', 'mgn_agent_install', {
            name: x(`"${prefix}-mgn-agent-install"`),
            description: 'Assumed by the migration controller to mint 1-hour credentials for the AWS Transform MGN agent installer.',
            max_session_duration: 3600,
            assume_role_policy: trust({ AWS: e('"arn:${' + partition + '}:iam::${data.aws_caller_identity.current.account_id}:root"') }),
            tags: tags('mgn-agent-install'),
          }),
          res('aws_iam_role_policy_attachment', 'mgn_agent_install', {
            role: x('aws_iam_role.mgn_agent_install.name'),
            policy_arn: x('"arn:${' + partition + '}:iam::aws:policy/AWSApplicationMigrationAgentInstallationPolicy"'),
          }),
          res('aws_security_group', 'mgn_replication', {
            name: x(`"${prefix}-mgn-replication"`),
            description: 'AWS Transform MGN replication servers: TCP 1500 from the source sites, TCP 443 out',
            vpc_id: x(vpc),
            tags: tags('mgn-replication'),
          }),
          res('aws_vpc_security_group_ingress_rule', 'mgn_replication', {
            for_each: x(`toset(${lz}.mgmt_cidrs)`),
            security_group_id: x('aws_security_group.mgn_replication.id'),
            cidr_ipv4: x('strcontains(each.value, ":") ? null : each.value'),
            cidr_ipv6: x('strcontains(each.value, ":") ? each.value : null'),
            ip_protocol: 'tcp',
            from_port: 1500,
            to_port: 1500,
            description: x('"Replication from ${each.value}"'),
          }),
          res('aws_vpc_security_group_egress_rule', 'mgn_replication_https', {
            security_group_id: x('aws_security_group.mgn_replication.id'), cidr_ipv4: '0.0.0.0/0', ip_protocol: 'tcp', from_port: 443, to_port: 443, description: 'HTTPS to the MGN and S3 endpoints',
          }),
          res('aws_vpc_security_group_egress_rule', 'mgn_replication_https_v6', {
            security_group_id: x('aws_security_group.mgn_replication.id'), cidr_ipv6: '::/0', ip_protocol: 'tcp', from_port: 443, to_port: 443, description: 'HTTPS to the MGN and S3 endpoints, IPv6',
          }),
          output('mgn', `{
    agent_role_arn     = aws_iam_role.mgn_agent_install.arn
    security_group_id  = aws_security_group.mgn_replication.id
    staging_subnet_id  = try(${lz}.subnet_ids[${q(`${net}/mgmt/a`)}], ${lz}.subnet_ids[${q(`${net}/app/a`)}])
    kms_key_arn        = ${lz}.kms_key_id
    subnet_ids         = ${lz}.subnet_ids
    security_group_ids = ${lz}.security_group_ids
    network_ids        = ${lz}.network_ids
    instance_profile   = ${lz}.instance_profile
  }`, 'What mgn.sh reads: the replication template\'s ids, the agent-install role, and the landing-zone ids the launch templates name.'),
        );
      }

      if (dbs.length) {
        const accountRoles = valueOf(values, 'dms_account_roles', 'yes') !== 'no';
        const endpoints                                         = {};
        for (const d of dbs) {
          const eng = dmsEngines(d.engine);
          if (!eng) {
            findings.push(warning('tf.mig.dms-engine', `${d.name}: AWS DMS has no endpoint engine for ${d.engine}; it is left out.`, { path: 'databases' }));
            continue;
          }
          const ssl = eng.family === 'oracle' ? 'none' : 'require';
          const name = d.name;
          endpoints[`${d.name}-source`] = { db: d.name, role: 'source', engine: eng.source, database: name, ssl };
          endpoints[`${d.name}-target`] = { db: d.name, role: 'target', engine: eng.target, database: name, ssl };
          if (eng.family === 'oracle') findings.push(info('tf.mig.dms-oracle-ssl', `${d.name}: the Oracle endpoints are written with ssl_mode none (Oracle TLS needs a certificate in DMS); use Oracle native network encryption on the source.`, { path: 'databases' }));
        }
        blocks.push({
          type: 'locals',
          comment: 'The DMS endpoints: one secret container and one endpoint each. The secret\'s value\n(username, password, host, port) is put by the kit from the vault, never here.',
          attributes: [{ name: 'mig_replication_dms', value: x(hcl(endpoints)) }],
        });
        if (accountRoles) {
          blocks.push(
            res('aws_iam_role', 'dms_vpc', { name: 'dms-vpc-role', description: 'DMS requires this name.', assume_role_policy: trust({ Service: 'dms.amazonaws.com' }) }),
            res('aws_iam_role_policy_attachment', 'dms_vpc', { role: x('aws_iam_role.dms_vpc.name'), policy_arn: x('"arn:${' + partition + '}:iam::aws:policy/service-role/AmazonDMSVPCManagementRole"') }),
            res('aws_iam_role', 'dms_cloudwatch_logs', { name: 'dms-cloudwatch-logs-role', description: 'DMS requires this name.', assume_role_policy: trust({ Service: 'dms.amazonaws.com' }) }),
            res('aws_iam_role_policy_attachment', 'dms_cloudwatch_logs', { role: x('aws_iam_role.dms_cloudwatch_logs.name'), policy_arn: x('"arn:${' + partition + '}:iam::aws:policy/service-role/AmazonDMSCloudWatchLogsRole"') }),
          );
          findings.push(info('tf.mig.dms-account-roles', 'dms-vpc-role and dms-cloudwatch-logs-role are account-wide names DMS requires; when the account already has them, set "Create dms-vpc-role …" to no.', { path: 'dms_account_roles', source: 'https://docs.aws.amazon.com/dms/latest/userguide/security-iam.html#CHAP_Security.APIRole' }));
        }
        blocks.push(
          res('aws_dms_replication_subnet_group', 'dms', {
            replication_subnet_group_id: x(`"${prefix}-dms"`),
            replication_subnet_group_description: 'AWS DMS Serverless replications of the migration',
            subnet_ids: x(`coalescelist(${sub('db')}, ${sub('mgmt')}, ${sub('app')})`),
            tags: tags('dms'),
            depends_on: accountRoles ? x('[aws_iam_role_policy_attachment.dms_vpc]') : undefined,
          }),
          res('aws_security_group', 'dms', { name: x(`"${prefix}-dms"`), description: 'AWS DMS replications: out to the sources and the targets', vpc_id: x(vpc), tags: tags('dms') }),
          res('aws_vpc_security_group_egress_rule', 'dms', { security_group_id: x('aws_security_group.dms.id'), cidr_ipv4: '0.0.0.0/0', ip_protocol: '-1', description: 'All outbound' }),
          res('aws_vpc_security_group_egress_rule', 'dms_v6', { security_group_id: x('aws_security_group.dms.id'), cidr_ipv6: '::/0', ip_protocol: '-1', description: 'All outbound, IPv6' }),
          res('aws_vpc_security_group_ingress_rule', 'dms_to_db', {
            for_each: x(`contains(keys(${lz}.security_group_ids), ${q(`${net}/db`)}) ? toset(${hcl(DB_PORTS.map(String))}) : toset([])`),
            security_group_id: x(`${lz}.security_group_ids[${q(`${net}/db`)}]`),
            referenced_security_group_id: x('aws_security_group.dms.id'),
            ip_protocol: 'tcp',
            from_port: x('tonumber(each.value)'),
            to_port: x('tonumber(each.value)'),
            description: x('"DMS to the database tier, TCP ${each.value}"'),
          }),
          res('aws_secretsmanager_secret', 'dms', {
            for_each: x('local.mig_replication_dms'),
            name: x(`"${prefix}/dms/\${each.key}"`),
            description: x('"DMS ${each.value.role} endpoint of ${each.value.db}: username, password, host and port, put by the migration kit"'),
            kms_key_id: x(`${lz}.kms_key_id`),
            recovery_window_in_days: 7,
            tags: tags('dms'),
          }),
          res('aws_iam_role', 'dms_secrets', {
            name: x(`"${prefix}-dms-secrets"`),
            description: 'Lets DMS read the endpoint secrets.',
            assume_role_policy: trust({ Service: e(`"dms.\${${lz}.region}.amazonaws.com"`) }),
            tags: tags('dms-secrets'),
          }),
          res('aws_iam_role_policy', 'dms_secrets', {
            name: 'read-endpoint-secrets',
            role: x('aws_iam_role.dms_secrets.id'),
            policy: x(jsonencode({
              Version: '2012-10-17',
              Statement: [
                { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], Resource: e('[for s in aws_secretsmanager_secret.dms : s.arn]') },
                { Effect: 'Allow', Action: ['kms:Decrypt'], Resource: e(`${lz}.kms_key_id == null ? ["*"] : [${lz}.kms_key_id]`), Condition: { StringEquals: { 'kms:ViaService': e(`"secretsmanager.\${${lz}.region}.amazonaws.com"`) } } },
              ],
            })),
          }),
          res('aws_dms_endpoint', 'dms', {
            for_each: x('local.mig_replication_dms'),
            endpoint_id: x(`"${prefix}-\${each.key}"`),
            endpoint_type: x('each.value.role'),
            engine_name: x('each.value.engine'),
            database_name: x('each.value.database'),
            ssl_mode: x('each.value.ssl'),
            secrets_manager_arn: x('aws_secretsmanager_secret.dms[each.key].arn'),
            secrets_manager_access_role_arn: x('aws_iam_role.dms_secrets.arn'),
            kms_key_arn: x(`${lz}.kms_key_id`),
            tags: tags('dms'),
            depends_on: x('[aws_iam_role_policy.dms_secrets]'),
          }),
          output('dms', `{
    subnet_group_id         = aws_dms_replication_subnet_group.dms.replication_subnet_group_id
    security_group_id       = aws_security_group.dms.id
    secrets_access_role_arn = aws_iam_role.dms_secrets.arn
    endpoints               = { for k, v in aws_dms_endpoint.dms : k => v.endpoint_arn }
    secrets                 = { for k, v in aws_secretsmanager_secret.dms : k => v.arn }
  }`, 'What the DMS scripts read: the endpoints, their secrets, the subnet group and security group.'),
        );
      }
      if (!vms.length && !dbs.length) {
        findings.push(info('tf.mig.replication-empty', 'No VM replicates and no database moves by DMS, so there is nothing to build for replication.', { path: 'vms' }));
      }
      return { files: { 'main.tf': mainTf(blocks, `AWS replication: AWS Transform MGN for ${vms.length} VM(s), AWS DMS for ${dbs.length} database(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Google Cloud (GCP): Migrate to Virtual Machines APIs, Database Migration Service
// ---------------------------------------------------------------------------

const GOOGLE_DEFAULT_VMS                                 = [
  ['db01', 'ol-8', 'replicated', 'n2-highmem-8', '4', 'pd-balanced:100 pd-ssd:500', 'prod', 'db', 'a', 'byol-image', 'gold', 'replicate', 'shop', 'oracle', 'prod', '2'],
];
const GOOGLE_DEFAULT_DBS                                 = [
  ['orders', 'google-cloudsql', 'POSTGRES_16', 'enterprise', '16', 'db-custom-4-15360', '200', 'regional', 'li', '14', 'prod', 'shop'],
  ['catalog', 'google-cloudsql', 'MYSQL_8_0', 'enterprise', '8.0', 'db-custom-2-7680', '100', 'none', 'li', '7', 'prod', 'shop'],
  ['ledger', 'google-alloydb', 'POSTGRES_16', '', '16', 'db-custom-4-32768', '100', 'regional', 'li', '14', 'prod', 'finance'],
];
const GOOGLE_DB_SERVICES = ['google-cloudsql', 'google-alloydb'];
const GOOGLE_ENGINES = ['POSTGRES_16', 'POSTGRES_15', 'MYSQL_8_0', 'MYSQL_8_4', 'SQLSERVER_2022_STANDARD'];

const googleEngine = (engine        )                                               =>
  /^postgres/i.test(engine) ? 'postgres' : /^mysql/i.test(engine) ? 'mysql' : /^sqlserver/i.test(engine) ? 'sqlserver' : 'other';

/** Database Migration Service by default: PostgreSQL and MySQL to Cloud SQL, PostgreSQL to AlloyDB (and SQL Server, which is not in Terraform). */
const googleDmsAuto = (d        )          => GOOGLE_DB_SERVICES.includes(d.service) && googleEngine(d.engine) !== 'other';

function googleReplication()            {
  return {
    id: 'google_mig_replication',
    label: 'Replication (migration)',
    group: MIGRATION_GROUP,
    description: 'The Migrate to Virtual Machines API (the migration itself is driven by the execution kit over its REST API: the provider has no resource for it), and Database Migration Service: source and destination connection profiles and a continuous migration job per database, created and left for the kit to start.',
    inputs: [
      NETWORK_INPUT,
      gridInput('vms', 'VMs', vmColumns([], ['pd-balanced', 'pd-ssd']), GOOGLE_DEFAULT_VMS, 'The compute grid; rows with Method replicate move by Migrate to Virtual Machines, and enable its API.'),
      gridInput('databases', 'Databases', dbColumns(GOOGLE_DB_SERVICES, GOOGLE_ENGINES, [], ['li']), GOOGLE_DEFAULT_DBS, 'The databases grid; DMS is set up for the rows it moves.'),
      DMS_DATABASES_INPUT,
      SOURCES_INPUT(),
      { id: 'dms_peering_range', label: 'DMS private connection range', control: 'text', default: '', hint: 'A free /29 for a DMS private connection (VPC peering) to the sources, e.g. 10.40.255.0/29; blank: none.' },
      PLAN_ID_INPUT,
      LANDING_ZONE_SOURCE,
    ],
    emits: ['google_project_service', 'google_database_migration_service_connection_profile', 'google_database_migration_service_private_connection', 'google_database_migration_service_migration_job'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const net = rname(valueOf(values, 'network', 'prod'));
      const vms = replicated(parseVms(valueOf(values, 'vms'), 'pd-balanced', [], valueOf(values, 'plan_id')));
      const all = dmsRows(values, parseDbs(valueOf(values, 'databases'), findings), googleDmsAuto, findings);
      const sources = parseSources(values, findings);
      if (findings.some((f) => f.severity === 'error')) return failed('google_mig_replication', findings);
      const sqlserver = all.filter((d) => googleEngine(d.engine) === 'sqlserver');
      if (sqlserver.length) {
        findings.push(info('tf.mig.gcp-dms-sqlserver', `${sqlserver.map((d) => d.name).join(', ')}: SQL Server to Cloud SQL has no Terraform connection profile in the google provider (8.4); the kit's gcp-dms script creates it with gcloud, from backup files in Cloud Storage.`, { path: 'databases' }));
      }
      const other = all.filter((d) => googleEngine(d.engine) === 'other' || !GOOGLE_DB_SERVICES.includes(d.service));
      if (other.length) findings.push(warning('tf.mig.gcp-dms-engine', `${other.map((d) => d.name).join(', ')}: Database Migration Service here covers PostgreSQL and MySQL to Cloud SQL or AlloyDB; left out.`, { path: 'databases' }));
      const dbs = all.filter((d) => ['postgres', 'mysql'].includes(googleEngine(d.engine)) && GOOGLE_DB_SERVICES.includes(d.service));
      const prefix = '${' + lz + '.prefix}';
      const plan = valueOf(values, 'plan_id').trim();
      const labels = x(hcl({ atk_plan: plan, atk_role: 'replication' }));
      const range = valueOf(values, 'dms_peering_range').trim();
      const blocks             = [terraformBlock(['google']), ...consumerPreamble('google', values)];
      if (vms.length) {
        blocks.push(res('google_project_service', 'vmmigration', { project: x(`${lz}.project`), service: 'vmmigration.googleapis.com', disable_on_destroy: false }));
      }
      blocks.push(output('m2vm', `{
    project         = ${lz}.project
    region          = ${lz}.region
    network_ids     = ${lz}.network_ids
    network_names   = ${lz}.network_names
    subnet_ids      = ${lz}.subnet_ids
    service_account = ${lz}.service_account
  }`, 'What m2vm.sh and image-import.sh read: the project, the networks and subnets the targets name, the VMs\' service account.'));
      if (dbs.length) {
        blocks.push(res('google_project_service', 'datamigration', { project: x(`${lz}.project`), service: 'datamigration.googleapis.com', disable_on_destroy: false }));
        if (range) {
          blocks.push(res('google_database_migration_service_private_connection', 'dms', {
            location: x(`${lz}.region`),
            private_connection_id: x(`"${prefix}-dms"`),
            display_name: x(`"${prefix}-dms"`),
            labels,
            depends_on: x('[google_project_service.datamigration]'),
          }, [blk('vpc_peering_config', { vpc_name: x(`${lz}.network_ids[${q(net)}]`), subnet: range })]));
        }
        for (const d of dbs) {
          const kind = googleEngine(d.engine)                        ;
          const src = sources.get(d.name) ?? {};
          const pw = `dms_${d.id}_source_password`;
          const hostVar = `dms_${d.id}_source_host`;
          blocks.push(secretVariable(pw, `The password of the migration user on the source of ${d.name}.`));
          if (!src.host) blocks.push(variable(hostVar, 'string', `The source host of ${d.name} (a name or an address the DMS network reaches).`));
          const conn = {
            host: src.host ?? x(`var.${hostVar}`),
            port: src.port ?? DEFAULT_PORT[kind],
            username: src.user ?? 'atk_migration',
            password: x(`var.${pw}`),
          };
          const alloy = d.service === 'google-alloydb';
          blocks.push(
            res('google_database_migration_service_connection_profile', `${d.id}_source`, {
              location: x(`${lz}.region`),
              connection_profile_id: x(`"${prefix}-${d.name}-source"`),
              display_name: x(`"${prefix}-${d.name}-source"`),
              labels,
              depends_on: x('[google_project_service.datamigration]'),
            }, [blk(kind === 'postgres' ? 'postgresql' : 'mysql', conn, kind === 'postgres' && range ? [blk('private_connectivity', { private_connection: x('google_database_migration_service_private_connection.dms.name') })] : [])]),
            res('google_database_migration_service_connection_profile', `${d.id}_destination`, {
              location: x(`${lz}.region`),
              connection_profile_id: x(`"${prefix}-${d.name}-destination"`),
              display_name: x(`"${prefix}-${d.name}-destination"`),
              labels,
              depends_on: x('[google_project_service.datamigration]'),
            }, [blk(kind === 'postgres' ? 'postgresql' : 'mysql', alloy ? { alloydb_cluster_id: x(`"${prefix}-${d.name}"`) } : { cloud_sql_id: x(`"${prefix}-${d.name}"`) })]),
            res('google_database_migration_service_migration_job', d.id, {
              location: x(`${lz}.region`),
              migration_job_id: x(`"${prefix}-${d.name}"`),
              display_name: x(`"${prefix}-${d.name}"`),
              type: 'CONTINUOUS',
              source: x(`google_database_migration_service_connection_profile.${d.id}_source.name`),
              destination: x(`google_database_migration_service_connection_profile.${d.id}_destination.name`),
              labels,
            }, [blk('vpc_peering_connectivity', { vpc: x(`${lz}.network_ids[${q(net)}]`) })]),
          );
        }
        blocks.push(output('dms', `{
    jobs = {
${dbs.map((d) => `      ${q(d.name)} = google_database_migration_service_migration_job.${d.id}.name`).join('\n')}
    }
  }`, 'What gcp-dms.sh reads: the migration job of each database.'));
        findings.push(info('tf.mig.gcp-dms-not-started', 'The DMS migration jobs are created, not started: the kit verifies and starts each one at its replicate step, so nothing waits here in a stopped state.', { path: 'databases' }));
      }
      if (!vms.length && !dbs.length) findings.push(info('tf.mig.replication-empty', 'No VM replicates and no database moves by DMS: only the output is written.', { path: 'vms' }));
      return { files: { 'main.tf': mainTf(blocks, `Google Cloud (GCP) replication: Migrate to Virtual Machines for ${vms.length} VM(s), Database Migration Service for ${dbs.length} database(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// OCI: Oracle Cloud Migrations and OCI Database Migration
// ---------------------------------------------------------------------------

const OCI_DEFAULT_VMS                                 = [
  ['app03', 'ol-9', 'replicated', 'VM.Standard.E5.Flex:2:32', '', 'balanced:100', 'prod', 'app', 'a', 'li', 'silver', 'replicate', 'shop', 'app', 'prod', '1'],
  ['db01', 'ol-8', 'replicated', 'VM.Standard.E5.Flex:4:64', '4', 'balanced:100 higher:500', 'prod', 'db', 'a', 'byol-image', 'gold', 'replicate', 'shop', 'oracle', 'prod', '2'],
];
const OCI_DEFAULT_DBS                                 = [
  ['web', 'oci-mysql-heatwave', 'mysql', '', '', 'MySQL.4', '100', 'regional', 'li', '7', 'prod', 'shop'],
  ['crm', 'oci-adb', 'oracle', '', '26ai', '4', '1024', 'none', 'li', '30', 'prod', 'crm'],
];
const OCI_DB_SERVICES = ['oci-adb', 'oci-mysql-heatwave'];

/** OCI Database Migration by default: MySQL to HeatWave (Oracle to Autonomous defaults to ZDM logical; name it to use DMS). */
const ociDmsAuto = (d        )          => d.service === 'oci-mysql-heatwave' && d.engine === 'mysql';

function ociReplication()            {
  return {
    id: 'oci_mig_replication',
    label: 'Replication (migration)',
    group: MIGRATION_GROUP,
    description: 'Oracle Cloud Migrations: the Cloud Bridge environment, inventory, vCenter asset source and schedules, one migration per wave, the migration assets from the discovered inventory, and a test and a cutover plan per wave with their target assets; OCI Database Migration connections and migrations.',
    inputs: [
      NETWORK_INPUT,
      gridInput('vms', 'VMs', vmColumns([], ['balanced', 'higher']), OCI_DEFAULT_VMS, 'The compute grid; rows with Method replicate move by Oracle Cloud Migrations (vSphere and AWS EC2 sources).'),
      gridInput('databases', 'Databases', dbColumns(OCI_DB_SERVICES, ['oracle', 'mysql'], [], ['li', 'byol']), OCI_DEFAULT_DBS, 'The databases grid; OCI Database Migration is set up for the rows it moves.'),
      DMS_DATABASES_INPUT,
      SOURCES_INPUT(),
      { id: 'environment', label: 'Cloud Bridge environment', control: 'text', default: 'atk-ocm', hint: 'The environment the discovery and replication agents register with.' },
      { id: 'snapshot_bucket', label: 'Snapshot bucket', control: 'text', default: 'ocm-snapshots', hint: 'The Object Storage bucket replication snapshots go to (the prefix is added).' },
      { id: 'schedule', label: 'Replication schedule', control: 'text', default: 'FREQ=DAILY;BYHOUR=1', hint: 'RFC 5545 recurrence of the replication after the first cycle.' },
      { id: 'test_network', label: 'Test network', control: 'text', default: 'nonprod', hint: 'The landing-zone network the test plans launch into.' },
      { id: 'vcenter', label: 'vCenter', control: 'text', default: '', hint: 'The vCenter the Cloud Bridge asset source discovers (FQDN); blank: no vSphere asset source.' },
      { id: 'inventory_id', label: 'Existing Cloud Bridge inventory OCID', control: 'text', default: '', hint: 'A tenancy has one inventory: give its OCID when it exists; blank creates it (in the tenancy root).' },
      PLAN_ID_INPUT,
      LANDING_ZONE_SOURCE,
    ],
    emits: [
      'oci_objectstorage_bucket', 'oci_cloud_bridge_environment', 'oci_cloud_bridge_inventory', 'oci_cloud_bridge_asset_source', 'oci_cloud_bridge_discovery_schedule',
      'oci_cloud_migrations_replication_schedule', 'oci_cloud_migrations_migration', 'oci_cloud_migrations_migration_asset',
      'oci_cloud_migrations_migration_plan', 'oci_cloud_migrations_target_asset', 'oci_database_migration_connection', 'oci_database_migration_migration',
    ],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const net = rname(valueOf(values, 'network', 'prod'));
      const vms = replicated(parseVms(valueOf(values, 'vms'), 'balanced', [], valueOf(values, 'plan_id')));
      const dbs = dmsRows(values, parseDbs(valueOf(values, 'databases'), findings), ociDmsAuto, findings);
      const sources = parseSources(values, findings);
      if (findings.some((f) => f.severity === 'error')) return failed('oci_mig_replication', findings);
      const prefix = '${' + lz + '.prefix}';
      const comp = x(`${lz}.compartment_id`);
      const plan = valueOf(values, 'plan_id').trim();
      const tags = x(hcl({ atk_plan: plan, atk_role: 'replication' }));
      const vcenter = valueOf(values, 'vcenter').trim();
      const inventory = valueOf(values, 'inventory_id').trim();
      const blocks             = [terraformBlock(['oci']), ...consumerPreamble('oci', values)];
      const subnet = (network        , tier        , zone        ) => `${lz}.subnet_ids[${q(`${network}/${tier}/${zone}`)}]`;

      if (vms.length) {
        const waves = [...new Set(vms.map((v) => v.wave || '0'))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
        const testNet = rname(valueOf(values, 'test_network', 'nonprod'));
        const ocmVms                                          = {};
        for (const v of vms) {
          const s = parseShape(v.size, v.cores);
          ocmVms[v.name] = {
            wave: v.wave || '0', shape: s.shape, ocpus: s.ocpus, memory: s.memory, ad: v.zoneIndex,
            subnet: e(subnet(v.network, v.tier, v.zone)),
            test_subnet: e(`try(${subnet(testNet, v.tier, v.zone)}, ${subnet(v.network, v.tier, v.zone)})`),
            ms_license: v.kind === 'windows' ? (v.licence === 'li' ? 'LICENSE_INCLUDED' : 'BRING_YOUR_OWN_LICENSE') : null,
          };
        }
        const plans                                          = {};
        for (const w of waves) {
          for (const phase of ['test', 'cutover']) plans[`${w}/${phase}`] = { wave: w, phase, network: phase === 'test' ? testNet : net };
        }
        blocks.push(
          {
            type: 'locals',
            comment: 'The VMs Oracle Cloud Migrations moves, and the plans: a test and a cutover plan per wave.',
            attributes: [
              { name: 'mig_replication_ocm_vms', value: x(hcl(ocmVms)) },
              { name: 'mig_replication_ocm_plans', value: x(hcl(plans)) },
              { name: 'mig_replication_ocm_assets', value: x('{ for k, v in var.ocm_inventory_asset_ids : k => v if contains(keys(local.mig_replication_ocm_vms), k) }') },
            ],
          },
          variable('ocm_inventory_asset_ids', 'map(string)', 'The discovered Cloud Bridge inventory asset of each VM (name to OCID), written by the migration kit to ocm-assets.auto.tfvars.json. Empty makes no migration asset.', { default: '{}' }),
          dat('oci_objectstorage_namespace', 'ocm', { compartment_id: comp }),
          res('oci_objectstorage_bucket', 'ocm_snapshots', {
            compartment_id: comp,
            namespace: x('data.oci_objectstorage_namespace.ocm.namespace'),
            name: x(`"${prefix}-${rname(valueOf(values, 'snapshot_bucket', 'ocm-snapshots'))}"`),
            access_type: 'NoPublicAccess',
            kms_key_id: x(`${lz}.kms_key_id`),
            freeform_tags: tags,
          }),
          res('oci_cloud_bridge_environment', 'ocm', { compartment_id: comp, display_name: x(`"${prefix}-${rname(valueOf(values, 'environment', 'atk-ocm'))}"`), freeform_tags: tags }),
        );
        if (!inventory) {
          blocks.push(
            variable('tenancy_ocid', 'string', 'The tenancy OCID: the Cloud Bridge inventory is created in the root compartment, one per tenancy.'),
            res('oci_cloud_bridge_inventory', 'ocm', { compartment_id: x('var.tenancy_ocid'), display_name: x(`"${prefix}-inventory"`), freeform_tags: tags }),
          );
          findings.push(info('tf.mig.ocm-inventory', 'A tenancy has one Cloud Bridge inventory: this creates it in the root compartment (var.tenancy_ocid). When the tenancy has one, give its OCID in "Existing Cloud Bridge inventory OCID".', { path: 'inventory_id', source: 'https://docs.oracle.com/en-us/iaas/Content/cloud-migration/cloud-migration-manage-inventory.htm' }));
        }
        const inventoryId = inventory ? inventory : x('oci_cloud_bridge_inventory.ocm.id');
        if (vcenter) {
          blocks.push(
            variable('ocm_vcenter_discovery_secret_id', 'string', 'The OCI Vault secret (its OCID) holding the vCenter credentials Cloud Bridge discovers with. The secret\'s value is never in Terraform.'),
            variable('ocm_vcenter_replication_secret_id', 'string', 'The OCI Vault secret (its OCID) holding the vCenter credentials Oracle Cloud Migrations replicates with.'),
            res('oci_cloud_bridge_discovery_schedule', 'ocm', { compartment_id: comp, display_name: x(`"${prefix}-discovery"`), execution_recurrences: 'FREQ=DAILY;BYHOUR=0', freeform_tags: tags }),
            res('oci_cloud_bridge_asset_source', 'vcenter', {
              compartment_id: comp,
              assets_compartment_id: comp,
              display_name: x(`"${prefix}-vcenter"`),
              environment_id: x('oci_cloud_bridge_environment.ocm.id'),
              inventory_id: inventoryId,
              discovery_schedule_id: x('oci_cloud_bridge_discovery_schedule.ocm.id'),
              type: 'VMWARE',
              vcenter_endpoint: `https://${vcenter}/sdk`,
              are_historical_metrics_collected: true,
              are_realtime_metrics_collected: true,
              freeform_tags: tags,
            }, [
              blk('discovery_credentials', { secret_id: x('var.ocm_vcenter_discovery_secret_id'), type: 'BASIC' }),
              blk('replication_credentials', { secret_id: x('var.ocm_vcenter_replication_secret_id'), type: 'BASIC' }),
            ]),
          );
        } else {
          findings.push(info('tf.mig.ocm-no-vcenter', 'No vCenter is given, so no vSphere asset source is made; set vCenter (or add an AWS asset source) before discovery.', { path: 'vcenter' }));
        }
        blocks.push(
          res('oci_cloud_migrations_replication_schedule', 'ocm', { compartment_id: comp, display_name: x(`"${prefix}-replication"`), execution_recurrences: valueOf(values, 'schedule', 'FREQ=DAILY;BYHOUR=1'), freeform_tags: tags }),
          res('oci_cloud_migrations_migration', 'wave', {
            for_each: x(`toset(${hcl(waves)})`),
            compartment_id: comp,
            display_name: x(`"${prefix}-w\${each.key}"`),
            replication_schedule_id: x('oci_cloud_migrations_replication_schedule.ocm.id'),
            freeform_tags: tags,
          }),
          res('oci_cloud_migrations_migration_asset', 'vm', {
            for_each: x('local.mig_replication_ocm_assets'),
            display_name: x('each.key'),
            inventory_asset_id: x('each.value'),
            migration_id: x('oci_cloud_migrations_migration.wave[local.mig_replication_ocm_vms[each.key].wave].id'),
            availability_domain: x(`element(${lz}.zones, local.mig_replication_ocm_vms[each.key].ad)`),
            replication_compartment_id: comp,
            snap_shot_bucket_name: x('oci_objectstorage_bucket.ocm_snapshots.name'),
            replication_schedule_id: x('oci_cloud_migrations_replication_schedule.ocm.id'),
          }),
          res('oci_cloud_migrations_migration_plan', 'wave', {
            for_each: x('local.mig_replication_ocm_plans'),
            compartment_id: comp,
            display_name: x(`"${prefix}-w\${each.value.wave}-\${each.value.phase}"`),
            migration_id: x('oci_cloud_migrations_migration.wave[each.value.wave].id'),
            freeform_tags: tags,
          }, [
            blk('strategies', { resource_type: 'ALL', strategy_type: 'AS_IS' }),
            blk('target_environments', {
              target_environment_type: 'VM_TARGET_ENV',
              target_compartment_id: comp,
              vcn: x(`try(${lz}.network_ids[each.value.network], ${lz}.network_ids[${q(net)}])`),
              subnet: x(`try(${lz}.subnet_ids["\${each.value.network}/app/a"], ${subnet(net, 'app', 'a')})`),
            }),
          ]),
          res('oci_cloud_migrations_target_asset', 'vm', {
            for_each: x('{ for pair in setproduct(keys(local.mig_replication_ocm_assets), ["test", "cutover"]) : "${pair[0]}/${pair[1]}" => { vm = pair[0], phase = pair[1] } }'),
            migration_plan_id: x('oci_cloud_migrations_migration_plan.wave["${local.mig_replication_ocm_vms[each.value.vm].wave}/${each.value.phase}"].id'),
            type: 'INSTANCE',
            is_excluded_from_execution: false,
            preferred_shape_type: 'VM',
            ms_license: x('local.mig_replication_ocm_vms[each.value.vm].ms_license'),
            depends_on: x('[oci_cloud_migrations_migration_asset.vm]'),
          }, [
            blk('user_spec', {
              display_name: x('each.value.phase == "test" ? "${each.value.vm}-test" : each.value.vm'),
              compartment_id: comp,
              availability_domain: x(`element(${lz}.zones, local.mig_replication_ocm_vms[each.value.vm].ad)`),
              shape: x('local.mig_replication_ocm_vms[each.value.vm].shape'),
            }, [
              blk('shape_config', { ocpus: x('local.mig_replication_ocm_vms[each.value.vm].ocpus'), memory_in_gbs: x('local.mig_replication_ocm_vms[each.value.vm].memory') }),
              blk('create_vnic_details', {
                subnet_id: x('each.value.phase == "test" ? local.mig_replication_ocm_vms[each.value.vm].test_subnet : local.mig_replication_ocm_vms[each.value.vm].subnet'),
                assign_public_ip: false,
              }),
            ]),
          ]),
          output('ocm', `{
    compartment_id  = ${lz}.compartment_id
    environment_id  = oci_cloud_bridge_environment.ocm.id
    asset_source_id = ${vcenter ? 'oci_cloud_bridge_asset_source.vcenter.id' : 'null'}
    bucket          = oci_objectstorage_bucket.ocm_snapshots.name
    migrations      = { for k, v in oci_cloud_migrations_migration.wave : k => v.id }
    plans           = { for k, v in oci_cloud_migrations_migration_plan.wave : k => v.id }
    assets          = { for k, v in oci_cloud_migrations_migration_asset.vm : k => v.id }
    target_assets   = { for k, v in oci_cloud_migrations_target_asset.vm : k => v.id }
  }`, 'What ocm.sh reads: the migrations, plans, migration assets and target assets by wave, phase and VM.'),
        );
        findings.push(info('tf.mig.ocm-target-assets', 'The target assets are written per VM and plan from the design (shape, OCPUs, subnet); how a created target asset pairs with its migration asset is not documented in the provider, so check the first wave\'s plans in the console.', { path: 'vms', source: 'https://registry.terraform.io/providers/oracle/oci/latest/docs/resources/cloud_migrations_target_asset' }));
      }

      if (dbs.length) {
        blocks.push(variable('oci_dms_key_id', 'string', 'The Vault key OCI Database Migration encrypts connection secrets with, when the landing zone uses provider-managed keys.', { default: '""' }));
        for (const d of dbs) {
          const mysql = d.engine === 'mysql';
          if (!mysql && d.engine !== 'oracle') {
            findings.push(warning('tf.mig.oci-dms-engine', `${d.name}: OCI Database Migration takes Oracle and MySQL; left out.`, { path: 'databases' }));
            continue;
          }
          if (mysql && d.service !== 'oci-mysql-heatwave') { findings.push(warning('tf.mig.oci-dms-target', `${d.name}: MySQL moves to HeatWave only here; left out.`, { path: 'databases' })); continue; }
          if (!mysql && d.service !== 'oci-adb') { findings.push(warning('tf.mig.oci-dms-target', `${d.name}: Oracle moves by OCI Database Migration to Autonomous Database here (Base Database and Exadata move by ZDM physical); left out.`, { path: 'databases' })); continue; }
          const src = sources.get(d.name) ?? {};
          const srcPw = `dms_${d.id}_source_password`;
          const tgtPw = `dms_${d.id}_target_password`;
          const hostVar = `dms_${d.id}_source_host`;
          const host = src.host ?? x(`var.${hostVar}`);
          const port = src.port ?? (mysql ? 3306 : 1521);
          blocks.push(
            secretVariable(srcPw, `The password of the migration user on the source of ${d.name}.`),
            secretVariable(tgtPw, `The password of the ${mysql ? 'HeatWave administrator (dbadmin)' : 'Autonomous Database ADMIN user'} of ${d.name}.`),
          );
          if (!src.host) blocks.push(variable(hostVar, 'string', `The source host of ${d.name} (a name or an address the migration's private endpoint reaches).`));
          const common = {
            compartment_id: comp,
            key_id: x(`coalesce(${lz}.kms_key_id, var.oci_dms_key_id)`),
            vault_id: x(`${lz}.vault_id`),
            subnet_id: x(`try(${subnet(net, 'db', 'a')}, ${subnet(net, 'mgmt', 'a')})`),
            freeform_tags: tags,
          };
          if (mysql) {
            blocks.push(
              dat('oci_mysql_mysql_db_systems', `dms_${d.id}`, { compartment_id: comp, display_name: x(`"${prefix}-${d.name}"`) }),
              res('oci_database_migration_connection', `${d.id}_source`, {
                ...common, display_name: x(`"${prefix}-${d.name}-source"`), connection_type: 'MYSQL', technology_type: 'MYSQL_SERVER',
                host, port, database_name: src.database ?? d.name, username: src.user ?? 'atk_migration', password: x(`var.${srcPw}`),
              }),
              res('oci_database_migration_connection', `${d.id}_target`, {
                ...common, display_name: x(`"${prefix}-${d.name}-target"`), connection_type: 'MYSQL', technology_type: 'OCI_MYSQL',
                db_system_id: x(`data.oci_mysql_mysql_db_systems.dms_${d.id}.db_systems[0].id`), username: 'dbadmin', password: x(`var.${tgtPw}`),
              }),
            );
          } else {
            blocks.push(
              dat('oci_database_autonomous_databases', `dms_${d.id}`, { compartment_id: comp, display_name: x(`"${prefix}-${d.name}"`) }),
              res('oci_database_migration_connection', `${d.id}_source`, {
                ...common, display_name: x(`"${prefix}-${d.name}-source"`), connection_type: 'ORACLE', technology_type: 'ORACLE_DATABASE',
                connection_string: typeof host === 'string' ? `${host}:${port}/${src.database ?? d.name}` : x(`"\${var.${hostVar}}:${port}/${src.database ?? d.name}"`),
                username: src.user ?? 'atk_migration', password: x(`var.${srcPw}`),
              }),
              res('oci_database_migration_connection', `${d.id}_target`, {
                ...common, display_name: x(`"${prefix}-${d.name}-target"`), connection_type: 'ORACLE', technology_type: 'OCI_AUTONOMOUS_DATABASE',
                database_id: x(`data.oci_database_autonomous_databases.dms_${d.id}.autonomous_databases[0].id`), username: 'ADMIN', password: x(`var.${tgtPw}`),
              }),
            );
          }
          blocks.push(res('oci_database_migration_migration', d.id, {
            compartment_id: comp,
            display_name: x(`"${prefix}-${d.name}"`),
            database_combination: mysql ? 'MYSQL' : 'ORACLE',
            type: 'ONLINE',
            source_database_connection_id: x(`oci_database_migration_connection.${d.id}_source.id`),
            target_database_connection_id: x(`oci_database_migration_connection.${d.id}_target.id`),
            freeform_tags: tags,
          }));
        }
        const made = dbs.filter((d) => (d.engine === 'mysql' && d.service === 'oci-mysql-heatwave') || (d.engine === 'oracle' && d.service === 'oci-adb'));
        blocks.push(output('dms', `{
    migrations = {
${made.map((d) => `      ${q(d.name)} = oci_database_migration_migration.${d.id}.id`).join('\n')}
    }
  }`, 'What oci-dms.sh reads: the migration of each database.'));
      }
      if (!vms.length && !dbs.length) findings.push(info('tf.mig.replication-empty', 'No VM replicates and no database moves by OCI Database Migration, so there is nothing to build for replication.', { path: 'vms' }));
      return { files: { 'main.tf': mainTf(blocks, `OCI replication: Oracle Cloud Migrations for ${vms.length} VM(s), OCI Database Migration for ${dbs.length} database(s)`) }, findings };
    },
  };
}

/** The replication blueprints, one per cloud (Azure has none: everything Azure Migrate is PowerShell). */
export const MIGRATION_REPLICATION_BLUEPRINTS                       = [awsReplication(), googleReplication(), ociReplication()];

